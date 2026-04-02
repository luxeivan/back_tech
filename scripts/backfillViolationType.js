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

async function fetchPage(token, page = 1) {
  const { data } = await http.get("/api/teh-narusheniyas", {
    params: {
      "pagination[page]": page,
      "pagination[pageSize]": PAGE_SIZE,
      "sort[0]": "id:asc",
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

function makeTypeCounter() {
  return {
    А: 0,
    В: 0,
    П: 0,
    other: 0,
  };
}

function bumpTypeCounter(counter, value) {
  const v = norm(value);
  if (v === "А" || v === "В" || v === "П") {
    counter[v] += 1;
    return;
  }
  counter.other += 1;
}

async function collectRemainingStats(token) {
  let page = 1;
  let pageCount = 1;
  let total = 0;
  const stats = makeTypeCounter();

  while (page <= pageCount) {
    const pack = await fetchPage(token, page);
    const rows = pack.rows;
    pageCount = pack.pageCount;
    total = pack.total;

    for (const item of rows) {
      const raw = getRaw(item);
      const topViolationType = getTopViolationType(item, raw);
      const rawViolationType = getRawViolationType(raw);

      if (topViolationType || !rawViolationType) continue;
      bumpTypeCounter(stats, rawViolationType);
    }

    page += 1;
  }

  return { total, stats };
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
  const startedAt = Date.now();
  const updateLimit = PROCESS_ALL ? Number.MAX_SAFE_INTEGER : LIMIT;

  console.log("[VIOLATION_TYPE] Старт backfill верхнего поля VIOLATION_TYPE");
  console.log(
    `[VIOLATION_TYPE] Режим: ${DRY_RUN ? "dry-run (без записи)" : "apply (с записью)"}`
  );
  if (GUID) {
    console.log(`[VIOLATION_TYPE] Точечный режим по GUID: ${GUID}`);
  } else {
    console.log(
      `[VIOLATION_TYPE] Лимит обновлений: ${PROCESS_ALL ? "все оставшиеся" : LIMIT}`
    );
    console.log("[VIOLATION_TYPE] Порядок обхода: по числовому id Strapi от старых к новым");
  }
  console.log(`[VIOLATION_TYPE] Размер страницы Strapi: ${PAGE_SIZE}`);

  const token = await getJwt();
  if (!token) {
    console.error("[VIOLATION_TYPE] Не удалось получить JWT для Strapi");
    process.exit(1);
  }

  if (!GUID && WITH_STATS) {
    console.log("[VIOLATION_TYPE] Считаем, сколько осталось записей по типам...");
    const remaining = await collectRemainingStats(token);
    console.log(`[VIOLATION_TYPE] Осталось записей с пустым верхним полем: ${remaining.total}`);
    console.log(
      `[VIOLATION_TYPE] Остаток по типам: П=${remaining.stats.П}, В=${remaining.stats.В}, А=${remaining.stats.А}, прочее=${remaining.stats.other}`
    );
  }

  let total = 0;
  let updated = 0;
  let scanned = 0;
  let skippedHasTop = 0;
  let skippedNoRaw = 0;
  let failed = 0;
  const updatedByType = makeTypeCounter();

  if (GUID) {
    console.log("[VIOLATION_TYPE] Ищем запись по GUID...");
    const item = await fetchByGuid(token, GUID);

    if (!item) {
      console.log(`[VIOLATION_TYPE] Запись с GUID=${GUID} не найдена`);
      process.exit(1);
    }

    scanned = 1;
    const raw = getRaw(item);
    const rowId = getRowId(item);
    const documentId = getDocumentId(item);
    const topViolationType = getTopViolationType(item, raw);
    const rawViolationType = getRawViolationType(raw);
    const guid = getGuid(item, raw) || GUID;
    const created = getCreateDate(item, raw);

    console.log(
      `[VIOLATION_TYPE] Найдена запись: rowId=${rowId || "—"}, documentId=${documentId}, GUID=${guid}, дата=${created}, верхнее=${topViolationType || "пусто"}, внутреннее=${rawViolationType || "пусто"}`
    );

    if (!documentId) {
      console.log("[VIOLATION_TYPE] Не найден documentId/id, обновление невозможно");
      process.exit(1);
    }

    if (topViolationType) {
      skippedHasTop = 1;
      console.log("[VIOLATION_TYPE] Верхнее поле уже заполнено, обновление не требуется");
      return;
    }

    if (!rawViolationType) {
      skippedNoRaw = 1;
      console.log("[VIOLATION_TYPE] Во внутреннем json нет VIOLATION_TYPE, обновление невозможно");
      return;
    }

    console.log(
      `[VIOLATION_TYPE] ${DRY_RUN ? "DRY-RUN" : "Обновляем"}: rowId=${rowId || "—"}, documentId=${documentId}, GUID=${guid}, VIOLATION_TYPE=${rawViolationType}`
    );

    if (!DRY_RUN) {
      await patchViolationType(token, documentId, rawViolationType);
    }

    updated = 1;
    bumpTypeCounter(updatedByType, rawViolationType);
    console.log("[VIOLATION_TYPE] Точечный режим завершён успешно");
    console.log(
      `[VIOLATION_TYPE] Время выполнения: ${((Date.now() - startedAt) / 1000).toFixed(2)} сек`
    );
    return;
  }

  while (updated < updateLimit) {
    console.log("[VIOLATION_TYPE] Читаем текущую первую страницу оставшихся записей...");
    const pack = await fetchPage(token, 1);
    const rows = pack.rows;
    total = pack.total;

    console.log(
      `[VIOLATION_TYPE] В выборке сейчас: записей на странице ${rows.length}, всего осталось ${total}`
    );

    if (!rows.length) {
      console.log("[VIOLATION_TYPE] Больше записей с пустым верхним полем не осталось");
      break;
    }

    for (const item of rows) {
      if (updated >= updateLimit) break;

      scanned += 1;
      const raw = getRaw(item);
      const rowId = getRowId(item);
      const documentId = getDocumentId(item);
      const topViolationType = getTopViolationType(item, raw);
      const rawViolationType = getRawViolationType(raw);
      const guid = getGuid(item, raw) || "без GUID";
      const created = getCreateDate(item, raw);

      if (!documentId) {
        failed += 1;
        console.log(
          `[VIOLATION_TYPE] Пропуск: не найден documentId/id для записи rowId=${rowId || "—"}, GUID=${guid}`
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
          `[VIOLATION_TYPE] Пропуск: у записи rowId=${rowId || "—"}, documentId=${documentId} (${guid}) нет VIOLATION_TYPE во внутреннем json`
        );
        continue;
      }

      console.log(
        `[VIOLATION_TYPE] ${DRY_RUN ? "DRY-RUN" : "Обновляем"}: ` +
          `rowId=${rowId || "—"}, documentId=${documentId}, GUID=${guid}, дата=${created}, VIOLATION_TYPE=${rawViolationType}`
      );

      if (!DRY_RUN) {
        try {
          await patchViolationType(token, documentId, rawViolationType);
        } catch (e) {
          failed += 1;
          const msg = e?.response?.data?.error?.message || e?.message || "Неизвестная ошибка";
          console.log(
            `[VIOLATION_TYPE] Ошибка обновления rowId=${rowId || "—"}, documentId=${documentId}, GUID=${guid}: ${msg}`
          );
          continue;
        }
      }

      updated += 1;
      bumpTypeCounter(updatedByType, rawViolationType);
    }
  }

  console.log("[VIOLATION_TYPE] ----------------------------------------");
  console.log(`[VIOLATION_TYPE] Обход завершён`);
  console.log(`[VIOLATION_TYPE] Просмотрено записей: ${scanned}`);
  console.log(`[VIOLATION_TYPE] Обновлено записей: ${updated}`);
  console.log(`[VIOLATION_TYPE] Пропущено (верхнее поле уже заполнено): ${skippedHasTop}`);
  console.log(`[VIOLATION_TYPE] Пропущено (во внутреннем json нет VIOLATION_TYPE): ${skippedNoRaw}`);
  console.log(`[VIOLATION_TYPE] Ошибок: ${failed}`);
  console.log(
    `[VIOLATION_TYPE] Обновлено по типам: П=${updatedByType.П}, В=${updatedByType.В}, А=${updatedByType.А}, прочее=${updatedByType.other}`
  );
  console.log(
    `[VIOLATION_TYPE] Время выполнения: ${((Date.now() - startedAt) / 1000).toFixed(2)} сек`
  );
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
