//Название файла такое серьезное 😄
require("dotenv").config();
const express = require("express");
const axios = require("axios");
const FormData = require("form-data");
const dayjs = require("dayjs");

const AUTH_BASE = process.env.MES_AUTH_URL || process.env.MES_BASE_URL;
const LOAD_BASE = process.env.MES_LOAD_URL || process.env.MES_BASE_URL;

// Быстрая валидация конфигурации на старте (логируем, но не падаем)
(function logMesEndpoints() {
  const a = AUTH_BASE ? new URL(AUTH_BASE).pathname : "—";
  const l = LOAD_BASE ? new URL(LOAD_BASE).pathname : "—";
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

// Коды по их спецификации (дефолты — МОЭ)
const SYS_CONTACT = process.env.MES_SYSTEM_CONTACT || "102"; // 1=РМР, 2=МОЭ
const KD_CHANNEL = process.env.MES_CHANNEL || "3"; // 3=ЕЛКК ФЛ
const KD_ORG = process.env.MES_ORG_CODE || "2"; // 2=МОЭ

// --- Утилиты ---
function toIsoT(v) {
  if (!v) return null;
  const d = dayjs(v);
  return d.isValid() ? d.format("YYYY-MM-DD[T]HH:mm:ss") : null;
}
function toHuman(v, withTime = false) {
  if (!v) return null;
  const d = dayjs(v);
  if (!d.isValid()) return null;
  return withTime ? d.format("YYYY-MM-DD HH:mm:ss") : d.format("YYYY-MM-DD");
}
function clean(v) {
  if (v === undefined || v === null || v === "" || v === "—") return null;
  return String(v);
}

// --- Шаг 1: auth (получить session) ---
async function mesAuth() {
  if (!AUTH_BASE || !MES_LOGIN || !MES_PASSWORD) {
    throw new Error("MES_* не настроены в .env");
  }
  const params = {
    action: "auth",
    login: MES_LOGIN,
    pwd_password: MES_PASSWORD,
  };
  const { data } = await axios.get(AUTH_BASE, { params, timeout: 15000 });
  const session = data?.data?.[0]?.session;
  if (!session) throw new Error("Не получили session от СУВК");
  return session;
}

// --- Маппинг KD_TP_NOTIFICATION (тип уведомления) ---
function mapNotification(tn) {
  const raw = tn?.data?.data || {};
  const type = clean(raw.VIOLATION_TYPE || tn?.data?.type) || "";
  const status = clean(raw.STATUS_NAME || tn?.data?.STATUS_NAME) || "";
  const t = type.toLowerCase();
  const s = status.toLowerCase();

  if (t.includes("план") || t === "п") return "3"; // плановое отключение
  if (s.includes("запитан") || s.includes("закрыт")) return "2"; // восстановление
  return "1"; // аварийное отключение
}

// --- Вытянуть первый ФИАС дома (GUID_FIAS_HOUSE) ---
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

// --- Построить строку реестра из "плоского" MES-пейлоада ---
function buildRegistryItemFromMesPayload(p, idx = 1) {
  const fias = clean(p.fias) || clean(p.Guid2) || clean(p.FIAS_LIST) || "";

  // Маппинг типа уведомления
  const st = (clean(p.status) || "").toLowerCase();
  const cond = (clean(p.condition) || "").toLowerCase();
  let kdNotif = "1";
  if (st === "п" || st.includes("план")) kdNotif = "3";
  else if (cond.includes("запитан") || cond.includes("закрыт")) kdNotif = "2";

  const item = {
    id_regline_ext: String(p.id_regline_ext || idx),
    kd_tp_client: 1,
    KD_TP_NOTIFICATION: kdNotif,
    KD_ORG: KD_ORG,
  };

  if (fias !== "") item.GUID_FIAS_HOUSE = fias;

  const dateOff = toIsoT(p.date_off);
  const datePlanOn = toIsoT(p.date_on_plan);
  const dateFactOn = toIsoT(p.date_on_fact);

  if (dateOff) item.DT_OUTAGE_TIME_PLANNED = dateOff;
  if (kdNotif === "2") {
    if (dateFactOn) item.DT_RESTORATION_TIME_PLANNED = dateFactOn;
    else if (datePlanOn) item.DT_RESTORATION_TIME_PLANNED = datePlanOn;
  } else if (datePlanOn) {
    item.DT_RESTORATION_TIME_PLANNED = datePlanOn;
  }

  const reason = clean(p.massage);
  if (reason) item.NM_REASON = reason.toLowerCase();

  return item;
}

// --- Построить одну строку реестра (vl_registry[]) ---
function buildRegistryItem(tn, idx = 1) {
  const raw = tn?.data?.data || {};
  const obj = tn?.data || {};

  const dateOff = toIsoT(raw.F81_060_EVENTDATETIME || obj.createDateTime);
  const datePlanOn = toIsoT(
    raw.F81_070_RESTOR_SUPPLAYDATETIME || obj.recoveryPlanDateTime
  );
  const dateFactOn = toIsoT(
    raw.F81_290_RECOVERYDATETIME || obj.recoveryDateTime
  );
  const reason = (
    clean(obj.description) ||
    clean(raw.DESCRIPTION) ||
    ""
  ).toLowerCase();
  const kdNotif = mapNotification(tn);
  const fias = firstFiasHouse(tn);
  const item = {
    id_regline_ext: String(obj.documentId || obj.id || idx), // внешний id строки
    kd_tp_client: 1, // 1 = ФЛ (дефолт)
    KD_TP_NOTIFICATION: kdNotif, // обязателен
    KD_ORG: KD_ORG, // 2 = МОЭ
  };

  // Даты
  if (dateOff) item.DT_OUTAGE_TIME_PLANNED = dateOff;
  if (kdNotif === "2") {
    // восстановление
    if (dateFactOn) item.DT_RESTORATION_TIME_PLANNED = dateFactOn;
    else if (datePlanOn) item.DT_RESTORATION_TIME_PLANNED = datePlanOn;
  } else if (datePlanOn) {
    item.DT_RESTORATION_TIME_PLANNED = datePlanOn;
  }

  if (reason) item.NM_REASON = reason; // примечание: нижний регистр

  return item;
}

// --- Шаг 2: upload реестра ---
async function mesUploadRegistry(items) {
  const session = await mesAuth();

  const params = {
    action: "upload",
    query: "FwdRegistryLoad",
    session,
    id_registry_ext: String(Date.now()).slice(-9), // внешний id реестра
    kd_system_contact: SYS_CONTACT, // 2 = МОЭ
    kd_channel: KD_CHANNEL, // 3 = ЕЛКК ФЛ
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

  const { data } = await axios.post(LOAD_BASE, form, {
    params,
    headers: form.getHeaders(),
    timeout: 30000,
    maxBodyLength: Infinity,
  });

  const idRegistry = data?.data?.[0]?.id_registry;
  if (!idRegistry) {
    throw new Error("Не получили id_registry в ответе СУВК");
  }
  return { idRegistry, session, raw: data };
}

// --- Шаг 3: проверка статуса ---
async function mesCheckStatus({ session, idRegistry }) {
  const { data } = await axios.get(LOAD_BASE, {
    params: {
      query: "FwdRegistryCheckStatus",
      session,
      id_registry: idRegistry,
    },
    timeout: 15000,
  });
  return data;
}

// ===== РОУТЫ =====

// Отправка: принимает tn/tns (старый формат) ИЛИ "плоский" MES-пейлоад; собирает vl_registry и грузит в СУВК
router.post("/upload", express.json({ limit: "20mb" }), async (req, res) => {
  try {
    const body = req.body || {};
    let items = [];

    // Вариант 1: старый формат (tn/tns)
    const list = Array.isArray(body?.tns)
      ? body.tns
      : [body?.tn].filter(Boolean);
    if (list.length) {
      items = list.map((tn, i) => buildRegistryItem(tn, i + 1));
    }

    // Вариант 2: "плоский" MES-пейлоад (date_off...condition + fias/Guid2/FIAS_LIST)
    const looksLikeMes =
      body &&
      (body.date_off ||
        body.massage ||
        body.status ||
        body.condition ||
        body.fias ||
        body.Guid2 ||
        body.FIAS_LIST);
    if (!items.length && looksLikeMes) {
      items = [buildRegistryItemFromMesPayload(body, 1)];
    }

    if (!items.length) {
      return res.status(400).json({
        ok: false,
        message: "Передай tn/tns или MES-поля (date_off/.../condition) + fias",
      });
    }

    // Имитация только ЯВНО: ?dryRun=1 (переменная окружения игнорируется)
    if (req.query.dryRun === "1") {
      const fakeId = `TEST-${Date.now()}`;
      console.log(
        `МосЭнергоСбыт DRY-RUN: строк реестра = ${items.length}, id_registry = ${fakeId}`
      );
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

    return res.json({ ok: true, id_registry: idRegistry, session });
  } catch (e) {
    console.error("Ошибка UPLOAD MES:", e?.message);
    return res
      .status(502)
      .json({ ok: false, message: e?.message || "Ошибка загрузки" });
  }
});

// Проверка статуса по session и id_registry
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
    console.error("Ошибка CHECK MES:", e?.message);
    return res
      .status(502)
      .json({ ok: false, message: e?.message || "Ошибка проверки статуса" });
  }
});

// Простая проверка конфигурации и доступности
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

module.exports = router;
