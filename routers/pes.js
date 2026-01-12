const express = require("express");
const axios = require("axios");

const router = express.Router();

// ⚠️ временно хардкодим, потом вынесем в env / vault
const DEFAULT_T3_BASE = "https://mon.t3group.ru";
const DEFAULT_T3_USER = "S-070.МинэнергоМО-ПЭС";
const DEFAULT_T3_PSWD = "3u8Z_0jR";

function env(name, fallback = null) {
  const v = process.env[name];
  return v === undefined || v === null || v === "" ? fallback : v;
}

function getT3Base() {
  return env("T3_BASE", DEFAULT_T3_BASE);
}

function getT3User() {
  return env("T3_USER", DEFAULT_T3_USER);
}

function getT3Password() {
  return env("T3_PSWD", DEFAULT_T3_PSWD);
}

function parseJwtExpMs(token) {
  try {
    // token can be like "$<jwt>" or "<jwt>"; we only parse pure jwt
    const t = String(token || "").trim().replace(/^\$/,"" );
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

function getT3TokenVariants() {
  // token sometimes comes with leading '$' in emails.
  let t = env("T3_TOKEN", null);
  if (!t) return [];
  t = String(t).trim();

  // strip wrapping quotes
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'"))
  ) {
    t = t.slice(1, -1).trim();
  }

  const withDollar = t.startsWith("$") ? t : `$${t}`;
  const withoutDollar = t.startsWith("$") ? t.slice(1) : t;

  // unique, non-empty
  return Array.from(new Set([t, withDollar, withoutDollar].map((x) => String(x || "").trim()).filter(Boolean)));
}

function getT3Token() {
  // backward compatibility: first variant if exists
  const variants = getT3TokenVariants();
  return variants.length ? variants[0] : null;
}

function getT3ServerVariants() {
  // T3_USER looks like: S-070.МинэнергоМО-ПЭС
  const t3User = getT3User();
  const rawServer = t3User.split(".")[0] || ""; // e.g. S-070

  // Some T3 deployments use "s070" (no dash, lowercase) instead of "S-070"
  const s1 = rawServer;
  const s2 = rawServer.toLowerCase().replace(/-/g, ""); // S-070 -> s070
  const s3 = rawServer.replace(/-/g, ""); // S-070 -> S070

  // allow explicit override
  const override = env("T3_SERVER", "").trim();

  return Array.from(new Set([override, s1, s2, s3].filter(Boolean)));
}

async function login() {
  const tokenVariants = getT3TokenVariants();
  if (tokenVariants.length) {
    // Используем токен из env, если он есть (без /login)
    // Кешируем до exp, если это JWT; иначе на 10 минут.
    const expMs = parseJwtExpMs(tokenVariants[0]);
    tokenCache.token = tokenVariants[0];
    tokenCache.expiresAt = expMs ? Math.min(expMs - 30_000, Date.now() + 10 * 60 * 1000) : Date.now() + 10 * 60 * 1000;
    return tokenVariants[0];
  }

  // ⚠️ ВАЖНО:
  // T3 ожидает server отдельно, а user БЕЗ префикса S-XXX.
  const t3User = getT3User();
  const username = t3User.split(".").slice(1).join("."); // МинэнергоМО-ПЭС
  const url = `${getT3Base()}/rest/mon/login`;

  const servers = getT3ServerVariants();
  let lastErr;

  for (const server of servers) {
    try {
      const resp = await axios.post(url, null, {
        params: {
          server,
          user: username,
          pswd: getT3Password(),
        },
        timeout: 10000,
      });

      const data = resp.data;
      // ⚠️ формат может быть token | jwt | {token, expires}
      const token = data.token || data.jwt || data;

      tokenCache.token = token;
      tokenCache.expiresAt = Date.now() + 10 * 60 * 1000;
      return token;
    } catch (e) {
      lastErr = e;
      continue;
    }
  }

  throw lastErr;
}

// простой in-memory кеш
let tokenCache = {
  token: null,
  expiresAt: 0,
};

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
    const base = getT3Base();

    const t3User = getT3User();
    const username = t3User.split(".").slice(1).join(".");
    const servers = getT3ServerVariants();
    const tokenVariants = Array.from(new Set([token, ...getT3TokenVariants()].filter(Boolean)));

    const url = `${base}/rest/mon/vehicles`;

    const attempts = [];

    for (const srv of servers) {
      for (const tk of tokenVariants) {
        // 1) JWT как Bearer
        attempts.push(() =>
          axios.get(url, {
            timeout: 10000,
            headers: { Authorization: `Bearer ${tk}` },
            params: { server: srv, user: username },
          })
        );

        // 2) Иногда ожидают Authorization: JWT <token>
        attempts.push(() =>
          axios.get(url, {
            timeout: 10000,
            headers: { Authorization: `JWT ${tk}` },
            params: { server: srv, user: username },
          })
        );

        // 3) query param token
        attempts.push(() =>
          axios.get(url, {
            timeout: 10000,
            params: { token: tk, server: srv, user: username },
          })
        );

        // 4) query param jwt
        attempts.push(() =>
          axios.get(url, {
            timeout: 10000,
            params: { jwt: tk, server: srv, user: username },
          })
        );

        // 5) header X-Auth-Token
        attempts.push(() =>
          axios.get(url, {
            timeout: 10000,
            headers: { "X-Auth-Token": tk },
            params: { server: srv, user: username },
          })
        );

        // 6) header token
        attempts.push(() =>
          axios.get(url, {
            timeout: 10000,
            headers: { token: tk },
            params: { server: srv, user: username },
          })
        );

        // 7) самый старый вариант: token в query вручную
        attempts.push(() =>
          axios.get(
            `${url}?token=${encodeURIComponent(tk)}&server=${encodeURIComponent(srv)}&user=${encodeURIComponent(username)}`,
            { timeout: 10000 }
          )
        );
      }
    }

    let resp;
    let lastErr;

    for (let i = 0; i < attempts.length; i++) {
      try {
        resp = await attempts[i]();
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        const status = err?.response?.status;

        // Для отладки: покажем, что именно ответил T3 на попытку.
        // (не логируем токен целиком)
        const body = err?.response?.data;
        if (status) {
          console.warn(`PES vehicles attempt #${i + 1} failed: ${status}`, typeof body === "string" ? body : "");
        }

        // если это «не авторизован/плохой формат», пробуем следующий формат
        if (status === 401 || status === 403 || status === 400 || status === 500) {
          continue;
        }

        // любые другие ошибки (сеть/таймаут/днс) — сразу наверх
        throw err;
      }
    }

    if (!resp) {
      throw lastErr;
    }

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
    console.error("❌ PES vehicles error:", {
      message: e?.message,
      code: e?.code,
      status: e?.response?.status,
      t3_body: e?.response?.data,
      t3_url: e?.config?.url,
      t3_headers: e?.response?.headers,
    });
    res.status(500).json({ error: "PES service error" });
  }
});

module.exports = router;
