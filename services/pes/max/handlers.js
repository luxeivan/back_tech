// Обработчики update MAX-бота: старт, меню, филиалы, ПО и подписки.
const { getBranchesList, findBranchByText } = require("./catalog");
const {
  getMessageText,
  getReplyTarget,
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
  const user = upsertUserState(update);

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
    const saved = setUserSubscribeAll(user);
    await sendMySubscriptions(update, saved);
    return;
  }

  if (text === "очистить") {
    const saved = clearUserScopes(user);
    await sendMySubscriptions(update, saved);
  }
}

async function handleCallback(update) {
  const callbackId = getCallbackId(update);
  const payload = decodeAction(getCallbackPayload(update));
  const user = upsertUserState(update);

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

  if (payload.action === "suball") {
    const saved = setUserSubscribeAll(user);
    await answerCallback(callbackId, {
      text: formatUserSubs(saved),
      attachments: buildMainMenuAttachments(),
      notification: "Подписка на все филиалы",
    });
    return;
  }

  if (payload.action === "clear") {
    const saved = clearUserScopes(user);
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

    const saved = toggleScope(user, scopeName);
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
    upsertUserState(update);
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
