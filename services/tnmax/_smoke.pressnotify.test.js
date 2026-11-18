// Smoke: notifyDistrict при гигантском ADDRESS_LIST (кейс 18.11 — 85 адресов,
// 12145 симв. → MAX отвергал proto.payload) дробит текст через splitPressText
// и шлёт чанками ≤4000. Моки pressBot/pressSubsStore/strapi — сеть не трогаем.
// Запуск: node services/tnmax/_smoke.pressnotify.test.js
const assert = require("assert");
const path = require("path");

function mockModule(request, exportsObj) {
  const p = require.resolve(request);
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exportsObj };
}

const sentMsgs = [];
mockModule(path.join(__dirname, "pressBot.js"), {
  sendMessage: async (target, text) => {
    sentMsgs.push({ target, text });
    return { message: { body: { mid: `mid.P${sentMsgs.length}` } } };
  },
});

mockModule(path.join(__dirname, "pressSubsStore.js"), {
  getAllSubscribers: async () => [
    { isActive: true, maxUserId: 185204534, districts: ["Коломна г.о."] },
    // неактивный и «чужой» округ — не должны получить ничего
    { isActive: false, maxUserId: 111, districts: ["Коломна г.о."] },
    { isActive: true, maxUserId: 222, districts: ["Истра"] },
  ],
  appendHistory: async () => {},
});

mockModule(path.join(__dirname, "../modus/strapi.js"), {
  getJwt: async () => null,
  fetchTnDescriptionById: async () => undefined,
});

const { notifyDistrict } = require("./pressNotifier");

// Монстр как из теста юзера: 85 адресов одной строкой через «; »
function mkMonsterRaw() {
  const addresses = Array.from(
    { length: 85 },
    (_, i) =>
      `г. Коломна, тестовый микрорайон Энергетический-${String(Math.floor(i / 10) + 1).padStart(2, "0")}, квартал № ${String((i % 10) + 1).padStart(2, "0")}, ул. Энергетиков, дом ${i + 1}, корпус 2, строение 2, подъезд 2, участок ТЕСТ-${String(i + 1).padStart(4, "0")}`
  ).join("; ");
  return {
    DISTRICT: "Коломна г.о.",
    createDateTime: "2026-11-18T12:10:00.000+03:00",
    addressList: addresses,
    data: {},
  };
}

(async () => {
  const raw = mkMonsterRaw();
  console.log(`ADDRESS_LIST длина: ${raw.addressList.length}`);

  const res = await notifyDistrict(raw.DISTRICT, "emergency", raw);
  console.log(
    `sent=${res.sent} total=${res.total} msgs=${sentMsgs.length} mids=${res.mids?.length}`
  );
  sentMsgs.forEach((m, i) =>
    console.log(`  chunk[${i + 1}] len=${m.text.length} user=${m.target.user_id}`)
  );

  assert.strictEqual(res.sent, 1, "только активный подписчик округа");
  assert.strictEqual(res.total, 1, "матчинг округа: ровно 1 подписчик");
  assert.ok(sentMsgs.length > 1, "длинный текст должен разойтись чанками");
  sentMsgs.forEach((m, i) => {
    assert.ok(
      m.text.length <= 4000,
      `чанк ${i + 1}: ${m.text.length} > 4000 — MAX отверг бы`
    );
    assert.strictEqual(m.target.user_id, 185204534, "ушло только Маргарите");
  });

  const joined = sentMsgs.map((m) => m.text).join("\n");
  assert.ok(joined.includes("внеплановое отключение"), "шапка на месте");
  assert.ok(joined.includes("ТЕСТ-0085"), "последний адрес доехал");
  assert.strictEqual(
    res.mids.length,
    sentMsgs.length,
    "mid собран со каждого чанка (для гашения)"
  );

  // Короткий текст — одним сообщением, без сплита
  sentMsgs.length = 0;
  const shortRaw = {
    ...raw,
    addressList: "г. Коломна, ул. Тестовая, д. 1",
  };
  const res2 = await notifyDistrict("Коломна г.о.", "emergency", shortRaw);
  assert.strictEqual(res2.sent, 1);
  assert.strictEqual(sentMsgs.length, 1, "короткий текст — одно сообщение");

  console.log("pressnotify: ALL OK");
  process.exit(0);
})().catch((e) => {
  console.error("FAIL:", e.message);
  process.exit(1);
});
