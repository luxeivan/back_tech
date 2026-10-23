// Генерация 2 таблиц (PNG) для поста в MAX-канал: аварийные ТН + ОО все филиалы.
// [ПЭС-столбец отключён] fetchPesItems/fetchPesDestinations больше не нужны — столбец ПЭС
// берётся из PES_COUNT ТН (как на фронте). Для возврата к модулю ПЭС раскомментировать.
// const { fetchOpenTnRows, fetchPesItems, fetchPesDestinations } = require("./fetchers");
const { fetchOpenTnRows } = require("./fetchers");
const { fetchTnFilialyRows } = require("./filialy");
// [ПЭС-столбец отключён] buildPesDashboardCountMaps закомментирован.
// const { isOperationalDashboardRow, buildPesDashboardCountMaps, buildOperationalBranchRows, buildOperationalBranchSummary } = require("./branchRows");
const { isOperationalDashboardRow, buildOperationalBranchRows, buildOperationalBranchSummary } = require("./branchRows");
const {
  buildHierarchy,
  makeEmergencyDocDefinition,
  makeEmptyDocDefinition,
  makeOoDocDefinition,
} = require("./builders");
const { OPERATIONAL_BRANCH_COLUMNS } = require("./config");
const { docToPdfBuffer, pdfToPngs } = require("./render");

const MAX_IMAGES_LIMIT = 12;

function pagesWithPrefix(pngs, baseName) {
  if (pngs.length === 1) return [{ name: `${baseName}.png`, buffer: pngs[0] }];
  return pngs.map((buffer, index) => ({ name: `${baseName}-${index + 1}.png`, buffer }));
}

async function generateTablesPngs({ jwt }) {
  if (!jwt) throw new Error("Нет JWT: авторизуйтесь");

  // [ПЭС-столбец отключён] fetchPesItems/fetchPesDestinations убраны — столбец ПЭС из PES_COUNT ТН.
  const [openTnRows, filialRows] = await Promise.all([
    fetchOpenTnRows(jwt),
    fetchTnFilialyRows(jwt),
  ]);

  // PDF #1: иерархия аварийных ТН (Филиал → ПО → ГО).
  const list = (Array.isArray(openTnRows) ? openTnRows : []).filter(isOperationalDashboardRow);
  let tnDoc;
  if (!list.length) {
    tnDoc = makeEmptyDocDefinition();
  } else {
    // ПЭС-колонка в этой таблице всегда 0 (pesCountMaps = null — как на фронте).
    const resourceByBranch = new Map(
      buildOperationalBranchRows(list, filialRows, null).map((row) => [row.branch, row])
    );
    const filials = buildHierarchy(list, resourceByBranch);
    tnDoc = filials.length ? makeEmergencyDocDefinition(filials) : makeEmptyDocDefinition();
  }

  // PDF #2: таблица «ОО все филиалы» (summary + строки веток, столбец ПЭС — из PES_COUNT ТН).
  // [ПЭС-столбец отключён] Старый формат (модуль ПЭС) — раскомментировать:
  // const pesCountMaps = buildPesDashboardCountMaps(
  //   Array.isArray(pesItems) ? pesItems : [],
  //   Array.isArray(destinations) ? destinations : [],
  //   filialRows
  // );
  const branchRows = buildOperationalBranchRows(openTnRows, filialRows, null);
  const ooDataSource = [buildOperationalBranchSummary(branchRows), ...branchRows];
  const ooDoc = makeOoDocDefinition(
    ooDataSource.length
      ? ooDataSource
      : [
          {
            key: "empty",
            branch: "Нет данных",
            ...OPERATIONAL_BRANCH_COLUMNS.slice(1).reduce((acc, col) => {
              acc[col.dataIndex] = "";
              return acc;
            }, {}),
          },
        ]
  );

  const [tnPdf, ooPdf] = await Promise.all([docToPdfBuffer(tnDoc), docToPdfBuffer(ooDoc)]);
  const [tnPngs, ooPngs] = await Promise.all([pdfToPngs(tnPdf), pdfToPngs(ooPdf)]);

  const images = [...pagesWithPrefix(tnPngs, "tn-table"), ...pagesWithPrefix(ooPngs, "oo-table")];
  if (images.length > MAX_IMAGES_LIMIT) {
    throw new Error(
      `Слишком много страниц для MAX: ${images.length} изображений (лимит ${MAX_IMAGES_LIMIT}). Уменьшите объём данных.`
    );
  }
  return images;
}

// PDF-файлы для поста в MAX-канале (по одному file-вложению на сообщение — лимит API).
// Имена как на фронте (exportTnPdf.js): «Аварийные ТН» — DD.MM.YYYY HH-mm-ss (МСК),
// «ОО все филиалы» — OO_все филиалы.pdf
function mskExportFilename(now = new Date()) {
  const msk = new Date(now.getTime() + 3 * 60 * 60 * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${p(msk.getUTCDate())}.${p(msk.getUTCMonth() + 1)}.${msk.getUTCFullYear()} ` +
    `${p(msk.getUTCHours())}-${p(msk.getUTCMinutes())}-${p(msk.getUTCSeconds())}.pdf`
  );
}

async function generateTablesPdfs({ jwt }) {
  if (!jwt) throw new Error("Нет JWT: авторизуйтесь");

  // [ПЭС-столбец отключён] fetchPesItems/fetchPesDestinations убраны — столбец ПЭС из PES_COUNT ТН.
  const [openTnRows, filialRows] = await Promise.all([
    fetchOpenTnRows(jwt),
    fetchTnFilialyRows(jwt),
  ]);

  const list = (Array.isArray(openTnRows) ? openTnRows : []).filter(isOperationalDashboardRow);
  let tnDoc;
  if (!list.length) {
    tnDoc = makeEmptyDocDefinition();
  } else {
    const resourceByBranch = new Map(
      buildOperationalBranchRows(list, filialRows, null).map((row) => [row.branch, row])
    );
    const filials = buildHierarchy(list, resourceByBranch);
    tnDoc = filials.length ? makeEmergencyDocDefinition(filials) : makeEmptyDocDefinition();
  }

  // [ПЭС-столбец отключён] Старый формат (модуль ПЭС) — раскомментировать:
  // const pesCountMaps = buildPesDashboardCountMaps(
  //   Array.isArray(pesItems) ? pesItems : [],
  //   Array.isArray(destinations) ? destinations : [],
  //   filialRows
  // );
  const branchRows = buildOperationalBranchRows(openTnRows, filialRows, null);
  const ooDataSource = [buildOperationalBranchSummary(branchRows), ...branchRows];
  const ooDoc = makeOoDocDefinition(
    ooDataSource.length
      ? ooDataSource
      : [
          {
            key: "empty",
            branch: "Нет данных",
            ...OPERATIONAL_BRANCH_COLUMNS.slice(1).reduce((acc, col) => {
              acc[col.dataIndex] = "";
              return acc;
            }, {}),
          },
        ]
  );

  const [tnPdf, ooPdf] = await Promise.all([docToPdfBuffer(tnDoc), docToPdfBuffer(ooDoc)]);
  return [
    { name: mskExportFilename(), buffer: tnPdf },
    { name: "ОО_все филиалы.pdf", buffer: ooPdf },
  ];
}

module.exports = {
  generateTablesPngs,
  generateTablesPdfs,
  MAX_IMAGES_LIMIT,
};
