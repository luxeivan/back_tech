const axios = require("axios");

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

function buildText({ action, items, destination, comment }) {
  const list = items.map((i) => `№${i.number} (${i.powerKw} кВт)`).join(", ");
  const addr = destination?.address || "—";
  const coords =
    destination && Number.isFinite(destination.lat) && Number.isFinite(destination.lon)
      ? `${destination.lat}, ${destination.lon}`
      : "—";
  const phone = items[0]?.dispatcherPhone || "—";
  const po = items[0]?.po || "—";

  if (action === "dispatch") {
    const lines = [
      "В связи с технологическим нарушением",
      `необходимо направить ПЭС ${list}`,
      `по адресу ${addr}`,
      `координаты ${coords}`,
      `Контактный телефон диспетчера ${phone} ПО - ${po}`,
      "Время выезда - не более 15 минут после получения настоящего указания",
      "По факту выезда ПЭС укажите в чате фактическое время выезда ПЭС.",
    ];
    if (comment) lines.push(`Комментарий: ${comment}`);
    return lines.join("\n");
  }

  if (action === "cancel") {
    const lines = [
      "В связи с восстановлением электроснабжения",
      "выезд ОТМЕНЕН",
      `ПЭС ${list}`,
      "на место постоянной дислокации",
      "По факту прибытия ПЭС укажите в чате фактическое время прибытия.",
    ];
    if (comment) lines.push(`Комментарий: ${comment}`);
    return lines.join("\n");
  }

  if (action === "reroute") {
    const lines = [
      "В связи с уточнением места технологическим нарушением точка назначения ИЗМЕНЕНА",
      `необходимо направить ПЭС ${list}`,
      `по новому адресу ${addr}`,
      `координаты ${coords}`,
      `Контактный телефон диспетчера ${phone} ПО - ${po}`,
      "Время корректировки маршрута - не более 15 минут после получения настоящего указания",
    ];
    if (comment) lines.push(`Комментарий: ${comment}`);
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
  const payload = { chat_id: chatId, text };
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

module.exports = { sendPesTelegram };
