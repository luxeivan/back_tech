// Минимальный клиент MAX для тестового канала ОО.
const axios = require("axios");

// platform-api2.max.ru требует сертификат Минцифры в trust store — локально его нет,
// поэтому по умолчанию старый домен (как у pes/max). Переопределение: TN_MAX_API_BASE.
function apiBase() {
  return String(process.env.TN_MAX_API_BASE || "https://platform-api.max.ru").replace(/\/$/, "");
}

function getConfig() {
  const token = String(process.env.TN_MAX_BOT_OO || "").trim();
  const channelLink = String(process.env.MAX_CHANEL_OO || "").trim();
  const chatId = Number(String(process.env.MAX_CHAT_ID_OO || "").trim()) || 0;
  return { token, channelLink, chatId };
}

async function sendToChannel({
  text,
  format,
  attachments,
  notify,
  disable_link_preview,
} = {}) {
  const { token, chatId } = getConfig();

  if (!token) throw new Error("Не задан TN_MAX_BOT_OO");
  if (!chatId) {
    throw new Error("Не задан MAX_CHAT_ID_OO (chat_id берётся из события bot_added, не из ссылки)");
  }

  const body = { text };
  if (format) body.format = format;
  if (Array.isArray(attachments) && attachments.length) body.attachments = attachments;
  if (typeof notify === "boolean") body.notify = notify;

  const params = { chat_id: chatId };
  if (typeof disable_link_preview === "boolean") {
    params.disable_link_preview = disable_link_preview;
  }

  const { data } = await axios.post(`${apiBase()}/messages`, body, {
    headers: {
      Authorization: token,
      "Content-Type": "application/json",
    },
    params,
    timeout: 20000,
  });

  return data;
}

module.exports = {
  apiBase,
  getConfig,
  sendToChannel,
};
