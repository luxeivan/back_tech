// Конфиг MAX-бота: env-переменные, базовые флаги и логирование.
const MAX_BOT_TOKEN = String(process.env.PES_MAX_BOT_TOKEN || "").trim();
const MAX_BOT_ENABLED = String(process.env.PES_MAX_BOT_ENABLED || "1") === "1";
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

function buildHeaders() {
  return {
    Authorization: MAX_BOT_TOKEN,
    "Content-Type": "application/json",
  };
}

module.exports = {
  MAX_BOT_TOKEN,
  MAX_BOT_ENABLED,
  MAX_API_BASE,
  maxLog,
  canRunMaxBot,
  buildHeaders,
};
