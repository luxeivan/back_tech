const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { loadPesItems } = require("./pesModuleData");
const {
  PES_ENDPOINTS,
  fetchAll,
  fetchFirst,
  createOne,
  updateOne,
  manyRelation,
} = require("./pesStrapiStore");

const BOT_TOKEN = String(process.env.PES_TELEGRAM_BOT_TOKEN || "").trim();
const BOT_ENABLED = String(process.env.PES_BOT_ENABLED || "1") === "1";
const LEGACY_SUBS_FILE = path.resolve(__dirname, "../data/pesBotSubscriptions.json");
const LEGACY_STATE_FILE = path.resolve(__dirname, "../data/pesBotState.json");
const MIGRATE_JSON_ON_START = String(process.env.PES_BOT_MIGRATE_JSON || "1") === "1";

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

function normalizeSubscriber(row) {
  const branches = manyRelation(row?.branches)
    .map((b) => norm(b.name))
    .filter(Boolean);

  return {
    id: row?.id || null,
    documentId: row?.documentId || null,
    chat_id: Number(row?.chat_id || 0),
    username: norm(row?.username),
    first_name: norm(row?.first_name),
    last_name: norm(row?.last_name),
    muted: Boolean(row?.muted),
    is_active: row?.is_active !== false,
    subscribe_all: Boolean(row?.subscribe_all),
    branches,
  };
}

async function listUsers() {
  const rows = await fetchAll(PES_ENDPOINTS.SUBSCRIBERS, {
    params: {
      "filters[is_active][$eq]": true,
      populate: "branches",
      "sort[0]": "chat_id:asc",
    },
  });
  return rows.map(normalizeSubscriber);
}

async function getUserByChatId(chatId) {
  const id = Number(chatId || 0);
  if (!Number.isFinite(id) || id <= 0) return null;

  const row = await fetchFirst(PES_ENDPOINTS.SUBSCRIBERS, {
    params: {
      "filters[chat_id][$eq]": id,
      populate: "branches",
    },
  });

  return row ? normalizeSubscriber(row) : null;
}

async function ensureBranches(branchNames) {
  const names = Array.from(
    new Set((branchNames || []).map((x) => norm(x)).filter(Boolean))
  );
  if (!names.length) return [];

  const existing = await fetchAll(PES_ENDPOINTS.BRANCHES, {
    params: {
      "pagination[pageSize]": 500,
    },
  });
  const byNorm = new Map(
    existing
      .map((r) => ({ row: r, key: branchNorm(r.name_norm || r.name) }))
      .filter((x) => x.key)
      .map((x) => [x.key, x.row])
  );

  const out = [];
  for (const name of names) {
    const key = branchNorm(name);
    if (!key) continue;

    const found = byNorm.get(key);
    if (found) {
      if (found.is_active === false && found.documentId) {
        const updated = await updateOne(PES_ENDPOINTS.BRANCHES, found.documentId, {
          is_active: true,
        });
        byNorm.set(key, updated);
        out.push(updated);
      } else {
        out.push(found);
      }
      continue;
    }

    const created = await createOne(PES_ENDPOINTS.BRANCHES, {
      name,
      name_norm: key,
      is_active: true,
    });
    byNorm.set(key, created);
    out.push(created);
  }

  return out;
}

async function upsertUser(chat, userMeta = {}) {
  const chatId = Number(chat?.id || 0);
  if (!Number.isFinite(chatId) || chatId <= 0) return null;

  const existingRow = await fetchFirst(PES_ENDPOINTS.SUBSCRIBERS, {
    params: {
      "filters[chat_id][$eq]": chatId,
      populate: "branches",
    },
  });

  const payload = {
    chat_id: chatId,
    username: norm(userMeta.username) || null,
    first_name: norm(userMeta.first_name) || null,
    last_name: norm(userMeta.last_name) || null,
    last_interaction_at: new Date().toISOString(),
    is_active: true,
  };

  let row;
  if (existingRow?.documentId) {
    row = await updateOne(PES_ENDPOINTS.SUBSCRIBERS, existingRow.documentId, payload);
  } else {
    row = await createOne(PES_ENDPOINTS.SUBSCRIBERS, {
      ...payload,
      muted: false,
      subscribe_all: false,
    });
  }

  const fresh = await fetchFirst(PES_ENDPOINTS.SUBSCRIBERS, {
    params: {
      "filters[chat_id][$eq]": chatId,
      populate: "branches",
    },
  });

  return fresh ? normalizeSubscriber(fresh) : normalizeSubscriber(row);
}

