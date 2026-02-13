const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { loadPesItems } = require("./pesModuleData");

const BOT_TOKEN = String(process.env.PES_TELEGRAM_BOT_TOKEN || "").trim();
const BOT_ENABLED = String(process.env.PES_BOT_ENABLED || "1") === "1";
const DATA_FILE =
  process.env.PES_BOT_SUBS_FILE ||
  path.resolve(__dirname, "../data/pesBotSubscriptions.json");
const STATE_FILE =
  process.env.PES_BOT_STATE_FILE ||
  path.resolve(__dirname, "../data/pesBotState.json");

const TG_BASE = BOT_TOKEN ? `https://api.telegram.org/bot${BOT_TOKEN}` : "";

let pollingStarted = false;
let pollingOffset = 0;

function norm(v) {
  return String(v == null ? "" : v).replace(/\s+/g, " ").trim();
}

function branchNorm(v) {
  return norm(v)
    .toLowerCase()
    .replace(/\bфилиал\b/g, "")
    .replace(/[^а-яa-z0-9]/gi, "");
}

function canRunBot() {
  return Boolean(BOT_ENABLED && BOT_TOKEN);
}

function ensureStoreFile() {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(
      DATA_FILE,
      JSON.stringify({ users: {}, updatedAt: new Date().toISOString() }, null, 2),
      "utf8"
    );
  }
}

function ensureStateFile() {
  const dir = path.dirname(STATE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(STATE_FILE)) {
    fs.writeFileSync(
      STATE_FILE,
      JSON.stringify({ offset: 0, updatedAt: new Date().toISOString() }, null, 2),
      "utf8"
    );
  }
}

function readState() {
  ensureStateFile();
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return { offset: Number(parsed?.offset) || 0 };
  } catch {
    return { offset: 0 };
  }
}

function writeState(offset) {
  ensureStateFile();
  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify(
      {
        offset: Number(offset) || 0,
        updatedAt: new Date().toISOString(),
      },
      null,
      2
    ),
    "utf8"
  );
}

function readStore() {
  ensureStoreFile();
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { users: {} };
    if (!parsed.users || typeof parsed.users !== "object") parsed.users = {};
    return parsed;
  } catch {
    return { users: {} };
  }
}

