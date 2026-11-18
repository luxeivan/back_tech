// Smoke: гвард «закрыли и забыли» — второй пост-закрытие в MAX не уходит.
// Кейсы: №170 (15.11) — флап МОДУСа запитана→открыта→запитана давал 3 поста;
// повторный PUT со статусом «закрыта»; удалена→запитана; обычное первое закрытие.
// Запуск: node services/tnmax/_smoke.closeguard.test.js
const assert = require("assert");
const fs = require("fs");
const { evaluate, has, mark, STORE_PATH } = require("./closeGuard");

function ev(over) {
  return evaluate({
    statusChanged: false,
    prevStatus: "",
    nextStatus: "",
    nextBaseType: 0,
    wasActive: true,
    finalSeen: false,
    ...over,
  });
}

// ── Матрица решений ──
const freshClose = ev({
  statusChanged: true,
  prevStatus: "открыта",
  nextStatus: "закрыта",
});
assert.strictEqual(freshClose.send, true, "первое закрытие: пост должен уходить");

const freshPower = ev({
  statusChanged: true,
  prevStatus: "открыта",
  nextStatus: "запитана",
});
assert.strictEqual(freshPower.send, true, "первая запитка: пост должен уходить");

// Повторный PUT: статус «закрыта» и до этого (гвард 20.10 + финальный статус уже был)
const repeat = ev({
  statusChanged: false,
  prevStatus: "закрыта",
  nextStatus: "закрыта",
  finalSeen: true,
});
assert.strictEqual(repeat.send, false, "повторный PUT со статусом «закрыта»: без поста");
assert.strictEqual(repeat.reason, null, "повторный PUT — тихо, не наш момент");

// Флап №170: закрытие уже было, МОДУС переоткрыл и «закрыл» снова
const flap = ev({
  statusChanged: true,
  prevStatus: "открыта",
  nextStatus: "запитана",
  wasActive: true,
  finalSeen: true,
});
assert.strictEqual(flap.send, false, "флап после закрытия: без второго поста");
assert.ok(flap.reason, "флап: причина пропуска должна быть в логе");

// isActive=false (закрыта/запитана/удалена до этого PUT)
const inactive = ev({
  statusChanged: true,
  prevStatus: "удалена",
  nextStatus: "запитана",
  wasActive: false,
});
assert.strictEqual(inactive.send, false, "isActive=false: без поста");
assert.ok(inactive.reason, "isActive=false: причина пропуска должна быть в логе");

// Запитана→закрыта после отправленного закрытия (гвард 20.10)
const powerToClose = ev({
  statusChanged: true,
  prevStatus: "запитана",
  nextStatus: "закрыта",
});
assert.strictEqual(powerToClose.send, false, "запитана→закрыта: без второго поста");

// Плановая ТН (BASE_TYPE=1) — постов-закрытия в ОО/И нет по определению
const planned = ev({
  statusChanged: true,
  prevStatus: "открыта",
  nextStatus: "закрыта",
  nextBaseType: 1,
});
assert.strictEqual(planned.send, false, "плановая: без поста");

// Нефинальный статус / правка без смены статуса — тихо
assert.strictEqual(ev({ statusChanged: true, prevStatus: "закрыта", nextStatus: "открыта" }).send, false);
assert.strictEqual(ev({ statusChanged: false, prevStatus: "открыта", nextStatus: "открыта" }).send, false);

// ── Стор: mark/has, идемпотентность, регистронезависимость ──
const original = fs.existsSync(STORE_PATH) ? fs.readFileSync(STORE_PATH, "utf8") : null;
const testGuid = "SMOKE-CLOSE-GUARD-0000";
try {
  assert.strictEqual(has(testGuid), false, "до mark: guid не должен быть в сторе");
  mark(testGuid);
  mark(testGuid); // идемпотентно
  assert.strictEqual(has(testGuid.toLowerCase()), true, "после mark: has должен найти (регистр не важен)");
  const map = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
  assert.strictEqual(Object.keys(map).length >= 1, true);
  assert.ok(map[testGuid], "guid в сторе — в верхнем регистре");
} finally {
  // Возвращаем файл как был, чтобы не засорять рабочий стор
  if (original === null) {
    try { fs.unlinkSync(STORE_PATH); } catch {}
  } else {
    fs.writeFileSync(STORE_PATH, original);
  }
}

console.log("closeGuard: ALL OK");
