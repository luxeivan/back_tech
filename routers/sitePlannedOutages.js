const express = require("express");
const axios = require("axios");
require("dotenv").config();

const router = express.Router();

const STRAPI_URL = process.env.URL_STRAPI;
const STRAPI_LOGIN = process.env.LOGIN_STRAPI;
const STRAPI_PASSWORD = process.env.PASSWORD_STRAPI;
const PLANNED_STATUSES = ["запланировано", "начата"];
const MOSCOW_TZ_OFFSET = "+03:00";
const JWT_CACHE_MS = 10 * 60 * 1000;
const RESPONSE_CACHE_MS = 5 * 60 * 1000;
const DEFAULT_COORDINATES = { lat: 55.754475, lon: 37.621869 };
let jwtCache = {
  token: "",
  expiresAt: 0,
};
const responseCache = new Map();
const daysResponseCache = new Map();
const DISTRICT_CENTERS = [
  ["Балашиха", 55.7963, 37.9382],
  ["Видное", 55.5518, 37.7066],
  ["Волоколамск", 56.0358, 35.9586],
  ["Воскресенск", 55.3173, 38.6815],
  ["Восход", 55.9731, 36.5296],
  ["Гжель", 55.6108, 38.3931],
  ["Голицыно", 55.6154, 36.9873],
  ["Дмитровский", 56.3477, 37.5267],
  ["Долгопрудный", 55.9386, 37.5101],
  ["Домодедово", 55.4364, 37.7666],
  ["Дубна", 56.7418, 37.1757],
  ["Егорьевск", 55.3831, 39.0358],
  ["Звенигород", 55.7296, 36.8553],
  ["Звёздный Городок", 55.8831, 38.1134],
  ["Ильинское", 55.6199, 38.1189],
  ["Истра", 55.9061, 36.8601],
  ["Кашира", 54.8534, 38.1904],
  ["Клин", 56.3334, 36.7304],
  ["Коломна", 55.1028, 38.7531],
  ["Красногорск", 55.8311, 37.3302],
  ["Краснознаменск", 55.5986, 37.0388],
  ["Лосино-Петровский", 55.8717, 38.2006],
  ["Луховицы", 54.9652, 39.0258],
  ["Лыткарино", 55.5821, 37.9056],
  ["Люберцы", 55.6765, 37.8981],
  ["Можайский", 55.5069, 36.0248],
  ["Мытищи", 55.9105, 37.7363],
  ["Наро-Фоминск", 55.3862, 36.7344],
  ["Ногинск", 55.8559, 38.4416],
  ["Одинцово", 55.6789, 37.2636],
  ["Орехово-Зуево", 55.8068, 38.9796],
  ["Павловский Посад", 55.7807, 38.6599],
  ["Подольск", 55.4312, 37.5457],
  ["Протвино", 54.8685, 37.2151],
  ["Пушкино", 56.0104, 37.8472],
  ["Раменский", 55.4738, 38.2719],
  ["Раменское", 55.5683, 38.2250],
  ["Рошаль", 55.6647, 39.8650],
  ["Руза", 55.7015, 36.1960],
  ["Сергиев-Посад", 56.3153, 38.1358],
  ["Серпухов", 54.9158, 37.4111],
  ["Солнечногорск", 56.1851, 36.9776],
  ["Ступино", 54.8869, 38.0784],
  ["Фрязино", 55.9590, 38.0456],
  ["Химки", 55.8892, 37.4449],
  ["Чехов", 55.1507, 37.4533],
  ["Черноголовка", 56.0101, 38.3792],
  ["Шатура", 55.5777, 39.5446],
  ["Шаховская", 56.0315, 35.5114],
  ["Щёлково", 55.9234, 37.9784],
  ["Щелково", 55.9234, 37.9784],
  ["Электросталь", 55.7851, 38.4447],
].reduce((acc, [name, lat, lon]) => {
  acc.set(normalizeName(name), { name, lat, lon });
  return acc;
}, new Map());

async function getJwt() {
  if (jwtCache.token && jwtCache.expiresAt > Date.now()) {
    return jwtCache.token;
  }

  const res = await axios.post(`${STRAPI_URL}/api/auth/local`, {
    identifier: STRAPI_LOGIN,
    password: STRAPI_PASSWORD,
  });
  jwtCache = {
    token: res.data.jwt,
    expiresAt: Date.now() + JWT_CACHE_MS,
  };
  return jwtCache.token;
}

function pickRaw(item) {
  return item?.data?.data ?? item?.data ?? item?.attributes?.data?.data ?? item?.attributes?.data ?? {};
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return "";
}

