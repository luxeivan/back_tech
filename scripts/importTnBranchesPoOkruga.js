const fs = require("fs");
const path = require("path");
const axios = require("axios");
const XLSX = require("xlsx");
require("dotenv").config();

const STRAPI_URL = String(process.env.URL_STRAPI || "").replace(/\/$/, "");
const STRAPI_LOGIN = process.env.LOGIN_STRAPI;
const STRAPI_PASSWORD = process.env.PASSWORD_STRAPI;

const FILIAL_COLLECTION = "tn-filialies";
const PO_COLLECTION = "tn-pos";
const OKRUG_COLLECTION = "tn-okruga";

const PO_FILIAL_FIELD = "tn_filialy";
const OKRUG_FILIAL_FIELD =
  getArgValue("--okrug-filial-field") || "tn_filialy";
const OKRUG_PO_FIELD = getArgValue("--okrug-po-field") || "tn_po";

const DEFAULT_FILIAL_REZIM = "bez_rezhima";
const PAGE_SIZE = 100;
const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 1200;

const XLSX_PATHS = [
  getArgValue("--xlsx"),
  "/app/data/городские_округа_.xlsx",
  path.resolve(__dirname, "../data/городские_округа_.xlsx"),
  "/Users/yanutstas/Desktop/городские_округа_.xlsx",
  "/Users/yanutstas/Downloads/городские_округа_.xlsx",
].filter(Boolean);

const applyChanges = process.argv.includes("--apply");

