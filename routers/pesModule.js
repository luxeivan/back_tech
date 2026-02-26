const crypto = require("crypto");
const express = require("express");
const {
  loadPesItems,
  loadAssemblyDestinations,
  loadTpDestinations,
} = require("../services/pesModuleData");
const { sendPesTelegram } = require("../services/pesTelegram");
const { sendPesSubscribersNotification } = require("../services/pesBot");
const { logAuditFromReq } = require("../services/auditLogger");
const {
  PES_ENDPOINTS,
  fetchPage,
  fetchAll,
  createOne,
  updateOne,
  oneRelation,
} = require("../services/pesStrapiStore");

const router = express.Router();

const PES_STATUS = {
  READY: "ready",
  COMMAND_SENT: "command_sent",
  DELAY: "delay",
  EN_ROUTE: "en_route",
  CONNECTED: "connected",
  REPAIR: "repair",
};

const MAX_DELAY_MS = 15 * 60 * 1000;

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

function norm(v) {
  return String(v == null ? "" : v).replace(/\s+/g, " ").trim();
}

function toIso(v) {
  if (v == null || v === "") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function toMs(v) {
  if (!v) return null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

function toNum(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toPositiveInt(value, fallback = 1) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

function randomId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function safeToken(value) {
  return String(value == null ? "" : value)
    .replace(/[^A-Za-z0-9\-_.~]/g, "_")
    .slice(0, 120);
}

function normalizeStoredStatus(value) {
  const s = String(value || "").trim().toLowerCase();
  if (s === "delayed") return PES_STATUS.DELAY;
  if (Object.values(PES_STATUS).includes(s)) return s;
  return PES_STATUS.READY;
}

function statusToPersist(value) {
  const s = normalizeStoredStatus(value);
  if (s === PES_STATUS.DELAY) return PES_STATUS.COMMAND_SENT;
  return s;
}

function effectiveStatus(item) {
  const status = normalizeStoredStatus(item.status);
  if (
    status === PES_STATUS.COMMAND_SENT &&
    !item.actualDepartureAt &&
    item.commandSentAt &&
    Date.now() - Number(item.commandSentAt) > MAX_DELAY_MS
  ) {
    return PES_STATUS.DELAY;
  }
  return status;
}

function toDto(item) {
  const dto = {
    id: item.id,
    number: item.number,
    name: item.name,
    branch: item.branch,
    po: item.po,
    powerKw: item.powerKw,
    model: item.model,
    baseAddress: item.baseAddress,
    dispatcherPhone: item.dispatcherPhone,
    sourceCode: item.sourceCode,
    district: item.district,
    status: normalizeStoredStatus(item.status),
    commandSentAt: item.commandSentAt,
    actualDepartureAt: item.actualDepartureAt,
    connectedAt: item.connectedAt,
    reroutedAt: item.reroutedAt || null,
    destination: item.destination || null,
    lastComment: item.lastComment || null,
  };
  return {
    ...dto,
    effectiveStatus: effectiveStatus(item),
  };
}

function roleFromReq(req) {
  return String(req.get("x-view-role") || "standart").trim().toLowerCase();
}

function requireManageRole(req, res, next) {
  if (roleFromReq(req) !== "standart") {
    return res.status(403).json({
      ok: false,
      message: "Операция доступна только пользователю с ролью standart",
    });
  }
  next();
}

function branchNeedle(branch) {
  return norm(branch)
    .toLowerCase()
    .replace(/\bфилиал\b/g, "")
    .replace(/[^а-яa-z0-9]/gi, "");
}

function sameBranch(a, b) {
  const aNorm = branchNeedle(a);
  const bNorm = branchNeedle(b);
  if (!aNorm || !bNorm) return false;
  return aNorm === bNorm || aNorm.includes(bNorm) || bNorm.includes(aNorm);
}

async function pickDestination({
  mode,
  destinationType,
  destinationId,
  branchHint,
}) {
  const scopedList =
    destinationType === "tp"
      ? await loadTpDestinations({ branch: branchHint || "" })
      : await loadAssemblyDestinations({ branch: branchHint || "" });
  let found = scopedList.find((x) => x.id === destinationId);

  // Защита от рассинхрона справочника/филиала:
  // если точка не нашлась в "филиальном" списке, пробуем глобальный список.
  if (!found && destinationType === "assembly") {
    const globalList = await loadAssemblyDestinations({ branch: "" });
    found = globalList.find((x) => x.id === destinationId) || null;
  }

  if (!found) return null;

  if (mode === "multi" && destinationType !== "assembly") {
    return { error: "При множественном выборе доступна только точка сбора ПЭС" };
  }

  return { value: clone(found) };
}

function summaryOf(items) {
  const summary = {
    total: items.length,
    ready: 0,
    commandSent: 0,
    delayed: 0,
    enRoute: 0,
    connected: 0,
    repair: 0,
  };

  items.forEach((it) => {
    const s = effectiveStatus(it);
    if (s === PES_STATUS.READY) summary.ready += 1;
    else if (s === PES_STATUS.COMMAND_SENT) summary.commandSent += 1;
    else if (s === PES_STATUS.DELAY) summary.delayed += 1;
    else if (s === PES_STATUS.EN_ROUTE) summary.enRoute += 1;
    else if (s === PES_STATUS.CONNECTED) summary.connected += 1;
    else if (s === PES_STATUS.REPAIR) summary.repair += 1;
  });

  return summary;
}

function buildStateIndex(rows) {
  const map = new Map();
  for (const row of rows) {
    const unit = oneRelation(row.pes_unit);
    const unitId = Number(unit?.id || 0);
    if (!Number.isFinite(unitId) || unitId <= 0) continue;
    map.set(unitId, row);
  }
  return map;
}

async function fetchStateRows() {
  return fetchAll(PES_ENDPOINTS.UNIT_STATES, {
    params: { populate: "pes_unit" },
  });
}

async function ensureStateRows(units, index) {
  let created = 0;
  for (const unit of units) {
    const unitId = Number(unit.unitStrapiId || 0);
    if (!Number.isFinite(unitId) || unitId <= 0) continue;
    if (index.has(unitId)) continue;

    const row = await createOne(PES_ENDPOINTS.UNIT_STATES, {
      pes_unit: unitId,
      pes_status: PES_STATUS.READY,
    });
    if (row) {
      index.set(unitId, {
        ...row,
        pes_unit: { id: unitId },
      });
      created += 1;
    }
  }
  return created;
}

function mapStateToItem(unit, stateRow) {
  const status = normalizeStoredStatus(stateRow?.pes_status);
  const destination = stateRow?.destination_ref
    ? {
        id: stateRow.destination_ref,
        type: stateRow.destination_type || "assembly",
        title: stateRow.destination_title || "",
        address: stateRow.destination_address || "",
        lat: toNum(stateRow.destination_lat),
        lon: toNum(stateRow.destination_lon),
      }
    : null;

  return {
    ...unit,
    status,
    commandSentAt: toMs(stateRow?.command_sent_at),
    actualDepartureAt: toMs(stateRow?.actual_departure_at),
    connectedAt: toMs(stateRow?.connected_at),
    reroutedAt: toMs(stateRow?.rerouted_at),
    destination,
    lastComment: norm(stateRow?.last_comment) || null,
    _stateDocumentId: stateRow?.documentId || null,
  };
}

async function loadSnapshot() {
  const units = await loadPesItems();
  const stateRows = await fetchStateRows();
  const index = buildStateIndex(stateRows);
  const created = await ensureStateRows(units, index);

  let finalIndex = index;
  if (created > 0) {
    finalIndex = buildStateIndex(await fetchStateRows());
  }

  return units.map((unit) => {
    const stateRow = finalIndex.get(Number(unit.unitStrapiId || 0)) || null;
    return mapStateToItem(unit, stateRow);
  });
}

async function persistState(item, { source = "web", chatId = null } = {}) {
  const payload = {
    pes_status: statusToPersist(item.status),
    command_sent_at: toIso(item.commandSentAt),
    actual_departure_at: toIso(item.actualDepartureAt),
    connected_at: toIso(item.connectedAt),
    rerouted_at: toIso(item.reroutedAt),
    destination_type: item.destination?.type || null,
    destination_ref: item.destination?.id || null,
    destination_title: item.destination?.title || null,
    destination_address: item.destination?.address || null,
    destination_lat: toNum(item.destination?.lat),
    destination_lon: toNum(item.destination?.lon),
    last_comment: item.lastComment || null,
    updated_from: source || null,
    updated_by_chat_id: Number.isFinite(Number(chatId)) ? Number(chatId) : null,
  };

  if (item._stateDocumentId) {
    const updated = await updateOne(
      PES_ENDPOINTS.UNIT_STATES,
      item._stateDocumentId,
      payload
    );
    item._stateDocumentId = updated?.documentId || item._stateDocumentId;
    return;
  }

  const created = await createOne(PES_ENDPOINTS.UNIT_STATES, {
    ...payload,
    pes_unit: Number(item.unitStrapiId || 0),
  });
  item._stateDocumentId = created?.documentId || null;
}

function logStatusFrom(status) {
  const s = normalizeStoredStatus(status);
  return s === PES_STATUS.DELAY ? PES_STATUS.DELAY : s;
}

function logStatusTo(status) {
  const s = normalizeStoredStatus(status);
  return s === PES_STATUS.DELAY ? PES_STATUS.COMMAND_SENT : s;
}

function normalizeUpdateSource(source, fallback = "web") {
  const value = norm(source).toLowerCase();
  if (value === "web" || value === "telegram" || value === "system") return value;
  return fallback;
}

async function createOperationLogSafe(payload) {
  try {
    await createOne(PES_ENDPOINTS.OPERATION_LOGS, payload);
    return;
  } catch (e) {
    const msg = String(e?.response?.data?.error?.message || e?.message || "");
    if (payload.status_from === PES_STATUS.READY && /status_from/i.test(msg)) {
      await createOne(PES_ENDPOINTS.OPERATION_LOGS, {
        ...payload,
        status_from: "ready,",
      });
      return;
    }
    throw e;
  }
}

async function appendOperationLogs({
  action,
  items,
  destination,
  comment,
  req,
  beforeStatusMap,
  sourceChatId,
}) {
  const batchId = randomId();
  const nowIso = new Date().toISOString();

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    const statusFrom = beforeStatusMap.get(item.id) || effectiveStatus(item);
    const statusTo = effectiveStatus(item);

    const delaySeconds =
      item.commandSentAt && item.actualDepartureAt
        ? Math.max(0, Math.round((item.actualDepartureAt - item.commandSentAt) / 1000))
        : null;

    const payload = {
      event_uid: `${safeToken(batchId)}_${safeToken(item.id)}_${i + 1}`,
      event_time: nowIso,
      action,
      status_from: logStatusFrom(statusFrom),
      status_to: logStatusTo(statusTo),
      comment: comment || null,
      branch: item.branch || null,
      po: item.po || null,
      destination_type: destination?.type || null,
      destination_title: destination?.title || null,
      destination_address: destination?.address || null,
      destination_lat: toNum(destination?.lat),
      destination_lon: toNum(destination?.lon),
      actor_role: roleFromReq(req),
      actor_login: norm(req.get("x-audit-username") || "") || null,
      actor_chat_id: Number.isFinite(Number(sourceChatId))
        ? Number(sourceChatId)
        : null,
      command_sent_at: toIso(item.commandSentAt),
      actual_departure_at: toIso(item.actualDepartureAt),
      delay_seconds: delaySeconds,
      delay_over_15m:
        delaySeconds == null ? null : delaySeconds > Math.round(MAX_DELAY_MS / 1000),
      batch_id: batchId,
      pes_unit: Number(item.unitStrapiId || 0) || null,
    };

    try {
      await createOperationLogSafe(payload);
    } catch (e) {
      console.error(
        "[pes-module] Не удалось записать историю ПЭС:",
        e?.response?.data?.error?.message || e?.message || e
      );
    }
  }
}

function toHistoryDto(row) {
  const unit = oneRelation(row?.pes_unit);
  return {
    id: row.documentId || row.id,
    eventUid: row.event_uid || "",
    eventTime: row.event_time || null,
    action: row.action || "",
    statusFrom: row.status_from || null,
    statusTo: row.status_to || null,
    result: row.result || null,
    errorText: row.error_text || null,
    comment: row.comment || null,
    branch: row.branch || null,
    po: row.po || null,
    destinationType: row.destination_type || null,
    destinationTitle: row.destination_title || null,
    destinationAddress: row.destination_address || null,
    actorRole: row.actor_role || null,
    actorLogin: row.actor_login || null,
    actorChatId: row.actor_chat_id ?? null,
    commandSentAt: row.command_sent_at || null,
    actualDepartureAt: row.actual_departure_at || null,
    delaySeconds: row.delay_seconds ?? null,
    delayOver15m: Boolean(row.delay_over_15m),
    batchId: row.batch_id || null,
    pes: unit
      ? {
          id: unit.code || String(unit.id || ""),
          number: unit.garage_number || null,
          name: unit.pes_name || null,
          branch: unit.branch || null,
        }
      : null,
  };
}

router.get("/items", async (req, res) => {
  try {
    const branch = String(req.query.branch || "").trim().toLowerCase();
    const po = String(req.query.po || "").trim().toLowerCase();
    const statusRaw = String(req.query.status || "").trim().toLowerCase();
    const status = statusRaw === "delayed" ? PES_STATUS.DELAY : statusRaw;

    let items = await loadSnapshot();
    if (branch) {
      items = items.filter((x) => sameBranch(x.branch, branch));
    }
    if (po) {
      items = items.filter((x) => norm(x.po).toLowerCase().includes(po));
    }
    if (status) {
      items = items.filter((x) => effectiveStatus(x) === status);
    }

    res.json({
      ok: true,
      items: items.map(toDto),
      summary: summaryOf(items),
    });
  } catch (e) {
    console.error("[pes-module] items error", e?.message || e);
    res.status(500).json({ ok: false, message: "Ошибка загрузки ПЭС" });
  }
});

router.get("/history", async (req, res) => {
  try {
    const page = toPositiveInt(req.query.page, 1);
    const pageSize = Math.min(200, toPositiveInt(req.query.pageSize, 50));
    const branch = norm(req.query.branch);
    const po = norm(req.query.po);
    const action = norm(req.query.action).toLowerCase();
    const pesId = norm(req.query.pesId);

    const params = {
      "sort[0]": "event_time:desc",
      "pagination[page]": page,
      "pagination[pageSize]": pageSize,
      populate: "pes_unit",
    };

    if (branch) params["filters[branch][$containsi]"] = branch;
    if (po) params["filters[po][$containsi]"] = po;
    if (action) params["filters[action][$eq]"] = action;
    if (pesId) params["filters[pes_unit][code][$eq]"] = pesId;

    const { rows, pagination } = await fetchPage(PES_ENDPOINTS.OPERATION_LOGS, {
      params,
    });

    res.json({
      ok: true,
      items: rows.map(toHistoryDto),
      pagination: {
        page: Number(pagination.page || page),
        pageSize: Number(pagination.pageSize || pageSize),
        pageCount: Number(pagination.pageCount || 1),
        total: Number(pagination.total || 0),
      },
    });
  } catch (e) {
    console.error("[pes-module] history error", e?.message || e);
    res.status(500).json({ ok: false, message: "Ошибка загрузки истории ПЭС" });
  }
});

router.get("/config", (req, res) => {
  const hasToken = Boolean(process.env.PES_TELEGRAM_BOT_TOKEN);
  const hasChats = Boolean(process.env.PES_TELEGRAM_CHATS);
  const botSubsEnabled = String(process.env.PES_BOT_ENABLED || "1") === "1";
  res.json({
    ok: true,
    telegramConfigured: hasToken && (hasChats || botSubsEnabled),
    strictMode: String(process.env.PES_TELEGRAM_STRICT || "0") === "1",
  });
});

router.get("/destinations", async (req, res) => {
  const mode = String(req.query.mode || "single").toLowerCase();
  const branch = String(req.query.branch || "").trim();
  const tpAllowed = mode !== "multi";

  const assembly = await loadAssemblyDestinations({ branch });
  const tp = tpAllowed ? await loadTpDestinations({ branch }) : [];

  res.json({
    ok: true,
    mode,
    branch: branch || "",
    assembly: clone(assembly),
    tp: clone(tp),
  });
});

router.post("/command", requireManageRole, async (req, res) => {
  const startedAt = Date.now();
  const reject400 = (message) => {
    const msg = String(message || "Bad Request");
    console.warn("[pes-module] command 400:", {
      message: msg,
      action: req.body?.action || null,
      pesIds: Array.isArray(req.body?.pesIds) ? req.body.pesIds : [],
      destinationType: req.body?.destinationType || null,
      destinationId: req.body?.destinationId || null,
      source: req.body?.source || "web",
    });
    return res.status(400).json({ ok: false, message: msg });
  };

  try {
    const {
      action,
      pesIds,
      destinationType,
      destinationId,
      comment,
      actualDepartureAt,
      sourceChatId,
      source,
    } = req.body || {};

    if (!Array.isArray(pesIds) || pesIds.length === 0) {
      return reject400("Не выбраны ПЭС");
    }

    const snapshot = await loadSnapshot();
    const byId = new Map(snapshot.map((x) => [x.id, x]));
    const items = pesIds.map((id) => byId.get(id)).filter(Boolean);

    if (items.length !== pesIds.length) {
      return res.status(404).json({ ok: false, message: "Часть ПЭС не найдена" });
    }

    const mode = items.length > 1 ? "multi" : "single";

    if (["dispatch", "reroute"].includes(action)) {
      const branchHint = mode === "single" ? items[0]?.branch || "" : "";
      const pick = await pickDestination({
        mode,
        destinationType,
        destinationId,
        branchHint,
      });
      if (pick?.error) {
        return reject400(pick.error);
      }
      if (!pick?.value) {
        return reject400("Точка назначения не найдена");
      }
    }

    for (const item of items) {
      const current = effectiveStatus(item);

      if (action === "dispatch" && current !== PES_STATUS.READY) {
        return reject400(
          `ПЭС №${item.number} нельзя отправить: текущий статус ${current}`
        );
      }

      if (
        action === "depart" &&
        ![PES_STATUS.COMMAND_SENT, PES_STATUS.DELAY].includes(current)
      ) {
        return reject400(
          `ПЭС №${item.number} нельзя перевести в 'В пути' из статуса ${current}`
        );
      }
    }

    let destination = null;
    if (["dispatch", "reroute"].includes(action)) {
      const branchHint = mode === "single" ? items[0]?.branch || "" : "";
      const pick = await pickDestination({
        mode,
        destinationType,
        destinationId,
        branchHint,
      });
      destination = pick?.value || null;
    }

    const now = Date.now();
    const beforeStatusMap = new Map(items.map((it) => [it.id, effectiveStatus(it)]));
    const updateSource = normalizeUpdateSource(
      source,
      Number.isFinite(Number(sourceChatId)) ? "telegram" : "web"
    );

    for (const item of items) {
      if (action === "dispatch") {
        item.status = PES_STATUS.COMMAND_SENT;
        item.commandSentAt = now;
        item.actualDepartureAt = null;
        item.connectedAt = null;
        item.destination = destination;
        item.lastComment = comment || null;
      } else if (action === "reroute") {
        item.destination = destination;
        item.reroutedAt = now;
        item.lastComment = comment || null;
      } else if (action === "cancel") {
        item.status = PES_STATUS.READY;
        item.destination = null;
        item.commandSentAt = null;
        item.actualDepartureAt = null;
        item.connectedAt = null;
        item.lastComment = comment || null;
      } else if (action === "depart") {
        item.status = PES_STATUS.EN_ROUTE;
        item.actualDepartureAt = actualDepartureAt
          ? new Date(actualDepartureAt).getTime()
          : now;
      } else if (action === "connect") {
        item.status = PES_STATUS.CONNECTED;
        item.connectedAt = now;
      } else if (action === "ready") {
        item.status = PES_STATUS.READY;
        item.destination = null;
        item.commandSentAt = null;
        item.actualDepartureAt = null;
        item.connectedAt = null;
      } else if (action === "repair") {
        item.status = PES_STATUS.REPAIR;
      }

      await persistState(item, { source: updateSource, chatId: sourceChatId });
    }

    const branch = items[0]?.branch || "";

    let telegramResult = { ok: true, skipped: true, reason: "not-required" };
    if (["dispatch", "cancel", "reroute"].includes(action)) {
      telegramResult = await sendPesTelegram({
        action,
        branch,
        items,
        destination,
        comment,
      });
    }

    const subscribersResult = await sendPesSubscribersNotification({
      action,
      branch,
      items,
      destination,
      comment,
    });

    await appendOperationLogs({
      action,
      items,
      destination,
      comment,
      req,
      beforeStatusMap,
      sourceChatId,
    });

    const refreshed = await loadSnapshot();

    res.json({
      ok: true,
      telegram: telegramResult,
      subscribers: subscribersResult,
      updated: items.map((x) => toDto(x)),
      summary: summaryOf(refreshed),
    });
  } catch (e) {
    const apiMsg =
      e?.response?.data?.error?.message ||
      e?.response?.data?.message ||
      e?.message ||
      "Ошибка обработки команды ПЭС";
    console.error("[pes-module] command error", apiMsg);
    res.status(500).json({ ok: false, message: apiMsg });
  } finally {
    setImmediate(() => {
      logAuditFromReq(req, {
        page: "/services/pes/module/command",
        action: "pes_command",
        entity: "pes",
        entity_id: Array.isArray(req.body?.pesIds)
          ? req.body.pesIds.join(",")
          : "",
        details: {
          command: req.body?.action || "",
          status: res.statusCode,
          duration_ms: Date.now() - startedAt,
        },
      }).catch(() => {});
    });
  }
});

module.exports = router;
