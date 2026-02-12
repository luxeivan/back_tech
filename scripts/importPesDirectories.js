#!/usr/bin/env node
require("dotenv").config();

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const axios = require("axios");
const XLSX = require("xlsx");

const DEFAULT_REGISTRY_XLSX = path.resolve(__dirname, "../import_data/+Приложение 1. Реестр ПЭС.xlsx");
const DEFAULT_POINTS_XLSX = path.resolve(__dirname, "../import_data/+Приложение_5_Справочник_точек_сбора_ПЭС.xlsx");
const DEFAULT_GRID_XLS = path.resolve(__dirname, "../import_data/R3. Электроустановки и линии с коорд.xls");

const argv = process.argv.slice(2);
const hasFlag = (name) => argv.includes(name);
const getArg = (name, fallback = "") => {
  const i = argv.indexOf(name);
  if (i === -1) return fallback;
  return argv[i + 1] || fallback;
};

const APPLY = hasFlag("--apply");
const CONCURRENCY = Math.max(1, Number(getArg("--concurrency", "6")) || 6);
const SKIP_REGISTRY = hasFlag("--skip-registry");
const SKIP_POINTS = hasFlag("--skip-points");
const SKIP_GRID = hasFlag("--skip-grid");
const WIPE_FIRST = hasFlag("--wipe");
const STRAPI_URL = String(process.env.URL_STRAPI || process.env.STRAPI_URL || "").replace(/\/$/, "");
const STRAPI_LOGIN = process.env.LOGIN_STRAPI || "";
const STRAPI_PASSWORD = process.env.PASSWORD_STRAPI || "";
const STRAPI_API_TOKEN = process.env.STRAPI_API_TOKEN || "";

const REGISTRY_ENDPOINT = process.env.STRAPI_PES_UNITS_ENDPOINT || "pes-units";
const POINTS_ENDPOINT = process.env.STRAPI_PES_POINTS_ENDPOINT || "pes-collection-points";
const GRID_ENDPOINT = process.env.STRAPI_GRID_OBJECTS_ENDPOINT || "electro-objects";

const REGISTRY_FILE = getArg("--registry", DEFAULT_REGISTRY_XLSX);
const POINTS_FILE = getArg("--points", DEFAULT_POINTS_XLSX);
const GRID_FILE = getArg("--grid", DEFAULT_GRID_XLS);

if (!STRAPI_URL) {
  console.error("[ERR] Не задан URL_STRAPI (или STRAPI_URL) в .env");
  process.exit(1);
}

