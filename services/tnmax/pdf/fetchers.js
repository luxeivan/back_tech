// Серверные загрузчики данных для PDF-выгрузок (параметры запросов 1-в-1 с фронтом).
const axios = require("axios");
const { isOpenTN, isDashboardBaseType, isNotDeletedTN } = require("./common");

const FETCH_CONCURRENCY = 6;

function strapiBase() {
  const base = String(process.env.URL_STRAPI || "").replace(/\/$/, "");
  if (!base) throw new Error("URL_STRAPI не задан");
  return base;
}

// Локальный хост сервисов (как VITE_URL_BACKEND_SERVICES на фронте).
function servicesBase() {
  return `http://127.0.0.1:${process.env.PORT || 3110}`;
}

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

// Порт fetchDashboardRowsPageSet (front dashboardPage.utils.js:251-312).
async function fetchDashboardRowsPageSet({ jwt, queryParts, pageSize = 1000, concurrency = FETCH_CONCURRENCY }) {
  const mapIt = (x) => (x?.attributes ? { id: x.id, ...x.attributes } : x);
  const headers = { Authorization: `Bearer ${jwt}` };
  const buildQuery = (page) =>
    [
      `pagination[page]=${page}`,
      `pagination[pageSize]=${pageSize}`,
      ...queryParts,
    ].join("&");

  const firstResp = await axios.get(`${strapiBase()}/api/teh-narusheniyas?${buildQuery(1)}`, {
    headers,
    timeout: 60000,
  });
  const firstList = Array.isArray(firstResp?.data?.data) ? firstResp.data.data.map(mapIt) : [];
  const pageCount = Number(firstResp?.data?.meta?.pagination?.pageCount || 1);

  if (pageCount <= 1) return firstList;

  const restRequests = Array.from({ length: pageCount - 1 }, (_, index) => async () => {
    const page = index + 2;
    return axios.get(`${strapiBase()}/api/teh-narusheniyas?${buildQuery(page)}`, {
      headers,
      timeout: 60000,
    });
  });
  const restResponses = await runLimited(restRequests, concurrency);
  const restList = restResponses.flatMap((resp) =>
    Array.isArray(resp?.data?.data) ? resp.data.data.map(mapIt) : []
  );

  return [...firstList, ...restList];
}

// Порт fetchOperationalDashboardInitialRows (front dashboardPage.utils.js:193-216):
// открытые аварийные ТН (BASE_TYPE=0), без удалённых.
async function fetchOpenTnRows(jwt) {
  if (!jwt) throw new Error("Нет JWT: авторизуйтесь");

  const data = await fetchDashboardRowsPageSet({
    jwt,
    queryParts: [
      "sort[0]=createDateTime:DESC",
      "filters[isActive][$eq]=true",
      "filters[BASE_TYPE][$eq]=0",
    ],
    pageSize: 500,
  });
  return data.filter((row) => isOpenTN(row) && isDashboardBaseType(row) && isNotDeletedTN(row));
}

// ПЭС-элементы: GET /services/pes/module/items → data.items (или []).
async function fetchPesItems(jwt) {
  const { data } = await axios.get(`${servicesBase()}/services/pes/module/items`, {
    headers: { Authorization: `Bearer ${jwt}` },
    timeout: 30000,
  });
  return Array.isArray(data?.items) ? data.items : [];
}

// Складочные пункты ПЭС: GET .../destinations?destinationType=assembly → data.assembly (или []).
async function fetchPesDestinations(jwt) {
  const { data } = await axios.get(`${servicesBase()}/services/pes/module/destinations`, {
    params: { destinationType: "assembly" },
    headers: { Authorization: `Bearer ${jwt}` },
    timeout: 30000,
  });
  return Array.isArray(data?.assembly) ? data.assembly : [];
}

module.exports = {
  fetchOpenTnRows,
  fetchPesItems,
  fetchPesDestinations,
};
