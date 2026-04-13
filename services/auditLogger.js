const axios = require("axios");

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

function isEnabled() {
  return envBool("AUDIT_LOGGER_ENABLED", true);
}

function toStr(v, fallback = "") {
  if (v == null) return fallback;
  const s = String(v).trim();
  return s || fallback;
}

function decodeMaybeUri(v) {
  const s = toStr(v, "");
  if (!s) return s;
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function detailsToString(v) {
  if (v == null) return "";
  const maxChars = envInt("AUDIT_MAX_DETAILS_CHARS", 8000, { min: 256, max: 200000 });
  let str = "";
  if (typeof v === "string") str = v;
  else {
    try {
      str = JSON.stringify(v);
    } catch {
      str = String(v);
    }
  }
  if (str.length <= maxChars) return str;
  return `${str.slice(0, maxChars)}… (${str.length} chars)`;
}

function parseDetailsMaybeJson(v) {
  if (typeof v !== "string") return v;
  const s = v.trim();
  if (!s) return "";
  const looksLikeJson =
    (s.startsWith("{") && s.endsWith("}")) || (s.startsWith("[") && s.endsWith("]"));
  if (!looksLikeJson) return v;
  try {
    return JSON.parse(s);
  } catch {
    return v;
  }
}

function humanAction(action) {
  const map = {
    page_view: "Открыл страницу",
    // page_leave временно отключен, чтобы не засорять журнал.
    page_leave: "Покинул страницу",
    click_dashboard: "Перешел на дашборд",
    click_audit_logging: "Перешел в журнал действий",
    click_reset_filters: "Сбросил фильтры",
    click_ai_analytics: "Открыл AI-аналитику",
    open_send_journal: "Открыл журнал отправки",
    toggle_sound: "Переключил звук",
    tn_field_edit: "Изменил поле ТН",
    tn_description_edit: "Изменил описание ТН",
    tn_resource_edit: "Изменил ресурсные поля ТН",
    send_edds_ok: "Отправил ТН в ЕДДС",
    send_edds_error: "Ошибка отправки в ЕДДС",
    send_mes_ok: "Отправил ТН в МосЭнергоСбыт",
    send_mes_error: "Ошибка отправки в МосЭнергоСбыт",
    send_error: "Ошибка отправки",
    edds_send: "Запрос отправки в ЕДДС",
    mes_upload: "Запрос отправки в МосЭнергоСбыт",
    pes_command: "Команда в модуле ПЭС",
    audit_logs_filter: "Обновил фильтры журнала действий",
  };
  return map[action] || action;
}

const ALLOWED_ACTIONS = new Set([
  "tn_field_edit",
  "tn_description_edit",
  "tn_resource_edit",
  "send_edds_ok",
  "send_edds_error",
  "send_mes_ok",
  "send_mes_error",
  "send_error",
  "edds_send",
  "mes_upload",
]);

function normalizeAction(action) {
  return String(action || "").trim().toLowerCase();
}

function isLoggingPagePath(page) {
  return String(page || "").trim().toLowerCase() === "/logging";
}

function isAllowedAction(action) {
  return ALLOWED_ACTIONS.has(normalizeAction(action));
}

function normalizeDetails(action, details) {
  const ru = humanAction(action);
  if (!details) return { ru };
  if (typeof details === "string") return { ru, message: details };
  if (typeof details === "object") return { ru, ...details };
  return { ru, message: String(details) };
}

function inferIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.trim()) {
    return xff.split(",")[0].trim();
  }
  return req.ip || req.connection?.remoteAddress || req.socket?.remoteAddress || "";
}

function cfg() {
  return {
    strapiUrl: env("URL_STRAPI", "").replace(/\/$/, ""),
    strapiLogin: env("LOGIN_STRAPI", ""),
    strapiPassword: env("PASSWORD_STRAPI", ""),
    endpoint: env("AUDIT_STRAPI_ENDPOINT", "/api/audit-events"),
    writeTimeoutMs: envInt("AUDIT_WRITE_TIMEOUT_MS", 3000, { min: 500, max: 60000 }),
    queryTimeoutMs: envInt("AUDIT_QUERY_TIMEOUT_MS", 5000, { min: 1000, max: 60000 }),
    degradeAfterErrors: envInt("AUDIT_DEGRADE_AFTER_ERRORS", 5, { min: 1, max: 1000 }),
    degradeCooldownMs: envInt("AUDIT_DEGRADE_COOLDOWN_MS", 120000, {
      min: 1000,
      max: 60 * 60 * 1000,
    }),
    authTimeoutMs: envInt("AUDIT_AUTH_TIMEOUT_MS", 2500, { min: 500, max: 10000 }),
    jwtTtlMs: envInt("AUDIT_JWT_TTL_MS", 5 * 60 * 1000, { min: 30000, max: 60 * 60 * 1000 }),
  };
}