for (const [label, filePath] of [
  ["реестр ПЭС", REGISTRY_FILE],
  ["точки сбора", POINTS_FILE],
  ["электроустановки и линии", GRID_FILE],
]) {
  if (!fs.existsSync(filePath)) {
    console.error(`[ERR] Не найден файл (${label}): ${filePath}`);
    process.exit(1);
  }
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

function toNum(v) {
  if (v == null || v === "") return null;
  const s = String(v).replace(/\s+/g, "").replace(",", ".");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function toInt(v) {
  const n = toNum(v);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

function formatGarage(v) {
  const s = norm(v);
  if (!s) return "";
  const digits = s.replace(/\D/g, "");
  if (!digits) return s;
  if (digits.length <= 3) return digits.padStart(3, "0");
  return digits;
}

function parseLatLon(raw) {
  const txt = norm(raw);
  if (!txt) return { lat: null, lon: null, raw: "" };
  const nums = txt.match(/-?\d+(?:[.,]\d+)?/g) || [];
  if (nums.length < 2) return { lat: null, lon: null, raw: txt };
  const lat = Number(String(nums[0]).replace(",", "."));
  const lon = Number(String(nums[1]).replace(",", "."));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return { lat: null, lon: null, raw: txt };
  }
  return { lat, lon, raw: txt };
}

function parseDateTimeRu(v) {
  const s = norm(v);
  if (!s) return null;
  const m = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) return null;
  const dd = Number(m[1]);
  const mm = Number(m[2]);
  const yyyy = Number(m[3]);
  const hh = Number(m[4] || 0);
  const mi = Number(m[5] || 0);
  const ss = Number(m[6] || 0);
  const dt = new Date(Date.UTC(yyyy, mm - 1, dd, hh, mi, ss));
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
}

function makeCode(parts) {
  const src = parts.map((x) => norm(x).toLowerCase()).join("|");
  return crypto.createHash("sha1").update(src).digest("hex").slice(0, 24);
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

async function preloadExisting(endpoint, uniqueField, token) {
  const map = new Map();
  let page = 1;
  const pageSize = 100;

  while (true) {
    const { data } = await http.get(`/api/${endpoint}`, {
      params: {
        "pagination[page]": page,
        "pagination[pageSize]": pageSize,
        [`fields[0]`]: uniqueField,
      },
      headers: authHeaders(token),
    });

    const rows = Array.isArray(data?.data) ? data.data : [];
    for (const row of rows) {
      const attrs = row?.attributes || row || {};
      const key = norm(attrs?.[uniqueField]);
      const targetId = row?.documentId || row?.id || null;
      if (key && targetId) map.set(key, targetId);
    }

    const meta = data?.meta?.pagination;
    const pageCount = meta?.pageCount || 1;
    if (page >= pageCount) break;
    page += 1;
  }

  return map;
}

async function wipeCollection(endpoint, token, title) {
  let deleted = 0;
  const deleteConcurrency = 16;
  while (true) {
    const { data } = await http.get(`/api/${endpoint}`, {
      params: {
        "pagination[page]": 1,
        "pagination[pageSize]": 100,
        "fields[0]": "documentId",
      },
      headers: authHeaders(token),
    });
    const rows = Array.isArray(data?.data) ? data.data : [];
    if (!rows.length) break;

    let cursor = 0;
    async function worker() {
      while (true) {
        const i = cursor;
        cursor += 1;
        if (i >= rows.length) return;
        const row = rows[i];
        const targetId = row?.documentId || row?.id;
        if (!targetId) continue;
        try {
          await http.delete(`/api/${endpoint}/${targetId}`, {
            headers: authHeaders(token),
          });
          deleted += 1;
        } catch (e) {
          const msg = e?.response?.data?.error?.message || e?.message || "unknown";
          console.error(`[${title}] Ошибка удаления id=${targetId}: ${msg}`);
        }
      }
    }
    await Promise.all(Array.from({ length: deleteConcurrency }, () => worker()));
    if (deleted % 1000 === 0 && deleted > 0) {
      console.log(`[${title}] удалено ${deleted}`);
    }
  }
  console.log(`[${title}] удаление завершено: ${deleted}`);
}

function parseRegistryRows(filePath) {
  const wb = XLSX.readFile(filePath, { cellDates: false });
  const ws = wb.Sheets["Передвижные"] || wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: "" });

  const out = [];
  for (let i = 3; i < rows.length; i += 1) {
    const r = rows[i] || [];
    const garage = formatGarage(r[0]);
    const name = norm(r[1]);
    if (!garage && !name) continue;

    const item = {
      code: makeCode(["pes", garage, name, r[2], r[3]]),
      garage_number: garage,
      pes_name: name,
      vehicle_plate: norm(r[2]),
      branch: norm(r[3]),
      power_kw_nominal: toNum(r[4]),
      power_kw_max: toNum(r[5]),
      power_kva_nominal: toNum(r[6]),
      power_kva_max: toNum(r[7]),
      generator_model: norm(r[8]),
      base_address: norm(r[9]),
      towing_vehicle: norm(r[10]),
      access_pass: norm(r[11]),
      duty_type: norm(r[12]),
      manufacture_year: toInt(r[13]),
      ownership_form: norm(r[14]),
      notes: norm(r[15]),
      district: norm(r[16]),
      source_row: i + 1,
    };
    out.push(item);
  }

  return out;
}

function resolvePointKind(typeRaw) {
  const t = norm(typeRaw).toLowerCase();
  if (t.includes("производственная база")) return "base";
  if (t.includes("альтернатив")) return "alternative";
  return "other";
}

function parsePointsRows(filePath) {
  const wb = XLSX.readFile(filePath, { cellDates: false });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: "" });

  const out = [];
  let currentBranch = "";
  let currentPo = "";
  let currentPhone = "";

  for (let i = 1; i < rows.length; i += 1) {
    const r = rows[i] || [];

    const branch = norm(r[0]);
    const po = norm(r[1]);
    const phone = norm(r[2]);

    if (branch) currentBranch = branch;
    if (po) currentPo = po;
    if (phone) currentPhone = phone;

    const pointTypeRaw = norm(r[3]);
    const address = norm(r[4]);
    const coordsRaw = norm(r[5]);

    if (!pointTypeRaw && !address) continue;

    const { lat, lon, raw } = parseLatLon(coordsRaw);

    const code = makeCode(["point", currentBranch, currentPo, pointTypeRaw, address]);

    const item = {
      code,
      branch: currentBranch,
      po: currentPo,
      dispatcher_phone: currentPhone,
      point_type_raw: pointTypeRaw,
      point_kind: resolvePointKind(pointTypeRaw),
      address,
      lat,
      lon,
      coords_raw: raw,
      source_row: i + 1,
    };
    out.push(item);
  }

  return out;
}

