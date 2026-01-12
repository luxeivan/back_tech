const express = require("express");
const axios = require("axios");

const router = express.Router();

function env(name, fallback = null) {
  const v = process.env[name];
  return v === undefined || v === null || v === "" ? fallback : v;
}

function stripWrappingQuotes(s) {
  const t = String(s || "").trim();
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'"))
  ) {
    return t.slice(1, -1).trim();
  }
  return t;
}

function parseJwtExpMs(token) {
  try {
    const t = stripWrappingQuotes(token).replace(/^\$/, "");
    const parts = t.split(".");
    if (parts.length < 2) return 0;
    const payloadB64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const pad = "=".repeat((4 - (payloadB64.length % 4)) % 4);
    const json = Buffer.from(payloadB64 + pad, "base64").toString("utf8");
    const payload = JSON.parse(json);
    if (!payload || !payload.exp) return 0;
    return Number(payload.exp) * 1000;
  } catch (_) {
    return 0;
  }
}

function getT3Base() {
  return env("T3_BASE", "https://mon.t3group.ru");
}

function getT3UserRaw() {
  return env("T3_USER", "");
}

function splitT3User(t3UserRaw) {
  const raw = String(t3UserRaw || "").trim();
  const [serverPart, ...rest] = raw.split(".");
  const username = rest.join(".");
  return { serverPart: serverPart || "", username };
}

function uniq(arr) {
  return Array.from(new Set(arr.filter(Boolean)));
}

function getServerVariants(serverPart) {
  const s1 = String(serverPart || "").trim();
  const s2 = s1.replace(/-/g, "");
  const s3 = s2.toLowerCase();
  const override = String(env("T3_SERVER", "")).trim();
  return uniq([override, s1, s2, s3]);
}

function getTokenVariants() {
  const raw = env("T3_TOKEN", "");
  if (!raw) return [];
  const t = stripWrappingQuotes(raw);
  const withDollar = t.startsWith("$") ? t : `$${t}`;
  const withoutDollar = t.startsWith("$") ? t.slice(1) : t;
  return uniq([t, withDollar, withoutDollar]);
}

let tokenCache = {
  token: null,
  expiresAt: 0,
};

function getTokenFromEnvCached() {
  const variants = getTokenVariants();
  if (!variants.length) return null;

  const main = variants[0];
  const expMs = parseJwtExpMs(main);

  // cache until exp-30s when possible, otherwise 10 minutes
  tokenCache.token = main;
  tokenCache.expiresAt = expMs
    ? Math.min(expMs - 30_000, Date.now() + 10 * 60 * 1000)
    : Date.now() + 10 * 60 * 1000;

  return main;
}

async function getToken() {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt)
    return tokenCache.token;
  return getTokenFromEnvCached();
}

/**
 * GET /services/pes/vehicles
 */
router.get("/vehicles", async (_req, res) => {
  try {
    const base = getT3Base();
    const token = await getToken();
    if (!token) {
      return res.status(500).json({ error: "T3_TOKEN is not set" });
    }

    const { serverPart, username } = splitT3User(getT3UserRaw());
    if (!serverPart || !username) {
      return res
        .status(500)
        .json({
          error: "T3_USER is not set or invalid (expected S-070.<username>)",
        });
    }

    const url = `${base}/rest/mon/vehicles`;

    const servers = getServerVariants(serverPart);
    const tokens = uniq([token, ...getTokenVariants()]);

    let resp;
    let lastErr;

    for (const srv of servers) {
      for (const tk of tokens) {
        try {
          resp = await axios.get(url, {
            timeout: 10_000,
            headers: { Authorization: `Bearer ${tk}` },
            params: { server: srv, user: username },
          });
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          const status = e?.response?.status;
          if (status === 401 || status === 403 || status === 400) continue;
          // unexpected errors (network/timeouts/etc.)
          throw e;
        }
      }
      if (resp) break;
    }

    if (!resp) throw lastErr;

    const data = resp.data;
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

    res.json({ source: "t3group", count: vehicles.length, vehicles });
  } catch (e) {
    console.error("❌ PES vehicles error:", {
      message: e?.message,
      code: e?.code,
      status: e?.response?.status,
      t3_body: e?.response?.data,
    });
    res.status(500).json({ error: "PES service error" });
  }
});

module.exports = router;
