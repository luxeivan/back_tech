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

function withDistrict(address, district) {
  const addr = norm(address);
  const dist = norm(district);
  if (!dist) return addr;
  if (!addr) return dist;

  // Не дублируем округ, если он уже присутствует в адресе.
  if (normLc(addr).includes(normLc(dist))) return addr;

  return `${dist}, ${addr}`;
}

function normForMatch(v) {
  return norm(v)
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[\"'`«»(){}\[\]]/g, " ")
    .replace(/[-–—\\/.,:;!?№]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const MATCH_STOPWORDS = new Set([
  "г",
  "город",
  "городской",
  "округ",
  "муниципальный",
  "район",
  "улица",
  "ул",
  "дом",
  "д",
  "корп",
  "корпус",
  "стр",
  "строение",
  "мкр",
  "микрорайон",
  "поселок",
  "пос",
  "рабочий",
  "село",
  "деревня",
  "переулок",
  "проспект",
  "проезд",
  "шоссе",
  "км",
  "территория",
  "филиал",
  "по",
  "су",
  "ср",
  "уч",
  "участок",
]);

function stemRuToken(token) {
  let x = token;
  x = x.replace(
    /(ского|скому|ским|ском|ских|скими|скую|ская|ское|ские|ский)$/i,
    "ск"
  );
  x = x.replace(
    /(ого|ему|ому|ыми|ими|ых|их|ой|ый|ий|ая|ое|ые|ую|юю|ом|ам|ям|ах|ях|а|я|ы|и|е|о|у|ю)$/i,
    ""
  );
  return x;
}

function matchTokens(text) {
  if (!text) return [];
  return Array.from(
    new Set(
      normForMatch(text)
        .split(" ")
        .map((x) => x.trim())
        .filter(Boolean)
        .filter((x) => x.length >= 3)
        .filter((x) => !MATCH_STOPWORDS.has(x))
        .map(stemRuToken)
        .filter((x) => x.length >= 3)
    )
  );
}

function toNum(v) {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function isDigitsOnly(v) {
  const s = norm(v);
  return Boolean(s) && /^\d+$/.test(s);
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
  const baseFields = [
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
  ];

  let rows = [];
  try {
    rows = await fetchAll(ENDPOINT_UNITS, [...baseFields, "po"], token);
  } catch (e) {
    const status = Number(e?.response?.status || 0);
    if (status !== 400) throw e;
    rows = await fetchAll(ENDPOINT_UNITS, baseFields, token);
  }
  cache.units = { ts: now, rows };
  return rows;
}

async function getPoints() {
  const now = Date.now();
  if (now - cache.points.ts < TTL_POINTS_MS && cache.points.rows.length) {
    return cache.points.rows;
  }
  const token = await getToken();
  const baseFields = [
    "code",
    "branch",
    "po",
    "dispatcher_phone",
    "point_type_raw",
    "point_kind",
    "address",
    "lat",
    "lon",
  ];

  let rows = [];
  try {
    rows = await fetchAll(ENDPOINT_POINTS, [...baseFields, "district"], token);
  } catch (e) {
    // В некоторых окружениях у коллекции точек нет поля district.
    // Делаем безопасный откат к прежнему набору полей.
    const status = Number(e?.response?.status || 0);
    if (status !== 400) throw e;
    rows = await fetchAll(ENDPOINT_POINTS, baseFields, token);
  }

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

  // Важно: не добавляем district в матчинг PO.
  // Округ слишком общий и "перетягивает" подбор в сторону крупного ПО филиала,
  // из-за чего локальные ПО (например, Гжельское) пропадают из группировки.
  const unitTokens = new Set(
    matchTokens(`${unit.base_address || ""} ${unit.pes_name || ""}`)
  );

  const scorePoint = (point) => {
    const pointTokens = new Set(
      matchTokens(`${point.po || ""} ${point.address || ""}`)
    );
    let score = 0;
    for (const t of unitTokens) {
      if (pointTokens.has(t)) score += 1;
    }
    if (point.point_kind === "base") score += 0.5;
    if (norm(point.dispatcher_phone)) score += 0.2;
    return score;
  };

  let best = null;
  let bestScore = -1;
  for (const point of list) {
    const score = scorePoint(point);
    if (score > bestScore) {
      best = point;
      bestScore = score;
      continue;
    }
    if (score === bestScore && best) {
      const bestIsBase = best.point_kind === "base";
      const curIsBase = point.point_kind === "base";
      if (curIsBase && !bestIsBase) {
        best = point;
        continue;
      }
      const bestHasPhone = Boolean(norm(best.dispatcher_phone));
      const curHasPhone = Boolean(norm(point.dispatcher_phone));
      if (curHasPhone && !bestHasPhone) {
        best = point;
      }
    }
  }

  const fallback =
    list.find((x) => x.point_kind === "base" && norm(x.dispatcher_phone)) ||
    list.find((x) => x.point_kind === "base") ||
    list[0];
  const selected = bestScore > 0 ? best : fallback;
  return {
    po: norm(selected?.po),
    dispatcherPhone: norm(selected?.dispatcher_phone),
  };
}

async function loadPesItems() {
  const [units, points] = await Promise.all([getUnits(), getPoints()]);

  return units
    .filter((u) => {
      // В справочнике иногда попадаются "итоговые" строки (например "ВСЕГО") и пустые заготовки.
      if (!isDigitsOnly(u.garage_number)) return false;
      if (!norm(u.branch)) return false;
      return true;
    })
    .map((u) => {
      const meta = pickPointMeta(u, points);
      return {
        unitStrapiId: Number.isFinite(Number(u.id)) ? Number(u.id) : null,
        unitDocumentId: norm(u.documentId),
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
  const [points, units] = await Promise.all([getPoints(), getUnits()]);

  function resolveDistrictForPoint(point) {
    const direct = norm(point.district);
    if (direct) return direct;

    const branchNeedle = normLc(point.branch);
    const poNeedle = normLc(point.po);
    if (!branchNeedle) return "";

    const branchRows = units
      .map((u) => ({
        branch: norm(u.branch),
        po: normLc(u.po),
        district: norm(u.district),
      }))
      .filter((u) => u.district)
      .filter((u) => sameBranch(u.branch, point.branch));

    if (!branchRows.length) return "";

    if (poNeedle) {
      const exact = branchRows.find((x) => x.po && x.po === poNeedle);
      if (exact?.district) return exact.district;
    }

    // Если не нашли соответствие по ПО, округ не подставляем,
    // чтобы избежать ошибочного "чужого" округа.
    return "";
  }

  return points
    .filter((p) => p.point_kind === "base" || p.point_kind === "alternative")
    .filter((p) => !branch || sameBranch(p.branch, branch))
    .map((p) => {
      const district = resolveDistrictForPoint(p);
      return {
      id: norm(p.code) || norm(p.documentId) || String(p.id || ""),
      branch: norm(p.branch),
      po: norm(p.po),
      title: norm(p.point_type_raw) || "Точка сбора ПЭС",
      rawAddress: norm(p.address),
      address: withDistrict(p.address, district),
      lat: toNum(p.lat),
      lon: toNum(p.lon),
      dispatcherPhone: norm(p.dispatcher_phone),
      type: "assembly",
      };
    });
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
