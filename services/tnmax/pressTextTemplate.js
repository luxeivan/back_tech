// Шаблоны постов для канала press «Мособлэнерго24» (без таблиц — MAX их не умеет).
// Плановые — по живому примеру из канала; внеплановые — по шаблону пресс-службы.

const MONTHS_GENITIVE = [
  "января", "февраля", "марта", "апреля", "мая", "июня",
  "июля", "августа", "сентября", "октября", "ноября", "декабря",
];

const MSK_OPTIONS = { timeZone: "Europe/Moscow", hour12: false };

function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

// "05.11.2026"
function fmtDmy(d) {
  if (!d) return "";
  const p = new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).formatToParts(d);
  const get = (t) => p.find((x) => x.type === t)?.value || "";
  return `${get("day")}.${get("month")}.${get("year")}`;
}

// "5 ноября" — день без ведущего нуля, для заголовка
function fmtDayMonthTitle(d) {
  if (!d) return "";
  const parts = new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "numeric",
    month: "numeric",
  }).formatToParts(d);
  const day = Number(parts.find((x) => x.type === "day")?.value || 0);
  const month = Number(parts.find((x) => x.type === "month")?.value || 0);
  if (!day || !month) return "";
  return `${day} ${MONTHS_GENITIVE[month - 1]}`;
}

