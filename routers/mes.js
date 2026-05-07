//Название файла такое серьезное 😄
require("dotenv").config();
const express = require("express");
const axios = require("axios");
const FormData = require("form-data");
const dayjs = require("dayjs");
const { logAuditFromReq } = require("../services/auditLogger");

const MES_MODE = String(process.env.MES_MODE || process.env.MES_ENV || "test")
  .trim()
  .toLowerCase();

const MES_TEST_AUTH_URL =
  process.env.MES_TEST_AUTH_URL || process.env.MES_AUTH_URL || process.env.MES_BASE_URL;
const MES_TEST_LOAD_URL =
  process.env.MES_TEST_LOAD_URL || process.env.MES_LOAD_URL || process.env.MES_BASE_URL;
const MES_PROD_AUTH_URL =
  process.env.MES_PROD_AUTH_URL || process.env.MES_AUTH_URL || process.env.MES_BASE_URL;
const MES_PROD_LOAD_URL =
  process.env.MES_PROD_LOAD_URL || process.env.MES_LOAD_URL || process.env.MES_BASE_URL;

const AUTH_BASE = MES_MODE === "prod" ? MES_PROD_AUTH_URL : MES_TEST_AUTH_URL;
const LOAD_BASE = MES_MODE === "prod" ? MES_PROD_LOAD_URL : MES_TEST_LOAD_URL;

(function logMesEndpoints() {
  try {
    console.log(`[MES] mode=${MES_MODE}`);
    console.log(`[MES] AUTH_BASE: ${AUTH_BASE}`);
  } catch (_) {}
  try {
    console.log(`[MES] LOAD_BASE: ${LOAD_BASE}`);
  } catch (_) {}
})();

const router = express.Router();

function readPositiveIntEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function normalizeHttpMethod(v, fallback = "post") {
  const method = String(v || fallback).trim().toLowerCase();
  return method === "get" ? "get" : "post";
}

const MES_LOGIN = process.env.MES_LOGIN;
const MES_PASSWORD = process.env.MES_PASSWORD;
const SYS_CONTACT = process.env.MES_SYSTEM_CONTACT || "102"; // 1=РМР, 2=МОЭ
const KD_CHANNEL = process.env.MES_CHANNEL || "3"; // 3=ЕЛКК ФЛ
const KD_ORG = process.env.MES_ORG_CODE || "2"; // 2=МОЭ
const FACILITY_ID = process.env.MES_FACILITY_ID || "1";
const CAMPAIGN_TYPE = process.env.MES_CAMPAIGN_TYPE || "SETI_NOTICE";
const MES_REQUEST_LOG = String(process.env.MES_REQUEST_LOG || "1") !== "0";
const MES_AUTH_METHOD = normalizeHttpMethod(process.env.MES_AUTH_METHOD, "post");
const MES_AUTH_TIMEOUT_MS = readPositiveIntEnv("MES_AUTH_TIMEOUT_MS", 12000);
const MES_UPLOAD_TIMEOUT_MS = readPositiveIntEnv("MES_UPLOAD_TIMEOUT_MS", 30000);
const MES_RETRY_ATTEMPTS = readPositiveIntEnv("MES_RETRY_ATTEMPTS", 1);

