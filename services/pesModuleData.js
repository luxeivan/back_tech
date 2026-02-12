const axios = require("axios");
const { getJwt } = require("./modus/strapi");

const STRAPI_URL = String(process.env.URL_STRAPI || "").replace(/\/$/, "");
const STRAPI_API_TOKEN = String(process.env.STRAPI_API_TOKEN || "").trim();

const ENDPOINT_UNITS = process.env.STRAPI_PES_UNITS_ENDPOINT || "pes-units";
const ENDPOINT_POINTS =
  process.env.STRAPI_PES_POINTS_ENDPOINT || "pes-collection-points";
const ENDPOINT_ELECTRO =
  process.env.STRAPI_GRID_OBJECTS_ENDPOINT || "electro-objects";

const cache = {
  units: { ts: 0, rows: [] },
  points: { ts: 0, rows: [] },
  electro: { ts: 0, rows: [] },
};

const TTL_UNITS_MS = 60 * 1000;
const TTL_POINTS_MS = 60 * 1000;
const TTL_ELECTRO_MS = 10 * 60 * 1000;

function norm(v) {
  return String(v == null ? "" : v).replace(/\s+/g, " ").trim();
}

function normLc(v) {
  return norm(v).toLowerCase();
}

function toNum(v) {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function escapeRegex(text) {
  return String(text || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function branchNeedle(branch) {
  return normLc(branch).replace(/\bфилиал\b/g, "").replace(/[^а-яa-z0-9]/gi, "");
}

function sameBranch(a, b) {
  const aNorm = normLc(a);
  const bNorm = normLc(b);
  if (aNorm && bNorm && aNorm === bNorm) return true;
  const aNeedle = branchNeedle(a);
  const bNeedle = branchNeedle(b);
  if (!aNeedle || !bNeedle) return false;
  return aNeedle.includes(bNeedle) || bNeedle.includes(aNeedle);
}

function isTpLike(row) {
  const subclass = normLc(row.subclass_name);
  if (subclass === "тп" || subclass === "ктп" || subclass.endsWith("тп")) return true;
  const blob = `${row.enobj_name || ""} ${row.class_name || ""} ${row.rclass_name || ""}`;
  return /\bтп\b/i.test(blob);
}

function matchesBranch(row, branch) {
  const needle = branchNeedle(branch);
  if (!needle) return true;
  const blob = normLc(
    `${row.subcontrol_area_name || ""} ${row.settlement || ""} ${row.address || ""} ${row.enobj_name || ""}`
  ).replace(/[^а-яa-z0-9]/gi, "");
  return blob.includes(needle);
}

async function getToken() {
  if (STRAPI_API_TOKEN) return STRAPI_API_TOKEN;
  const jwt = await getJwt();
  if (!jwt) throw new Error("Не удалось авторизоваться в Strapi");
  return jwt;
}

async function fetchAll(endpoint, fields, token) {
  if (!STRAPI_URL) throw new Error("URL_STRAPI не задан");
  const rows = [];
  let page = 1;
  const pageSize = 100;

  while (true) {
    const params = {
      "pagination[page]": page,
      "pagination[pageSize]": pageSize,
    };
    fields.forEach((f, i) => {
      params[`fields[${i}]`] = f;
    });

    const { data } = await axios.get(`${STRAPI_URL}/api/${endpoint}`, {
      headers: { Authorization: `Bearer ${token}` },
      params,
      timeout: 30000,
    });

    const batch = Array.isArray(data?.data) ? data.data : [];
    for (const row of batch) {
      const attrs = row?.attributes || row || {};
      rows.push({
        id: row?.id ?? attrs?.id ?? null,
        documentId: row?.documentId || attrs?.documentId || null,
        ...attrs,
      });
    }

    const pg = data?.meta?.pagination;
    if (!pg || page >= Number(pg.pageCount || 1)) break;
    page += 1;
  }

  return rows;
}

async function getUnits() {
  const now = Date.now();
  if (now - cache.units.ts < TTL_UNITS_MS && cache.units.rows.length) {
    return cache.units.rows;
  }
  const token = await getToken();
  const rows = await fetchAll(
    ENDPOINT_UNITS,
    [
      "code",
      "garage_number",
      "pes_name",
      "vehicle_plate",
      "branch",
      "power_kw_nominal",
      "power_kw_max",
      "generator_model",
      "base_address",
      "district",
    ],
    token
  );
  cache.units = { ts: now, rows };
  return rows;
}

async function getPoints() {
  const now = Date.now();
  if (now - cache.points.ts < TTL_POINTS_MS && cache.points.rows.length) {
    return cache.points.rows;
  }
  const token = await getToken();
  const rows = await fetchAll(
    ENDPOINT_POINTS,
    [
      "code",
      "branch",
      "po",
      "dispatcher_phone",
      "point_type_raw",
      "point_kind",
      "address",
      "lat",
      "lon",
    ],
    token
  );
  cache.points = { ts: now, rows };
  return rows;
}

async function getElectro() {
  const now = Date.now();
  if (now - cache.electro.ts < TTL_ELECTRO_MS && cache.electro.rows.length) {
    return cache.electro.rows;
  }
  const token = await getToken();
  const rows = await fetchAll(
    ENDPOINT_ELECTRO,
    [
      "keylink",
      "subcontrol_area_name",
      "enobj_name",
      "subclass_name",
      "class_name",
      "rclass_name",
      "address",
      "settlement",
      "lat",
      "lon",
    ],
    token
  );
  cache.electro = { ts: now, rows };
  return rows;
}

function pickPointMeta(unit, points) {
  const branch = norm(unit.branch);
  const list = points.filter((p) => sameBranch(p.branch, branch));
  if (!list.length) return { po: "", dispatcherPhone: "" };

  const district = normLc(unit.district);
  if (district) {
    const districtRx = new RegExp(escapeRegex(district), "i");
    const hit =
      list.find((x) => districtRx.test(String(x.po || ""))) ||
      list.find((x) => districtRx.test(String(x.address || "")));
    if (hit) {
      return {
        po: norm(hit.po),
        dispatcherPhone: norm(hit.dispatcher_phone),
      };
    }
  }

  const first = list[0];
  return { po: norm(first.po), dispatcherPhone: norm(first.dispatcher_phone) };
}

async function loadPesItems() {
  const [units, points] = await Promise.all([getUnits(), getPoints()]);

  return units.map((u) => {
    const meta = pickPointMeta(u, points);
    return {
      id: norm(u.code) || norm(u.documentId) || String(u.id || ""),
      number: norm(u.garage_number),
      name: norm(u.pes_name) || norm(u.vehicle_plate) || "ПЭС",
      branch: norm(u.branch),
      po: meta.po,
      powerKw: toNum(u.power_kw_nominal) ?? toNum(u.power_kw_max) ?? null,
      model: norm(u.generator_model),
      status: "ready",
      baseAddress: norm(u.base_address),
      dispatcherPhone: meta.dispatcherPhone,
      sourceCode: norm(u.code),
      district: norm(u.district),
    };
  });
}

async function loadAssemblyDestinations({ branch = "" } = {}) {
  const points = await getPoints();

  return points
    .filter((p) => p.point_kind === "base" || p.point_kind === "alternative")
    .filter((p) => !branch || sameBranch(p.branch, branch))
    .map((p) => ({
      id: norm(p.code) || norm(p.documentId) || String(p.id || ""),
      branch: norm(p.branch),
      po: norm(p.po),
      title: norm(p.point_type_raw) || "Точка сбора ПЭС",
      address: norm(p.address),
      lat: toNum(p.lat),
      lon: toNum(p.lon),
      dispatcherPhone: norm(p.dispatcher_phone),
      type: "assembly",
    }));
}

async function loadTpDestinations({ branch = "" } = {}) {
  const branchLc = normLc(branch);
  if (!branchLc) return [];

  const rows = await getElectro();
  return rows
    .filter(isTpLike)
    .filter((r) => matchesBranch(r, branch))
    .map((r) => ({
      id: `tp-${norm(r.keylink)}`,
      keylink: norm(r.keylink),
      branch: norm(branch),
      po: norm(r.subcontrol_area_name),
      title: norm(r.enobj_name) || norm(r.keylink),
      address: norm(r.address) || norm(r.settlement) || norm(r.subcontrol_area_name),
      lat: toNum(r.lat),
      lon: toNum(r.lon),
      type: "tp",
    }));
}

module.exports = {
  loadPesItems,
  loadAssemblyDestinations,
  loadTpDestinations,
};
