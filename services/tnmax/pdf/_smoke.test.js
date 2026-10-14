// Smoke-тест генерации 2 PDF: мок-данные → docDefinition → PDF-буферы.
// Запуск: node services/tnmax/pdf/_smoke.test.js (без сети).
const assert = require("assert");
const { execFileSync } = require("child_process");
const {
  isOperationalDashboardRow,
  buildPesDashboardCountMaps,
  buildOperationalBranchRows,
  buildOperationalBranchSummary,
} = require("./branchRows");
const {
  buildHierarchy,
  makeEmergencyDocDefinition,
  makeEmptyDocDefinition,
  makeOoDocDefinition,
} = require("./builders");
const { docToPdfBuffer, pdfToPngs } = require("./render");
const { isOpenTN } = require("./common");

// --- Мок-данные: открытые аварийные ТН по 3 филиалам ---
const mkTn = (over) => ({
  isActive: true,
  BASE_TYPE: 0,
  STATUS_NAME: "Открыта",
  createDateTime: "2026-10-01T10:00:00.000+03:00",
  SC_FILIAL: "Домодедовский",
  SC_PO: "Домодедово ПО",
  DISTRICT: "г.о. Домодедово",
  DISPCENTER_NAME_: "Домодедово",
  POPULATION_COUNT: 1000,
  MKD_ALL: 120,
  BOILER_ALL: 10,
  CTP_ALL: 5,
  WELLS_ALL: 3,
  VNS_ALL: 2,
  KNS_ALL: 4,
  HOSPITALS_ALL: 2,
  CLINICS_ALL: 6,
  SCHOOLS_ALL: 8,
  KINDERGARTENS_ALL: 7,
  EMPLOYEECOUNT: 50,
  BRIGADECOUNT: 5,
  SPECIALTECHNIQUECOUNT: 9,
  LINE110_ALL: 12,
  LINE35_ALL: 30,
  LINESN_ALL: 11,
  LINENN_ALL: 6,
  TP_ALL: 40,
  RPSN_ALL: 15,
  ...over,
});

const tnRows = [
  mkTn({}),
  mkTn({
    SC_FILIAL: "Коломенский филиал",
    SC_PO: "Коломна ПО",
    DISTRICT: "г.о. Коломна",
    DISPCENTER_NAME_: "Коломна",
    POPULATION_COUNT: 2500,
    createDateTime: "2026-10-02T08:30:00.000+03:00",
  }),
  mkTn({
    SC_FILIAL: "Раменский",
    SC_PO: "Раменское ПО",
    DISTRICT: "г.о. Раменское",
    DISPCENTER_NAME_: "Раменское",
    POPULATION_COUNT: 700,
    createDateTime: "2026-10-03T15:45:00.000+03:00",
  }),
  // Не должна попасть: закрытая ТН.
  mkTn({ isActive: false, SC_FILIAL: "Мытищинский", POPULATION_COUNT: 50 }),
];

// Мок строк филиалов (tn-filialies) с relation ПО/округов.
const filialRows = [
  {
    id: 1,
    documentId: "f1",
    name: "Домодедовский",
    is_active: true,
    osn_resours: 420,
    ovb: 78,
    v_smene: 45,
    tn_pos: [{ id: 11, documentId: "p1", name: "Домодедово ПО", is_active: true }],
    tn_okruga: [{ id: 21, documentId: "o1", name: "г.о. Домодедово", is_active: true }],
  },
  {
    id: 2,
    documentId: "f2",
    name: "Коломенский",
    is_active: true,
    osn_resours: 310,
    ovb: 60,
    v_smene: 33,
    tn_pos: [{ id: 12, documentId: "p2", name: "Коломна ПО", is_active: true }],
    tn_okruga: [],
  },
  {
    id: 3,
    documentId: "f3",
    name: "Раменский",
    is_active: true,
    osn_resours: 250,
    ovb: 55,
    v_smene: 28,
    tn_pos: [],
    tn_okruga: [{ id: 23, documentId: "o3", name: "г.о. Раменское", is_active: true }],
  },
];

// Мок ПЭС-элементов/складов (только активные статусы учитываются).
const pesItems = [
  { id: "e1", status: "connected", branch: "Домодедовский", po: "Домодедово ПО", district: "г.о. Домодедово", destination: { id: "d1", type: "assembly" } },
  { id: "e2", status: "en_route", branch: "Коломенский", po: "Коломна ПО", district: "г.о. Коломна", destination: { id: "d2", type: "assembly" } },
  { id: "e3", status: "cancelled", branch: "Раменский", po: "Раменское ПО", district: "г.о. Раменское", destination: { id: "d3", type: "assembly" } },
];
const destinations = [
  { id: "d1", branch: "Домодедовский", po: "Домодедово ПО", district: "г.о. Домодедово", address: "городской округ Домодедово, ул. Ленина" },
  { id: "d2", branch: "Коломенский", po: "Коломна ПО", district: "г.о. Коломна", address: "г. Коломна, пр. Ленина" },
];

