const express = require("express");
const axios = require("axios");

const router = express.Router();

const OPERATIONAL_CHART_YEAR = 2026;
const CACHE_TTL_MS = 5 * 60 * 1000;
const FETCH_CONCURRENCY = 4;
const REQUEST_TIMEOUT_MS = 120000;
const REQUEST_RETRIES = 5;
const RETRY_DELAY_MS = 1500;

const BRANCHES = [
  "Домодедовский",
  "Коломенский",
  "Красногорский",
  "Мытищинский",
  "Одинцовский",
  "Орехово-Зуевский",
  "Павлово-Посадский",
  "Раменский",
  "Сергиево-Посадский",
  "Щелковский",
];

const DISPCENTER_TO_BRANCH = {
  Видное: "Домодедовский",
  Домодедово: "Домодедовский",
  Подольск: "Домодедовский",
  Чехов: "Домодедовский",
  Гжель: "Раменский",
  Ильинское: "Раменский",
  Люберцы: "Раменский",
  Раменское: "Раменский",
  Воскресенск: "Коломенский",
  Кашира: "Коломенский",
  Коломна: "Коломенский",
  Луховицы: "Коломенский",
  Протвино: "Коломенский",
  Серпухов: "Коломенский",
  Ступино: "Коломенский",
  Истра: "Красногорский",
  Клин: "Красногорский",
  Красногорск: "Красногорский",
  Химки: "Красногорский",
  "Орехово-Зуево город": "Орехово-Зуевский",
  Егорьевск: "Павлово-Посадский",
  "Орехово-Зуево район": "Павлово-Посадский",
  Рошаль: "Павлово-Посадский",
  Шатура: "Павлово-Посадский",
  Электросталь: "Павлово-Посадский",
  Голицыно: "Одинцовский",
  Звенигород: "Одинцовский",
  Краснознаменск: "Одинцовский",
  "Наро-Фоминск": "Одинцовский",
  Одинцово: "Одинцовский",
  Руза: "Одинцовский",
  Мытищи: "Мытищинский",
  Пушкино: "Мытищинский",
  Балашиха: "Щелковский",
  "Лосино-Петровский": "Щелковский",
  Ногинск: "Щелковский",
  Фрязино: "Щелковский",
  Щелково: "Щелковский",
  Дубна: "Сергиево-Посадский",
  "Сергиев-Посад": "Сергиево-Посадский",
};

const normalizeLookupName = (value) =>
  String(value || "")
    .replace(/ё/g, "е")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

const DISPCENTER_BRANCH_BY_NORMALIZED_NAME = new Map(
  Object.entries(DISPCENTER_TO_BRANCH).map(([dispcenter, branch]) => [
    normalizeLookupName(dispcenter),
    branch,
  ])
);

let currentYearCache = {
  expiresAt: 0,
  payload: null,
};

const mapIt = (item) => (item?.attributes ? { id: item.id, ...item.attributes } : item);

const pick = (row, key) =>
  row?.[key] ?? row?.data?.[key] ?? row?.data?.data?.[key] ?? null;

const nestedPick = (row, key) => row?.data?.[key] ?? row?.data?.data?.[key] ?? null;

const getBaseType = (row) => {
  const raw = row?.BASE_TYPE ?? nestedPick(row, "BASE_TYPE") ?? null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
};

const getStatusName = (row) => String(pick(row, "STATUS_NAME") || "").trim().toLowerCase();

const getBranchByRow = (row) =>
  DISPCENTER_BRANCH_BY_NORMALIZED_NAME.get(normalizeLookupName(pick(row, "DISPCENTER_NAME_"))) ||
  null;

const runLimited = async (tasks, limit = FETCH_CONCURRENCY) => {
  const results = new Array(tasks.length);
  let nextIndex = 0;

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (nextIndex < tasks.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await tasks[currentIndex]();
    }
  });

  await Promise.all(workers);
  return results;
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const buildQuery = (page, pageSize) =>
  [
    `pagination[page]=${page}`,
    `pagination[pageSize]=${pageSize}`,
    "sort[0]=createDateTime:DESC",
    `filters[createDateTime][$gte]=${encodeURIComponent(`${OPERATIONAL_CHART_YEAR}-01-01T00:00:00.000+03:00`)}`,
    `filters[createDateTime][$lt]=${encodeURIComponent(`${OPERATIONAL_CHART_YEAR + 1}-01-01T00:00:00.000+03:00`)}`,
    "filters[BASE_TYPE][$eq]=0",
  ].join("&");

