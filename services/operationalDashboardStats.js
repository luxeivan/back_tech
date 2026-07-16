const axios = require("axios");
require("dotenv").config();
const { getJwt } = require("./modus/strapi");

const OPERATIONAL_CHART_YEAR = 2026;
const STATS_COLLECTION = "dashbord-oo-statistikas";
const STATS_CODE = `tech_violations_${OPERATIONAL_CHART_YEAR}`;
const DEFAULT_REFRESH_MS = 10 * 60 * 1000;
const REFRESH_MS =
  Number(process.env.OPERATIONAL_DASHBOARD_STATS_REFRESH_MS) || DEFAULT_REFRESH_MS;
const PAGE_SIZE = 100;
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

let refreshTimer = null;
let refreshInFlight = null;
let memoryPayload = null;

const log = (message, details) => {
  if (details === undefined) {
    console.log(`[dashboard-oo-stats] ${message}`);
    return;
  }
  console.log(`[dashboard-oo-stats] ${message}`, details);
};

const mapItem = (item) => {
  const attributes = item?.attributes || {};
  return {
    id: item?.id ?? attributes.id,
    documentId: item?.documentId || attributes.documentId || null,
    ...attributes,
    ...item,
  };
};

const pick = (row, key) =>
  row?.[key] ?? row?.data?.[key] ?? row?.data?.data?.[key] ?? null;

const getBaseType = (row) => {
  const value = Number(pick(row, "BASE_TYPE"));
  return Number.isFinite(value) ? value : null;
};

const getStatusName = (row) => String(pick(row, "STATUS_NAME") || "").trim().toLowerCase();

const getBranchByRow = (row) =>
  DISPCENTER_BRANCH_BY_NORMALIZED_NAME.get(normalizeLookupName(pick(row, "DISPCENTER_NAME_"))) ||
  null;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

const createStrapiClient = async () => {
  const strapiUrl = String(process.env.URL_STRAPI || "").replace(/\/$/, "");
  if (!strapiUrl) throw new Error("URL_STRAPI не задан");

  const jwt = await getJwt();
  if (!jwt) throw new Error("Не удалось получить JWT Strapi");

  return axios.create({
    baseURL: strapiUrl,
    headers: {
      Authorization: `Bearer ${jwt}`,
      Connection: "close",
    },
    timeout: REQUEST_TIMEOUT_MS,
  });
};

const buildTnQuery = (page) => ({
  "pagination[page]": page,
  "pagination[pageSize]": PAGE_SIZE,
  "sort[0]": "createDateTime:DESC",
  "filters[createDateTime][$gte]": `${OPERATIONAL_CHART_YEAR}-01-01T00:00:00.000+03:00`,
  "filters[createDateTime][$lt]": `${OPERATIONAL_CHART_YEAR + 1}-01-01T00:00:00.000+03:00`,
  "filters[BASE_TYPE][$eq]": 0,
});

const requestWithRetry = async (fn, label) => {
  let lastError = null;

  for (let attempt = 1; attempt <= REQUEST_RETRIES; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt >= REQUEST_RETRIES) break;

      const status = error?.response?.status || error?.code || error?.message || "unknown";
      const delay = RETRY_DELAY_MS * attempt;
      log(`${label}: попытка ${attempt}/${REQUEST_RETRIES} упала (${status}), повтор через ${delay} мс`);
      await wait(delay);
    }
  }

  throw lastError;
};

const fetchTnPage = async ({ client, page }) =>
  requestWithRetry(
    () => client.get("/api/teh-narusheniyas", { params: buildTnQuery(page) }),
    `страница ТН ${page}`
  );

const fetchAllCurrentYearRows = async (client) => {
  const firstResponse = await fetchTnPage({ client, page: 1 });
  const firstRows = Array.isArray(firstResponse?.data?.data)
    ? firstResponse.data.data.map(mapItem)
    : [];
  const pagination = firstResponse?.data?.meta?.pagination || {};
  const pageCount = Number(pagination.pageCount || 1);
  const total = Number(pagination.total || firstRows.length);
  const effectivePageSize = Number(pagination.pageSize || PAGE_SIZE);

  log(`Страница 1/${pageCount}: загружено ${firstRows.length}/${total || "?"}`);

  const restTasks = Array.from({ length: Math.max(0, pageCount - 1) }, (_, index) => {
    const page = index + 2;
    return async () => {
      const response = await fetchTnPage({ client, page });
      const rows = Array.isArray(response?.data?.data) ? response.data.data.map(mapItem) : [];
      if (page === pageCount || page % 10 === 0) {
        log(`Страница ${page}/${pageCount}: загружено ${(page - 1) * effectivePageSize + rows.length}/${total || "?"}`);
      }
      return rows;
    };
  });

  const restRows = (await runLimited(restTasks)).flat();
  return {
    rows: [...firstRows, ...restRows],
    meta: {
      pageCount,
      total,
      requestedPageSize: PAGE_SIZE,
      effectivePageSize,
    },
  };
};

