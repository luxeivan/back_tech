const express = require("express");
const {
  loadPesItems,
  loadAssemblyDestinations,
  loadTpDestinations,
} = require("../services/pesModuleData");
const { sendPesTelegram } = require("../services/pesTelegram");
const { sendPesSubscribersNotification } = require("../services/pesBot");
const { logAuditFromReq } = require("../services/auditLogger");

const router = express.Router();

const PES_STATUS = {
  READY: "ready",
  COMMAND_SENT: "command_sent",
  EN_ROUTE: "en_route",
  CONNECTED: "connected",
  REPAIR: "repair",
};

const MAX_DELAY_MS = 15 * 60 * 1000;
const store = new Map();

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

function normalizeStatus(item) {
  if (
    item.status === PES_STATUS.COMMAND_SENT &&
    !item.actualDepartureAt &&
    item.commandSentAt &&
    Date.now() - Number(item.commandSentAt) > MAX_DELAY_MS
  ) {
    return "delayed";
  }
  return item.status;
}

function toDto(item) {
  return {
    ...item,
    effectiveStatus: normalizeStatus(item),
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

async function pickDestination({
  mode,
  destinationType,
  destinationId,
  branchHint,
}) {
  const list =
    destinationType === "tp"
      ? await loadTpDestinations({ branch: branchHint || "" })
      : await loadAssemblyDestinations({ branch: branchHint || "" });
  const found = list.find((x) => x.id === destinationId);
  if (!found) return null;

  if (mode === "multi" && destinationType !== "assembly") {
    return { error: "При множественном выборе доступна только точка сбора ПЭС" };
  }

  return { value: clone(found) };
}

async function syncStoreWithStrapi() {
  const baseItems = await loadPesItems();
  const seen = new Set();

  for (const item of baseItems) {
    if (!item?.id) continue;
    seen.add(item.id);

    const prev = store.get(item.id);
    if (!prev) {
      store.set(item.id, {
        ...item,
        status: item.status || PES_STATUS.READY,
        commandSentAt: null,
        actualDepartureAt: null,
        connectedAt: null,
        destination: null,
        lastComment: null,
        reroutedAt: null,
      });
      continue;
    }

    store.set(item.id, {
      ...prev,
      ...item,
      status: prev.status || item.status || PES_STATUS.READY,
      commandSentAt: prev.commandSentAt || null,
      actualDepartureAt: prev.actualDepartureAt || null,
      connectedAt: prev.connectedAt || null,
      destination: prev.destination || null,
      lastComment: prev.lastComment || null,
      reroutedAt: prev.reroutedAt || null,
    });
  }

  for (const id of Array.from(store.keys())) {
    if (!seen.has(id)) store.delete(id);
  }
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
    const s = normalizeStatus(it);
    if (s === PES_STATUS.READY) summary.ready += 1;
    else if (s === PES_STATUS.COMMAND_SENT) summary.commandSent += 1;
    else if (s === "delayed") summary.delayed += 1;
    else if (s === PES_STATUS.EN_ROUTE) summary.enRoute += 1;
    else if (s === PES_STATUS.CONNECTED) summary.connected += 1;
    else if (s === PES_STATUS.REPAIR) summary.repair += 1;
  });

  return summary;
}

router.get("/items", async (req, res) => {
  await syncStoreWithStrapi();

  const branch = String(req.query.branch || "").trim().toLowerCase();
  const po = String(req.query.po || "").trim().toLowerCase();
  const status = String(req.query.status || "").trim().toLowerCase();

  let list = Array.from(store.values());
  if (branch) list = list.filter((x) => x.branch.toLowerCase().includes(branch));
  if (po) list = list.filter((x) => x.po.toLowerCase().includes(po));
  if (status) list = list.filter((x) => normalizeStatus(x) === status);

  const dto = list.map(toDto);
  res.json({ ok: true, items: dto, summary: summaryOf(list) });
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
  try {
    await syncStoreWithStrapi();

    const {
      action,
      pesIds,
      destinationType,
      destinationId,
      comment,
      actualDepartureAt,
    } = req.body || {};

    if (!Array.isArray(pesIds) || pesIds.length === 0) {
      return res.status(400).json({ ok: false, message: "Не выбраны ПЭС" });
    }

    const items = pesIds.map((id) => store.get(id)).filter(Boolean);
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
      if (pick?.error) return res.status(400).json({ ok: false, message: pick.error });
      if (!pick?.value) {
        return res.status(400).json({ ok: false, message: "Точка назначения не найдена" });
      }
    }

    for (const item of items) {
      const current = normalizeStatus(item);

      if (action === "dispatch" && current !== PES_STATUS.READY) {
        return res.status(400).json({
          ok: false,
          message: `ПЭС №${item.number} нельзя отправить: текущий статус ${current}`,
        });
      }

      if (action === "depart" && ![PES_STATUS.COMMAND_SENT, "delayed"].includes(current)) {
        return res.status(400).json({
          ok: false,
          message: `ПЭС №${item.number} нельзя перевести в 'В пути' из статуса ${current}`,
        });
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

    items.forEach((item) => {
      if (action === "dispatch") {
        item.status = PES_STATUS.COMMAND_SENT;
        item.commandSentAt = now;
        item.actualDepartureAt = null;
        item.connectedAt = null;
        item.destination = destination;
        item.lastComment = null;
        return;
      }

      if (action === "reroute") {
        item.destination = destination;
        item.reroutedAt = now;
        item.lastComment = comment || null;
        return;
      }

      if (action === "cancel") {
        item.status = PES_STATUS.READY;
        item.destination = null;
        item.commandSentAt = null;
        item.actualDepartureAt = null;
        item.connectedAt = null;
        item.lastComment = comment || null;
        return;
      }

      if (action === "depart") {
        item.status = PES_STATUS.EN_ROUTE;
        item.actualDepartureAt = actualDepartureAt
          ? new Date(actualDepartureAt).getTime()
          : now;
        return;
      }

      if (action === "connect") {
        item.status = PES_STATUS.CONNECTED;
        item.connectedAt = now;
        return;
      }

      if (action === "ready") {
        item.status = PES_STATUS.READY;
        item.destination = null;
        item.commandSentAt = null;
        item.actualDepartureAt = null;
        item.connectedAt = null;
        return;
      }

      if (action === "repair") {
        item.status = PES_STATUS.REPAIR;
      }
    });

    res.json({
      ok: true,
      telegram: telegramResult,
      subscribers: subscribersResult,
      updated: items.map((x) => toDto(x)),
      summary: summaryOf(Array.from(store.values())),
    });
  } catch (e) {
    console.error("[pes-module] command error", e?.message || e);
    res.status(500).json({ ok: false, message: "Ошибка обработки команды ПЭС" });
  } finally {
    setImmediate(() => {
      logAuditFromReq(req, {
        page: "/services/pes/module/command",
        action: "pes_command",
        entity: "pes",
        entity_id: Array.isArray(req.body?.pesIds) ? req.body.pesIds.join(",") : "",
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
