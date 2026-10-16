// Минимальный клиент MAX для тестового канала ОО.
const axios = require("axios");
const FormData = require("form-data");
const fs = require("fs");

// platform-api2.max.ru требует сертификат Минцифры в trust store — локально его нет,
// поэтому по умолчанию старый домен (как у pes/max). Переопределение: TN_MAX_API_BASE.
function apiBase() {
  return String(process.env.TN_MAX_API_BASE || "https://platform-api.max.ru").replace(/\/$/, "");
}

// Лог перед каждым вызовом MAX API: какой домен и есть ли файл сертов Минцифры.
// Доказательство в консоли: домен platform-api2 + `✓ OK 200` = серты работают
// (без них соединение с api2 падает с UNABLE_TO_GET_ISSUER_CERT_LOCALLY).
function logTarget(method, path) {
  const ca = String(process.env.NODE_EXTRA_CA_CERTS || "").trim();
  const caStatus = !ca
    ? "NODE_EXTRA_CA_CERTS не задан"
    : fs.existsSync(ca)
      ? `есть (${ca})`
      : `НЕ НАЙДЕН (${ca})`;
  console.log(`[tnmax] → ${method} ${apiBase()}${path} | серты Минцифры: ${caStatus}`);
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
  link,
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
  // Ответ/пересылка на исходное сообщение: {type: "reply"|"forward", mid}
  if (link && link.mid) {
    body.link = {
      type: link.type === "forward" ? "forward" : "reply",
      mid: String(link.mid),
    };
  }

  const params = { chat_id: chatId };
  if (typeof disable_link_preview === "boolean") {
    params.disable_link_preview = disable_link_preview;
  }

  logTarget("POST", "/messages");
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

async function deleteMessage(mid) {
  const { token } = getConfig();

  if (!token) throw new Error("Не задан TN_MAX_BOT_OO");
  if (!mid) throw new Error("mid обязателен");

  logTarget("DELETE", "/messages");
  const { data } = await axios.delete(`${apiBase()}/messages`, {
    headers: {
      Authorization: token,
      "Content-Type": "application/json",
    },
    params: { message_id: mid },
    timeout: 20000,
  });

  return data;
}

// mid-поле хранит один или несколько mid через запятую (текст + 2 PDF = 3 сообщения).
function parseMids(stored) {
  return String(stored || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Удаление всех mid из поля с паузой 600 мс (лимит MAX: 2 удаления/сек в чат).
async function deleteStoredMids(stored) {
  const mids = parseMids(stored);
  const deleted = [];
  const failed = [];
  for (let i = 0; i < mids.length; i += 1) {
    if (i > 0) await new Promise((r) => setTimeout(r, 600));
    try {
      await deleteMessage(mids[i]);
      deleted.push(mids[i]);
    } catch (e) {
      failed.push({ mid: mids[i], error: e?.response?.data?.message || e?.message });
    }
  }
  return { mids, deleted, failed };
}

// Загрузка изображения в MAX: POST /uploads?type=image → multipart → mediafile token.
async function uploadImage(buffer, filename = "image.png") {
  const { token } = getConfig();
  if (!token) throw new Error("Не задан TN_MAX_BOT_OO");

  logTarget("POST", "/uploads?type=image");
  const { data: up } = await axios.post(`${apiBase()}/uploads?type=image`, null, {
    headers: { Authorization: token, Accept: "application/json" },
    timeout: 15000,
  });

  const form = new FormData();
  form.append("data", buffer, { filename, contentType: "image/png" });

  const { data } = await axios.post(up.url, form, {
    headers: { Authorization: token, ...form.getHeaders() },
    timeout: 60000,
    maxBodyLength: 60 * 1024 * 1024,
  });

  // Реальный ответ MAX: {"photos":{"0":{"token":"..."}}} (docs: photos.photoIds.token — устарел)
  const firstPhoto = data?.photos ? Object.values(data.photos)[0] : null;
  const mediaToken = firstPhoto?.token || data?.photos?.photoIds?.token || data?.token;
  if (!mediaToken) {
    throw new Error(`MAX upload не вернул токен: ${JSON.stringify(data)}`);
  }
  console.log(
    `[tnmax] image uploaded: ${filename}, ${buffer.length} байт, token=${String(mediaToken).slice(0, 16)}…`
  );
  return mediaToken;
}

// Загрузка файла в MAX: POST /uploads?type=file → multipart → {fileId, token}.
async function uploadFile(buffer, filename = "file.pdf") {
  const { token } = getConfig();
  if (!token) throw new Error("Не задан TN_MAX_BOT_OO");

  logTarget("POST", "/uploads?type=file");
  const { data: up } = await axios.post(`${apiBase()}/uploads?type=file`, null, {
    headers: { Authorization: token, Accept: "application/json" },
    timeout: 15000,
  });

  const form = new FormData();
  form.append("data", buffer, { filename, contentType: "application/pdf" });

  const { data } = await axios.post(up.url, form, {
    headers: { Authorization: token, ...form.getHeaders() },
    timeout: 120000,
    maxBodyLength: 100 * 1024 * 1024,
  });

  const fileToken = data?.token;
  if (!fileToken) {
    throw new Error(`MAX upload file не вернул токен: ${JSON.stringify(data)}`);
  }
  console.log(
    `[tnmax] file uploaded: ${filename}, ${buffer.length} байт, fileId=${data?.fileId || "-"}, token=${String(fileToken).slice(0, 16)}…`
  );
  return fileToken;
}

module.exports = {
  apiBase,
  getConfig,
  logTarget,
  sendToChannel,
  deleteMessage,
  parseMids,
  deleteStoredMids,
  uploadImage,
  uploadFile,
};
