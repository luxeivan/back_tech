// «Закрыли и забыли» (заказчик, 18.11.2026): после первого финального статуса ТН
// (закрыта/запитана/удалена) повторных постов-закрытия в MAX быть не должно —
// ни при правках ТН после закрытия, ни при флапах МОДУСа (запитана→открыта→запитана),
// ни при восстановлениях (удалена→запитана). isActive alone не покрывает флапы:
// при переоткрытии МОДУС снова ставит isActive=true.
//
// Поэтому ведём локальную память о guid'ах, у которых финальный статус уже был.
// Файл лежит в data/ (bind-mount ./data в docker-compose) — переживает рестарты.
const fs = require("fs");
const path = require("path");

const STORE_PATH = path.resolve(__dirname, "../../data/tnMaxClosed.json");

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function key(guid) {
  return String(guid || "").trim().toUpperCase();
}

// Был ли у ТН уже финальный статус (пост-закрытия уже отправлялся / запрещён).
function has(guid) {
  const k = key(guid);
  if (!k) return false;
  return Object.prototype.hasOwnProperty.call(load(), k);
}

// Зафиксировать факт финального статуса. Идемпотентно.
function mark(guid) {
  const k = key(guid);
  if (!k) return;
  const map = load();
  if (Object.prototype.hasOwnProperty.call(map, k)) return;
  map[k] = new Date().toISOString();
  try {
    fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
    fs.writeFileSync(STORE_PATH, JSON.stringify(map, null, 2));
  } catch (e) {
    // Не роняем приём ТН из-за диска; худший случай — повторный пост при флапе.
    console.warn("[tnmax] не удалось сохранить tnMaxClosed.json:", e?.message);
  }
}

// Решение о посте-закрытии в Этапе 8.5.
// Статусы приходят уже нормализованные (trim+lowercase), nextBaseType — number|null.
// send=false, reason=null — «не наш момент» (тихо, как раньше);
// send=false, reason=string — был повод для поста, но запрет (логируем skip).
function evaluate({ statusChanged, prevStatus, nextStatus, nextBaseType, wasActive, finalSeen }) {
  const wantsClose =
    !!statusChanged &&
    ["закрыта", "запитана"].includes(nextStatus) &&
    // Закрытие — только если ТН до этого была открыта (гвард от 20.10.2026):
    // запитана→закрыта после уже отправленного закрытия не шлём.
    !["закрыта", "запитана"].includes(prevStatus) &&
    nextBaseType === 0;
  if (!wantsClose) return { send: false, reason: null };
  if (finalSeen) {
    return { send: false, reason: "закрыли и забыли: финальный статус уже приходил — повторный пост не отправляем" };
  }
  if (!wasActive) {
    return { send: false, reason: "закрыли и забыли: isActive=false — ТН уже закрыта/запитана/удалена" };
  }
  return { send: true, reason: null };
}

module.exports = { has, mark, evaluate, STORE_PATH };