const state = {
  consecutiveErrors: 0,
  degradedUntil: 0,
  droppedTotal: 0,
  droppedOverflow: 0, // оставлено для совместимости c UI
  droppedDegraded: 0,
  flushedRows: 0,
  flushedBatches: 0,
  lastError: null,
  lastWarnAt: 0,
  lastWriteAt: null,
  lastReadAt: null,
};

function isDegraded() {
  return state.degradedUntil > Date.now();
}

function warnThrottled(message) {
  const now = Date.now();
  if (now - state.lastWarnAt < 15000) return;
  state.lastWarnAt = now;
  console.warn(message);
}

function normalizeApiPath(path) {
  const trimmed = String(path || "").trim();
  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed || "api/audit-events"}`;
  return withLeadingSlash.startsWith("/api/") ? withLeadingSlash : `/api/${withLeadingSlash.replace(/^\//, "")}`;
}

function endpointCandidates() {
  const base = normalizeApiPath(cfg().endpoint);
  const variants = [base, base.replace(/_/g, "-"), base.replace(/-/g, "_")];
  return [...new Set(variants.map((x) => x.replace(/\/+$/, "")))];
}

const jwtCache = {
  token: "",
  expiresAt: 0,
  inFlight: null,
};

const usersDirectoryCache = {
  byUsername: new Map(),
  expiresAt: 0,
  inFlight: null,
};

async function getServiceJwt() {
  const options = cfg();
  if (!options.strapiUrl) {
    throw new Error("URL_STRAPI not configured");
  }
  if (jwtCache.token && Date.now() < jwtCache.expiresAt) {
    return jwtCache.token;
  }
  if (jwtCache.inFlight) return jwtCache.inFlight;

  jwtCache.inFlight = (async () => {
    const resp = await axios.post(
      `${options.strapiUrl}/api/auth/local`,
      {
        identifier: options.strapiLogin,
        password: options.strapiPassword,
      },
      { timeout: options.authTimeoutMs }
    );
    const token = String(resp?.data?.jwt || "").trim();
    if (!token) throw new Error("Strapi auth returned empty jwt");
    jwtCache.token = token;
    jwtCache.expiresAt = Date.now() + options.jwtTtlMs;
    return token;
  })();

  try {
    return await jwtCache.inFlight;
  } finally {
    jwtCache.inFlight = null;
  }
}

async function strapiRequest(method, { params, data, timeoutMs } = {}) {
  const options = cfg();
  const token = await getServiceJwt();
  let lastError = null;

  for (const path of endpointCandidates()) {
    try {
      return await axios({
        method,
        url: `${options.strapiUrl}${path}`,
        headers: { Authorization: `Bearer ${token}` },
        params,
        data,
        timeout: timeoutMs || options.queryTimeoutMs,
      });
    } catch (e) {
      const status = Number(e?.response?.status || 0);
      if (status === 404) {
        lastError = e;
        continue;
      }
      if (status === 401 || status === 403) {
        jwtCache.token = "";
      }
      throw e;
    }
  }

  throw lastError || new Error("Strapi audit endpoint not found");
}

function normalizeUserRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.results)) return payload.results;
  return [];
}

async function loadUsersDirectory() {
  const now = Date.now();
  if (usersDirectoryCache.byUsername.size > 0 && usersDirectoryCache.expiresAt > now) {
    return usersDirectoryCache.byUsername;
  }
  if (usersDirectoryCache.inFlight) return usersDirectoryCache.inFlight;

  usersDirectoryCache.inFlight = (async () => {
    const options = cfg();
    const token = await getServiceJwt();
    const map = new Map();
    let page = 1;
    let pageCount = 1;
    const maxPages = 20;

    while (page <= pageCount && page <= maxPages) {
      const resp = await axios.get(`${options.strapiUrl}/api/users`, {
        headers: { Authorization: `Bearer ${token}` },
        params: {
          "pagination[page]": page,
          "pagination[pageSize]": 200,
        },
        timeout: options.queryTimeoutMs,
      });

      const rows = normalizeUserRows(resp?.data);
      for (const row of rows) {
        const username = toStr(row?.username || row?.fullName || row?.name, "");
        if (!username) continue;
        const key = username.toLowerCase();
        const email = toStr(row?.email, "");
        const existing = map.get(key);
        if (!existing || (!existing.email && email)) {
          map.set(key, { username, email });
        }
      }

      const pagination = resp?.data?.meta?.pagination;
      if (!pagination || !Number.isFinite(Number(pagination.pageCount))) {
        break;
      }
      pageCount = Math.max(1, Number(pagination.pageCount));
      page += 1;
    }

    usersDirectoryCache.byUsername = map;
    usersDirectoryCache.expiresAt = Date.now() + 5 * 60 * 1000;
    return map;
  })();

  try {
    return await usersDirectoryCache.inFlight;
  } finally {
    usersDirectoryCache.inFlight = null;
  }
}

