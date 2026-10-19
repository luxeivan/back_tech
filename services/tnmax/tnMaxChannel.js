// Минимальный клиент MAX: канал ОО (таргет oo) + тестовая группа И (таргет i).
const axios = require("axios");
const FormData = require("form-data");

// platform-api2.max.ru требует сертификат Минцифры в trust store — локально его нет,
// поэтому по умолчанию старый домен (как у pes/max). Переопределение: TN_MAX_API_BASE.
function apiBase() {
  return String(process.env.TN_MAX_API_BASE || "https://platform-api.max.ru").replace(/\/$/, "");
}

// chat_id группы: MAX_GROUP_I может быть числом или ссылкой https://web.max.ru/-801… (число в конце = chat_id).
function parseChatId(raw) {
  const s = String(raw || "").trim();
  if (!s) return 0;
  if (/^-?\d+$/.test(s)) return Number(s);
  const m = s.match(/(-?\d+)\/?$/);
  return m ? Number(m[1]) : 0;
}

const TARGETS = {
  oo: { envToken: "TN_MAX_BOT_OO", envChat: "MAX_CHAT_ID_OO" },
  i: { envToken: "TN_MAX_BOT_I", envChat: "MAX_GROUP_I" },
};

function getConfig(target = "oo") {
  const t = TARGETS[target] || TARGETS.oo;
  const token = String(process.env[t.envToken] || "").trim();
  const chatId = parseChatId(process.env[t.envChat]);
  return { token, chatId, target: TARGETS[target] ? target : "oo", envToken: t.envToken, envChat: t.envChat };
}

async function sendToChannel({
  text,
  format,
  attachments,
  notify,
  disable_link_preview,
  link,
  target,
} = {}) {
  const { token, chatId, envToken, envChat } = getConfig(target);

  if (!token) throw new Error(`Не задан ${envToken}`);
  if (!chatId) throw new Error(`Не задан chat_id (${envChat})`);

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

async function deleteMessage(mid, target) {
  const { token, envToken } = getConfig(target);

  if (!token) throw new Error(`Не задан ${envToken}`);
  if (!mid) throw new Error("mid обязателен");

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
async function deleteStoredMids(stored, target) {
  const mids = parseMids(stored);
  const deleted = [];
  const failed = [];
  for (let i = 0; i < mids.length; i += 1) {
    if (i > 0) await new Promise((r) => setTimeout(r, 600));
    try {
      await deleteMessage(mids[i], target);
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
  sendToChannel,
  deleteMessage,
  parseMids,
  deleteStoredMids,
  uploadImage,
  uploadFile,
};
