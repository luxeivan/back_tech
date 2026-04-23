#!/usr/bin/env node
require("dotenv").config();

const axios = require("axios");
const { getJwt } = require("../services/modus/strapi");

const argv = process.argv.slice(2);
const hasFlag = (name) => argv.includes(name);
const getArg = (name, fallback = "") => {
  const i = argv.lastIndexOf(name);
  if (i === -1) return fallback;
  return argv[i + 1] || fallback;
};

const APPLY = hasFlag("--apply");
const DRY_RUN = hasFlag("--dry-run") || !APPLY;
const PROCESS_ALL = hasFlag("--all");
const LIMIT = Math.max(1, Number(getArg("--limit", "1000")) || 1000);
const PAGE_SIZE = Math.max(10, Math.min(200, Number(getArg("--page-size", "100")) || 100));
const GUID = norm(getArg("--guid", ""));
const STRAPI_URL = String(process.env.URL_STRAPI || process.env.STRAPI_URL || "").replace(/\/$/, "");

if (!STRAPI_URL) {
  console.error("[П->А] Не задан URL_STRAPI (или STRAPI_URL) в .env");
  process.exit(1);
}

const http = axios.create({
  baseURL: STRAPI_URL,
  timeout: 30000,
});

function norm(v) {
  return String(v == null ? "" : v).replace(/\s+/g, " ").trim();
}

function toTypeCode(v) {
  return norm(v).toUpperCase();
}

function getSource(item) {
  const attrs = item?.attributes;
  if (attrs && typeof attrs === "object") {
    return { ...attrs, id: item?.id ?? attrs.id };
  }
  return item || {};
}

function getRawInfo(src) {
  const nested = src?.data?.data;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    return { raw: nested, hasNestedRaw: true };
  }
  const direct = src?.data;
  if (direct && typeof direct === "object" && !Array.isArray(direct)) {
    return { raw: direct, hasNestedRaw: true };
  }
  return { raw: {}, hasNestedRaw: false };
}

function getDocumentId(src) {
  return src?.documentId || src?.id || null;
}

function getRowId(src) {
  return src?.id || null;
}

function getGuid(src, raw) {
  return norm(src?.guid || src?.VIOLATION_GUID_STR || raw?.guid || raw?.VIOLATION_GUID_STR);
}

function getNumber(src, raw) {
  return norm(src?.number || src?.F81_010_NUMBER || raw?.F81_010_NUMBER);
}

function getTopType(src) {
  return toTypeCode(src?.VIOLATION_TYPE);
}

function getRawType(raw) {
  return toTypeCode(raw?.VIOLATION_TYPE);
}

function isTargetType(topType, rawType) {
  return topType === "П" || rawType === "П";
}

function buildPatch(src, raw, hasNestedRaw) {
  const topType = getTopType(src);
  const rawType = getRawType(raw);
  const patch = {};

  if (topType !== "А") {
    patch.VIOLATION_TYPE = "А";
  }

  if (hasNestedRaw && rawType === "П") {
    patch.data = { ...raw, VIOLATION_TYPE: "А" };
  }

  return patch;
}

function describeTarget(src, raw) {
  const guid = getGuid(src, raw) || "без GUID";
  const number = getNumber(src, raw) || "—";
  const topType = getTopType(src) || "пусто";
  const rawType = getRawType(raw) || "пусто";
  const documentId = getDocumentId(src) || "—";
  const rowId = getRowId(src) || "—";
  return `rowId=${rowId}, documentId=${documentId}, №=${number}, GUID=${guid}, верхнее=${topType}, внутреннее=${rawType}`;
}

function explainPatch(patch) {
  const changes = [];
  if (patch.VIOLATION_TYPE) {
    changes.push(`верхнее VIOLATION_TYPE -> ${patch.VIOLATION_TYPE}`);
  }
  if (patch.data?.VIOLATION_TYPE) {
    changes.push(`внутреннее data.VIOLATION_TYPE -> ${patch.data.VIOLATION_TYPE}`);
  }
  return changes.join(", ") || "изменений нет";
}

