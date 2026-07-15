const fs = require("fs");
const path = require("path");
const axios = require("axios");
require("dotenv").config();

const STRAPI_URL = String(process.env.URL_STRAPI || "").replace(/\/$/, "");
const STRAPI_LOGIN = process.env.LOGIN_STRAPI;
const STRAPI_PASSWORD = process.env.PASSWORD_STRAPI;

const COLLECTION_PATH = "tn-okruga";
const DEFAULT_REZIM = "bez_rezhima";
const DEFAULT_SOURCE_PATHS = [
  "/app/data/moscow-region-municipalities.geojson",
  path.resolve(__dirname, "../../front_tech_vite/public/data/moscow-region-municipalities.geojson"),
  "/Users/yanutstas/Desktop/Project/front_tech_vite/public/data/moscow-region-municipalities.geojson",
];

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const onlyMissing = argv.includes("--only-missing");
const geojsonArg = argv.find((arg) => arg.startsWith("--geojson="))?.split("=").slice(1).join("=");

function fail(message) {
  console.error(`[tn-okruga-import] ${message}`);
  process.exit(1);
}

function getGeojsonPath() {
  const candidates = geojsonArg ? [geojsonArg] : DEFAULT_SOURCE_PATHS;
  const found = candidates.find((candidate) => candidate && fs.existsSync(candidate));
  if (!found) {
    fail(
      `GeoJSON не найден. Передай путь явно: --geojson=/path/to/moscow-region-municipalities.geojson`
    );
  }
  return found;
}

async function getJwt() {
  if (!STRAPI_URL) fail("URL_STRAPI не задан");
  if (!STRAPI_LOGIN) fail("LOGIN_STRAPI не задан");
  if (!STRAPI_PASSWORD) fail("PASSWORD_STRAPI не задан");

  const response = await axios.post(
    `${STRAPI_URL}/api/auth/local`,
    {
      identifier: STRAPI_LOGIN,
      password: STRAPI_PASSWORD,
    },
    { timeout: 20000 }
  );

  const jwt = response?.data?.jwt;
  if (!jwt) fail("Strapi не вернул jwt");
  return jwt;
}

function formatDistrictName(name) {
  const cleaned = String(name || "")
    .replace(/^Городской Округ\s+/i, "")
    .replace(/\s+Городской Округ$/i, "")
    .replace(/\s+/g, " ")
    .trim();

  return cleaned.replace(/(^|[\s-])([а-яё])/g, (match, prefix, letter) =>
    `${prefix}${letter.toLocaleUpperCase("ru-RU")}`
  );
}

function mapItem(item) {
  return item?.attributes ? { id: item.id, ...item.attributes } : item;
}

function readGeojson(filePath) {
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const features = Array.isArray(parsed?.features) ? parsed.features : [];
  if (!features.length) fail("В GeoJSON не найден массив features");

  const rows = features.map((feature, index) => {
    const sourceName = String(feature?.properties?.district || "").trim();
    const name = formatDistrictName(sourceName);
    if (!sourceName || !name) {
      fail(`Feature #${index + 1}: не найдено properties.district`);
    }
    if (!feature?.geometry) {
      fail(`Feature #${index + 1} (${sourceName}): не найден geometry`);
    }

    return {
      name,
      source_name: sourceName,
      rezim: DEFAULT_REZIM,
      geometry: feature.geometry,
      properties: feature.properties || {},
      sort_order: index + 1,
      is_active: true,
    };
  });

  const duplicates = rows.reduce((acc, row) => {
    acc[row.source_name] = (acc[row.source_name] || 0) + 1;
    return acc;
  }, {});
  const duplicateNames = Object.entries(duplicates).filter(([, count]) => count > 1);
  if (duplicateNames.length) {
    fail(`В GeoJSON есть дубли source_name: ${duplicateNames.map(([name]) => name).join(", ")}`);
  }

  return rows;
}

