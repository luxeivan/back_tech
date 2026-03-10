#!/usr/bin/env node
require("dotenv").config();

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const XLSX = require("xlsx");

const DEFAULT_POINTS_XLSX = path.resolve(
  __dirname,
  "../import_data/+Приложение_5_Справочник_точек_сбора_ПЭС.xlsx"
);

const argv = process.argv.slice(2);
const hasFlag = (name) => argv.includes(name);
const getArg = (name, fallback = "") => {
  const i = argv.indexOf(name);
  if (i === -1) return fallback;
  return argv[i + 1] || fallback;
};

const APPLY = hasFlag("--apply");
const XLSX_FILE = getArg("--file", DEFAULT_POINTS_XLSX);
const STRAPI_URL = String(process.env.URL_STRAPI || process.env.STRAPI_URL || "").replace(/\/$/, "");
const STRAPI_LOGIN = process.env.LOGIN_STRAPI || "";
const STRAPI_PASSWORD = process.env.PASSWORD_STRAPI || "";
const STRAPI_API_TOKEN = process.env.STRAPI_API_TOKEN || "";
const BRANCHES_ENDPOINT = process.env.STRAPI_PES_BRANCHES_ENDPOINT || "pes-branches";

if (!STRAPI_URL) {
  console.error("[ERR] Не задан URL_STRAPI (или STRAPI_URL) в .env");
  process.exit(1);
}

if (!fs.existsSync(XLSX_FILE)) {
  console.error(`[ERR] Не найден файл Excel: ${XLSX_FILE}`);
  process.exit(1);
}

const http = axios.create({
  baseURL: STRAPI_URL,
  timeout: 30000,
});

function norm(v) {
  return String(v == null ? "" : v)
    .replace(/\s+/g, " ")
    .trim();
}

function keyify(v) {
  return norm(v)
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/филиал/g, "")
    .replace(/[^а-яa-z0-9]/gi, "");
}

function branchCanonical(v) {
  return norm(v).replace(/филиал/gi, "").trim().toUpperCase();
}

function normalizePoList(value) {
  if (Array.isArray(value)) {
    return Array.from(new Set(value.map(norm).filter(Boolean))).sort((a, b) =>
      a.localeCompare(b, "ru")
    );
  }
  if (value == null) return [];
  const s = norm(value);
  if (!s) return [];
  // Легаси-формат: текст с разделителями.
  const parts = s
    .split(/\r?\n|;|,/g)
    .map(norm)
    .filter(Boolean);
  return Array.from(new Set(parts)).sort((a, b) => a.localeCompare(b, "ru"));
}

function samePoList(a, b) {
  const aa = normalizePoList(a);
  const bb = normalizePoList(b);
  if (aa.length !== bb.length) return false;
  for (let i = 0; i < aa.length; i += 1) {
    if (aa[i] !== bb[i]) return false;
  }
  return true;
}

async function getJwt() {
  if (STRAPI_API_TOKEN) return STRAPI_API_TOKEN;
  if (!STRAPI_LOGIN || !STRAPI_PASSWORD) {
    throw new Error("Не заданы LOGIN_STRAPI/PASSWORD_STRAPI или STRAPI_API_TOKEN");
  }
  const { data } = await http.post("/api/auth/local", {
    identifier: STRAPI_LOGIN,
    password: STRAPI_PASSWORD,
  });
  if (!data?.jwt) throw new Error("Не удалось получить JWT в Strapi");
  return data.jwt;
}

function authHeaders(token) {
  return { Authorization: `Bearer ${token}` };
}

async function fetchAllBranches(token) {
  const rows = [];
  let hasPoField = false;
  let page = 1;
  const pageSize = 100;

  while (true) {
    const { data } = await http.get(`/api/${BRANCHES_ENDPOINT}`, {
      params: {
        "pagination[page]": page,
        "pagination[pageSize]": pageSize,
      },
      headers: authHeaders(token),
    });

    const batch = Array.isArray(data?.data) ? data.data : [];
    for (const row of batch) {
      const attrs = row?.attributes || row || {};
      if (Object.prototype.hasOwnProperty.call(attrs, "po")) hasPoField = true;
      rows.push({
        id: row?.id ?? attrs?.id ?? null,
        documentId: row?.documentId || attrs?.documentId || null,
        name: norm(attrs?.name),
        name_norm: norm(attrs?.name_norm),
        po: attrs?.po,
      });
    }

    const pg = data?.meta?.pagination;
    if (!pg || page >= Number(pg.pageCount || 1)) break;
    page += 1;
  }

  return { rows, hasPoField };
}