function normalizeName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[«»"']/g, "")
    .replace(/г\s*\.?\s*о\s*\.?/g, " ")
    .replace(/м\s*\.?\s*о\s*\.?/g, " ")
    .replace(/(^|[^а-яa-z0-9])городской(?=$|[^а-яa-z0-9])/g, " ")
    .replace(/(^|[^а-яa-z0-9])муниципальный(?=$|[^а-яa-z0-9])/g, " ")
    .replace(/(^|[^а-яa-z0-9])город(?=$|[^а-яa-z0-9])/g, " ")
    .replace(/(^|[^а-яa-z0-9])округ(?=$|[^а-яa-z0-9])/g, " ")
    .replace(/(^|[^а-яa-z0-9])район(?=$|[^а-яa-z0-9])/g, " ")
    .replace(/(^|[^а-яa-z0-9])г\s*\./g, " ")
    .replace(/[^а-яa-z0-9-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseDateParam(value) {
  const fallback = new Date();
  const raw = String(value || "").trim();
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) {
    return {
      day: raw,
      startIso: `${raw}T00:00:00.000${MOSCOW_TZ_OFFSET}`,
      endIso: `${raw}T23:59:59.999${MOSCOW_TZ_OFFSET}`,
    };
  }

  const yyyy = fallback.getFullYear();
  const mm = String(fallback.getMonth() + 1).padStart(2, "0");
  const dd = String(fallback.getDate()).padStart(2, "0");
  const day = `${yyyy}-${mm}-${dd}`;
  return {
    day,
    startIso: `${day}T00:00:00.000${MOSCOW_TZ_OFFSET}`,
    endIso: `${day}T23:59:59.999${MOSCOW_TZ_OFFSET}`,
  };
}

function parseMonthParam(value) {
  const fallback = new Date();
  const raw = String(value || "").trim();
  const match = raw.match(/^(\d{4})-(\d{2})$/);
  const year = match ? Number(match[1]) : fallback.getFullYear();
  const month = match ? Number(match[2]) : fallback.getMonth() + 1;
  const normalizedMonth = Math.min(Math.max(month, 1), 12);
  const monthKey = `${year}-${String(normalizedMonth).padStart(2, "0")}`;
  const daysInMonth = new Date(year, normalizedMonth, 0).getDate();

  return {
    month: monthKey,
    year,
    monthNumber: normalizedMonth,
    daysInMonth,
    startIso: `${monthKey}-01T00:00:00.000${MOSCOW_TZ_OFFSET}`,
    endIso: `${monthKey}-${String(daysInMonth).padStart(2, "0")}T23:59:59.999${MOSCOW_TZ_OFFSET}`,
  };
}

async function fetchAllStrapi(client, path, params) {
  const pageSize = Number(params?.["pagination[pageSize]"]) || 100;
  let page = 1;
  let result = [];

  while (true) {
    const r = await client.get(path, {
      params: {
        ...params,
        "pagination[page]": page,
        "pagination[pageSize]": pageSize,
      },
    });
    const rows = Array.isArray(r?.data?.data) ? r.data.data : [];
    result = result.concat(rows);
    const total = r?.data?.meta?.pagination?.total ?? result.length;
    if (result.length >= total || rows.length === 0) break;
    page += 1;
  }

  return result;
}

function getPlannedStatus(item, raw) {
  return String(item?.STATUS_NAME || raw?.STATUS_NAME || "").trim().toLowerCase();
}

function getDistrictCenter(districtName) {
  const normalized = normalizeName(districtName);
  if (!normalized) {
    return {
      name: districtName || "Московская область",
      ...DEFAULT_COORDINATES,
    };
  }

  if (DISTRICT_CENTERS.has(normalized)) return DISTRICT_CENTERS.get(normalized);

  for (const [key, center] of DISTRICT_CENTERS.entries()) {
    if (normalized.includes(key) || key.includes(normalized)) return center;
  }

  return {
    name: districtName || "Московская область",
    ...DEFAULT_COORDINATES,
  };
}

function mapPlannedItem(item) {
  const raw = pickRaw(item);
  const districtName = firstNonEmpty(raw?.DISTRICT, item?.dispCenter, raw?.DISPCENTER_NAME_);
  const districtCenter = getDistrictCenter(districtName);
  const begin = firstNonEmpty(raw?.F81_060_EVENTDATETIME, item?.createDateTime);
  const end = firstNonEmpty(raw?.F81_070_RESTOR_SUPPLAYDATETIME, item?.recoveryPlanDateTime);
  const address = firstNonEmpty(raw?.ADDRESS_LIST, item?.addressList, raw?.HOUSE_LIST, districtName);
  const comment = firstNonEmpty(raw?.BRIGADE_ACTION, raw?.DESCRIPTION, item?.description);
  const objectName = firstNonEmpty(raw?.F81_041_ENERGOOBJECTNAME, item?.energoObject);
  const lat = Number(districtCenter?.lat) || 55.754475;
  const lon = Number(districtCenter?.lon) || 37.621869;

  return {
    id: item?.id,
    attributes: {
      begin,
      end,
      comment,
      guid: firstNonEmpty(item?.guid, raw?.VIOLATION_GUID_STR, item?.documentId),
      number: firstNonEmpty(raw?.F81_010_NUMBER, item?.number),
      statusName: getPlannedStatus(item, raw),
      branch: firstNonEmpty(raw?.SC_FILIAL, raw?.OWN_SCNAME),
      po: firstNonEmpty(raw?.SC_PO, raw?.SCNAME),
      uzel_podklyucheniya: {
        data: {
          attributes: {
            gorod: {
              data: {
                attributes: {
                  name: districtCenter?.name || districtName || "Московская область",
                  fias: {
                    data: {
                      geo_lat: lat,
                      geo_lon: lon,
                    },
                  },
                },
              },
            },
            uliczas: {
              data: [
                {
                  attributes: {
                    name: address,
                    comment: objectName,
                    fias: {
                      value: address,
                      data: {
                        geo_lat: lat,
                        geo_lon: lon,
                      },
                    },
                  },
                },
              ],
            },
          },
        },
      },
    },
  };
}

function getPlannedItemDateRange(item) {
  const raw = pickRaw(item);
  return {
    begin: firstNonEmpty(raw?.F81_060_EVENTDATETIME, item?.createDateTime),
    end: firstNonEmpty(raw?.F81_070_RESTOR_SUPPLAYDATETIME, item?.recoveryPlanDateTime),
  };
}

function getPlannedDays(rows, monthInfo) {
  const days = [];

  for (let day = 1; day <= monthInfo.daysInMonth; day += 1) {
    const dayKey = `${monthInfo.month}-${String(day).padStart(2, "0")}`;
    const dayStart = Date.parse(`${dayKey}T00:00:00.000${MOSCOW_TZ_OFFSET}`);
    const dayEnd = Date.parse(`${dayKey}T23:59:59.999${MOSCOW_TZ_OFFSET}`);
    const hasOutages = rows.some((item) => {
      const { begin, end } = getPlannedItemDateRange(item);
      const beginMs = Date.parse(begin);
      const endMs = Date.parse(end);
      return Number.isFinite(beginMs) && Number.isFinite(endMs) && beginMs <= dayEnd && endMs >= dayStart;
    });

    if (hasOutages) days.push(dayKey);
  }

  return days;
}

async function fetchPlannedRowsForRange(startIso, endIso) {
  const jwt = await getJwt();
  const client = axios.create({
    baseURL: STRAPI_URL,
    timeout: 30000,
    headers: { Authorization: `Bearer ${jwt}` },
  });

  return fetchAllStrapi(client, "/api/teh-narusheniyas", {
    "pagination[pageSize]": 100,
    "sort[0]": "createDateTime:ASC",
    "filters[$and][0][BASE_TYPE][$eq]": 1,
    "filters[$and][1][createDateTime][$lte]": endIso,
    "filters[$and][2][recoveryPlanDateTime][$gte]": startIso,
    "filters[$and][3][$or][0][STATUS_NAME][$eqi]": PLANNED_STATUSES[0],
    "filters[$and][3][$or][1][STATUS_NAME][$eqi]": PLANNED_STATUSES[1],
  });
}

router.get("/days", async (req, res) => {
  try {
    const monthInfo = parseMonthParam(req.query.month);
    const cached = daysResponseCache.get(monthInfo.month);
    if (cached && cached.expiresAt > Date.now()) {
      return res.json({
        ...cached.payload,
        meta: {
          ...cached.payload.meta,
          cached: true,
        },
      });
    }

    const rows = await fetchPlannedRowsForRange(monthInfo.startIso, monthInfo.endIso);
    const days = getPlannedDays(rows, monthInfo);
    const payload = {
      data: days,
      meta: {
        source: "jtn-strapi",
        month: monthInfo.month,
        total: days.length,
        cached: false,
      },
    };

    daysResponseCache.set(monthInfo.month, {
      expiresAt: Date.now() + RESPONSE_CACHE_MS,
      payload,
    });

    return res.json(payload);
  } catch (e) {
    console.error("[sitePlannedOutages.days] Ошибка:", e?.response?.data || e?.message || e);
    res.status(500).json({
      data: [],
      meta: {
        source: "jtn-strapi",
        total: 0,
        error: "Не удалось получить даты плановых отключений",
      },
    });
  }
});

router.get("/", async (req, res) => {
  try {
    const { day, startIso, endIso } = parseDateParam(req.query.date);
    const cached = responseCache.get(day);
    if (cached && cached.expiresAt > Date.now()) {
      return res.json({
        ...cached.payload,
        meta: {
          ...cached.payload.meta,
          cached: true,
        },
      });
    }

    const rows = await fetchPlannedRowsForRange(startIso, endIso);
    const data = rows.map(mapPlannedItem);

    const payload = {
      data,
      meta: {
        source: "jtn-strapi",
        day,
        total: data.length,
        cached: false,
      },
    };
    responseCache.set(day, {
      expiresAt: Date.now() + RESPONSE_CACHE_MS,
      payload,
    });

    return res.json(payload);
  } catch (e) {
    console.error("[sitePlannedOutages] Ошибка:", e?.response?.data || e?.message || e);
    res.status(500).json({
      data: [],
      meta: {
        source: "jtn-strapi",
        total: 0,
        error: "Не удалось получить плановые отключения",
      },
    });
  }
});

module.exports = router;
