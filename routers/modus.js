//123
const { exec } = require("node:child_process");
const express = require("express");
const axios = require("axios");
const { broadcast } = require("../services/sse");
const { buildAutoDescription } = require("../services/autoDescription");
const { buildEddsPayload } = require("../services/modus/eddsPayload");
const { buildEddsNewPayload, mapEddsValidationErrors } = require("../services/modus/eddsNewPayload");
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
  plan_date_close: "F81_070_RESTOR_SUPPLAYDATETIME",
  externalId: "VIOLATION_GUID_STR",
  equipmentType: "OBJECTTYPE81/VOLTAGECLASS",
  equipmentName: "F81_041_ENERGOOBJECTNAME",
  districtFiasIds: "DISTRICT/SCNAME",
  "shutdownInfo.shutdownType": "VIOLATION_TYPE",
  "shutdownInfo.disabledAt": "F81_060_EVENTDATETIME",
  "shutdownInfo.plannedInclusionAt": "F81_070_RESTOR_SUPPLAYDATETIME",
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
  try {
    if (!isAuthorized(req)) {
      return res.status(403).json({ status: "Forbidden" });
    }

    const items = req.body.data || req.body.Data;
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        status: "error",
        message:
          "Не хватает требуемых данных (ожидается Data или data: массив)",
      });
    }

    const mapItem = (item) => {
      const status = (item.STATUS_NAME || "").toString().trim().toLowerCase();
      const isActive = status === "открыта";
      const baseType = parseBaseType(item.BASE_TYPE);
      const mapped = {
        guid: item.VIOLATION_GUID_STR,
        number: `${item.F81_010_NUMBER}`,
        energoObject: item.F81_041_ENERGOOBJECTNAME,
        createDateTime: item.F81_060_EVENTDATETIME,
        recoveryPlanDateTime: item.F81_070_RESTOR_SUPPLAYDATETIME,
        addressList: item.ADDRESS_LIST,
        // description: item.F81_042_DISPNAME,
        recoveryFactDateTime: item.F81_290_RECOVERYDATETIME,
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

    const jwt = await getJwt();
    if (!jwt) {
      return res.status(500).json({
        status: "error",
        message: "Не удалось авторизоваться в Strapi",
      });
    }

    const fiasSet = new Set();

    const results = await items.reduce(async (prevPromise, rawItem, index) => {
      const acc = await prevPromise;
      const mapped = mapItem(rawItem);
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
        acc.push({
          success: false,
          index: index + 1,
          error: "Не передан GUID записи",
        });
        return acc;
      }

      try {
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
        const needEddsPlanned = isPlanned;
        const needEddsDelete = statusChanged && nextStatus === "удалена" && !!existingEdsRequestId;
        const needEddsRestore = statusChanged && !existingEdsRequestId && isPlanned && prevStatus === "удалена";

        console.log(`[PUT] guid=${mapped.guid} baseType=${nextBaseType} isPlanned=${isPlanned} needEddsPlanned=${needEddsPlanned} needEddsDelete=${needEddsDelete} statusChanged=${statusChanged} prev=${prevStatus} next=${nextStatus}`);

        if (!documentId) {
          acc.push({
            success: false,
            index: index + 1,
            status: "not_found",
            error: "Запись с таким GUID не найдена",
          });
          return acc;
        }

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
        // ─────────────────────────────────────────────────────────────────────────────

        if (Object.keys(patch).length === 0) {
          acc.push({
            success: true,
            index: index + 1,
            id: documentId,
            updated: false,
            message: "Изменений нет",
          });
          return acc;
        }

        const upd = await axios.put(
          `${urlStrapi}/api/teh-narusheniyas/${documentId}`,
          { data: patch },
          { headers: { Authorization: `Bearer ${jwt}` } }
        );

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
        } catch (e) {
          console.error("SSE broadcast error (update):", e?.message);
        }
        if (needEdds) {
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
          setTimeout(async () => {
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
                    console.log(
                      `[modus→edds] ✅ GUID=${mapped.guid} отправлен в ЕДДС через ${url}` +
                        (claimId ? `; claim_id=${claimId}` : "")
                    );
                  } else {
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
              console.error(
                `[modus→edds] ❌ Не удалось доставить GUID=${mapped.guid} до /services/edds — все кандидаты вернули 404`
              );
            }
          }, 0);
        }

        if ((needEddsPlanned || needEddsRestore) && !needEddsDelete) {
          const usePut = !!existingEdsRequestId;
          const method = usePut ? "PUT" : "POST";
          const suffix = usePut ? `/${existingEdsRequestId}` : "";
          const action = needEddsRestore ? "Восстановление" : "Плановая заявка";
          console.log(`[PUT→EDDS] ${action}, отправка в ЕДДС v2 (${method}): guid=${mapped.guid}` + (usePut ? ` edds_electricityRequestId=${existingEdsRequestId}` : ""));

          setTimeout(async () => {
            try {
              const mergedForNew = { ...mapped, data: mergedRaw };
              if (mapped?.STATUS_NAME) mergedForNew.STATUS_NAME = mapped.STATUS_NAME;
              if (mapped?.recoveryFactDateTime) mergedForNew.recoveryFactDateTime = mapped.recoveryFactDateTime;

              const { payload: v2Payload, errors: buildErrors } = buildEddsNewPayload({ data: mergedForNew });
              if (!v2Payload) {
                console.error(`[PUT→EDDS] Ошибка сборки v2 payload:`, buildErrors);
                return;
              }
              if (buildErrors.length) {
                console.warn(`[PUT→EDDS] Предупреждения при сборке v2 payload:`, buildErrors);
              }

              console.log(`\n${"═".repeat(60)}`);
              console.log(`  ЕДДС v2 ${method} → payload (${Object.keys(v2Payload).length} полей)`);
              console.log(`${"═".repeat(60)}`);
              console.log(JSON.stringify(v2Payload, null, 2));
              console.log(`${"═".repeat(60)}\n`);

              const locationResult = await resolveAccidentLocation(v2Payload);
              if (locationResult.ok) {
                v2Payload.accidentLocation = locationResult.accidentLocation;
                // console.log(`  📍 accidentLocation: ${JSON.stringify(locationResult.accidentLocation)} (${locationResult.resolvedCount}/${locationResult.totalFias} FIAS)`);
              } else {
                console.warn(`  ⚠ accidentLocation: ${locationResult.message} — координаты не определены`);
              }

              const eddsUrl = `${process.env.EDDS_NEW_BASE_URL}/edds/external/requests/electricity${suffix}`;
              const eddsToken = process.env.EDDS_TOKEN;
              // console.log(`  🔑 EDDS_TOKEN (ПОЛНЫЙ): ${eddsToken || 'ОТСУТСТВУЕТ'}`);
              // console.log(`  🌐 EDDS_URL:            ${eddsUrl}`);
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

        if (needEddsDelete) {
          console.log(`[PUT→EDDS] ТН удалена, отправка DELETE в ЕДДС v2: guid=${mapped.guid} edds_electricityRequestId=${existingEdsRequestId}`);

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
        acc.push({ success: false, index: index + 1, error: msg });
      }

      return acc;
    }, Promise.resolve([]));

    setTimeout(() => {
      if (!fiasSet.size) {
        return;
      }
      upsertAddressesInStrapi([...fiasSet], jwt).catch((e) =>
        console.warn("[modus] Ошибка фоновой обработки адресов:", e?.message)
      );
    }, 0);

    return res.json({ status: "ok", results });
  } catch (e) {
    const msg = e?.message || "Внутренняя ошибка сервера";
    return res.status(500).json({ status: "error", message: msg });
  }
});

router.post("/", async (req, res) => {
  const authorization = req.get("Authorization");

  async function sendDataSequentially(dataArray) {
    const jwt = await getJwt();
    const fiasSet = new Set();

    const results = await dataArray.reduce(
      async (previousPromise, item, index) => {
        const accumulatedResults = await previousPromise;
        try {
          const guid = item?.guid;
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
            } catch (e) {
              console.warn(
                `[POST] Не удалось выполнить проверку дубликатов для guid=${guid}:`,
                e?.response?.status || e?.message
              );
            }
          }

          // Build payload with auto-description on create
          const payload = { ...item };
          try {
            const autoDesc = buildAutoDescription({
              ...(item?.data || {}),
              ...item,
            });
            if (autoDesc) payload.description = autoDesc;
          } catch (e) {
            console.warn("[POST] autoDescription generation failed:", e?.message);
          }
          const response = await axios.post(
            `${urlStrapi}/api/teh-narusheniyas`,
            { data: payload },
            { headers: { Authorization: `Bearer ${jwt}` } }
          );

          // Достаём реальные данные из ответа Strapi (v4/v5) и тянем дефолт из самой Strapi (без хардкода)
          const created = response?.data?.data;
          const createdId = created?.id || created?.documentId;
          const createdAttrs = created?.attributes || {};
          let descriptionFromStrapi = createdAttrs?.description;
          if (descriptionFromStrapi == null && createdId) {
            descriptionFromStrapi = await fetchTnDescriptionById(
              createdId,
              jwt
            );
          }

          accumulatedResults.push({
            success: true,
            id: createdId,
            index: index + 1,
          });
          console.log(`[POST] Элемент ${index + 1} успешно отправлен`);
          try {
            const fiasCodes = extractFiasList(item);
            fiasCodes.forEach((id) => fiasSet.add(id));
          } catch (e) {
            console.warn("[POST] Пропущено извлечение адресов:", e?.message);
          }
          try {
            const entryForSse = {
              ...item,
              id: createdId,
              // если фронт слушает только SSE — отдадим корректное описание из Strapi
              description: descriptionFromStrapi,
              // expose Strapi-managed PES fields (override-friendly)
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
          } catch (e) {
            console.error("Ошибка SSE broadcast (create):", e?.message);
          }

          // ── Auto-send planned outages to EDDS v2 ────────────────────────
          if (item.BASE_TYPE === 1) {
            console.log(`[POST→EDDS] Плановая заявка, автоматическая отправка в ЕДДС v2: guid=${item.guid}`);
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

                console.log(`\n${"═".repeat(60)}`);
                console.log(`  ЕДДС v2 → payload (${Object.keys(v2Payload).length} полей)`);
                console.log(`${"═".repeat(60)}`);
                console.log(JSON.stringify(v2Payload, null, 2));
                console.log(`${"═".repeat(60)}\n`);

                const locationResult = await resolveAccidentLocation(v2Payload);
                if (locationResult.ok) {
                  v2Payload.accidentLocation = locationResult.accidentLocation;
              // console.log(`  📍 accidentLocation: ${JSON.stringify(locationResult.accidentLocation)} (${locationResult.resolvedCount}/${locationResult.totalFias} FIAS)`);
                } else {
                  console.warn(`  ⚠ accidentLocation: ${locationResult.message} — координаты не определены, отправка с placeholder`);
                }

                const eddsUrl = `${process.env.EDDS_NEW_BASE_URL}/edds/external/requests/electricity`;
                const eddsToken = process.env.EDDS_TOKEN;
                // console.log(`  🔑 EDDS_TOKEN (ПОЛНЫЙ): ${eddsToken || 'ОТСУТСТВУЕТ'}`);
                // console.log(`  🌐 EDDS_URL:            ${eddsUrl}`);
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
          // ─────────────────────────────────────────────────────────────────
        } catch (error) {
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

    return results;
  }

  if (authorization === `Bearer ${secretModus}`) {
    if (!req.body?.Data) {
      return res
        .status(400)
        .json({ status: "error", message: "Не хватает требуемых данных" });
    }
    const data = req.body.Data;
    const prepareData = data.map((item) => {
      const baseType = parseBaseType(item.BASE_TYPE);
      const prepared = {
        guid: item.VIOLATION_GUID_STR,
        number: `${item.F81_010_NUMBER}`,
        energoObject: item.F81_041_ENERGOOBJECTNAME,
        createDateTime: item.F81_060_EVENTDATETIME,
        recoveryPlanDateTime: item.F81_070_RESTOR_SUPPLAYDATETIME,
        addressList: item.ADDRESS_LIST,
        // description: item.F81_042_DISPNAME,
        recoveryFactDateTime: item.F81_290_RECOVERYDATETIME,
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

    const results = await sendDataSequentially(prepareData);
    if (!results) {
      return res.status(500).json({ status: "error" });
    }

    const anyCreated = results.some((r) => r?.success === true);
    const allDuplicates =
      results.length > 0 && results.every((r) => r?.status === "duplicate");

    if (allDuplicates && !anyCreated) {
      return res.status(409).json({
        status: "duplicate",
        message: "Запись с таким GUID уже существует",
        results,
      });
    }

    return res.json({ status: "ok", results });
  } else {
    res.status(403).json({ status: "Forbidden" });
  }
});

module.exports = router;
