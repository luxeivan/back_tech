// Рассылка операций ПЭС подписчикам MAX.
const { canRunMaxBot } = require("./config");
const { button, keyboard } = require("./context");
const { sendMessage } = require("./transport");
const { listUsers } = require("./subscriptions");
const { branchNorm, norm, parsePoScopeName, poNorm } = require("./utils");

function formatPowerKw(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  return Number.isInteger(n) ? String(n) : String(n).replace(".", ",");
}

function formatPesList(items) {
  return (Array.isArray(items) ? items : [])
    .map((item) => `№${norm(item?.number)} мощностью ${formatPowerKw(item?.powerKw)} кВт`)
    .filter((line) => !line.startsWith("№ мощностью"))
    .join(", ");
}

function normalizeTel(phone) {
  const digits = String(phone || "").replace(/\D+/g, "");
  if (!digits) return "";
  if (digits.length === 11 && digits.startsWith("8")) return `+7${digits.slice(1)}`;
  if (digits.length === 11 && digits.startsWith("7")) return `+${digits}`;
  if (digits.length === 10) return `+7${digits}`;
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
  if (!lat || !lon) return "-";
  return `${lat}, ${lon}`;
}

function buildYandexMapsUrl(destination) {
  const lat = formatCoord6(destination?.lat);
  const lon = formatCoord6(destination?.lon);
  if (!lat || !lon) return "";
  return `https://yandex.ru/maps/?pt=${lon},${lat}&z=17&l=map`;
}

function buildActionTitle(action) {
  if (action === "dispatch") return "Команда на выезд";
  if (action === "reroute") return "Корректировка маршрута";
  if (action === "cancel") return "Отмена выезда";
  if (action === "depart") return "Фактический выезд";
  if (action === "connect") return "Подключена (в работе)";
  if (action === "ready") return "Готова к выезду (в резерве)";
  if (action === "repair") return "Перевод в ремонт";
  return "Операция по ПЭС";
}

function buildNotificationText({ action, branch, items, destination, comment }) {
  const list = formatPesList(items) || "№... мощностью ... кВт";
  const addr = norm(destination?.address) || "-";
  const coords = formatCoords(destination);
  const mapUrl = buildYandexMapsUrl(destination);
  const targetPhone = normalizeTel(destination?.dispatcherPhone || items?.[0]?.dispatcherPhone);
  const targetPo = norm(destination?.po || items?.[0]?.po) || "-";
  const safeComment = norm(comment);

  if (action === "dispatch") {
    const lines = [
      "В связи с технологическим нарушением",
      `необходимо направить ПЭС ${list}`,
      `по адресу ${addr}`,
      `координаты ${coords}`,
      `Контактный телефон диспетчера ${targetPhone || "-"} ПО - ${targetPo}`,
      "Время выезда - не более 15 минут после получения настоящего указания",
      "По факту выезда ПЭС укажите фактическое время выезда ПЭС.",
    ];
    if (mapUrl) lines.push(`Карта: ${mapUrl}`);
    if (safeComment) lines.push(`Комментарий: ${safeComment}`);
    return lines.join("\n");
  }

  if (action === "cancel") {
    const lines = [
      "В связи с восстановлением электроснабжения",
      "выезд ОТМЕНЕН",
      `необходимо направить ПЭС ${list}`,
      "на место постоянной дислокации",
      "По факту прибытия ПЭС укажите фактическое время прибытия.",
    ];
    if (safeComment) lines.push(`Комментарий: ${safeComment}`);
    return lines.join("\n");
  }

  if (action === "reroute") {
    const lines = [
      "В связи с уточнением места технологического нарушения точка назначения ИЗМЕНЕНА",
      `необходимо направить ПЭС ${list}`,
      `по новому адресу ${addr}`,
      `координаты ${coords}`,
      `Контактный телефон диспетчера ${targetPhone || "-"} ПО - ${targetPo}`,
      "Время корректировки маршрута - не более 15 минут после получения настоящего указания",
    ];
    if (mapUrl) lines.push(`Карта: ${mapUrl}`);
    if (safeComment) lines.push(`Комментарий: ${safeComment}`);
    return lines.join("\n");
  }

  const now = new Date().toLocaleString("ru-RU");
  const lines = [
    `ПЭС: ${buildActionTitle(action)}`,
    `Филиал: ${branch || "-"}`,
    `ПЭС: ${list || "-"}`,
  ];
  if (addr && addr !== "-") lines.push(`Точка: ${addr}`);
  if (coords !== "-") lines.push(`Координаты: ${coords}`);
  if (safeComment) lines.push(`Комментарий: ${safeComment}`);
  lines.push(`Время: ${now}`);
  return lines.join("\n");
}

