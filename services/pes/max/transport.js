// HTTP-обертки над MAX API: сообщения, callback-ответы, webhook subscriptions.
const axios = require("axios");
const {
  MAX_API_BASE,
  MAX_BOT_TOKEN,
  MAX_WEBHOOK_SECRET,
  MAX_WEBHOOK_UPDATE_TYPES,
  MAX_WEBHOOK_URL,
  buildHeaders,
} = require("./config");

async function sendMessage(target, text, attachments = []) {
  if (!target) return { ok: false, skipped: true, reason: "no-target" };

  const body = { text };
  if (attachments.length) {
    body.attachments = attachments;
  }

  const { data } = await axios.post(`${MAX_API_BASE}/messages`, body, {
    headers: buildHeaders(),
    params: target,
    timeout: 20000,
  });

  return { ok: true, response: data };
}

async function answerCallback(
  callbackId,
  { text, attachments = [], notification } = {}
) {
  if (!callbackId) return;

  const body = {};
  if (notification) {
    body.notification = notification;
  }
  if (text || attachments.length) {
    body.message = {};
    if (text) body.message.text = text;
    if (attachments.length) body.message.attachments = attachments;
  }

  await axios.post(`${MAX_API_BASE}/answers`, body, {
    headers: buildHeaders(),
    params: {
      callback_id: callbackId,
    },
    timeout: 20000,
  });
}

async function fetchUpdates({ marker, timeout = 25, limit = 100 } = {}) {
  const params = {
    timeout,
    limit,
    types: "message_created,bot_started,message_callback",
  };

  if (Number.isFinite(Number(marker))) {
    params.marker = Number(marker);
  }

  const { data } = await axios.get(`${MAX_API_BASE}/updates`, {
    headers: {
      Authorization: MAX_BOT_TOKEN,
    },
    params,
    timeout: (timeout + 10) * 1000,
  });

  return {
    updates: Array.isArray(data?.updates) ? data.updates : [],
    marker: Number.isFinite(Number(data?.marker)) ? Number(data.marker) : null,
  };
}

async function listWebhookSubscriptions() {
  const { data } = await axios.get(`${MAX_API_BASE}/subscriptions`, {
    headers: {
      Authorization: MAX_BOT_TOKEN,
    },
    timeout: 20000,
  });

  return data;
}

async function createWebhookSubscription({
  url = MAX_WEBHOOK_URL,
  secret = MAX_WEBHOOK_SECRET,
  updateTypes = MAX_WEBHOOK_UPDATE_TYPES,
} = {}) {
  const body = {
    url,
    update_types: updateTypes,
  };
  if (secret) body.secret = secret;

  const { data } = await axios.post(`${MAX_API_BASE}/subscriptions`, body, {
    headers: buildHeaders(),
    timeout: 20000,
  });

  return data;
}

async function deleteWebhookSubscription({ url = MAX_WEBHOOK_URL } = {}) {
  const { data } = await axios.delete(`${MAX_API_BASE}/subscriptions`, {
    headers: {
      Authorization: MAX_BOT_TOKEN,
    },
    params: { url },
    timeout: 20000,
  });

  return data;
}

module.exports = {
  sendMessage,
  answerCallback,
  fetchUpdates,
  listWebhookSubscriptions,
  createWebhookSubscription,
  deleteWebhookSubscription,
};
