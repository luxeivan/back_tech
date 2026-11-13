// Бот пресс-службы (TN_MAX_BOT_PRESS): приветствие по «Начать» + выбор
// округа-подписки из Strapi (tn-okruga), пагинация по 10 кнопок в столбик.
const axios = require("axios");
const { getJwt } = require("../modus/strapi");

const PAGE_SIZE = 10; // округов на странице (в столбик)
const TTL_MS = 10 * 60 * 1000; // время жизни кэша списка округов
let cache = { at: 0, rows: null };
let polling = false;
let marker = null;

// Текст приветствия — правится здесь.
const GREETING = [
  "Здравствуйте! Это бот пресс-службы АО «Мособлэнерго».",
  "",
  "Здесь вы можете получить информацию о плановых и аварийных отключениях.",
].join("\n");

// Базовый URL MAX API.
const apiBase = () =>
  String(process.env.TN_MAX_API_BASE || "https://platform-api.max.ru").replace(/\/$/, "");

// Токен бота из .env.
const token = () => String(process.env.TN_MAX_BOT_PRESS || "").trim();

// Лог с префиксом [press-bot].
const log = (tag, payload) =>
  payload === undefined
    ? console.log(`[press-bot] ${tag}`)
    : console.log(`[press-bot] ${tag}`, payload);

// Кнопка: payload = "action" или "action|значение".
const button = (text, action, value) => ({
  type: "callback",
  text,
  payload: value === undefined ? action : `${action}|${value}`,
});

// Ряды кнопок → attachment inline_keyboard для MAX.
const keyboard = (rows) => [{ type: "inline_keyboard", payload: { buttons: rows } }];

// Разбор payload кнопки на действие и значение.
const decode = (raw) => {
  const s = String(raw || "");
  const i = s.indexOf("|");
  return i < 0 ? { action: s, value: "" } : { action: s.slice(0, i), value: s.slice(i + 1) };
};

// Активные округа из Strapi с кэшем на 10 минут.
async function fetchDistricts() {
  if (cache.rows && Date.now() - cache.at < TTL_MS) return cache.rows;

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

  const rows = (data?.data || [])
    .filter((r) => r?.name && r.is_active !== false)
    .map((r) => String(r.name).trim())
    .sort((a, b) => a.localeCompare(b, "ru"));
  cache = { at: Date.now(), rows };
  log(`округа загружены: ${rows.length}`);
  return rows;
}