function attachEmailByUsername(rows, directory) {
  if (!Array.isArray(rows) || rows.length === 0) return rows || [];
  return rows.map((row) => {
    const key = String(row?.username || "").trim().toLowerCase();
    const match = key ? directory.get(key) : null;
    return {
      ...row,
      email: row?.email || match?.email || "",
    };
  });
}

function extractActor(req, body = {}) {
  const username =
    toStr(body.username) ||
    decodeMaybeUri(req.get("x-audit-username")) ||
    toStr(req.get("x-username")) ||
    "unknown";
  const role =
    toStr(body.role) ||
    decodeMaybeUri(req.get("x-audit-role")) ||
    toStr(req.get("x-view-role")) ||
    "unknown";
  return { username, role };
}

async function logAuditEvent(event) {
  if (!isEnabled()) return { ok: false, skipped: true, reason: "audit_logger_disabled" };
  if (!isAllowedAction(event?.action)) {
    return { ok: false, skipped: true, reason: "action_not_allowed" };
  }
  if (isLoggingPagePath(event?.page)) {
    return { ok: false, skipped: true, reason: "logging_page_suppressed" };
  }

  const options = cfg();
  if (isDegraded()) {
    state.droppedTotal += 1;
    state.droppedDegraded += 1;
    warnThrottled("[audit] logger is in degraded mode, dropping incoming event");
    return { ok: false, skipped: true, reason: "logger_degraded" };
  }

  const roleRaw = toStr(event.role || event.view_role || "system", "system").toLowerCase();
  const safeRole = ["standart", "preview", "supergeneral", "system"].includes(roleRaw)
    ? roleRaw
    : "system";
  const statusRaw = toStr(event.status_event || event.status || "", "").toLowerCase();
  const safeStatus = ["success", "error", "info", "warning"].includes(statusRaw)
    ? statusRaw
    : toStr(event.action || "", "").toLowerCase().includes("error")
      ? "error"
      : "info";
  const sourceRaw = toStr(event.source || "backend", "backend").toLowerCase();
  const safeSource = ["frontend", "backend", "bot", "system"].includes(sourceRaw)
    ? sourceRaw
    : "system";

  const payload = {
    event_time: event.event_time || new Date().toISOString(),
    username: toStr(event.username, "unknown"),
    view_role: safeRole,
    action: toStr(event.action, "unknown"),
    page: toStr(event.page, ""),
    entity_id: toStr(event.entity_id, ""),
    status_event: safeStatus,
    ip: toStr(event.ip, ""),
    request_id: toStr(event.request_id, ""),
    source: safeSource,
    details: normalizeDetails(event.action, parseDetailsMaybeJson(event.details)),
  };

  try {
    await strapiRequest("post", {
      data: { data: payload },
      timeoutMs: options.writeTimeoutMs,
    });
    state.consecutiveErrors = 0;
    state.lastError = null;
    state.flushedRows += 1;
    state.flushedBatches += 1;
    state.lastWriteAt = new Date().toISOString();
    return { ok: true, stored: true };
  } catch (e) {
    state.consecutiveErrors += 1;
    state.lastError = {
      at: new Date().toISOString(),
      message: e?.response?.data?.error?.message || e?.message || String(e),
    };
    state.droppedTotal += 1;

    warnThrottled(
      `[audit] write failed (${state.consecutiveErrors}/${options.degradeAfterErrors}): ${
        state.lastError.message
      }`
    );

    if (state.consecutiveErrors >= options.degradeAfterErrors) {
      state.degradedUntil = Date.now() + options.degradeCooldownMs;
      warnThrottled(
        `[audit] logger degraded for ${options.degradeCooldownMs}ms after ${state.consecutiveErrors} errors`
      );
    }
    return { ok: false, skipped: true, reason: "write_failed" };
  }
}

