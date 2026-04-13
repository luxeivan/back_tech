const express = require("express");
const axios = require("axios");
const {
  logAuditFromReq,
  getAuditLoggerState,
  inferIp,
  readAuditEvents,
  readAuditUsers,
  checkAuditStore,
} = require("../services/auditLogger");

const router = express.Router();
const authCache = new Map();
const rateLimitMap = new Map();

function env(name, fallback = "") {
  const v = process.env[name];
  return v == null || v === "" ? fallback : String(v);
}

function envInt(name, fallback, { min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY } = {}) {
  const raw = Number(env(name, String(fallback)));
  const normalized = Number.isFinite(raw) ? Math.trunc(raw) : fallback;
  return Math.min(max, Math.max(min, normalized));
}

function envBool(name, fallback = false) {
  const raw = env(name, fallback ? "1" : "0").trim().toLowerCase();
  return ["1", "true", "yes", "y", "on"].includes(raw);
}

function authIsRequired() {
  return envBool("AUDIT_REQUIRE_AUTH", true);
}

function getBearerFromHeader(req) {
  const h = String(req.get("authorization") || "").trim();
  if (!h) return "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : "";
}

function getAnyToken(req, body) {
  const bearer = getBearerFromHeader(req);
  if (bearer) return bearer;
  const fromHeader = String(req.get("x-audit-token") || "").trim();
  if (fromHeader) return fromHeader;
  return String(body?.auth_token || "").trim();
}

function cleanupAuthCache() {
  const now = Date.now();
  for (const [token, item] of authCache.entries()) {
    if (!item || item.expiresAt <= now) authCache.delete(token);
  }
}

async function validateTokenWithStrapi(token) {
  const strapi = env("URL_STRAPI", "").replace(/\/$/, "");
  if (!strapi) return { ok: false, reason: "strapi_url_not_configured" };

  const now = Date.now();
  const cached = authCache.get(token);
  if (cached && cached.expiresAt > now) {
    return { ok: cached.ok, reason: "cached", user: cached.user || null };
  }

  try {
    const resp = await axios.get(`${strapi}/api/users/me`, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: envInt("AUDIT_AUTH_TIMEOUT_MS", 2500, { min: 500, max: 10000 }),
    });
    const user = resp?.data && typeof resp.data === "object" ? resp.data : null;
    authCache.set(token, { ok: true, user, expiresAt: now + 5 * 60 * 1000 });
    return { ok: true, reason: "validated", user };
  } catch {
    authCache.set(token, { ok: false, user: null, expiresAt: now + 30 * 1000 });
    return { ok: false, reason: "invalid_token" };
  } finally {
    cleanupAuthCache();
  }
}

function isPreviewUser(user) {
  return String(user?.view_role || "").trim().toLowerCase() === "preview";
}

async function resolveAuthUser(req, body = {}, { requirePreview = false } = {}) {
  if (!authIsRequired()) {
    if (requirePreview) {
      return {
        ok: false,
        status: 503,
        payload: {
          ok: false,
          message: "Audit preview endpoints require AUDIT_REQUIRE_AUTH=1",
        },
      };
    }
    return { ok: true, user: null };
  }

  const token = getAnyToken(req, body);
  if (!token) {
    return {
      ok: false,
      status: 401,
      payload: { ok: false, message: "Audit auth token required" },
    };
  }

  const auth = await validateTokenWithStrapi(token);
  if (!auth.ok) {
    return {
      ok: false,
      status: 401,
      payload: { ok: false, message: "Audit auth failed" },
    };
  }

  if (requirePreview && !isPreviewUser(auth.user)) {
    return {
      ok: false,
      status: 403,
      payload: { ok: false, message: "Access denied: preview role required" },
    };
  }

  return { ok: true, user: auth.user || null, token };
}

function cleanupRateLimitMap() {
  const now = Date.now();
  const windowMs = envInt("AUDIT_RATE_WINDOW_MS", 60_000, { min: 1000, max: 600000 });
  for (const [key, item] of rateLimitMap.entries()) {
    if (!item || now - item.windowStart > windowMs * 3) rateLimitMap.delete(key);
  }
}

function checkRateLimit(ip) {
  const now = Date.now();
  const max = envInt("AUDIT_RATE_MAX", 120, { min: 1, max: 10000 });
  const windowMs = envInt("AUDIT_RATE_WINDOW_MS", 60_000, { min: 1000, max: 600000 });

  const key = ip || "unknown";
  const prev = rateLimitMap.get(key);

  if (!prev || now - prev.windowStart >= windowMs) {
    rateLimitMap.set(key, { windowStart: now, count: 1 });
    return { ok: true, left: Math.max(0, max - 1), retryAfterSec: 0 };
  }

  prev.count += 1;
  rateLimitMap.set(key, prev);

  if (prev.count > max) {
    const retryAfterSec = Math.max(1, Math.ceil((windowMs - (now - prev.windowStart)) / 1000));
    return { ok: false, left: 0, retryAfterSec };
  }
  cleanupRateLimitMap();
  return { ok: true, left: Math.max(0, max - prev.count), retryAfterSec: 0 };
}

router.get("/health", async (req, res) => {
  const auth = await resolveAuthUser(req, {}, { requirePreview: true });
  if (!auth.ok) return res.status(auth.status).json(auth.payload);
  const store = await checkAuditStore();
  return res.json({
    ok: store.ok,
    auth_required: authIsRequired(),
    actor: {
      username: auth.user?.username || null,
      view_role: auth.user?.view_role || null,
    },
    rate_limit: {
      max: envInt("AUDIT_RATE_MAX", 120, { min: 1, max: 10000 }),
      window_ms: envInt("AUDIT_RATE_WINDOW_MS", 60_000, { min: 1000, max: 600000 }),
    },
    logger: getAuditLoggerState(),
    store,
  });
});