function getArgValue(name) {
  const prefix = `${name}=`;
  const arg = process.argv.find((item) => item.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : "";
}

function fail(message) {
  console.error(`[tn-org-import] ${message}`);
  process.exit(1);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeText(value) {
  return String(value || "").replace(/\t/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeKey(value) {
  return normalizeText(value)
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/g, "е")
    .replace(/^городской округ\s+/i, "")
    .replace(/^городской\s+/i, "")
    .replace(/\s+городской округ$/i, "")
    .replace(/павловский\s+посад/g, "павлово-посадский")
    .replace(/сергиев\s+посад/g, "сергиево-посадский")
    .replace(/[^а-яa-z0-9]+/g, "");
}

function isWeakValue(value) {
  const normalized = normalizeKey(value);
  return !normalized || normalized === "нет" || normalized === "-";
}

function scoreRow(row) {
  let score = 0;
  if (!isWeakValue(row.filial)) score += 2;
  if (!isWeakValue(row.po)) score += 2;
  return score;
}

function getWriteId(row) {
  return row?.documentId || row?.id;
}

function mapItem(item) {
  return item?.attributes
    ? { id: item.id, documentId: item.documentId, ...item.attributes }
    : item;
}

function relationValue(row) {
  const writeId = getWriteId(row);
  if (!writeId) fail(`Не найден documentId/id для relation: ${JSON.stringify(row)}`);
  return writeId;
}

function relationName(row) {
  return row?.name || row?.source_name || row?.documentId || row?.id || "?";
}

function findXlsxPath() {
  const found = XLSX_PATHS.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    fail(
      `Не найден городские_округа_.xlsx. Передай путь явно: --xlsx=/path/to/городские_округа_.xlsx`
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

async function requestWithRetry(fn, label) {
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt >= MAX_RETRIES) break;

      const status = error?.response?.status;
      const message = status || error?.code || error?.message || "unknown";
      const delay = RETRY_DELAY_MS * attempt;
      console.warn(
        `[tn-org-import] ${label}: попытка ${attempt}/${MAX_RETRIES} упала (${message}), повтор через ${delay} мс...`
      );
      await wait(delay);
    }
  }

  throw lastError;
}

async function fetchAll(client, collection, params = {}) {
  const rows = [];
  let page = 1;
  let pageCount = 1;

  do {
    const response = await requestWithRetry(
      () =>
        client.get(`/api/${collection}`, {
          params: {
            ...params,
            "pagination[page]": page,
            "pagination[pageSize]": PAGE_SIZE,
          },
        }),
      `чтение ${collection}, страница ${page}`
    );

    const dataRows = Array.isArray(response?.data?.data) ? response.data.data : [];
    rows.push(...dataRows.map(mapItem));
    pageCount = Number(response?.data?.meta?.pagination?.pageCount || 1);
    page += 1;
  } while (page <= pageCount);

  return rows;
}

function findByName(rows, name) {
  const key = normalizeKey(name);
  return rows.find((row) => normalizeKey(row.name) === key);
}

function readWorkbookRows(filePath) {
  const workbook = XLSX.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) fail("В Excel не найден первый лист");

  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
  const header = rows[0] || [];
  const districtIndex = header.findIndex((cell) =>
    normalizeText(cell).toLocaleLowerCase("ru-RU").includes("городской округ")
  );
  const filialIndex = header.findIndex((cell) =>
    normalizeText(cell).toLocaleLowerCase("ru-RU").includes("филиал")
  );
  const poIndex = header.findIndex((cell) => normalizeText(cell).toLocaleLowerCase("ru-RU") === "по");

  if (districtIndex < 0) fail("В Excel не найдена колонка 'Городской округ'");
  if (filialIndex < 0) fail("В Excel не найдена колонка 'Филиал'");
  if (poIndex < 0) fail("В Excel не найдена колонка 'ПО'");

  const parsed = rows
    .slice(1)
    .map((row, index) => ({
      excelRow: index + 2,
      district: normalizeText(row[districtIndex]),
      filial: normalizeText(row[filialIndex]),
      po: normalizeText(row[poIndex]),
    }))
    .filter((row) => row.district);

  if (!parsed.length) fail("В Excel не найдено строк с округами");
  return parsed;
}

function chooseDistrictRows(rows) {
  const result = new Map();
  const duplicates = [];

  rows.forEach((row) => {
    const key = normalizeKey(row.district);
    const existing = result.get(key);
    if (!existing) {
      result.set(key, row);
      return;
    }

    const selected = scoreRow(row) >= scoreRow(existing) ? row : existing;
    result.set(key, selected);
    duplicates.push({ previous: existing, current: row, selected });
  });

  return { rows: Array.from(result.values()), duplicates };
}

function buildUniqueNames(rows, field) {
  const items = [];
  const seen = new Set();

  rows.forEach((row) => {
    const value = normalizeText(row[field]);
    if (isWeakValue(value)) return;
    const key = normalizeKey(value);
    if (!key || seen.has(key)) return;
    seen.add(key);
    items.push(value);
  });

  return items;
}

async function upsertNamedRecord({ client, collection, existingRows, name, data }) {
  const existing = findByName(existingRows, name);
  if (!applyChanges) {
    return { row: existing || { name, documentId: `dry-${normalizeKey(name)}` }, action: existing ? "exists" : "would-create" };
  }

  if (existing) {
    const writeId = getWriteId(existing);
    const response = await requestWithRetry(
      () => client.put(`/api/${collection}/${writeId}`, { data }),
      `обновление ${collection}: ${name}`
    );
    return { row: mapItem(response?.data?.data), action: "updated" };
  }

  const response = await requestWithRetry(
    () => client.post(`/api/${collection}`, { data }),
    `создание ${collection}: ${name}`
  );
  return { row: mapItem(response?.data?.data), action: "created" };
}

async function updateOkrugRelations({ client, okrug, filial, po }) {
  const writeId = getWriteId(okrug);
  if (!writeId) fail(`У округа ${relationName(okrug)} не найден documentId/id`);

  const data = {
    [OKRUG_FILIAL_FIELD]: relationValue(filial),
  };
  if (po) data[OKRUG_PO_FIELD] = relationValue(po);

  if (!applyChanges) {
    return "would-update";
  }

  await requestWithRetry(
    () => client.put(`/api/${OKRUG_COLLECTION}/${writeId}`, { data }),
    `обновление связей округа ${relationName(okrug)}`
  );
  return "updated";
}

function printDuplicateWarnings(duplicates) {
  if (!duplicates.length) return;

  console.warn("");
  console.warn("[tn-org-import] В Excel найдены дубли округов. Для relation округ -> филиал/ПО будет выбран один вариант:");
  duplicates.forEach(({ previous, current, selected }) => {
    console.warn(
      `[tn-org-import] - ${current.district}: строка ${previous.excelRow} (${previous.filial} / ${previous.po}) и строка ${current.excelRow} (${current.filial} / ${current.po}); выбрана строка ${selected.excelRow} (${selected.filial} / ${selected.po})`
    );
  });
}

function printWeakWarnings(rows) {
  const weak = rows.filter((row) => isWeakValue(row.filial) || isWeakValue(row.po));
  if (!weak.length) return;

  console.warn("");
  console.warn("[tn-org-import] В Excel есть строки с пустыми/служебными значениями филиала или ПО:");
  weak.forEach((row) => {
    console.warn(`[tn-org-import] - строка ${row.excelRow}: ${row.district} -> ${row.filial} / ${row.po}`);
  });
}

async function main() {
  const startedAt = Date.now();
  const xlsxPath = findXlsxPath();

  console.log(`[tn-org-import] Excel: ${xlsxPath}`);
  console.log(`[tn-org-import] Режим: ${applyChanges ? "APPLY, будут записи в Strapi" : "DRY RUN, Strapi не меняю"}`);
  console.log(`[tn-org-import] Поле связи ПО -> филиал: ${PO_FILIAL_FIELD}`);
  console.log(`[tn-org-import] Поле связи округ -> филиал: ${OKRUG_FILIAL_FIELD}`);
  console.log(`[tn-org-import] Поле связи округ -> ПО: ${OKRUG_PO_FIELD}`);

  const rawRows = readWorkbookRows(xlsxPath);
  const { rows: districtRows, duplicates } = chooseDistrictRows(rawRows);
  const filialNames = buildUniqueNames(rawRows, "filial");
  const poNames = buildUniqueNames(districtRows, "po");

  console.log(`[tn-org-import] Строк в Excel: ${rawRows.length}`);
  console.log(`[tn-org-import] Уникальных округов после разбора дублей: ${districtRows.length}`);
  console.log(`[tn-org-import] Уникальных филиалов: ${filialNames.length}`);
  console.log(`[tn-org-import] Уникальных ПО: ${poNames.length}`);
  printDuplicateWarnings(duplicates);
  printWeakWarnings(rawRows);

  console.log("");
  console.log("[tn-org-import] Логинюсь в Strapi...");
  const jwt = await getJwt();
  const client = axios.create({
    baseURL: STRAPI_URL,
    headers: {
      Authorization: `Bearer ${jwt}`,
      Connection: "close",
    },
    timeout: 120000,
  });

  console.log("[tn-org-import] Загружаю существующие филиалы, ПО и округа...");
  const [existingFilials, existingPos, existingOkruga] = await Promise.all([
    fetchAll(client, FILIAL_COLLECTION, { "sort[0]": "sort_order:asc" }),
    fetchAll(client, PO_COLLECTION, { "sort[0]": "sort_order:asc", populate: "*" }),
    fetchAll(client, OKRUG_COLLECTION, { "sort[0]": "sort_order:asc", populate: "*" }),
  ]);

  const stats = {
    filialsCreated: 0,
    filialsUpdated: 0,
    filialsExisting: 0,
    filialsWouldCreate: 0,
    posCreated: 0,
    posUpdated: 0,
    posExisting: 0,
    posWouldCreate: 0,
    okrugaUpdated: 0,
    okrugaWouldUpdate: 0,
    okrugaMissing: [],
  };

  const filialByKey = new Map();
  const poByKey = new Map();

  console.log("");
  console.log("[tn-org-import] Синхронизирую филиалы...");
  for (let index = 0; index < filialNames.length; index += 1) {
    const name = filialNames[index];
    const { row, action } = await upsertNamedRecord({
      client,
      collection: FILIAL_COLLECTION,
      existingRows: existingFilials,
      name,
      data: {
        name,
        rezim: DEFAULT_FILIAL_REZIM,
        sort_order: index + 1,
        is_active: true,
      },
    });

    filialByKey.set(normalizeKey(name), row);
    if (action === "created") stats.filialsCreated += 1;
    if (action === "updated") stats.filialsUpdated += 1;
    if (action === "exists") stats.filialsExisting += 1;
    if (action === "would-create") stats.filialsWouldCreate += 1;
    console.log(`[tn-org-import] Филиал ${index + 1}/${filialNames.length}: ${action} | ${name}`);
  }

  console.log("");
  console.log("[tn-org-import] Синхронизирую ПО...");
  for (let index = 0; index < poNames.length; index += 1) {
    const name = poNames[index];
    const sourceRow = rawRows.find((row) => normalizeKey(row.po) === normalizeKey(name));
    const filial = filialByKey.get(normalizeKey(sourceRow?.filial));
    if (!filial) fail(`Для ПО ${name} не найден филиал ${sourceRow?.filial}`);

    const { row, action } = await upsertNamedRecord({
      client,
      collection: PO_COLLECTION,
      existingRows: existingPos,
      name,
      data: {
        name,
        sort_order: index + 1,
        is_active: true,
        [PO_FILIAL_FIELD]: relationValue(filial),
      },
    });

    poByKey.set(normalizeKey(name), row);
    if (action === "created") stats.posCreated += 1;
    if (action === "updated") stats.posUpdated += 1;
    if (action === "exists") stats.posExisting += 1;
    if (action === "would-create") stats.posWouldCreate += 1;
    console.log(
      `[tn-org-import] ПО ${index + 1}/${poNames.length}: ${action} | ${name} -> ${relationName(filial)}`
    );
  }

  console.log("");
  console.log("[tn-org-import] Проставляю связи у округов...");
  for (let index = 0; index < districtRows.length; index += 1) {
    const sourceRow = districtRows[index];
    const okrug = findByName(existingOkruga, sourceRow.district);
    const shouldSetFilial = !isWeakValue(sourceRow.filial);
    const filial = shouldSetFilial ? filialByKey.get(normalizeKey(sourceRow.filial)) : null;
    const shouldSetPo = !isWeakValue(sourceRow.po);
    const po = shouldSetPo ? poByKey.get(normalizeKey(sourceRow.po)) : null;

    if (!okrug) {
      stats.okrugaMissing.push(sourceRow);
      console.warn(`[tn-org-import] Округ не найден в Strapi: ${sourceRow.district}`);
      continue;
    }
    if (shouldSetFilial && !filial) {
      fail(`Для округа ${sourceRow.district} не найден филиал ${sourceRow.filial}`);
    }
    if (shouldSetPo && !po) fail(`Для округа ${sourceRow.district} не найдено ПО ${sourceRow.po}`);
    if (!shouldSetFilial) {
      console.warn(
        `[tn-org-import] Для округа ${sourceRow.district} филиал пустой/служебный (${sourceRow.filial || "пусто"}), пропускаю связь филиала и ПО`
      );
      continue;
    }
    if (!shouldSetPo) {
      console.warn(
        `[tn-org-import] Для округа ${sourceRow.district} ПО пустое/служебное (${sourceRow.po || "пусто"}), обновляю только филиал`
      );
    }

    const action = await updateOkrugRelations({ client, okrug, filial, po });
    if (action === "updated") stats.okrugaUpdated += 1;
    if (action === "would-update") stats.okrugaWouldUpdate += 1;
    console.log(
      `[tn-org-import] Округ ${index + 1}/${districtRows.length}: ${action} | ${sourceRow.district} -> ${relationName(filial)} / ${po ? relationName(po) : "ПО не задано"}`
    );
  }

  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);

  console.log("");
  console.log("=== Импорт филиалов/ПО/связей округов ===");
  console.log(`Excel: ${xlsxPath}`);
  console.log(`Строк в Excel: ${rawRows.length}`);
  console.log(`Уникальных округов: ${districtRows.length}`);
  console.log(`Дублей округов: ${duplicates.length}`);
  console.log(`Филиалы: created=${stats.filialsCreated}, updated=${stats.filialsUpdated}, exists=${stats.filialsExisting}, wouldCreate=${stats.filialsWouldCreate}`);
  console.log(`ПО: created=${stats.posCreated}, updated=${stats.posUpdated}, exists=${stats.posExisting}, wouldCreate=${stats.posWouldCreate}`);
  console.log(`Округа: updated=${stats.okrugaUpdated}, wouldUpdate=${stats.okrugaWouldUpdate}, missing=${stats.okrugaMissing.length}`);
  if (stats.okrugaMissing.length) {
    console.log("Округа из Excel, не найденные в Strapi:");
    stats.okrugaMissing.forEach((row) => {
      console.log(`- строка ${row.excelRow}: ${row.district} -> ${row.filial} / ${row.po}`);
    });
  }
  console.log(`Готово за ${elapsedSec} сек.`);
}

main().catch((error) => {
  const status = error?.response?.status;
  const data = error?.response?.data;
  console.error("[tn-org-import] Ошибка:", status || error?.message);
  if (data) console.error(JSON.stringify(data, null, 2));
  process.exit(1);
});
