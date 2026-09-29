//123
const { exec } = require("node:child_process");
const express = require("express");
const axios = require("axios");
const { broadcast } = require("../services/sse");
const { buildAutoDescription } = require("../services/autoDescription");
const { buildEddsPayload } = require("../services/modus/eddsPayload");
const {
  buildEddsNewPayload,
  buildEddsNewDescription,
  mapEddsValidationErrors,
} = require("../services/modus/eddsNewPayload");
const { resolveAccidentLocation } = require("../services/edds/resolveAccidentLocation");
const {
  extractFiasList,
  upsertAddressesInStrapi,
} = require("../services/modus/addresses");
const { getJwt, fetchTnDescriptionById } = require("../services/modus/strapi");
require("dotenv").config();

// ── Журнал отправок (zhurnal-otpravkis) ─────────────────────────────────────
const URL_STRAPI = process.env.URL_STRAPI;
const LOGIN_STRAPI = process.env.LOGIN_STRAPI;
const PASSWORD_STRAPI = process.env.PASSWORD_STRAPI;
const EDDS_URL = process.env.EDDS_URL;
const EDDS_URL_PUT = process.env.EDDS_URL_PUT;
const EDDS_TOKEN = process.env.EDDS_TOKEN;

function parseJournalData(item) {
  const id = item.id;
  const documentId = item.documentId || item.documentID || item.document_id || null;
  const dataField = item.data ?? item.attributes?.data;
  let list = [];
  if (Array.isArray(dataField)) list = dataField.slice();
  else if (typeof dataField === "string") list = [dataField];
  else if (dataField && typeof dataField === "object" && Array.isArray(dataField.lines)) list = dataField.lines.slice();
  return { id, documentId, list };
}

async function getOrCreateJournalByIndex(jwt, index) {
  if (!URL_STRAPI || !jwt) return null;
  try {
    const r = await axios.get(
      `${URL_STRAPI}/api/zhurnal-otpravkis?pagination[page]=1&pagination[pageSize]=10&sort=createdAt:asc`,
      { headers: { Authorization: `Bearer ${jwt}` }, timeout: 15000 }
    );
    const arr = r?.data?.data || [];
    if (arr.length > index) {
      return parseJournalData(arr[index]);
    }
    const c = await axios.post(
      `${URL_STRAPI}/api/zhurnal-otpravkis`,
      { data: { data: [] } },
      { headers: { Authorization: `Bearer ${jwt}` }, timeout: 15000 }
    );
    const id = c?.data?.data?.id;
    const documentId = c?.data?.data?.documentId || null;
    return id ? { id, documentId, list: [] } : null;
  } catch (e) {
    console.warn("[modus][journal] Не удалось получить/создать запись журнала:", e?.response?.status || e?.message);
    return null;
  }
}

async function getOrCreateJournalSingle(jwt) {
  return getOrCreateJournalByIndex(jwt, 0);
}

async function getOrCreatePlannedJournal(jwt) {
  return getOrCreateJournalByIndex(jwt, 1);
}

async function appendToJournal(line, jwt, isPlanned) {
  const rec = isPlanned
    ? await getOrCreatePlannedJournal(jwt)
    : await getOrCreateJournalSingle(jwt);
  if (!rec) return;
  const MAX = 2000;
  const list = rec.list || [];
  list.push(line);
  while (list.length > MAX) list.shift();
  const targetId = rec.documentId || rec.id;
  const urlBase = `${URL_STRAPI}/api/zhurnal-otpravkis`;
  try {
    await axios.put(
      `${urlBase}/${targetId}`,
      { data: { data: list } },
      { headers: { Authorization: `Bearer ${jwt}` }, timeout: 20000 }
    );
  } catch (e) {
    if (rec.documentId && rec.id && e?.response?.status === 404) {
      await axios.put(
        `${urlBase}/${rec.id}`,
        { data: { data: list } },
        { headers: { Authorization: `Bearer ${jwt}` }, timeout: 20000 }
      );
    } else {
      throw e;
    }
  }
}

function fmtRu(dt) {
  try {
    const d = dt ? new Date(dt) : new Date();
    return d.toLocaleString("ru-RU", {
      timeZone: "Europe/Moscow",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    }).replace(",", "");
  } catch { return ""; }
}

async function saveEdsRequestId(guid, requestId, jwt) {
  if (!jwt) return;
  try {
    const search = await axios.get(`${URL_STRAPI}/api/teh-narusheniyas`, {
      headers: { Authorization: `Bearer ${jwt}` },
      params: { "filters[guid][$eq]": guid, "pagination[pageSize]": 1 },
    });
    const found = search?.data?.data?.[0];
    const documentId = found?.documentId || found?.id;
    if (!documentId) {
      console.warn(`[modus] ТН с GUID=${guid} не найдена в Strapi, edds_electricityRequestId не сохранён`);
      return;
    }
    await axios.put(
      `${URL_STRAPI}/api/teh-narusheniyas/${documentId}`,
      { data: { edds_electricityRequestId: requestId } },
      { headers: { Authorization: `Bearer ${jwt}` } }
    );
    console.log(`[modus] edds_electricityRequestId=${requestId} для GUID=${guid}`);
  } catch (e) {
    console.warn("[modus] Ошибка сохранения edds_electricityRequestId:", e?.response?.status || e?.message);
  }
}

const EDDS_FIELD_TO_MODUS = {
  plan_date_close: "REPAIRDATETIME",
  externalId: "VIOLATION_GUID_STR",
  equipmentType: "OBJECTTYPE81/VOLTAGECLASS",
  equipmentName: "F81_041_ENERGOOBJECTNAME",
  districtFiasIds: "DISTRICT/SCNAME",
  "shutdownInfo.shutdownType": "VIOLATION_TYPE",
  "shutdownInfo.disabledAt": "F81_060_EVENTDATETIME",
  "shutdownInfo.plannedInclusionAt": "REPAIRDATETIME",
  "shutdownInfo.fiasIds": "FIAS_LIST",
  "shutdownInfo.reasons": "BRIGADE_ACTION",
  "affectedObjectsCount.peopleCount": "POPULATION_COUNT",
  "affectedObjectsCount.placesCount": "SETTLEMENT_COUNT",
  count_people: "POPULATION_COUNT",
  district_id: "DISTRICT/SCNAME",
  time_create: "F81_060_EVENTDATETIME",
  accidentLocation: "FIAS_LIST (координаты через DaData/Dadata)",
};

function formatFieldErrors(parsed) {
  const parts = [];

  const data = parsed?.data;
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const entries = Object.entries(data).filter(([, v]) => Array.isArray(v) && v.length);
    for (const [field, msgs] of entries) {
      const modusField = EDDS_FIELD_TO_MODUS[field] || "?";
      parts.push(`${field}(${modusField})=${msgs[0]}`);
    }
  }

  const errors = parsed?.errors;
  if (Array.isArray(errors)) {
    for (const err of errors) {
      const path = err?.path || "?";
      const msg = err?.error || err?.message || "ошибка";
      const modusField = EDDS_FIELD_TO_MODUS[path] || "?";
      parts.push(`${path}(${modusField})=${msg}`);
    }
  }

  return parts.length ? parts.join('; ') : null;
}

async function writeEdsJournal({ guid, tnNumber, target, httpCode, parsed, isPlanned }) {
  try {
    const jwt = await getJwt();
    if (!jwt) return;
    const human = fmtRu(new Date());
    let msg = "";
    if (httpCode >= 200 && httpCode < 300) {
      msg = parsed?.data?.id ? `Данные приняты (id: ${parsed.data.id})` : "Данные приняты";
    } else {
      msg = parsed?.message || `HTTP ${httpCode}`;
      const fieldDetails = formatFieldErrors(parsed);
      if (fieldDetails) msg += ` [${fieldDetails}]`;
      else if (parsed?.data && typeof parsed.data === 'string') msg += ` [${parsed.data}]`;
      else if (parsed?.error) msg += ` [${parsed.error}]`;
    }
    const line = `№${tnNumber ?? "—"} - ${guid ?? "—"} - ${human} - ${target} - ${msg}`;
    await appendToJournal(line, jwt, !!isPlanned);
    console.log(`[modus][journal]${isPlanned ? " (плановая)" : ""} запись добавлена: ${line}`);
  } catch (e) {
    console.warn("[modus][journal] ошибка записи:", e?.response?.status || e?.message);
  }
}

