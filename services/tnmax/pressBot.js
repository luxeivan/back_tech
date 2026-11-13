// Бот пресс-службы (TN_MAX_BOT_PRESS): long-polling update, приветствие
// по кнопке «Начать» и выбор подписки на округа (tn-okruga из Strapi).
const axios = require("axios");
const { getJwt } = require("../modus/strapi");

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

// --- Клавиатуры -----------------------------------------------------------

function button(text, action, value) {
  return {
    type: "callback",
    text,
    payload: value === undefined ? action : `${action}|${value}`,
  };
}

function keyboard(rows) {
  return [
    {
      type: "inline_keyboard",
      payload: { buttons: rows },
    },
  ];
}

function decodePayload(raw) {
  const source = String(raw || "");
  const idx = source.indexOf("|");
  if (idx < 0) return { action: source, value: "" };
  return { action: source.slice(0, idx), value: source.slice(idx + 1) };
}

const GREETING_KEYBOARD = keyboard([[button("Выбрать подписку", "subs")]]);

// --- Округа (tn-okruga) ---------------------------------------------------

const PAGE_SIZE = 10; // по 10 в столбик: 60 округов = 6 страниц
const COLS = 1;
const DISTRICTS_TTL_MS = 10 * 60 * 1000;
const districtsCache = { at: 0, rows: null };

async function fetchDistricts() {
  if (districtsCache.rows && Date.now() - districtsCache.at < DISTRICTS_TTL_MS) {
    return districtsCache.rows;
  }

  const jwt = await getJwt();
  if (!jwt) throw new Error("Нет JWT для Strapi");

  const { data } = await axios.get(`${process.env.URL_STRAPI}/api/tn-okruga`, {
    headers: { Authorization: `Bearer ${jwt}` },
    params: {
      "pagination[pageSize]": 100,
      "fields[0]": "name",
      "fields[1]": "is_active",
      "sort": "name:asc",
    },
    timeout: 15000,
  });

  const rows = (Array.isArray(data?.data) ? data.data : [])
    .filter((r) => r && r.name && r.is_active !== false)
    .map((r) => String(r.name).trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, "ru"));

  districtsCache.at = Date.now();
  districtsCache.rows = rows;
  botLog(`округа загружены: ${rows.length}`);
  return rows;
}

async function buildDistrictsMessage(pageIndex) {
  const all = await fetchDistricts();
  const pages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
  const page = Math.min(Math.max(0, Number(pageIndex) || 0), pages - 1);
  const slice = all.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const rows = [];
  for (let i = 0; i < slice.length; i += COLS) {
    rows.push(slice.slice(i, i + COLS).map((name) => button(name, "pick", name)));
  }

  const nav = [];
  if (page > 0) nav.push(button("◀️", "page", page - 1));
  nav.push(button(`Страница ${page + 1}/${pages}`, "page", page));
  if (page < pages - 1) nav.push(button("▶️", "page", page + 1));
  rows.push(nav);

  return {
    text: `Выберите округ для подписки (всего ${all.length}):`,
    attachments: keyboard(rows),
  };
}

// --- Отправка / ответы ----------------------------------------------------

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

async function sendMessage(target, text, attachments) {
  const token = getToken();
  if (!token) throw new Error("Не задан TN_MAX_BOT_PRESS");

  const body = { text };
  if (Array.isArray(attachments) && attachments.length) {
    body.attachments = attachments;
  }

  const { data } = await axios.post(`${apiBase()}/messages`, body, {
    headers: { Authorization: token, "Content-Type": "application/json" },
    params: target,
    timeout: 20000,
  });
  return data;
}

// Ответ на callback: с текстом/клавиатурой заменяет исходное сообщение.
async function answerCallback(callbackId, { text, attachments, notification } = {}) {
  if (!callbackId) return;
  const token = getToken();
  if (!token) throw new Error("Не задан TN_MAX_BOT_PRESS");

  const body = {};
  if (notification) body.notification = notification;
  if (text || (Array.isArray(attachments) && attachments.length)) {
    body.message = {};
    if (text) body.message.text = text;
    if (Array.isArray(attachments) && attachments.length) {
      body.message.attachments = attachments;
    }
  }

  await axios.post(`${apiBase()}/answers`, body, {
    headers: { Authorization: token, "Content-Type": "application/json" },
    params: { callback_id: callbackId },
    timeout: 20000,
  });
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
  await sendMessage(target, GREETING_TEXT, GREETING_KEYBOARD);
  botLog("приветствие отправлено", target);
}

// --- Обработка update -----------------------------------------------------

function getMessageText(update) {
  return String(update?.message?.body?.text || "").trim().toLowerCase();
}

async function handleCallback(update) {
  const callbackId = String(
    update?.callback?.callback_id || update?.callback?.id || ""
  ).trim();
  const { action, value } = decodePayload(
    update?.callback?.payload || update?.callback?.data || ""
  );

  if (!callbackId) {
    botLog("callback без callback_id", {
      update_type: update?.update_type,
      callback: update?.callback || null,
    });
    return;
  }

  try {
    if (action === "subs") {
      const msg = await buildDistrictsMessage(0);
      await answerCallback(callbackId, msg);
      return;
    }

    if (action === "page") {
      const msg = await buildDistrictsMessage(Number(value));
      await answerCallback(callbackId, msg);
      return;
    }

    if (action === "pick") {
      // Подписки реализуем следующим шагом — пока заглушка.
      await answerCallback(callbackId, { notification: "Скоро" });
      return;
    }

    await answerCallback(callbackId, { notification: "Неизвестная команда" });
  } catch (e) {
    botLog(
      "ошибка callback",
      e?.response?.data || e?.message || e
    );
    await answerCallback(callbackId, {
      notification: "Ошибка, попробуйте позже",
    }).catch(() => {});
  }
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
    return;
  }

  if (updateType === "message_callback") {
    await handleCallback(update);
  }
}

// --- Long-polling ---------------------------------------------------------

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
  fetchDistricts,
  buildDistrictsMessage,
};
