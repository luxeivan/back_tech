const axios = require("axios");
require("dotenv").config();

const STRAPI_URL = String(process.env.URL_STRAPI || "").replace(/\/$/, "");
const STRAPI_LOGIN = process.env.LOGIN_STRAPI;
const STRAPI_PASSWORD = process.env.PASSWORD_STRAPI;

const DEFAULT_PAGE_SIZE = 100;
const PAGE_SIZE = Number(process.argv.find((arg) => arg.startsWith("--page-size="))?.split("=")[1]) || DEFAULT_PAGE_SIZE;
const MAX_RETRIES = Number(process.argv.find((arg) => arg.startsWith("--retries="))?.split("=")[1]) || 5;
const RETRY_DELAY_MS =
  Number(process.argv.find((arg) => arg.startsWith("--retry-delay-ms="))?.split("=")[1]) || 1500;
const FIELD_NAME = "DISPCENTER_NAME_";

function fail(message) {
  console.error(`[dispcenter-stats] ${message}`);
  process.exit(1);
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

function mapItem(item) {
  return item?.attributes ? { id: item.id, ...item.attributes } : item;
}

function pick(row, key) {
  return row?.[key] ?? row?.data?.[key] ?? row?.data?.data?.[key] ?? null;
}

function normalizeValue(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchPage({ jwt, page }) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const response = await axios.get(`${STRAPI_URL}/api/teh-narusheniyas`, {
        headers: {
          Authorization: `Bearer ${jwt}`,
          Connection: "close",
        },
        params: {
          "pagination[page]": page,
          "pagination[pageSize]": PAGE_SIZE,
          "sort[0]": "id:asc",
        },
        timeout: 120000,
      });

      return response?.data || {};
    } catch (error) {
      if (attempt >= MAX_RETRIES) throw error;

      const status = error?.response?.status;
      const message = status || error?.code || error?.message || "unknown";
      const delay = RETRY_DELAY_MS * attempt;
      console.warn(
        `[dispcenter-stats] Страница ${page}: попытка ${attempt}/${MAX_RETRIES} упала (${message}), повтор через ${delay} мс...`
      );
      await wait(delay);
    }
  }

  return {};
}

async function main() {
  const startedAt = Date.now();
  console.log("[dispcenter-stats] Логинюсь в Strapi...");
  const jwt = await getJwt();

  console.log(
    `[dispcenter-stats] Загружаю teh-narusheniyas постранично, pageSize=${PAGE_SIZE}, retries=${MAX_RETRIES}...`
  );

  const stats = {
    totalLoaded: 0,
    totalFromMeta: 0,
    filled: 0,
    empty: 0,
  };
  const values = new Map();

  const processRows = (rows) => {
    rows.map(mapItem).forEach((row) => {
      stats.totalLoaded += 1;

      const normalized = normalizeValue(pick(row, FIELD_NAME));
      if (normalized) {
        stats.filled += 1;
        values.set(normalized, (values.get(normalized) || 0) + 1);
      } else {
        stats.empty += 1;
      }
    });
  };

  const firstPage = await fetchPage({ jwt, page: 1 });
  const meta = firstPage?.meta?.pagination || {};
  const pageCount = Number(meta.pageCount || 1);
  stats.totalFromMeta = Number(meta.total || 0);
  const effectivePageSize = Number(meta.pageSize || PAGE_SIZE);

  processRows(Array.isArray(firstPage?.data) ? firstPage.data : []);
  console.log(
    `[dispcenter-stats] Страница 1/${pageCount}: загружено ${stats.totalLoaded}/${stats.totalFromMeta || "?"}`
  );

  for (let page = 2; page <= pageCount; page += 1) {
    const data = await fetchPage({ jwt, page });
    processRows(Array.isArray(data?.data) ? data.data : []);

    if (page === pageCount || page % 10 === 0) {
      console.log(
        `[dispcenter-stats] Страница ${page}/${pageCount}: загружено ${stats.totalLoaded}/${stats.totalFromMeta || "?"}`
      );
    }
  }

  const sortedValues = Array.from(values.entries()).sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0].localeCompare(b[0], "ru", { sensitivity: "base" });
  });

  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);

  console.log("");
  console.log(`=== Статистика поля ${FIELD_NAME} ===`);
  console.log(`Всего ТН по meta.total: ${stats.totalFromMeta}`);
  console.log(`Всего ТН реально загружено: ${stats.totalLoaded}`);
  console.log(`Поле заполнено: ${stats.filled}`);
  console.log(`Поле пустое/не найдено: ${stats.empty}`);
  console.log(`Уникальных значений: ${sortedValues.length}`);
  console.log(`Эффективный pageSize Strapi: ${effectivePageSize}`);
  console.log("");
  console.log("Значения поля и количество повторов:");
  sortedValues.forEach(([value, count]) => {
    console.log(`- ${value}: ${count}`);
  });
  console.log("");
  console.log(`Готово за ${elapsedSec} сек.`);
}

main().catch((error) => {
  const status = error?.response?.status;
  const data = error?.response?.data;
  console.error("[dispcenter-stats] Ошибка:", status || error?.message);
  if (data) console.error(JSON.stringify(data, null, 2));
  process.exit(1);
});
