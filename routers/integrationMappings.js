const express = require("express");
const axios = require("axios");
const { getJwt } = require("../services/modus/strapi");

require("dotenv").config();

const router = express.Router();

const URL_STRAPI = String(process.env.URL_STRAPI || "").replace(/\/$/, "");
const STRAPI_API_TOKEN = String(
  process.env.STRAPI_API_TOKEN || process.env.STRAPI_INTEGRATION_MAPPINGS_TOKEN || ""
).trim();

function normalizeRuleItem(item) {
  const src = item?.attributes || item || {};
  return {
    id: item?.id || src?.id || null,
    documentId: item?.documentId || src?.documentId || null,
    title: src?.title || "",
    integration: src?.integration || "",
    mappingType: src?.mappingType || "",
    sourceField: src?.sourceField || "",
    sourceValue: src?.sourceValue || "",
    matchType: src?.matchType || "exact",
    targetValue: src?.targetValue || "",
    priority: Number(src?.priority || 100),
    isActive: src?.isActive !== false,
    comment: src?.comment || "",
  };
}

async function fetchMappingsPage(authHeader, page = 1, pageSize = 200) {
  const r = await axios.get(`${URL_STRAPI}/api/integration-mappings`, {
    headers: { Authorization: authHeader },
    params: {
      "filters[integration][$eq]": "edds_new",
      "filters[isActive][$eq]": true,
      "pagination[page]": page,
      "pagination[pageSize]": pageSize,
      "sort[0]": "priority:asc",
      "sort[1]": "id:asc",
    },
    timeout: 20000,
  });

  const rows = Array.isArray(r?.data?.data) ? r.data.data : [];
  const pageCount = Number(r?.data?.meta?.pagination?.pageCount || 1);
  return { rows, pageCount };
}

async function fetchAllMappings(authHeader) {
  const out = [];
  let page = 1;
  let pageCount = 1;
  while (page <= pageCount) {
    const pack = await fetchMappingsPage(authHeader, page);
    pack.rows.forEach((item) => out.push(normalizeRuleItem(item)));
    pageCount = pack.pageCount;
    page += 1;
  }
  return out;
}

async function resolveStrapiAuthHeader(userAuthHeader) {
  if (STRAPI_API_TOKEN) {
    return `Bearer ${STRAPI_API_TOKEN}`;
  }
  const serviceJwt = await getJwt();
  if (serviceJwt) {
    return `Bearer ${serviceJwt}`;
  }
  return userAuthHeader;
}

router.get("/edds-new", async (req, res) => {
  try {
    const authHeader = String(req.headers.authorization || "").trim();
    if (!authHeader) {
      return res.status(403).json({ ok: false, error: "Нет токена авторизации" });
    }

    if (!URL_STRAPI) {
      return res.status(500).json({ ok: false, error: "URL_STRAPI не задан" });
    }

    await axios.get(`${URL_STRAPI}/api/users/me`, {
      headers: { Authorization: authHeader },
      timeout: 15000,
    });

    const strapiAuthHeader = await resolveStrapiAuthHeader(authHeader);
    const rules = await fetchAllMappings(strapiAuthHeader);

    const mappings = {
      district_fias: rules.filter((r) => r.mappingType === "district_fias"),
      reason_code: rules.filter((r) => r.mappingType === "reason_code"),
      equipment_type: rules.filter((r) => r.mappingType === "equipment_type"),
    };

    return res.json({
      ok: true,
      integration: "edds_new",
      total: rules.length,
      mappings,
    });
  } catch (e) {
    const status = e?.response?.status || 500;
    const msg = e?.response?.data?.error?.message || e?.response?.data?.error || e?.message;
    return res.status(status).json({ ok: false, error: msg || "Ошибка чтения маппингов" });
  }
});

module.exports = router;
