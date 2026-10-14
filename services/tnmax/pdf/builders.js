// Порт exportTnPdf.js (front .../emergency/js): построители docDefinition для pdfmake.
// Вместо pdfMake.createPdf(...).download() — возврат docDefinition (см. render.js).
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
const timezone = require("dayjs/plugin/timezone");
const { toNumber, pick, s, startDate } = require("./common");
const {
  getOperationalBranchByRow,
  getOperationalDistrictByRow,
  getOperationalPoByRow,
} = require("./branchRows");
const { OPERATIONAL_BRANCH_COLUMNS } = require("./config");

dayjs.extend(utc);
dayjs.extend(timezone);

// Метрики — без МКД и ОВБ; ЖВО = Котел. ЦТП + ВЗУ ВНС + КНС.
const METRIC_COLUMNS = [
  { key: "population", title: "Население", width: 48 },
  { key: "jvo", title: "ЖВО (Котел. ЦТП,\nВЗУ ВНС, КНС)", width: 90 },
  { key: "medical", title: "Медицина\n(больницы, поликлиники)", width: 58 },
  { key: "schools", title: "Образование\n(школы, дет.сады)", width: 52 },
  { key: "staff", title: "Персонал", width: 44 },
  { key: "pes", title: "ПЭС", width: 32 },
];

const SUM_FIELDS = METRIC_COLUMNS.map((c) => c.key);

function exportFilename() {
  const ts = dayjs().tz("Europe/Moscow").format("DD.MM.YYYY HH-mm-ss");
  return `${ts}.pdf`;
}

function addFields(row, fields) {
  return fields.reduce((sum, field) => sum + toNumber(pick(row, field)), 0);
}

function emptyTotals() {
  const totals = { tnCount: 0 };
  METRIC_COLUMNS.forEach(({ key }) => {
    totals[key] = 0;
  });
  return totals;
}

function mergeTotals(target, source) {
  SUM_FIELDS.forEach((field) => {
    target[field] += toNumber(source[field]);
  });
  target.tnCount += toNumber(source.tnCount);
  return target;
}

function addRowToTotals(totals, row) {
  totals.tnCount += 1;
  totals.population += toNumber(pick(row, "POPULATION_COUNT"));
  totals.jvo += addFields(row, [
    "BOILER_ALL",
    "CTP_ALL",
    "WELLS_ALL",
    "VNS_ALL",
    "KNS_ALL",
  ]);
  totals.medical += addFields(row, ["HOSPITALS_ALL", "CLINICS_ALL"]);
  totals.schools += addFields(row, ["SCHOOLS_ALL", "KINDERGARTENS_ALL"]);
  totals.staff += toNumber(pick(row, "EMPLOYEECOUNT"));
}

function nameOr(value, fallback) {
  const v = s(value);
  return v || fallback;
}

function metricCells(totals) {
  return METRIC_COLUMNS.map(({ key }) => {
    const value = totals?.[key];
    if (value === undefined || value === null || value === "") {
      return { text: "0", alignment: "right" };
    }
    if (typeof value === "number") return { text: String(value), alignment: "right" };
    return { text: String(value) };
  });
}

// Цвета как на /dashboard-oo.
const COLORS = {
  headerBg: "#285a9c",
  headerText: "#ffffff",
  // между шапкой (#285a9c) и ПО (#e2eef9)
  filialBg: "#4d7db5",
  filialText: "#ffffff",
  poBg: "#e2eef9",
  poText: "#0a5f9e",
  goBg: "#e2eef9",
  goText: "#0a5f9e",
  totalBg: "#94add6",
  totalText: "#101827",
  border: "#d9d9d9",
};

function rowPalette(level, isTotal = false) {
  if (isTotal) return { bg: COLORS.totalBg, text: COLORS.totalText };
  if (level === 0) return { bg: COLORS.filialBg, text: COLORS.filialText };
  if (level === 1) return { bg: COLORS.poBg, text: COLORS.poText };
  return { bg: COLORS.goBg, text: COLORS.goText };
}

function headerRow() {
  return [
    {
      text: "Филиал / ПО / ГО",
      bold: true,
      alignment: "left",
      fontSize: 7,
      color: COLORS.headerText,
      fillColor: COLORS.headerBg,
    },
    ...METRIC_COLUMNS.map(({ title }) => ({
      text: title,
      bold: true,
      alignment: "center",
      fontSize: 7,
      color: COLORS.headerText,
      fillColor: COLORS.headerBg,
    })),
  ];
}