function logEddsV2AsyncError(prefix, e) {
  console.error(prefix, e?.stack || e?.code || e?.message || e);
}

// ── Поэтапное логирование (Этап N — Название) ───────────────────────────────
function createStageLogger(prefix, sharedStages) {
  const stages = sharedStages || [];
  return {
    start(num, name) {
      const stage = { num, name, status: "pending", error: null };
      stages.push(stage);
      console.log(`[${prefix}] Этап ${num} — ${name}...`);
      return stage;
    },
    success(stage, detail) {
      stage.status = "success";
      console.log(`[${prefix}] Этап ${stage.num} — ${stage.name} ✓${detail ? " " + detail : ""}`);
    },
    fail(stage, error) {
      stage.status = "error";
      stage.error = String(error || "неизвестная ошибка");
      console.error(`[${prefix}] Этап ${stage.num} — ${stage.name} ✗ ${stage.error}`);
    },
    skip(stage, reason) {
      stage.status = "skipped";
      console.log(`[${prefix}] Этап ${stage.num} — ${stage.name} ⊘ ${reason || "пропущен"}`);
    },
    summary() {
      const line = "═".repeat(60);
      console.log(`\n${line}`);
      console.log(`  ИТОГ [${prefix}]`);
      console.log(line);
      for (const s of stages) {
        const icon = s.status === "success" ? "✓" : s.status === "error" ? "✗" : s.status === "skipped" ? "⊘" : "…";
        const tail = s.error ? ` — ${s.error}` : "";
        const msg = `  Этап ${s.num} — ${s.name} ${icon}${tail}`;
        if (s.status === "error") console.error(msg);
        else console.log(msg);
      }
      const errors = stages.filter((s) => s.status === "error");
      if (errors.length) {
        console.error(`  ⚠ ОШИБКА: ${errors.map((e) => `Этап ${e.num} (${e.name})`).join(", ")}`);
      } else {
        console.log(`  ✅ Все этапы пройдены`);
      }
      console.log(`${line}\n`);
    },
  };
}

function writeEddsV2AsyncErrorJournal({ guid, tnNumber, target, e }) {
  const message = e?.message || e?.code || "Ошибка до ответа ЕДДС v2";
  return writeEdsJournal({
    guid,
    tnNumber,
    target,
    httpCode: 0,
    parsed: { message },
    isPlanned: true,
  }).catch((journalError) => {
    console.warn("[modus][journal] ошибка записи ошибки ЕДДС v2:", journalError?.message || journalError);
  });
}

function writeEddsV2CurlErrorJournal({ guid, tnNumber, target, err, stderr }) {
  const code = err?.code != null ? err.code : "unknown";
  const message = `curl error ${code}`;
  const error = String(stderr || err?.message || "").trim();
  return writeEdsJournal({
    guid,
    tnNumber,
    target,
    httpCode: 0,
    parsed: error ? { message, error } : { message },
    isPlanned: true,
  }).catch((journalError) => {
    console.warn("[modus][journal] ошибка записи curl-ошибки ЕДДС v2:", journalError?.message || journalError);
  });
}

const PLANNED_EDDS_TRANSPORT = "v1"; // "v2" вернет прямую отправку плановых в ЕДДС v2.
const PLANNED_EDDS_SEND_PAUSED = false; // true временно поставит отправку плановых на паузу.
const PLANNED_EDDS_PAUSE_MESSAGE =
  "Отправки временно приостановлены: не отправлено";

function jsonForShell(data) {
  return JSON.stringify(data).replace(/'/g, `'\\''`);
}

function isDuplicateEddsV1Error(resp) {
  try {
    const msg = String(
      (resp?.parsed && (resp.parsed.message || resp.parsed.error)) || resp?.stdout || ""
    );
    return /существует|уже существует/i.test(msg);
  } catch {
    return false;
  }
}

function normStatus(s) {
  return String(s || "")
    .trim()
    .toLowerCase();
}

function plannedStatusToEddsV1Status(statusName) {
  const status = normStatus(statusName);
  if (status === "начата") return "2";
  if (["закрыта", "удалена"].includes(status)) return "4";
  return null;
}

function isPlannedEddsV1CreateOrUpdateStatus(statusName) {
  return ["начата", "закрыта"].includes(normStatus(statusName));
}

function buildPlannedEddsV1Payload(item) {
  const payload = buildEddsPayload({ data: item });
  if (!payload) return null;

  const raw = item?.data || {};
  const statusName = String(item?.STATUS_NAME || raw?.STATUS_NAME || "")
    .trim()
    .toLowerCase();
  const statusCode = plannedStatusToEddsV1Status(statusName);
  if (!statusCode) return null;

  payload.type = "3";
  payload.status = statusCode;

  const description = buildEddsNewDescription({ data: item });
  if (description) {
    payload.description = description;
  }

  return payload;
}

function runEddsV1Curl(url, payload, { target }) {
  return new Promise((resolve) => {
    try {
      if (!url) {
        return resolve({
          ok: false,
          code: "NO_URL",
          stderr: "EDDS_URL не задан в .env",
        });
      }
      if (!EDDS_TOKEN) {
        return resolve({
          ok: false,
          code: "NO_TOKEN",
          stderr: "EDDS_TOKEN не задан в .env",
        });
      }

      const command =
        `curl -sS -X POST ` +
        `-H "Content-Type: application/json" ` +
        `-H "HTTP-X-API-TOKEN: ${EDDS_TOKEN}" ` +
        `-d '${jsonForShell(payload)}' ` +
        `-w "\\nHTTP_CODE:%{http_code}" ` +
        `"${url}" --insecure`;

      exec(command, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          const code = err.code != null ? err.code : "unknown";
          console.error(`[${target}] ✗ curl error code=${code}`);
          if (stderr) console.error(`    ${stderr}`);
          return resolve({ ok: false, code, stdout: stdout || "", stderr: stderr || "" });
        }

        let httpCode = null;
        let body = stdout;
        const codeMatch = stdout.match(/\nHTTP_CODE:(\d+)/);
        if (codeMatch) {
          httpCode = Number(codeMatch[1]);
          body = stdout.slice(0, codeMatch.index).trim();
        }

        let parsed = null;
        try { parsed = JSON.parse(body); } catch { /* raw */ }

        resolve({ ok: true, httpCode, parsed, stdout: body });
      });
    } catch (e) {
      return resolve({ ok: false, code: "EXCEPTION", stderr: e.message });
    }
  });
}

async function sendPlannedEddsV1({ item, guid, tnNumber, mode = "create" }) {
  const target = mode === "update" ? "ЕДДС v1 update" : "ЕДДС v1";
  const payload = buildPlannedEddsV1Payload(item);
  if (!payload) {
    await writeEdsJournal({
      guid,
      tnNumber,
      target,
      httpCode: 0,
      parsed: { message: "Не удалось сформировать JSON для ЕДДС v1" },
      isPlanned: true,
    });
    return;
  }

  try {
    const locationResult = await resolveAccidentLocation(payload);
    if (locationResult.ok) {
      payload.accidentLocation = locationResult.accidentLocation;
      console.log(
        `[planned→edds-v1] accidentLocation=${JSON.stringify(locationResult.accidentLocation)}`
      );
    } else {
      console.warn(`[planned→edds-v1] accidentLocation: ${locationResult.message} — отправка продолжается`);
    }
  } catch (e) {
    console.warn(`[planned→edds-v1] accidentLocation error: ${e?.message} — отправка продолжается`);
  }

  const primaryUrl = mode === "update" ? EDDS_URL_PUT || EDDS_URL : EDDS_URL;
  const fallbackUrl = mode !== "update" && EDDS_URL_PUT ? EDDS_URL_PUT : null;

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  Плановая ЕДДС v1 ${mode} → payload (${Object.keys(payload).length} полей)`);
  console.log(`${"═".repeat(60)}`);
  console.log(JSON.stringify(payload, null, 2));
  console.log(`${"═".repeat(60)}\n`);

  let resp = await runEddsV1Curl(primaryUrl, payload, { target });
  let finalTarget = target;

  if (resp.ok && resp.parsed?.success === false && fallbackUrl && isDuplicateEddsV1Error(resp)) {
    console.log("[planned→edds-v1] Дубликат — пробуем update.php");
    resp = await runEddsV1Curl(fallbackUrl, payload, { target: "ЕДДС v1 update" });
    finalTarget = "ЕДДС v1 update";
  }

  const httpCode = resp.httpCode || 0;
  const parsed = resp.parsed || {
    message: resp.stderr || resp.stdout || resp.code || "Ошибка отправки ЕДДС v1",
  };
  const ok =
    resp.ok &&
    httpCode >= 200 &&
    httpCode < 300 &&
    (parsed?.success === true || parsed?.data?.claim_id || parsed?.claim_id);

  console.log(
    `[planned→edds-v1] GUID=${guid || "—"} HTTP=${httpCode || "—"} ok=${ok} target=${finalTarget}`
  );
  if (!ok) {
    console.warn(`[planned→edds-v1] Ответ ЕДДС v1: ${JSON.stringify(parsed)}`);
  }

  const journalHttpCode = ok ? httpCode : httpCode >= 200 ? 400 : httpCode;
  await writeEdsJournal({
    guid,
    tnNumber,
    target: finalTarget,
    httpCode: journalHttpCode,
    parsed,
    isPlanned: true,
  });
}

