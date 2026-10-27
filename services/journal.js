// Хелперы журнала отправок (Strapi-коллекция zhurnal-otpravkis, один record-массив строк).
const axios = require("axios");
require("dotenv").config();

const URL_STRAPI = process.env.URL_STRAPI;
const LOGIN_STRAPI = process.env.LOGIN_STRAPI;
const PASSWORD_STRAPI = process.env.PASSWORD_STRAPI;

const JOURNAL_URL = `${URL_STRAPI}/api/zhurnal-otpravkis`;
const JOURNAL_MAX_LINES = 2000;

async function getJwt() {
  try {
    const r = await axios.post(
      `${URL_STRAPI}/api/auth/local`,
      { identifier: LOGIN_STRAPI, password: PASSWORD_STRAPI },
      { timeout: 15000 }
    );
    return r?.data?.jwt || null;
  } catch (e) {
    console.warn(
      "[journal] Не получил JWT для Strapi:",
      e?.response?.status || e?.message
    );
    return null;
  }
}

// Номер ТН по GUID (верхнеуровневое поле, фолбэк — поиск в JSON data).
async function fetchTnNumberByGuid(guid, jwt) {
  if (!guid || !URL_STRAPI || !jwt) return null;

  const headers = { Authorization: `Bearer ${jwt}` };
  const tryGet = async (qs) => {
    const r = await axios.get(`${URL_STRAPI}${qs}`, { headers, timeout: 15000 });
    const entry = Array.isArray(r?.data?.data) && r.data.data[0] ? r.data.data[0] : null;
    if (!entry) return null;
    const n = entry.attributes?.number ?? entry.number;
    return n !== undefined && n !== null && String(n).trim() !== "" ? String(n) : null;
  };

  try {
    const byGuid = await tryGet(
      `/api/teh-narusheniyas?filters[guid][$eq]=${encodeURIComponent(guid)}&pagination[pageSize]=1`
    );
    if (byGuid) return byGuid;

    const byJsonContains = await tryGet(
      `/api/teh-narusheniyas?filters[data][$containsi]=${encodeURIComponent(guid)}&pagination[pageSize]=1`
    );
    return byJsonContains;
  } catch (e) {
    console.warn(
      "[journal] Не удалось получить номер ТН из Strapi:",
      e?.response?.status || e?.message
    );
    return null;
  }
}

// Единственный record журнала: { id, documentId, list }.
async function getOrCreateJournalSingle(jwt) {
  if (!URL_STRAPI || !jwt) return null;
  try {
    const r = await axios.get(
      `${JOURNAL_URL}?pagination[page]=1&pagination[pageSize]=1&sort=createdAt:asc`,
      { headers: { Authorization: `Bearer ${jwt}` }, timeout: 15000 }
    );
    const arr = r?.data?.data || [];
    if (arr.length > 0) {
      const item = arr[0];
      const id = item.id;
      const documentId = item.documentId || item.documentID || item.document_id || null;
      const dataField = item.data ?? item.attributes?.data;
      let list = [];

      if (Array.isArray(dataField)) list = dataField.slice();
      else if (typeof dataField === "string") list = [dataField];
      else if (dataField && typeof dataField === "object" && Array.isArray(dataField.lines)) list = dataField.lines.slice();

      return { id, documentId, list };
    }

    const c = await axios.post(
      JOURNAL_URL,
      { data: { data: [] } },
      { headers: { Authorization: `Bearer ${jwt}` }, timeout: 15000 }
    );
    const id = c?.data?.data?.id;
    const documentId = c?.data?.data?.documentId || null;
    return id ? { id, documentId, list: [] } : null;
  } catch (e) {
    console.warn("[journal] Не удалось получить/создать запись журнала:", e?.response?.status || e?.message);
    return null;
  }
}

async function appendToJournalSingle(line, jwt) {
  const rec = await getOrCreateJournalSingle(jwt);
  if (!rec) return;
  const list = rec.list || [];
  list.push(line);
  while (list.length > JOURNAL_MAX_LINES) list.shift();

  const targetId = rec.documentId || rec.id;
  try {
    await axios.put(
      `${JOURNAL_URL}/${targetId}`,
      { data: { data: list } },
      { headers: { Authorization: `Bearer ${jwt}` }, timeout: 20000 }
    );
  } catch (e) {
    if (rec.documentId && rec.id && e?.response?.status === 404) {
      await axios.put(
        `${JOURNAL_URL}/${rec.id}`,
        { data: { data: list } },
        { headers: { Authorization: `Bearer ${jwt}` }, timeout: 20000 }
      );
    } else {
      throw e;
    }
  }
}

// Дата/время МСК в формате журнала: "27.10.2026 15:30:00"
function fmtRu(dt) {
  try {
    const d = dt ? new Date(dt) : new Date();
    const s = d.toLocaleString("ru-RU", {
      timeZone: "Europe/Moscow",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    return s.replace(",", "");
  } catch {
    return "";
  }
}

// Добавляет строку вида: №{num} - {guid} - {дата МСК} - {канал} - {сообщение}
async function appendJournalLine({ num = null, guid = null, target, message = "" }) {
  try {
    const jwt = await getJwt();
    if (!jwt) return false;

    let tnNumber = num;
    if (tnNumber == null && guid) tnNumber = await fetchTnNumberByGuid(guid, jwt);

    const human = fmtRu(new Date());
    const line =
      `№${tnNumber ?? "—"} - ${guid ?? "—"} - ${human} - ${target}` +
      (message ? ` - ${message}` : "");

    await appendToJournalSingle(line, jwt);
    console.log("[journal] запись добавлена:", line);
    return true;
  } catch (e) {
    console.warn("[journal] не удалось добавить запись:", e?.response?.status, e?.message);
    return false;
  }
}

module.exports = {
  getJwt,
  fetchTnNumberByGuid,
  getOrCreateJournalSingle,
  appendToJournalSingle,
  appendJournalLine,
  fmtRu,
};
