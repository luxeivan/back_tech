// Бот пресс-службы (TN_MAX_BOT_PRESS): приветствие, выбор округов-подписок
// (накопление ✓ + подтверждение) и хранение в Strapi tn-podpischiki-maxes.
const axios = require("axios");
const { getJwt } = require("../modus/strapi");
const { getDistricts, subscribe, unsubscribe, touchSubscriber, appendHistory } = require("./pressSubsStore");

const PAGE_SIZE = 10; // округов на странице (в столбик)
const MY_PAGE_SIZE = 10; // подписок на странице экрана «Мои подписки»
const TTL_MS = 10 * 60 * 1000; // время жизни кэша списка округов
let cache = { at: 0, rows: null };

// Округа, схлопнутые в одну кнопку: отображаемое имя → имена записей tn-okruga
// (подписка ставится на все id группы разом, чтобы оповещения совпадали с любым вариантом имени).
const MERGED_DISTRICTS = {
  "Орехово-Зуевский": ["Орехово-Зуевский", "Орехово-Зуевский г.о", "Орехово-Зуево"],
};
let polling = false;
let marker = null;
const state = new Map(); // user_id → {page, sel:Set} — выбор в памяти процесса

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

// Два экрана приветствия: выбор подписок и мой список.
const GREETING_KEYBOARD = keyboard([
  [button("Добавить округа", "subs")],
  [button("Мои подписки", "my")],
]);

// user_id из update (callback, приветствие, сообщение).
function cbUserId(update) {
  const cb = update?.callback || {};
  const u = cb.sender || cb.user || update?.user || update?.sender || update?.message?.sender || null;
  const id = Number(cb.user_id || update?.user_id || u?.user_id);
  return Number.isFinite(id) && id > 0 ? id : null;
}

// chat_id диалога из update — для записи max_chat_id подписчика.
function dialogChatId(update) {
  const chatId = Number(
    update?.chat_id ||
      update?.callback?.message?.recipient?.chat_id ||
      update?.message?.recipient?.chat_id
  );
  return Number.isFinite(chatId) && chatId > 0 ? chatId : null;
}

// Фоном запоминает chat_id юзера в записи подписчика (если она есть).
function rememberChat(update) {
  const chatId = dialogChatId(update);
  const userId = cbUserId(update);
  if (!chatId || !userId) return;
  touchSubscriber(userId, chatId).catch((e) =>
    log("touchSubscriber: ошибка", e?.message || e)
  );
}

// Профиль юзера из callback — для записи подписки в Strapi.
function cbProfile(update) {
  const cb = update?.callback || {};
  const u = cb.sender || cb.user || update?.user || update?.sender || null;
  return {
    maxUserId: cbUserId(update),
    username: u?.username || "",
    firstName: u?.first_name || "",
    lastName: u?.last_name || "",
  };
}

// Состояние выбора юзера, создаётся на лету.
function userState(userId) {
  if (!state.has(userId)) state.set(userId, { page: 0, sel: new Set() });
  return state.get(userId);
}

// Активные округа из Strapi (id+имя) с кэшем на 10 минут; группы MERGED_DISTRICTS схлопнуты в одну строку.
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
      sort: "name:asc",
    },
    timeout: 15000,
  });
  const active = (data?.data || [])
    .filter((r) => r?.name && r.is_active !== false)
    .map((r) => ({ id: r.id, name: String(r.name).trim() }));

  const rows = [];
  const consumed = new Set();
  for (const [display, members] of Object.entries(MERGED_DISTRICTS)) {
    const hits = active.filter((r) => members.includes(r.name));
    if (!hits.length) continue;
    // members — только активные (по ним считается «уже подписаны»); неактивные имена
    // входят в MERGED_DISTRICTS лишь для displayNameFor.
    rows.push({ name: display, ids: hits.map((r) => r.id), members: hits.map((r) => r.name) });
    hits.forEach((r) => consumed.add(r.name));
  }
  for (const r of active) {
    if (consumed.has(r.name)) continue;
    rows.push({ name: r.name, ids: [r.id], members: [r.name] });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name, "ru"));

  cache = { at: Date.now(), rows };
  log(`округа загружены: ${rows.length}`);
  return rows;
}

