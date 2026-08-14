const axios = require("axios");
const { getJwt } = require("../services/modus/strapi");
require("dotenv").config({ quiet: true });

const COLLECTION = "teh-narusheniyas";
const SEARCH_FIELDS = [
  "OWN_SCNAME",
  "SCNAME",
  "DISPCENTER_NAME_",
  "SC_PO",
  "SC_FILIAL",
  "DISTRICT",
];

const LOCAL_SEARCH_VARIANTS = [
  "орехово-зуево",
  "орехово зуево",
  "ореховозуево",
  "орехово-зуев",
  "орехово зуев",
  "ореховозуев",
  "орехово-зуевский",
  "орехово зуевский",
  "ореховозуевский",
  "орехово-зуевское",
  "орехово зуевское",
  "ореховозуевское",
  "орехово-зуевский г.о",
  "орехово-зуевский го",
  "орехово-зуевский городской округ",
  "город орехово-зуево",
  "г. орехово-зуево",
  "г орехово-зуево",
  "г.о. орехово-зуевский",
  "го орехово-зуевский",
];

const PAVLOVO_POSADSKY_VARIANTS = [
  "павлово-посадский",
  "павлово посадский",
  "павловопосадский",
  "павлово-посадский филиал",
  "павлово посадский филиал",
  "павловопосадский филиал",
  "павлово-посадское",
  "павлово посадское",
  "павловопосадское",
  "павлово-посадское по",
  "павлово посадское по",
  "павловопосадское по",
  "павловский посад",
  "павловский-посад",
  "павловскийпосад",
  "павлово-посад",
  "павлово посад",
  "павловопосад",
];

const PAGE_SIZE = Number(process.argv.find((arg) => arg.startsWith("--page-size="))?.split("=")[1]) || 100;
const MAX_PAGES = Number(process.argv.find((arg) => arg.startsWith("--max-pages="))?.split("=")[1]) || Infinity;
const YEAR = Number(process.argv.find((arg) => arg.startsWith("--year="))?.split("=")[1]) || 2026;
const RETRIES = Number(process.argv.find((arg) => arg.startsWith("--retries="))?.split("=")[1]) || 5;
const RETRY_DELAY_MS = Number(process.argv.find((arg) => arg.startsWith("--retry-delay-ms="))?.split("=")[1]) || 1500;
const PAGE_DELAY_MS = Number(process.argv.find((arg) => arg.startsWith("--page-delay-ms="))?.split("=")[1]) || 150;
const OUTPUT_JSON = process.argv.includes("--json");
const ONLY_GUIDS = process.argv.includes("--guids-only");

