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
    reply: m.link?.mid || null,
  }));
  const files = sent.filter((m) => m.attachments?.[0]?.type === "file").length;
  console.log(`\n=== ${label}: STATUS_NAME="${status}" → ok=${result.ok}`);
  console.log("message:", result.message);
  console.log("files:", files);
  texts.forEach((t, i) => console.log(`text[${i}] target=${t.target} reply=${t.reply || "-"} | ${t.head}`));
  const closes = texts.filter((t) => t.head.includes("Доп. информация"));
  assert.strictEqual(files, 2, "должны уйти 2 PDF");
  if (expectClose) {
    assert.strictEqual(closes.length, 2, "закрытие: ОО + группа И");
    assert.ok(closes.every((c) => c.reply), "закрытие должно быть reply на первый пост");
  } else {
    assert.strictEqual(closes.length, 0, "закрытия быть не должно");
  }
}

(async () => {
  await runCase("открыта", "Открыта", false);
  await runCase("запитана", "запитана", true);
  await runCase("закрыта", "ЗАКРЫТА", true);
  console.log("\nALL OK");
  process.exit(0);
})().catch((e) => {
  console.error("\nFAIL:", e.message);
  process.exit(1);
});