const buildStatsPayload = ({ rows, fetchMeta, startedAt }) => {
  const counts = new Map(BRANCHES.map((branch) => [branch, 0]));
  const unmatched = new Map();

  rows.forEach((row) => {
    if (getBaseType(row) !== 0 || getStatusName(row) === "удалена") return;

    const branch = getBranchByRow(row);
    if (!branch) {
      const dispcenter = String(pick(row, "DISPCENTER_NAME_") || "Без DISPCENTER_NAME_").trim();
      unmatched.set(dispcenter, (unmatched.get(dispcenter) || 0) + 1);
      return;
    }

    counts.set(branch, counts.get(branch) + 1);
  });

  const calculatedAt = new Date().toISOString();
  const nextCalculatedAt = new Date(Date.now() + REFRESH_MS).toISOString();
  const chartRows = BRANCHES.map((branch) => ({
    OWN_SCNAME: branch,
    BASE_TYPE: 0,
    __count: counts.get(branch) || 0,
  }));

  return {
    ok: true,
    year: OPERATIONAL_CHART_YEAR,
    rows: chartRows,
    meta: {
      ...fetchMeta,
      code: STATS_CODE,
      matched: chartRows.reduce((sum, row) => sum + Number(row.__count || 0), 0),
      unmatched: Array.from(unmatched.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => ({ name, count })),
      calculatedAt,
      nextCalculatedAt,
      refreshMs: REFRESH_MS,
      ms: Date.now() - startedAt,
      source: STATS_COLLECTION,
    },
  };
};

const findStatsRecord = async (client) => {
  const response = await requestWithRetry(
    () =>
      client.get(`/api/${STATS_COLLECTION}`, {
        params: {
          "filters[code][$eq]": STATS_CODE,
          "pagination[page]": 1,
          "pagination[pageSize]": 1,
        },
      }),
    "поиск записи статистики"
  );

  const item = Array.isArray(response?.data?.data) ? response.data.data[0] : null;
  return item ? mapItem(item) : null;
};

const readStatsPayload = async () => {
  const client = await createStrapiClient();
  const record = await findStatsRecord(client);
  const data = record?.data;
  if (!data?.rows) return null;
  return data;
};

const saveStatsPayload = async ({ client, payload }) => {
  const existing = await findStatsRecord(client);
  const writeId = existing?.documentId || existing?.id;
  const body = {
    data: {
      code: STATS_CODE,
      data: payload,
    },
  };

  if (writeId) {
    log(`Обновляю запись Strapi: ${STATS_COLLECTION}/${writeId}`);
    await requestWithRetry(
      () => client.put(`/api/${STATS_COLLECTION}/${writeId}`, body),
      "обновление записи статистики"
    );
    return { action: "updated", writeId };
  }

  log(`Создаю запись Strapi: ${STATS_COLLECTION}`);
  const response = await requestWithRetry(
    () => client.post(`/api/${STATS_COLLECTION}`, body),
    "создание записи статистики"
  );
  const created = mapItem(response?.data?.data);
  return { action: "created", writeId: created?.documentId || created?.id || null };
};

const refreshOperationalDashboardStats = async ({ reason = "manual" } = {}) => {
  if (refreshInFlight) {
    log(`Пересчет уже идет, подключаюсь к текущему процессу (${reason})`);
    return refreshInFlight;
  }

  refreshInFlight = (async () => {
    const startedAt = Date.now();
    log(`Старт пересчета ${STATS_CODE}, причина: ${reason}`);

    const client = await createStrapiClient();
    log("JWT Strapi получен, начинаю загрузку teh-narusheniyas");

    const { rows, meta } = await fetchAllCurrentYearRows(client);
    log(`Загрузка завершена: строк ${rows.length}, meta.total=${meta.total}`);

    const payload = buildStatsPayload({ rows, fetchMeta: meta, startedAt });
    log("Расчет завершен", {
      matched: payload.meta.matched,
      unmatchedCount: payload.meta.unmatched.reduce((sum, item) => sum + item.count, 0),
      ms: payload.meta.ms,
    });

    const saveResult = await saveStatsPayload({ client, payload });
    memoryPayload = payload;
    log("Статистика сохранена в Strapi", {
      action: saveResult.action,
      writeId: saveResult.writeId,
      calculatedAt: payload.meta.calculatedAt,
      nextCalculatedAt: payload.meta.nextCalculatedAt,
    });

    return payload;
  })();

  try {
    return await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
};

const getOperationalDashboardStatsPayload = async () => {
  const payload = await readStatsPayload();
  if (payload) {
    memoryPayload = payload;
    return payload;
  }

  if (memoryPayload) return memoryPayload;
  return null;
};

const startOperationalDashboardStatsScheduler = () => {
  if (refreshTimer) return;

  log(`Планировщик включен: ${Math.round(REFRESH_MS / 60000)} мин.`);

  refreshOperationalDashboardStats({ reason: "startup" }).catch((error) => {
    log("Ошибка стартового пересчета", error?.response?.data || error?.message);
  });

  refreshTimer = setInterval(() => {
    refreshOperationalDashboardStats({ reason: "interval" }).catch((error) => {
      log("Ошибка интервального пересчета", error?.response?.data || error?.message);
    });
  }, REFRESH_MS);
};

module.exports = {
  OPERATIONAL_CHART_YEAR,
  REFRESH_MS,
  STATS_CODE,
  getOperationalDashboardStatsPayload,
  refreshOperationalDashboardStats,
  startOperationalDashboardStatsScheduler,
};
