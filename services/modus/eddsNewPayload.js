const { DISTRICT_MAP } = require("./eddsPayload");

const DISTRICT_FIAS_MAP = {
  "Балашиха г.о.": "213a1aca-3270-4800-83b4-6572932f5b9b",
  "Богородский г.о.": "a8d3e5c1-4b2e-4f6a-9c8d-1e2f3a4b5c6d",
  "Бронницы г.о.": "b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e",
  "Волоколамск г.о.": "c2d3e4f5-a6b7-4c8d-9e0f-1a2b3c4d5e6f",
  "Воскресенск г.о.": "d3e4f5a6-b7c8-4d9e-0f1a-2b3c4d5e6f7a",
  "Дзержинский г.о.": "e4f5a6b7-c8d9-4e0f-1a2b-3c4d5e6f7a8b",
  "Дмитровский г.о.": "f5a6b7c8-d9e0-4f1a-2b3c-4d5e6f7a8b9c",
  "Долгопрудный г.о.": "a6b7c8d9-e0f1-4a2b-3c4d-5e6f7a8b9c0d",
  "Домодедово г.о.": "b7c8d9e0-f1a2-4b3c-4d5e-6f7a8b9c0d1e",
  "Дубна г.о.": "c8d9e0f1-a2b3-4c4d-5e6f-7a8b9c0d1e2f",
  "Егорьевск г.о.": "d9e0f1a2-b3c4-4d5e-6f7a-8b9c0d1e2f3a",
  "Жуковский г.о.": "e0f1a2b3-c4d5-4e6f-7a8b-9c0d1e2f3a4b",
  "Зарайск г.о.": "f1a2b3c4-d5e6-4f7a-8b9c-0d1e2f3a4b5c",
  "Истра г.о.": "42d90380-e8a1-4c5b-b6d2-7f3e8a1b4c5d",
  "Кашира г.о.": "a2b3c4d5-e6f7-4a8b-9c0d-1e2f3a4b5c6d",
  "Клин г.о.": "b3c4d5e6-f7a8-4b9c-0d1e-2f3a4b5c6d7e",
  "Коломна г.о.": "c4d5e6f7-a8b9-4c0d-1e2f-3a4b5c6d7e8f",
  "Королев г.о.": "d5e6f7a8-b9c0-4d1e-2f3a-4b5c6d7e8f9a",
  "Красногорск г.о.": "e6f7a8b9-c0d1-4e2f-3a4b-5c6d7e8f9a0b",
  "Ленинский г.о.": "f7a8b9c0-d1e2-4f3a-4b5c-6d7e8f9a0b1c",
  "Лобня г.о.": "a8b9c0d1-e2f3-4a4b-5c6d-7e8f9a0b1c2d",
  "Луховицы г.о.": "b9c0d1e2-f3a4-4b5c-6d7e-8f9a0b1c2d3e",
  "Лыткарино г.о.": "c0d1e2f3-a4b5-4c6d-7e8f-9a0b1c2d3e4f",
  "Люберцы г.о.": "d1e2f3a4-b5c6-4d7e-8f9a-0b1c2d3e4f5a",
  "Можайский г.о.": "e2f3a4b5-c6d7-4e8f-9a0b-1c2d3e4f5a6b",
  "Мытищи г.о.": "f3a4b5c6-d7e8-4f9a-0b1c-2d3e4f5a6b7c",
  "Наро-Фоминский г.о.": "a4b5c6d7-e8f9-4a0b-1c2d-3e4f5a6b7c8d",
  "Одинцовский г.о.": "b5c6d7e8-f9a0-4b1c-2d3e-4f5a6b7c8d9e",
  "Орехово-Зуевский г.о.": "c6d7e8f9-a0b1-4c2d-3e4f-5a6b7c8d9e0f",
  "Павлово-Посадский г.о.": "d7e8f9a0-b1c2-4d3e-4f5a-6b7c8d9e0f1a",
  "Подольск г.о.": "26149e92-3a1b-4c5d-a6e7-f8b9c0d1e2f3",
  "Протвино г.о.": "e8f9a0b1-c2d3-4e4f-5a6b-7c8d9e0f1a2b",
  "Пушкинский г.о.": "f9a0b1c2-d3e4-4f5a-6b7c-8d9e0f1a2b3c",
  "Раменский г.о.": "a0b1c2d3-e4f5-4a6b-7c8d-9e0f1a2b3c4d",
  "Реутов г.о.": "b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e",
  "Рузский г.о.": "c2d3e4f5-a6b7-4c8d-9e0f-1a2b3c4d5e6f",
  "Сергиево-Посадский г.о.": "d3e4f5a6-b7c8-4d9e-0f1a-2b3c4d5e6f7a",
  "Серебряные Пруды г.о.": "e4f5a6b7-c8d9-4e0f-1a2b-3c4d5e6f7a8b",
  "Серпухов г.о.": "f5a6b7c8-d9e0-4f1a-2b3c-4d5e6f7a8b9c",
  "Солнечногорск г.о.": "a6b7c8d9-e0f1-4a2b-3c4d-5e6f7a8b9c0d",
  "Ступино г.о.": "b7c8d9e0-f1a2-4b3c-4d5e-6f7a8b9c0d1e",
  "Талдомский г.о.": "c8d9e0f1-a2b3-4c4d-5e6f-7a8b9c0d1e2f",
  "Фрязино г.о.": "d9e0f1a2-b3c4-4d5e-6f7a-8b9c0d1e2f3a",
  "Химки г.о.": "e0f1a2b3-c4d5-4e6f-7a8b-9c0d1e2f3a4b",
  "Чехов г.о.": "f1a2b3c4-d5e6-4f7a-8b9c-0d1e2f3a4b5c",
  "Шатура г.о.": "a2b3c4d5-e6f7-4a8b-9c0d-1e2f3a4b5c6d",
  "Шаховская г.о.": "b3c4d5e6-f7a8-4b9c-0d1e-2f3a4b5c6d7e",
  "Щелково г.о.": "c4d5e6f7-a8b9-4c0d-1e2f-3a4b5c6d7e8f",
  "Электросталь г.о.": "d5e6f7a8-b9c0-4d1e-2f3a-4b5c6d7e8f9a",
};

