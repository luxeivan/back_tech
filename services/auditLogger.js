const axios = require("axios");

function env(name, fallback = "") {
  const v = process.env[name];
  return v == null || v === "" ? fallback : String(v);
}

function isEnabled() {
  return env("DB_DIALECT").toLowerCase() === "clickhouse";
}

function toStr(v, fallback = "") {
  if (v == null) return fallback;
  const s = String(v).trim();
  return s || fallback;
}

function detailsToString(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function humanAction(action) {
  const map = {
    page_view: "Открыл страницу",
    page_leave: "Покинул страницу",
    click_dashboard: "Перешел на дашборд",
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
  };
  return map[action] || action;
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

function extractActor(req, body = {}) {
  const username =
    toStr(body.username) ||
    toStr(req.get("x-audit-username")) ||
    toStr(req.get("x-username")) ||
    "unknown";
  const role =
    toStr(body.role) ||
    toStr(req.get("x-audit-role")) ||
    toStr(req.get("x-view-role")) ||
    "unknown";
  return { username, role };
}

async function logAuditEvent(event) {
  if (!isEnabled()) return { ok: false, skipped: true, reason: "db_dialect_not_clickhouse" };

  const host = env("DB_HOST", "127.0.0.1");
  const rawPort = Number(env("DB_PORT", "8123")) || 8123;
  const port = Number(env("DB_HTTP_PORT", String(rawPort === 9000 ? 8123 : rawPort))) || 8123;
  const user = env("DB_USER", "default");
  const password = env("DB_PASSWORD", "");
  const dbName = env("DB_NAME", "portal_logs");
  const query = `INSERT INTO ${dbName}.audit_events FORMAT JSONEachRow`;
  const url = `http://${host}:${port}/?query=${encodeURIComponent(query)}`;

  const row = {
    username: toStr(event.username, "unknown"),
    role: toStr(event.role, "unknown"),
    page: toStr(event.page, ""),
    action: toStr(event.action, ""),
    entity: toStr(event.entity, ""),
    entity_id: toStr(event.entity_id, ""),
    details: detailsToString(normalizeDetails(event.action, event.details)),
    ip: toStr(event.ip, ""),
    user_agent: toStr(event.user_agent, ""),
  };

  await axios.post(url, `${JSON.stringify(row)}\n`, {
    timeout: 3000,
    auth: { username: user, password },
    headers: { "Content-Type": "application/json" },
  });

  return { ok: true };
}

async function logAuditFromReq(req, event = {}) {
  const actor = extractActor(req, event);
  const row = {
    ...actor,
    page: event.page || req.originalUrl || req.path || "",
    action: event.action || "unknown",
    entity: event.entity || "ui",
    entity_id: event.entity_id || "",
    details: event.details || "",
    ip: inferIp(req),
    user_agent: req.get("user-agent") || "",
  };
  return logAuditEvent(row);
}

module.exports = { logAuditEvent, logAuditFromReq, extractActor, inferIp };