function writeStore(store) {
  ensureStoreFile();
  const next = {
    ...store,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(DATA_FILE, JSON.stringify(next, null, 2), "utf8");
}

function upsertUser(chat, userMeta = {}) {
  const store = readStore();
  const id = String(chat?.id || "");
  if (!id) return null;
  const prev = store.users[id] || {
    chat_id: Number(chat.id),
    username: "",
    first_name: "",
    last_name: "",
    branches: [],
    muted: false,
    created_at: new Date().toISOString(),
  };

  store.users[id] = {
    ...prev,
    chat_id: Number(chat.id),
    username: norm(userMeta.username || prev.username),
    first_name: norm(userMeta.first_name || prev.first_name),
    last_name: norm(userMeta.last_name || prev.last_name),
    updated_at: new Date().toISOString(),
  };
  writeStore(store);
  return store.users[id];
}

function updateUserBranches(chatId, branches) {
  const store = readStore();
  const id = String(chatId);
  const user = store.users[id];
  if (!user) return null;
  user.branches = Array.from(new Set((branches || []).map((x) => norm(x)).filter(Boolean)));
  user.updated_at = new Date().toISOString();
  writeStore(store);
  return user;
}

function getUserByChatId(chatId) {
  const store = readStore();
  return store.users[String(chatId)] || null;
}

function listUsers() {
  const store = readStore();
  return Object.values(store.users || {});
}

async function getBranchesList() {
  const items = await loadPesItems();
  return Array.from(new Set(items.map((x) => norm(x.branch)).filter(Boolean))).sort(
    (a, b) => a.localeCompare(b, "ru")
  );
}

function findBranchByText(text, branches) {
  const txt = norm(text);
  if (!txt) return "";
  const n = branchNorm(txt);
  if (!n) return "";
  const exact = branches.find((b) => branchNorm(b) === n);
  if (exact) return exact;
  const includes = branches.find((b) => branchNorm(b).includes(n) || n.includes(branchNorm(b)));
  return includes || "";
}

async function tgSendMessage(chatId, text, extra = {}) {
  if (!canRunBot()) return { ok: false, skipped: true, reason: "bot-disabled" };
  const payload = {
    chat_id: chatId,
    text,
    ...extra,
  };
  const { data } = await axios.post(`${TG_BASE}/sendMessage`, payload, {
    timeout: 20000,
  });
  return data;
}

async function tgAnswerCallback(callbackQueryId, text = "") {
  if (!canRunBot() || !callbackQueryId) return;
  try {
    await axios.post(
      `${TG_BASE}/answerCallbackQuery`,
      { callback_query_id: callbackQueryId, text: text || undefined },
      { timeout: 15000 }
    );
  } catch (_) {}
}

function splitChunks(lines, maxLen = 3500) {
  const out = [];
  let cur = "";
  for (const line of lines) {
    if (!cur) {
      cur = line;
      continue;
    }
    const next = `${cur}\n${line}`;
    if (next.length > maxLen) {
      out.push(cur);
      cur = line;
    } else {
      cur = next;
    }
  }
  if (cur) out.push(cur);
  return out;
}

async function sendBranchesList(chatId) {
  const branches = await getBranchesList();
  if (!branches.length) {
    await tgSendMessage(chatId, "Список филиалов пока пуст.");
    return;
  }

  const keyboard = [];
  for (const b of branches) {
    keyboard.push([{ text: b, callback_data: `toggle|${b}` }]);
  }
  keyboard.push([
    { text: "Подписаться на все", callback_data: "suball|" },
    { text: "Очистить", callback_data: "clear|" },
  ]);
  keyboard.push([{ text: "Мои подписки", callback_data: "my|" }]);

  await tgSendMessage(chatId, "Выбери филиалы кнопками:", {
    reply_markup: { inline_keyboard: keyboard },
  });
}

function formatUserSubs(user) {
  if (!user) return "Подписки не найдены.";
  const branches = Array.isArray(user.branches) ? user.branches : [];
  if (!branches.length) return "У вас пока нет подписок на филиалы.";
  if (branches.includes("*")) return "Вы подписаны на все филиалы.";
  return `Ваши подписки:\n${branches.map((x) => `- ${x}`).join("\n")}`;
}

async function processMessage(msg) {
  const chatId = msg?.chat?.id;
  if (!chatId) return;
  const text = norm(msg?.text || "");
  const lc = text.toLowerCase();
  const userMeta = msg?.from || {};

  upsertUser(msg.chat, userMeta);

  if (!text) return;

  if (lc === "/start") {
    await tgSendMessage(
      chatId,
      [
        "Бот ПЭС запущен.",
        "Подписки по филиалам включены.",
        "Нажми /list и выбери филиалы кнопками.",
      ].join("\n")
    );
    return;
  }

  if (lc === "/help" || lc === "помощь") {
    await tgSendMessage(
      chatId,
      [
        "/list - список филиалов",
        "/sub <филиал> - подписаться",
        "/unsub <филиал> - отписаться",
        "/suball - подписаться на все филиалы",
        "/clear - очистить подписки",
        "/my - мои подписки",
      ].join("\n")
    );
    return;
  }

  if (lc === "/list") {
    await sendBranchesList(chatId);
    return;
  }

  if (lc === "/my") {
    const user = getUserByChatId(chatId);
    await tgSendMessage(chatId, formatUserSubs(user));
    return;
  }

  if (lc === "/suball") {
    const user = updateUserBranches(chatId, ["*"]);
    await tgSendMessage(chatId, formatUserSubs(user));
    return;
  }

  if (lc === "/clear") {
    const user = updateUserBranches(chatId, []);
    await tgSendMessage(chatId, formatUserSubs(user));
    return;
  }

  if (lc.startsWith("/sub ")) {
    const target = norm(text.slice(5));
    const branches = await getBranchesList();
    const branch = findBranchByText(target, branches);
    if (!branch) {
      await tgSendMessage(chatId, "Филиал не найден. Используй /list");
      return;
    }
    const user = getUserByChatId(chatId);
    const current = Array.isArray(user?.branches) ? user.branches : [];
    const next = current.includes("*")
      ? [branch]
      : Array.from(new Set([...current, branch]));
    const saved = updateUserBranches(chatId, next);
    await tgSendMessage(chatId, `Подписка добавлена: ${branch}\n\n${formatUserSubs(saved)}`);
    return;
  }

  if (lc.startsWith("/unsub ")) {
    const target = norm(text.slice(7));
    const branches = await getBranchesList();
    const branch = findBranchByText(target, branches);
    if (!branch) {
      await tgSendMessage(chatId, "Филиал не найден. Используй /list");
      return;
    }
    const user = getUserByChatId(chatId);
    const current = Array.isArray(user?.branches) ? user.branches : [];
    const next = current.filter((x) => x !== "*" && x !== branch);
    const saved = updateUserBranches(chatId, next);
    await tgSendMessage(chatId, `Подписка удалена: ${branch}\n\n${formatUserSubs(saved)}`);
    return;
  }
}

async function processCallbackQuery(query) {
  const callbackId = query?.id;
  const data = norm(query?.data || "");
  const chatId = query?.message?.chat?.id;
  const userMeta = query?.from || {};
  if (!chatId || !data) {
    await tgAnswerCallback(callbackId);
    return;
  }

  upsertUser({ id: chatId }, userMeta);

  const parts = data.split("|");
  const action = norm(parts[0] || "");
  const payload = norm(parts[1] || "");

  if (action === "pes") {
    const cmd = norm(parts[1] || "");
    const pesId = norm(parts[2] || "");
    const allowed = new Set(["cancel", "depart", "connect", "ready", "repair"]);
    if (!cmd || !pesId) {
      await tgAnswerCallback(callbackId, "Некорректная команда");
      return;
    }
    if (!allowed.has(cmd)) {
      await tgAnswerCallback(callbackId, "Недоступно");
      return;
    }
    try {
      await runPesModuleCommand({ action: cmd, pesId });
      await tgAnswerCallback(callbackId, "Готово");
    } catch (e) {
      const msg = norm(e?.response?.data?.message || e?.message || "Ошибка");
      await tgAnswerCallback(callbackId, msg.slice(0, 180));
    }
    return;
  }

  if (action === "my") {
    const user = getUserByChatId(chatId);
    await tgSendMessage(chatId, formatUserSubs(user));
    await tgAnswerCallback(callbackId, "Готово");
    return;
  }

  if (action === "suball") {
    const user = updateUserBranches(chatId, ["*"]);
    await tgSendMessage(chatId, formatUserSubs(user));
    await tgAnswerCallback(callbackId, "Подписка на все филиалы");
    return;
  }

  if (action === "clear") {
    const user = updateUserBranches(chatId, []);
    await tgSendMessage(chatId, formatUserSubs(user));
    await tgAnswerCallback(callbackId, "Подписки очищены");
    return;
  }

  if (action === "toggle") {
    const branches = await getBranchesList();
    const branch = findBranchByText(payload, branches);
    if (!branch) {
      await tgAnswerCallback(callbackId, "Филиал не найден");
      return;
    }
    const user = getUserByChatId(chatId);
    const current = Array.isArray(user?.branches) ? user.branches.filter((x) => x !== "*") : [];
    let next = current;
    let msg = "";
    if (current.includes(branch)) {
      next = current.filter((x) => x !== branch);
      msg = `Отписка: ${branch}`;
    } else {
      next = [...current, branch];
      msg = `Подписка: ${branch}`;
    }
    const saved = updateUserBranches(chatId, next);
    await tgSendMessage(chatId, `${msg}\n\n${formatUserSubs(saved)}`);
    await tgAnswerCallback(callbackId, "Готово");
    return;
  }

  await tgAnswerCallback(callbackId);
}

async function pollLoop() {
  if (!canRunBot()) return;
  try {
    const { data } = await axios.get(`${TG_BASE}/getUpdates`, {
      params: {
        offset: pollingOffset || undefined,
        timeout: 25,
        allowed_updates: JSON.stringify(["message", "callback_query"]),
      },
      timeout: 35000,
    });
    const updates = Array.isArray(data?.result) ? data.result : [];
    let offsetChanged = false;
    for (const upd of updates) {
      const id = Number(upd?.update_id);
      if (Number.isFinite(id)) {
        const next = id + 1;
        if (next > pollingOffset) {
          pollingOffset = next;
          offsetChanged = true;
        }
      }
      if (upd?.message) {
        try {
          await processMessage(upd.message);
        } catch (e) {
          console.error("[pes-bot] Ошибка обработки сообщения:", e?.message || e);
        }
      }
      if (upd?.callback_query) {
        try {
          await processCallbackQuery(upd.callback_query);
        } catch (e) {
          console.error("[pes-bot] Ошибка обработки callback_query:", e?.message || e);
        }
      }
    }
    if (offsetChanged) writeState(pollingOffset);
  } catch (e) {
    console.error("[pes-bot] Ошибка polling:", e?.message || e);
  } finally {
    setTimeout(pollLoop, 1000);
  }
}

async function bootstrapOffsetToLatest() {
  if (!canRunBot()) return;
  if (Number(pollingOffset) > 0) return;
  try {
    const { data } = await axios.get(`${TG_BASE}/getUpdates`, {
      params: { offset: -1, limit: 1, timeout: 0 },
      timeout: 15000,
    });
    const updates = Array.isArray(data?.result) ? data.result : [];
    const lastId = Number(updates[0]?.update_id);
    if (Number.isFinite(lastId)) {
      pollingOffset = lastId + 1;
      writeState(pollingOffset);
      console.log(`[pes-bot] offset инициализирован: ${pollingOffset}`);
    }
  } catch (e) {
    console.error("[pes-bot] Не удалось инициализировать offset:", e?.message || e);
  }
}

function startPesBotPolling() {
  if (!canRunBot()) {
    console.log("[pes-bot] отключен (нет токена или PES_BOT_ENABLED=0)");
    return;
  }
  if (pollingStarted) return;
  pollingStarted = true;
  ensureStoreFile();
  pollingOffset = readState().offset;
  console.log("[pes-bot] polling запущен");
  bootstrapOffsetToLatest().finally(() => pollLoop());
}

function isUserSubscribedToBranch(user, branch) {
  const list = Array.isArray(user?.branches) ? user.branches : [];
  if (!list.length) return false;
  if (list.includes("*")) return true;
  const target = branchNorm(branch);
  return list.some((x) => branchNorm(x) === target);
}

function buildActionTitle(action) {
  if (action === "dispatch") return "Команда на выезд";
  if (action === "reroute") return "Корректировка маршрута";
  if (action === "cancel") return "Отмена выезда";
  if (action === "depart") return "Фактический выезд";
  if (action === "connect") return "Подключена";
  if (action === "ready") return "Возврат в резерв";
  if (action === "repair") return "Перевод в ремонт";
  return "Операция по ПЭС";
}

function buildBranchNotifyText({ action, branch, items, destination, comment }) {
  const list = items
    .map((i) => `№${i.number} (${i.powerKw ?? "—"} кВт)`)
    .join(", ");
  const lines = [
    `ПЭС: ${buildActionTitle(action)}`,
    `Филиал: ${branch || "—"}`,
    `ПЭС: ${list || "—"}`,
  ];
  if (destination?.address) lines.push(`Точка: ${destination.address}`);
  if (
    destination &&
    Number.isFinite(Number(destination.lat)) &&
    Number.isFinite(Number(destination.lon))
  ) {
    lines.push(`Координаты: ${Number(destination.lat)}, ${Number(destination.lon)}`);
  }
  if (comment) lines.push(`Комментарий: ${comment}`);
  lines.push(`Время: ${new Date().toLocaleString("ru-RU")}`);
  return lines.join("\n");
}

function buildPesInlineKeyboard(action, pesId) {
  const mk = (text, a) => ({ text, callback_data: `pes|${a}|${pesId}` });

  if (!pesId) return null;

  if (action === "dispatch") {
    return {
      inline_keyboard: [[mk("Фактический выезд", "depart"), mk("Отмена", "cancel")]],
    };
  }

  if (action === "depart") {
    return {
      inline_keyboard: [[mk("Подключена", "connect"), mk("Отмена", "cancel")]],
    };
  }

  if (action === "connect") {
    return {
      inline_keyboard: [[mk("Вернуть в резерв", "ready"), mk("В ремонт", "repair")]],
    };
  }

  if (action === "repair") {
    return { inline_keyboard: [[mk("Вернуть в резерв", "ready")]] };
  }

  if (action === "ready") {
    return { inline_keyboard: [[mk("В ремонт", "repair")]] };
  }

  if (action === "cancel") {
    return { inline_keyboard: [[mk("В ремонт", "repair")]] };
  }

  return null;
}

function getLocalBackendBase() {
  const port = Number(process.env.PORT) || 5000;
  return `http://127.0.0.1:${port}`;
}

async function runPesModuleCommand({ action, pesId }) {
  const base = getLocalBackendBase();
  const payload = { action, pesIds: [pesId] };
  if (action === "depart") payload.actualDepartureAt = new Date().toISOString();

  const { data } = await axios.post(`${base}/services/pes/module/command`, payload, {
    headers: { "x-view-role": "standart" },
    timeout: 20000,
  });
  return data;
}

async function sendPesSubscribersNotification({
  action,
  branch,
  items,
  destination,
  comment,
}) {
  if (!canRunBot()) return { ok: false, skipped: true, reason: "bot-disabled" };
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!list.length) return { ok: true, skipped: true, reason: "empty-items", sent: 0 };

  const users = listUsers();
  const targets = users.filter((u) => !u.muted && isUserSubscribedToBranch(u, branch));
  if (!targets.length) {
    return { ok: true, skipped: true, reason: "no-subscribers", sent: 0 };
  }
  const prepared = list.map((it) => ({
    text: buildBranchNotifyText({ action, branch, items: [it], destination, comment }),
    reply_markup: buildPesInlineKeyboard(action, it.id),
  }));

  let sent = 0; // кол-во сообщений
  let failed = 0;
  for (const user of targets) {
    for (const msg of prepared) {
      try {
        await tgSendMessage(user.chat_id, msg.text, msg.reply_markup ? { reply_markup: msg.reply_markup } : {});
        sent += 1;
      } catch (e) {
        failed += 1;
        console.error(
          `[pes-bot] Ошибка отправки chat_id=${user.chat_id}:`,
          e?.response?.data?.description || e?.message || e
        );
      }
    }
  }
  return { ok: failed === 0, sent, failed, total: targets.length * prepared.length };
}

module.exports = {
  startPesBotPolling,
  sendPesSubscribersNotification,
};