async function main() {
  // --- PDF #1: иерархия аварийных ТН ---
  // fetchOpenTnRows уже фильтрует по isOpenTN (isActive) — воспроизводим ту же цепочку.
  const openRows = tnRows.filter(isOpenTN);
  const list = openRows.filter(isOperationalDashboardRow);
  assert.strictEqual(list.length, 3, `ожидалось 3 открытые ТН, получено ${list.length}`);

  const resourceByBranch = new Map(
    buildOperationalBranchRows(list, filialRows, null).map((row) => [row.branch, row])
  );
  const filials = buildHierarchy(list, resourceByBranch);
  assert.strictEqual(filials.length, 3, "иерархия должна содержать 3 филиала");
  const tnDoc = filials.length ? makeEmergencyDocDefinition(filials) : makeEmptyDocDefinition();

  // --- PDF #2: ОО все филиалы ---
  const pesCountMaps = buildPesDashboardCountMaps(pesItems, destinations, filialRows);
  const branchRows = buildOperationalBranchRows(tnRows, filialRows, pesCountMaps);
  assert.strictEqual(branchRows.length, 3, "строк веток ОО = 3");
  // Два активных ПЭС: Домодедовский и Коломенский.
  const pesByBranch = Object.fromEntries(branchRows.map((r) => [r.branch, r.pes]));
  assert.strictEqual(pesByBranch["Домодедовский"], 1, "ПЭС Домодедовский = 1");
  assert.strictEqual(pesByBranch["Коломенский"], 1, "ПЭС Коломенский = 1");
  assert.strictEqual(pesByBranch["Раменский"], 0, "ПЭС Раменский = 0 (cancelled)");

  const ooDataSource = [buildOperationalBranchSummary(branchRows), ...branchRows];
  const ooDoc = makeOoDocDefinition(ooDataSource);

  // --- Рендер PDF ---
  const [tnPdf, ooPdf] = await Promise.all([docToPdfBuffer(tnDoc), docToPdfBuffer(ooDoc)]);

  assert.ok(tnPdf.length > 1000, `PDF #1 слишком мал: ${tnPdf.length} байт`);
  assert.strictEqual(tnPdf.subarray(0, 4).toString(), "%PDF", "PDF #1 не начинается с %PDF");
  assert.ok(ooPdf.length > 1000, `PDF #2 слишком мал: ${ooPdf.length} байт`);
  assert.strictEqual(ooPdf.subarray(0, 4).toString(), "%PDF", "PDF #2 не начинается с %PDF");

  // Пустой docDefinition тоже должен рендериться.
  const emptyPdf = await docToPdfBuffer(makeEmptyDocDefinition());
  assert.ok(emptyPdf.length > 1000, `пустой PDF слишком мал: ${emptyPdf.length} байт`);
  assert.strictEqual(emptyPdf.subarray(0, 4).toString(), "%PDF");

  console.log(`PDF #1 (аварийные ТН): ${tnPdf.length} байт`);
  console.log(`PDF #2 (ОО все филиалы): ${ooPdf.length} байт`);
  console.log(`PDF пустой: ${emptyPdf.length} байт`);

  // --- pdftoppm: только если установлен ---
  try {
    execFileSync("pdftoppm", ["-v"], { stdio: "ignore" });
    const pngs = await pdfToPngs(tnPdf);
    assert.ok(pngs.length >= 1, "pdftoppm не дал страниц");
    pngs.forEach((buf, i) => {
      // PNG-сигнатуру: 89 50 4E 47
      assert.strictEqual(buf.subarray(0, 4).toString("hex"), "89504e47", `страница ${i + 1} не PNG`);
    });
    console.log(`PNG из PDF #1: ${pngs.length} стр., размеры: ${pngs.map((b) => b.length).join(", ")} байт`);
  } catch (error) {
    if (error?.code === "ENOENT" || /pdftoppm не установлен/.test(error?.message || "")) {
      console.log("PNG-конвертация ПРОПУЩЕНА: pdftoppm не установлен (apt/brew install poppler-utils)");
    } else {
      throw error;
    }
  }

  console.log("SMOKE OK");
}

main().catch((error) => {
  console.error("SMOKE FAILED:", error);
  process.exit(1);
});