/* ---------------- utils ---------------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(fn, { attempts = 3, baseDelay = 1200 } = {}) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i === attempts) break;
      await sleep(baseDelay * i); // линейный backoff: 1.2s, 2.4s, 3.6s
    }
  }
  throw lastErr;
}

function toIsoT(v) {
  if (!v) return null;
  const d = dayjs(v);
  return d.isValid() ? d.format("YYYY-MM-DD[T]HH:mm:ss") : null;
}
function clean(v) {
  if (v === undefined || v === null || v === "" || v === "—") return null;
  return String(v);
}

function maskSecret(v) {
  if (!v) return null;
  const s = String(v);
  if (s.length <= 4) return "****";
  return `${s.slice(0, 2)}***${s.slice(-2)}`;
}

function maskSession(v) {
  if (!v) return null;
  const s = String(v);
  if (s.length <= 10) return "********";
  return `${s.slice(0, 6)}***${s.slice(-4)}`;
}

function sanitizeMesResponse(data) {
  if (!data || typeof data !== "object") return data;
  const copy = JSON.parse(JSON.stringify(data));
  if (Array.isArray(copy.data)) {
    copy.data = copy.data.map((row) => {
      if (row && typeof row === "object" && row.session) {
        return { ...row, session: maskSession(row.session) };
      }
      return row;
    });
  }
  return copy;
}

function logMes(...args) {
  if (MES_REQUEST_LOG) console.log(...args);
}

function splitFirst(v) {
  const val = clean(v);
  if (!val) return null;
  return (
    val
      .split(/[;,]/)
      .map((s) => s.trim())
      .filter(Boolean)[0] || null
  );
}

function normalizeBaseType(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function getBaseTypeFromPayload(p = {}) {
  return normalizeBaseType(p.base_type ?? p.BASE_TYPE);
}

function getBaseTypeFromTn(tn) {
  const raw = tn?.data?.data || {};
  const obj = tn?.data || {};
  return normalizeBaseType(obj.BASE_TYPE ?? raw.BASE_TYPE);
}

function getExternalIdFromPayload(p = {}) {
  return (
    clean(p.external_id) ||
    clean(p.VIOLATION_GUID_STR) ||
    clean(p.guid) ||
    clean(p.id_registry_ext) ||
    null
  );
}

function getExternalIdFromTn(tn) {
  const raw = tn?.data?.data || {};
  const obj = tn?.data || {};
  return (
    clean(raw.VIOLATION_GUID_STR) ||
    clean(obj.guid) ||
    clean(obj.documentId) ||
    clean(obj.id) ||
    null
  );
}

function buildRegistryExternalId(externalId) {
  const base = clean(externalId) || "mosoblenergo";
  const safeBase = base.replace(/[^\w.-]+/g, "_").slice(0, 80);
  return `${safeBase}_${dayjs().format("YYYYMMDDHHmmss")}`;
}

function makeAuthParams(masked = false) {
  return {
    action: "auth",
    login: MES_LOGIN,
    pwd_password: masked ? maskSecret(MES_PASSWORD) : MES_PASSWORD,
  };
}

async function sendMesAuthRequest({ method = MES_AUTH_METHOD, timeoutMs = MES_AUTH_TIMEOUT_MS } = {}) {
  const params = makeAuthParams(false);
  const normalizedMethod = normalizeHttpMethod(method, MES_AUTH_METHOD);
  const startedAt = Date.now();

  const response =
    normalizedMethod === "get"
      ? await axios.get(AUTH_BASE, { params, timeout: timeoutMs })
      : await axios.post(AUTH_BASE, null, { params, timeout: timeoutMs });

  return {
    data: response.data,
    durationMs: Date.now() - startedAt,
    request: {
      method: normalizedMethod.toUpperCase(),
      url: AUTH_BASE,
      query: makeAuthParams(true),
      timeout_ms: timeoutMs,
    },
  };
}

/* ---------------- auth ---------------- */
async function mesAuth() {
  if (!AUTH_BASE || !MES_LOGIN || !MES_PASSWORD) {
    throw new Error("MES_* не настроены в .env");
  }

  logMes("[МосЭнергоСбыт] auth: отправляем запрос", {
    mode: MES_MODE,
    url: AUTH_BASE,
    method: MES_AUTH_METHOD.toUpperCase(),
    timeout_ms: MES_AUTH_TIMEOUT_MS,
    retry_attempts: MES_RETRY_ATTEMPTS,
    query: makeAuthParams(true),
  });
  const { data } = await withRetry(
    () =>
      sendMesAuthRequest({
        method: MES_AUTH_METHOD,
        timeoutMs: MES_AUTH_TIMEOUT_MS,
      }),
    { attempts: MES_RETRY_ATTEMPTS, baseDelay: 1500 }
  );

  const session = data?.data?.[0]?.session;
  if (!session) throw new Error("Не получили session от СУВК");
  return session;
}

async function mesAuthDiagnostic(method = MES_AUTH_METHOD) {
  if (!AUTH_BASE || !MES_LOGIN || !MES_PASSWORD) {
    throw new Error("MES_* не настроены в .env");
  }

  const normalizedMethod = normalizeHttpMethod(method, MES_AUTH_METHOD);

  console.log("[МосЭнергоСбыт] Диагностика: попытка 1 из 1");
  console.log(
    `[МосЭнергоСбыт] Диагностика: отправляем action=auth методом ${normalizedMethod.toUpperCase()}`
  );
  console.log(
    `[МосЭнергоСбыт] Диагностика: логин=${MES_LOGIN}, пароль=${maskSecret(MES_PASSWORD)}`
  );

  const { data, durationMs, request } = await sendMesAuthRequest({
    method: normalizedMethod,
    timeoutMs: MES_AUTH_TIMEOUT_MS,
  });

  console.log(`[МосЭнергоСбыт] Диагностика: внешний сервер ответил за ${durationMs}мс`);

  const session = data?.data?.[0]?.session;
  if (!session) throw new Error("Не получили session от СУВК");
  return { session, raw: sanitizeMesResponse(data), durationMs, request };
}

