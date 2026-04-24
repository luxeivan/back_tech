// Обработчики update MAX-бота: старт, меню, филиалы, ПО и подписки.
const axios = require("axios");
const { getBranchesList, findBranchByText } = require("./catalog");
const {
  getMessageText,
  getReplyTarget,
  getSenderNode,
  getSenderUserId,
  getCallbackId,
  getCallbackPayload,
  decodeAction,
} = require("./context");
const {
  upsertUserState,
  setUserSubscribeAll,
  clearUserScopes,
  toggleScope,
  formatUserSubs,
} = require("./subscriptions");
const { maxLog } = require("./config");
const { sendMessage, answerCallback } = require("./transport");
const {
  buildMainMenuText,
  buildMainMenuAttachments,
  buildBranchesMenuAttachments,
  buildPoMenuAttachments,
  buildPoMenuText,
  resolveScopeBranch,
} = require("./ui");
const { norm } = require("./utils");

function getLocalBackendBase() {
  const port = Number(process.env.PORT) || 5000;
  return `http://127.0.0.1:${port}`;
}

function buildAuditUsernameFromUpdate(update) {
  const sender = getSenderNode(update) || {};
  const username = norm(sender.username);
  const firstName = norm(sender.first_name);
  const lastName = norm(sender.last_name);
  const fullName = norm([firstName, lastName].filter(Boolean).join(" "));
  const userId = getSenderUserId(update);
  return norm(
    [
      "MAX",
      username ? `@${username}` : "",
      fullName || "",
      userId ? `id:${userId}` : "",
    ]
      .filter(Boolean)
      .join(" ")
  ) || "MAX unknown";
}

async function runPesModuleCommand({ action, pesId, update }) {
  const userId = getSenderUserId(update);
  const payload = {
    action,
    pesIds: [pesId],
    source: "max",
    sourceChatId: Number(userId) || null,
  };
  if (action === "depart") payload.actualDepartureAt = new Date().toISOString();

  const { data } = await axios.post(
    `${getLocalBackendBase()}/services/pes/module/command`,
    payload,
    {
      headers: {
        "x-view-role": "standart",
        "x-audit-role": "system",
        "x-audit-username": encodeURIComponent(buildAuditUsernameFromUpdate(update)),
      },
      timeout: 20000,
    }
  );
  return data;
}

async function sendMainMenu(update, { callbackId = "" } = {}) {
  const text = buildMainMenuText(update);
  const attachments = buildMainMenuAttachments();

  if (callbackId) {
    await answerCallback(callbackId, {
      text,
      attachments,
      notification: "Главное меню",
    });
    return;
  }

  const target = getReplyTarget(update);
  if (!target) {
    maxLog("не найден target для стартового меню", {
      update_type: update?.update_type,
    });
    return;
  }

  await sendMessage(target, text, attachments);
}

async function sendBranchesMenu(update, { callbackId = "" } = {}) {
  const text = "Выбери филиал для просмотра ПО и подписок.";
  const attachments = await buildBranchesMenuAttachments();

  if (callbackId) {
    await answerCallback(callbackId, {
      text,
      attachments,
      notification: "Список филиалов",
    });
    return;
  }

  const target = getReplyTarget(update);
  await sendMessage(target, text, attachments);
}

async function sendMySubscriptions(update, user, { callbackId = "" } = {}) {
  const text = formatUserSubs(user);
  const attachments = buildMainMenuAttachments();

  if (callbackId) {
    await answerCallback(callbackId, {
      text,
      attachments,
      notification: "Мои подписки",
    });
    return;
  }

  const target = getReplyTarget(update);
  await sendMessage(target, text, attachments);
}

async function sendPoMenu(update, user, branch, { callbackId = "" } = {}) {
  const text = buildPoMenuText(branch);
  const attachments = await buildPoMenuAttachments(user, branch);

  if (callbackId) {
    await answerCallback(callbackId, {
      text,
      attachments,
      notification: "Список ПО",
    });
    return;
  }

  const target = getReplyTarget(update);
  await sendMessage(target, text, attachments);
}