async function logAuditFromReq(req, event = {}) {
  const actor = extractActor(req, event);
  const row = {
    ...actor,
    page: event.page || req.originalUrl || req.path || "",
    action: event.action || "unknown",
    entity: event.entity || "ui",
    entity_id: event.entity_id || "",
    details: parseDetailsMaybeJson(event.details || ""),
    ip: inferIp(req),
    user_agent: req.get("user-agent") || "",
  };
  return logAuditEvent(row);
}

function getAuditLoggerState() {
  return {
    enabled: isEnabled(),
    queue_size: 0,
    flushing: false,
    degraded: isDegraded(),
    degraded_until: state.degradedUntil ? new Date(state.degradedUntil).toISOString() : null,
    consecutive_errors: state.consecutiveErrors,
    dropped_total: state.droppedTotal,
    dropped_overflow: state.droppedOverflow,
    dropped_degraded: state.droppedDegraded,
    flushed_rows: state.flushedRows,
    flushed_batches: state.flushedBatches,
    last_error: state.lastError,
    last_write_at: state.lastWriteAt,
    last_read_at: state.lastReadAt,
    backend: "strapi",
  };
}

function pickRaw(item) {
  if (!item || typeof item !== "object") return {};
  return item.attributes && typeof item.attributes === "object" ? item.attributes : item;
}

function rowToUi(item) {
  const raw = pickRaw(item);
  return {
    id: item?.id ?? raw?.id ?? null,
    documentId: item?.documentId ?? raw?.documentId ?? null,
    created_at: raw.event_time || raw.createdAt || null,
    username: raw.username || "",
    email: raw.email || "",
    role: raw.view_role || "system",
    page: raw.page || "",
    action: raw.action || "",
    entity_id: raw.entity_id || "",
    details: raw.details ?? "",
    details_json: raw.details ?? {},
    ip: raw.ip || "",
    request_id: raw.request_id || "",
    status_event: raw.status_event || "",
    source: raw.source || "",
  };
}

function containsCi(haystack, needle) {
  return String(haystack || "").toLowerCase().includes(String(needle || "").toLowerCase());
}

function parseIsoDateSafe(value) {
  const s = String(value || "").trim();
  if (!s) return "";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString();
}

function normalizeStatusEvent(value) {
  const v = String(value || "").trim().toLowerCase();
  if (!v) return "";
  return ["success", "error", "info", "warning"].includes(v) ? v : "";
}

function normalizeTnType(value) {
  const v = String(value || "").trim().toLowerCase();
  if (!v) return "";
  return v === "number" ? "number" : v === "guid" ? "guid" : "";
}

function rowMatchesTn(row, tnType, tnValue) {
  const needle = String(tnValue || "").trim().toLowerCase();
  if (!needle) return true;

  const entityId = String(row?.entity_id || "").toLowerCase();
  const detailsText = detailsToString(row?.details_json ?? row?.details ?? "").toLowerCase();

  if (tnType === "number") {
    const compactNeedle = needle.replace(/\s+/g, "");
    const compactDetails = detailsText.replace(/\s+/g, "");
    return (
      entityId.includes(needle) ||
      detailsText.includes(`"number":"${needle}"`) ||
      detailsText.includes(`"number":${needle}`) ||
      compactDetails.includes(`"number":"${compactNeedle}"`) ||
      detailsText.includes(needle)
    );
  }

  return entityId.includes(needle) || detailsText.includes(needle);
}