async function updateUserBranches(chatId, branches) {
  const id = Number(chatId || 0);
  if (!Number.isFinite(id) || id <= 0) return null;

  const existing = await fetchFirst(PES_ENDPOINTS.SUBSCRIBERS, {
    params: {
      "filters[chat_id][$eq]": id,
      populate: "branches",
    },
  });
  if (!existing?.documentId) return null;

  const clean = Array.from(
    new Set((branches || []).map((x) => norm(x)).filter(Boolean))
  );
  const subscribeAll = clean.includes("*");

  let branchIds = [];
  if (!subscribeAll) {
    const rows = await ensureBranches(clean);
    branchIds = rows.map((x) => Number(x.id)).filter((x) => Number.isFinite(x) && x > 0);
  }

  await updateOne(PES_ENDPOINTS.SUBSCRIBERS, existing.documentId, {
    subscribe_all: subscribeAll,
    branches: branchIds,
    last_interaction_at: new Date().toISOString(),
  });

  const fresh = await fetchFirst(PES_ENDPOINTS.SUBSCRIBERS, {
    params: {
      "filters[chat_id][$eq]": id,
      populate: "branches",
    },
  });
  return fresh ? normalizeSubscriber(fresh) : null;
}

async function getBranchesList() {
  const rows = await fetchAll(PES_ENDPOINTS.BRANCHES, {
    params: {
      "filters[is_active][$eq]": true,
      "sort[0]": "name:asc",
    },
  });

  let branches = rows.map((x) => norm(x.name)).filter(Boolean);
  if (branches.length) {
    return Array.from(new Set(branches)).sort((a, b) => a.localeCompare(b, "ru"));
  }

  const items = await loadPesItems();
  branches = Array.from(new Set(items.map((x) => norm(x.branch)).filter(Boolean))).sort(
    (a, b) => a.localeCompare(b, "ru")
  );
  if (branches.length) {
    await ensureBranches(branches);
  }
  return branches;
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

async function getBotStateRow() {
  const existing = await fetchFirst(PES_ENDPOINTS.BOT_STATES, {
    params: {
      "filters[key][$eq]": "main",
    },
  });
  if (existing) return existing;

  return createOne(PES_ENDPOINTS.BOT_STATES, {
    key: "main",
    polling_offset: 0,
    enabled: true,
  });
}

async function readState() {
  const row = await getBotStateRow();
  return {
    row,
    offset: Number(row?.polling_offset || 0),
    enabled: row?.enabled !== false,
  };
}

async function writeState(offset) {
  const current = await getBotStateRow();
  if (!current?.documentId) return;
  await updateOne(PES_ENDPOINTS.BOT_STATES, current.documentId, {
    polling_offset: Number(offset) || 0,
    last_poll_at: new Date().toISOString(),
  });
}

function readLegacyJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function migrateLegacyJsonIfNeeded() {
  if (!MIGRATE_JSON_ON_START) return;

  const currentUsers = await listUsers();
  const currentState = await readState();
  const legacySubs = readLegacyJsonSafe(LEGACY_SUBS_FILE, { users: {} });
  const legacyState = readLegacyJsonSafe(LEGACY_STATE_FILE, { offset: 0 });

  if (!currentUsers.length && legacySubs?.users && typeof legacySubs.users === "object") {
    const allBranches = await getBranchesList();
    const byText = (value) => findBranchByText(value, allBranches) || norm(value);

    for (const item of Object.values(legacySubs.users)) {
      const chatId = Number(item?.chat_id || 0);
      if (!Number.isFinite(chatId) || chatId <= 0) continue;

      await upsertUser(
        { id: chatId },
        {
          username: item?.username,
          first_name: item?.first_name,
          last_name: item?.last_name,
        }
      );

      const branchList = Array.isArray(item?.branches) ? item.branches : [];
      const mapped = branchList.includes("*")
        ? ["*"]
        : branchList.map(byText).filter(Boolean);

      const user = await updateUserBranches(chatId, mapped);
      if (user?.documentId && item?.muted === true) {
        await updateOne(PES_ENDPOINTS.SUBSCRIBERS, user.documentId, { muted: true });
      }
    }
    console.log("[pes-bot] Миграция подписок из JSON завершена");
  }

  const legacyOffset = Number(legacyState?.offset || 0);
  if (currentState.offset <= 0 && legacyOffset > 0) {
    await writeState(legacyOffset);
    pollingOffset = legacyOffset;
    console.log(`[pes-bot] Перенесен offset из JSON: ${legacyOffset}`);
  }
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
  if (user.subscribe_all) return "Вы подписаны на все филиалы.";
  if (!branches.length) return "У вас пока нет подписок на филиалы.";
  return `Ваши подписки:\n${branches.map((x) => `- ${x}`).join("\n")}`;
}

async function processMessage(msg) {
  const chatId = msg?.chat?.id;
  if (!chatId) return;
  const text = norm(msg?.text || "");
  const lc = text.toLowerCase();
  const userMeta = msg?.from || {};

  await upsertUser(msg.chat, userMeta);

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
    const user = await getUserByChatId(chatId);
    await tgSendMessage(chatId, formatUserSubs(user));
    return;
  }

  if (lc === "/suball") {
    const user = await updateUserBranches(chatId, ["*"]);
    await tgSendMessage(chatId, formatUserSubs(user));
    return;
  }

  if (lc === "/clear") {
    const user = await updateUserBranches(chatId, []);
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
    const user = await getUserByChatId(chatId);
    const current = Array.isArray(user?.branches) ? user.branches : [];
    const next = user?.subscribe_all
      ? [branch]
      : Array.from(new Set([...current, branch]));
    const saved = await updateUserBranches(chatId, next);
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
    const user = await getUserByChatId(chatId);
    const current = Array.isArray(user?.branches) ? user.branches : [];
    const next = current.filter((x) => x !== branch);
    const saved = await updateUserBranches(chatId, next);
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

  await upsertUser({ id: chatId }, userMeta);

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
      await runPesModuleCommand({ action: cmd, pesId, chatId: Number(chatId) });
      await tgAnswerCallback(callbackId, "Готово");
    } catch (e) {
      const msg = norm(e?.response?.data?.message || e?.message || "Ошибка");
      await tgAnswerCallback(callbackId, msg.slice(0, 180));
    }
    return;
  }

  if (action === "my") {
    const user = await getUserByChatId(chatId);
    await tgSendMessage(chatId, formatUserSubs(user));
    await tgAnswerCallback(callbackId, "Готово");
    return;
  }

  if (action === "suball") {
    const user = await updateUserBranches(chatId, ["*"]);
    await tgSendMessage(chatId, formatUserSubs(user));
    await tgAnswerCallback(callbackId, "Подписка на все филиалы");
    return;
  }

  if (action === "clear") {
    const user = await updateUserBranches(chatId, []);
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
    const user = await getUserByChatId(chatId);
    const current = Array.isArray(user?.branches) ? user.branches : [];
    let next = current;
    let msg = "";
    if (current.includes(branch)) {
      next = current.filter((x) => x !== branch);
      msg = `Отписка: ${branch}`;
    } else {
      next = [...current, branch];
      msg = `Подписка: ${branch}`;
    }
    const saved = await updateUserBranches(chatId, next);
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
    if (offsetChanged) await writeState(pollingOffset);
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
      await writeState(pollingOffset);
      console.log(`[pes-bot] offset инициализирован: ${pollingOffset}`);
    }
  } catch (e) {
    console.error("[pes-bot] Не удалось инициализировать offset:", e?.message || e);
  }
}

