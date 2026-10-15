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
const pad2 = (n) => String(n).padStart(2, "0");

function szoCount(raw) {
  return SZO_ALL_FIELDS.reduce((sum, field) => sum + num(raw[field]), 0);
}

function severityEmoji(population, szo) {
  if (szo > 5 || population > 5000) return "🔴🔴🔴";
  if (szo === 0 && population <= 1000) return "🟢";
  return "🔴🔴";
}

// HH:MM по МСК (UTC+3, без DST)
function formatMskTime(v) {
  if (!v) return "";
  const d = new Date(v);
  if (isNaN(d.getTime())) return "";
  const msk = new Date(d.getTime() + 3 * 60 * 60 * 1000);
  return `${pad2(msk.getUTCHours())}:${pad2(msk.getUTCMinutes())}`;
}

// Порядковый номер из первой строки первого поста: "2. 🔴🔴 👪(3) 🏭(3)"
function parseSequenceFromDescription(desc) {
  const m = String(desc || "").match(/^\s*(\d+)\./);
  return m ? Number(m[1]) : null;
}

// Количество кружков важности из шапки первого поста: "2. 🔴🔴 👪(3) 🏭(3)"
function parseCircleCountFromDescription(desc) {
  const firstLine = String(desc || "").split("\n")[0] || "";
  const reds = (firstLine.match(/🔴/g) || []).length;
  const greens = (firstLine.match(/🟢/g) || []).length;
  const n = reds || greens;
  return n > 0 ? n : null;
}

// Строка «дата филиал ПО. объект…» — второй абзац первого поста
// (после шапки «N. …» и пустой строки), как в макете заказчика закрытия.
function parseObjectLineFromDescription(desc) {
  const parts = String(desc || "").split(/\n{2,}/);
  return (parts[1] || "").trim();
}

// Жирные лейблы первого поста (включая двоеточие; значение после — обычное).
// «Городской округ: …» НЕ в списке — по просьбе юзера (красный не поддержан API).
const BOLD_LABELS = [
  "Без напряжения:",
  "ТП, РП полностью:",
  "ТП, РП по одной секции:",
  "МКД:",
  "Чел:",
  "Абонентов:",
  "СЗО полностью:",
  "СЗО по одной секции:",
  "Направлено ПЭС:",
  "Задействовано:",
  "Прогнозируемое время включения",
];

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Плейн-текст → HTML для MAX (format: "html"): жирные лейблы через <b>…</b>
function boldifyForMax(plain) {
  let html = escapeHtml(plain);
  for (const label of BOLD_LABELS) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    html = html.replace(new RegExp(`(^|\\n)(${escaped})`, "g"), "$1<b>$2</b>");
  }
  return html;
}

function buildMaxPostText(raw = {}, { sequenceNumber } = {}) {
  // sequenceNumber — порядковый номер аварийки с 08:00 МСК (см. calcSequenceNumber в postPublisher);
  // fallback на номер ТН из МОДУСа, если нумерация не посчиталась
  const number =
    sequenceNumber != null && Number(sequenceNumber) > 0
      ? String(sequenceNumber)
      : String(raw.F81_010_NUMBER ?? "").trim();
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

// Пост-закрытие/запитка (макет заказчика «Скрин закрытия.png»):
// N. 🟢…(0) 🏭(0)\nДоп. информация: /<строка первого поста>/. В HH:MM электроснабжение… Причина - …
// sequenceNumber/objectLine — из первого поста (description_MAX_operativnayObstanovka).
function buildClosePostText(
  raw = {},
  { sequenceNumber, firstDescription, recoveryAt, reason } = {}
) {
  // Кружки той же важности, что и в первом посте, но зелёные; (0)(0) по макету.
  // Количество берём из шапки первого поста; fallback — пересчёт из raw.
  const greenCircles = "🟢".repeat(
    parseCircleCountFromDescription(firstDescription) ||
      severityEmoji(num(raw.POPULATION_COUNT), szoCount(raw)).replace(/[^🔴]/g, "").length ||
      1
  );
  const number =
    sequenceNumber != null && Number(sequenceNumber) > 0
      ? String(sequenceNumber)
      : parseSequenceFromDescription(firstDescription) ||
        String(raw.F81_010_NUMBER ?? "").trim();

  const headerLine = [
    number ? `${number}.` : "",
    greenCircles,
    "🧑‍🧑‍🧒‍🧒(0)",
    "🏭(0)",
  ]
    .filter(Boolean)
    .join(" ");

  const objectLine = parseObjectLineFromDescription(firstDescription);
  const when = formatMskTime(recoveryAt || raw.F81_290_RECOVERYDATETIME);
  const reasonText = String(reason || raw.REASON_OPER || "").trim();

  // Макет заказчика (уточнение 2026-10-15): каждая часть на своей строке
  const lines = [
    "Доп. информация:",
    objectLine ? `/${objectLine}/.` : null,
    when ? `В ${when} электроснабжение потребителей восстановлено.` : null,
    reasonText ? `Причина - ${reasonText}.` : null,
  ].filter(Boolean);

  return [headerLine, ...lines].filter(Boolean).join("\n");
}

module.exports = {
  buildMaxPostText,
  buildClosePostText,
  boldifyForMax,
  parseSequenceFromDescription,
  parseObjectLineFromDescription,
  formatMskTime,
  szoCount,
  severityEmoji,
};
