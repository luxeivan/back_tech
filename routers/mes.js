//Название файла такое серьезное 😄
require("dotenv").config();
const express = require("express");
const axios = require("axios");
const FormData = require("form-data");
const dayjs = require("dayjs");
const { logAuditFromReq } = require("../services/auditLogger");

const AUTH_BASE = process.env.MES_AUTH_URL || process.env.MES_BASE_URL;
const LOAD_BASE = process.env.MES_LOAD_URL || process.env.MES_BASE_URL;

(function logMesEndpoints() {
  try {
    console.log(`[MES] AUTH_BASE: ${AUTH_BASE}`);
  } catch (_) {}
  try {
    console.log(`[MES] LOAD_BASE: ${LOAD_BASE}`);
  } catch (_) {}
})();

const router = express.Router();

const MES_LOGIN = process.env.MES_LOGIN;
const MES_PASSWORD = process.env.MES_PASSWORD;
const SYS_CONTACT = process.env.MES_SYSTEM_CONTACT || "102"; // 1=РМР, 2=МОЭ
const KD_CHANNEL = process.env.MES_CHANNEL || "3"; // 3=ЕЛКК ФЛ
const KD_ORG = process.env.MES_ORG_CODE || "2"; // 2=МОЭ

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

/* ---------------- auth ---------------- */
async function mesAuth() {
  if (!AUTH_BASE || !MES_LOGIN || !MES_PASSWORD) {
    throw new Error("MES_* не настроены в .env");
  }
  const params = {
    action: "auth",
    login: MES_LOGIN,
    pwd_password: MES_PASSWORD,
  };

  // Было timeout 15000 → увеличил до 45000 + ретраи
  const { data } = await withRetry(
    () => axios.get(AUTH_BASE, { params, timeout: 45000 }),
    { attempts: 3, baseDelay: 1500 }
  );

  const session = data?.data?.[0]?.session;
  if (!session) throw new Error("Не получили session от СУВК");
  return session;
}

/* ---------------- mapping ---------------- */
function mapNotification(tn) {
  const raw = tn?.data?.data || {};
  const type = clean(raw.VIOLATION_TYPE || tn?.data?.type) || "";
  const status = clean(raw.STATUS_NAME || tn?.data?.STATUS_NAME) || "";
  const t = type.toLowerCase();
  const s = status.toLowerCase();
  if (t.includes("план") || t === "п") return "3";
  if (s.includes("запитан") || s.includes("закрыт")) return "2";
  return "1";
}

function firstFiasHouse(tn) {
  const raw = tn?.data?.data || {};
  const val = clean(
    raw.FIAS_LIST || tn?.data?.FIAS_LIST || tn?.data?.house_fias_list
  );
  if (!val) return null;
  return (
    val
      .split(/[;,]/)
      .map((s) => s.trim())
      .filter(Boolean)[0] || null
  );
}

function buildRegistryItemFromMesPayload(p, idx = 1) {
  const fias = clean(p.fias) || clean(p.Guid2) || clean(p.FIAS_LIST) || "";
  const st = (clean(p.status) || "").toLowerCase();
  const cond = (clean(p.condition) || "").toLowerCase();
  let kdNotif = "1";
  if (st === "п" || st.includes("план")) kdNotif = "3";
  else if (cond.includes("запитан") || cond.includes("закрыт")) kdNotif = "2";

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
  const dateFact = toIsoT(raw.F81_290_RECOVERYDATETIME || obj.recoveryDateTime);
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
async function mesUploadRegistry(items) {
  const session = await mesAuth();

  const params = {
    action: "upload",
    query: "FwdRegistryLoad",
    session,
    id_registry_ext: String(Date.now()).slice(-9),
    kd_system_contact: SYS_CONTACT,
    kd_channel: KD_CHANNEL,
    dt_campaign_beg: dayjs().format("YYYY-MM-DD"),
    dt_campaign_end: dayjs().add(3, "day").format("YYYY-MM-DD"),
    id_facility: "1",
    kd_tp_campaign: "SETI_NOTICE",
  };

  const form = new FormData();
  form.append("vl_registry", Buffer.from(JSON.stringify(items, null, 2)), {
    filename: "registry.json",
    contentType: "application/json",
  });

  // Было timeout 30000 → поднял до 60000 + ретраи
  const { data } = await withRetry(
    () =>
      axios.post(LOAD_BASE, form, {
        params,
        headers: form.getHeaders(),
        timeout: 60000,
        maxBodyLength: Infinity,
      }),
    { attempts: 3, baseDelay: 1500 }
  );

  const idRegistry = data?.data?.[0]?.id_registry;
  if (!idRegistry) throw new Error("Не получили id_registry в ответе СУВК");
  return { idRegistry, session, raw: data };
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

    const list = Array.isArray(body?.tns)
      ? body.tns
      : [body?.tn].filter(Boolean);
    if (list.length) items = list.map((tn, i) => buildRegistryItem(tn, i + 1));

    const looksLikeMes =
      body &&
      (body.date_off ||
        body.massage ||
        body.status ||
        body.condition ||
        body.fias ||
        body.Guid2 ||
        body.FIAS_LIST);
    if (!items.length && looksLikeMes)
      items = [buildRegistryItemFromMesPayload(body, 1)];

    if (!items.length) {
      return res.status(400).json({
        ok: false,
        message:
          "Передай tn/tns или MES-поля (date_off/.../condition) + fias/Guid2/FIAS_LIST",
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
        vl_registry: items,
      });
    }

    console.log(`МосЭнергоСбыт UPLOAD: строк реестра = ${items.length}`);
    const { idRegistry, session } = await mesUploadRegistry(items);
    console.log("МосЭнергоСбыт: id_registry =", idRegistry);

    auditDetails = { result: "ok", rows: items.length, id_registry: idRegistry };
    return res.json({ ok: true, id_registry: idRegistry, session });
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
        entity_id: String(req.body?.tn?.data?.number || req.body?.number || ""),
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
      AUTH_BASE: !!AUTH_BASE,
      LOAD_BASE: !!LOAD_BASE,
    });
  } catch (e) {
    return res
      .status(500)
      .json({ ok: false, message: e?.message || "ping failed" });
  }
});

// Диагностика авторизации
router.get("/auth-test", async (_req, res) => {
  try {
    const session = await mesAuth();
    return res.json({ ok: true, session });
  } catch (e) {
    const status = e?.response?.status || 502;
    return res
      .status(status)
      .json({
        ok: false,
        message: e?.message,
        code: e?.code,
        details: e?.response?.data,
      });
  }
});

module.exports = router;