function outlineText(text, { id, parentId = null, expanded = true } = {}) {
  return {
    text,
    bold: true,
    ...(id ? { outline: true, outlineText: text, outlineExpanded: expanded } : {}),
    ...(parentId ? { outlineParentId: parentId } : {}),
  };
}

function labelCell({ level, label, id, parentId, color }) {
  // level: 0 — филиал, 1 — ПО, 2 — ГО
  const indent = level * 6;
  const prefix = level === 0 ? "" : level === 1 ? " " : "  ";
  return {
    stack: [
      {
        ...outlineText(`${prefix}${label}`, {
          id: level < 2 ? id : undefined,
          parentId,
          expanded: true,
        }),
        fontSize: level === 0 ? 8 : 7,
        color,
        margin: [indent, 0, 0, 0],
      },
    ],
    margin: [0, 1, 0, 1],
  };
}

function dataRow({ level, label, totals, id, parentId, isTotal = false }) {
  const { bg, text: textColor } = rowPalette(level, isTotal);

  return [
    labelCell({ level, label, id, parentId, color: textColor }),
    ...metricCells(totals),
  ].map((cell, index) => {
    if (index === 0) {
      return {
        ...cell,
        fillColor: bg,
        color: textColor,
      };
    }
    return {
      ...cell,
      fillColor: bg,
      color: textColor,
      fontSize: 7,
      bold: level < 2 || isTotal,
    };
  });
}

// Момент возникновения ТН; null → 0 (такие уйдут ниже датированных).
function rowStartMs(row) {
  const raw = startDate(row);
  if (!raw) return 0;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? 0 : ms;
}

// Новое ТН выше ранее возникших: сначала по maxStart (убыв.), потом алфавит.
function byNewestFirst(a, b) {
  if (b.maxStart !== a.maxStart) return b.maxStart - a.maxStart;
  return String(a.name).localeCompare(String(b.name), "ru");
}

function buildHierarchy(list, resourceByBranch) {
  const filialMap = new Map();

  list.forEach((row) => {
    const filialName = nameOr(getOperationalBranchByRow(row), "Без филиала");
    const poName = nameOr(getOperationalPoByRow(row), "Без ПО");
    const goName = nameOr(
      getOperationalDistrictByRow(row) || pick(row, "DISTRICT"),
      "Без ГО"
    );
    const startMs = rowStartMs(row);

    if (!filialMap.has(filialName)) {
      const resourceRow = resourceByBranch.get(getOperationalBranchByRow(row) || filialName);
      filialMap.set(filialName, {
        name: filialName,
        maxStart: 0,
        totals: { ...emptyTotals(), pes: toNumber(resourceRow?.pes) },
        pos: new Map(),
      });
    }
    const filial = filialMap.get(filialName);
    if (startMs > filial.maxStart) filial.maxStart = startMs;

    if (!filial.pos.has(poName)) {
      filial.pos.set(poName, {
        name: poName,
        maxStart: 0,
        totals: emptyTotals(),
        gos: new Map(),
      });
    }
    const po = filial.pos.get(poName);
    if (startMs > po.maxStart) po.maxStart = startMs;

    if (!po.gos.has(goName)) {
      po.gos.set(goName, {
        name: goName,
        maxStart: 0,
        totals: emptyTotals(),
      });
    }
    const go = po.gos.get(goName);
    if (startMs > go.maxStart) go.maxStart = startMs;

    addRowToTotals(go.totals, row);
  });

  filialMap.forEach((filial) => {
    const filialAgg = { ...emptyTotals(), pes: filial.totals.pes };
    filial.pos.forEach((po) => {
      const poAgg = emptyTotals();
      po.gos.forEach((go) => mergeTotals(poAgg, go.totals));
      po.totals = poAgg;
      mergeTotals(filialAgg, poAgg);
    });
    filial.totals = {
      ...filialAgg,
      pes: filial.totals.pes,
    };
  });

  return [...filialMap.values()].sort(byNewestFirst);
}

function slug(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-zа-яё0-9]+/gi, "-")
    .replace(/^-|-$/g, "");
}

function buildBody(filials) {
  const body = [headerRow()];
  const grand = emptyTotals();

  filials.forEach((filial) => {
    mergeTotals(grand, {
      ...filial.totals,
      tnCount: filial.totals.tnCount,
    });
  });

  body.push(
    dataRow({
      level: 0,
      label: "ВСЕГО",
      totals: grand,
      id: "total",
      parentId: null,
      isTotal: true,
    })
  );

  filials.forEach((filial) => {
    const fId = `f-${slug(filial.name)}`;
    body.push(
      dataRow({
        level: 0,
        label: filial.name,
        totals: filial.totals,
        id: fId,
        parentId: null,
      })
    );

    const pos = [...filial.pos.values()].sort(byNewestFirst);
    pos.forEach((po) => {
      const pId = `${fId}-po-${slug(po.name)}`;
      body.push(
        dataRow({
          level: 1,
          label: po.name,
          totals: po.totals,
          id: pId,
          parentId: fId,
        })
      );

      const gos = [...po.gos.values()].sort(byNewestFirst);
      gos.forEach((go) => {
        body.push(
          dataRow({
            level: 2,
            label: go.name,
            totals: go.totals,
            id: null,
            parentId: pId,
          })
        );
      });
    });
  });

  return body;
}

