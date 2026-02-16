// Вынесено из routers/modus.js (нулевой рефактор): авторизация и чтение полей из Strapi.

const axios = require("axios");

const JWT_TTL_MS = 5 * 60 * 1000;
let jwtCache = {
  token: "",
  expiresAt: 0,
  inFlight: null,
};

async function getJwt() {
  if (jwtCache.token && Date.now() < jwtCache.expiresAt) {
    return jwtCache.token;
  }
  if (jwtCache.inFlight) {
    return jwtCache.inFlight;
  }

  const loginStrapi = process.env.LOGIN_STRAPI;
  const passwordStrapi = process.env.PASSWORD_STRAPI;
  const urlStrapi = process.env.URL_STRAPI;

  jwtCache.inFlight = (async () => {
    try {
      const res = await axios.post(`${urlStrapi}/api/auth/local`, {
        identifier: loginStrapi,
        password: passwordStrapi,
      });
      const token = res?.data?.jwt || "";
      if (token) {
        jwtCache.token = token;
        jwtCache.expiresAt = Date.now() + JWT_TTL_MS;
        return token;
      }
      return false;
    } catch (error) {
      console.log("Ошибка авторизации в Strapi:", error);
      return false;
    } finally {
      jwtCache.inFlight = null;
    }
  })();

  return jwtCache.inFlight;
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