async function startPesBotPolling() {
  if (!canRunBot()) {
    console.log("[pes-bot] отключен (нет токена или PES_BOT_ENABLED=0)");
    return;
  }
  if (pollingStarted) return;

  try {
    pollingStarted = true;
    await migrateLegacyJsonIfNeeded();

    const state = await readState();
    if (!state.enabled) {
      console.log("[pes-bot] отключен в Strapi (pes-bot-states.enabled=false)");
      pollingStarted = false;
      return;
    }

    pollingOffset = Number(state.offset || 0);
    console.log("[pes-bot] polling запущен");
    await bootstrapOffsetToLatest();
    pollLoop();
  } catch (e) {
    pollingStarted = false;
    console.error("[pes-bot] Ошибка старта:", e?.message || e);
  }
}

function isUserSubscribedToBranch(user, branch) {
  if (!user || user.is_active === false || user.muted) return false;
  if (user.subscribe_all) return true;

  const list = Array.isArray(user?.branches) ? user.branches : [];
  if (!list.length) return false;

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

async function runPesModuleCommand({ action, pesId, chatId }) {
  const base = getLocalBackendBase();
  const payload = { action, pesIds: [pesId], sourceChatId: Number(chatId) || null };
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

  const users = await listUsers();
  const targets = users.filter((u) => isUserSubscribedToBranch(u, branch));
  if (!targets.length) {
    return { ok: true, skipped: true, reason: "no-subscribers", sent: 0 };
  }

  const prepared = list.map((it) => ({
    text: buildBranchNotifyText({ action, branch, items: [it], destination, comment }),
    reply_markup: buildPesInlineKeyboard(action, it.id),
  }));

  let sent = 0;
  let failed = 0;
  for (const user of targets) {
    for (const msg of prepared) {
      try {
        await tgSendMessage(
          user.chat_id,
          msg.text,
          msg.reply_markup ? { reply_markup: msg.reply_markup } : {}
        );
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