router.get("/events", async (req, res) => {
  try {
    const auth = await resolveAuthUser(req, {}, { requirePreview: true });
    if (!auth.ok) return res.status(auth.status).json(auth.payload);

    const limit = envInt("AUDIT_UI_DEFAULT_LIMIT", 200, { min: 1, max: 1000 });
    const requestedLimit = Number(req.query.limit);
    const safeLimit =
      Number.isFinite(requestedLimit) && requestedLimit > 0
        ? Math.min(1000, Math.trunc(requestedLimit))
        : limit;

    const action = String(req.query.action || "").trim();
    const username = String(req.query.username || "").trim();
    const page = String(req.query.page || "").trim();
    const search = String(req.query.search || "").trim();
    const from = String(req.query.from || "").trim();
    const to = String(req.query.to || "").trim();
    const statusEvent = String(req.query.statusEvent || "").trim();
    const tnType = String(req.query.tnType || "").trim();
    const tnValue = String(req.query.tnValue || "").trim();

    const startedAt = Date.now();
    try {
      const parsed = await readAuditEvents({
        limit: safeLimit,
        action,
        username,
        page,
        search,
        from,
        to,
        statusEvent,
        tnType,
        tnValue,
      });
      const data = Array.isArray(parsed?.data) ? parsed.data : [];

      return res.json({
        ok: true,
        data,
        meta: {
          count: data.length,
          limit: safeLimit,
          total: parsed?.meta?.total ?? data.length,
          page: parsed?.meta?.page ?? 1,
          pageSize: parsed?.meta?.pageSize ?? safeLimit,
          pageCount: parsed?.meta?.pageCount ?? 1,
          took_ms: Date.now() - startedAt,
          query: {
            action: action || null,
            username: username || null,
            page: page || null,
            search: search || null,
            from: from || null,
            to: to || null,
            statusEvent: statusEvent || null,
            tnType: tnType || null,
            tnValue: tnValue || null,
          },
        },
      });
    } catch (e) {
      const raw = String(
        e?.response?.data?.error?.message || e?.response?.data || e?.message || "unknown error"
      );
      const msg = /ECONNREFUSED|connect|ENOTFOUND|timeout/i.test(raw)
        ? "Strapi недоступен. Проверь URL_STRAPI и учетку LOGIN_STRAPI/PASSWORD_STRAPI."
        : "Ошибка чтения логов из Strapi";

      return res.json({
        ok: false,
        data: [],
        message: msg,
        error: raw.slice(0, 500),
        meta: {
          count: 0,
          limit: safeLimit,
          took_ms: Date.now() - startedAt,
          query: {
            action: action || null,
            username: username || null,
            page: page || null,
            search: search || null,
            from: from || null,
            to: to || null,
            statusEvent: statusEvent || null,
            tnType: tnType || null,
            tnValue: tnValue || null,
          },
        },
      });
    }
  } catch (e) {
    const status = e?.response?.status || 500;
    const raw = String(e?.response?.data || e?.message || "unknown error");
    return res.status(status).json({
      ok: false,
      message: "Не удалось получить аудит-логи",
      error: raw.slice(0, 500),
    });
  }
});

router.get("/users", async (req, res) => {
  try {
    const auth = await resolveAuthUser(req, {}, { requirePreview: true });
    if (!auth.ok) return res.status(auth.status).json(auth.payload);

    const query = String(req.query.query || "").trim();
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const from = String(req.query.from || "").trim();
    const to = String(req.query.to || "").trim();

    const parsed = await readAuditUsers({ query, limit, from, to });
    const data = Array.isArray(parsed?.data) ? parsed.data : [];

    return res.json({
      ok: true,
      data,
      meta: {
        count: data.length,
        limit,
      },
    });
  } catch (e) {
    const status = e?.response?.status || 500;
    const raw = String(
      e?.response?.data?.error?.message || e?.response?.data || e?.message || "unknown error"
    );
    return res.status(status).json({
      ok: false,
      message: "Не удалось получить список пользователей журнала",
      error: raw.slice(0, 500),
    });
  }
});

router.post("/event", async (req, res) => {
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const ip = inferIp(req) || "unknown";
    const maxBytes = envInt("AUDIT_MAX_BODY_BYTES", 64 * 1024, {
      min: 1024,
      max: 5 * 1024 * 1024,
    });
    const contentLen = Number(req.get("content-length") || 0);
    if (contentLen > maxBytes) {
      return res.status(413).json({
        ok: false,
        message: "Payload too large for audit endpoint",
      });
    }

    const rl = checkRateLimit(ip);
    if (!rl.ok) {
      res.set("Retry-After", String(rl.retryAfterSec));
      return res.status(429).json({
        ok: false,
        message: "Too many audit events",
      });
    }

    const auth = await resolveAuthUser(req, body);
    if (!auth.ok) return res.status(auth.status).json(auth.payload);

    await logAuditFromReq(req, {
      username: body.username,
      role: body.role,
      page: body.page,
      action: body.action,
      entity: body.entity,
      entity_id: body.entity_id,
      details: body.details,
    });
    return res.json({ ok: true });
  } catch (e) {
    console.warn("[audit] write failed:", e?.message || e);
    return res.status(200).json({ ok: false, skipped: true });
  }
});

module.exports = router;
