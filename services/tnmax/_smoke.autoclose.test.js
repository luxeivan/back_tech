// Smoke: ТН пришла одним POST уже в финальном статусе → первый пост + сразу закрытие.
// Моки axios/tnMaxChannel/pdf — сеть и MAX не трогаем. Запуск: node services/tnmax/_smoke.autoclose.test.js
const assert = require("assert");
const path = require("path");

const sent = [];
let midCounter = 0;

function mockModule(request, exportsObj) {
  const p = require.resolve(request);
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exportsObj };
}

mockModule("axios", {
  get: async () => ({ data: { meta: { pagination: { total: 3 } } } }),
  post: async () => ({ data: {} }),
  put: async () => ({ data: {} }),
  delete: async () => ({ data: {} }),
});

mockModule(path.join(__dirname, "tnMaxChannel.js"), {
  sendToChannel: async (payload) => {
    midCounter += 1;
    const mid = `mid.TEST${midCounter}`;
    sent.push({ ...payload, _mid: mid });
    return { message: { body: { mid }, url: `url-${mid}` } };
  },
  uploadFile: async () => ({ token: "tok" }),
});

mockModule(path.join(__dirname, "pdf/index.js"), {
  generateTablesPdfs: async () => [
    { name: "test.pdf", buffer: Buffer.from("x") },
    { name: "ОО_все филиалы.pdf", buffer: Buffer.from("x") },
  ],
});

const { publishTnPost } = require("./postPublisher");

function mkRaw(over) {
  return {
    BASE_TYPE: 0,
    POPULATION_COUNT: 2187,
    PES_COUNT: 0,
    F81_010_NUMBER: 777,
    F81_060_EVENTDATETIME: "2026-10-20T09:00:00.000+03:00",
    F81_070_RESTOR_SUPPLAYDATETIME: "2026-10-20T09:07:00.000+03:00",
    F81_290_RECOVERYDATETIME: "2026-10-20T09:05:00.000+03:00",
    SC_FILIAL: "Тестовый филиал",
    SC_PO: "Тестовое ПО",
    F81_041_ENERGOOBJECTNAME: "ТП-1",
    PROTECT_TYPE: "МТЗ",
    VOLTAGECLASS: "10кВ",
    SWITCHNAMEKEY: "ТП-1",
    DISTRICT: "Тестово",
    REASON_OPER: "Причина",
    ADDRESS_LIST: "г Тестов, ул Т, д 1; \n\nЦТП:\nЦТП №1. Адрес: г Тестов\n",
    STATUS_NAME: "Открыта",
    ...over,
  };
}

async function runCase(label, status, expectClose) {
  sent.length = 0;
  const result = await publishTnPost({
    jwt: "j",
    guid: "GUID-" + label,
    raw: mkRaw({ STATUS_NAME: status }),
    midDocId: "doc",
    urlStrapi: "http://unused",
  });
  const texts = sent.filter((m) => m.text).map((m) => ({
    target: m.target || "oo",
    head: String(m.text).replace(/\s+/g, " ").slice(0, 90),
    full: String(m.text),
    reply: m.link?.mid || null,
  }));
  const files = sent.filter((m) => m.attachments?.[0]?.type === "file");
  console.log(`\n=== ${label}: STATUS_NAME="${status}" → ok=${result.ok}`);
  console.log("message:", result.message);
  console.log("files:", files.length);
  texts.forEach((t, i) => console.log(`text[${i}] target=${t.target} reply=${t.reply || "-"} len=${t.full.length} | ${t.head}`));
  const closes = texts.filter((t) => t.head.includes("Доп. информация"));
  // Открытие: 2 PDF; закрытие: +2 актуальных PDF (только канал ОО, без target/i)
  const expectFiles = expectClose ? 4 : 2;
  assert.strictEqual(files.length, expectFiles, `должны уйти ${expectFiles} PDF`);
  assert.ok(
    files.every((m) => !m.target || m.target === "oo"),
    "PDF — только канал ОО"
  );
  // Лимит MAX на текст — 4000 символов (реальный кейс №872: 5043 → Этап 8 падал)
  texts.forEach((t) => {
    assert.ok(t.full.length <= 4000, `текстовое сообщение ${t.full.length} > 4000`);
  });
  if (expectClose) {
    assert.strictEqual(closes.length, 2, "закрытие: ОО + группа И");
    assert.ok(closes.every((c) => c.reply), "закрытие должно быть reply на первый пост");
    // Время закрытия — из F81_070 (09:07), НЕ из F81_290 (09:05)
    assert.ok(
      closes.every((c) => c.full.includes("09:07") && !c.full.includes("09:05")),
      "в закрытии должно быть время из F81_070 (09:07)"
    );
  } else {
    assert.strictEqual(closes.length, 0, "закрытия быть не должно");
  }
}