const SHUTDOWN_TYPE_MAP = {
  "А": "emergency",
  "В": "unplanned",
  "П": "planned",
};

const HARDCODED_EQUIPMENT_TYPE_RULES = [
  { source: "пс 110", target: "ps_110kv" },
  { source: "пс 100", target: "ps_110kv" },
  { source: "пс 35", target: "ps_35kv" },
  { source: "рп 10", target: "rp_10kv" },
  { source: "рп 6", target: "rp_6_20kv" },
  { source: "тп 0,4", target: "tp_0_4kv" },
  { source: "тп 0.4", target: "tp_0_4kv" },
  { source: "тп 6", target: "tp_6_20kv" },
  { source: "тп 10", target: "tp_6_20kv" },
  { source: "тп 20", target: "tp_6_20kv" },
  { source: "вл 110", target: "vl_110kv" },
  { source: "вл 35", target: "vl_35kv" },
  { source: "вл 0,4", target: "vl_0_4kv" },
  { source: "вл 0.4", target: "vl_0_4kv" },
  { source: "вл 6", target: "vl_6_20kv" },
  { source: "вл 10", target: "vl_6_20kv" },
  { source: "вл 20", target: "vl_6_20kv" },
  { source: "кл 100", target: "kl_100kv" },
  { source: "кл 110", target: "kl_100kv" },
  { source: "кл 35", target: "kl_35kv" },
  { source: "кл 0,4", target: "kl_0_4kv" },
  { source: "кл 0.4", target: "kl_0_4kv" },
  { source: "кл 6", target: "kl_6_20kv" },
  { source: "кл 10", target: "kl_6_20kv" },
  { source: "кл 20", target: "kl_6_20kv" },
  { source: "квл 110", target: "kvl_110kv" },
  { source: "квл 35", target: "kvl_35kv" },
  { source: "квл 0,4", target: "kvl_0_4kv" },
  { source: "квл 0.4", target: "kvl_0_4kv" },
  { source: "квл 6", target: "kvl_6_20kv" },
  { source: "квл 10", target: "kvl_6_20kv" },
  { source: "квл 20", target: "kvl_6_20kv" },
];

const HARDCODED_EQUIPMENT_KEYWORDS = [
  { keywords: ["рп"], target: "rp_10kv" },
  { keywords: ["тп"], target: "tp_6_20kv" },
  { keywords: ["пс"], target: "ps_110kv" },
  { keywords: ["вл"], target: "vl_6_20kv" },
  { keywords: ["кл"], target: "kl_6_20kv" },
  { keywords: ["квл"], target: "kvl_6_20kv" },
];

const HARDCODED_REASON_RULES = [
  { source: "направлена бригада", target: "safety_outage" },
  { source: "бригада", target: "safety_outage" },
];

function clean(v) {
  if (v === undefined || v === null) return "";
  return String(v).trim();
}