// A4 landscape ≈ 842pt, pageMargins [16, …, 16, …] → контент ≈ 810.
// Первый столбец: 70% «звёзды», затем −30% → ~49% от исходного (~450 → ~220).
const TABLE_WIDTHS = (() => {
  const metricsWidth = METRIC_COLUMNS.reduce((sum, { width }) => sum + width, 0);
  const pageContentWidth = 841.89 - 16 - 16;
  const firstCol = Math.round((pageContentWidth - metricsWidth) * 0.7 * 0.7);
  return [firstCol, ...METRIC_COLUMNS.map(({ width }) => width)];
})();

const TABLE_LAYOUT = {
  hLineColor: () => COLORS.border,
  vLineColor: () => COLORS.border,
  hLineWidth: () => 0.4,
  vLineWidth: () => 0.4,
  paddingLeft: () => 3,
  paddingRight: () => 3,
  paddingTop: () => 2,
  paddingBottom: () => 2,
  fillColor: (rowIndex, node) => {
    if (rowIndex === 0) return COLORS.headerBg;
    const cell = node?.table?.body?.[rowIndex]?.[0];
    if (cell && typeof cell === "object" && cell.fillColor) return cell.fillColor;
    return null;
  },
};

function makeEmergencyDocDefinition(filials) {
  return {
    pageOrientation: "landscape",
    pageSize: "A4",
    pageMargins: [16, 24, 16, 24],
    content: [
      {
        text: "Аварийные ТН",
        style: "header",
        margin: [0, 0, 0, 8],
      },
      {
        table: {
          headerRows: 1,
          widths: TABLE_WIDTHS,
          body: buildBody(filials),
          dontBreakRows: false,
          keepWithHeaderRows: 1,
        },
        layout: TABLE_LAYOUT,
        fontSize: 7,
      },
    ],
    styles: {
      header: {
        fontSize: 13,
        bold: true,
      },
    },
    defaultStyle: {
      fontSize: 7,
    },
  };
}

function makeEmptyDocDefinition() {
  return {
    pageOrientation: "landscape",
    pageSize: "A4",
    pageMargins: [16, 24, 16, 24],
    content: [
      {
        text: "Аварийные ТН",
        style: "header",
        margin: [0, 0, 0, 8],
      },
      {
        table: {
          headerRows: 1,
          widths: TABLE_WIDTHS,
          body: [headerRow()],
          dontBreakRows: false,
          keepWithHeaderRows: 1,
        },
        layout: {
          ...TABLE_LAYOUT,
          fillColor: (rowIndex) => (rowIndex === 0 ? COLORS.headerBg : null),
        },
        fontSize: 7,
      },
    ],
    styles: {
      header: {
        fontSize: 13,
        bold: true,
      },
    },
    defaultStyle: {
      fontSize: 7,
    },
  };
}

// Стили таблицы «Округа» с /dashboard-oo (OperationalDistrictsPanel).
const OO_TABLE_COLORS = {
  headerBg: "#285a9c",
  headerText: "#ffffff",
  border: "#ffffff",
  branchText: "#0968ad",
  dataText: "#0a5f9d",
  oddBg: "#d3e2f4",
  evenBg: "#e2eef9",
  summaryBg: "#94add5",
  summaryText: "#111827",
};

const OO_COLUMN_TITLES = {
  branch: "Филиал",
  lep: "ЛЭП",
  tpRp: "ТП (РП)",
  population: "Население",
  mkd: "МКД",
  boilerCtp: "Котел. ЦТП",
  vzuVns: "ВЗУ ВНС",
  kns: "КНС",
  medical: "Больницы\nПоликлиники",
  schools: "Школы\nд.сады",
  brigades: "Бригады",
  staff: "Персонал",
  vehicles: "Техника",
  pes: "ПЭС",
  mainResource: "Осн.\nресурс",
  ovb: "ОВБ",
  ovbVSmene: "В смене",
};

