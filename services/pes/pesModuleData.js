const axios = require("axios");
const { getJwt } = require("../modus/strapi");

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
const ELECTRO_FIELDS = [
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
];

const BRANCH_CANONICAL = new Map([
  ["домодедовск", "ДОМОДЕДОВСКИЙ"],
  ["коломенск", "КОЛОМЕНСКИЙ"],
  ["красногорск", "КРАСНОГОРСКИЙ"],
  ["мытищ", "МЫТИЩИНСКИЙ"],
  ["одинцов", "ОДИНЦОВСКИЙ"],
  ["ореховозуев", "ОРЕХОВО-ЗУЕВСКИЙ"],
  ["павловопосад", "ПАВЛОВО-ПОСАДСКИЙ"],
  ["раменск", "РАМЕНСКИЙ"],
  ["сергиевопосад", "СЕРГИЕВО-ПОСАДСКИЙ"],
  ["щелков", "ЩЕЛКОВСКИЙ"],
  ["талдом", "СЕРГИЕВО-ПОСАДСКИЙ"], // фактический перенос Талдомского модуля в Сергиев-Посад
]);

const PO_BRANCH_OVERRIDES = new Map([
  ["дзержинск", "ДОМОДЕДОВСКИЙ"],
  ["королевск", "МЫТИЩИНСКИЙ"],
  ["голицынск", "ОДИНЦОВСКИЙ"],
  ["голицинск", "ОДИНЦОВСКИЙ"],
  ["краснознамен", "ОДИНЦОВСКИЙ"],
  ["щелковск", "ЩЕЛКОВСКИЙ"],
]);

const UNIT_BRANCH_OVERRIDES = new Map([
  ["115", "СЕРГИЕВО-ПОСАДСКИЙ"],
]);

const PO_TITLE_OVERRIDES = new Map([
  ["дзержинск", "Дзержинское ПО"],
  ["голицинск", "Голицынское ПО"],
  ["голицынск", "Голицынское ПО"],
  ["краснознамен", "Краснознаменное ПО"],
  ["щелков", "Щелковское ПО"],
]);

const PO_SEARCH_OVERRIDES = new Map([
  ["лесногород", ["городок"]],
]);

const TP_HINT_EXCLUDED_PO_KEYS = new Set([
  // В electro-objects нет ТП для этой записи, а точка сбора в Strapi без адреса.
  "загородный",
]);

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

function toBool(v) {
  if (typeof v === "boolean") return v;
  const s = normLc(v);
  if (!s) return false;
  return ["true", "1", "да", "yes", "y"].includes(s);
}

function isDigitsOnly(v) {
  const s = norm(v);
  return Boolean(s) && /^\d+$/.test(s);
}

function branchNeedle(branch) {
  return normLc(branch)
    .replace(/ё/g, "е")
    .replace(/\bфилиал\b/g, "")
    .replace(/[^а-яa-z0-9]/gi, "");
}

function poNeedle(po) {
  return norm(po)
    .toLowerCase()
    .replace(/ё/g, "е")
    .split(/[^а-яa-z0-9]+/gi)
    .map((x) => x.trim())
    .filter(Boolean)
    .filter((x) => !["по", "су", "ср", "уч", "участок", "филиал"].includes(x))
    .join("");
}

function poSearchTerm(po) {
  const key = poNeedle(po);
  for (const [needle, terms] of PO_SEARCH_OVERRIDES.entries()) {
    if (key.includes(needle) || needle.includes(key)) return terms[0];
  }
  for (const [needle, label] of PO_TITLE_OVERRIDES.entries()) {
    if (samePo(label, po)) return needle;
  }
  const [token] = matchTokens(po);
  if (token && token.length > 5 && token.endsWith("ск")) return token.slice(0, -2);
  return token || poNeedle(po);
}

function rowContainsPoTerm(row, term) {
  const needle = norm(term).toLowerCase().replace(/ё/g, "е");
  if (!needle) return false;
  return normForMatch(
    `${row?.subcontrol_area_name || ""} ${row?.settlement || ""} ${row?.address || ""} ${row?.enobj_name || ""}`
  )
    .replace(/\s+/g, "")
    .includes(needle);
}

function mergeRowsByKeylink(lists) {
  const map = new Map();
  for (const list of lists) {
    for (const row of Array.isArray(list) ? list : []) {
      const key = norm(row?.keylink) || norm(row?.documentId) || String(row?.id || "");
      if (!key || map.has(key)) continue;
      map.set(key, row);
    }
  }
  return Array.from(map.values());
}

function samePo(a, b) {
  const aNorm = poNeedle(a);
  const bNorm = poNeedle(b);
  if (!aNorm || !bNorm) return false;
  return aNorm === bNorm || aNorm.includes(bNorm) || bNorm.includes(aNorm);
}