async function handleMessage(update) {
  const rawText = getMessageText(update);
  const text = rawText.toLowerCase();
  const user = await upsertUserState(update);

  if (!rawText) return;

  if (text === "/start" || text === "старт") {
    await sendMainMenu(update);
    return;
  }

  if (text === "филиалы") {
    await sendBranchesMenu(update);
    return;
  }

  if (text === "мои подписки") {
    await sendMySubscriptions(update, user);
    return;
  }

  if (text === "подписаться на все") {
    const saved = await setUserSubscribeAll(user);
    await sendMySubscriptions(update, saved);
    return;
  }

  if (text === "очистить") {
    const saved = await clearUserScopes(user);
    await sendMySubscriptions(update, saved);
  }
}

async function handleCallback(update) {
  const callbackId = getCallbackId(update);
  const payload = decodeAction(getCallbackPayload(update));
  const user = await upsertUserState(update);

  if (!callbackId) {
    maxLog("callback без callback_id", {
      update_type: update?.update_type,
      callback: update?.callback || null,
    });
    return;
  }

  if (payload.action === "menu") {
    await sendMainMenu(update, { callbackId });
    return;
  }

  if (payload.action === "list") {
    await sendBranchesMenu(update, { callbackId });
    return;
  }

  if (payload.action === "my") {
    await sendMySubscriptions(update, user, { callbackId });
    return;
  }

  if (payload.action === "pes") {
    const [cmd, pesId] = norm(payload.value).split("|").map(norm);
    const allowed = new Set(["depart", "connect", "ready"]);
    if (!cmd || !pesId) {
      await answerCallback(callbackId, {
        notification: "Некорректная команда",
      });
      return;
    }
    if (!allowed.has(cmd)) {
      await answerCallback(callbackId, {
        notification: "Недоступно",
      });
      return;
    }

    try {
      await runPesModuleCommand({
        action: cmd,
        pesId,
        update,
      });
      await answerCallback(callbackId, {
        notification: "Готово",
      });
    } catch (e) {
      await answerCallback(callbackId, {
        notification: norm(e?.response?.data?.message || e?.message || "Ошибка").slice(0, 180),
      });
    }
    return;
  }

  if (payload.action === "suball") {
    const saved = await setUserSubscribeAll(user);
    await answerCallback(callbackId, {
      text: formatUserSubs(saved),
      attachments: buildMainMenuAttachments(),
      notification: "Подписка на все филиалы",
    });
    return;
  }

  if (payload.action === "clear") {
    const saved = await clearUserScopes(user);
    await answerCallback(callbackId, {
      text: formatUserSubs(saved),
      attachments: buildMainMenuAttachments(),
      notification: "Подписки очищены",
    });
    return;
  }

  if (payload.action === "open") {
    const branches = await getBranchesList();
    const branch = findBranchByText(payload.value, branches);
    if (!branch) {
      await answerCallback(callbackId, {
        notification: "Филиал не найден",
      });
      return;
    }
    await sendPoMenu(update, user, branch, { callbackId });
    return;
  }

  if (payload.action === "toggle") {
    const scopeName = norm(payload.value);
    if (!scopeName) {
      await answerCallback(callbackId, {
        notification: "Подписка не найдена",
      });
      return;
    }

    const saved = await toggleScope(user, scopeName);
    await sendPoMenu(update, saved, resolveScopeBranch(scopeName), {
      callbackId,
    });
    return;
  }

  await answerCallback(callbackId, {
    notification: "Команда пока не поддерживается",
  });
}

async function processUpdate(update) {
  const updateType = norm(update?.update_type).toLowerCase();

  if (updateType === "bot_started") {
    await upsertUserState(update);
    await sendMainMenu(update);
    return;
  }

  if (updateType === "message_created") {
    await handleMessage(update);
    return;
  }

  if (updateType === "message_callback") {
    await handleCallback(update);
  }
}

module.exports = {
  processUpdate,
};