// Длинный текст (адреса Климовска, реальный кейс №872: 5043 > 4000) —
// должен разбиться на чанки в канале ОО и в группе И, каждый ≤4000.
async function runLongTextCase() {
  sent.length = 0;
  const longAddresses = Array.from(
    { length: 80 },
    (_, i) => `ЦТП №${i}. Адрес: г. Климовск, ул. Большая, д. ${i} стр. ${i}`
  ).join("\n");
  const raw = mkRaw({
    STATUS_NAME: "Открыта",
    ADDRESS_LIST: `ЦТП:\n${longAddresses}\n`,
    POPULATION_COUNT: 6000,
    PES_COUNT: 6,
  });
  const result = await publishTnPost({
    jwt: "j",
    guid: "GUID-long",
    raw,
    midDocId: "doc",
    urlStrapi: "http://unused",
  });
  const texts = sent.filter((m) => m.text).map((m) => ({
    target: m.target || "oo",
    full: String(m.text),
    reply: m.link?.mid || null,
  }));
  const files = sent.filter((m) => m.attachments?.[0]?.type === "file");
  const ooTexts = texts.filter((t) => t.target === "oo" && !t.reply);
  const iTexts = texts.filter((t) => t.target === "i" && !t.reply);

  console.log(`\n=== длинный текст → ok=${result.ok}`);
  console.log("message:", result.message);
  console.log(`ОО-чанков=${ooTexts.length} И-чанков=${iTexts.length} PDF=${files.length}`);
  ooTexts.forEach((t, i) => console.log(`oo[${i}] len=${t.full.length}`));
  iTexts.forEach((t, i) => console.log(`i[${i}] len=${t.full.length}`));

  assert.ok(result.ok, `publishTnPost должен быть ok: ${result.message}`);
  assert.ok(ooTexts.length > 1, `канал ОО: ожидалось >1 чанка, получено ${ooTexts.length}`);
  assert.ok(iTexts.length > 1, `группа И: ожидалось >1 чанка, получено ${iTexts.length}`);
  texts.forEach((t) => {
    assert.ok(t.full.length <= 4000, `чанк ${t.full.length} > 4000`);
  });
  assert.strictEqual(files.length, 2, "PDF по-прежнему 2, сплит их не ломает");
  assert.ok(
    result.message.includes("mid сохранён"),
    `mid должен сохраняться: ${result.message}`
  );
  // reply закрытия не в этом кейсе (ТН открыта), но сохранённый mid группы И — список
  assert.ok(
    result.message.includes("группа И mid=") && result.message.includes(","),
    `mid группы И должен быть списком через запятую: ${result.message}`
  );
}

(async () => {
  await runCase("открыта", "Открыта", false);
  await runCase("запитана", "запитана", true);
  await runCase("закрыта", "ЗАКРЫТА", true);
  await runLongTextCase();
  console.log("\nALL OK");
  process.exit(0);
})().catch((e) => {
  console.error("\nFAIL:", e.message);
  process.exit(1);
});