async function fetchPage(token, page) {
  const { data } = await http.get("/api/teh-narusheniyas", {
    params: {
      "pagination[page]": page,
      "pagination[pageSize]": PAGE_SIZE,
      "sort[0]": "id:asc",
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

async function patchRecord(token, src, patch) {
  const documentId = src?.documentId || null;
  const rowId = src?.id || null;

  const tryPatch = async (targetId) =>
    http.put(
      `/api/teh-narusheniyas/${targetId}`,
      { data: patch },
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }
    );

  if (documentId) {
    try {
      return await tryPatch(documentId);
    } catch (e) {
      if (e?.response?.status === 404 && rowId && String(rowId) !== String(documentId)) {
        return tryPatch(rowId);
      }
      throw e;
    }
  }

  if (rowId) {
    return tryPatch(rowId);
  }

  throw new Error("Не найден documentId/id для обновления");
}

async function processOne({ src, raw, hasNestedRaw, token, dryRun }) {
  const patch = buildPatch(src, raw, hasNestedRaw);
  if (!Object.keys(patch).length) {
    return { ok: true, updated: false, reason: "нет изменений" };
  }

  if (dryRun) {
    return { ok: true, updated: false, dryRun: true, patch };
  }

  await patchRecord(token, src, patch);
  return { ok: true, updated: true, patch };
}

async function main() {
  const startedAt = Date.now();
  const updateLimit = PROCESS_ALL ? Number.MAX_SAFE_INTEGER : LIMIT;

  console.log("[П->А] Старт скрипта замены VIOLATION_TYPE: П -> А");
  console.log(`[П->А] Режим: ${DRY_RUN ? "dry-run (без записи)" : "apply (с записью)"}`);
  if (GUID) {
    console.log(`[П->А] Точечный режим по GUID: ${GUID}`);
  } else {
    console.log(`[П->А] Лимит обработки: ${PROCESS_ALL ? "без ограничений" : LIMIT}`);
    console.log(`[П->А] Размер страницы: ${PAGE_SIZE}`);
    console.log("[П->А] Обход: по всем ТН от старых к новым (sort id:asc)");
  }

  const token = await getJwt();
  if (!token) {
    console.error("[П->А] Не удалось получить JWT для Strapi");
    process.exit(1);
  }

  let scanned = 0;
  let matched = 0;
  let matchedTop = 0;
  let matchedRaw = 0;
  let updated = 0;
  let dryRunPlanned = 0;
  let failed = 0;
  let withoutId = 0;
  let processedTargets = 0;

  if (GUID) {
    const item = await fetchByGuid(token, GUID);
    if (!item) {
      console.log(`[П->А] Запись с GUID=${GUID} не найдена`);
      process.exit(1);
    }

    const src = getSource(item);
    const { raw, hasNestedRaw } = getRawInfo(src);
    const topType = getTopType(src);
    const rawType = getRawType(raw);

    scanned = 1;

    console.log(`[П->А] Найдена запись: ${describeTarget(src, raw)}`);

    if (!isTargetType(topType, rawType)) {
      console.log("[П->А] У записи нет типа П ни в верхнем поле, ни во внутреннем JSON. Изменения не требуются.");
      return;
    }

    matched = 1;
    if (topType === "П") matchedTop += 1;
    if (rawType === "П") matchedRaw += 1;

    if (!getDocumentId(src) && !getRowId(src)) {
      withoutId = 1;
      console.log("[П->А] Не найден documentId/id, обновление невозможно");
    } else {
      const result = await processOne({ src, raw, hasNestedRaw, token, dryRun: DRY_RUN });
      if (result.ok && result.updated) {
        updated = 1;
        console.log(`[П->А] Обновлено: ${explainPatch(result.patch)}`);
      } else if (result.ok && result.dryRun) {
        dryRunPlanned = 1;
        console.log(`[П->А] DRY-RUN: ${explainPatch(result.patch)}`);
      } else if (!result.ok) {
        failed = 1;
        console.log(`[П->А] Ошибка: ${result.reason}`);
      }
    }

    console.log("[П->А] ----------------------------------------");
    console.log(`[П->А] Проверено записей: ${scanned}`);
    console.log(`[П->А] Найдено целей (П): ${matched}`);
    console.log(`[П->А] Из них верхнее поле П: ${matchedTop}`);
    console.log(`[П->А] Из них внутреннее поле П: ${matchedRaw}`);
    console.log(`[П->А] Обновлено: ${updated}`);
    console.log(`[П->А] К обновлению (dry-run): ${dryRunPlanned}`);
    console.log(`[П->А] Пропущено без documentId/id: ${withoutId}`);
    console.log(`[П->А] Ошибок: ${failed}`);
    console.log(
      `[П->А] Время выполнения: ${((Date.now() - startedAt) / 1000).toFixed(2)} сек`
    );
    return;
  }

  let page = 1;
  let pageCount = 1;

  while (page <= pageCount) {
    const pack = await fetchPage(token, page);
    const rows = pack.rows;
    pageCount = pack.pageCount;

    console.log(
      `[П->А] Страница ${page}/${pageCount}: получено ${rows.length} записей (всего в базе: ${pack.total})`
    );

    for (const item of rows) {
      if (processedTargets >= updateLimit) break;

      scanned += 1;
      const src = getSource(item);
      const { raw, hasNestedRaw } = getRawInfo(src);
      const topType = getTopType(src);
      const rawType = getRawType(raw);

      if (!isTargetType(topType, rawType)) {
        continue;
      }

      matched += 1;
      processedTargets += 1;
      if (topType === "П") matchedTop += 1;
      if (rawType === "П") matchedRaw += 1;

      const targetInfo = describeTarget(src, raw);

      if (!getDocumentId(src) && !getRowId(src)) {
        withoutId += 1;
        console.log(`[П->А] Пропуск (нет id): ${targetInfo}`);
        continue;
      }

      try {
        const result = await processOne({ src, raw, hasNestedRaw, token, dryRun: DRY_RUN });
        if (result.ok && result.updated) {
          updated += 1;
          console.log(`[П->А] Обновлено: ${targetInfo}; ${explainPatch(result.patch)}`);
        } else if (result.ok && result.dryRun) {
          dryRunPlanned += 1;
          console.log(`[П->А] DRY-RUN: ${targetInfo}; ${explainPatch(result.patch)}`);
        } else {
          console.log(`[П->А] Пропуск: ${targetInfo}; причина=${result.reason}`);
        }
      } catch (e) {
        failed += 1;
        const msg = e?.response?.data?.error?.message || e?.message || "Неизвестная ошибка";
        console.log(`[П->А] Ошибка: ${targetInfo}; причина=${msg}`);
      }
    }

    if (processedTargets >= updateLimit) {
      console.log(
        `[П->А] Достигнут лимит обработки ${updateLimit}. Останавливаем обход.`
      );
      break;
    }

    page += 1;
  }

  console.log("[П->А] ----------------------------------------");
  console.log(`[П->А] Обход завершён`);
  console.log(`[П->А] Проверено записей: ${scanned}`);
  console.log(`[П->А] Найдено целей (П): ${matched}`);
  console.log(`[П->А] Из них верхнее поле П: ${matchedTop}`);
  console.log(`[П->А] Из них внутреннее поле П: ${matchedRaw}`);
  console.log(`[П->А] Обновлено: ${updated}`);
  console.log(`[П->А] К обновлению (dry-run): ${dryRunPlanned}`);
  console.log(`[П->А] Пропущено без documentId/id: ${withoutId}`);
  console.log(`[П->А] Ошибок: ${failed}`);
  console.log(
    `[П->А] Время выполнения: ${((Date.now() - startedAt) / 1000).toFixed(2)} сек`
  );
  console.log(
    `[П->А] Итоговый режим: ${DRY_RUN ? "dry-run, записи не менялись" : "apply, изменения применены"}`
  );
}

main().catch((e) => {
  console.error(
    "[П->А] Скрипт завершился с ошибкой:",
    e?.response?.data?.error?.message || e?.message || e
  );
  process.exit(1);
});
