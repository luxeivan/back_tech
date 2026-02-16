const axios = require("axios");
const { getJwt } = require("./modus/strapi");

const STRAPI_URL = String(process.env.URL_STRAPI || "").replace(/\/$/, "");
const STRAPI_API_TOKEN = String(process.env.STRAPI_API_TOKEN || "").trim();

const PES_ENDPOINTS = {
  UNIT_STATES:
    process.env.STRAPI_PES_UNIT_STATES_ENDPOINT || "pes-unit-states",
  OPERATION_LOGS:
    process.env.STRAPI_PES_OPERATION_LOGS_ENDPOINT || "pes-operation-logs",
  BOT_STATES: process.env.STRAPI_PES_BOT_STATES_ENDPOINT || "pes-bot-states",
  SUBSCRIBERS:
    process.env.STRAPI_PES_SUBSCRIBERS_ENDPOINT || "pes-telegram-subscribers",
  BRANCHES: process.env.STRAPI_PES_BRANCHES_ENDPOINT || "pes-branches",
};

function toObj(v) {
  return v && typeof v === "object" ? v : {};
}

function normalizeRow(row) {
  if (!row || typeof row !== "object") return null;
  const attrs = row.attributes && typeof row.attributes === "object" ? row.attributes : row;
  const out = { ...attrs };
  if (row.id != null) out.id = row.id;
  if (!out.id && attrs.id != null) out.id = attrs.id;
  if (row.documentId) out.documentId = row.documentId;
  if (!out.documentId && attrs.documentId) out.documentId = attrs.documentId;
  return out;
}

function normalizeRows(list) {
  if (!Array.isArray(list)) return [];
  return list.map(normalizeRow).filter(Boolean);
}

async function getToken() {
  if (STRAPI_API_TOKEN) return STRAPI_API_TOKEN;
  const jwt = await getJwt();
  if (!jwt) throw new Error("Не удалось получить JWT для Strapi");
  return jwt;
}

async function authHeaders() {
  const token = await getToken();
  return { Authorization: `Bearer ${token}` };
}

async function fetchPage(endpoint, { params = {} } = {}) {
  if (!STRAPI_URL) throw new Error("URL_STRAPI не задан");
  const headers = await authHeaders();
  const { data } = await axios.get(`${STRAPI_URL}/api/${endpoint}`, {
    headers,
    params,
    timeout: 30000,
  });
  return {
    rows: normalizeRows(data?.data),
    pagination: toObj(data?.meta?.pagination),
  };
}

async function fetchAll(endpoint, { params = {}, pageSize = 100 } = {}) {
  if (!STRAPI_URL) throw new Error("URL_STRAPI не задан");
  let page = 1;
  const rows = [];

  while (true) {
    const current = {
      ...params,
      "pagination[page]": page,
      "pagination[pageSize]": pageSize,
    };
    const { rows: batch, pagination } = await fetchPage(endpoint, {
      params: current,
    });

    rows.push(...batch);
    const pageCount = Number(pagination.pageCount || 1);
    if (page >= pageCount) break;
    page += 1;
  }

  return rows;
}

async function fetchFirst(endpoint, { params = {} } = {}) {
  const { rows } = await fetchPage(endpoint, {
    params: {
      ...params,
      "pagination[page]": 1,
      "pagination[pageSize]": 1,
    },
  });
  return rows[0] || null;
}

async function createOne(endpoint, payload) {
  if (!STRAPI_URL) throw new Error("URL_STRAPI не задан");
  const headers = await authHeaders();
  const { data } = await axios.post(
    `${STRAPI_URL}/api/${endpoint}`,
    { data: payload },
    { headers, timeout: 30000 }
  );
  return normalizeRow(data?.data);
}

async function updateOne(endpoint, documentId, payload) {
  if (!documentId) throw new Error("Не передан documentId для update");
  if (!STRAPI_URL) throw new Error("URL_STRAPI не задан");
  const headers = await authHeaders();
  const { data } = await axios.put(
    `${STRAPI_URL}/api/${endpoint}/${documentId}`,
    { data: payload },
    { headers, timeout: 30000 }
  );
  return normalizeRow(data?.data);
}

async function deleteOne(endpoint, documentId) {
  if (!documentId) return;
  if (!STRAPI_URL) throw new Error("URL_STRAPI не задан");
  const headers = await authHeaders();
  await axios.delete(`${STRAPI_URL}/api/${endpoint}/${documentId}`, {
    headers,
    timeout: 30000,
  });
}

function oneRelation(rel) {
  if (!rel) return null;
  if (Array.isArray(rel)) return normalizeRow(rel[0]);
  if (rel.data !== undefined) return oneRelation(rel.data);
  return normalizeRow(rel);
}

function manyRelation(rel) {
  if (!rel) return [];
  if (Array.isArray(rel)) return normalizeRows(rel);
  if (rel.data !== undefined) return manyRelation(rel.data);
  return [normalizeRow(rel)].filter(Boolean);
}

module.exports = {
  PES_ENDPOINTS,
  fetchPage,
  fetchAll,
  fetchFirst,
  createOne,
  updateOne,
  deleteOne,
  oneRelation,
  manyRelation,
};
