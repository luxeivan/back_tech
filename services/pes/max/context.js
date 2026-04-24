// Разбор update из MAX: текст сообщения, sender, reply target и callback payload.
const { norm } = require("./utils");

function getMessageNode(update) {
  return update?.message || update?.callback?.message || null;
}

function getSenderNode(update) {
  const message = getMessageNode(update);
  return (
    message?.sender ||
    update?.callback?.sender ||
    update?.callback?.user ||
    null
  );
}

function getMessageText(update) {
  return norm(update?.message?.body?.text || "");
}

function getSenderName(update) {
  const sender = getSenderNode(update);
  const firstName = norm(sender?.first_name);
  const lastName = norm(sender?.last_name);
  return norm([firstName, lastName].filter(Boolean).join(" ")) || "коллега";
}

function getSenderUserId(update) {
  const sender = getSenderNode(update);
  const userId = Number(
    sender?.user_id ||
      update?.callback?.user_id ||
      update?.callback?.user?.user_id
  );
  return Number.isFinite(userId) ? userId : null;
}

function getReplyTarget(update) {
  const message = getMessageNode(update);

  const chatId = Number(message?.recipient?.chat_id);
  if (Number.isFinite(chatId) && chatId > 0) {
    return { chat_id: chatId };
  }

  const userId = getSenderUserId(update);
  if (Number.isFinite(userId) && userId > 0) {
    return { user_id: userId };
  }

  const dialogUserId = Number(message?.recipient?.chat?.dialog_with_user?.user_id);
  if (Number.isFinite(dialogUserId) && dialogUserId > 0) {
    return { user_id: dialogUserId };
  }

  return null;
}

function getCallbackId(update) {
  return norm(
    update?.callback?.callback_id ||
      update?.callback?.id ||
      update?.callback_id
  );
}

function getCallbackPayload(update) {
  return norm(
    update?.callback?.payload ||
      update?.callback?.data ||
      update?.callback?.value
  );
}

function encodeAction(action, value = "") {
  const payload = Buffer.from(String(value || ""), "utf8").toString("base64url");
  return `${action}|${payload}`;
}

function decodeAction(raw) {
  const source = norm(raw);
  const idx = source.indexOf("|");
  if (idx < 0) return { action: source, value: "" };
  const action = source.slice(0, idx);
  const encoded = source.slice(idx + 1);
  try {
    return {
      action,
      value: Buffer.from(encoded, "base64url").toString("utf8"),
    };
  } catch {
    return { action, value: "" };
  }
}

function button(text, action, value = "") {
  return {
    type: "callback",
    text,
    payload: encodeAction(action, value),
  };
}

function keyboard(rows) {
  return [
    {
      type: "inline_keyboard",
      payload: {
        buttons: rows,
      },
    },
  ];
}

module.exports = {
  getMessageNode,
  getSenderNode,
  getMessageText,
  getSenderName,
  getSenderUserId,
  getReplyTarget,
  getCallbackId,
  getCallbackPayload,
  decodeAction,
  button,
  keyboard,
};