// Имя кнопки для имени записи tn-okruga (обратный маппинг MERGED_DISTRICTS).
function displayNameFor(memberName) {
  for (const [display, members] of Object.entries(MERGED_DISTRICTS)) {
    if (members.includes(memberName)) return display;
  }
  return memberName;
}

// Подписан ли юзер на строку списка полностью (для группы — на все её члены).
function isRowSubscribed(row, subscribed) {
  return row.members.every((m) => subscribed.includes(m));
}

// Страница списка округов: ✓ — в выборе, ✅ — уже подписан; навигация и кнопки действий.
async function buildDistrictsMessage(pageIndex, userId) {
  const all = await fetchDistricts();
  const pages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
  const page = Math.min(Math.max(0, Number(pageIndex) || 0), pages - 1);
  const st = userState(userId);
  st.page = page;
  const subscribed = await getDistricts(userId);
  const slice = all.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const rows = slice.map(({ name, ids, members }) => {
    const row = { name, ids, members };
    const mark = isRowSubscribed(row, subscribed) ? "✅ " : st.sel.has(name) ? "✓ " : "";
    return [button(mark + name, "pick", name)];
  });

  const nav = [];
  if (page > 0) nav.push(button("◀️", "page", page - 1));
  nav.push(button(`Страница ${page + 1}/${pages}`, "page", page));
  if (page < pages - 1) nav.push(button("▶️", "page", page + 1));
  rows.push(nav);
  rows.push([button(`Подтвердить (${st.sel.size})`, "confirm"), button("Очистить", "clear")]);
  rows.push([button("В приветствие", "home")]);

  return {
    text: "Выберите округа, по которым хотите получать уведомления",
    attachments: keyboard(rows),
  };
}

