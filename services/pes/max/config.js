// Конфиг MAX-бота: env-переменные, базовые флаги и логирование.
const MAX_BOT_TOKEN = String(process.env.PES_MAX_BOT_TOKEN || "").trim();
const MAX_BOT_ENABLED = String(process.env.PES_MAX_BOT_ENABLED || "0") === "1";
const MAX_WEBHOOK_SECRET = String(process.env.PES_MAX_WEBHOOK_SECRET || "").trim();
const MAX_WEBHOOK_URL = String(process.env.PES_MAX_WEBHOOK_URL || "").trim();
const MAX_WEBHOOK_UPDATE_TYPES = String(
  process.env.PES_MAX_WEBHOOK_UPDATE_TYPES ||
    "message_created,bot_started,message_callback"
)
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const MAX_API_BASE = String(
  process.env.PES_MAX_API_BASE || "https://platform-api.max.ru"
).replace(/\/$/, "");

function maxLog(tag, payload) {
  if (payload === undefined) {
    console.log(`[pes-max-bot] ${tag}`);
    return;
  }
  console.log(`[pes-max-bot] ${tag}`, payload);
}

function canRunMaxBot() {
  return Boolean(MAX_BOT_ENABLED && MAX_BOT_TOKEN);
}

function canUseMaxWebhook() {
  return Boolean(MAX_BOT_ENABLED && MAX_BOT_TOKEN);
}

function canRegisterMaxWebhook(url = MAX_WEBHOOK_URL) {
  return Boolean(canUseMaxWebhook() && String(url || "").trim());
}

function buildHeaders() {
  return {
    Authorization: MAX_BOT_TOKEN,
    "Content-Type": "application/json",
  };
}

module.exports = {
  MAX_BOT_TOKEN,
  MAX_BOT_ENABLED,
  MAX_WEBHOOK_SECRET,
  MAX_WEBHOOK_URL,
  MAX_WEBHOOK_UPDATE_TYPES,
  MAX_API_BASE,
  maxLog,
  canRunMaxBot,
  canUseMaxWebhook,
  canRegisterMaxWebhook,
  buildHeaders,
};