async function readAuditEvents({
  limit = 200,
  action = "",
  username = "",
  page = "",
  search = "",
  from = "",
  to = "",
  statusEvent = "",
  tnType = "",
  tnValue = "",
} = {}) {
  const safeLimit = Math.min(1000, Math.max(1, Number(limit) || 200));
  const defaultTo = new Date().toISOString();
  const defaultFrom = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const fromIso = parseIsoDateSafe(from) || (!to ? defaultFrom : "");
  const toIso = parseIsoDateSafe(to) || (!from ? defaultTo : "");
  const safeStatusEvent = normalizeStatusEvent(statusEvent);
  const safeTnType = normalizeTnType(tnType);

  if (from && !fromIso) {
    throw new Error("Invalid 'from' date");
  }
  if (to && !toIso) {
    throw new Error("Invalid 'to' date");
  }

  const params = {
    "pagination[page]": 1,
    "pagination[pageSize]": safeLimit,
    "sort[0]": "event_time:desc",
  };

  if (action) params["filters[action][$containsi]"] = String(action).trim();
  if (username) params["filters[username][$containsi]"] = String(username).trim();
  if (page) params["filters[page][$containsi]"] = String(page).trim();
  if (fromIso) params["filters[event_time][$gte]"] = fromIso;
  if (toIso) params["filters[event_time][$lte]"] = toIso;
  if (safeStatusEvent) params["filters[status_event][$eq]"] = safeStatusEvent;

  const resp = await strapiRequest("get", { params, timeoutMs: cfg().queryTimeoutMs });
  const rawRows = Array.isArray(resp?.data?.data) ? resp.data.data : [];
  const mapped = rawRows.map(rowToUi);
  let mappedWithEmail = mapped;
  try {
    const directory = await loadUsersDirectory();
    mappedWithEmail = attachEmailByUsername(mapped, directory);
  } catch {
    mappedWithEmail = mapped;
  }
  const searchNeedle = String(search || "").trim().toLowerCase();
  const filtered = mappedWithEmail.filter((row) => {
    if (!isAllowedAction(row?.action)) return false;
    if (isLoggingPagePath(row?.page)) return false;
    const hasSearch =
      !searchNeedle ||
      containsCi(row.entity_id, searchNeedle) ||
      containsCi(detailsToString(row.details_json), searchNeedle);
    const hasTn = rowMatchesTn(row, safeTnType, tnValue);
    return hasSearch && hasTn;
  });

  const pagination = resp?.data?.meta?.pagination || {};
  state.lastReadAt = new Date().toISOString();

  return {
    ok: true,
    data: filtered,
    meta: {
      count: filtered.length,
      limit: safeLimit,
      total: pagination.total ?? filtered.length,
      page: pagination.page ?? 1,
      pageSize: pagination.pageSize ?? safeLimit,
      pageCount: pagination.pageCount ?? 1,
      period: {
        from: fromIso || null,
        to: toIso || null,
      },
    },
  };
}

async function readAuditUsers({ query = "", limit = 50, from = "", to = "" } = {}) {
  const safeLimit = Math.min(200, Math.max(1, Number(limit) || 50));
  const fromIso = parseIsoDateSafe(from);
  const toIso = parseIsoDateSafe(to);
  const queryNeedle = String(query || "").trim();
  const pageSize = 100;
  const maxPages = 30;

  const set = new Set();
  const users = [];
  let page = 1;
  let pageCount = 1;

  while (page <= pageCount && page <= maxPages && users.length < safeLimit) {
    const params = {
      "pagination[page]": page,
      "pagination[pageSize]": pageSize,
      "sort[0]": "event_time:desc",
    };
    if (queryNeedle) params["filters[username][$containsi]"] = queryNeedle;
    if (fromIso) params["filters[event_time][$gte]"] = fromIso;
    if (toIso) params["filters[event_time][$lte]"] = toIso;

    const resp = await strapiRequest("get", { params, timeoutMs: cfg().queryTimeoutMs });
    const rawRows = Array.isArray(resp?.data?.data) ? resp.data.data : [];
    for (const row of rawRows) {
      const mapped = rowToUi(row);
      if (!isAllowedAction(mapped?.action)) continue;
      if (isLoggingPagePath(mapped?.page)) continue;
      const username = String(mapped?.username || "").trim();
      if (!username) continue;
      const key = username.toLowerCase();
      if (set.has(key)) continue;
      set.add(key);
      users.push(username);
      if (users.length >= safeLimit) break;
    }

    const pagination = resp?.data?.meta?.pagination || {};
    pageCount = Number(pagination.pageCount || 1);
    page += 1;
  }

  let data = users.map((username) => ({ username, email: "" }));
  try {
    const directory = await loadUsersDirectory();
    data = users.map((username) => {
      const key = String(username).toLowerCase();
      const match = directory.get(key);
      return {
        username,
        email: match?.email || "",
      };
    });
  } catch {
    data = users.map((username) => ({ username, email: "" }));
  }

  return {
    ok: true,
    data,
    meta: {
      count: data.length,
      limit: safeLimit,
    },
  };
}

async function checkAuditStore() {
  try {
    await readAuditEvents({ limit: 1 });
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      message: e?.response?.data?.error?.message || e?.message || "Audit store unavailable",
    };
  }
}

module.exports = {
  logAuditEvent,
  logAuditFromReq,
  extractActor,
  inferIp,
  getAuditLoggerState,
  readAuditEvents,
  readAuditUsers,
  checkAuditStore,
};
