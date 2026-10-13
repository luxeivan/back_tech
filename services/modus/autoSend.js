// Автоотправка аварийных ТН в ЕДДС.
// Глобальный флаг хранится в Strapi-коллекции tn-avtootpravkas (singleton-подобная,
// читаем первую запись; boolean-поле status_live).

const axios = require("axios");
const { getJwt } = require("./strapi");

function strapiBase() {
  return String(process.env.URL_STRAPI || "").replace(/\/$/, "");
}

async function getAutoSendState(jwt) {
  const token = jwt || (await getJwt());
  if (!token || !strapiBase()) return { enabled: false, record: null };
  const r = await axios.get(`${strapiBase()}/api/tn-avtootpravkas`, {
    headers: { Authorization: `Bearer ${token}` },
    params: { "pagination[pageSize]": 1, sort: "createdAt:asc" },
    timeout: 15000,
  });
  const record = r?.data?.data?.[0] || null;
  return { enabled: record?.status_live === true, record };
}

async function setAutoSendState(enabled, jwt) {
  const token = jwt || (await getJwt());
  if (!token || !strapiBase()) throw new Error("Strapi не настроен");
  const next = Boolean(enabled);
  const { record } = await getAutoSendState(token);
  if (record) {
    const target = record.documentId || record.id;
    await axios.put(
      `${strapiBase()}/api/tn-avtootpravkas/${target}`,
      { data: { status_live: next } },
      { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
    );
  } else {
    await axios.post(
      `${strapiBase()}/api/tn-avtootpravkas`,
      { data: { status_live: next } },
      { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
    );
  }
  return { enabled: next };
}

module.exports = { getAutoSendState, setAutoSendState };
