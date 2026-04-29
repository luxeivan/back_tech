const express = require("express");
const axios = require("axios");
require("dotenv").config();

const router = express.Router();

const STRAPI_URL = process.env.URL_STRAPI;
const STRAPI_LOGIN = process.env.LOGIN_STRAPI;
const STRAPI_PASSWORD = process.env.PASSWORD_STRAPI;

async function getJwt() {
  const res = await axios.post(`${STRAPI_URL}/api/auth/local`, {
    identifier: STRAPI_LOGIN,
    password: STRAPI_PASSWORD,
  });
  return res.data.jwt;
}

function pickRaw(item) {
  return item?.data?.data ?? item?.data ?? item ?? {};
}

function getStatusName(item, raw) {
  const value = item?.STATUS_NAME || raw?.STATUS_NAME || "";
  return String(value).trim().toLowerCase();
}

function isOpen(item, raw) {
  const value =
    item?.isActive ??
    item?.data?.isActive ??
    raw?.isActive ??
    raw?.data?.isActive;

  return value === true || value === 1 || value === "true";
}

router.get("/", async (req, res) => {
  try {
    const jwt = await getJwt();

    const r = await axios.get(`${STRAPI_URL}/api/teh-narusheniyas`, {
      headers: { Authorization: `Bearer ${jwt}` },
      params: {
        "pagination[page]": 1,
        "pagination[pageSize]": 1000,
        "filters[BASE_TYPE][$eq]": 0,
        sort: "updatedAt:desc",
      },
    });

    const rows = Array.isArray(r?.data?.data) ? r.data.data : [];
    const map = new Map();

    rows.forEach((item) => {
      const raw = pickRaw(item);
      const baseType = Number(item?.BASE_TYPE ?? item?.data?.BASE_TYPE ?? raw?.BASE_TYPE);
      const statusName = getStatusName(item, raw);

      if (baseType !== 0) return;
      if (!(isOpen(item, raw) || statusName === "открыта")) return;

      const name = raw.DISTRICT || raw.SCNAME || item?.dispCenter || "—";
      const count =
        Number(raw.POPULATION_COUNT) ||
        Number(raw.PEOPLE_COUNT) ||
        Number(raw.POPULATION) ||
        0;

      if (count <= 0) return;

      map.set(name, (map.get(name) || 0) + count);
    });

    res.json({
      data: Array.from(map.entries()).map(([name, count]) => ({ name, count })),
      result: 1,
    });
  } catch (e) {
    console.error("[МинЭнерго РФ] Ошибка GET /services/minenergo:", e?.response?.data || e?.message || e);
    res.status(500).json({
      data: [],
      result: 0,
    });
  }
});

module.exports = router;