/* ---------------- mapping ---------------- */
function mapNotification(tn) {
  const raw = tn?.data?.data || {};
  const status = clean(raw.STATUS_NAME || tn?.data?.STATUS_NAME) || "";
  const s = status.toLowerCase();
  if (s.includes("запитан") || s.includes("закрыт")) return "2";
  if (getBaseTypeFromTn(tn) === 1) return "3";
  return "1";
}

function firstFiasHouse(tn) {
  const raw = tn?.data?.data || {};
  return splitFirst(
    raw.FIAS_LIST || tn?.data?.FIAS_LIST || tn?.data?.house_fias_list
  );
}

function buildRegistryItemFromMesPayload(p, idx = 1) {
  const fias = splitFirst(p.fias) || splitFirst(p.Guid2) || splitFirst(p.FIAS_LIST) || "";
  const cond = (clean(p.condition) || "").toLowerCase();
  const baseType = getBaseTypeFromPayload(p);
  let kdNotif = "1";
  if (cond.includes("запитан") || cond.includes("закрыт")) kdNotif = "2";
  else if (baseType === 1) kdNotif = "3";

  const item = {
    id_regline_ext: String(p.id_regline_ext || idx),
    kd_tp_client: 1,
    KD_TP_NOTIFICATION: kdNotif,
    KD_ORG,
  };

  if (fias !== "") item.GUID_FIAS_HOUSE = fias;

  const dateOff = toIsoT(p.date_off);
  const datePlan = toIsoT(p.date_on_plan);
  const dateFact = toIsoT(p.date_on_fact);

  if (dateOff) item.DT_OUTAGE_TIME_PLANNED = dateOff;
  if (kdNotif === "2") {
    if (dateFact) item.DT_RESTORATION_TIME_PLANNED = dateFact;
    else if (datePlan) item.DT_RESTORATION_TIME_PLANNED = datePlan;
  } else if (datePlan) {
    item.DT_RESTORATION_TIME_PLANNED = datePlan;
  }

  const reason = clean(p.massage);
  if (reason) item.NM_REASON = reason.toLowerCase();

  return item;
}

function buildRegistryItem(tn, idx = 1) {
  const raw = tn?.data?.data || {};
  const obj = tn?.data || {};

  const dateOff = toIsoT(raw.F81_060_EVENTDATETIME || obj.createDateTime);
  const datePlan = toIsoT(
    raw.F81_070_RESTOR_SUPPLAYDATETIME || obj.recoveryPlanDateTime
  );
  const dateFact = toIsoT(
    raw.F81_290_RECOVERYDATETIME || obj.recoveryFactDateTime || obj.recoveryDateTime
  );
  const reason = (
    clean(obj.description) ||
    clean(raw.DESCRIPTION) ||
    ""
  ).toLowerCase();
  const kdNotif = mapNotification(tn);

  const item = {
    id_regline_ext: String(obj.documentId || obj.id || idx),
    kd_tp_client: 1,
    KD_TP_NOTIFICATION: kdNotif,
    KD_ORG,
  };

  const fias = firstFiasHouse(tn);
  if (fias) item.GUID_FIAS_HOUSE = fias;

  if (dateOff) item.DT_OUTAGE_TIME_PLANNED = dateOff;
  if (kdNotif === "2") {
    if (dateFact) item.DT_RESTORATION_TIME_PLANNED = dateFact;
    else if (datePlan) item.DT_RESTORATION_TIME_PLANNED = datePlan;
  } else if (datePlan) {
    item.DT_RESTORATION_TIME_PLANNED = datePlan;
  }
  if (reason) item.NM_REASON = reason;

  return item;
}