function writePlannedEddsPausedJournal({ guid, tnNumber, target }) {
  console.warn(
    `[${target}] GUID=${guid || "—"} №${tnNumber || "—"} — ${PLANNED_EDDS_PAUSE_MESSAGE}`
  );
  return writeEdsJournal({
    guid,
    tnNumber,
    target,
    httpCode: 0,
    parsed: { message: PLANNED_EDDS_PAUSE_MESSAGE },
    isPlanned: true,
  }).catch((journalError) => {
    console.warn(
      "[modus][journal] ошибка записи паузы плановой отправки ЕДДС:",
      journalError?.message || journalError
    );
  });
}
// ─────────────────────────────────────────────────────────────────────────────

const router = express.Router();
const secretModus = process.env.SECRET_FOR_MODUS;

const isAuthorized = (req) => {
  const raw = (
    req.get("authorization") ||
    req.get("Authorization") ||
    ""
  ).trim();
  const match = /^Bearer\s+(.+)$/i.exec(raw);
  const token = match ? match[1].trim() : "";
  const ok = token && token === String(secretModus || "");
  if (!ok) {
    const mask = (s) => (s ? `${s.slice(0, 4)}…${s.slice(-4)}` : "<empty>");
    console.warn(
      "[modus] Доступ запрещен: token=",
      mask(token),
      " ожидался=",
      mask(String(secretModus || ""))
    );
  }
  return ok;
};

const urlStrapi = process.env.URL_STRAPI;

const norm = (s) =>
  String(s || "")
    .trim()
    .toLowerCase();
const parseBaseType = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return parsed === 0 || parsed === 1 ? parsed : null;
};
const isFinalStatus = (s) =>
  ["закрыта", "запитана", "удалена"].includes(norm(s));

