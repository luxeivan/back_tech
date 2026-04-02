#!/usr/bin/env node
require("dotenv").config();

const axios = require("axios");
const { getJwt } = require("../services/modus/strapi");

const argv = process.argv.slice(2);
const hasFlag = (name) => argv.includes(name);
const getArg = (name, fallback = "") => {
  const i = argv.indexOf(name);
  if (i === -1) return fallback;
  return argv[i + 1] || fallback;
};

const APPLY = hasFlag("--apply");
const DRY_RUN = hasFlag("--dry-run") || !APPLY;
const LIMIT = Math.max(1, Number(getArg("--limit", "100")) || 100);
const PAGE_SIZE = Math.max(10, Math.min(200, Number(getArg("--page-size", "100")) || 100));
const STRAPI_URL = String(process.env.URL_STRAPI || process.env.STRAPI_URL || "").replace(/\/$/, "");

if (!STRAPI_URL) {
  console.error("[VIOLATION_TYPE] Не задан URL_STRAPI (или STRAPI_URL) в .env");
  process.exit(1);
}

const http = axios.create({
  baseURL: STRAPI_URL,
  timeout: 30000,
});

function norm(v) {
  return String(v == null ? "" : v).replace(/\s+/g, " ").trim();
}

function getRaw(item) {
  return item?.data?.data ?? item?.data ?? item ?? {};
}

function getTopViolationType(item, raw) {
  return norm(item?.VIOLATION_TYPE || item?.attributes?.VIOLATION_TYPE);
}

function getRawViolationType(raw) {
  return norm(raw?.VIOLATION_TYPE);
}

function getDocumentId(item) {
  return item?.documentId || item?.id || null;
}

function getGuid(item, raw) {
  return norm(item?.guid || item?.VIOLATION_GUID_STR || raw?.guid || raw?.VIOLATION_GUID_STR);
}

function getCreateDate(item, raw) {
  return (
    norm(item?.createDateTime) ||
    norm(item?.createdAt) ||
    norm(raw?.F81_060_EVENTDATETIME) ||
    norm(raw?.createDateTime) ||
    "—"
  );
}

async function fetchPage(token, page) {
  const { data } = await http.get("/api/teh-narusheniyas", {
    params: {
      "pagination[page]": page,
      "pagination[pageSize]": PAGE_SIZE,
      "sort[0]": "createDateTime:asc",
      "sort[1]": "createdAt:asc",
      "filters[$or][0][VIOLATION_TYPE][$null]": true,
      "filters[$or][1][VIOLATION_TYPE][$eq]": "",
    },
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  return {
    rows: Array.isArray(data?.data) ? data.data : [],
    pageCount: Number(data?.meta?.pagination?.pageCount || 1),
    total: Number(data?.meta?.pagination?.total || 0),
  };
}

async function patchViolationType(token, documentId, violationType) {
  await http.put(
    `/api/teh-narusheniyas/${documentId}`,
    {
      data: {
        VIOLATION_TYPE: violationType,
      },
    },
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    }
  );
}

async function main() {
  console.log("[VIOLATION_TYPE] Старт backfill верхнего поля VIOLATION_TYPE");
  console.log(
    `[VIOLATION_TYPE] Режим: ${DRY_RUN ? "dry-run (без записи)" : "apply (с записью)"}`
  );
  console.log(`[VIOLATION_TYPE] Лимит обновлений: ${LIMIT}`);
  console.log(`[VIOLATION_TYPE] Размер страницы Strapi: ${PAGE_SIZE}`);

  const token = await getJwt();
  if (!token) {
    console.error("[VIOLATION_TYPE] Не удалось получить JWT для Strapi");
    process.exit(1);
  }

  let page = 1;
  let pageCount = 1;
  let total = 0;
  let updated = 0;
  let scanned = 0;
  let skippedHasTop = 0;
  let skippedNoRaw = 0;
  let failed = 0;

  while (page <= pageCount && updated < LIMIT) {
    console.log(`[VIOLATION_TYPE] Читаем страницу ${page}...`);
    const pack = await fetchPage(token, page);
    const rows = pack.rows;
    pageCount = pack.pageCount;
    total = pack.total;

    console.log(
      `[VIOLATION_TYPE] Страница ${page}: записей ${rows.length}, всего в коллекции ${total}`
    );

    for (const item of rows) {
      if (updated >= LIMIT) break;

      scanned += 1;
      const raw = getRaw(item);
      const documentId = getDocumentId(item);
      const topViolationType = getTopViolationType(item, raw);
      const rawViolationType = getRawViolationType(raw);
      const guid = getGuid(item, raw) || "без GUID";
      const created = getCreateDate(item, raw);

      if (!documentId) {
        failed += 1;
        console.log(
          `[VIOLATION_TYPE] Пропуск: не найден documentId/id для записи GUID=${guid}`
        );
        continue;
      }

      if (topViolationType) {
        skippedHasTop += 1;
        continue;
      }

      if (!rawViolationType) {
        skippedNoRaw += 1;
        console.log(
          `[VIOLATION_TYPE] Пропуск: у записи ${documentId} (${guid}) нет VIOLATION_TYPE во внутреннем json`
        );
        continue;
      }

      console.log(
        `[VIOLATION_TYPE] ${DRY_RUN ? "DRY-RUN" : "Обновляем"}: ` +
          `id=${documentId}, GUID=${guid}, дата=${created}, VIOLATION_TYPE=${rawViolationType}`
      );

      if (!DRY_RUN) {
        try {
          await patchViolationType(token, documentId, rawViolationType);
        } catch (e) {
          failed += 1;
          const msg = e?.response?.data?.error?.message || e?.message || "Неизвестная ошибка";
          console.log(
            `[VIOLATION_TYPE] Ошибка обновления id=${documentId}, GUID=${guid}: ${msg}`
          );
          continue;
        }
      }

      updated += 1;
    }

    page += 1;
  }

  console.log("[VIOLATION_TYPE] ----------------------------------------");
  console.log(`[VIOLATION_TYPE] Обход завершён`);
  console.log(`[VIOLATION_TYPE] Просмотрено записей: ${scanned}`);
  console.log(`[VIOLATION_TYPE] Обновлено записей: ${updated}`);
  console.log(`[VIOLATION_TYPE] Пропущено (верхнее поле уже заполнено): ${skippedHasTop}`);
  console.log(`[VIOLATION_TYPE] Пропущено (во внутреннем json нет VIOLATION_TYPE): ${skippedNoRaw}`);
  console.log(`[VIOLATION_TYPE] Ошибок: ${failed}`);
  console.log(
    `[VIOLATION_TYPE] Итоговый режим: ${DRY_RUN ? "dry-run, записи не менялись" : "apply, записи обновлены"}`
  );
}

main().catch((e) => {
  console.error(
    "[VIOLATION_TYPE] Скрипт завершился с ошибкой:",
    e?.response?.data?.error?.message || e?.message || e
  );
  process.exit(1);
});