function resolvePoBranchOverride(poOrKey) {
  const key = poNeedle(poOrKey);
  if (!key) return "";
  for (const [needle, label] of PO_BRANCH_OVERRIDES.entries()) {
    if (key.includes(needle) || needle.includes(key)) return label;
  }
  return "";
}

function canonicalPoTitle(po) {
  const key = poNeedle(po);
  if (!key) return norm(po);
  for (const [needle, label] of PO_TITLE_OVERRIDES.entries()) {
    if (key.includes(needle) || needle.includes(key)) return label;
  }
  return norm(po);
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

function canonicalBranch(branch) {
  const src = norm(branch);
  if (!src) return "";
  const key = branchNeedle(src);
  if (!key) return src;
  for (const [needle, label] of BRANCH_CANONICAL.entries()) {
    if (key.includes(needle) || needle.includes(key)) return label;
  }
  return src.toUpperCase();
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
    `${row.subcontrol_area_name || ""} ${row.settlement || ""} ${row.enobj_name || ""}`
  ).replace(/[^а-яa-z0-9]/gi, "");
  return blob.includes(needle);
}

function buildPoBranchIndex(points) {
  const counters = new Map();
  for (const p of points) {
    const key = poNeedle(p.po);
    const branch = canonicalBranch(p.branch);
    if (!key || !branch) continue;
    if (!counters.has(key)) counters.set(key, new Map());
    const branchMap = counters.get(key);
    branchMap.set(branch, Number(branchMap.get(branch) || 0) + 1);
  }
  const out = new Map();
  for (const [key, branchMap] of counters.entries()) {
    const forced = resolvePoBranchOverride(key);
    if (forced) {
      out.set(key, forced);
      continue;
    }
    const selected = Array.from(branchMap.entries())
      .sort((a, b) => {
        const dc = Number(b[1] || 0) - Number(a[1] || 0);
        if (dc !== 0) return dc;
        return String(a[0] || "").localeCompare(String(b[0] || ""), "ru");
      })[0]?.[0];
    if (selected) out.set(key, selected);
  }
  return out;
}

function findPointDispatcherPhone(points, { branch = "", po = "" } = {}) {
  const poTitle = norm(po);
  if (!poTitle) return "";

  const branchTitle = canonicalBranch(branch);
  const matched = points.filter((point) => {
    if (!samePo(point.po, poTitle)) return false;
    if (!branchTitle) return true;
    return sameBranch(point.branch, branchTitle);
  });

  const selected =
    matched.find((point) => point.point_kind === "base" && norm(point.dispatcher_phone)) ||
    matched.find((point) => norm(point.dispatcher_phone)) ||
    null;

  return norm(selected?.dispatcher_phone);
}

async function getToken() {
  if (STRAPI_API_TOKEN) return STRAPI_API_TOKEN;
  const jwt = await getJwt();
  if (!jwt) throw new Error("Не удалось авторизоваться в Strapi");
  return jwt;
}

