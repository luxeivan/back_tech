// Хранилище подписок: Strapi-коллекция tn-podpischiki-maxes (relation tn_okrugas → tn-okruga).
const axios = require("axios");
const { getJwt } = require("../modus/strapi");

const COLLECTION = "tn-podpischiki-maxes";

// Авторизованный запрос к Strapi (метод + URL + тело), возвращает data ответа.
async function req(method, url, body) {
  const jwt = await getJwt();
  if (!jwt) throw new Error("Нет JWT для Strapi");
  const { data } = await axios({
    method,
    url,
    data: body,
    headers: { Authorization: `Bearer ${jwt}` },
    timeout: 15000,
  });
  return data;
}

// Имена подписанных округов юзера ([] — если записи ещё нет).
async function getDistricts(maxUserId) {
  const id = Number(maxUserId);
  if (!Number.isFinite(id) || id <= 0) return [];
  const url =
    `${process.env.URL_STRAPI}/api/${COLLECTION}` +
    `?filters[max_user_id][$eq]=${id}` +
    `&pagination[pageSize]=1&fields[0]=documentId` +
    `&populate[tn_okrugas][fields][0]=name`;
  const data = await req("get", url);
  const rel = data?.data?.[0]?.tn_okrugas;
  const list = Array.isArray(rel) ? rel : Array.isArray(rel?.data) ? rel.data : [];
  return list.map((r) => r?.name).filter(Boolean);
}

// Подписывает юзера на округа: создаёт запись или дописывает connect к существующей.
async function subscribe({ maxUserId, username, firstName, lastName, districtIds }) {
  const base = `${process.env.URL_STRAPI}/api/${COLLECTION}`;
  const url =
    `${base}?filters[max_user_id][$eq]=${Number(maxUserId)}` +
    `&pagination[pageSize]=1&fields[0]=documentId`;
  const data = await req("get", url);
  const row = data?.data?.[0];
  const profile = {
    username: username || "",
    first_name: firstName || "",
    last_name: lastName || "",
    is_active: true,
  };

  if (row) {
    await req("put", `${base}/${row.documentId}`, {
      data: { ...profile, tn_okrugas: { connect: districtIds } },
    });
    return { created: false };
  }

  await req("post", base, {
    data: { max_user_id: Number(maxUserId), ...profile, tn_okrugas: districtIds },
  });
  return { created: true };
}

// Отписывает юзера от округов: полная замена массива (запись юзера остаётся).
// Ловушка Strapi: {disconnect:[...]} отдаёт 200 и обновляет updatedAt, но ссылки НЕ удаляет
// (проверено живьём 16.11) — читаем текущие id и пишем массив без отписываемых.
async function unsubscribe({ maxUserId, districtIds }) {
  const base = `${process.env.URL_STRAPI}/api/${COLLECTION}`;
  const url =
    `${base}?filters[max_user_id][$eq]=${Number(maxUserId)}` +
    `&pagination[pageSize]=1&fields[0]=documentId` +
    `&populate[tn_okrugas][fields][0]=name`;
  const data = await req("get", url);
  const row = data?.data?.[0];
  if (!row) return { updated: false };
  const rel = row.tn_okrugas;
  const list = Array.isArray(rel) ? rel : Array.isArray(rel?.data) ? rel.data : [];
  const remove = new Set((districtIds || []).map(Number));
  const next = list
    .map((r) => Number(r?.id))
    .filter((id) => Number.isFinite(id) && id > 0 && !remove.has(id));
  await req("put", `${base}/${row.documentId}`, {
    data: { tn_okrugas: next },
  });
  return { updated: true };
}

// Состояние подписки: флаг subscribe_all + текущие id округов (+ documentId для записи).
async function getSubscriptionState(maxUserId) {
  const id = Number(maxUserId);
  if (!Number.isFinite(id) || id <= 0) {
    return { exists: false, subscribe_all: false, districtIds: [], documentId: null };
  }
  const url =
    `${process.env.URL_STRAPI}/api/${COLLECTION}` +
    `?filters[max_user_id][$eq]=${id}` +
    `&pagination[pageSize]=1&fields[0]=documentId&fields[1]=subscribe_all` +
    `&populate[tn_okrugas][fields][0]=id`;
  const data = await req("get", url);
  const row = data?.data?.[0];
  if (!row) return { exists: false, subscribe_all: false, districtIds: [], documentId: null };
  const rel = Array.isArray(row.tn_okrugas) ? row.tn_okrugas : [];
  const districtIds = rel
    .map((r) => Number(r?.id))
    .filter((n) => Number.isFinite(n) && n > 0);
  return {
    exists: true,
    subscribe_all: row.subscribe_all === true,
    districtIds,
    documentId: row.documentId || null,
  };
}

