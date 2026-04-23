#!/usr/bin/env node
require("dotenv").config();

const axios = require("axios");
const { getJwt } = require("../services/modus/strapi");

const argv = process.argv.slice(2);
const hasFlag = (f) => argv.includes(f);
const getArg = (name, fallback = "") => {
  const i = argv.indexOf(name);
  if (i === -1) return fallback;
  return argv[i + 1] || fallback;
};

const APPLY = hasFlag("--apply");
const DRY_RUN = !APPLY;
const STRAPI_URL = String(process.env.URL_STRAPI || process.env.STRAPI_URL || "").replace(/\/$/, "");
const ENDPOINT = String(process.env.STRAPI_PES_MAP_ALLOWLIST_ENDPOINT || "pes-map-allowlists").trim();
const JWT_OVERRIDE = String(getArg("--jwt", getArg("--token", ""))).trim();
const API_TOKEN = String(process.env.STRAPI_API_TOKEN || "").trim();

if (!STRAPI_URL) {
  console.error("[PES-MAP-SEED] Не задан URL_STRAPI (или STRAPI_URL) в .env");
  process.exit(1);
}

const RAW_IDS = [
  52459, 53810, 24490, 53832, 52879, 53796, 53973, 54102, 54093, 21718, 52957,
  957, 54083, 24358, 1152, 53561, 52529, 53833, 977, 54099, 52878, 54113, 54092,
  53852, 54066, 1173, 54128, 54119, 53834, 53945, 52498, 52455, 54091, 54067,
  52465, 1142, 19808, 53001, 54071, 54127, 54105, 1138, 51598, 53835, 1072,
  54111, 1097, 52461, 54084, 51556, 962, 24807, 54090, 53850, 1066, 52466,
  51824, 24798, 54126, 52447, 21808, 53836, 24325, 24786, 54130, 54116, 53917,
  19847, 1110, 1153, 52462, 21812, 1160, 53851, 52467, 53956, 52882, 52212,
  1071, 54125, 54107, 53924, 51750, 53837, 54131, 54117, 1111, 52888, 54086,
  53939, 51479, 1213, 942, 53977, 54124, 54106, 54088, 54097, 19837, 54132,
  52967, 54087, 52494, 973, 53948, 52689, 53573, 52469, 53954, 19804, 54123,
  54101, 54089, 54096, 51605, 52718, 19850, 24800, 54115, 54080, 53989, 53830,
  54949, 53971, 54100, 53923, 54095, 54081, 53929, 53831, 53855, 996, 24344,
  53797, 1123, 53984, 19855, 53949, 51483, 51771, 51598,
];

function toInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function uniqueIds(arr) {
  const seen = new Set();
  const out = [];
  const dups = new Set();
  for (const raw of arr) {
    const n = toInt(raw);
    if (!Number.isFinite(n)) continue;
    if (seen.has(n)) {
      dups.add(n);
      continue;
    }
    seen.add(n);
    out.push(n);
  }
  return { ids: out, dups: Array.from(dups).sort((a, b) => a - b) };
}

function extractPesId(row) {
  const src = row?.attributes || row || {};
  return toInt(src?.pesId ?? src?.pesid ?? src?.pes_id);
}

async function getAuthToken() {
  if (JWT_OVERRIDE) return JWT_OVERRIDE;
  if (API_TOKEN) return API_TOKEN;
  const jwt = await getJwt();
  return jwt || "";
}

async function fetchExisting(token) {
  const all = [];
  let page = 1;
  let pageCount = 1;

  while (page <= pageCount) {
    const resp = await axios.get(`${STRAPI_URL}/api/${ENDPOINT}`, {
      headers: { Authorization: `Bearer ${token}` },
      params: {
        "fields[0]": "pesId",
        "pagination[page]": page,
        // Strapi на сервере ограничивает pageSize до 100.
        "pagination[pageSize]": 100,
        publicationState: "preview",
      },
      timeout: 30000,
    });

    const rows = Array.isArray(resp?.data?.data) ? resp.data.data : [];
    rows.forEach((r) => all.push(r));
    pageCount = Number(resp?.data?.meta?.pagination?.pageCount || 1);
    page += 1;
  }

  return all;
}

