const express = require("express");
const {
  MAX_BOT_TOKEN,
  MAX_WEBHOOK_SECRET,
  MAX_WEBHOOK_UPDATE_TYPES,
  MAX_WEBHOOK_URL,
  canRegisterMaxWebhook,
  canUseMaxWebhook,
  maxLog,
} = require("../services/pes/max/config");
const { processUpdate } = require("../services/pes/max/handlers");
const {
  listWebhookSubscriptions,
  createWebhookSubscription,
  deleteWebhookSubscription,
} = require("../services/pes/max/transport");

const router = express.Router();

function roleFromReq(req) {
  return String(req.get("x-view-role") || "").trim().toLowerCase();
}

function requirePreview(req, res, next) {
  if (roleFromReq(req) !== "preview") {
    return res.status(403).json({
      ok: false,
      message: "Доступно только роли preview",
    });
  }
  next();
}

function verifyWebhookSecret(req, res, next) {
  if (!canUseMaxWebhook()) {
    return res.status(503).json({
      ok: false,
      message: "MAX бот отключен или не настроен",
    });
  }

  if (!MAX_WEBHOOK_SECRET) return next();

  const headerSecret = String(req.get("x-max-bot-api-secret") || "").trim();
  if (headerSecret !== MAX_WEBHOOK_SECRET) {
    maxLog("webhook: неверный secret", {
      ip: req.ip,
      has_header: Boolean(headerSecret),
    });
    return res.status(403).json({
      ok: false,
      message: "Неверный secret MAX webhook",
    });
  }

  next();
}

router.get("/webhook/status", (req, res) => {
  res.json({
    ok: true,
    mode: "webhook",
    token: Boolean(MAX_BOT_TOKEN),
    enabled: canUseMaxWebhook(),
    url: MAX_WEBHOOK_URL || null,
    update_types: MAX_WEBHOOK_UPDATE_TYPES,
    secret: Boolean(MAX_WEBHOOK_SECRET),
    can_receive: canUseMaxWebhook(),
    can_register: canRegisterMaxWebhook(),
  });
});

router.post("/webhook", verifyWebhookSecret, async (req, res) => {
  const update = req.body;

  try {
    if (!update || typeof update !== "object") {
      return res.status(400).json({ ok: false, message: "Пустой update MAX" });
    }

    res.json({ ok: true });

    processUpdate(update).catch((e) => {
      console.error(
        "[pes-max-bot] webhook: ошибка обработки update:",
        e?.response?.data || e?.message || e
      );
    });
  } catch (e) {
    console.error(
      "[pes-max-bot] webhook: ошибка приема update:",
      e?.response?.data || e?.message || e
    );
    if (!res.headersSent) {
      res.status(500).json({ ok: false, message: "Ошибка MAX webhook" });
    }
  }
});

router.get("/webhook/subscribe", requirePreview, async (req, res) => {
  if (!MAX_BOT_TOKEN) {
    return res.status(400).json({
      ok: false,
      message: "Не задан PES_MAX_BOT_TOKEN",
    });
  }

  try {
    const data = await listWebhookSubscriptions();
    res.json({ ok: true, data });
  } catch (e) {
    res.status(502).json({
      ok: false,
      message: e?.response?.data?.message || e?.message || "Ошибка чтения MAX webhook subscriptions",
      data: e?.response?.data || null,
    });
  }
});

router.post("/webhook/subscribe", requirePreview, async (req, res) => {
  const url = String(req.body?.url || req.query?.url || MAX_WEBHOOK_URL || "").trim();
  const secret = String(req.body?.secret || req.query?.secret || MAX_WEBHOOK_SECRET || "").trim();
  const updateTypesRaw = req.body?.update_types || req.query?.update_types || MAX_WEBHOOK_UPDATE_TYPES;
  const updateTypes = Array.isArray(updateTypesRaw)
    ? updateTypesRaw
    : String(updateTypesRaw || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);

  if (!canRegisterMaxWebhook(url)) {
    return res.status(400).json({
      ok: false,
      message: "Не задан PES_MAX_BOT_TOKEN/PES_MAX_BOT_ENABLED или url webhook",
    });
  }

  try {
    const data = await createWebhookSubscription({
      url,
      secret,
      updateTypes: updateTypes.length ? updateTypes : MAX_WEBHOOK_UPDATE_TYPES,
    });
    res.json({ ok: true, data });
  } catch (e) {
    res.status(502).json({
      ok: false,
      message: e?.response?.data?.message || e?.message || "Ошибка регистрации MAX webhook",
      data: e?.response?.data || null,
    });
  }
});

router.delete("/webhook/subscribe", requirePreview, async (req, res) => {
  const url = String(req.body?.url || req.query?.url || MAX_WEBHOOK_URL || "").trim();

  if (!MAX_BOT_TOKEN || !url) {
    return res.status(400).json({
      ok: false,
      message: "Не задан PES_MAX_BOT_TOKEN или url webhook",
    });
  }

  try {
    const data = await deleteWebhookSubscription({ url });
    res.json({ ok: true, data });
  } catch (e) {
    res.status(502).json({
      ok: false,
      message: e?.response?.data?.message || e?.message || "Ошибка удаления MAX webhook",
      data: e?.response?.data || null,
    });
  }
});

module.exports = router;