// "11:00"
function fmtHm(d) {
  if (!d) return "";
  return new Intl.DateTimeFormat("ru-RU", {
    ...MSK_OPTIONS,
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

// "11:00 – 16:00"; если конец в другой день — с датой
function fmtWindow(start, end) {
  if (!start) return "";
  const s = fmtHm(start);
  if (!end) return s;
  const sameDay = fmtDmy(start) === fmtDmy(end);
  return sameDay ? `${s} – ${fmtHm(end)}` : `${s} – ${fmtDmy(end)} ${fmtHm(end)}`;
}

// "Пушкинский г.о." / "Городской Округ Истра" → "пушкинский" / "истра"
function normalizeDistrictKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/г\s*\.\s*о\s*\.?/g, " ")
    .replace(/муниципальн\w*\s+округ/g, " ")
    .replace(/городской\s+округ/g, " ")
    .replace(/муниципальное\s+образование/g, " ")
    .replace(/город\s+/g, " ")
    .replace(/[^а-яё0-9]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// «Пушкинский г.о.» → «Пушкинский» (для заголовка)
function districtTitle(value) {
  const s = String(value || "").trim();
  if (!s) return "";
  return s
    .replace(/\s*г\s*\.\s*о\s*\.?$/i, "")
    .replace(/\s*городской\s+округ\s*$/i, "")
    .replace(/\s*муниципальный\s+округ\s*$/i, "")
    .trim();
}

// Схлопывает мусорные пробелы/переносы в адресном списке
function cleanAddressList(value) {
  return String(value || "")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function lastCharIsPunct(s) {
  return /[.!?;:]$/.test(s);
}

// ── Плановые ────────────────────────────────────────────────────────────────
// Заголовок/пример — из канала: «В муниципальном округе Истра 5 ноября …».
// Строки: «📍 05.11.2026 (11:00 – 16:00) адрес. Отключение для безопасного проведения работ.»
function buildPressPlannedText(raw = {}) {
  const data = raw.data && typeof raw.data === "object" ? raw.data : {};
  const start = parseDate(raw.createDateTime || data.F81_060_EVENTDATETIME);
  const end = parseDate(raw.repairDateTime || raw.recoveryPlanDateTime || data.REPAIRDATETIME);
  const districtRaw = data.DISTRICT || raw.DISTRICT || "";
  const titleDistrict = districtTitle(districtRaw) || "—";
  const address = cleanAddressList(raw.addressList || data.ADDRESS_LIST);

  const lines = [];
  const titleDate = fmtDayMonthTitle(start);
  lines.push(
    `В муниципальном округе ${titleDistrict}${titleDate ? ` ${titleDate}` : ""} возможны плановые отключения электроэнергии`
  );
  lines.push("");
  lines.push(
    "«Мособлэнерго» информирует о возможных плановых отключениях электроэнергии. На энергообъектах, обслуживаемых компанией, будут проводиться технические работы для повышения надежности электроснабжения потребителей. Для обеспечения безопасного выполнения работ отключение электричества планируется:"
  );
  lines.push("");

  const when = fmtWindow(start, end);
  if (address) {
    lines.push(`📍 ${fmtDmy(start)}${when ? ` (${when})` : ""} ${address}${lastCharIsPunct(address) ? "" : "."} Отключение для безопасного проведения работ.`);
  } else {
    lines.push(`📍 ${fmtDmy(start)}${when ? ` (${when})` : ""}. Отключение для безопасного проведения работ.`);
  }
  lines.push("");
  lines.push("Приносим извинения за доставленные неудобства!");
  lines.push("");
  lines.push(
    "По вопросам отключений и качества электроснабжения просим обращаться на «Горячую линию» АО «Мособлэнерго» по телефону 8(495) 99-500-99."
  );

  return lines.join("\n");
}

// ── Плановые: групповой пост (округ + дата, несколько ТН) ───────────────────
// Заголовок: first_line_shablon из tn-okruga (индивидуальный на округ) + дата + хвост.
// Строка: «📍 DD.MM.YYYY (HH:MM – HH:MM) адрес. причина.» — окно и причина свои у каждой ТН.
function buildPressPlannedGroupText(entries = [], { firstLine, district } = {}) {
  const starts = entries
    .map((e) => e.start)
    .filter(Boolean)
    .sort((a, b) => a - b);
  const titleDate = fmtDayMonthTitle(starts[0]);
  const head =
    String(firstLine || "").trimEnd() ||
    `В муниципальном образовании ${districtTitle(district) || "—"}`;

  const lines = [];
  lines.push(
    `${head}${titleDate ? ` ${titleDate}` : ""} возможны плановые отключения электроснабжения`
  );
  lines.push("");
  lines.push(
    "«Мособлэнерго» информирует о возможных плановых отключениях электроэнергии. На энергообъектах, обслуживаемых компанией, будут проводиться технические работы для повышения надежности электроснабжения потребителей. Для обеспечения безопасного выполнения работ отключение электричества планируется:"
  );
  lines.push("");

  for (const e of entries) {
    const when = fmtWindow(e.start, e.end);
    const address = cleanAddressList(e.address);
    const reason = String(e.reason || "").trim().replace(/\s+/g, " ");
    let line = `📍 ${fmtDmy(e.start)}${when ? ` (${when})` : ""}`;
    if (address) line += ` ${address}${lastCharIsPunct(address) ? "" : "."}`;
    if (reason) line += ` ${reason}${lastCharIsPunct(reason) ? "" : "."}`;
    lines.push(line);
  }

  lines.push("");
  lines.push("Приносим извинения за доставленные неудобства!");
  lines.push("");
  lines.push(
    "По вопросам отключений и качества электроснабжения просим обращаться на «Горячую линию» АО «Мособлэнерго» по телефону 8(495) 99-500-99."
  );

  return lines.join("\n");
}

// ── Внеплановые (аварийные) ────────────────────────────────────────────────
function buildPressEmergencyText(raw = {}) {
  const data = raw.data && typeof raw.data === "object" ? raw.data : {};
  const start = parseDate(raw.createDateTime || data.F81_060_EVENTDATETIME);
  const plan = parseDate(raw.recoveryPlanDateTime || data.REPAIRDATETIME);
  const address = cleanAddressList(raw.addressList || data.ADDRESS_LIST);

  const planValue =
    !plan
      ? "—"
      : fmtDmy(start) === fmtDmy(plan)
        ? fmtHm(plan)
        : `${fmtDmy(plan)} ${fmtHm(plan)}`;

  const lines = [];
  lines.push("Уважаемый потребитель!");
  lines.push("АО «Мособлэнерго» информирует о произошедшем внеплановом отключении электроэнергии");
  lines.push("");
  lines.push(`Дата: ${start ? fmtDmy(start) : "—"}`);
  lines.push(`Время регистрации технологического нарушения: ${start ? fmtHm(start) : "—"}`);
  lines.push(`Адрес: ${address || "—"}`);
  lines.push(`Прогнозируемое время восстановления: ${planValue}`);
  lines.push("");
  lines.push(
    "Мы предпринимаем все необходимые меры для скорейшего восстановления электроснабжения. Для проведения работ направлены оперативно-выездные бригады и необходимая спецтехника."
  );
  lines.push("Приносим извинения за доставленные неудобства!");
  lines.push("С уважением, АО «Мособлэнерго»");

  return lines.join("\n");
}

// ── Разбивка по лимиту MAX (4000 символов; 3900 с запасом) ────────────────
function splitPressText(text, limit = 3900) {
  const src = String(text || "");
  if (src.length <= limit) return [src];

  const lines = src.split("\n");
  const chunks = [];
  let cur = "";

  const pushCur = () => {
    if (cur) chunks.push(cur);
    cur = "";
  };

  for (let line of lines) {
    // гигантская строка (адрес) — жёсткий разрез по словам
    while (line.length > limit) {
      pushCur();
      let cut = line.lastIndexOf(" ", limit);
      if (cut < limit * 0.5) cut = limit;
      chunks.push(line.slice(0, cut));
      line = line.slice(cut).replace(/^\s+/, "");
    }
    const candidate = cur ? `${cur}\n${line}` : line;
    if (candidate.length > limit && cur) {
      pushCur();
      cur = line;
    } else {
      cur = candidate;
    }
  }
  pushCur();
  return chunks.length ? chunks : [src];
}

module.exports = {
  buildPressPlannedText,
  buildPressPlannedGroupText,
  buildPressEmergencyText,
  normalizeDistrictKey,
  districtTitle,
  splitPressText,
  fmtDmy,
  fmtHm,
};