function buildPesInlineKeyboard(action, pesId) {
  if (!pesId) return [];

  if (action === "dispatch") {
    return keyboard([[button("Фактический выезд", "pes", `depart|${pesId}`)]]);
  }

  if (action === "depart") {
    return keyboard([[button("Подключена (в работе)", "pes", `connect|${pesId}`)]]);
  }

  if (action === "connect" || action === "repair") {
    return keyboard([[button("Вернуть в резерв", "pes", `ready|${pesId}`)]]);
  }

  return [];
}

function isUserSubscribedToTarget(user, branch, po) {
  if (!user || user.is_active === false || user.muted) return false;
  if (user.subscribe_all) return true;

  const list = Array.isArray(user?.branches) ? user.branches : [];
  if (!list.length) return false;

  const branchTarget = branchNorm(branch);
  const byBranch = list.some(
    (item) => !parsePoScopeName(item) && branchNorm(item) === branchTarget
  );
  if (byBranch) return true;

  const poTarget = poNorm(po);
  if (!poTarget) return false;

  return list.some((item) => {
    const parsed = parsePoScopeName(item);
    if (!parsed) return false;
    return branchNorm(parsed.branch) === branchTarget && poNorm(parsed.po) === poTarget;
  });
}

async function sendPesMaxSubscribersNotification({
  action,
  branch,
  items,
  destination,
  comment,
}) {
  if (!canRunMaxBot()) return { ok: false, skipped: true, reason: "max-bot-disabled" };

  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!list.length) return { ok: true, skipped: true, reason: "empty-items", sent: 0 };

  let users = [];
  try {
    users = await listUsers();
  } catch (e) {
    return {
      ok: false,
      skipped: true,
      reason:
        e?.response?.data?.error?.message ||
        e?.response?.data?.message ||
        e?.message ||
        "max-subscribers-read-error",
    };
  }
  if (!users.length) {
    return { ok: true, skipped: true, reason: "no-subscribers", sent: 0 };
  }

  let sent = 0;
  let failed = 0;
  let total = 0;

  for (const user of users) {
    for (const item of list) {
      const eventBranch = norm(item?.branch) || norm(branch);
      if (!isUserSubscribedToTarget(user, eventBranch, item?.po)) continue;

      total += 1;
      const chatId = Number(user.max_chat_id || 0);
      if (!Number.isFinite(chatId) || chatId <= 0) {
        failed += 1;
        console.error(
          `[pes-max-bot] Не найден max_chat_id для user_id=${user.max_user_id}. Пользователю нужно написать боту "Старт" после добавления поля max_chat_id.`
        );
        continue;
      }

      try {
        await sendMessage(
          { chat_id: chatId },
          buildNotificationText({
            action,
            branch: eventBranch,
            items: [item],
            destination,
            comment,
          }),
          buildPesInlineKeyboard(action, item.id)
        );
        sent += 1;
      } catch (e) {
        failed += 1;
        console.error(
          `[pes-max-bot] Ошибка отправки chat_id=${chatId}, user_id=${user.max_user_id}:`,
          e?.response?.data || e?.message || e
        );
      }
    }
  }

  if (!total) return { ok: true, skipped: true, reason: "no-matching-subscribers", sent: 0 };
  return { ok: failed === 0, sent, failed, total };
}

module.exports = {
  sendPesMaxSubscribersNotification,
  buildNotificationText,
};