// Ленивая синхронизация subscribe_all: дописывает недостающие округа, не трогая профиль.
async function connectDistricts(maxUserId, districtIds) {
  const st = await getSubscriptionState(maxUserId);
  if (!st.exists || !st.documentId) return { updated: false, added: 0 };
  const have = new Set(st.districtIds);
  const add = (districtIds || [])
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0 && !have.has(n));
  if (!add.length) return { updated: false, added: 0 };
  await req("put", `${process.env.URL_STRAPI}/api/${COLLECTION}/${st.documentId}`, {
    data: { tn_okrugas: { connect: add } },
  });
  return { updated: true, added: add.length };
}

// Записывает subscribe_all (если изменился) — флаг производный: «покрыты все активные округа».
async function setSubscribeAll(maxUserId, value) {
  const st = await getSubscriptionState(maxUserId);
  if (!st.exists || !st.documentId) return { updated: false };
  const next = Boolean(value);
  if (st.subscribe_all === next) return { updated: false, unchanged: true };
  await req("put", `${process.env.URL_STRAPI}/api/${COLLECTION}/${st.documentId}`, {
    data: { subscribe_all: next },
  });
  return { updated: true, value: next };
}

// Все подписчики с их округами — для оповещений (до 100 записей).
async function getAllSubscribers() {
  const url =
    `${process.env.URL_STRAPI}/api/${COLLECTION}` +
    `?pagination[pageSize]=100` +
    `&fields[0]=max_user_id&fields[1]=max_chat_id&fields[2]=is_active&fields[3]=subscribe_all` +
    `&populate[tn_okrugas][fields][0]=name`;
  const data = await req("get", url);
  return (data?.data || []).map((row) => {
    const rel = row.tn_okrugas;
    const list = Array.isArray(rel) ? rel : Array.isArray(rel?.data) ? rel.data : [];
    return {
      maxUserId: row.max_user_id,
      maxChatId: row.max_chat_id,
      isActive: row.is_active !== false,
      subscribeAll: row.subscribe_all === true,
      districts: list.map((r) => r?.name).filter(Boolean),
    };
  });
}

// Запоминает chat_id и время взаимодействия, если запись подписчика уже есть.
async function touchSubscriber(maxUserId, chatId) {
  const id = Number(maxUserId);
  const chat = Number(chatId);
  if (!Number.isFinite(id) || id <= 0 || !Number.isFinite(chat) || chat <= 0) {
    return { updated: false };
  }
  const base = `${process.env.URL_STRAPI}/api/${COLLECTION}`;
  const url = `${base}?filters[max_user_id][$eq]=${id}&pagination[pageSize]=1&fields[0]=documentId`;
  const data = await req("get", url);
  const row = data?.data?.[0];
  if (!row) return { updated: false };
  await req("put", `${base}/${row.documentId}`, {
    data: { max_chat_id: chat, last_interaction_at: new Date().toISOString() },
  });
  return { updated: true };
}

// Дописывает запись в history JSON подписчика (нет записи — no-op), хранит последние 200.
async function appendHistory(maxUserId, entry) {
  const id = Number(maxUserId);
  if (!Number.isFinite(id) || id <= 0 || !entry) return { saved: false };
  const base = `${process.env.URL_STRAPI}/api/${COLLECTION}`;
  const url =
    `${base}?filters[max_user_id][$eq]=${id}` +
    `&pagination[pageSize]=1&fields[0]=documentId&fields[1]=history`;
  const data = await req("get", url);
  const row = data?.data?.[0];
  if (!row) return { saved: false };
  const hist = Array.isArray(row.history) ? row.history : [];
  hist.push({ at: new Date().toISOString(), ...entry });
  await req("put", `${base}/${row.documentId}`, {
    data: { history: hist.slice(-200) },
  });
  return { saved: true };
}

module.exports = {
  getDistricts,
  subscribe,
  unsubscribe,
  getSubscriptionState,
  connectDistricts,
  setSubscribeAll,
  getAllSubscribers,
  touchSubscriber,
  appendHistory,
};
