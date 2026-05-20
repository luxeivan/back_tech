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
  return item?.data?.data ?? item?.data ?? item?.attributes?.data?.data ?? item?.attributes?.data ?? {};
}

function isOpen(item, raw) {
  const active =
    item?.isActive ??
    item?.attributes?.isActive ??
    item?.data?.isActive ??
    raw?.isActive;
  if (active === true || active === 1 || active === "true") return true;

  const status = String(item?.STATUS_NAME || raw?.STATUS_NAME || "").trim().toLowerCase();
  return status === "открыта" || status === "открыто";
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return "";
}

function durationHours(raw, startIso) {
  const explicit = Number(raw?.F81_090);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;

  const endIso = firstNonEmpty(raw?.F81_290_RECOVERYDATETIME, raw?.F81_070_RESTOR_SUPPLAYDATETIME);
  const start = startIso ? new Date(startIso).getTime() : NaN;
  const end = endIso ? new Date(endIso).getTime() : NaN;
  if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
    return Math.ceil((end - start) / 3_600_000);
  }

  return "";
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
        "filters[isActive][$eq]": true,
        "sort[0]": "createDateTime:DESC",
      },
    });

    const rows = Array.isArray(r?.data?.data) ? r.data.data : [];
    const data = rows.reduce((acc, item) => {
      const raw = pickRaw(item);
      if (!isOpen(item, raw)) return acc;

      const startIso = firstNonEmpty(raw?.F81_060_EVENTDATETIME, raw?.STARTDATETIME, item?.createDateTime);

      acc.push({
        id: item?.id,
        attributes: {
          go: firstNonEmpty(raw?.DISTRICT, raw?.SCNAME, item?.dispCenter),
          addressDisconnected: firstNonEmpty(raw?.ADDRESS_LIST, item?.addressList, raw?.HOUSE_LIST),
          dateDisconnected: startIso,
          durationSolution: durationHours(raw, startIso),
          disconnectedSubscribers: Number(raw?.POINTALL) || 0,
          guid: firstNonEmpty(raw?.VIOLATION_GUID_STR, item?.guid),
        },
      });

      return acc;
    }, []);

    res.json({
      data,
      meta: {
        source: "jtn",
        total: data.length,
      },
    });
  } catch (e) {
    console.error("[siteEmergencyOutages] Ошибка:", e?.response?.data || e?.message || e);
    res.status(500).json({
      data: [],
      meta: {
        source: "jtn",
        total: 0,
        error: "Не удалось получить аварийные отключения",
      },
    });
  }
});

module.exports = router;
