// Генерация 2 таблиц (PNG) для поста в MAX-канал: аварийные ТН + ОО все филиалы.
const { fetchOpenTnRows, fetchPesItems, fetchPesDestinations } = require("./fetchers");
const { fetchTnFilialyRows } = require("./filialy");
const { isOperationalDashboardRow, buildPesDashboardCountMaps, buildOperationalBranchRows, buildOperationalBranchSummary } = require("./branchRows");
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

  const [openTnRows, filialRows, pesItems, destinations] = await Promise.all([
    fetchOpenTnRows(jwt),
    fetchTnFilialyRows(jwt),
    fetchPesItems(jwt),
    fetchPesDestinations(jwt),
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

  // PDF #2: таблица «ОО все филиалы» (summary + строки веток с ПЭС-счётчиками).
  const pesCountMaps = buildPesDashboardCountMaps(
    Array.isArray(pesItems) ? pesItems : [],
    Array.isArray(destinations) ? destinations : [],
    filialRows
  );
  const branchRows = buildOperationalBranchRows(openTnRows, filialRows, pesCountMaps);
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
async function generateTablesPdfs({ jwt }) {
  if (!jwt) throw new Error("Нет JWT: авторизуйтесь");

  const [openTnRows, filialRows, pesItems, destinations] = await Promise.all([
    fetchOpenTnRows(jwt),
    fetchTnFilialyRows(jwt),
    fetchPesItems(jwt),
    fetchPesDestinations(jwt),
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

  const pesCountMaps = buildPesDashboardCountMaps(
    Array.isArray(pesItems) ? pesItems : [],
    Array.isArray(destinations) ? destinations : [],
    filialRows
  );
  const branchRows = buildOperationalBranchRows(openTnRows, filialRows, pesCountMaps);
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
    { name: "tn-table.pdf", buffer: tnPdf },
    { name: "oo-table.pdf", buffer: ooPdf },
  ];
}

module.exports = {
  generateTablesPngs,
  generateTablesPdfs,
  MAX_IMAGES_LIMIT,
};