router.put("/", async (req, res) => {
  const sharedStages = [];
  const slog = createStageLogger("PUT", sharedStages);
  try {
    // Этап 1 — Авторизация
    const st1 = slog.start(1, "Авторизация (Bearer SECRET_FOR_MODUS)");
    if (!isAuthorized(req)) {
      slog.fail(st1, "Неверный или отсутствующий токен");
      slog.summary();
      return res.status(403).json({ status: "Forbidden" });
    }
    slog.success(st1);

    // Этап 2 — Валидация тела запроса
    const st2 = slog.start(2, "Валидация тела запроса (Data/data массив)");
    const items = req.body.data || req.body.Data;
    if (!items || !Array.isArray(items) || items.length === 0) {
      slog.fail(st2, "Не хватает требуемых данных (ожидается Data или data: массив)");
      slog.summary();
      return res.status(400).json({
        status: "error",
        message:
          "Не хватает требуемых данных (ожидается Data или data: массив)",
      });
    }
    slog.success(st2, `получено элементов: ${items.length}`);

    const mapItem = (item) => {
      const status = (item.STATUS_NAME || "").toString().trim().toLowerCase();
      const isActive = status === "открыта";
      const baseType = parseBaseType(item.BASE_TYPE);
      const mapped = {
        guid: item.VIOLATION_GUID_STR,
        number: `${item.F81_010_NUMBER}`,
        energoObject: item.F81_041_ENERGOOBJECTNAME,
        createDateTime: item.F81_060_EVENTDATETIME,
        recoveryPlanDateTime: item.REPAIRDATETIME,
        repairDateTime: item.REPAIRDATETIME,
        addressList: item.ADDRESS_LIST,
        // description: item.F81_042_DISPNAME,
        recoveryFactDateTime: item.F81_290_RECOVERYDATETIME,
        factRestoreDateTime: item.F81_070_RESTOR_SUPPLAYDATETIME,
        normalizationDateTime: item.F81_290_RECOVERYDATETIME,
        dispCenter: item.DISPCENTER_NAME_,
        STATUS_NAME: (item.STATUS_NAME || "").toString().trim(),
        isActive,
        data: item,
      };
      if (baseType !== null) {
        mapped.BASE_TYPE = baseType;
      }
      return mapped;
    };

    const buildPatch = (current, next) => {
      const patch = {};
      Object.keys(next).forEach((key) => {
        const prevVal = current?.[key];
        const nextVal = next[key];
        const eq =
          typeof nextVal === "object" && nextVal !== null
            ? JSON.stringify(prevVal) === JSON.stringify(nextVal)
            : prevVal === nextVal;
        if (!eq && nextVal !== undefined) patch[key] = nextVal;
      });
      return patch;
    };

    // Этап 3 — Strapi JWT
    const st3 = slog.start(3, "Авторизация в Strapi (JWT)");
    const jwt = await getJwt();
    if (!jwt) {
      slog.fail(st3, "Не удалось авторизоваться в Strapi");
      slog.summary();
      return res.status(500).json({
        status: "error",
        message: "Не удалось авторизоваться в Strapi",
      });
    }
    slog.success(st3);

    const fiasSet = new Set();
    let itemCounter = 0;

    const results = await items.reduce(async (prevPromise, rawItem, index) => {
      const acc = await prevPromise;
      itemCounter++;
      const islg = createStageLogger(`PUT[${index + 1}]`, sharedStages);

      // Этап 4 — Маппинг полей МОДУС → внутренняя форма
      const st4 = islg.start(4, "Маппинг полей МОДУС → внутренняя форма");
      const mapped = mapItem(rawItem);
      islg.success(st4, `guid=${mapped.guid || "нет"}`);

      try {
        const fiasCodes = extractFiasList(rawItem);
        fiasCodes.forEach((id) => fiasSet.add(id));
      } catch (e) {
        console.warn(
          `[PUT] Ошибка при извлечении FIAS для элемента ${index + 1}:`,
          e.message
        );
      }

      if (!mapped.guid) {
        islg.fail(islg.start(5, "Проверка GUID"), "Не передан GUID записи");
        acc.push({
          success: false,
          index: index + 1,
          error: "Не передан GUID записи",
        });
        return acc;
      }

      try {
        // Этап 5 — Поиск записи в Strapi + расчёт веток
        const st5 = islg.start(5, "Поиск записи в Strapi + расчёт веток");
        const search = await axios.get(`${urlStrapi}/api/teh-narusheniyas`, {
          headers: { Authorization: `Bearer ${jwt}` },
          params: {
            "filters[guid][$eq]": mapped.guid,
            "pagination[pageSize]": 1,
            "populate": "*",
          },
        });

        const found = search?.data?.data?.[0];
        const documentId = found?.documentId || found?.id;
        const current = found || {};
        const currentAttrs = current?.attributes || current || {};
        const currentRaw = currentAttrs?.data || current?.data || {};
        const prevStatus = norm(
          current?.STATUS_NAME || current?.attributes?.STATUS_NAME
        );
        const nextStatus = norm(mapped?.STATUS_NAME);
        const statusChanged = prevStatus !== nextStatus;
        const nextIsFinal = isFinalStatus(nextStatus);
        const nextBaseType =
          parseBaseType(mapped?.BASE_TYPE) ??
          parseBaseType(currentAttrs?.BASE_TYPE) ??
          parseBaseType(currentRaw?.BASE_TYPE);
        const needEdds = statusChanged && nextIsFinal && nextBaseType === 0;
        const existingEdsRequestId = current?.edds_electricityRequestId || currentAttrs?.edds_electricityRequestId || null;
        const isPlanned = nextBaseType === 1;
        const nextIsPlannedCreateOrUpdateStatus =
          isPlannedEddsV1CreateOrUpdateStatus(nextStatus);
        const needEddsDelete =
          isPlanned &&
          statusChanged &&
          nextStatus === "удалена" &&
          !!existingEdsRequestId;
        const needEddsPlanned =
          isPlanned &&
          statusChanged &&
          nextIsPlannedCreateOrUpdateStatus &&
          !needEddsDelete;
        const needEddsRestore =
          statusChanged &&
          !existingEdsRequestId &&
          isPlanned &&
          prevStatus === "удалена" &&
          nextIsPlannedCreateOrUpdateStatus;

        islg.success(st5, `documentId=${documentId || "не найден"} baseType=${nextBaseType} statusChanged=${statusChanged} needEdds=${needEdds} needEddsPlanned=${needEddsPlanned} needEddsDelete=${needEddsDelete} needEddsRestore=${needEddsRestore}`);

        if (!documentId) {
          islg.fail(st5, "Запись с таким GUID не найдена");
          acc.push({
            success: false,
            index: index + 1,
            status: "not_found",
            error: "Запись с таким GUID не найдена",
          });
          return acc;
        }

        // Этап 6 — Сборка patch (diff + merge raw JSON + auto-description)
        const st6 = islg.start(6, "Сборка patch (diff + merge raw JSON + auto-description)");
        // Сначала считаем обычный патч по всем полям
        let patch = buildPatch(current, mapped);

        // Всегда объединяем сырые данные: то, что прилетело из MODUS (mapped.data),
        // накладываем поверх того, что уже хранится в Strapi (currentRaw)
        // null/пустые строки из incoming НЕ затирают существующие значения
        const incomingRaw = mapped.data || {};
        const cleanedIncoming = Object.fromEntries(
          Object.entries(incomingRaw).filter(([, v]) => v !== null && v !== "")
        );
        const mergedRaw = { ...(currentRaw || {}), ...cleanedIncoming };
        const rawChanged = JSON.stringify(mergedRaw) !== JSON.stringify(currentRaw || {});
        if (rawChanged) {
          patch.data = mergedRaw;
        }

        // Если статус стал финальным и нужно отправлять в ЕДДС —
        // не урезаем патч, а лишь гарантируем, что статусные поля совпадают
        if (needEdds) {
          if (currentAttrs?.STATUS_NAME !== mapped.STATUS_NAME) {
            patch.STATUS_NAME = mapped.STATUS_NAME;
          }
          const nextIsActive = nextStatus === "открыта";
          if (currentAttrs?.isActive !== nextIsActive) {
            patch.isActive = nextIsActive;
          }
          // и дублируем STATUS_NAME внутрь raw-объекта
          if ((mergedRaw?.STATUS_NAME || "") !== mapped.STATUS_NAME) {
            patch.data = { ...mergedRaw, STATUS_NAME: mapped.STATUS_NAME };
          }
        }
        // ── Auto‑description on update: fill only when empty (never overwrite manual edits) ──
        try {
          const isEmptyDesc = (t) => {
            const s = String(t ?? "").trim();
            return !s || s === "—";
          };

          const currentDesc = currentAttrs?.description ?? "";

          // Сохраняем оригинальное описание MODUS для "Исходник"
          const rawModusDesc = String(mergedRaw?.description ?? "").trim();
          const currentRawDesc = currentAttrs?.raw_description ?? "";
          if (rawModusDesc && isEmptyDesc(currentRawDesc)) {
            patch = patch || {};
            patch.raw_description = rawModusDesc;
          }

          // Если описание пустое — генерим автоописание. Если дежурный редактировал — не трогаем.
          if (isEmptyDesc(currentDesc)) {
            const nextAuto = buildAutoDescription({
              ...(mergedRaw || {}),
            });

            if (nextAuto && String(nextAuto).trim()) {
              patch = patch || {};
              patch.description = nextAuto;
            }
          }
        } catch (e) {
          console.warn("[PUT] autoDescription generation skipped:", e?.message);
        }
        islg.success(st6, `полей в patch: ${Object.keys(patch).length}`);

        if (Object.keys(patch).length === 0) {
          islg.skip(islg.start(7, "Запись в Strapi (PUT)"), "Изменений нет");
          acc.push({
            success: true,
            index: index + 1,
            id: documentId,
            updated: false,
            message: "Изменений нет",
          });
          return acc;
        }

        // Этап 7 — Запись в Strapi (PUT)
        const st7 = islg.start(7, "Запись в Strapi (PUT /api/teh-narusheniyas)");
        const upd = await axios.put(
          `${urlStrapi}/api/teh-narusheniyas/${documentId}`,
          { data: patch },
          { headers: { Authorization: `Bearer ${jwt}` } }
        );
        islg.success(st7, `documentId=${documentId}`);

        // Этап 8 — SSE-уведомление
        const st8 = islg.start(8, "SSE-уведомление (tn-upsert)");
        try {
          broadcast({
            type: "tn-upsert",
            source: "modus",
            action: "update",
            id: documentId,
            guid: mapped.guid,
            patch,
            timestamp: Date.now(),
          });
          islg.success(st8);
        } catch (e) {
          islg.fail(st8, e?.message);
        }
        if (needEdds) {
          // Этап 9 — Отправка в ЕДДС (авария, BASE_TYPE=0)
          const st9 = islg.start(9, "Отправка в ЕДДС v1 (авария, через /services/edds)");
          let strapiTn = null;
          try {
            const rFull = await axios.get(`${urlStrapi}/api/teh-narusheniyas`, {
              headers: { Authorization: `Bearer ${jwt}` },
              params: {
                "filters[guid][$eq]": mapped.guid,
                "pagination[pageSize]": 1,
                populate: "*",
              },
            });
            const full = rFull?.data?.data?.[0];
            strapiTn = full?.attributes || full || null;
          } catch (e) {
            console.warn(
              `[modus→edds] Не удалось подтянуть полную запись из Strapi по guid=${mapped.guid}:`,
              e?.response?.status || e?.message
            );
          }

          if (!strapiTn) {
            strapiTn = { ...mapped };
          }

          const mergedForPayload = { ...strapiTn };
          if (mapped?.STATUS_NAME != null)
            mergedForPayload.STATUS_NAME = mapped.STATUS_NAME;
          if (mapped?.recoveryFactDateTime != null)
            mergedForPayload.recoveryFactDateTime = mapped.recoveryFactDateTime;
          if (mapped?.recoveryPlanDateTime != null)
            mergedForPayload.recoveryPlanDateTime = mapped.recoveryPlanDateTime;
          if (mapped?.createDateTime != null)
            mergedForPayload.createDateTime = mapped.createDateTime;
          const payload = buildEddsPayload({ data: mergedForPayload });
          try {
            const dbg = {
              mergedForPayload,
              eddsPayload: payload,
            };
            const snap = JSON.stringify(dbg);
            const snapClip =
              snap.length > 4000
                ? snap.slice(0, 4000) + `… (${snap.length} chars)`
                : snap;
            console.log(`[modus→edds] payload snapshot: ${snapClip}`);
          } catch (e) {
            console.warn(
              "[modus→edds] Не удалось сформировать debug snapshot:",
              e?.message
            );
          }

          const explicitSelf = String(process.env.SELF_EDDS_URL || "").trim();
          const port = Number(
            process.env.PORT || process.env.BACK_PORT || 3110
          );
          const protocol = req.protocol || "http";
          const host = req.get("host");
          const qs = "debug=1";
          const candidates = [
            explicitSelf && `${explicitSelf}?${qs}`,
            `http://127.0.0.1:${port}/services/edds?${qs}`,
            `http://localhost:${port}/services/edds?${qs}`,
            `${protocol}://${host}/services/edds?${qs}`,
            `${protocol}://${host}/api/services/edds?${qs}`,
          ].filter(Boolean);

          console.log(`[modus→edds] candidates: ${candidates.join(", ")}`);
          islg.success(st9, `payload сформирован, self-POST через setTimeout`);
          setTimeout(async () => {
            const asyncSlog = createStageLogger(`PUT[${index + 1}→EDDS]`);
            const ast = asyncSlog.start(1, "Доставка в /services/edds (self-POST)");
            let delivered = false;

            for (const url of candidates) {
              try {
                const resp = await axios.post(url, payload, {
                  headers: { Authorization: `Bearer ${jwt}` },
                  timeout: 30000,
                  validateStatus: () => true,
                });

                const body =
                  typeof resp?.data === "string"
                    ? resp.data
                    : JSON.stringify(
                        resp?.data ?? resp?.statusText ?? "",
                        null,
                        2
                      );
                const bodyClip =
                  body.length > 4000
                    ? body.slice(0, 4000) + `… (${body.length} chars)`
                    : body;

                console.log(
                  `[modus→edds] try ${url} → HTTP ${resp?.status}; body=${bodyClip}`
                );
                if (resp?.status !== 404) {
                  const claimId =
                    resp?.data?.data?.claim_id ?? resp?.data?.claim_id;
                  const ok =
                    resp?.status >= 200 &&
                    resp?.status < 300 &&
                    (resp?.data?.success === true || !!claimId);

                  if (ok) {
                    asyncSlog.success(ast, `claim_id=${claimId || "—"}`);
                    console.log(
                      `[modus→edds] ✅ GUID=${mapped.guid} отправлен в ЕДДС через ${url}` +
                        (claimId ? `; claim_id=${claimId}` : "")
                    );
                  } else {
                    asyncSlog.fail(ast, `HTTP ${resp?.status}; success=${resp?.data?.success}; message=${resp?.data?.message}`);
                    console.warn(
                      `[modus→edds] ❌ ЕДДС не приняла GUID=${mapped.guid}: HTTP ${resp?.status}; success=${resp?.data?.success}; message=${resp?.data?.message}; тело=${bodyClip}`
                    );
                  }

                  delivered = true;
                  break;
                }
              } catch (e) {
                const code = e?.response?.status || e?.code || e?.message;
                console.warn(
                  `[modus→edds] Ошибка запроса ${url} для GUID=${mapped.guid}: ${code}`
                );
              }
            }

            if (!delivered) {
              asyncSlog.fail(ast, "Все кандидаты вернули 404");
              console.error(
                `[modus→edds] ❌ Не удалось доставить GUID=${mapped.guid} до /services/edds — все кандидаты вернули 404`
              );
            }
          }, 0);
        }

        if ((needEddsPlanned || needEddsRestore) && !needEddsDelete) {
          // Этап 10 — Отправка плановой в ЕДДС
          const st10 = islg.start(10, `Отправка плановой в ЕДДС (${PLANNED_EDDS_TRANSPORT})`);
          const usePut = !!existingEdsRequestId;
          const method = usePut ? "PUT" : "POST";
          const suffix = usePut ? `/${existingEdsRequestId}` : "";
          const action = needEddsRestore ? "Восстановление" : "Плановая заявка";
          const mergedForNew = { ...mapped, data: mergedRaw };
          if (mapped?.STATUS_NAME) mergedForNew.STATUS_NAME = mapped.STATUS_NAME;
          if (mapped?.recoveryFactDateTime) mergedForNew.recoveryFactDateTime = mapped.recoveryFactDateTime;
          console.log(
            `[PUT→EDDS] ${action}, отправка плановой в ЕДДС ${PLANNED_EDDS_TRANSPORT}: guid=${mapped.guid}` +
              (usePut ? ` edds_electricityRequestId=${existingEdsRequestId}` : "")
          );

          if (PLANNED_EDDS_SEND_PAUSED) {
            islg.skip(st10, PLANNED_EDDS_PAUSE_MESSAGE);
            await writePlannedEddsPausedJournal({
              guid: mapped.guid,
              tnNumber: mapped.number,
              target: `ЕДДС ${PLANNED_EDDS_TRANSPORT} ${method}`,
            });
          } else if (PLANNED_EDDS_TRANSPORT === "v1") {
            islg.success(st10, `mode=${usePut ? "update" : "create"}`);
            await sendPlannedEddsV1({
              item: mergedForNew,
              guid: mapped.guid,
              tnNumber: mapped.number,
              mode: usePut ? "update" : "create",
            });
          } else {
            islg.success(st10, `v2 mode=${method} suffix=${suffix}`);
            setTimeout(async () => {
            try {
              const { payload: v2Payload, errors: buildErrors } = buildEddsNewPayload({ data: mergedForNew });
              if (!v2Payload) {
                console.error(`[PUT→EDDS] Ошибка сборки v2 payload:`, buildErrors);
                return;
              }
              if (buildErrors.length) {
                console.warn(`[PUT→EDDS] Предупреждения при сборке v2 payload:`, buildErrors);
              }

              const locationResult = await resolveAccidentLocation(v2Payload);
              if (locationResult.ok) {
                v2Payload.accidentLocation = locationResult.accidentLocation;
              } else {
                console.warn(`  ⚠ accidentLocation: ${locationResult.message} — координаты не определены`);
              }

              const eddsUrl = `${process.env.EDDS_NEW_BASE_URL}/edds/external/requests/electricity${suffix}`;
              const eddsToken = process.env.EDDS_TOKEN;
              // console.log(`  🔑 EDDS_TOKEN (ПОЛНЫЙ): ${eddsToken || 'ОТСУТСТВУЕТ'}`);
              // console.log(`  🌐 EDDS_URL:            ${eddsUrl}`);

              console.log(`\n${"═".repeat(60)}`);
              console.log(`  ЕДДС v2 ${method} → финальный JSON (${Object.keys(v2Payload).length} полей)`);
              console.log(`${"═".repeat(60)}`);
              console.log(JSON.stringify(v2Payload, null, 2));
              console.log(`${"═".repeat(60)}\n`);

              const jsonEscaped = JSON.stringify(v2Payload).replace(/'/g, `'\\''`);

              const command =
                `curl -sS --http1.1 -X ${method} ` +
                `-H "Content-Type: application/json" ` +
                `-H "Authorization: Service ${eddsToken}" ` +
                `-d '${jsonEscaped}' ` +
                `-w "\\nHTTP_CODE:%{http_code}" ` +
                `"${eddsUrl}" --insecure`;

              // console.log(`  📤 curl headers:`);
              // console.log(`     Content-Type: application/json`);
              // console.log(`     Authorization: Service ${eddsToken}`);

              await new Promise((resolve) => {
                exec(command, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
                  if (err) {
                    console.error(`[PUT→EDDS] ✗ curl error code=${err.code}`);
                    if (stderr) console.error(`    ${stderr}`);
                    writeEddsV2CurlErrorJournal({
                      guid: mapped.guid,
                      tnNumber: mapped.number,
                      target: `ЕДДС v2 ${method}`,
                      err,
                      stderr,
                    });
                    resolve();
                    return;
                  }

                  let httpCode = null;
                  let body = stdout;
                  const codeMatch = stdout.match(/\nHTTP_CODE:(\d+)/);
                  if (codeMatch) {
                    httpCode = Number(codeMatch[1]);
                    body = stdout.slice(0, codeMatch.index).trim();
                  }

                  let parsed = null;
                  try { parsed = JSON.parse(body); } catch { /* raw */ }

                  const icon = httpCode >= 200 && httpCode < 300 ? "✓" : "✗";
                  console.log(`\n  ${icon} API ЕДДС ответил: HTTP ${httpCode}`);
                  console.log(`${"─".repeat(60)}`);
                  console.log(JSON.stringify(parsed || body, null, 2));
                  console.log(`${"─".repeat(60)}`);

                  if (httpCode >= 200 && httpCode < 300) {
                    const requestId = parsed?.data?.id || null;
                    console.log(`[PUT→EDDS] ✅ GUID=${mapped.guid} — ЕДДС v2 ${method} прошёл` + (requestId ? ` (id: ${requestId})` : ""));
                    if (requestId && !usePut) {
                      getJwt().then(jwt => saveEdsRequestId(mapped.guid, requestId, jwt)).catch(() => {});
                    }
                  } else {
                    console.warn(`[PUT→EDDS] ❌ GUID=${mapped.guid} — ЕДДС v2 отклонила: ${parsed?.message || JSON.stringify(parsed || body)}`);
                    const eddsFieldErrors = parsed?.data;
                    if (eddsFieldErrors && typeof eddsFieldErrors === 'object') {
                      const mapped = mapEddsValidationErrors(Object.entries(eddsFieldErrors).map(([field, msgs]) => ({ field, message: Array.isArray(msgs) ? msgs[0] : msgs })), v2Payload);
                      mapped.forEach(m => console.warn(`  → ${m}`));
                    }
                  }

                  writeEdsJournal({ guid: mapped.guid, tnNumber: mapped.number, target: `ЕДДС v2 ${method}`, httpCode, parsed, isPlanned: true }).catch((e) => console.warn("[modus][journal] ошибка:", e?.message || e));

                  resolve();
                });
              });
            } catch (e) {
              logEddsV2AsyncError(`[PUT→EDDS] Ошибка отправки в ЕДДС v2 для GUID=${mapped.guid}:`, e);
              writeEddsV2AsyncErrorJournal({
                guid: mapped.guid,
                tnNumber: mapped.number,
                target: `ЕДДС v2 ${method}`,
                e,
              });
            }
            }, 0);
          }
        }

        if (needEddsDelete) {
          // Этап 11 — Удаление в ЕДДС (DELETE)
          const st11 = islg.start(11, `Удаление в ЕДДС (${PLANNED_EDDS_TRANSPORT} DELETE)`);
          const mergedForDelete = { ...mapped, data: mergedRaw };
          if (mapped?.STATUS_NAME) mergedForDelete.STATUS_NAME = mapped.STATUS_NAME;
          console.log(
            `[PUT→EDDS] ТН удалена, отправка плановой в ЕДДС ${PLANNED_EDDS_TRANSPORT}: guid=${mapped.guid} edds_electricityRequestId=${existingEdsRequestId}`
          );

          if (PLANNED_EDDS_SEND_PAUSED) {
            islg.skip(st11, PLANNED_EDDS_PAUSE_MESSAGE);
            await writePlannedEddsPausedJournal({
              guid: mapped.guid,
              tnNumber: mapped.number,
              target: `ЕДДС ${PLANNED_EDDS_TRANSPORT} DELETE`,
            });
          } else if (PLANNED_EDDS_TRANSPORT === "v1") {
            islg.success(st11, "mode=update (статус «удалена» → code 4)");
            await sendPlannedEddsV1({
              item: mergedForDelete,
              guid: mapped.guid,
              tnNumber: mapped.number,
              mode: "update",
            });
          } else {
            islg.success(st11, `DELETE /${existingEdsRequestId}`);
            setTimeout(async () => {
            try {
              const eddsUrl = `${process.env.EDDS_NEW_BASE_URL}/edds/external/requests/electricity/${existingEdsRequestId}`;
              const eddsToken = process.env.EDDS_TOKEN;

              const command =
                `curl -sS --http1.1 -X DELETE ` +
                `-H "Content-Type: application/json" ` +
                `-H "Authorization: Service ${eddsToken}" ` +
                `-w "\\nHTTP_CODE:%{http_code}" ` +
                `"${eddsUrl}" --insecure`;

              await new Promise((resolve) => {
                exec(command, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
                  if (err) {
                    console.error(`[PUT→EDDS] ✗ DELETE curl error code=${err.code}`);
                    if (stderr) console.error(`    ${stderr}`);
                    writeEddsV2CurlErrorJournal({
                      guid: mapped.guid,
                      tnNumber: mapped.number,
                      target: "ЕДДС v2 DELETE",
                      err,
                      stderr,
                    });
                    resolve();
                    return;
                  }

                  let httpCode = null;
                  let body = stdout;
                  const codeMatch = stdout.match(/\nHTTP_CODE:(\d+)/);
                  if (codeMatch) {
                    httpCode = Number(codeMatch[1]);
                    body = stdout.slice(0, codeMatch.index).trim();
                  }

                  let parsed = null;
                  try { parsed = JSON.parse(body); } catch { /* raw */ }

                  const icon = httpCode >= 200 && httpCode < 300 ? "✓" : "✗";
                  console.log(`\n  ${icon} API ЕДДС ответил: HTTP ${httpCode}`);
                  console.log(`${"─".repeat(60)}`);
                  console.log(JSON.stringify(parsed || body, null, 2));
                  console.log(`${"─".repeat(60)}`);

                  if (httpCode >= 200 && httpCode < 300) {
                    console.log(`[PUT→EDDS] ✅ GUID=${mapped.guid} — ЕДДС v2 DELETE прошёл`);
                    getJwt().then(j => saveEdsRequestId(mapped.guid, null, j)).catch(e => console.warn(`[PUT→EDDS] Ошибка обнуления edds_electricityRequestId для GUID=${mapped.guid}:`, e?.message || e));
                  } else {
                    console.warn(`[PUT→EDDS] ❌ GUID=${mapped.guid} — ЕДДС v2 DELETE отклонила: ${parsed?.message || JSON.stringify(parsed || body)}`);
                  }

                  writeEdsJournal({ guid: mapped.guid, tnNumber: mapped.number, target: "ЕДДС v2 DELETE", httpCode, parsed, isPlanned: true }).catch((e) => console.warn("[journal] ошибка:", e?.message || e));

                  resolve();
                });
              });
            } catch (e) {
              logEddsV2AsyncError(`[PUT→EDDS] Ошибка DELETE для GUID=${mapped.guid}:`, e);
              writeEddsV2AsyncErrorJournal({
                guid: mapped.guid,
                tnNumber: mapped.number,
                target: "ЕДДС v2 DELETE",
                e,
              });
            }
            }, 0);
          }
        }

        // Этап 12 — Удаление «удалённых» из Strapi (только для плановых)
        if (isPlanned && nextStatus === "удалена") {
          const st12 = islg.start(12, "Удаление плановой ТН из Strapi (status=удалена)");
          try {
            await axios.delete(
              `${urlStrapi}/api/teh-narusheniyas/${documentId}`,
              { headers: { Authorization: `Bearer ${jwt}` } }
            );
            islg.success(st12, `documentId=${documentId}`);
            console.log(`[PUT] ✅ Плановая ТН удалена из Strapi: guid=${mapped.guid} documentId=${documentId}`);
            broadcast({
              type: "tn-delete",
              source: "modus",
              action: "delete",
              id: documentId,
              guid: mapped.guid,
              timestamp: Date.now(),
            });
          } catch (e) {
            islg.fail(st12, e?.response?.data || e?.message);
            console.error(
              `[PUT] ❌ Не удалось удалить плановую ТН из Strapi: guid=${mapped.guid} documentId=${documentId}:`,
              e?.response?.data || e?.message
            );
          }
        }

        acc.push({
          success: true,
          index: index + 1,
          id: upd?.data?.data?.id || documentId,
          updated: true,
        });
      } catch (e) {
        const msg =
          e?.response?.data?.error?.message ||
          e?.message ||
          "Неизвестная ошибка";
        islg.fail(islg.start(99, "Обработка элемента"), msg);
        acc.push({ success: false, index: index + 1, error: msg });
      }

      return acc;
    }, Promise.resolve([]));

    // Этап 13 — Фоновый геокодинг адресов
    const st13 = slog.start(13, "Фоновый геокодинг адресов (DaData)");
    setTimeout(() => {
      if (!fiasSet.size) {
        slog.skip(st13, "FIAS не найдены");
        slog.summary();
        return;
      }
      upsertAddressesInStrapi([...fiasSet], jwt).catch((e) =>
        console.warn("[modus] Ошибка фоновой обработки адресов:", e?.message)
      );
      slog.success(st13, `FIAS: ${fiasSet.size}`);
      slog.summary();
    }, 0);

    return res.json({ status: "ok", results });
  } catch (e) {
    const msg = e?.message || "Внутренняя ошибка сервера";
    slog.fail(slog.start(99, "Обработка запроса"), msg);
    slog.summary();
    return res.status(500).json({ status: "error", message: msg });
  }
});

router.post("/", async (req, res) => {
  const sharedStages = [];
  const slog = createStageLogger("POST", sharedStages);
  const authorization = req.get("Authorization");

  async function sendDataSequentially(dataArray) {
    const jwt = await getJwt();
    const fiasSet = new Set();

    const results = await dataArray.reduce(
      async (previousPromise, item, index) => {
        const accumulatedResults = await previousPromise;
        const islg = createStageLogger(`POST[${index + 1}]`, sharedStages);
        try {
          const guid = item?.guid;

          // Этап 1 — Проверка дубликатов (GUID)
          const st1 = islg.start(1, "Проверка дубликатов (GUID в Strapi)");
          if (guid) {
            try {
              const search = await axios.get(
                `${urlStrapi}/api/teh-narusheniyas`,
                {
                  headers: { Authorization: `Bearer ${jwt}` },
                  params: {
                    "filters[guid][$eq]": guid,
                    "pagination[pageSize]": 1,
                  },
                }
              );
              const found = search?.data?.data?.[0];
              if (found) {
                islg.fail(st1, "Запись с таким GUID уже существует (duplicate)");
                const existingId = found?.documentId || found?.id;
                accumulatedResults.push({
                  success: false,
                  index: index + 1,
                  status: "duplicate",
                  error: "Запись с таким GUID уже существует",
                  guid,
                  id: existingId,
                });
                return accumulatedResults;
              }
              islg.success(st1, "дубликатов нет");
            } catch (e) {
              islg.fail(st1, `Не удалось проверить: ${e?.response?.status || e?.message}`);
              console.warn(
                `[POST] Не удалось выполнить проверку дубликатов для guid=${guid}:`,
                e?.response?.status || e?.message
              );
            }
          } else {
            islg.skip(st1, "GUID не передан");
          }

          // Этап 2 — Формирование payload + auto-description
          const st2 = islg.start(2, "Формирование payload + auto-description");
          const payload = { ...item };
          const originalModusDesc = String(item.description ?? "").trim();
          if (originalModusDesc) {
            payload.raw_description = originalModusDesc;
          }
          try {
            const autoDesc = buildAutoDescription({
              ...(item?.data || {}),
              ...item,
            });
            if (autoDesc) payload.description = autoDesc;
            islg.success(st2, autoDesc ? "auto-description сгенерирован" : "auto-description пуст");
          } catch (e) {
            islg.fail(st2, e?.message);
            console.warn("[POST] autoDescription generation failed:", e?.message);
          }

          // Этап 3 — Запись в Strapi (POST /api/teh-narusheniyas)
          const st3 = islg.start(3, "Запись в Strapi (POST /api/teh-narusheniyas)");
          const response = await axios.post(
            `${urlStrapi}/api/teh-narusheniyas`,
            { data: payload },
            { headers: { Authorization: `Bearer ${jwt}` } }
          );

          const created = response?.data?.data;
          const createdId = created?.id || created?.documentId;
          const createdAttrs = created?.attributes || {};
          islg.success(st3, `createdId=${createdId}`);

          // Этап 4 — Извлечение FIAS
          const st4 = islg.start(4, "Извлечение FIAS из ADDRESS_LIST");
          try {
            const fiasCodes = extractFiasList(item);
            fiasCodes.forEach((id) => fiasSet.add(id));
            islg.success(st4, `FIAS: ${fiasCodes.size || fiasCodes.length}`);
          } catch (e) {
            islg.fail(st4, e?.message);
            console.warn("[POST] Пропущено извлечение адресов:", e?.message);
          }

          // Этап 5 — SSE-уведомление (tn-upsert)
          const st5 = islg.start(5, "SSE-уведомление (tn-upsert)");
          try {
            let descriptionFromStrapi = createdAttrs?.description;
            if (descriptionFromStrapi == null && createdId) {
              descriptionFromStrapi = await fetchTnDescriptionById(createdId, jwt);
            }
            const entryForSse = {
              ...item,
              id: createdId,
              description: descriptionFromStrapi,
              PES_COUNT: createdAttrs?.PES_COUNT ?? 0,
              PES_POWER: createdAttrs?.PES_POWER ?? 0,
            };
            broadcast({
              type: "tn-upsert",
              source: "modus",
              action: "create",
              id: createdId,
              entry: entryForSse,
              timestamp: Date.now(),
            });
            islg.success(st5);
          } catch (e) {
            islg.fail(st5, e?.message);
            console.error("Ошибка SSE broadcast (create):", e?.message);
          }

          // Этап 6 — Отправка плановой в ЕДДС
          if (item.BASE_TYPE === 1) {
            const st6 = islg.start(6, `Отправка плановой в ЕДДС (${PLANNED_EDDS_TRANSPORT})`);
            const plannedStatus = item.STATUS_NAME || payload.STATUS_NAME || payload?.data?.STATUS_NAME;
            const canSendPlanned =
              isPlannedEddsV1CreateOrUpdateStatus(plannedStatus);
            if (!canSendPlanned) {
              islg.skip(st6, `status="${plannedStatus || "пусто"}" — не «начата»/«закрыта»`);
              console.log(
                `[POST→EDDS] Плановая заявка не отправляется в ЕДДС: status="${plannedStatus || "пусто"}", guid=${item.guid}`
              );
              accumulatedResults.push({
                success: true,
                id: createdId,
                index: index + 1,
              });
              return accumulatedResults;
            }

            console.log(
              `[POST→EDDS] Плановая заявка, автоматическая отправка в ЕДДС ${PLANNED_EDDS_TRANSPORT}: guid=${item.guid}`
            );
            if (PLANNED_EDDS_SEND_PAUSED) {
              islg.skip(st6, PLANNED_EDDS_PAUSE_MESSAGE);
              await writePlannedEddsPausedJournal({
                guid: item.guid,
                tnNumber: item.number,
                target: `ЕДДС ${PLANNED_EDDS_TRANSPORT}`,
              });
            } else if (PLANNED_EDDS_TRANSPORT === "v1") {
              islg.success(st6, "mode=create (v1)");
              await sendPlannedEddsV1({
                item: payload,
                guid: item.guid,
                tnNumber: item.number,
                mode: "create",
              });
            } else {
              islg.success(st6, "v2 mode=POST");
              setTimeout(async () => {
              try {
                const { payload: v2Payload, errors: buildErrors } = buildEddsNewPayload({ data: item });
                if (!v2Payload) {
                  console.error(`[POST→EDDS] Ошибка сборки v2 payload:`, buildErrors);
                  return;
                }
                if (buildErrors.length) {
                  console.warn(`[POST→EDDS] Предупреждения при сборке v2 payload:`, buildErrors);
                }

                const locationResult = await resolveAccidentLocation(v2Payload);
                if (locationResult.ok) {
                  v2Payload.accidentLocation = locationResult.accidentLocation;
                } else {
                  console.warn(`  ⚠ accidentLocation: ${locationResult.message} — координаты не определены, отправка с placeholder`);
                }

                const eddsUrl = `${process.env.EDDS_NEW_BASE_URL}/edds/external/requests/electricity`;
                const eddsToken = process.env.EDDS_TOKEN;
                // console.log(`  🔑 EDDS_TOKEN (ПОЛНЫЙ): ${eddsToken || 'ОТСУТСТВУЕТ'}`);
                // console.log(`  🌐 EDDS_URL:            ${eddsUrl}`);

                console.log(`\n${"═".repeat(60)}`);
                console.log(`  ЕДДС v2 → финальный JSON (${Object.keys(v2Payload).length} полей)`);
                console.log(`${"═".repeat(60)}`);
                console.log(JSON.stringify(v2Payload, null, 2));
                console.log(`${"═".repeat(60)}\n`);

                const jsonEscaped = JSON.stringify(v2Payload).replace(/'/g, `'\\''`);

                const command =
                  `curl -sS --http1.1 -X POST ` +
                  `-H "Content-Type: application/json" ` +
                  `-H "Authorization: Service ${eddsToken}" ` +
                  `-d '${jsonEscaped}' ` +
                  `-w "\\nHTTP_CODE:%{http_code}" ` +
                  `"${eddsUrl}" --insecure`;

                  // console.log(`  📤 curl headers:`);
                  // console.log(`     Content-Type: application/json`);
                  // console.log(`     Authorization: Service ${eddsToken}`);

                await new Promise((resolve) => {
                  exec(command, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
                    if (err) {
                      console.error(`[POST→EDDS] ✗ curl error code=${err.code}`);
                      if (stderr) console.error(`    ${stderr}`);
                      writeEddsV2CurlErrorJournal({
                        guid: item.guid,
                        tnNumber: item.number,
                        target: "ЕДДС v2",
                        err,
                        stderr,
                      });
                      resolve();
                      return;
                    }

                    let httpCode = null;
                    let body = stdout;
                    const codeMatch = stdout.match(/\nHTTP_CODE:(\d+)/);
                    if (codeMatch) {
                      httpCode = Number(codeMatch[1]);
                      body = stdout.slice(0, codeMatch.index).trim();
                    }

                    let parsed = null;
                    try { parsed = JSON.parse(body); } catch { /* raw */ }

                    const icon = httpCode >= 200 && httpCode < 300 ? "✓" : "✗";
                    console.log(`\n  ${icon} API ЕДДС ответил: HTTP ${httpCode}`);
                    console.log(`${"─".repeat(60)}`);
                    console.log(JSON.stringify(parsed || body, null, 2));
                    console.log(`${"─".repeat(60)}`);

                    if (httpCode >= 200 && httpCode < 300) {
                      const requestId = parsed?.data?.id || null;
                      console.log(`[POST→EDDS] ✅ GUID=${item.guid} — ЕДДС v2 приняла` + (requestId ? ` (id: ${requestId})` : ""));
                      if (requestId) {
                        getJwt().then(jwt => saveEdsRequestId(item.guid, requestId, jwt)).catch(() => {});
                      }
                    } else {
                      console.warn(`[POST→EDDS] ❌ GUID=${item.guid} — ЕДДС v2 отклонила: ${parsed?.message || JSON.stringify(parsed || body)}`);
                      const eddsFieldErrors = parsed?.data;
                      if (eddsFieldErrors && typeof eddsFieldErrors === 'object') {
                        const mapped = mapEddsValidationErrors(Object.entries(eddsFieldErrors).map(([field, msgs]) => ({ field, message: Array.isArray(msgs) ? msgs[0] : msgs })), v2Payload);
                        mapped.forEach(m => console.warn(`  → ${m}`));
                      }
                    }

                    writeEdsJournal({ guid: item.guid, tnNumber: item.number, target: "ЕДДС v2", httpCode, parsed, isPlanned: true }).catch((e) => console.warn("[modus][journal] ошибка:", e?.message || e));

                    resolve();
                  });
                });
              } catch (e) {
                logEddsV2AsyncError(`[POST→EDDS] Ошибка отправки в ЕДДС v2 для GUID=${item.guid}:`, e);
                writeEddsV2AsyncErrorJournal({
                  guid: item.guid,
                  tnNumber: item.number,
                  target: "ЕДДС v2",
                  e,
                });
              }
              }, 0);
            }
          }

          // Этап 7 — Удаление «удалённых» из Strapi (только для плановых)
          if (item.BASE_TYPE === 1) {
            const st7 = islg.start(7, "Удаление плановой ТН из Strapi (status=удалена)");
            const delStatus = (item.STATUS_NAME || "").toString().trim().toLowerCase();
            if (delStatus === "удалена") {
              try {
                await axios.delete(
                  `${urlStrapi}/api/teh-narusheniyas/${createdId}`,
                  { headers: { Authorization: `Bearer ${jwt}` } }
                );
                islg.success(st7, `documentId=${createdId}`);
                console.log(`[POST] ✅ Плановая ТН удалена из Strapi: guid=${item.guid} documentId=${createdId}`);
                broadcast({
                  type: "tn-delete",
                  source: "modus",
                  action: "delete",
                  id: createdId,
                  guid: item.guid,
                  timestamp: Date.now(),
                });
              } catch (e) {
                islg.fail(st7, e?.response?.data || e?.message);
                console.error(
                  `[POST] ❌ Не удалось удалить плановую ТН из Strapi: guid=${item.guid} documentId=${createdId}:`,
                  e?.response?.data || e?.message
                );
              }
            } else {
              islg.skip(st7, `status="${delStatus}" — не «удалена»`);
            }
          }

          accumulatedResults.push({
            success: true,
            id: createdId,
            index: index + 1,
          });
        } catch (error) {
          islg.fail(islg.start(99, "Обработка элемента"), error.message);
          console.error(
            `[POST] Ошибка при отправке элемента ${index + 1}:`,
            error.message
          );
          accumulatedResults.push({
            success: false,
            error: error.message,
            index: index + 1,
          });
        }

        return accumulatedResults;
      },
      Promise.resolve([])
    );
    setTimeout(() => {
      if (!fiasSet.size) {
        return;
      }
      upsertAddressesInStrapi([...fiasSet], jwt).catch((e) =>
        console.warn("[modus] Ошибка фоновой обработки адресов:", e?.message)
      );
    }, 0);

    slog.summary();
    return results;
  }

  // Этап 1 — Авторизация
  const stAuth = slog.start(1, "Авторизация (Bearer SECRET_FOR_MODUS)");
  if (authorization !== `Bearer ${secretModus}`) {
    slog.fail(stAuth, "Неверный или отсутствующий токен");
    slog.summary();
    return res.status(403).json({ status: "Forbidden" });
  }
  slog.success(stAuth);

  // Этап 2 — Валидация тела запроса
  const stBody = slog.start(2, "Валидация тела запроса (Data массив)");
  if (!req.body?.Data) {
    slog.fail(stBody, "Не хватает требуемых данных (ожидается Data)");
    slog.summary();
    return res
      .status(400)
      .json({ status: "error", message: "Не хватает требуемых данных" });
  }
  const data = req.body.Data;
  slog.success(stBody, `получено элементов: ${data.length}`);

  // Этап 3 — Маппинг полей МОДУС → внутренняя форма
  const stMap = slog.start(3, "Маппинг полей МОДУС → внутренняя форма");
  const prepareData = data.map((item) => {
    const baseType = parseBaseType(item.BASE_TYPE);
    const prepared = {
      guid: item.VIOLATION_GUID_STR,
      number: `${item.F81_010_NUMBER}`,
      energoObject: item.F81_041_ENERGOOBJECTNAME,
      createDateTime: item.F81_060_EVENTDATETIME,
      recoveryPlanDateTime: item.REPAIRDATETIME,
      repairDateTime: item.REPAIRDATETIME,
      addressList: item.ADDRESS_LIST,
      recoveryFactDateTime: item.F81_290_RECOVERYDATETIME,
      factRestoreDateTime: item.F81_070_RESTOR_SUPPLAYDATETIME,
      normalizationDateTime: item.F81_290_RECOVERYDATETIME,
      dispCenter: item.DISPCENTER_NAME_,
      STATUS_NAME: (item.STATUS_NAME || "").toString().trim(),
      isActive:
        (item.STATUS_NAME || "").toString().trim().toLowerCase() === "открыта",
      data: item,
    };
    if (baseType !== null) {
      prepared.BASE_TYPE = baseType;
    }
    return prepared;
  });
  slog.success(stMap, `подготовлено: ${prepareData.length}`);

  const results = await sendDataSequentially(prepareData);
  if (!results) {
    slog.fail(slog.start(99, "Обработка"), "sendDataSequentially вернул null");
    slog.summary();
    return res.status(500).json({ status: "error" });
  }

  const anyCreated = results.some((r) => r?.success === true);
  const allDuplicates =
    results.length > 0 && results.every((r) => r?.status === "duplicate");

  if (allDuplicates && !anyCreated) {
    slog.summary();
    return res.status(409).json({
      status: "duplicate",
      message: "Запись с таким GUID уже существует",
      results,
    });
  }

  return res.json({ status: "ok", results });
});

module.exports = router;
