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

router.get("/", async (req, res) => {
  try {
    const jwt = await getJwt();

    console.log("ℹ️ disconnected: запрашиваем активные ТН из Strapi");

    const r = await axios.get(`${STRAPI_URL}/api/teh-narusheniyas`, {
      headers: { Authorization: `Bearer ${jwt}` },
      params: {
        "pagination[page]": 1,
        "pagination[pageSize]": 1000,
        "filters[isActive][$eq]": true,
      },
    });

    const rows = Array.isArray(r?.data?.data) ? r.data.data : [];

    console.log(`ℹ️ disconnected: найдено ТН = ${rows.length}`);

    const map = new Map();

    rows.forEach((item) => {
      const raw = pickRaw(item);

      const district = raw.DISTRICT || raw.SCNAME || item?.dispCenter || "—";

      const people =
        Number(raw.POPULATION_COUNT) ||
        Number(raw.PEOPLE_COUNT) ||
        Number(raw.POPULATION) ||
        0;

      if (!map.has(district)) {
        map.set(district, 0);
      }
      map.set(district, map.get(district) + people);

      console.log("🧩 ТН:", {
        district,
        people,
        guid: raw.VIOLATION_GUID_STR || item?.guid || item?.id,
      });
    });

    const data = Array.from(map.entries()).map(([name, count]) => ({
      name,
      count,
    }));

    console.log("✅ disconnected: агрегированный результат:", data);

    res.json({
      data,
      result: 1,
    });
  } catch (e) {
    console.error("❌ Ошибка роутера disconnected:", e?.response?.data || e);
    res.status(500).json({
      data: [],
      result: 0,
    });
  }
});

module.exports = router;