const fetchStrapiPage = async ({ strapiUrl, headers, page, pageSize }) => {
  let lastError = null;

  for (let attempt = 1; attempt <= REQUEST_RETRIES; attempt += 1) {
    try {
      return await axios.get(`${strapiUrl}/api/teh-narusheniyas?${buildQuery(page, pageSize)}`, {
        headers: {
          ...headers,
          Connection: "close",
        },
        timeout: REQUEST_TIMEOUT_MS,
      });
    } catch (error) {
      lastError = error;
      if (attempt >= REQUEST_RETRIES) break;
      await wait(RETRY_DELAY_MS * attempt);
    }
  }

  throw lastError;
};

router.get("/current-year-counts", async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ ok: false, message: "Нет Authorization header" });
  }
  const strapiUrl = process.env.URL_STRAPI;
  if (!strapiUrl) {
    return res.status(500).json({ ok: false, message: "URL_STRAPI не задан" });
  }

  const now = Date.now();
  if (currentYearCache.payload && now < currentYearCache.expiresAt) {
    return res.json({ ...currentYearCache.payload, cached: true });
  }

  const startedAt = Date.now();
  const pageSize = 100;
  const headers = { Authorization: authHeader };

  try {
    const firstResponse = await fetchStrapiPage({ strapiUrl, headers, page: 1, pageSize });
    const firstRows = Array.isArray(firstResponse?.data?.data)
      ? firstResponse.data.data.map(mapIt)
      : [];
    const pageCount = Number(firstResponse?.data?.meta?.pagination?.pageCount || 1);
    const total = Number(firstResponse?.data?.meta?.pagination?.total || firstRows.length);
    const effectivePageSize = Number(firstResponse?.data?.meta?.pagination?.pageSize || pageSize);

    const restTasks = Array.from({ length: Math.max(0, pageCount - 1) }, (_, index) => {
      const page = index + 2;
      return async () => {
        const response = await fetchStrapiPage({ strapiUrl, headers, page, pageSize });
        return Array.isArray(response?.data?.data) ? response.data.data.map(mapIt) : [];
      };
    });

    const restRows = (await runLimited(restTasks)).flat();
    const counts = new Map(BRANCHES.map((branch) => [branch, 0]));
    const unmatched = new Map();

    [...firstRows, ...restRows].forEach((row) => {
      if (getBaseType(row) !== 0 || getStatusName(row) === "удалена") return;

      const branch = getBranchByRow(row);
      if (!branch) {
        const dispcenter = String(pick(row, "DISPCENTER_NAME_") || "Без DISPCENTER_NAME_").trim();
        unmatched.set(dispcenter, (unmatched.get(dispcenter) || 0) + 1);
        return;
      }

      counts.set(branch, counts.get(branch) + 1);
    });

    const rows = BRANCHES.map((branch) => ({
      OWN_SCNAME: branch,
      BASE_TYPE: 0,
      __count: counts.get(branch) || 0,
    }));

    const payload = {
      ok: true,
      year: OPERATIONAL_CHART_YEAR,
      rows,
      meta: {
        pageCount,
        total,
        requestedPageSize: pageSize,
        effectivePageSize,
        matched: rows.reduce((sum, row) => sum + Number(row.__count || 0), 0),
        unmatched: Array.from(unmatched.entries())
          .sort((a, b) => b[1] - a[1])
          .map(([name, count]) => ({ name, count })),
        ms: Date.now() - startedAt,
      },
    };

    currentYearCache = {
      expiresAt: Date.now() + CACHE_TTL_MS,
      payload,
    };

    return res.json(payload);
  } catch (error) {
    return res.status(error?.response?.status || 502).json({
      ok: false,
      message: error?.response?.data?.error?.message || error?.message || "Ошибка загрузки статистики",
    });
  }
});

module.exports = router;