async function requestWithRetry(fn, label, maxRetries = 5) {
  let lastError = null;

  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt >= maxRetries) break;

      const status = error?.response?.status;
      const message = status || error?.code || error?.message || "unknown";
      const delay = 1000 * attempt;
      console.warn(
        `[tn-okruga-import] ${label}: попытка ${attempt}/${maxRetries} упала (${message}), повтор через ${delay} мс...`
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

async function findExistingBySourceName({ client, sourceName }) {
  const response = await requestWithRetry(
    () =>
      client.get(`/api/${COLLECTION_PATH}`, {
        params: {
          "filters[source_name][$eq]": sourceName,
          "pagination[page]": 1,
          "pagination[pageSize]": 1,
        },
      }),
    `поиск ${sourceName}`
  );

  const item = Array.isArray(response?.data?.data) ? response.data.data[0] : null;
  return item ? mapItem(item) : null;
}

async function upsertRow({ client, row }) {
  const existing = await findExistingBySourceName({ client, sourceName: row.source_name });

  if (dryRun) {
    return existing ? "would-update" : "would-create";
  }

  if (existing?.id) {
    if (onlyMissing) return "skip-existing";

    await requestWithRetry(
      () => client.put(`/api/${COLLECTION_PATH}/${existing.id}`, { data: row }),
      `обновление ${row.source_name}`
    );
    return "updated";
  }

  await requestWithRetry(
    () => client.post(`/api/${COLLECTION_PATH}`, { data: row }),
    `создание ${row.source_name}`
  );
  return "created";
}

async function main() {
  const startedAt = Date.now();
  const geojsonPath = getGeojsonPath();

  console.log(`[tn-okruga-import] GeoJSON: ${geojsonPath}`);
  const rows = readGeojson(geojsonPath);
  console.log(`[tn-okruga-import] Найдено округов: ${rows.length}`);
  console.log(`[tn-okruga-import] Режим по умолчанию: ${DEFAULT_REZIM}`);
  if (dryRun) console.log("[tn-okruga-import] DRY RUN: записи не будут изменены");
  if (onlyMissing) console.log("[tn-okruga-import] ONLY MISSING: существующие записи не обновляются");

  console.log("[tn-okruga-import] Логинюсь в Strapi...");
  const jwt = await getJwt();
  const client = axios.create({
    baseURL: STRAPI_URL,
    headers: {
      Authorization: `Bearer ${jwt}`,
      Connection: "close",
    },
    timeout: 120000,
  });

  const stats = {
    created: 0,
    updated: 0,
    skipped: 0,
    wouldCreate: 0,
    wouldUpdate: 0,
  };

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const action = await upsertRow({ client, row });

    if (action === "created") stats.created += 1;
    if (action === "updated") stats.updated += 1;
    if (action === "skip-existing") stats.skipped += 1;
    if (action === "would-create") stats.wouldCreate += 1;
    if (action === "would-update") stats.wouldUpdate += 1;

    console.log(
      `[tn-okruga-import] ${index + 1}/${rows.length}: ${action} | ${row.name} <- ${row.source_name}`
    );
  }

  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log("");
  console.log("=== Импорт ТН: Округа ===");
  console.log(`Всего строк из GeoJSON: ${rows.length}`);
  console.log(`Создано: ${stats.created}`);
  console.log(`Обновлено: ${stats.updated}`);
  console.log(`Пропущено существующих: ${stats.skipped}`);
  console.log(`DRY RUN создать: ${stats.wouldCreate}`);
  console.log(`DRY RUN обновить: ${stats.wouldUpdate}`);
  console.log(`Готово за ${elapsedSec} сек.`);
}

main().catch((error) => {
  const status = error?.response?.status;
  const data = error?.response?.data;
  console.error("[tn-okruga-import] Ошибка:", status || error?.message);
  if (data) console.error(JSON.stringify(data, null, 2));
  process.exit(1);
});