function parseBranchPoMap(filePath) {
  const wb = XLSX.readFile(filePath, { cellDates: false });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });

  const byBranch = new Map();
  let currentBranch = "";
  let currentPo = "";

  for (const row of rows) {
    const branchRaw = norm(row["филиал"]);
    const poRaw = norm(row["ПО"]);
    const typeRaw = norm(row["Тип точки сбора"]).toLowerCase();

    if (branchRaw) currentBranch = branchCanonical(branchRaw);
    if (poRaw) currentPo = poRaw;

    if (!currentBranch || !currentPo) continue;

    // Для справочника ПО берём только строки "Производственная база".
    if (typeRaw && !typeRaw.includes("производственная база")) continue;

    if (!byBranch.has(currentBranch)) byBranch.set(currentBranch, new Set());
    byBranch.get(currentBranch).add(currentPo);
  }

  return byBranch;
}

async function updateBranchPo(documentId, poValue, token) {
  await http.put(
    `/api/${BRANCHES_ENDPOINT}/${documentId}`,
    { data: { po: poValue } },
    { headers: authHeaders(token) }
  );
}

async function main() {
  const token = await getJwt();
  const [branchPoMap, branchPack] = await Promise.all([
    Promise.resolve(parseBranchPoMap(XLSX_FILE)),
    fetchAllBranches(token),
  ]);
  const branches = branchPack.rows;

  const strapiByKey = new Map();
  for (const b of branches) {
    const k1 = keyify(b.name_norm);
    const k2 = keyify(b.name);
    if (k1) strapiByKey.set(k1, b);
    if (k2) strapiByKey.set(k2, b);
  }

  const plan = [];
  const missing = [];

  for (const [branchName, poSet] of branchPoMap.entries()) {
    const key = keyify(branchName);
    const target = strapiByKey.get(key);
    const poList = Array.from(poSet).sort((a, b) => a.localeCompare(b, "ru"));
    const poValue = poList;

    if (!target) {
      missing.push({ branchName, poCount: poList.length });
      continue;
    }

    plan.push({
      branchName,
      documentId: target.documentId || String(target.id || ""),
      beforePo: target.po,
      afterPo: poValue,
      changed: !samePoList(target.po, poValue),
      poCount: poList.length,
    });
  }

  const changed = plan.filter((x) => x.changed);
  const unchanged = plan.length - changed.length;

  console.log("[PO-IMPORT] Файл:", XLSX_FILE);
  console.log("[PO-IMPORT] Филиалов в Excel:", branchPoMap.size);
  console.log("[PO-IMPORT] Найдено в Strapi:", plan.length);
  console.log("[PO-IMPORT] Не найдено в Strapi:", missing.length);
  console.log("[PO-IMPORT] К изменению:", changed.length);
  console.log("[PO-IMPORT] Без изменений:", unchanged);

  if (missing.length) {
    console.log("\n[PO-IMPORT] Не сопоставленные филиалы:");
    for (const m of missing) {
      console.log(`- ${m.branchName} (ПО: ${m.poCount})`);
    }
  }

  if (!APPLY) {
    if (!branchPack.hasPoField) {
      console.log("\n[PO-IMPORT] ВАЖНО: в коллекции pes-branches пока нет поля `po`.");
      console.log("[PO-IMPORT] Сначала добавь поле `po` в Strapi (Text или Rich text), затем запускай --apply.");
    }
    console.log("\n[PO-IMPORT] DRY RUN. Для записи добавь флаг --apply");
    for (const x of changed.slice(0, 20)) {
      console.log(`- ${x.branchName}: будет записано ПО ${x.poCount} шт.`);
    }
    return;
  }

  if (!branchPack.hasPoField) {
    throw new Error("В коллекции pes-branches не найдено поле `po`. Добавь поле в Strapi и запусти снова.");
  }

  let updated = 0;
  for (const x of changed) {
    if (!x.documentId) {
      console.log(`[SKIP] ${x.branchName}: нет documentId`);
      continue;
    }
    await updateBranchPo(x.documentId, x.afterPo, token);
    updated += 1;
    console.log(`[OK] ${x.branchName}: обновлено (${x.poCount} ПО)`);
  }

  console.log(`\n[PO-IMPORT] Готово. Обновлено: ${updated}`);
}

main().catch((e) => {
  const apiMsg = e?.response?.data?.error?.message || e?.response?.data?.message;
  if (apiMsg) console.error("[ERR]", apiMsg);
  else console.error("[ERR]", e.message || e);
  process.exit(1);
});
