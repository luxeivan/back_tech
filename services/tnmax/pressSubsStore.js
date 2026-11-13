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

// Отписывает юзера от округов: disconnect из tn_okrugas (запись юзера остаётся).
async function unsubscribe({ maxUserId, districtIds }) {
  const base = `${process.env.URL_STRAPI}/api/${COLLECTION}`;
  const url =
    `${base}?filters[max_user_id][$eq]=${Number(maxUserId)}` +
    `&pagination[pageSize]=1&fields[0]=documentId`;
  const data = await req("get", url);
  const row = data?.data?.[0];
  if (!row) return { updated: false };
  await req("put", `${base}/${row.documentId}`, {
    data: { tn_okrugas: { disconnect: districtIds } },
  });
  return { updated: true };
}

module.exports = { getDistricts, subscribe, unsubscribe };
