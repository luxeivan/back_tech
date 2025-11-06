const num = (v) => (Number.isFinite(+v) ? +v : 0);
const s = (v) => (v == null ? "" : String(v).trim());

function dec(n, [one, few, many]) {
  n = Math.abs(Number(n)) % 100;
  const n1 = n % 10;
  if (n > 10 && n < 20) return many;
  if (n1 > 1 && n1 < 5) return few;
  if (n1 === 1) return one;
  return many;
}

const pad2 = (n) => String(n).padStart(2, "0");
function formatRusDateTime(v) {
  if (!v) return "";
  const d = new Date(v);
  if (isNaN(d.getTime())) return s(v);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())} ${pad2(
    d.getDate()
  )}.${pad2(d.getMonth() + 1)}.${d.getFullYear()}`;
}

// Классификация соц. объектов по типу из SocialObjects[].SocialTyp
function classifySocialType(t) {
  const x = String(t || "").toLowerCase();
  if (x.includes("поликлин")) return "polyclinic";
  if (x.includes("больниц")) return "hospital";
  if (x.includes("школ")) return "school";
  if (x.includes("детс") || x.includes("сад")) return "kindergarten";
  if (x.includes("котель")) return "boiler";
  if (x.includes("цтп")) return "ctp";
  if (x.includes("кнс")) return "kns";
  if (x.includes("взу")) return "wells";
  if (x.includes("внс")) return "vns";
  return null;
}

function normalizeNameForGrouping(name) {
  let n = s(name);
  if (!n) return n;
  // Убираем хвосты вида «, ввод 1», «ввод 2», «Ввод № 3»
  n = n.replace(/\s*[,(]?\s*ввод\s*№?\s*\d+\s*$/i, "");
  // Чистим завершающую пунктуацию и лишние пробелы
  n = n.replace(/\s*[.,;:]+$/g, "");
  return n.trim();
}

function collectSocialNames(arr) {
  const buckets = {
    polyclinic: new Set(),
    hospital: new Set(),
    school: new Set(),
    kindergarten: new Set(),
    boiler: new Set(),
    ctp: new Set(),
    kns: new Set(),
    wells: new Set(),
    vns: new Set(),
  };
  (Array.isArray(arr) ? arr : []).forEach((it) => {
    const key = classifySocialType(it?.SocialTyp);
    const base = normalizeNameForGrouping(it?.Name);
    if (key && base) buckets[key].add(base);
  });
  return Object.fromEntries(
    Object.entries(buckets).map(([k, set]) => [k, Array.from(set)])
  );
}

function fmtCountDeclOnly(count, forms) {
  const c = num(count);
  if (!c) return null;
  return `${c} ${dec(c, forms)}`;
}

// Согласования для категорий СЗО (ед., 2-4, 5+)
const SZO_FORMS = {
  polyclinic: ["Поликлиника", "Поликлиники", "Поликлиник"],
  hospital: ["Больница", "Больницы", "Больниц"],
  school: ["Школа", "Школы", "Школ"],
  kindergarten: ["Детский сад", "Детских сада", "Детских садов"],
  boiler: ["Котельная", "Котельные", "Котельных"],
  ctp: ["ЦТП", "ЦТП", "ЦТП"],
  kns: ["КНС", "КНС", "КНС"],
  wells: ["ВЗУ", "ВЗУ", "ВЗУ"],
  vns: ["ВНС", "ВНС", "ВНС"],
};

function formatVoltage(raw) {
  const str = s(raw);
  if (!str) return "";
  // Найдём число (поддержка "6", "6.0", "6,0")
  const m = str.match(/(\d+(?:[.,]\d+)?)/);
  if (m) {
    const n = m[1].replace(",", ".");
    return `${n}кВ`;
  }
  // Если числа нет, но есть упоминание кВ/kv — нормализуем написание
  if (/кв|kv/i.test(str)) {
    return str.replace(/\s+/g, "").replace(/kv/gi, "кВ").replace(/кв/gi, "кВ");
  }
  // Иначе добавим кВ к исходной строке
  return `${str}кВ`;
}

// ===== Core =====
function buildAutoDescription(raw = {}) {
  // 1) Поля по ТЗ заказчика
  const sc = s(raw.SCNAME);
  const when = formatRusDateTime(raw.F81_060_EVENTDATETIME); // "03:54 20.10.2025"
  const enobj = s(raw.F81_041_ENERGOOBJECTNAME);
  const voltText = formatVoltage(s(raw.VOLTAGECLASS)); // пример: "6кВ"
  const switchName = s(raw.SWITCHDISPNAME || raw.SWITCHNAMEKEY || "");
  const ownSc = s(raw.OWN_SCNAME);
  const protect = s(raw.PROTECT_TYPE);

  const tpAll = num(raw.TP_ALL);
  const rpsnAll = num(raw.RPSN_ALL);
  const tpSection = num(raw.TP_SECTION);
  const rpsnSection = num(raw.RPSN_SECTION);

  const mkdAll = num(raw.MKD_ALL);
  const population = num(raw.POPULATION_COUNT);
  const abonents = num(raw.POINTALL || raw.ENOBJ_COUNT); // POINTALL по ТЗ, fallback на ENOBJ_COUNT

  // Соц. объекты: имена из SocialObjects (если есть)
  const names = collectSocialNames(raw.SocialObjects);

  // ПЭС – ожидается, что вызывающий код уже пробросил верхнеуровневые значения
  const pesCount = num(raw.PES_COUNT);
  const pesPower = s(raw.PES_POWER);

  const parts = [];
  const q = (x) => {
    const t = s(x);
    return t ? `${t}` : "";
  };

  parts.push(
    `АО «Мособлэнерго». ${when} ${q(ownSc)} ${q(sc)}. ${q(enobj)} ${q(
      protect
    )} КЛ ${voltText} в направлении ${q(switchName)}.`
      .replace(/\s+/g, " ")
      .replace(/\s\./g, ".")
  );

  parts.push(
    `Без напряжения полностью ${tpAll} ТП, ${rpsnAll} РП, без напряжения по одной секции ${tpSection} ТП, ${rpsnSection} РП (${mkdAll} МКД, ${population} чел., ${abonents} абонентов).`
  );

  const fullCounts = [
    fmtCountDeclOnly(raw.CLINICS_ALL, SZO_FORMS.polyclinic),
    fmtCountDeclOnly(raw.HOSPITALS_ALL, SZO_FORMS.hospital),
    fmtCountDeclOnly(raw.SCHOOLS_ALL, SZO_FORMS.school),
    fmtCountDeclOnly(raw.KINDERGARTENS_ALL, SZO_FORMS.kindergarten),
    fmtCountDeclOnly(raw.BOILER_ALL, SZO_FORMS.boiler),
    fmtCountDeclOnly(raw.CTP_ALL, SZO_FORMS.ctp),
    fmtCountDeclOnly(raw.KNS_ALL, SZO_FORMS.kns),
    fmtCountDeclOnly(raw.WELLS_ALL, SZO_FORMS.wells),
    fmtCountDeclOnly(raw.VNS_ALL, SZO_FORMS.vns),
  ].filter(Boolean);
  const sectCounts = [
    fmtCountDeclOnly(raw.CLINICS_SECTION, SZO_FORMS.polyclinic),
    fmtCountDeclOnly(raw.HOSPITALS_SECTION, SZO_FORMS.hospital),
    fmtCountDeclOnly(raw.SCHOOLS_SECTION, SZO_FORMS.school),
    fmtCountDeclOnly(raw.KINDERGARTENS_SECTION, SZO_FORMS.kindergarten),
    fmtCountDeclOnly(raw.BOILER_SECTION, SZO_FORMS.boiler),
    fmtCountDeclOnly(raw.CTP_SECTION, SZO_FORMS.ctp),
    fmtCountDeclOnly(raw.KNS_SECTION, SZO_FORMS.kns),
    fmtCountDeclOnly(raw.WELLS_SECTION, SZO_FORMS.wells),
    fmtCountDeclOnly(raw.VNS_SECTION, SZO_FORMS.vns),
  ].filter(Boolean);

  if (fullCounts.length) {
    parts.push(`СЗО: полностью без напряжения ${fullCounts.join(", ")}.`);
  }
  if (sectCounts.length) {
    parts.push(`Отключены по одной секции ${sectCounts.join(", ")}.`);
  }

  // --- Списки СЗО по именам, построчно ---
  const sections = [];
  const addSection = (title, arr) => {
    const list = Array.isArray(arr) ? arr.filter(Boolean) : [];
    if (list.length) {
      sections.push(`${title}:\n${list.map((n) => `«${s(n)}»`).join("\n")}`);
    }
  };
  addSection("Поликлиники", names.polyclinic);
  addSection("Больницы", names.hospital);
  addSection("Школы", names.school);
  addSection("Детские сады", names.kindergarten);
  addSection("Котельные", names.boiler);
  addSection("ЦТП", names.ctp);
  addSection("КНС", names.kns);
  addSection("ВЗУ", names.wells);
  addSection("ВНС", names.vns);

  const brigadeCount = num(raw.BRIGADECOUNT);
  const employeeCount = num(raw.EMPLOYEECOUNT);
  const tail = [];
  tail.push(
    `Направлена ${pesCount} ПЭС${pesPower ? ` ${pesPower} кВт` : ""} филиала.`
  );
  if (brigadeCount || employeeCount) {
    tail.push(
      `Задействована ${brigadeCount} ${dec(brigadeCount, [
        "бригада",
        "бригады",
        "бригад",
      ])}, ${employeeCount} ${dec(employeeCount, [
        "человек",
        "человека",
        "человек",
      ])}.`
    );
  }
  tail.push("Прогнозируемое время включения 2 часа.");

  return [
    parts.filter(Boolean).join(" "),
    sections.join("\n\n"),
    tail.join(" "),
  ]
    .filter(Boolean)
    .join("\n\n");
}

module.exports = { buildAutoDescription };
