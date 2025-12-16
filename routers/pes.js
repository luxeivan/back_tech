const express = require("express");
const axios = require("axios");

const router = express.Router();

// ⚠️ временно хардкодим, потом вынесем в env / vault
const T3_BASE = process.env.T3_BASE || "https://mon.t3group.ru";
const T3_USER = process.env.T3_USER || "S-070.МинэнергоМО-ПЭС";
const T3_PSWD = process.env.T3_PSWD || "3u8Z_0jR";

// простой in-memory кеш
let tokenCache = {
  token: null,
  expiresAt: 0,
};

async function login() {
  // ⚠️ ВАЖНО:
  // T3 ожидает server отдельно, а user БЕЗ префикса S-XXX.
  const server = T3_USER.split(".")[0]; // S-070
  const username = T3_USER.split(".").slice(1).join("."); // МинэнергоМО-ПЭС

  const url = `${T3_BASE}/rest/mon/login`;

  const resp = await axios.post(
    url,
    null,
    {
      params: {
        server,
        user: username,
        pswd: T3_PSWD,
      },
      timeout: 10000,
    }
  );

  const data = resp.data;

  // ⚠️ формат может быть token | jwt | {token, expires}
  const token = data.token || data.jwt || data;

  // кладём на 10 минут (без фанатизма)
  tokenCache.token = token;
  tokenCache.expiresAt = Date.now() + 10 * 60 * 1000;

  return token;
}

async function getToken() {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt) {
    return tokenCache.token;
  }
  return login();
}

/**
 * GET /services/pes/vehicles
 */
router.get("/vehicles", async (req, res) => {
  try {
    const token = await getToken();
    const url = `${T3_BASE}/rest/mon/vehicles?token=${encodeURIComponent(
      token
    )}`;

    const resp = await axios.get(url, { timeout: 10000 });
    const data = resp.data;

    // минимальная нормализация под фронт
    const vehicles = Array.isArray(data)
      ? data.map((v) => ({
          id: v.id,
          name: v.name,
          lat: v.lat,
          lon: v.lon,
          speed: v.speed,
          time: v.time,
          model: v.model,
          caption: v.caption,
        }))
      : [];

    res.json({
      source: "t3group",
      count: vehicles.length,
      vehicles,
    });
  } catch (e) {
    console.error("❌ PES vehicles error:", e);
    res.status(500).json({ error: "PES service error" });
  }
});

module.exports = router;
