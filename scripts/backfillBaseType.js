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
const PROCESS_ALL = hasFlag("--all");
const WITH_STATS = hasFlag("--stats");
const LIMIT = Math.max(1, Number(getArg("--limit", "1000")) || 1000);
const PAGE_SIZE = Math.max(10, Math.min(200, Number(getArg("--page-size", "100")) || 100));
const GUID = norm(getArg("--guid", ""));
const TARGET_BASE_TYPE = 0;
const STRAPI_URL = String(process.env.URL_STRAPI || process.env.STRAPI_URL || "").replace(/\/$/, "");

if (!STRAPI_URL) {
  console.error("[BASE_TYPE] Не задан URL_STRAPI (или STRAPI_URL) в .env");
  process.exit(1);
}

const http = axios.create({
  baseURL: STRAPI_URL,
  timeout: 30000,
});

function norm(v) {
  return String(v == null ? "" : v).replace(/\s+/g, " ").trim();
}

function hasFilledValue(v) {
  return v !== null && v !== undefined && norm(v) !== "";
}

function getRaw(item) {
  return item?.data?.data ?? item?.data ?? item ?? {};
}

function getTopBaseType(item) {
  const value = item?.BASE_TYPE ?? item?.attributes?.BASE_TYPE;
  return hasFilledValue(value) ? Number(value) : null;
}

function getRawBaseType(raw) {
  return hasFilledValue(raw?.BASE_TYPE) ? Number(raw.BASE_TYPE) : null;
}

function getDocumentId(item) {
  return item?.documentId || item?.id || null;
}

