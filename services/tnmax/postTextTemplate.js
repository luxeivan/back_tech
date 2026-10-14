const { buildAutoDescription } = require("../autoDescription");

const SZO_ALL_FIELDS = [
  "CLINICS_ALL",
  "HOSPITALS_ALL",
  "SCHOOLS_ALL",
  "KINDERGARTENS_ALL",
  "BOILER_ALL",
  "CTP_ALL",
  "KNS_ALL",
  "WELLS_ALL",
  "VNS_ALL",
];

const num = (v) => (Number.isFinite(+v) ? +v : 0);

function szoCount(raw) {
  return SZO_ALL_FIELDS.reduce((sum, field) => sum + num(raw[field]), 0);
}

function severityEmoji(population, szo) {
  if (szo > 5 || population > 5000) return "🔴🔴🔴";
  if (szo === 0 && population <= 1000) return "🟢";
  return "🔴🔴";
}

function buildMaxPostText(raw = {}) {
  const number = String(raw.F81_010_NUMBER ?? "").trim();
  const population = num(raw.POPULATION_COUNT);
  const szo = szoCount(raw);


  const headerLine = [
    number ? `${number}.` : "",
    severityEmoji(population, szo),
    `🧑‍🧑‍🧒‍🧒(${population})`,
    `🏭(${szo})`,
  ]
    .filter(Boolean)
    .join(" ");

  const body = buildAutoDescription(raw, {
    includeHousesAddresses: false,
    socialObjectsBlocks: true,
  })
    .replace(/^АО «Мособлэнерго»\s*/, "")
    // Пустая строка перед первым блоком СЗО — как в макете заказчика
    .replace(
      /(^|\n)(?!\n)(Поликлиники|Больницы|Школы|Детские сады|Котельные|ЦТП|КНС|ВЗУ|ВНС|СНТ):/m,
      "$1\n$2:"
    );

  return [headerLine, body].filter(Boolean).join("\n\n");
}

module.exports = { buildMaxPostText, szoCount, severityEmoji };
