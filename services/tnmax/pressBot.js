// Бот пресс-службы (TN_MAX_BOT_PRESS): long-polling update и приветствие
// по кнопке «Начать» (update bot_started) или тексту «начать»/«/start».
const axios = require("axios");

function apiBase() {
  return String(process.env.TN_MAX_API_BASE || "https://platform-api.max.ru").replace(/\/$/, "");
}

function botLog(tag, payload) {
  if (payload === undefined) {
    console.log(`[press-bot] ${tag}`);
    return;
  }
  console.log(`[press-bot] ${tag}`, payload);
}

function getToken() {
  return String(process.env.TN_MAX_BOT_PRESS || "").trim();
}

// Текст приветствия — единый для всех (без условий), правится здесь.
const GREETING_TEXT = [
  "Здравствуйте! Это бот пресс-службы АО «Мособлэнерго».",
  "",
  "Здесь вы можете получить информацию о плановых и аварийных отключениях.",
].join("\n");

function getSenderUserId(update) {
  const sender =
    update?.user ||
    update?.sender ||
    update?.message?.sender ||
    update?.callback?.sender ||
    null;
  const userId = Number(
    update?.user_id || update?.user?.user_id || sender?.user_id
  );
  return Number.isFinite(userId) && userId > 0 ? userId : null;
}

function getReplyTarget(update) {
  const chatId = Number(update?.chat_id || update?.message?.recipient?.chat_id);
  if (Number.isFinite(chatId) && chatId > 0) return { chat_id: chatId };

  const userId = getSenderUserId(update);
  if (userId) return { user_id: userId };

  const dialogUserId = Number(
    update?.message?.recipient?.chat?.dialog_with_user?.user_id
  );
  if (Number.isFinite(dialogUserId) && dialogUserId > 0) {
    return { user_id: dialogUserId };
  }
  return null;
}

async function sendMessage(target, text) {
  const token = getToken();
  if (!token) throw new Error("Не задан TN_MAX_BOT_PRESS");

  const { data } = await axios.post(
    `${apiBase()}/messages`,
    { text },
    {
      headers: { Authorization: token, "Content-Type": "application/json" },
      params: target,
      timeout: 20000,
    }
  );
  return data;
}

async function sendGreeting(update) {
  const target = getReplyTarget(update);
  if (!target) {
    botLog("приветствие: нет target для ответа", {
      update_type: update?.update_type,
      keys: update && typeof update === "object" ? Object.keys(update) : [],
    });
    return;
  }
  await sendMessage(target, GREETING_TEXT);
  botLog("приветствие отправлено", target);
}

function getMessageText(update) {
  return String(update?.message?.body?.text || "").trim().toLowerCase();
}

async function processUpdate(update) {
  const updateType = String(update?.update_type || "").toLowerCase();

  if (updateType === "bot_started") {
    await sendGreeting(update);
    return;
  }

  if (updateType === "message_created") {
    const text = getMessageText(update);
    if (text === "начать" || text === "/start" || text === "старт") {
      await sendGreeting(update);
    }
  }
}

async function fetchUpdates({ marker, timeout = 25, limit = 100 } = {}) {
  const token = getToken();
  if (!token) throw new Error("Не задан TN_MAX_BOT_PRESS");

  const params = {
    timeout,
    limit,
    types: "message_created,bot_started,message_callback",
  };
  if (Number.isFinite(Number(marker))) params.marker = Number(marker);

  const { data } = await axios.get(`${apiBase()}/updates`, {
    headers: { Authorization: token },
    params,
    timeout: (timeout + 10) * 1000,
  });

  return {
    updates: Array.isArray(data?.updates) ? data.updates : [],
    marker: Number.isFinite(Number(data?.marker)) ? Number(data.marker) : null,
  };
}

let pollingStarted = false;
let pollingMarker = null;

// Стартовый marker = последний доступный: старые update после рестарта не проигрываем.
async function bootstrapMarkerToLatest() {
  if (Number.isFinite(Number(pollingMarker))) return;
  try {
    const page = await fetchUpdates({ timeout: 0, limit: 1 });
    if (Number.isFinite(Number(page.marker))) {
      pollingMarker = Number(page.marker);
      botLog(`marker инициализирован: ${pollingMarker}`);
    }
  } catch (e) {
    botLog("не удалось инициализировать marker", e?.response?.data || e?.message || e);
  }
}

async function pollLoop() {
  try {
    const page = await fetchUpdates({ marker: pollingMarker, timeout: 25, limit: 100 });

    for (const update of page.updates) {
      try {
        await processUpdate(update);
      } catch (e) {
        botLog("ошибка обработки update", e?.response?.data || e?.message || e);
      }
    }

    if (Number.isFinite(Number(page.marker))) pollingMarker = Number(page.marker);
  } catch (e) {
    botLog("ошибка polling", e?.response?.data || e?.message || e);
  } finally {
    setTimeout(pollLoop, 1000);
  }
}

async function startPressBotPolling() {
  if (!getToken()) {
    botLog("отключен (нет TN_MAX_BOT_PRESS)");
    return;
  }
  if (pollingStarted) return;
  pollingStarted = true;

  botLog("polling запущен");
  await bootstrapMarkerToLatest();
  pollLoop();
}

module.exports = {
  startPressBotPolling,
  GREETING_TEXT,
};