function getRowId(item) {
  return item?.id || null;
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

async function fetchEmptyPage(token, page = 1) {
  const { data } = await http.get("/api/teh-narusheniyas", {
    params: {
      "pagination[page]": page,
      "pagination[pageSize]": PAGE_SIZE,
      "sort[0]": "id:asc",
      "filters[BASE_TYPE][$null]": true,
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

async function fetchByGuid(token, guid) {
  const { data } = await http.get("/api/teh-narusheniyas", {
    params: {
      "filters[guid][$eq]": guid,
      "pagination[pageSize]": 1,
    },
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  return Array.isArray(data?.data) ? data.data[0] || null : null;
}

async function patchBaseType(token, documentId, baseType) {
  await http.put(
    `/api/teh-narusheniyas/${documentId}`,
    {
      data: {
        BASE_TYPE: baseType,
      },
    },
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    }
  );
}

function createStats() {
  return {
    raw0: 0,
    raw1: 0,
    rawEmpty: 0,
    rawOther: 0,
  };
}

function bumpRawStats(stats, value) {
  if (value === 0) {
    stats.raw0 += 1;
    return;
  }
  if (value === 1) {
    stats.raw1 += 1;
    return;
  }
  if (value === null) {
    stats.rawEmpty += 1;
    return;
  }
  stats.rawOther += 1;
}

async function collectRemainingStats(token) {
  let page = 1;
  let pageCount = 1;
  let total = 0;
  const stats = createStats();

  while (page <= pageCount) {
    const pack = await fetchEmptyPage(token, page);
    pageCount = pack.pageCount;
    total = pack.total;

    for (const item of pack.rows) {
      const raw = getRaw(item);
      bumpRawStats(stats, getRawBaseType(raw));
    }

    page += 1;
  }

  return { total, stats };
}

async function processItem({ token, item, dryRunLabel }) {
  const raw = getRaw(item);
  const rowId = getRowId(item);
  const documentId = getDocumentId(item);
  const guid = getGuid(item, raw) || "без GUID";
  const created = getCreateDate(item, raw);
  const topBaseType = getTopBaseType(item);
  const rawBaseType = getRawBaseType(raw);

  if (!documentId) {
    return {
      ok: false,
      skippedHasTop: 0,
      message: `[BASE_TYPE] Пропуск: не найден documentId/id для rowId=${rowId || "—"}, GUID=${guid}`,
    };
  }

  if (topBaseType !== null) {
    return {
      ok: true,
      skippedHasTop: 1,
      message: `[BASE_TYPE] Пропуск: верхнее поле уже заполнено (${topBaseType}) для rowId=${rowId || "—"}, documentId=${documentId}, GUID=${guid}`,
    };
  }

  const message =
    `[BASE_TYPE] ${dryRunLabel}: ` +
    `rowId=${rowId || "—"}, documentId=${documentId}, GUID=${guid}, дата=${created}, ` +
    `верхнее=пусто, внутреннее=${rawBaseType === null ? "пусто" : rawBaseType}, ставим=${TARGET_BASE_TYPE}`;

  if (!DRY_RUN) {
    await patchBaseType(token, documentId, TARGET_BASE_TYPE);
  }

  return {
    ok: true,
    skippedHasTop: 0,
    message,
  };
}

async function main() {
  const startedAt = Date.now();
  const updateLimit = PROCESS_ALL ? Number.MAX_SAFE_INTEGER : LIMIT;

  console.log("[BASE_TYPE] Старт backfill верхнего поля BASE_TYPE");
  console.log(`[BASE_TYPE] Режим: ${DRY_RUN ? "dry-run (без записи)" : "apply (с записью)"}`);
  console.log("[BASE_TYPE] Правило: пустое верхнее BASE_TYPE -> 0");
  console.log("[BASE_TYPE] Уже заполненные значения не перетираем");
  if (GUID) {
    console.log(`[BASE_TYPE] Точечный режим по GUID: ${GUID}`);
  } else {
    console.log(`[BASE_TYPE] Лимит обновлений: ${PROCESS_ALL ? "все оставшиеся" : LIMIT}`);
    console.log("[BASE_TYPE] Порядок обхода: по числовому id Strapi от старых к новым");
  }
  console.log(`[BASE_TYPE] Размер страницы Strapi: ${PAGE_SIZE}`);

  const token = await getJwt();
  if (!token) {
    console.error("[BASE_TYPE] Не удалось получить JWT для Strapi");
    process.exit(1);
  }

  if (!GUID && WITH_STATS) {
    console.log("[BASE_TYPE] Считаем остаток записей с пустым верхним BASE_TYPE...");
    const remaining = await collectRemainingStats(token);
    console.log(`[BASE_TYPE] Осталось записей с пустым верхним BASE_TYPE: ${remaining.total}`);
    console.log(
      `[BASE_TYPE] Внутренний data.BASE_TYPE среди них: 0=${remaining.stats.raw0}, 1=${remaining.stats.raw1}, пусто=${remaining.stats.rawEmpty}, прочее=${remaining.stats.rawOther}`
    );
  }

  let total = 0;
  let scanned = 0;
  let updated = 0;
  let skippedHasTop = 0;
  let failed = 0;

  if (GUID) {
    console.log("[BASE_TYPE] Ищем запись по GUID...");
    const item = await fetchByGuid(token, GUID);

    if (!item) {
      console.log(`[BASE_TYPE] Запись с GUID=${GUID} не найдена`);
      process.exit(1);
    }

    scanned = 1;
    const result = await processItem({
      token,
      item,
      dryRunLabel: DRY_RUN ? "DRY-RUN" : "Обновляем",
    });

    console.log(result.message);
    skippedHasTop += result.skippedHasTop;
    updated = result.skippedHasTop ? 0 : 1;

    console.log("[BASE_TYPE] Точечный режим завершён");
    console.log(`[BASE_TYPE] Обновлено записей: ${DRY_RUN ? 0 : updated}`);
    console.log(`[BASE_TYPE] Время выполнения: ${((Date.now() - startedAt) / 1000).toFixed(2)} сек`);
    return;
  }

  if (DRY_RUN) {
    let page = 1;
    let pageCount = 1;

    while (page <= pageCount && scanned < updateLimit) {
      console.log(`[BASE_TYPE] DRY-RUN: читаем страницу ${page}...`);
      const pack = await fetchEmptyPage(token, page);
      pageCount = pack.pageCount;
      total = pack.total;

      console.log(
        `[BASE_TYPE] В выборке сейчас: записей на странице ${pack.rows.length}, всего пустых ${total}`
      );

      for (const item of pack.rows) {
        if (scanned >= updateLimit) break;
        scanned += 1;
        try {
          const result = await processItem({
            token,
            item,
            dryRunLabel: "DRY-RUN",
          });
          console.log(result.message);
          skippedHasTop += result.skippedHasTop;
          if (!result.skippedHasTop) updated += 1;
        } catch (e) {
          failed += 1;
          const msg = e?.response?.data?.error?.message || e?.message || "Неизвестная ошибка";
          console.log(`[BASE_TYPE] Ошибка dry-run обработки: ${msg}`);
        }
      }

      page += 1;
    }
  } else {
    while (updated < updateLimit) {
      console.log("[BASE_TYPE] Читаем текущую первую страницу оставшихся пустых записей...");
      const pack = await fetchEmptyPage(token, 1);
      const rows = pack.rows;
      total = pack.total;

      console.log(
        `[BASE_TYPE] В выборке сейчас: записей на странице ${rows.length}, всего осталось ${total}`
      );

      if (!rows.length) {
        console.log("[BASE_TYPE] Больше записей с пустым верхним BASE_TYPE не осталось");
        break;
      }

      for (const item of rows) {
        if (updated >= updateLimit) break;
        scanned += 1;

        try {
          const result = await processItem({
            token,
            item,
            dryRunLabel: "Обновляем",
          });
          console.log(result.message);
          skippedHasTop += result.skippedHasTop;
          if (!result.skippedHasTop) updated += 1;
        } catch (e) {
          failed += 1;
          const msg = e?.response?.data?.error?.message || e?.message || "Неизвестная ошибка";
          const raw = getRaw(item);
          const rowId = getRowId(item);
          const documentId = getDocumentId(item);
          const guid = getGuid(item, raw) || "без GUID";
          console.log(
            `[BASE_TYPE] Ошибка обновления rowId=${rowId || "—"}, documentId=${documentId || "—"}, GUID=${guid}: ${msg}`
          );
        }
      }
    }
  }

  console.log("[BASE_TYPE] ----------------------------------------");
  console.log("[BASE_TYPE] Обход завершён");
  console.log(`[BASE_TYPE] Просмотрено записей: ${scanned}`);
  console.log(`[BASE_TYPE] ${DRY_RUN ? "Будет обновлено при apply" : "Обновлено записей"}: ${updated}`);
  console.log(`[BASE_TYPE] Пропущено (верхнее поле уже заполнено): ${skippedHasTop}`);
  console.log(`[BASE_TYPE] Ошибок: ${failed}`);
  console.log(`[BASE_TYPE] Время выполнения: ${((Date.now() - startedAt) / 1000).toFixed(2)} сек`);
  console.log(
    `[BASE_TYPE] Итоговый режим: ${DRY_RUN ? "dry-run, записи не менялись" : "apply, записи обновлены"}`
  );
}

main().catch((e) => {
  console.error(
    "[BASE_TYPE] Скрипт завершился с ошибкой:",
    e?.response?.data?.error?.message || e?.message || e
  );
  process.exit(1);
});
