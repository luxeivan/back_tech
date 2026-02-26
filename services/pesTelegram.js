const axios = require("axios");

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function parseJsonEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function getConfig() {
  const botToken = process.env.PES_TELEGRAM_BOT_TOKEN || "";
  const strict = String(process.env.PES_TELEGRAM_STRICT || "0") === "1";
  const chatsByBranch = parseJsonEnv("PES_TELEGRAM_CHATS", {});
  const threadsByBranch = parseJsonEnv("PES_TELEGRAM_THREADS", {});
  return { botToken, strict, chatsByBranch, threadsByBranch };
}

function norm(v) {
  return String(v == null ? "" : v).replace(/\s+/g, " ").trim();
}

function formatPowerKw(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return Number.isInteger(n) ? String(n) : String(n).replace(".", ",");
}

function formatPesList(items) {
  return (Array.isArray(items) ? items : [])
    .map((i) => `№${norm(i?.number)} мощностью ${formatPowerKw(i?.powerKw)} кВт`)
    .filter((x) => !x.includes("№ мощностью"))
    .join(", ");
}

function normalizeTelLink(phone) {
  const digits = String(phone || "").replace(/\D+/g, "");
  if (!digits) return "";

  // 8XXXXXXXXXX -> +7XXXXXXXXXX
  if (digits.length === 11 && digits.startsWith("8")) {
    return `+7${digits.slice(1)}`;
  }

  // 7XXXXXXXXXX -> +7XXXXXXXXXX
  if (digits.length === 11 && digits.startsWith("7")) {
    return `+${digits}`;
  }

  // XXXXXXXXXX -> +7XXXXXXXXXX
  if (digits.length === 10) {
    return `+7${digits}`;
  }

  return "";
}

function formatCoord6(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "";
  return n.toFixed(6);
}

function formatCoords(destination) {
  const lat = formatCoord6(destination?.lat);
  const lon = formatCoord6(destination?.lon);
  if (!lat || !lon) return "—";
  return `${lat}, ${lon}`;
}

function buildYandexMapsUrl(destination) {
  const lat = formatCoord6(destination?.lat);
  const lon = formatCoord6(destination?.lon);
  if (!lat || !lon) return "";
  return `https://yandex.ru/maps/?pt=${lon},${lat}&z=17&l=map`;
}

function formatCoordsHtml(destination) {
  const coords = formatCoords(destination);
  const url = buildYandexMapsUrl(destination);
  if (!url || coords === "—") return escapeHtml(coords);
  return `<a href="${escapeHtml(url)}">${escapeHtml(coords)}</a>`;
}

function formatPhoneHtml(phone) {
  const display = escapeHtml(phone || "—");
  const tel = normalizeTelLink(phone);
  if (!tel) return display;
  return `<a href="tel:${escapeHtml(tel)}">${display}</a>`;
}

function buildText({ action, items, destination, comment }) {
  const list = formatPesList(items);
  const addr = escapeHtml(destination?.address || "—");
  const coordsHtml = formatCoordsHtml(destination);
  // Контакты и ПО должны относиться к точке НАЗНАЧЕНИЯ (куда направляется ПЭС),
  // а не к базовому ПО самой ПЭС.
  const targetPhone = destination?.dispatcherPhone || items[0]?.dispatcherPhone || "—";
  const targetPo = destination?.po || items[0]?.po || "—";
  const phoneHtml = formatPhoneHtml(targetPhone);
  const po = escapeHtml(targetPo);
  const safeComment = escapeHtml(comment || "");

  if (action === "dispatch") {
    const lines = [
      "<b>В связи с технологическим нарушением</b>",
      `необходимо направить ПЭС <b>${escapeHtml(list || "№... мощностью ... кВт")}</b>`,
      `по адресу <b>${addr}</b>`,
      `координаты ${coordsHtml}`,
      `Контактный телефон диспетчера ${phoneHtml} ПО - <b>${po}</b>`,
      "Время выезда - не более <b>15 минут</b> после получения настоящего указания",
      "По факту выезда ПЭС укажите в чате фактическое время выезда ПЭС.",
    ];
    if (safeComment) lines.push(`<b>Комментарий:</b> <i>${safeComment}</i>`);
    return lines.join("\n");
  }

  if (action === "cancel") {
    const lines = [
      "<b>В связи с восстановлением электроснабжения</b>",
      "<b>выезд ОТМЕНЕН</b>",
      `необходимо направить ПЭС <b>${escapeHtml(list || "№... мощностью ... кВт")}</b>`,
      "на место постоянной дислокации",
      "По факту прибытия ПЭС укажите в чате фактическое время прибытия.",
    ];
    if (safeComment) lines.push(`<b>Комментарий:</b> <i>${safeComment}</i>`);
    return lines.join("\n");
  }

  if (action === "reroute") {
    const lines = [
      "<b>В связи с уточнением места технологическим нарушением точка назначения ИЗМЕНЕНА</b>",
      `необходимо направить ПЭС <b>${escapeHtml(list || "№... мощностью ... кВт")}</b>`,
      `по новому адресу <b>${addr}</b>`,
      `координаты ${coordsHtml}`,
      `Контактный телефон диспетчера ${phoneHtml} ПО - <b>${po}</b>`,
      "Время корректировки маршрута - не более <b>15 минут</b> после получения настоящего указания",
    ];
    if (safeComment) lines.push(`<b>Комментарий:</b> <i>${safeComment}</i>`);
    return lines.join("\n");
  }

  return "";
}

async function sendPesTelegram({ action, branch, items, destination, comment }) {
  const cfg = getConfig();
  const chatId = cfg.chatsByBranch?.[branch];
  const threadId = cfg.threadsByBranch?.[branch];

  if (!cfg.botToken || !chatId) {
    const msg = "Telegram не настроен: нет токена или chat_id филиала";
    if (cfg.strict) {
      const err = new Error(msg);
      err.code = "TELEGRAM_NOT_CONFIGURED";
      throw err;
    }
    return { ok: false, skipped: true, reason: msg };
  }

  const text = buildText({ action, items, destination, comment });
  const payload = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  };
  if (threadId != null && threadId !== "") {
    payload.message_thread_id = threadId;
  }

  const url = `https://api.telegram.org/bot${cfg.botToken}/sendMessage`;
  const { data } = await axios.post(url, payload, { timeout: 15000 });
  return {
    ok: Boolean(data?.ok),
    skipped: false,
    response: data,
  };
}

module.exports = { sendPesTelegram, buildText };
