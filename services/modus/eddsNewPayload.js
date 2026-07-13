const { DISTRICT_MAP, toDateEDDS } = require("./eddsPayload");

const DISTRICT_FIAS_MAP = {
  "Балашиха г.о.": "213a1aca-5c9e-4b94-a4e0-c5333882cba0",
  "Богородский г.о.": "d1954143-4569-4938-b06a-2c51d07b8fe3",
  "Бронницы г.о.": "292ca80f-50ec-4160-b7c8-adeb53774645",
  "Власиха г.о.": "bc6c3bd3-95b9-4258-9726-089a9d207f13",
  "Волоколамский г.о.": "5a5f9a40-b6a3-4ad8-af28-aff545e17b84",
  "Воскресенск г.о.": "28ae170a-f54c-4ec4-8fcc-920f20871ea3",
  "Восход г.о.": "93c36278-3ece-468d-a74f-5a77f8a1b863",
  "Дзержинский г.о.": "646f3a1d-1087-454a-a412-c7c9831d67d0",
  "Дмитровский г.о.": "07044206-f77f-4bbf-83b9-ce4f0432eaea",
  "Долгопрудный г.о.": "79ba1e00-2b3f-466d-88db-50deeb27c4c9",
  "Домодедово г.о.": "af2085e0-ca38-4a98-9bec-e43b7057ba6c",
  "Дубна г.о.": "819d73c8-9375-4e39-8853-ddf003b42217",
  "Егорьевск г.о.": "d8737d58-293f-4d6b-9d37-b1d588c04eaa",
  "Жуковский г.о.": "f205bd3d-c738-4743-be7e-4a21084cb22f",
  "Зарайск г.о.": "2d5657bb-0069-492f-bf7e-f521b14cddb1",
  "Звездный городок г.о.": "4613a114-016a-4b72-9a9c-57a6961e1971",
  "Истра г.о.": "42d90380-b3b2-42d3-bae2-3d3652a2e50d",
  "Кашира г.о.": "3e5c43e5-95ec-4faf-9b4d-8612e6003a52",
  "Клин г.о.": "d3757aca-5857-47ed-9566-5adc2b57afac",
  "Коломна г.о.": "6e68c7e7-10ab-4965-aada-478aeae821db",
  "Королёв г.о.": "9d737e81-e677-43cb-83d2-4e11e5e5dc2c",
  "Королев г.о.": "9d737e81-e677-43cb-83d2-4e11e5e5dc2c",
  "Котельники г.о.": "5277759e-be05-4a2d-ba89-d8478add5a0c",
  "Красногорск г.о.": "d55b49ba-475a-4141-b11f-9cb3f29e2205",
  "Краснознаменск г.о.": "d34042a0-5440-40c5-8bc7-09383bd38cab",
  "Ленинский г.о.": "c2c325fc-435f-4ab7-88fc-d632f6b33c87",
  "Лобня г.о.": "36b29bf3-2a90-4c6c-9bc2-8dc59e890ef3",
  "Лосино-Петровский г.о.": "9132b305-951c-423e-9bba-0b29d23fddd6",
  "Лотошино г.о.": "b6515ab8-66eb-4f6d-8b9d-3667b287004d",
  "Луховицы г.о.": "044de8a0-d790-49b3-a3e3-7ee7ea56e79c",
  "Лыткарино г.о.": "462cc323-d81e-4564-9dc8-ee30f9a46b0a",
  "Люберцы г.о.": "2e1b7a2a-55de-42be-aacf-6c625cad5ff5",
  "Можайский г.о.": "d75a3e6e-3d43-4404-97d7-a0bb0ad01459",
  "Молодёжный г.о.": "f602fcc3-8b8b-4a03-b215-4aab8ca4e390",
  "Молодежный г.о.": "f602fcc3-8b8b-4a03-b215-4aab8ca4e390",
  "Москва": "0c5b2444-70a0-4932-980c-b4dc0d3f02b5",
  "Мытищи г.о.": "aa29f2e6-5d7d-4e7b-b062-56c4fe0f39fe",
  "Наро-Фоминский г.о.": "0d5fdd1b-a7fa-452e-bde7-6f752016d67b",
  "Одинцовский г.о.": "b4d06790-77eb-44d8-8cfd-035404fb2fb7",
  "Орехово-Зуевский г.о.": "57e6e3c2-486a-4265-afc6-af1c2d6729dc",
  "Павлово-Посадский г.о.": "560e4d42-b5a8-4b34-9462-e8d4f048c964",
  "Подольск г.о.": "26149e92-3a76-4bba-b332-1facc35f9311",
  "Пушкинский г.о.": "113003b5-dae9-46de-99cf-28eb47763625",
  "Раменский г.о.": "d77fcba7-6fd9-4e15-a70f-dba0e96a116e",
  "Реутов г.о.": "98b2ade5-8a1b-4a98-b569-6aeefcb2ab8e",
  "Рузский г.о.": "26580099-b45e-4834-b085-527485d692b7",
  "Сергиево-Посадский г.о.": "ed7da874-3df1-4f99-a1f4-302a27be0d95",
  "Серебряные Пруды г.о.": "5f07f4b6-9b3b-45f2-937f-92a39ffd3128",
  "Серпухов г.о.": "ef67af07-1d09-4924-a7e4-f2429428b581",
  "Солнечногорск г.о.": "885695b8-1384-4c12-990e-1a2961a337b2",
  "Ступино г.о.": "ec488b61-384c-48ff-a78d-117bc22c9674",
  "Талдомский г.о.": "70ce2cc9-ded3-492a-9bda-a26dceb3bcd2",
  "Фрязино г.о.": "a5845777-83fb-4cf0-bf14-6f24d900b389",
  "Химки г.о.": "cd03d381-6681-4970-8d7a-f77b2bf108fa",
  "Черноголовка г.о.": "d9b693fc-2211-424c-b570-d4a9f3c8d709",
  "Чехов г.о.": "d000a228-e8ec-4e5f-8903-98a209c78d68",
  "Шатура г.о.": "ef438532-11fe-459f-99b4-873b7f216125",
  "Шаховская г.о.": "36087d43-b081-40fc-855c-8d65681d5cef",
  "Щербинка г.о.": "89184dde-a93f-40ae-b6d5-8645833bddb3",
  "Щёлково г.о.": "277e8ad7-99a4-498a-8385-6f94c1dcac28",
  "Щелково г.о.": "277e8ad7-99a4-498a-8385-6f94c1dcac28",
  "Электросталь г.о.": "b433362d-7f0c-48dd-91ae-2af6aed54879",
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

const EDDS_TO_MODUS_FIELD_MAP = {
  externalId: "VIOLATION_GUID_STR",
  planDateClose: "F81_070_RESTOR_SUPPLAYDATETIME / recoveryPlanDateTime",
  districtFiasIds: "DISTRICT / SCNAME",
  equipmentType: "OBJECTTYPE81 / VOLTAGECLASS / SWITCHTYPE",
  equipmentName: "F81_041_ENERGOOBJECTNAME",
  "shutdownInfo.shutdownType": "VIOLATION_TYPE (А/В/П)",
  "shutdownInfo.disabledAt": "F81_060_EVENTDATETIME / STARTDATETIME",
  "shutdownInfo.plannedInclusionAt": "F81_070_RESTOR_SUPPLAYDATETIME",
  "shutdownInfo.fiasIds": "FIAS_LIST",
  "affectedObjectsCount.peopleCount": "POPULATION_COUNT",
  "affectedObjectsCount.placesCount": "SETTLEMENT_COUNT",
  "comment.text": "SCNAME + F81_042_DISPNAME + другие поля",
  plan_date_close: "F81_070_RESTOR_SUPPLAYDATETIME / recoveryPlanDateTime",
  time_create: "F81_060_EVENTDATETIME",
  count_people: "POPULATION_COUNT",
  district_id: "DISTRICT / SCNAME",
};

function mapEddsValidationErrors(eddsErrors, payload) {
  if (!Array.isArray(eddsErrors) || !eddsErrors.length) return [];
  return eddsErrors.map(err => {
    const field = err?.field || err?.path || err?.message || String(err);
    const modusSource = EDDS_TO_MODUS_FIELD_MAP[field] || "(источник не определён)";
    const value = field.split('.').reduce((o, k) => o?.[k], payload);
    return `${field} → Модус: ${modusSource} = ${JSON.stringify(value ?? null)}`;
  });
}

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
    if (normalizeDistrict(name) === normalized) {
      console.log(`  🗺️  DISTRICT маппинг: "${districtSource}" → "${name}" → ${fias}`);
      return fias;
    }
  }
  console.log(`  🗺️  DISTRICT маппинг: "${districtSource}" → НЕ НАЙДЕН`);
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

  const externalId = clean(raw?.VIOLATION_GUID_STR);
  if (!externalId) {
    errors.push("Не заполнено обязательное поле externalId (VIOLATION_GUID_STR).");
  }

  const districtSource = clean(raw?.DISTRICT || raw?.SCNAME || mapped?.district || mapped?.dispCenter);
  const districtFiasId = mapDistrictFias(districtSource);
  if (!districtFiasId) {
    errors.push(`Не найден маппинг districtFiasIds для DISTRICT="${districtSource || "пусто"}".`);
  }
  // console.log(`  📋 districtFiasIds[0] = "${districtFiasId}" (из DISTRICT="${districtSource}")`);
  // console.log(`  📋 externalId = "${externalId}"`);

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
  if (!fiasIds.length && districtFiasId) {
    console.log(`[EDDS] FIAS_LIST пустой, fallback на districtFiasId: ${districtFiasId}`);
    fiasIds.push(districtFiasId);
  }
  if (!fiasIds.length) {
    console.warn("[EDDS] shutdownInfo.fiasIds пустой — EDDS отклонит если обязательно");
  }

  const disabledAt = toIso(raw?.F81_060_EVENTDATETIME || mapped?.createDateTime || raw?.STARTDATETIME);
  if (!disabledAt) {
    console.warn("[EDDS] shutdownInfo.disabledAt пустой — EDDS отклонит если обязательно");
  }

  const plannedInclusionAt = toIso(raw?.F81_070_RESTOR_SUPPLAYDATETIME || mapped?.recoveryPlanDateTime);
  if (!plannedInclusionAt) {
    console.warn("[EDDS] shutdownInfo.plannedInclusionAt пустой — EDDS отклонит если обязательно");
  }

  const planDateClose = toDateEDDS(raw?.F81_070_RESTOR_SUPPLAYDATETIME || mapped?.recoveryPlanDateTime, true);

  const peopleCount = toInt(raw?.POPULATION_COUNT);
  const placesCount = toInt(raw?.SETTLEMENT_COUNT);
  const commentText = buildCommentText(raw);

  if (errors.length > 0) {
    return { payload: null, errors };
  }

  const payload = {
    externalId,
    // planDateClose,
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
      deenergizedObjectsInfo: "заглушка",
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

module.exports = { buildEddsNewPayload, mapEddsValidationErrors, EDDS_TO_MODUS_FIELD_MAP };