function parseGridRows(filePath) {
  const wb = XLSX.readFile(filePath, { cellDates: false });
  const out = [];

  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: "" });
    if (!rows.length) continue;

    const h = rows[0] || [];
    const idx = {
      subcontrol_area_name: h.indexOf("SUBCONTROLARENAME"),
      enobj_name: h.indexOf("ENOBJNAME"),
      subclass_name: h.indexOf("SUBCLASSNAME"),
      keylink: h.indexOf("KEYLINK"),
      class_name: h.indexOf("CLASSNAME"),
      rclass_name: h.indexOf("RCLASSNAME"),
      voltage: h.indexOf("VOLTAGE"),
      installation_date: h.indexOf("INSTALLATIONDATE"),
      address: h.indexOf("ADDRESS"),
      settlement: h.indexOf("SETTLEMENT"),
      equipment_exists: h.indexOf("EQUIPMENTEXISTS"),
      eq_datetime: h.indexOf("EQDATETIME"),
      eq_insert_datetime: h.indexOf("EQINSERTDATETIME"),
      latitude: h.indexOf("LATITUDE"),
      longitude: h.indexOf("LONGITUDE"),
    };

    if (idx.keylink < 0) continue;

    for (let i = 1; i < rows.length; i += 1) {
      const r = rows[i] || [];
      const keylink = norm(r[idx.keylink]);
      if (!keylink) continue;

      const lat = toNum(r[idx.latitude]);
      const lon = toNum(r[idx.longitude]);

      out.push({
        keylink,
        subcontrol_area_name: norm(r[idx.subcontrol_area_name]),
        enobj_name: norm(r[idx.enobj_name]),
        subclass_name: norm(r[idx.subclass_name]),
        class_name: norm(r[idx.class_name]),
        rclass_name: norm(r[idx.rclass_name]),
        voltage: norm(r[idx.voltage]),
        installation_date_raw: norm(r[idx.installation_date]),
        installation_date: parseDateTimeRu(r[idx.installation_date]),
        address: norm(r[idx.address]),
        settlement: norm(r[idx.settlement]),
        equipment_exists: norm(r[idx.equipment_exists]),
        eq_datetime_raw: norm(r[idx.eq_datetime]),
        eq_datetime: parseDateTimeRu(r[idx.eq_datetime]),
        eq_insert_datetime_raw: norm(r[idx.eq_insert_datetime]),
        eq_insert_datetime: parseDateTimeRu(r[idx.eq_insert_datetime]),
        lat,
        lon,
        sheet_name: sheetName,
        source_row: i + 1,
      });
    }
  }

  return out;
}

async function uploadRows(rows, endpoint, uniqueField, token, title) {
  let created = 0;
  let updated = 0;
  let failed = 0;
  let done = 0;

  const existing = await preloadExisting(endpoint, uniqueField, token);
  let cursor = 0;

  async function worker() {
    while (true) {
      const idx = cursor;
      cursor += 1;
      if (idx >= rows.length) return;

      const row = rows[idx];
      const uniqueValue = norm(row[uniqueField]);
      if (!uniqueValue) {
        failed += 1;
        done += 1;
        continue;
      }

      const existingId = existing.get(uniqueValue);

      try {
        if (!existingId) {
          const { data } = await http.post(
            `/api/${endpoint}`,
            { data: row },
            { headers: authHeaders(token) }
          );
          created += 1;
          const targetId = data?.data?.documentId || data?.data?.id;
          if (targetId) existing.set(uniqueValue, targetId);
        } else {
          await http.put(
            `/api/${endpoint}/${existingId}`,
            { data: row },
            { headers: authHeaders(token) }
          );
          updated += 1;
        }
      } catch (e) {
        failed += 1;
        const msg = e?.response?.data?.error?.message || e?.message || "unknown";
        console.error(`[${title}] Ошибка по ${uniqueField}=${uniqueValue}: ${msg}`);
      } finally {
        done += 1;
        if (done % 1000 === 0 || done === rows.length) {
          console.log(`[${title}] прогресс ${done}/${rows.length}`);
        }
      }
    }
  }

  const workers = Array.from({ length: CONCURRENCY }, () => worker());
  await Promise.all(workers);
  return { created, updated, failed };
}