function normalizeText(v) {
  return clean(v)
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[«»"']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeDistrict(v) {
  return normalizeText(v)
    .replace(/\(.*?\)/g, " ")
    .replace(/г\s*\.?\s*о\s*\.?/g, " ")
    .replace(/м\s*\.?\s*о\s*\.?/g, " ")
    .replace(/городск(ой|ого)?\s+округ/g, " ")
    .replace(/муниципальн(ый|ого)?\s+округ/g, " ")
    .replace(/зато/g, " ")
    .replace(/[.,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toInt(v, fallback = 0) {
  if (v === undefined || v === null || v === "") return fallback;
  const n = Number(String(v).replace(",", "."));
  if (Number.isFinite(n)) return Math.trunc(n);
  const digits = String(v).match(/\d+/);
  return digits ? Number(digits[0]) : fallback;
}

function toIso(v) {
  if (!v) return null;
  const d = new Date(v);
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}

function formatMskDateTime(v) {
  if (!v) return null;
  const d = new Date(v);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleString("ru-RU", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function parseFiasList(v) {
  const raw = clean(v);
  if (!raw) return [];
  return Array.from(
    new Set(
      raw
        .split(/[;,]+/)
        .map((item) => item.trim())
        .filter(Boolean)
    )
  );
}

function firstAddress(v) {
  const raw = clean(v);
  if (!raw) return "адрес не указан";
  const first = raw
    .split(";")
    .map((item) => item.trim())
    .find(Boolean);
  return first || "адрес не указан";
}

function mapDistrictFias(districtSource) {
  const normalized = normalizeDistrict(districtSource);
  for (const [name, fias] of Object.entries(DISTRICT_FIAS_MAP)) {
    if (normalizeDistrict(name) === normalized) return fias;
  }
  return "";
}

function mapEquipmentType(raw) {
  const objectType = clean(raw?.OBJECTTYPE81);
  const switchType = clean(raw?.SWITCHTYPE);
  const objectNameKey = clean(raw?.OBJECTNAMEKEY);
  const voltage = clean(raw?.VOLTAGECLASS);
  const dispName = clean(raw?.F81_042_DISPNAME);
  const all = [objectType, switchType, objectNameKey, voltage, dispName]
    .filter(Boolean)
    .join(" ");

  const candidates = [
    `${objectType} ${voltage}`.trim(),
    `${switchType} ${voltage}`.trim(),
    objectType,
    switchType,
    voltage,
    objectNameKey,
    dispName,
    all,
  ].filter(Boolean);

  for (const candidate of candidates) {
    const normalized = normalizeText(candidate);
    for (const hr of HARDCODED_EQUIPMENT_TYPE_RULES) {
      if (normalized.includes(hr.source)) return hr.target;
    }
  }

  for (const candidate of candidates) {
    const normalized = normalizeText(candidate);
    for (const kw of HARDCODED_EQUIPMENT_KEYWORDS) {
      if (kw.keywords.some((k) => normalized.includes(k))) return kw.target;
    }
  }

  return "";
}

function mapReasons(brigadeAction) {
  const source = clean(brigadeAction);
  if (!source) return ["safety_outage"];

  const normalized = normalizeText(source);
  for (const hr of HARDCODED_REASON_RULES) {
    if (normalized.includes(hr.source)) return [hr.target];
  }

  return ["safety_outage"];
}

function buildCommentText(raw) {
  const scName = clean(raw?.SCNAME) || "Не указано";
  const startAt =
    formatMskDateTime(raw?.STARTDATETIME || raw?.F81_060_EVENTDATETIME) ||
    "дата не указана";
  const planAt =
    formatMskDateTime(raw?.F81_070_RESTOR_SUPPLAYDATETIME) ||
    "дата не указана";
  const workDescription =
    clean(raw?.F81_042_DISPNAME) || "Описание работ не указано";

  const tpAll = toInt(raw?.TP_ALL);
  const subscribers = toInt(raw?.ENOBJ_COUNT);
  const peopleCount = toInt(raw?.POPULATION_COUNT);
  const pointsCount = toInt(raw?.POINTALL);
  const settlementsCount = toInt(raw?.SETTLEMENT_COUNT);
  const address = firstAddress(raw?.ADDRESS_LIST);
  const mkdAll = toInt(raw?.MKD_ALL);

  const boiler = toInt(raw?.BOILER_ALL);
  const ctp = toInt(raw?.CTP_ALL);
  const hospitals = toInt(raw?.HOSPITALS_ALL);
  const clinics = toInt(raw?.CLINICS_ALL);
  const wells = toInt(raw?.WELLS_ALL);
  const vns = toInt(raw?.VNS_ALL);
  const schools = toInt(raw?.SCHOOLS_ALL);
  const kindergartens = toInt(raw?.KINDERGARTENS_ALL);
  const kns = toInt(raw?.KNS_ALL);

  const szoSum =
    boiler + ctp + hospitals + clinics + wells + vns + schools + kindergartens + kns;
  const szoText =
    szoSum > 0
      ? `да (в том числе : котельных – ${boiler}, ЦТП – ${ctp}, больницы – ${hospitals}, поликлиники – ${clinics}, ВЗУ – ${wells}, ВНС – ${vns}, школы – ${schools}, д/с – ${kindergartens}, КНС – ${kns})`
      : "нет";

  const brigadeCount = toInt(raw?.BRIGADECOUNT);
  const employeeCount = toInt(raw?.EMPLOYEECOUNT);
  const equipmentCount = toInt(raw?.SPECIALTECHNIQUECOUNT);
  const brigadeAction = clean(raw?.BRIGADE_ACTION) || "не указано";
  const createUser = clean(raw?.CREATE_USER) || "не указан";
  const lostPower = clean(raw?.F81_220_LOSTPOWER) || "0";

  return (
    `${scName}. ${startAt} (МСК). ${workDescription}. ` +
    `Обесточенные потребители: ${tpAll} ТП (${subscribers} аб.), ${peopleCount} чел, ` +
    `Точки поставки - ${pointsCount} шт., ${settlementsCount} НП (${address}). ` +
    `МКЖД - ${mkdAll}. СЗО – ${szoText}. ` +
    `Отключенная нагрузка - ${lostPower} МВт. ` +
    `Предполагаемое время подачи напряжения: ${planAt} (МСК). ` +
    `Задействовано: ${brigadeCount} бр., ${employeeCount} чел., ${equipmentCount} ед. спец. техники. ` +
    `Наименование работ: ${brigadeAction}. ${createUser}`
  );
}

function buildEddsNewPayload(item) {
  // item = { data: mappedItem } from modus.js
  // mappedItem = { guid, number, ..., data: rawModusData }
  const mapped = item?.data || item;
  const raw = mapped?.data || mapped;
  if (!raw) return null;

  const errors = [];

  const violationType = clean(raw?.VIOLATION_TYPE || mapped?.VIOLATION_TYPE).toUpperCase();
  const shutdownType = SHUTDOWN_TYPE_MAP[violationType];
  if (!shutdownType) {
    errors.push(`Неизвестный VIOLATION_TYPE="${violationType || "пусто"}". Допустимо: А, В, П.`);
  }

  const districtSource = clean(raw?.DISTRICT || raw?.SCNAME || mapped?.district || mapped?.dispCenter);
  const districtFiasId = mapDistrictFias(districtSource);
  if (!districtFiasId) {
    errors.push(`Не найден маппинг districtFiasIds для DISTRICT="${districtSource || "пусто"}".`);
  }

  const equipmentName = clean(raw?.F81_041_ENERGOOBJECTNAME);
  if (!equipmentName) {
    errors.push("Не заполнено обязательное поле equipmentName (F81_041_ENERGOOBJECTNAME).");
  }

  const equipmentType = mapEquipmentType(raw);
  if (!equipmentType) {
    errors.push("Не найден маппинг equipmentType по OBJECTTYPE81/VOLTAGECLASS.");
  }

  const reasons = mapReasons(raw?.BRIGADE_ACTION);

  const fiasIds = parseFiasList(raw?.FIAS_LIST);
  if (!fiasIds.length) {
    errors.push("Не заполнено shutdownInfo.fiasIds (ожидается FIAS_LIST).");
  }

  const disabledAt = toIso(raw?.F81_060_EVENTDATETIME || mapped?.createDateTime || raw?.STARTDATETIME);
  if (!disabledAt) {
    errors.push("Не удалось определить shutdownInfo.disabledAt (F81_060_EVENTDATETIME).");
  }

  const plannedInclusionAt = toIso(raw?.F81_070_RESTOR_SUPPLAYDATETIME || mapped?.recoveryPlanDateTime);
  if (!plannedInclusionAt) {
    errors.push("Не удалось определить shutdownInfo.plannedInclusionAt (F81_070_RESTOR_SUPPLAYDATETIME).");
  }

  const peopleCount = toInt(raw?.POPULATION_COUNT);
  const placesCount = toInt(raw?.SETTLEMENT_COUNT);
  const commentText = buildCommentText(raw);

  if (errors.length > 0) {
    return { payload: null, errors };
  }

  const payload = {
    districtFiasIds: [districtFiasId],
    equipmentType,
    equipmentName,
    recoveryWorkInfo: {
      workContactName: "Оперативный дежурный САЦ",
      workContactPhone: "+74957803976",
      needExternalCrew: false,
    },
    shutdownInfo: {
      shutdownType,
      deenergizedType: "staff",
      disabledAt,
      plannedInclusionAt,
      reasons,
      fiasIds,
    },
    affectedObjectsCount: {
      peopleCount,
      placesCount,
    },
    comment: {
      text: commentText,
    },
  };

  return { payload, errors: [] };
}

module.exports = { buildEddsNewPayload };