async function createRow(token, pesId) {
  await axios.post(
    `${STRAPI_URL}/api/${ENDPOINT}`,
    { data: { pesId } },
    {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 30000,
    }
  );
}

async function main() {
  const { ids: targetIds, dups: sourceDups } = uniqueIds(RAW_IDS);
  const token = await getAuthToken();
  if (!token) {
    console.error("[PES-MAP-SEED] Не удалось получить JWT/API токен для Strapi");
    process.exit(1);
  }

  console.log(`[PES-MAP-SEED] URL: ${STRAPI_URL}`);
  console.log(`[PES-MAP-SEED] Коллекция: ${ENDPOINT}`);
  console.log(`[PES-MAP-SEED] Режим: ${DRY_RUN ? "DRY-RUN" : "APPLY"}`);
  console.log(`[PES-MAP-SEED] Входных ID: ${RAW_IDS.length}`);
  console.log(`[PES-MAP-SEED] Уникальных ID: ${targetIds.length}`);
  if (sourceDups.length) {
    console.log(`[PES-MAP-SEED] Дубли в исходном списке удалены: ${sourceDups.join(", ")}`);
  }

  const existingRows = await fetchExisting(token);
  const existingIdsRaw = existingRows.map(extractPesId).filter((v) => Number.isFinite(v));
  const { ids: existingIds, dups: existingDups } = uniqueIds(existingIdsRaw);
  const existingSet = new Set(existingIds);
  const targetSet = new Set(targetIds);

  const missing = targetIds.filter((id) => !existingSet.has(id));
  const extra = existingIds.filter((id) => !targetSet.has(id));

  console.log(`[PES-MAP-SEED] Уже в Strapi: ${existingIds.length}`);
  if (existingDups.length) {
    console.log(`[PES-MAP-SEED] Дубли в Strapi (по pesId): ${existingDups.join(", ")}`);
  }
  console.log(`[PES-MAP-SEED] Нужно добавить: ${missing.length}`);
  console.log(`[PES-MAP-SEED] Лишних в Strapi (не трогаем): ${extra.length}`);

  if (!missing.length) {
    console.log("[PES-MAP-SEED] Всё уже актуально, добавлять нечего.");
    return;
  }

  if (DRY_RUN) {
    console.log(
      `[PES-MAP-SEED] DRY-RUN завершен. Пример ID к добавлению: ${missing
        .slice(0, 20)
        .join(", ")}${missing.length > 20 ? ", ..." : ""}`
    );
    return;
  }

  let created = 0;
  for (let i = 0; i < missing.length; i += 1) {
    const pesId = missing[i];
    await createRow(token, pesId);
    created += 1;
    if (created % 20 === 0 || created === missing.length) {
      console.log(`[PES-MAP-SEED] Добавлено ${created}/${missing.length}`);
    }
  }

  const finalRows = await fetchExisting(token);
  const finalIds = new Set(finalRows.map(extractPesId).filter((v) => Number.isFinite(v)));
  const finalCovered = targetIds.filter((id) => finalIds.has(id)).length;

  console.log("[PES-MAP-SEED] Готово.");
  console.log(`[PES-MAP-SEED] Всего записей в коллекции: ${finalIds.size}`);
  console.log(`[PES-MAP-SEED] Покрытие целевого списка: ${finalCovered}/${targetIds.length}`);
}

main().catch((e) => {
  const status = e?.response?.status;
  const body = e?.response?.data;
  console.error("[PES-MAP-SEED] Ошибка:", status || e?.message || e);
  if (body) {
    console.error("[PES-MAP-SEED] Ответ Strapi:", JSON.stringify(body, null, 2));
  }
  process.exit(1);
});
