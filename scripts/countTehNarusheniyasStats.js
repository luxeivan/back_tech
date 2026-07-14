const axios = require("axios");
require("dotenv").config();

const STRAPI_URL = String(process.env.URL_STRAPI || "").replace(/\/$/, "");
const STRAPI_LOGIN = process.env.LOGIN_STRAPI;
const STRAPI_PASSWORD = process.env.PASSWORD_STRAPI;

const DEFAULT_PAGE_SIZE = 100;
const PAGE_SIZE = Number(process.argv.find((arg) => arg.startsWith("--page-size="))?.split("=")[1]) || DEFAULT_PAGE_SIZE;

const EVENT_DATE_FIELDS = [
  "F81_060_EVENTDATETIME",
  "createDateTime",
  "STARTDATETIME",
];

const DB_CREATED_AFTER = new Date("2026-01-01T00:00:00.000+03:00").getTime();

function fail(message) {
  console.error(`[tn-stats] ${message}`);
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

function parseDate(value) {
  if (!value && value !== 0) return null;
  const date = new Date(value);
  const timestamp = date.getTime();
  return Number.isFinite(timestamp) ? date : null;
}

function getEventDate(row) {
  for (const field of EVENT_DATE_FIELDS) {
    const date = parseDate(row?.[field]);
    if (date) return { date, field };
  }
  return { date: null, field: null };
}

function getMoscowYear(date) {
  const yearText = new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    year: "numeric",
  }).format(date);
  return Number(yearText);
}

async function fetchPage({ jwt, page }) {
  const response = await axios.get(`${STRAPI_URL}/api/teh-narusheniyas`, {
    headers: { Authorization: `Bearer ${jwt}` },
    params: {
      "pagination[page]": page,
      "pagination[pageSize]": PAGE_SIZE,
      "sort[0]": "id:asc",
    },
    timeout: 60000,
  });

  return response?.data || {};
}

async function main() {
  const startedAt = Date.now();
  console.log("[tn-stats] Логинюсь в Strapi...");
  const jwt = await getJwt();

  console.log(`[tn-stats] Загружаю teh-narusheniyas постранично, pageSize=${PAGE_SIZE}...`);
  const firstPage = await fetchPage({ jwt, page: 1 });
  const meta = firstPage?.meta?.pagination || {};
  const pageCount = Number(meta.pageCount || 1);
  const totalFromMeta = Number(meta.total || 0);
  const effectivePageSize = Number(meta.pageSize || PAGE_SIZE);

  const stats = {
    totalLoaded: 0,
    totalFromMeta,
    eventYear2026: 0,
    eventYear2025: 0,
    dbCreatedAfter20251231: 0,
    eventDateUnknown: 0,
  };
  const eventDateFieldUsage = new Map(EVENT_DATE_FIELDS.map((field) => [field, 0]));

  const processRows = (rows) => {
    rows.map(mapItem).forEach((row) => {
      stats.totalLoaded += 1;

      const { date: eventDate, field } = getEventDate(row);
      if (eventDate) {
        eventDateFieldUsage.set(field, (eventDateFieldUsage.get(field) || 0) + 1);
        const year = getMoscowYear(eventDate);
        if (year === 2026) stats.eventYear2026 += 1;
        if (year === 2025) stats.eventYear2025 += 1;
      } else {
        stats.eventDateUnknown += 1;
      }

      const createdAt = parseDate(row?.createdAt);
      if (createdAt && createdAt.getTime() >= DB_CREATED_AFTER) {
        stats.dbCreatedAfter20251231 += 1;
      }
    });
  };

  processRows(Array.isArray(firstPage?.data) ? firstPage.data : []);
  console.log(
    `[tn-stats] Страница 1/${pageCount}: загружено ${stats.totalLoaded}/${totalFromMeta || "?"}`
  );

  for (let page = 2; page <= pageCount; page += 1) {
    const data = await fetchPage({ jwt, page });
    processRows(Array.isArray(data?.data) ? data.data : []);

    if (page === pageCount || page % 10 === 0) {
      console.log(
        `[tn-stats] Страница ${page}/${pageCount}: загружено ${stats.totalLoaded}/${totalFromMeta || "?"}`
      );
    }
  }

  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);

  console.log("");
  console.log("=== Статистика teh-narusheniyas ===");
  console.log(`Всего ТН по meta.total: ${stats.totalFromMeta}`);
  console.log(`Всего ТН реально загружено: ${stats.totalLoaded}`);
  console.log(`ТН за 2026 год по дате события: ${stats.eventYear2026}`);
  console.log(`ТН, поступившие в БД после 31.12.2025 по createdAt: ${stats.dbCreatedAfter20251231}`);
  console.log(`ТН за 2025 год по дате события: ${stats.eventYear2025}`);
  console.log(`ТН, где дату события определить не удалось: ${stats.eventDateUnknown}`);
  console.log("");
  console.log("Поля, по которым была найдена дата события:");
  for (const [field, count] of eventDateFieldUsage.entries()) {
    console.log(`- ${field}: ${count}`);
  }
  console.log("");
  console.log(`Готово за ${elapsedSec} сек.`);
}

main().catch((error) => {
  const status = error?.response?.status;
  const data = error?.response?.data;
  console.error("[tn-stats] Ошибка:", status || error?.message);
  if (data) console.error(JSON.stringify(data, null, 2));
  process.exit(1);
});