const normalizeText = (value) =>
  String(value ?? "")
    .replace(/ё/g, "е")
    .replace(/[‐‑‒–—−]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("ru-RU");

const normalizeCompact = (value) =>
  normalizeText(value)
    .replace(/\bг\s*\.\s*о\s*\./g, "го")
    .replace(/\bг\s*\.\s*/g, "г ")
    .replace(/[.\s-]+/g, "");

const SEARCH_VARIANTS = LOCAL_SEARCH_VARIANTS.flatMap((variant) => [
  normalizeText(variant),
  normalizeCompact(variant),
]).filter(Boolean);

const PAVLOVO_SEARCH_VARIANTS = PAVLOVO_POSADSKY_VARIANTS.flatMap((variant) => [
  normalizeText(variant),
  normalizeCompact(variant),
]).filter(Boolean);

const mapItem = (item) => {
  const attributes = item?.attributes || {};
  return {
    id: item?.id ?? attributes.id,
    documentId: item?.documentId || attributes.documentId || null,
    ...attributes,
    ...item,
  };
};

const pick = (row, key) =>
  row?.[key] ?? row?.data?.[key] ?? row?.data?.data?.[key] ?? null;

const firstNonEmpty = (...values) =>
  values.find((value) => String(value ?? "").trim()) ?? "";

const getGuid = (row) =>
  firstNonEmpty(
    pick(row, "guid"),
    pick(row, "GUID"),
    pick(row, "VIOLATION_GUID_STR"),
    row?.documentId,
    row?.id,
  );

const getChronologyTime = (row) =>
  firstNonEmpty(
    pick(row, "createDateTime"),
    pick(row, "F81_060_EVENTDATETIME"),
    pick(row, "createdAt"),
    pick(row, "updatedAt"),
  );

const getTnNumber = (row) =>
  firstNonEmpty(
    pick(row, "num"),
    pick(row, "number"),
    pick(row, "N_TN"),
    pick(row, "TN_NUMBER"),
    pick(row, "F81_000_NUMBER"),
  );

const getMatchedFields = (row) =>
  SEARCH_FIELDS.flatMap((field) => {
    const value = pick(row, field);
    const normalized = normalizeText(value);
    const compact = normalizeCompact(value);
    const matchedVariants = SEARCH_VARIANTS.filter(
      (variant) =>
        (normalized && normalized.includes(variant)) ||
        (compact && compact.includes(variant)),
    );

    if (!matchedVariants.length) return [];

    return [{
      field,
      value: String(value ?? ""),
    }];
  });

const getPavlovoMatches = (row) =>
  SEARCH_FIELDS.flatMap((field) => {
    const value = pick(row, field);
    const normalized = normalizeText(value);
    const compact = normalizeCompact(value);
    const matchedVariants = PAVLOVO_SEARCH_VARIANTS.filter(
      (variant) =>
        (normalized && normalized.includes(variant)) ||
        (compact && compact.includes(variant)),
    );

    if (!matchedVariants.length) return [];

    return [{
      field,
      value: String(value ?? ""),
    }];
  });

const buildParams = (page) => {
  const params = {
    "pagination[page]": page,
    "pagination[pageSize]": PAGE_SIZE,
    "sort[0]": "createDateTime:asc",
    "sort[1]": "createdAt:asc",
  };

  if (YEAR) {
    params["filters[createDateTime][$gte]"] = `${YEAR}-01-01T00:00:00.000Z`;
    params["filters[createDateTime][$lt]"] = `${YEAR + 1}-01-01T00:00:00.000Z`;
  }

  return params;
};

const createClient = async () => {
  const strapiUrl = String(process.env.URL_STRAPI || "").replace(/\/$/, "");
  if (!strapiUrl) throw new Error("URL_STRAPI не задан в .env");

  const jwt = await getJwt();
  if (!jwt) throw new Error("Не удалось получить JWT Strapi");

  return axios.create({
    baseURL: strapiUrl,
    headers: {
      Authorization: `Bearer ${jwt}`,
      Connection: "close",
    },
    timeout: 120000,
  });
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const fetchPage = async (client, page) => {
  let lastError = null;

  for (let attempt = 1; attempt <= RETRIES; attempt += 1) {
    try {
      const response = await client.get(`/api/${COLLECTION}`, {
        params: buildParams(page),
      });
      return {
        rows: Array.isArray(response?.data?.data) ? response.data.data.map(mapItem) : [],
        pagination: response?.data?.meta?.pagination || {},
      };
    } catch (error) {
      lastError = error;
      const status = error?.response?.status || error?.code || error?.message || "unknown";
      if (attempt >= RETRIES) break;
      const delay = RETRY_DELAY_MS * attempt;
      console.error(
        `[find-orekhovo-zuevo-tns] Страница ${page}: попытка ${attempt}/${RETRIES} упала (${status}), повтор через ${delay} мс`,
      );
      await wait(delay);
    }
  }

  throw lastError;
};

const sortChronologically = (rows) =>
  rows.sort((left, right) => {
    const leftTime = Date.parse(left.time) || 0;
    const rightTime = Date.parse(right.time) || 0;
    if (leftTime !== rightTime) return rightTime - leftTime;
    return String(left.guid).localeCompare(String(right.guid), "ru");
  });

const formatMatchLine = (match) =>
  `${match.field}="${String(match.value).replace(/\s+/g, " ").trim()}"`;

const printHuman = ({ results, scanned, total }) => {
  console.log("=== Поиск ТН по Орехово-Зуево ===");
  console.log(`Коллекция Strapi: ${COLLECTION}`);
  console.log(`Поля: ${SEARCH_FIELDS.join(", ")}`);
  console.log(`Год: ${YEAR}`);
  console.log("Фильтр: полный постраничный проход, совпадения проверяются локально по JSON-полям");
  console.log(`Просмотрено записей: ${scanned}${total ? ` из ${total}` : ""}`);
  console.log(`Найдено совпадений: ${results.length}`);
  console.log(
    `Из них Орехово-Зуево + Павлово-Посадский: ${
      results.filter((item) => item.hasOrekhovoAndPavlovo).length
    }`,
  );
  console.log("");

  if (ONLY_GUIDS) {
    results.forEach((item) => console.log(item.guid));
    return;
  }

  results.forEach((item, index) => {
    console.log(
      `${String(index + 1).padStart(3, " ")}. ${
        item.hasOrekhovoAndPavlovo ? "[ОРЕХОВО + ПАВЛОВО] " : ""
      }${item.time || "без даты"} | GUID=${item.guid || "—"} | TN=${item.number || "—"}`,
    );
    item.matches.forEach((match) => console.log(`     ${formatMatchLine(match)}`));
    if (Array.isArray(item.pavlovoMatches)) {
      item.pavlovoMatches.forEach((match) => console.log(`     PAVLOVO: ${formatMatchLine(match)}`));
    }
  });
};

const main = async () => {
  const client = await createClient();
  const foundByKey = new Map();

  const firstPage = await fetchPage(client, 1);
  const realPageCount = Number(firstPage.pagination.pageCount || 1);
  const pageCount = Math.min(realPageCount, MAX_PAGES);
  const total = Number(firstPage.pagination.total || firstPage.rows.length);
  let scanned = 0;

  const handleRows = (rows) => {
    scanned += rows.length;
    rows.forEach((row) => {
      const rowYear = new Date(getChronologyTime(row)).getFullYear();
      if (YEAR && rowYear !== YEAR) return;

      const matches = getMatchedFields(row);
      if (!matches.length) return;
      const pavlovoMatches = getPavlovoMatches(row);

      const guid = getGuid(row);
      const key = String(guid || row.documentId || row.id);
      if (!key || foundByKey.has(key)) return;

      const result = {
        guid,
        number: getTnNumber(row),
        time: getChronologyTime(row),
        matches,
      };

      if (pavlovoMatches.length) {
        result.pavlovoMatches = pavlovoMatches;
        result.hasPavlovoPosadsky = true;
        result.hasOrekhovoAndPavlovo = true;
      }

      foundByKey.set(key, result);
    });
  };

  handleRows(firstPage.rows);

  for (let page = 2; page <= pageCount; page += 1) {
    const nextPage = await fetchPage(client, page);
    handleRows(nextPage.rows);
    if (page % 10 === 0 || page === pageCount) {
      console.error(`[find-orekhovo-zuevo-tns] Страница ${page}/${pageCount}, просмотрено ${scanned}/${total}`);
    }
    if (PAGE_DELAY_MS > 0) await wait(PAGE_DELAY_MS);
  }

  const results = sortChronologically(Array.from(foundByKey.values()));
  const orekhovoAndPavlovoTotal = results.filter(
    (item) => item.hasOrekhovoAndPavlovo,
  ).length;

  if (OUTPUT_JSON) {
    console.log(JSON.stringify({
      total: results.length,
      orekhovoAndPavlovoTotal,
      scanned,
      results,
    }, null, 2));
    return;
  }

  printHuman({ results, scanned, total });
};

main().catch((error) => {
  const status = error?.response?.status;
  const data = error?.response?.data;
  console.error("[find-orekhovo-zuevo-tns] Ошибка:", status || error?.message);
  if (data) console.error(JSON.stringify(data, null, 2));
  process.exit(1);
});