async function main() {
  console.log("\n=== Импорт справочников ПЭС -> Strapi ===");
  console.log(`Strapi: ${STRAPI_URL}`);
  console.log(`Реестр: ${REGISTRY_FILE}${SKIP_REGISTRY ? " (skip)" : ""}`);
  console.log(`Точки:  ${POINTS_FILE}${SKIP_POINTS ? " (skip)" : ""}`);
  console.log(`R3:     ${GRID_FILE}${SKIP_GRID ? " (skip)" : ""}`);
  console.log(`Режим:  ${APPLY ? "запись в Strapi" : "только проверка (dry-run)"}`);
  console.log(`Параллельность: ${CONCURRENCY}`);
  console.log(`Очистка перед импортом: ${WIPE_FIRST ? "да" : "нет"}`);

  const registryRows = SKIP_REGISTRY ? [] : parseRegistryRows(REGISTRY_FILE);
  const pointsRows = SKIP_POINTS ? [] : parsePointsRows(POINTS_FILE);
  const gridRows = SKIP_GRID ? [] : parseGridRows(GRID_FILE);

  console.log(`\nРеестр ПЭС: ${registryRows.length} строк`);
  console.log(`Точки сбора: ${pointsRows.length} строк`);
  console.log(`Объекты R3: ${gridRows.length} строк`);

  if (!APPLY) {
    if (!SKIP_REGISTRY) {
      console.log("\nПример из реестра:");
      console.log(JSON.stringify(registryRows.slice(0, 1), null, 2));
    }
    if (!SKIP_POINTS) {
      console.log("\nПример из точек:");
      console.log(JSON.stringify(pointsRows.slice(0, 1), null, 2));
    }
    if (!SKIP_GRID) {
      console.log("\nПример из R3:");
      console.log(JSON.stringify(gridRows.slice(0, 1), null, 2));
    }
    console.log("\nDry-run завершён. Для реальной загрузки добавь флаг --apply");
    return;
  }

  const token = await getJwt();

  if (WIPE_FIRST) {
    if (!SKIP_REGISTRY) await wipeCollection(REGISTRY_ENDPOINT, token, "Реестр");
    if (!SKIP_POINTS) await wipeCollection(POINTS_ENDPOINT, token, "Точки");
    if (!SKIP_GRID) await wipeCollection(GRID_ENDPOINT, token, "R3");
  }

  let regStats = { created: 0, updated: 0, failed: 0 };
  let pointStats = { created: 0, updated: 0, failed: 0 };

  if (!SKIP_REGISTRY) {
    console.log(`\nЗагрузка в коллекцию: ${REGISTRY_ENDPOINT} (unique: code)`);
    regStats = await uploadRows(registryRows, REGISTRY_ENDPOINT, "code", token, "Реестр");
  }

  if (!SKIP_POINTS) {
    console.log(`\nЗагрузка в коллекцию: ${POINTS_ENDPOINT} (unique: code)`);
    pointStats = await uploadRows(pointsRows, POINTS_ENDPOINT, "code", token, "Точки");
  }

  let gridStats = { created: 0, updated: 0, failed: 0 };
  if (!SKIP_GRID) {
    console.log(`\nЗагрузка в коллекцию: ${GRID_ENDPOINT} (unique: keylink)`);
    gridStats = await uploadRows(gridRows, GRID_ENDPOINT, "keylink", token, "R3");
  }

  console.log("\n=== Готово ===");
  console.log(`Реестр -> created: ${regStats.created}, updated: ${regStats.updated}, failed: ${regStats.failed}`);
  console.log(`Точки  -> created: ${pointStats.created}, updated: ${pointStats.updated}, failed: ${pointStats.failed}`);
  console.log(`R3     -> created: ${gridStats.created}, updated: ${gridStats.updated}, failed: ${gridStats.failed}`);
}

main().catch((e) => {
  console.error("\n[ERR] Импорт завершился с ошибкой:");
  console.error(e?.response?.data || e?.message || e);
  process.exit(1);
});
