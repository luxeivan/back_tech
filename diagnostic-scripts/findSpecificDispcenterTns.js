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

const TARGET_DISPCENTERS = [
  "СергиевПосад",
  "ОреховоЗуево",
  "Щелковский филиал",
  "ПавловскийПосад",
];
const BASE_TYPE_FILTER = 0;

function fail(message) {
  console.error(`[find-dispcenter-tns] ${message}`);
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

function pickNestedData(row, key) {
  return row?.data?.[key] ?? row?.data?.data?.[key] ?? null;
}

function normalizeValue(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function parseDate(value) {
  if (!value && value !== 0) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function getEventDate(row) {
  return (
    parseDate(pick(row, "F81_060_EVENTDATETIME")) ||
    parseDate(row?.createDateTime) ||
    parseDate(pick(row, "CREATE_DATETIME")) ||
    parseDate(row?.createdAt) ||
    null
  );
}

function formatDateMoscow(date) {
  if (!date) return "—";
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
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
          "filters[BASE_TYPE][$eq]": BASE_TYPE_FILTER,
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
        `[find-dispcenter-tns] Страница ${page}: попытка ${attempt}/${MAX_RETRIES} упала (${message}), повтор через ${delay} мс...`
      );
      await wait(delay);
    }
  }

  return {};
}

async function main() {
  const startedAt = Date.now();
  const targets = new Set(TARGET_DISPCENTERS);
  const found = [];

  console.log("[find-dispcenter-tns] Логинюсь в Strapi...");
  const jwt = await getJwt();

  console.log(
    `[find-dispcenter-tns] Ищу DISPCENTER_NAME_: ${TARGET_DISPCENTERS.join(", ")}`
  );
  console.log(
    `[find-dispcenter-tns] Загружаю teh-narusheniyas постранично, pageSize=${PAGE_SIZE}, retries=${MAX_RETRIES}...`
  );

  const firstPage = await fetchPage({ jwt, page: 1 });
  const meta = firstPage?.meta?.pagination || {};
  const pageCount = Number(meta.pageCount || 1);
  const totalFromMeta = Number(meta.total || 0);

  const processRows = (rows) => {
    rows.map(mapItem).forEach((row) => {
      const nestedBaseType = pickNestedData(row, "BASE_TYPE");
      if (Number(nestedBaseType) !== BASE_TYPE_FILTER) return;

      const dispcenter = normalizeValue(pick(row, "DISPCENTER_NAME_"));
      if (!targets.has(dispcenter)) return;

      const eventDate = getEventDate(row);
      found.push({
        dispcenter,
        date: eventDate,
        dateText: formatDateMoscow(eventDate),
        violationGuid: normalizeValue(pick(row, "VIOLATION_GUID_STR")) || "—",
        id: row?.id ?? "—",
        number: normalizeValue(row?.number ?? pick(row, "F81_010_NUMBER")) || "—",
        topBaseType: row?.BASE_TYPE ?? "—",
        nestedBaseType,
        ownScname: normalizeValue(pick(row, "OWN_SCNAME")) || "—",
        statusName: normalizeValue(row?.STATUS_NAME ?? pick(row, "STATUS_NAME")) || "—",
      });
    });
  };

  let loaded = 0;
  const firstRows = Array.isArray(firstPage?.data) ? firstPage.data : [];
  loaded += firstRows.length;
  processRows(firstRows);
  console.log(`[find-dispcenter-tns] Страница 1/${pageCount}: загружено ${loaded}/${totalFromMeta || "?"}`);

  for (let page = 2; page <= pageCount; page += 1) {
    const data = await fetchPage({ jwt, page });
    const rows = Array.isArray(data?.data) ? data.data : [];
    loaded += rows.length;
    processRows(rows);

    if (page === pageCount || page % 10 === 0) {
      console.log(`[find-dispcenter-tns] Страница ${page}/${pageCount}: загружено ${loaded}/${totalFromMeta || "?"}`);
    }
  }

  found.sort((a, b) => {
    const aTime = a.date ? a.date.getTime() : Number.MAX_SAFE_INTEGER;
    const bTime = b.date ? b.date.getTime() : Number.MAX_SAFE_INTEGER;
    if (aTime !== bTime) return aTime - bTime;
    return a.dispcenter.localeCompare(b.dispcenter, "ru", { sensitivity: "base" });
  });

  const countsByDispcenter = new Map(TARGET_DISPCENTERS.map((name) => [name, 0]));
  found.forEach((item) => {
    countsByDispcenter.set(item.dispcenter, (countsByDispcenter.get(item.dispcenter) || 0) + 1);
  });

  console.log("");
  console.log("=== Найденные ТН по подозрительным DISPCENTER_NAME_ ===");
  console.log(`Фильтр верхнего BASE_TYPE в Strapi: ${BASE_TYPE_FILTER}`);
  console.log(`Дополнительный фильтр вложенного data.BASE_TYPE: ${BASE_TYPE_FILTER}`);
  console.log(`Всего ТН по meta.total: ${totalFromMeta}`);
  console.log(`Всего ТН реально загружено: ${loaded}`);
  console.log(`Найдено ТН: ${found.length}`);
  console.log("");
  console.log("Количество по значениям:");
  TARGET_DISPCENTERS.forEach((name) => {
    console.log(`- ${name}: ${countsByDispcenter.get(name) || 0}`);
  });
  console.log("");
  console.log("Список ТН, отсортировано по дате:");
  found.forEach((item, index) => {
    console.log(
      `${String(index + 1).padStart(3, " ")}. ${item.dateText} | ${item.dispcenter} | VIOLATION_GUID_STR=${item.violationGuid} | id=${item.id} | number=${item.number} | top_BASE_TYPE=${item.topBaseType} | data.BASE_TYPE=${item.nestedBaseType} | OWN_SCNAME=${item.ownScname} | STATUS_NAME=${item.statusName}`
    );
  });

  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log("");
  console.log(`Готово за ${elapsedSec} сек.`);
}

main().catch((error) => {
  const status = error?.response?.status;
  const data = error?.response?.data;
  console.error("[find-dispcenter-tns] Ошибка:", status || error?.message);
  if (data) console.error(JSON.stringify(data, null, 2));
  process.exit(1);
});
