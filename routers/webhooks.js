const express = require("express");
const router = express.Router();
const { broadcast } = require("../services/sse");

const TN_FILIALY_REZIM_UPDATED_EVENT = "tn-filialy-rezim-updated";
const WEBHOOK_LOG_PREFIX = "[webhook][strapi]";

function getWebhookEntry(payload) {
  return payload?.entry || payload?.data || payload?.result || null;
}

function getWebhookModel(payload) {
  return String(
    payload?.uid ||
      payload?.model ||
      payload?.modelUid ||
      payload?.contentType ||
      payload?.contentTypeUid ||
      ""
  ).toLowerCase();
}

function getWebhookSummary(payload) {
  const entry = getWebhookEntry(payload) || {};

  return {
    event: payload?.event || null,
    uid: payload?.uid || payload?.model || payload?.modelUid || null,
    entryId: entry.documentId || entry.id || null,
    entryName: entry.name || entry.number || entry.title || null,
  };
}

function logWebhookResult(status, message, payload, extra = {}) {
  console.log(`${WEBHOOK_LOG_PREFIX} ${status}: ${message}`, {
    ...getWebhookSummary(payload),
    ...extra,
  });
}

function isTnFilialyWebhook(payload) {
  const model = getWebhookModel(payload);
  const entry = getWebhookEntry(payload);
  const entryType = String(entry?.__contentType || entry?.contentType || "").toLowerCase();

  return (
    model.includes("tn-filialy") ||
    model.includes("tn-filialies") ||
    entryType.includes("tn-filialy") ||
    entryType.includes("tn-filialies")
  );
}

function isTnWebhook(payload) {
  const model = getWebhookModel(payload);
  return (
    isTnFilialyWebhook(payload) ||
    model.includes("teh-narusheniya") ||
    model.includes("tn-")
  );
}

function buildTnFilialyModeEvent(payload) {
  const entry = getWebhookEntry(payload) || {};
  const id = entry.documentId || entry.id || null;
  const name = entry.name || "";
  const rezim = entry.rezim || "";
  const timestamp = Date.now();

  return {
    type: TN_FILIALY_REZIM_UPDATED_EVENT,
    source: "strapi-webhook",
    event: payload?.event || null,
    uid: payload?.uid || null,
    model: payload?.model || null,
    rezim,
    filialIds: id ? [id] : [],
    filials: name
      ? [
          {
            id: entry.id || null,
            documentId: entry.documentId || null,
            name,
          },
        ]
      : [],
    timestamp,
  };
}

router.all("/", (req, res) => {
  try {
    const method = req.method.toUpperCase();

    if (method === "GET" || method === "HEAD") {
      console.log("🔍 Вебхук: проверка доступности (", method, ")");
      return res.status(200).json({ message: "Эндпоинт вебхука доступен" });
    }

    if (method === "POST") {
      const payload = req.body;
      logWebhookResult("IN", "получен POST от Strapi", payload, {
        headerEvent: req.get("X-Strapi-Event") || null,
      });

      if (process.env.DEBUG_STRAPI_WEBHOOK_PAYLOAD === "true") {
        console.log(`${WEBHOOK_LOG_PREFIX} payload:`, JSON.stringify(payload, null, 2));
      }

      if (!isTnWebhook(payload)) {
        logWebhookResult("SKIP", "не ТН-событие, SSE не отправляем", payload);
        return res.json({ skipped: true, reason: "not_tn_webhook" });
      }

      if (isTnFilialyWebhook(payload)) {
        const eventPayload = buildTnFilialyModeEvent(payload);

        broadcast(eventPayload);
        logWebhookResult("OK", "режим филиала распознан, SSE отправлен", payload, {
          event: eventPayload.event,
          rezim: eventPayload.rezim,
          filialIds: eventPayload.filialIds,
          filials: eventPayload.filials.map((item) => item.name),
        });

        return res.json({ message: "Вебхук принят", modeEvent: true });
      }

      broadcast({
        type: "strapi-webhook",
        event: payload?.event,
        uid: payload?.uid,
        model: payload?.model,
        entry: payload?.entry,
        timestamp: Date.now(),
      });
      logWebhookResult("OK", "ТН-событие принято, общий SSE отправлен", payload);

      return res.json({ message: "Вебхук принят" });
    }

    // На всякий — остальные методы завершаем 204
    return res.sendStatus(204);
  } catch (e) {
    console.error(`${WEBHOOK_LOG_PREFIX} ERROR: ошибка обработки`, e);
    return res.status(500).json({ error: "Ошибка обработки вебхука" });
  }
});

module.exports = router;