async function fetchAll(endpoint, fields, token, extraParams = {}) {
  if (!STRAPI_URL) throw new Error("URL_STRAPI не задан");
  const rows = [];
  const pageSize = 100;
  const concurrency = 6;

  const fetchPage = async (page) => {
    const params = {
      ...extraParams,
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
    const pageRows = [];
    for (const row of batch) {
      const attrs = row?.attributes || row || {};
      pageRows.push({
        id: row?.id ?? attrs?.id ?? null,
        documentId: row?.documentId || attrs?.documentId || null,
        ...attrs,
      });
    }

    return {
      rows: pageRows,
      pageCount: Number(data?.meta?.pagination?.pageCount || 1),
    };
  };

  const first = await fetchPage(1);
  rows.push(...first.rows);

  const pages = [];
  for (let page = 2; page <= first.pageCount; page += 1) pages.push(page);

  for (let i = 0; i < pages.length; i += concurrency) {
    const chunk = pages.slice(i, i + concurrency);
    const results = await Promise.all(chunk.map((page) => fetchPage(page)));
    for (const result of results) rows.push(...result.rows);
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
    rows = await fetchAll(ENDPOINT_UNITS, [...baseFields, "po", "prioritet"], token);
  } catch (e) {
    const status = Number(e?.response?.status || 0);
    if (status !== 400) throw e;
    try {
      rows = await fetchAll(ENDPOINT_UNITS, [...baseFields, "po"], token);
    } catch (e2) {
      const status2 = Number(e2?.response?.status || 0);
      if (status2 !== 400) throw e2;
      rows = await fetchAll(ENDPOINT_UNITS, baseFields, token);
    }
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
  const rows = await fetchAll(ENDPOINT_ELECTRO, ELECTRO_FIELDS, token);
  cache.electro = { ts: now, rows };
  return rows;
}

async function getElectroFiltered(extraParams = {}) {
  const token = await getToken();
  return fetchAll(ENDPOINT_ELECTRO, ELECTRO_FIELDS, token, extraParams);
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
        branch: canonicalBranch(
          UNIT_BRANCH_OVERRIDES.get(norm(u.garage_number)) || norm(u.branch)
        ),
        po: norm(u.po) || meta.po,
        prioritet: toBool(u.prioritet),
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
      branch: canonicalBranch(p.branch),
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

async function mapTpRows(rows, { branch = "", po = "" } = {}) {
  const branchNorm = canonicalBranch(branch);
  const hasBranchFilter = Boolean(normLc(branchNorm));
  const poNorm = norm(po);
  const hasPoFilter = Boolean(poNorm);

  const points = await getPoints();
  const poBranchIndex = buildPoBranchIndex(points);

  return rows
    .filter(isTpLike)
    .filter((r) => {
      const key = poNeedle(r.subcontrol_area_name);
      const forcedBranch = resolvePoBranchOverride(key);
      if (forcedBranch) return hasBranchFilter ? sameBranch(forcedBranch, branchNorm) : true;
      const mappedBranch = poBranchIndex.get(key) || "";
      if (mappedBranch) return hasBranchFilter ? sameBranch(mappedBranch, branchNorm) : true;
      if (hasPoFilter && rowContainsPoTerm(r, poSearchTerm(poNorm))) return true;
      return hasBranchFilter ? matchesBranch(r, branchNorm) : true;
    })
    .map((r) => {
      const rawPo = canonicalPoTitle(r.subcontrol_area_name);
      const poTitle =
        hasPoFilter && !samePo(rawPo, poNorm) && rowContainsPoTerm(r, poSearchTerm(poNorm))
          ? poNorm
          : rawPo;
      const branchTitle =
        canonicalBranch(
          resolvePoBranchOverride(poNeedle(r.subcontrol_area_name)) ||
            poBranchIndex.get(poNeedle(r.subcontrol_area_name)) ||
            branchNorm
        ) || branchNorm || "";
      return {
        id: `tp-${norm(r.keylink)}`,
        keylink: norm(r.keylink),
        branch: branchTitle,
        po: poTitle,
        title: norm(r.enobj_name) || norm(r.keylink),
        address: norm(r.address) || norm(r.settlement) || norm(r.subcontrol_area_name),
        lat: toNum(r.lat),
        lon: toNum(r.lon),
        dispatcherPhone: findPointDispatcherPhone(points, {
          branch: branchTitle,
          po: poTitle,
        }),
        type: "tp",
      };
    })
    .filter((x) => (hasPoFilter ? samePo(x.po, poNorm) : true));
}

async function loadTpDestinations({ branch = "", po = "" } = {}) {
  const poNorm = norm(po);
  const poFilter = poSearchTerm(poNorm);
  const rows = poFilter
    ? mergeRowsByKeylink(
        await Promise.all([
          getElectroFiltered({
            "filters[subcontrol_area_name][$containsi]": poFilter,
          }),
          getElectroFiltered({
            "filters[settlement][$containsi]": poFilter,
          }),
        ])
      )
    : await getElectro();

  return mapTpRows(rows, { branch, po });
}

async function loadTpDestinationById(destinationId) {
  const key = norm(destinationId).replace(/^tp-/i, "");
  if (!key) return null;

  const rows = await getElectroFiltered({
    "filters[keylink][$eq]": key,
  });
  const mapped = await mapTpRows(rows);
  return mapped.find((x) => String(x.id || "") === `tp-${key}`) || null;
}

async function loadTpHints() {
  const map = new Map();
  const points = await getPoints();

  for (const point of points) {
    const branch = canonicalBranch(point.branch);
    const po = canonicalPoTitle(point.po);
    if (!branch || !po) continue;
    if (TP_HINT_EXCLUDED_PO_KEYS.has(poNeedle(po))) continue;

    if (!map.has(branch)) map.set(branch, new Set());
    map.get(branch).add(po);
  }

  return Array.from(map.entries())
    .sort((a, b) => String(a[0]).localeCompare(String(b[0]), "ru"))
    .map(([branch, poSet]) => ({
      branch,
      po: Array.from(poSet).sort((a, b) => String(a).localeCompare(String(b), "ru")),
    }));
}

module.exports = {
  loadPesItems,
  loadAssemblyDestinations,
  loadTpDestinations,
  loadTpDestinationById,
  loadTpHints,
};
