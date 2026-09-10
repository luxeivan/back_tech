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

  // Форматируем ЖЁСТКО в часовом поясе Москвы, чтобы бэкенд (Node в UTC)
  // и фронт (браузер в локальном TZ) показывали одно и то же время.
  try {
    const fmt = new Intl.DateTimeFormat("ru-RU", {
      timeZone: "Europe/Moscow",
      hour: "2-digit",
      minute: "2-digit",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour12: false,
    });
    const parts = Object.fromEntries(fmt.formatToParts(d).map(p => [p.type, p.value]));
    return `${parts.hour}:${parts.minute} ${parts.day}.${parts.month}.${parts.year}`;
  } catch (_) {
    // Фоллбэк без Intl: Москва фиксированно UTC+3, без перехода на летнее время.
    const msk = new Date(d.getTime() + 3 * 60 * 60 * 1000);
    return `${pad2(msk.getUTCHours())}:${pad2(msk.getUTCMinutes())} ${pad2(msk.getUTCDate())}.${pad2(msk.getUTCMonth() + 1)}.${msk.getUTCFullYear()}`;
  }
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
function formatDateTimeNew(v) {
  if (!v) return "";
  const d = new Date(v);
  if (isNaN(d.getTime())) return s(v);
  try {
    const fmt = new Intl.DateTimeFormat("ru-RU", {
      timeZone: "Europe/Moscow",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const parts = Object.fromEntries(fmt.formatToParts(d).map(p => [p.type, p.value]));
    return `${parts.day}.${parts.month}.${parts.year} ${parts.hour}:${parts.minute}`;
  } catch (_) {
    const msk = new Date(d.getTime() + 3 * 60 * 60 * 1000);
    return `${pad2(msk.getUTCDate())}.${pad2(msk.getUTCMonth() + 1)}.${msk.getUTCFullYear()} ${pad2(msk.getUTCHours())}:${pad2(msk.getUTCMinutes())}`;
  }
}

const SZO_SHORT = {
  polyclinic: "поликл.",
  hospital: "больниц.",
  school: "школа",
  kindergarten: "дет.сад",
  boiler: "котельная",
  ctp: "ЦТП",
  kns: "КНС",
  wells: "ВЗУ",
  vns: "ВНС",
};

function buildSzoSummaryNew(raw) {
  const full = [];
  const sect = [];
  let fullTotal = 0;
  let sectTotal = 0;
  const pushType = (arr, key, countRaw, addCount) => {
    const c = num(countRaw);
    if (!c) return;
    const short = SZO_SHORT[key];
    arr.push(c === 1 ? short : `${short} (${c})`);
    addCount(c);
  };
  pushType(full, "polyclinic", raw.CLINICS_ALL, (c) => { fullTotal += c; });
  pushType(full, "hospital", raw.HOSPITALS_ALL, (c) => { fullTotal += c; });
  pushType(full, "school", raw.SCHOOLS_ALL, (c) => { fullTotal += c; });
  pushType(full, "kindergarten", raw.KINDERGARTENS_ALL, (c) => { fullTotal += c; });
  pushType(full, "boiler", raw.BOILER_ALL, (c) => { fullTotal += c; });
  pushType(full, "ctp", raw.CTP_ALL, (c) => { fullTotal += c; });
  pushType(full, "kns", raw.KNS_ALL, (c) => { fullTotal += c; });
  pushType(full, "wells", raw.WELLS_ALL, (c) => { fullTotal += c; });
  pushType(full, "vns", raw.VNS_ALL, (c) => { fullTotal += c; });
  pushType(sect, "polyclinic", raw.CLINICS_SECTION, (c) => { sectTotal += c; });
  pushType(sect, "hospital", raw.HOSPITALS_SECTION, (c) => { sectTotal += c; });
  pushType(sect, "school", raw.SCHOOLS_SECTION, (c) => { sectTotal += c; });
  pushType(sect, "kindergarten", raw.KINDERGARTENS_SECTION, (c) => { sectTotal += c; });
  pushType(sect, "boiler", raw.BOILER_SECTION, (c) => { sectTotal += c; });
  pushType(sect, "ctp", raw.CTP_SECTION, (c) => { sectTotal += c; });
  pushType(sect, "kns", raw.KNS_SECTION, (c) => { sectTotal += c; });
  pushType(sect, "wells", raw.WELLS_SECTION, (c) => { sectTotal += c; });
  pushType(sect, "vns", raw.VNS_SECTION, (c) => { sectTotal += c; });
  const fullStr = fullTotal ? `${fullTotal} (${full.join(", ")})` : "0";
  const sectStr = sectTotal ? `${sectTotal} (${sect.join(", ")})` : "0";
  return { fullStr, sectStr };
}

function tpRpTotalNew(raw) {
  return num(raw.TP_ALL) + num(raw.RPSN_ALL);
}

function tpRpSectionTotalNew(raw) {
  return num(raw.TP_SECTION) + num(raw.RPSN_SECTION);
}

function stripHousesAndSzo(addressList) {
  return addressList
    .split(";")
    .map((item) => {
      let t = item.trim();
      if (!t) return "";
      t = t.replace(/,?\s*д\.?\s*[\d].*$/i, "");
      t = t.replace(/,?\s*дом\.?\s*[\d].*$/i, "");
      t = t.replace(/,\s*$/, "").trim();
      return t;
    })
    .filter((t) => {
      if (!t) return false;
      const hasStreet = /(ул\.|улица|пер\.|переулок|ш\.|шоссе|б-р|бульвар|пр\.|проспект|км|мкр|г\.|город)/i.test(t);
      if (!hasStreet) {
        const looksLikeOrg = /("|«|»|МУП|ООО|ОАО|АО|ПАО|УП|ФГБУ|ГБУ|МБУ|МКУ|ФКР)/i.test(t);
        if (looksLikeOrg) return false;
      }
      return true;
    })
    .join("; ");
}

function buildAutoDescription(raw = {}) {
  const sc = s(raw.SC_PO);
  const when = formatDateTimeNew(raw.F81_060_EVENTDATETIME);
  const ownSc = s(raw.SC_FILIAL);
  const enobj = s(raw.F81_041_ENERGOOBJECTNAME);
  const voltRaw = s(raw.VOLTAGECLASS);
  const voltText = formatVoltage(voltRaw);
  const switchName = s(raw.SWITCHDISPNAME || raw.SWITCHNAMEKEY || "");
  const protect = s(raw.PROTECT_TYPE);

  const q = (x) => {
    const t = s(x);
    return t ? `${t}` : "";
  };

  const header = [
    `АО «Мособлэнерго»`,
    `${when} ${q(ownSc)} ${q(sc)}.`,
    `${q(enobj)} ${q(protect)} КЛ ${voltText} в направлении ${q(switchName)}.`,
  ]
    .join("\n")
    .replace(/\s+/g, " ")
    .replace(/\s\./g, ".");

  const tpRpFull = tpRpTotalNew(raw);
  const tpRpSect = tpRpSectionTotalNew(raw);
  const mkdAll = num(raw.MKD_ALL);
  const population = num(raw.POPULATION_COUNT);
  const abonents = num(raw.POINTALL || raw.ENOBJ_COUNT);

  const { fullStr, sectStr } = buildSzoSummaryNew(raw);

  const outageLines = [
    "Без напряжения:",
    `ТП, РП полностью: ${tpRpFull}`,
    `ТП, РП по одной секции: ${tpRpSect}`,
    `МКД: ${mkdAll}`,
    `Чел: ${population}`,
    `Абонентов: ${abonents}`,
    `СЗО полностью: ${fullStr}`,
    sectStr !== "0" ? `СЗО по одной секции: ${sectStr}` : null,
  ].filter(Boolean);

  const addressList = s(raw.ADDRESS_LIST);
  if (addressList) {
    const streetsOnly = stripHousesAndSzo(addressList);
    if (streetsOnly) {
      outageLines.push(`Адреса отключенных объектов: ${streetsOnly}`);
    }
  }

  const pesCount = num(raw.PES_COUNT);
  const pesPower = s(raw.PES_POWER);
  const brigadeCount = num(raw.BRIGADECOUNT);
  const employeeCount = num(raw.EMPLOYEECOUNT);

  const pesLine = pesCount
    ? `Направлено ПЭС: да (${pesCount} шт., ${pesPower ? `${pesPower} кВт` : "мощность не указана"})`
    : "Направлено ПЭС: нет";

  const brigadeLine =
    brigadeCount || employeeCount
      ? `Задействовано: ${brigadeCount} ${dec(brigadeCount, ["бригада", "бригады", "бригад"])}, ${employeeCount} ${dec(employeeCount, ["человек", "человека", "человек"])}.`
      : "Задействовано: —";

  const tail = [pesLine, brigadeLine].join("\n");

  return [header, outageLines.join("\n"), tail].filter(Boolean).join("\n\n");
}

module.exports = { buildAutoDescription };