// Текст + клавиатура страницы округов; страница живёт в payload (stateless).
async function buildDistrictsMessage(pageIndex) {
  const all = await fetchDistricts();
  const pages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
  const page = Math.min(Math.max(0, Number(pageIndex) || 0), pages - 1);
  const slice = all.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const rows = slice.map((name) => [button(name, "pick", name)]);
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

// Кому отвечать: chat_id из update, иначе user_id отправителя.
function replyTarget(update) {
  const chatId = Number(update?.chat_id || update?.message?.recipient?.chat_id);
  if (chatId > 0) return { chat_id: chatId };
  const sender =
    update?.user || update?.sender || update?.message?.sender || update?.callback?.sender;
  const userId = Number(update?.user_id || sender?.user_id);
  if (userId > 0) return { user_id: userId };
  const dialog = Number(update?.message?.recipient?.chat?.dialog_with_user?.user_id);
  return dialog > 0 ? { user_id: dialog } : null;
}

// Отправить сообщение (текст + опц. клавиатура) в личку/чат.
async function sendMessage(target, text, attachments) {
  const body = { text };
  if (attachments?.length) body.attachments = attachments;
  const { data } = await axios.post(`${apiBase()}/messages`, body, {
    headers: { Authorization: token(), "Content-Type": "application/json" },
    params: target,
    timeout: 20000,
  });
  return data;
}

// Ответить на кнопку: с text/attachments заменяет сообщение, иначе — тост notification.
async function answerCallback(callbackId, { text, attachments, notification } = {}) {
  if (!callbackId) return;
  const body = {};
  if (notification) body.notification = notification;
  if (text || attachments?.length) {
    body.message = {};
    if (text) body.message.text = text;
    if (attachments?.length) body.message.attachments = attachments;
  }
  await axios.post(`${apiBase()}/answers`, body, {
    headers: { Authorization: token(), "Content-Type": "application/json" },
    params: { callback_id: callbackId },
    timeout: 20000,
  });
}

// Приветствие с кнопкой «Выбрать подписку».
async function sendGreeting(update) {
  const target = replyTarget(update);
  if (!target) return log("приветствие: нет target", update?.update_type || "");
  await sendMessage(target, GREETING, keyboard([[button("Выбрать подписку", "subs")]]));
  log("приветствие отправлено", target);
}

// Данные пользователя и клика по округу для лога (база будущих подписок в Strapi).
function pickLog(update, district) {
  const cb = update?.callback || {};
  const user = cb.sender || cb.user || update?.user || update?.sender || null;
  const msg = cb.message || update?.message || null;
  return {
    district,
    user_id: cb.user_id || update?.user_id || user?.user_id || null,
    username: user?.username || null,
    name: [user?.first_name, user?.last_name].filter(Boolean).join(" ") || null,
    chat_id: msg?.recipient?.chat_id || update?.chat_id || null,
    mid: msg?.body?.mid || msg?.mid || null,
    callback_id: cb.callback_id || cb.id || null,
    at: new Date().toISOString(),
    user, // всё, что MAX дал о пользователе (полный объект)
  };
}

// Кнопки меню: subs/page — листать округа, pick — заглушка «Скоро».
async function handleCallback(update) {
  const callbackId = String(update?.callback?.callback_id || update?.callback?.id || "").trim();
  if (!callbackId) return;
  const { action, value } = decode(update?.callback?.payload || update?.callback?.data || "");
  try {
    if (action === "subs" || action === "page") {
      const page = action === "page" ? Number(value) : 0;
      await answerCallback(callbackId, await buildDistrictsMessage(page));
    } else if (action === "pick") {
      log("выбор округа", pickLog(update, value));
      await answerCallback(callbackId, { notification: "Скоро" }); // подписки — следующим шагом
    } else {
      await answerCallback(callbackId, { notification: "Неизвестная команда" });
    }
  } catch (e) {
    log("ошибка callback", e?.response?.data || e?.message || e);
    await answerCallback(callbackId, { notification: "Ошибка, попробуйте позже" }).catch(() => {});
  }
}

// Диспетчер update: старт/«начать» → приветствие, callback → меню.
async function processUpdate(update) {
  const type = String(update?.update_type || "").toLowerCase();
  if (type === "bot_started") return sendGreeting(update);
  if (type === "message_created") {
    const text = String(update?.message?.body?.text || "").trim().toLowerCase();
    if (["начать", "/start", "старт"].includes(text)) await sendGreeting(update);
    return;
  }
  if (type === "message_callback") await handleCallback(update);
}

// Один long-poll запрос /updates (marker — позиция в потоке).
async function fetchUpdates({ timeout = 25, limit = 100 } = {}) {
  const params = { timeout, limit, types: "message_created,bot_started,message_callback" };
  if (Number.isFinite(Number(marker))) params.marker = Number(marker);
  const { data } = await axios.get(`${apiBase()}/updates`, {
    headers: { Authorization: token() },
    params,
    timeout: (timeout + 10) * 1000,
  });
  return {
    updates: Array.isArray(data?.updates) ? data.updates : [],
    marker: Number.isFinite(Number(data?.marker)) ? Number(data.marker) : null,
  };
}

// Стартовый marker = последний, чтобы после рестарта старые update не проигрывались.
async function bootstrapMarker() {
  if (Number.isFinite(Number(marker))) return;
  try {
    const page = await fetchUpdates({ timeout: 0, limit: 1 });
    if (Number.isFinite(Number(page.marker))) marker = Number(page.marker);
  } catch (e) {
    log("marker не инициализирован", e?.response?.data || e?.message || e);
  }
}

// Цикл опроса: обработать update, через 1 с опросить снова.
async function pollLoop() {
  try {
    const page = await fetchUpdates();
    for (const update of page.updates) {
      try {
        await processUpdate(update);
      } catch (e) {
        log("ошибка обработки update", e?.response?.data || e?.message || e);
      }
    }
    if (Number.isFinite(Number(page.marker))) marker = Number(page.marker);
  } catch (e) {
    log("ошибка polling", e?.response?.data || e?.message || e);
  } finally {
    setTimeout(pollLoop, 1000);
  }
}

// Точка входа из app.js: включается только при заданном токене.
async function startPressBotPolling() {
  if (!token()) return log("отключен (нет TN_MAX_BOT_PRESS)");
  if (polling) return;
  polling = true;
  log("polling запущен");
  await bootstrapMarker();
  pollLoop();
}

module.exports = { startPressBotPolling, fetchDistricts, buildDistrictsMessage, processUpdate };
