// Вынесено из routers/modus.js (нулевой рефактор): авторизация и чтение полей из Strapi.

const axios = require("axios");

async function getJwt() {
  const loginStrapi = process.env.LOGIN_STRAPI;
  const passwordStrapi = process.env.PASSWORD_STRAPI;
  const urlStrapi = process.env.URL_STRAPI;

  try {
    const res = await axios.post(`${urlStrapi}/api/auth/local`, {
      identifier: loginStrapi,
      password: passwordStrapi,
    });
    if (res.data) {
      return res.data.jwt;
    } else {
      return false;
    }
  } catch (error) {
    console.log("Ошибка авторизации в Strapi:", error);
    return false;
  }
}

// Достаём description по id (нужно, чтобы на create отдавать на фронт именно то,
// что реально сохранила/нормализовала Strapi).
async function fetchTnDescriptionById(id, jwt) {
  const urlStrapi = process.env.URL_STRAPI;
  if (!id || !jwt) return undefined;
  try {
    const r = await axios.get(`${urlStrapi}/api/teh-narusheniyas/${id}`, {
      headers: { Authorization: `Bearer ${jwt}` },
      params: { "fields[0]": "description" },
      timeout: 15000,
    });
    const d = r?.data?.data;
    const attrs = d?.attributes || d || {};
    return attrs?.description;
  } catch (e) {
    console.warn(
      "[POST] Не удалось получить description из Strapi:",
      e?.response?.status || e?.message
    );
    return undefined;
  }
}

module.exports = { getJwt, fetchTnDescriptionById };

