#!/usr/bin/env node
require("dotenv").config();

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const XLSX = require("xlsx");

const DEFAULT_XLSX = "/Users/yanutstas/Desktop/МосОблЭнерго/ЖТН:JTM:JTN/Новый Рээстр ПЭС.xlsx";

const argv = process.argv.slice(2);
const hasFlag = (name) => argv.includes(name);
const getArg = (name, fallback = "") => {
  const i = argv.indexOf(name);
  if (i === -1) return fallback;
  return argv[i + 1] || fallback;
};

const APPLY = hasFlag("--apply");
const XLSX_FILE = getArg("--file", DEFAULT_XLSX);
const STRAPI_URL = String(process.env.URL_STRAPI || process.env.STRAPI_URL || "").replace(/\/$/, "");
const STRAPI_LOGIN = process.env.LOGIN_STRAPI || "";
const STRAPI_PASSWORD = process.env.PASSWORD_STRAPI || "";
const STRAPI_API_TOKEN = process.env.STRAPI_API_TOKEN || "";
const UNITS_ENDPOINT = process.env.STRAPI_PES_UNITS_ENDPOINT || "pes-units";

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

function normalizeName(v) {
  return norm(v)
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[\s_-]+/g, "")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

function formatGarage(v) {
  const s = norm(v);
  if (!s) return "";
  const digits = s.replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length <= 3) return digits.padStart(3, "0");
  return digits;
}

function parsePriority(v) {
  const s = norm(v).toLowerCase();
  if (!s) return false;
  return ["да", "true", "1", "yes", "y", "приоритет", "priority"].includes(s);
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

function parseExcelRows(filePath) {
  const wb = XLSX.readFile(filePath, { cellDates: false });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });

  const out = [];
  for (const row of rows) {
    const garage = formatGarage(row["Гараж.№"] ?? row["Гараж №"] ?? row["Гараж№"]);
    const pesName = norm(row["Наименование"]);
    const po = norm(row["ПО"]);
    const prioritet = parsePriority(row["приоритетные ПЭС"] ?? row["Приоритетный ПЭС"]);

    if (!garage && !pesName) continue;
    if (!po && !prioritet) continue;

    out.push({
      garage_number: garage,
      pes_name: pesName,
      po,
      prioritet,
    });
  }

  return out;
}

async function fetchAllUnits(token) {
  const rows = [];
  let hasPoField = false;
  let hasPrioritetField = false;
  let page = 1;
  const pageSize = 100;

  while (true) {
    const { data } = await http.get(`/api/${UNITS_ENDPOINT}`, {
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
      if (Object.prototype.hasOwnProperty.call(attrs, "prioritet")) hasPrioritetField = true;

      rows.push({
        id: row?.id ?? attrs?.id ?? null,
        documentId: row?.documentId || attrs?.documentId || null,
        garage_number: formatGarage(attrs?.garage_number),
        pes_name: norm(attrs?.pes_name),
        po: norm(attrs?.po),
        prioritet: Boolean(attrs?.prioritet),
      });
    }

    const pg = data?.meta?.pagination;
    if (!pg || page >= Number(pg.pageCount || 1)) break;
    page += 1;
  }

  return { rows, hasPoField, hasPrioritetField };
}

function shouldChange(current, next) {
  return norm(current.po) !== norm(next.po) || Boolean(current.prioritet) !== Boolean(next.prioritet);
}

async function updateUnit(documentId, payload, token) {
  await http.put(
    `/api/${UNITS_ENDPOINT}/${documentId}`,
    { data: payload },
    { headers: authHeaders(token) }
  );
}

async function main() {
  const token = await getJwt();
  const excelRows = parseExcelRows(XLSX_FILE);
  const unitsPack = await fetchAllUnits(token);
  const units = unitsPack.rows;

  const byGarage = new Map();
  const byName = new Map();
  for (const unit of units) {
    if (unit.garage_number) byGarage.set(unit.garage_number, unit);
    const n = normalizeName(unit.pes_name);
    if (n) byName.set(n, unit);
  }

  const plan = [];
  const missed = [];

  for (const src of excelRows) {
    let target = null;
    let matchedBy = "";

    if (src.garage_number && byGarage.has(src.garage_number)) {
      target = byGarage.get(src.garage_number);
      matchedBy = "garage_number";
    } else {
      const n = normalizeName(src.pes_name);
      if (n && byName.has(n)) {
        target = byName.get(n);
        matchedBy = "pes_name";
      }
    }

    if (!target) {
      missed.push(src);
      continue;
    }

    const next = {
      po: src.po || target.po || "",
      prioritet: src.prioritet,
    };

    plan.push({
      documentId: target.documentId || String(target.id || ""),
      garage_number: target.garage_number,
      pes_name: target.pes_name,
      matchedBy,
      before: { po: target.po, prioritet: target.prioritet },
      after: next,
      changed: shouldChange(target, next),
    });
  }

  const changed = plan.filter((x) => x.changed);
  const unchanged = plan.length - changed.length;

  console.log("[PES-PO-PRIORITET] Файл:", XLSX_FILE);
  console.log("[PES-PO-PRIORITET] Строк из Excel (валидных):", excelRows.length);
  console.log("[PES-PO-PRIORITET] Найдено ПЭС в Strapi:", plan.length);
  console.log("[PES-PO-PRIORITET] Не найдено ПЭС:", missed.length);
  console.log("[PES-PO-PRIORITET] К изменению:", changed.length);
  console.log("[PES-PO-PRIORITET] Без изменений:", unchanged);

  if (missed.length) {
    console.log("\n[PES-PO-PRIORITET] Не сопоставленные строки (первые 20):");
    for (const x of missed.slice(0, 20)) {
      console.log(`- гараж=${x.garage_number || "—"}, наименование=${x.pes_name || "—"}`);
    }
  }

  if (!APPLY) {
    if (!unitsPack.hasPoField || !unitsPack.hasPrioritetField) {
      console.log("\n[PES-PO-PRIORITET] ВАЖНО: проверь поля в pes-units:");
      console.log(`- po: ${unitsPack.hasPoField ? "OK" : "НЕ найдено"}`);
      console.log(`- prioritet: ${unitsPack.hasPrioritetField ? "OK" : "НЕ найдено"}`);
    }
    console.log("\n[PES-PO-PRIORITET] DRY RUN. Для записи добавь флаг --apply");
    for (const x of changed.slice(0, 25)) {
      console.log(
        `- ${x.garage_number || "—"} ${x.pes_name || ""}: po "${x.before.po}" -> "${x.after.po}", prioritet ${x.before.prioritet} -> ${x.after.prioritet}`
      );
    }
    return;
  }

  if (!unitsPack.hasPoField || !unitsPack.hasPrioritetField) {
    throw new Error("В pes-units нет поля `po` и/или `prioritet`. Добавь поля в Strapi и запусти снова.");
  }

  let updated = 0;
  for (const x of changed) {
    if (!x.documentId) {
      console.log(`[SKIP] ${x.garage_number || "—"}: нет documentId`);
      continue;
    }
    await updateUnit(x.documentId, x.after, token);
    updated += 1;
    console.log(`[OK] ${x.garage_number || "—"} ${x.pes_name || ""}: обновлено (${x.matchedBy})`);
  }

  console.log(`\n[PES-PO-PRIORITET] Готово. Обновлено: ${updated}`);
}

main().catch((e) => {
  const apiMsg = e?.response?.data?.error?.message || e?.response?.data?.message;
  if (apiMsg) console.error("[ERR]", apiMsg);
  else console.error("[ERR]", e.message || e);
  process.exit(1);
});