// Экран «Мои подписки»: члены MERGED_DISTRICTS схлопнуты в одну строку; отписка — по имени кнопки.
// Пагинация обязательна: у MAX лимит inline_keyboard — 30 строк, а подписок бывает до 56
// (без неё ответ /answers падал с 400 → «Ошибка, попробуйте позже»; баг Маргариты 17.11.2026).
// pageIndex === undefined — оставить текущую страницу (отписка), иначе перейти на указанную.
async function mySubsMessage(userId, pageIndex) {
  const st = userState(userId);
  const districts = [...new Set((await getDistricts(userId)).map(displayNameFor))];
  const pages = Math.max(1, Math.ceil(districts.length / MY_PAGE_SIZE));
  const wanted = pageIndex === undefined ? st.myPage || 0 : Number(pageIndex) || 0;
  const page = Math.min(Math.max(0, wanted), pages - 1);
  st.myPage = page;

  const slice = districts.slice(page * MY_PAGE_SIZE, (page + 1) * MY_PAGE_SIZE);
  const text = districts.length
    ? `Вы подписаны на уведомления по округам:\n${slice
        .map((d) => `• ${d}`)
        .join("\n")}${pages > 1 ? `\n\nСтраница ${page + 1}/${pages}` : ""}`
    : "У вас пока нет подписок.";

  const rows = slice.map((d) => [button(`❌ Отписаться от ${d}`, "unsub", d)]);
  const nav = [];
  if (page > 0) nav.push(button("◀️", "mypage", page - 1));
  if (pages > 1) nav.push(button(`Страница ${page + 1}/${pages}`, "mypage", page));
  if (page < pages - 1) nav.push(button("▶️", "mypage", page + 1));
  if (nav.length) rows.push(nav);
  rows.push([button("Добавить округа", "subs")]);
  rows.push([button("В приветствие", "home")]);
  return { text, attachments: keyboard(rows) };
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

// Отправить сообщение (текст + опц. клавиатура + опц. format) в личку/чат.
async function sendMessage(target, text, attachments, format) {
  const body = { text };
  if (format) body.format = format;
  if (attachments?.length) body.attachments = attachments;
  const { data } = await axios.post(`${apiBase()}/messages`, body, {
    headers: { Authorization: token(), "Content-Type": "application/json" },
    params: target,
    timeout: 20000,
  });
  return data;
}

// Ответить на кнопку: с text/attachments заменяет сообщение, иначе — тост notification.
// userId — для history в Strapi (нет — не пишем).
async function answerCallback(callbackId, { text, attachments, notification } = {}, userId) {
  if (!callbackId) return;
  const body = {};
  if (notification) body.notification = notification;
  if (text || attachments?.length) {
    body.message = {};
    if (text) body.message.text = text;
    if (attachments?.length) body.message.attachments = attachments;
  }
  const resp = await axios.post(`${apiBase()}/answers`, body, {
    headers: { Authorization: token(), "Content-Type": "application/json" },
    params: { callback_id: callbackId },
    timeout: 20000,
  });
  if (userId) {
    const mid = resp?.data?.message?.body?.mid || null;
    appendHistory(userId, {
      dir: "out",
      kind: "answer",
      text: text || notification || null,
      notification: notification || null,
      mid,
    }).catch(() => {});
  }
}

// Приветствие с кнопками «Добавить округа» и «Мои подписки».
async function sendGreeting(update) {
  const target = replyTarget(update);
  if (!target) return log("приветствие: нет target", update?.update_type || "");
  const resp = await sendMessage(target, GREETING, GREETING_KEYBOARD);
  log("приветствие отправлено", target);
  rememberChat(update);
  const userId = cbUserId(update);
  if (userId) {
    const mid = resp?.message?.body?.mid || null;
    appendHistory(userId, { dir: "out", kind: "greeting", text: GREETING, mid }).catch(() => {});
  }
}

// Данные пользователя и клика по округу для лога (база будущих подписок в Strapi).
function pickLog(update, district) {
  const cb = update?.callback || {};
  const user = cb.sender || cb.user || update?.user || update?.sender || null;
  const msg = cb.message || update?.message || null;
  return {
    district,
    user_id: cbUserId(update),
    username: user?.username || null,
    name: [user?.first_name, user?.last_name].filter(Boolean).join(" ") || null,
    chat_id: msg?.recipient?.chat_id || update?.chat_id || null,
    mid: msg?.body?.mid || msg?.mid || null,
    callback_id: cb.callback_id || cb.id || null,
    at: new Date().toISOString(),
    user, // всё, что MAX дал о пользователе (полный объект)
  };
}

// Пишет выбор в Strapi (connect к tn_okrugas), чистит выбор, открывает «Мои подписки».
async function confirmSubscription(update, userId, callbackId) {
  const st = userState(userId);
  if (!st.sel.size) {
    await answerCallback(callbackId, { notification: "Выберите хотя бы один округ" }, userId);
    return;
  }
  const all = await fetchDistricts();
  const ids = [...st.sel]
    .flatMap((name) => all.find((d) => d.name === name)?.ids || [])
    .filter((id) => Number.isFinite(Number(id)));
  const profile = cbProfile(update);
  await subscribe({ ...profile, districtIds: ids });
  log("подписка сохранена", { ...profile, districts: [...st.sel] });
  rememberChat(update);
  st.sel.clear();
  const msg = await mySubsMessage(userId, 0);
  await answerCallback(callbackId, { ...msg, notification: "Подписка оформлена" }, userId);
}

// Отписка от одного округа (для группы — disconnect всех её id) + перерисовка «Мои подписки».
async function unsubscribeDistrict(update, userId, callbackId, districtName) {
  const all = await fetchDistricts();
  const ids = (all.find((d) => d.name === districtName)?.ids || []).filter((id) =>
    Number.isFinite(Number(id))
  );
  if (!ids.length) {
    await answerCallback(callbackId, { notification: "Округ не найден" }, userId);
    return;
  }
  const profile = cbProfile(update);
  await unsubscribe({ ...profile, districtIds: ids });
  log("отписка сохранена", { ...profile, district: districtName });
  const msg = await mySubsMessage(userId);
  await answerCallback(callbackId, { ...msg, notification: `Отписка от «${districtName}»` }, userId);
}

// Кнопки меню: листание, выбор ✓, подтверждение, мой список, отписка.
async function handleCallback(update) {
  const callbackId = String(update?.callback?.callback_id || update?.callback?.id || "").trim();
  if (!callbackId) return;
  const { action, value } = decode(update?.callback?.payload || update?.callback?.data || "");
  const userId = cbUserId(update);
  try {
    if (action === "subs" || action === "page") {
      const page = action === "page" ? Number(value) : 0;
      await answerCallback(callbackId, await buildDistrictsMessage(page, userId), userId);
    } else if (action === "pick") {
      const subscribed = await getDistricts(userId);
      const row = (await fetchDistricts()).find((d) => d.name === value);
      const fullySubscribed = row
        ? isRowSubscribed(row, subscribed)
        : subscribed.includes(value);
      if (fullySubscribed) {
        await answerCallback(callbackId, { notification: "Вы уже подписаны" }, userId);
      } else {
        const st = userState(userId);
        if (st.sel.has(value)) st.sel.delete(value);
        else st.sel.add(value);
        log("выбор округа", pickLog(update, value));
        await answerCallback(callbackId, await buildDistrictsMessage(st.page, userId), userId);
      }
    } else if (action === "confirm") {
      await confirmSubscription(update, userId, callbackId);
    } else if (action === "clear") {
      const st = userState(userId);
      st.sel.clear();
      await answerCallback(callbackId, await buildDistrictsMessage(st.page, userId), userId);
    } else if (action === "my") {
      await answerCallback(callbackId, await mySubsMessage(userId, 0), userId);
    } else if (action === "mypage") {
      await answerCallback(callbackId, await mySubsMessage(userId, Number(value)), userId);
    } else if (action === "home") {
      await answerCallback(callbackId, { text: GREETING, attachments: GREETING_KEYBOARD }, userId);
    } else if (action === "unsub") {
      await unsubscribeDistrict(update, userId, callbackId, value);
    } else {
      await answerCallback(callbackId, { notification: "Неизвестная команда" }, userId);
    }
  } catch (e) {
    log("ошибка callback", e?.response?.data || e?.message || e);
    await answerCallback(callbackId, { notification: "Ошибка, попробуйте позже" }, userId).catch(() => {});
  }
}

// Диспетчер update: старт/«начать» → приветствие, очистка истории → автоприветствие,
// callback → меню, прочие тексты → лог.
async function processUpdate(update) {
  const type = String(update?.update_type || "").toLowerCase();
  if (type === "bot_started") return sendGreeting(update);
  // Стерли переписку — сами шлём приветствие с кнопками, чтобы не заставлять
  // пользователя вручную вводить «Начать» (update dialog_cleared, документация MAX).
  if (type === "dialog_cleared") {
    log(`диалог очищен → автоприветствие, user=${cbUserId(update) || "?"}`);
    return sendGreeting(update);
  }
  if (type === "message_created") {
    const text = String(update?.message?.body?.text || "").trim().toLowerCase();
    const raw = String(update?.message?.body?.text || "");
    if (raw.trim()) {
      log(`сообщение от ${cbUserId(update) || "?"}:`, raw);
      const inUserId = cbUserId(update);
      if (inUserId) {
        appendHistory(inUserId, { dir: "in", text: raw }).catch(() => {});
      }
    }
    if (["начать", "/start", "старт"].includes(text)) return sendGreeting(update);
    return;
  }
  if (type === "message_callback") await handleCallback(update);
}

// Один long-poll запрос /updates (marker — позиция в потоке).
async function fetchUpdates({ timeout = 25, limit = 100 } = {}) {
  const params = { timeout, limit, types: "message_created,bot_started,message_callback,dialog_cleared" };
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

// Точка входа из app.js: включается при заданном токене И флаге локального запуска.
async function startPressBotPolling() {
  if (String(process.env.PRESS_MAX_BOT_ENABLED_LOCAL).toLowerCase() !== "true") {
    return log("отключен (PRESS_MAX_BOT_ENABLED_LOCAL != true)");
  }
  if (!token()) return log("отключен (нет TN_MAX_BOT_PRESS)");
  if (polling) return;
  polling = true;
  log("polling запущен");
  await bootstrapMarker();
  pollLoop();
}

module.exports = {
  startPressBotPolling,
  fetchDistricts,
  buildDistrictsMessage,
  processUpdate,
  sendMessage,
};
