// Транспорт VK: публикация/удаление записей на стене сообщества press
// (аналог tnMaxChannel для MAX). Гейт включения — VK_PRESS_ENABLED_LOCAL (как PRESS_MAX_BOT_ENABLED_LOCAL).
const axios = require("axios");

const VK_API_BASE = "https://api.vk.com/method";
const VK_API_VERSION = "5.199";
// Лимит текста записи на стене ~20000 символов — режем с запасом.
const VK_TEXT_LIMIT = 19000;
const VK_SEND_PAUSE_MS = 600;
// Имя файла для preview-роута (аналог FILE_RE в routers/vkPreview.js).
const VK_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

function getVkConfig() {
  return {
    token: String(process.env.VK_PRESS_BOT_TOKEN || "").trim(),
    userToken: String(process.env.VK_PRESS_USER_TOKEN || "").trim(),
    groupId: String(process.env.VK_PRESS_GROUP_ID || "").trim(),
  };
}

function isVkPressEnabled() {
  return String(process.env.VK_PRESS_ENABLED_LOCAL || "").toLowerCase() === "true";
}

// База для og:image-страниц (публичный адрес back_tech через nginx).
function getPreviewBase() {
  return String(process.env.VK_PREVIEW_BASE || "https://jtv.mosoblenergo.ru").replace(
    /\/$/,
    ""
  );
}

async function vkApi(method, params, token = getVkConfig().token) {
  if (!token) throw new Error("Не задан VK_PRESS_BOT_TOKEN");

  const body = new URLSearchParams({ ...params, access_token: token, v: VK_API_VERSION });
  const { data } = await axios.post(`${VK_API_BASE}/${method}`, body, { timeout: 30000 });

  if (data?.error) {
    const err = new Error(data.error.error_msg || `Ошибка VK ${method}`);
    err.vk = data.error;
    throw err;
  }
  return data?.response;
}

// HTML press-шаблонов → плоский текст стены VK (VK через API — plain text).
function htmlToVkText(html) {
  let text = String(html || "");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<\/(p|div|h[1-6]|li|tr|blockquote)>/gi, "\n");
  text = text.replace(/<[^>]+>/g, "");
  text = text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

// Текст длиннее лимита стены → чанки по переводам строк.
function splitVkText(text) {
  const chunks = [];
  let rest = String(text || "");
  while (rest.length > VK_TEXT_LIMIT) {
    let cut = rest.lastIndexOf("\n", VK_TEXT_LIMIT);
    if (cut < VK_TEXT_LIMIT / 2) cut = VK_TEXT_LIMIT;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  if (rest) chunks.push(rest);
  return chunks;
}

async function postToWall(message) {
  const { groupId } = getVkConfig();
  if (!groupId) throw new Error("Не задан VK_PRESS_GROUP_ID");

  const text = String(message || "").trim();
  if (!text) throw new Error("Пустой текст поста");

  const postId = await vkApi("wall.post", {
    owner_id: `-${groupId}`,
    message: text,
  }).then((r) => r?.post_id);

  return {
    ok: true,
    post_id: postId,
    url: postId ? `https://vk.com/wall-${groupId}_${postId}` : null,
  };
}

// Зеркало press-поста: HTML → текст; картинка — ссылкой на og:image-страницу
// (нативная photo-загрузка сообществу API VK не даёт — только ссылочный путь).
async function mirrorToWall({ html, image } = {}) {
  const { groupId, token } = getVkConfig();
  if (!groupId) throw new Error("Не задан VK_PRESS_GROUP_ID");
  if (!token) throw new Error("Не задан VK_PRESS_BOT_TOKEN");

  const text = htmlToVkText(html);
  if (!text) throw new Error("Пустой текст поста");

  const publicFile = String(image?.publicFile || image?.filename || "");
  let attachment = "";
  if (publicFile && VK_FILE_RE.test(publicFile)) {
    const titleLine =
      (text.split("\n").find((line) => line.trim()) || "Мособлэнерго")
        .trim()
        .slice(0, 120);
    attachment =
      `${getPreviewBase()}/services/vk/preview` +
      `?img=${encodeURIComponent(publicFile)}&title=${encodeURIComponent(titleLine)}`;
  }

  const chunks = splitVkText(text);
  const postIds = [];
  for (let i = 0; i < chunks.length; i += 1) {
    const params = {
      owner_id: `-${groupId}`,
      message: chunks[i],
    };
    if (attachment) params.from_group = 1;
    if (i === 0 && attachment) params.attachments = attachment;
    const resp = await vkApi("wall.post", params, token);
    if (!resp?.post_id) throw new Error("VK wall.post: нет post_id в ответе");
    postIds.push(resp.post_id);
    if (i < chunks.length - 1) {
      await new Promise((r) => setTimeout(r, VK_SEND_PAUSE_MS));
    }
  }

  const postId = postIds[0];
  return {
    ok: Boolean(postId),
    post_id: postId,
    post_ids: postIds,
    url: postId ? `https://vk.com/wall-${groupId}_${postId}` : null,
  };
}

async function deleteWallPost(postId) {
  const id = Number(postId);
  if (!id) return { ok: false, reason: "нет post_id" };

  const { groupId, userToken } = getVkConfig();
  if (userToken && !groupId) throw new Error("Не задан VK_PRESS_GROUP_ID");
  const params = { post_id: id };
  if (userToken) params.owner_id = `-${groupId}`;
  const resp = await vkApi("wall.delete", params, userToken || undefined);
  return { ok: resp === 1 || resp === true };
}

module.exports = {
  postToWall,
  mirrorToWall,
  deleteWallPost,
  htmlToVkText,
  isVkPressEnabled,
};