/* ---------------- upload + status ---------------- */
async function mesUploadRegistry(items, { externalId } = {}) {
  const session = await mesAuth();
  const idRegistryExt = buildRegistryExternalId(externalId);

  const params = {
    action: "upload",
    query: "FwdRegistryLoad",
    session,
    id_registry_ext: idRegistryExt,
    kd_system_contact: SYS_CONTACT,
    kd_channel: KD_CHANNEL,
    dt_campaign_beg: dayjs().format("YYYY-MM-DD"),
    dt_campaign_end: dayjs().add(3, "day").format("YYYY-MM-DD"),
    id_facility: FACILITY_ID,
    kd_tp_campaign: CAMPAIGN_TYPE,
  };

  const form = new FormData();
  form.append("vl_registry", Buffer.from(JSON.stringify(items, null, 2)), {
    filename: "registry.json",
    contentType: "application/json",
  });

  logMes("[МосЭнергоСбыт] upload: отправляем реестр", {
    mode: MES_MODE,
    url: LOAD_BASE,
    query: { ...params, session: maskSession(session) },
    rows: items.length,
    vl_registry: items,
  });

  const { data } = await withRetry(
    () =>
      axios.post(LOAD_BASE, form, {
        params,
        headers: form.getHeaders(),
        timeout: MES_UPLOAD_TIMEOUT_MS,
        maxBodyLength: Infinity,
      }),
    { attempts: MES_RETRY_ATTEMPTS, baseDelay: 1500 }
  );

  const idRegistry = data?.data?.[0]?.id_registry;
  if (!idRegistry) throw new Error("Не получили id_registry в ответе СУВК");
  logMes("[МосЭнергоСбыт] upload: ответ внешней системы", sanitizeMesResponse(data));
  return { idRegistry, idRegistryExt, session, raw: data };
}

async function mesCheckStatus({ session, idRegistry }) {
  const { data } = await axios.get(LOAD_BASE, {
    params: {
      query: "FwdRegistryCheckStatus",
      session,
      id_registry: idRegistry,
    },
    timeout: 30000,
  });
  return data;
}

/* ---------------- routes ---------------- */
router.post("/upload", express.json({ limit: "20mb" }), async (req, res) => {
  const startedAt = Date.now();
  let auditDetails = { result: "unknown" };
  try {
    const body = req.body || {};
    let items = [];
    let externalId = null;

    const list = Array.isArray(body?.tns)
      ? body.tns
      : [body?.tn].filter(Boolean);
    if (list.length) {
      items = list.map((tn, i) => buildRegistryItem(tn, i + 1));
      externalId = getExternalIdFromTn(list[0]);
    }

    const looksLikeMes =
      body &&
      (body.date_off ||
        body.massage ||
        body.status ||
        body.base_type !== undefined ||
        body.BASE_TYPE !== undefined ||
        body.external_id ||
        body.condition ||
        body.fias ||
        body.Guid2 ||
        body.FIAS_LIST);
    if (!items.length && looksLikeMes) {
      items = [buildRegistryItemFromMesPayload(body, 1)];
      externalId = getExternalIdFromPayload(body);
    }

    if (!items.length) {
      return res.status(400).json({
        ok: false,
        message:
          "Передай tn/tns или MES-поля (date_off/.../condition/base_type) + fias/Guid2/FIAS_LIST",
      });
    }

    if (req.query.dryRun === "1") {
      const fakeId = `TEST-${Date.now()}`;
      console.log(
        `МосЭнергоСбыт DRY-RUN: строк реестра = ${items.length}, id_registry = ${fakeId}`
      );
      auditDetails = { result: "dry-run", rows: items.length };
      return res.json({
        ok: true,
        dryRun: true,
        id_registry: fakeId,
        session: "TEST-SESSION",
        id_registry_ext: buildRegistryExternalId(externalId),
        vl_registry: items,
      });
    }

    console.log(`МосЭнергоСбыт UPLOAD: строк реестра = ${items.length}`);
    const { idRegistry, idRegistryExt, session } = await mesUploadRegistry(items, {
      externalId,
    });
    console.log("МосЭнергоСбыт: id_registry =", idRegistry);
    console.log("МосЭнергоСбыт: id_registry_ext =", idRegistryExt);

    auditDetails = {
      result: "ok",
      rows: items.length,
      id_registry: idRegistry,
      id_registry_ext: idRegistryExt,
    };
    return res.json({
      ok: true,
      id_registry: idRegistry,
      id_registry_ext: idRegistryExt,
      session: maskSession(session),
    });
  } catch (e) {
    const status = e?.response?.status || 502;
    const details = e?.response?.data;
    console.error(
      "Ошибка UPLOAD MES:",
      e?.message,
      details ? ` | details: ${JSON.stringify(details)}` : ""
    );
    auditDetails = {
      result: "error",
      status,
      message: e?.message || "Ошибка загрузки",
    };
    return res.status(status).json({
      ok: false,
      message: e?.message || "Ошибка загрузки",
      code: e?.code,
      details,
    });
  } finally {
    setImmediate(() => {
      logAuditFromReq(req, {
        page: "/services/mes/upload",
        action: "mes_upload",
        entity: "mes",
        entity_id: String(
          req.body?.tn?.data?.number ||
            req.body?.number ||
            req.body?.external_id ||
            req.body?.VIOLATION_GUID_STR ||
            ""
        ),
        details: {
          ...auditDetails,
          duration_ms: Date.now() - startedAt,
        },
      }).catch(() => {});
    });
  }
});