const OO_FILIAL_COLUMN_WIDTHS = {
  lep: 34,
  tpRp: 38,
  population: 50,
  mkd: 34,
  boilerCtp: 44,
  vzuVns: 42,
  kns: 34,
  medical: 56,
  schools: 52,
  brigades: 42,
  staff: 44,
  vehicles: 42,
  pes: 34,
  mainResource: 36,
  ovb: 34,
  ovbVSmene: 40,
};

const OO_NUMBER_FORMAT = new Intl.NumberFormat("ru-RU");

function formatOoCellValue(value) {
  if (typeof value === "number") return OO_NUMBER_FORMAT.format(value);
  if (value === null || value === undefined || value === "") return "";
  return String(value);
}

function ooHeaderRow() {
  return OPERATIONAL_BRANCH_COLUMNS.map((column) => ({
    text: OO_COLUMN_TITLES[column.dataIndex] || String(column.dataIndex),
    bold: true,
    alignment: "center",
    fontSize: 7,
    color: OO_TABLE_COLORS.headerText,
    fillColor: OO_TABLE_COLORS.headerBg,
  }));
}

function ooBodyRow(record, index, isSummary = false) {
  const bg = isSummary
    ? OO_TABLE_COLORS.summaryBg
    : index % 2 === 0
      ? OO_TABLE_COLORS.oddBg
      : OO_TABLE_COLORS.evenBg;
  const textColor = isSummary ? OO_TABLE_COLORS.summaryText : OO_TABLE_COLORS.dataText;

  return OPERATIONAL_BRANCH_COLUMNS.map((column, colIndex) => {
    const isBranch = column.dataIndex === "branch";
    return {
      text: formatOoCellValue(record[column.dataIndex]),
      bold: isSummary || isBranch,
      alignment: isBranch ? "left" : "center",
      color: isBranch && !isSummary ? OO_TABLE_COLORS.branchText : textColor,
      fillColor: bg,
      fontSize: 7,
      margin: colIndex === 0 ? [2, 1, 0, 1] : [0, 1, 0, 1],
    };
  });
}

function ooTableWidths() {
  // A4 landscape ≈ 842pt, поля 16+16 → ~810. Филиал забирает остаток.
  return [
    "*",
    ...OPERATIONAL_BRANCH_COLUMNS.slice(1).map(
      (column) => OO_FILIAL_COLUMN_WIDTHS[column.dataIndex] || 40
    ),
  ];
}

function makeOoDocDefinition(dataSource) {
  return {
    pageOrientation: "landscape",
    pageSize: "A4",
    pageMargins: [16, 24, 16, 24],
    content: [
      {
        text: "ОО все филиалы",
        style: "header",
        margin: [0, 0, 0, 8],
      },
      {
        table: {
          headerRows: 1,
          widths: ooTableWidths(),
          body: [
            ooHeaderRow(),
            ...dataSource.map((record, index) =>
              ooBodyRow(record, index, record?.key === "summary")
            ),
          ],
          dontBreakRows: false,
          keepWithHeaderRows: 1,
        },
        layout: {
          hLineColor: () => OO_TABLE_COLORS.border,
          vLineColor: () => OO_TABLE_COLORS.border,
          hLineWidth: () => 0.4,
          vLineWidth: () => 0.4,
          paddingLeft: () => 3,
          paddingRight: () => 3,
          paddingTop: () => 2,
          paddingBottom: () => 2,
          fillColor: (rowIndex, node) => {
            if (rowIndex === 0) return OO_TABLE_COLORS.headerBg;
            const cell = node?.table?.body?.[rowIndex]?.[0];
            if (cell && typeof cell === "object" && cell.fillColor) return cell.fillColor;
            return null;
          },
        },
        fontSize: 7,
      },
    ],
    styles: {
      header: {
        fontSize: 13,
        bold: true,
      },
    },
    defaultStyle: {
      fontSize: 7,
    },
  };
}

module.exports = {
  METRIC_COLUMNS,
  SUM_FIELDS,
  exportFilename,
  addFields,
  emptyTotals,
  mergeTotals,
  nameOr,
  metricCells,
  COLORS,
  rowPalette,
  headerRow,
  outlineText,
  labelCell,
  dataRow,
  rowStartMs,
  byNewestFirst,
  buildHierarchy,
  slug,
  buildBody,
  TABLE_WIDTHS,
  makeEmergencyDocDefinition,
  makeEmptyDocDefinition,
  OO_TABLE_COLORS,
  OO_COLUMN_TITLES,
  OO_FILIAL_COLUMN_WIDTHS,
  formatOoCellValue,
  ooHeaderRow,
  ooBodyRow,
  ooTableWidths,
  makeOoDocDefinition,
};