router.get("/status", async (req, res) => {
  try {
    const session = req.query.session;
    const idRegistry = req.query.id_registry;
    if (!session || !idRegistry) {
      return res
        .status(400)
        .json({ ok: false, message: "Нужны session и id_registry" });
    }
    const data = await mesCheckStatus({ session, idRegistry });
    return res.json({ ok: true, data });
  } catch (e) {
    const status = e?.response?.status || 502;
    return res
      .status(status)
      .json({
        ok: false,
        message: e?.message || "Ошибка проверки статуса",
        code: e?.code,
        details: e?.response?.data,
      });
  }
});

router.get("/ping", async (req, res) => {
  try {
    if (!AUTH_BASE && !LOAD_BASE)
      return res
        .status(500)
        .json({ ok: false, message: "MES_* URL не настроены" });
    return res.json({
      ok: true,
      mode: MES_MODE,
      AUTH_BASE: !!AUTH_BASE,
      LOAD_BASE: !!LOAD_BASE,
      auth_url: AUTH_BASE || null,
      load_url: LOAD_BASE || null,
      auth_method: MES_AUTH_METHOD.toUpperCase(),
      auth_timeout_ms: MES_AUTH_TIMEOUT_MS,
      upload_timeout_ms: MES_UPLOAD_TIMEOUT_MS,
      retry_attempts: MES_RETRY_ATTEMPTS,
    });
  } catch (e) {
    return res
      .status(500)
      .json({ ok: false, message: e?.message || "ping failed" });
  }
});

// Диагностика авторизации
router.get("/auth-test", async (req, res) => {
  const startedAt = Date.now();
  const startedIso = new Date(startedAt).toISOString();
  const method = normalizeHttpMethod(req.query.method, MES_AUTH_METHOD);

  console.log("[МосЭнергоСбыт] Тест авторизации: старт");
  console.log(`[МосЭнергоСбыт] AUTH_BASE: ${AUTH_BASE || "не задан"}`);
  console.log(
    `[МосЭнергоСбыт] Режим диагностики: method=${method.toUpperCase()}, timeout=${MES_AUTH_TIMEOUT_MS}мс, retry=1`
  );
  console.log(
    `[МосЭнергоСбыт] Учетные данные: login=${MES_LOGIN || "не задан"}, password=${maskSecret(MES_PASSWORD) || "не задан"}`
  );

  try {
    const result = await mesAuthDiagnostic(method);
    const durationMs = Date.now() - startedAt;
    console.log(
      `[МосЭнергоСбыт] Тест авторизации: session получен успешно за ${durationMs}мс`
    );

    return res.json({
      ok: true,
      message: "Сессионный токен получен",
      session: maskSession(result.session),
      debug: {
        started_at: startedIso,
        duration_ms: durationMs,
        mode: MES_MODE,
        auth_url: AUTH_BASE,
        auth_method: method.toUpperCase(),
        timeout_ms: MES_AUTH_TIMEOUT_MS,
        retry_attempts: 1,
        credentials: {
          login: MES_LOGIN || null,
          password: maskSecret(MES_PASSWORD),
        },
        request: result.request,
        raw_response: result.raw,
      },
    });
  } catch (e) {
    const durationMs = Date.now() - startedAt;
    const status = e?.response?.status || 502;
    const details = e?.response?.data;

    console.error(
      `[МосЭнергоСбыт] Тест авторизации: ошибка через ${durationMs}мс - ${e?.message || "unknown"}`
    );
    if (e?.code) console.error(`[МосЭнергоСбыт] Код ошибки: ${e.code}`);
    if (details) {
      try {
        console.error(
          `[МосЭнергоСбыт] Ответ внешней системы: ${JSON.stringify(details)}`
        );
      } catch (_) {
        console.error("[МосЭнергоСбыт] Ответ внешней системы не удалось сериализовать");
      }
    }

    return res.status(status).json({
      ok: false,
      message: e?.message || "Ошибка авторизации в МосЭнергоСбыт",
      code: e?.code || null,
      details,
      debug: {
        started_at: startedIso,
        duration_ms: durationMs,
        auth_url: AUTH_BASE,
        timeout_ms: 12000,
        retry_attempts: 1,
        credentials: {
          login: MES_LOGIN || null,
          password: maskSecret(MES_PASSWORD),
        },
        request: {
          method: method.toUpperCase(),
          url: AUTH_BASE,
          query: makeAuthParams(true),
          timeout_ms: MES_AUTH_TIMEOUT_MS,
        },
        http_status: e?.response?.status || null,
      },
    });
  }
});

module.exports = router;
