// Вынесено из routers/modus.js: сборка payload в ЕДДС и маппинги.

const DISTRICT_MAP = {
  "Балашиха г.о.": "4",
  "Богородский г.о.": "81",
  "Бронницы г.о.": "5",
  "Власиха (ЗАТО) г.о.": "84",
  "Волоколамск г.о.": "6",
  "Воскресенск г.о.": "7",
  "Восход (ЗАТО) г.о.": "85",
  "Дзержинский г.о.": "16",
  "Дмитровский г.о.": "17",
  "Долгопрудный г.о.": "18",
  "Домодедово г.о.": "19",
  "Дубна г.о.": "20",
  "Егорьевск г.о.": "21",
  "Жуковский г.о.": "23",
  "Зарайск г.о.": "24",
  "Звездный городок г.о.": "91",
  "Истра г.о.": "27",
  "Кашира г.о.": "28",
  "Клин г.о.": "31",
  "Коломна г.о.": "32",
  "Королев г.о.": "34",
  "Котельники г.о.": "83",
  "Красногорск г.о.": "36",
  "Краснознаменск г.о.": "37",
  "Ленинский г.о.": "38",
  "Лобня г.о.": "39",
  "Лосино-Петровский г.о.": "88",
  "Лотошино г.о.": "40",
  "Луховицы г.о.": "41",
  "Лыткарино г.о.": "42",
  "Люберцы г.о.": "43",
  "Можайский г.о.": "44",
  "Молодежный (ЗАТО) г.о.": "90",
  "Мытищи г.о.": "46",
  "Наро-Фоминский г.о.": "48",
  "Одинцовский г.о.": "50",
  "Орехово-Зуевский г.о.": "52",
  "Павлово-Посадский г.о.": "54",
  "Подольск г.о.": "56",
  "Протвино г.о.": "57",
  "Пушкинский г.о.": "58",
  "Пущино г.о.": "59",
  "Раменский г.о.": "60",
  "Реутов г.о.": "62",
  "Рузский г.о.": "63",
  "Сергиево-Посадский г.о.": "64",
  "Серебряные Пруды г.о.": "65",
  "Серпухов г.о.": "66",
  "Солнечногорск г.о.": "68",
  "Ступино г.о.": "70",
  "Талдомский г.о.": "71",
  "Фрязино г.о.": "72",
  "Химки г.о.": "73",
  "Черноголовка г.о.": "92",
  "Чехов г.о.": "74",
  "Шатура г.о.": "76",
  "Шаховская г.о.": "77",
  "Щелково г.о.": "78",
  "Электрогорск г.о.": "89",
  "Электросталь г.о.": "79",
};

const TYPE_MAP = {
  "Аварийная заявка": "1",
  "Неплановая заявка": "1",
  "Плановая заявка": "1",
  А: "1",
  В: "1",
  П: "1",
};

const STATUS_NAME_MAP = {
  Открыта: "2",
  Запитана: "4",
  Удалена: "4",
  Закрыта: "4",
};

function pad2(n) {
  return String(n).padStart(2, "0");
}

function toDateEDDS(v, withTime = false) {
  if (!v) return null;
  const d = new Date(v);
  if (isNaN(d.getTime())) return null;

  try {
    if (withTime) {
      const s = d
        .toLocaleString("ru-RU", {
          timeZone: "Europe/Moscow",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false,
        })
        .replace(",", "");
      const [datePart, timePart] = s.split(" ");
      const [dd, mm, yyyy] = datePart.split(".");
      return `${yyyy}-${mm}-${dd} ${timePart}`;
    } else {
      const s = d.toLocaleDateString("ru-RU", {
        timeZone: "Europe/Moscow",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      });
      const [dd, mm, yyyy] = s.split(".");
      return `${yyyy}-${mm}-${dd}`;
    }
  } catch {
    // Fallback: local time if Intl fails
    const yyyy = d.getFullYear();
    const mm = pad2(d.getMonth() + 1);
    const dd = pad2(d.getDate());
    if (!withTime) return `${yyyy}-${mm}-${dd}`;
    const HH = pad2(d.getHours());
    const MM = pad2(d.getMinutes());
    const SS = pad2(d.getSeconds());
    return `${yyyy}-${mm}-${dd} ${HH}:${MM}:${SS}`;
  }
}

function clean(v) {
  if (v === "—" || v === undefined || v === null || v === "") return null;
  return String(v);
}

function valOrZero(v) {
  if (v === "—" || v === undefined || v === null || v === "") return "0";
  return String(v);
}

function buildMkdFromFiasList(str) {
  if (!str || typeof str !== "string") return [];
  return str
    .split(/[,;]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((fias) => ({ fias: fias.toLowerCase() }));
}

function buildEddsPayload(tnLike) {
  const obj = tnLike?.data ? tnLike.data : tnLike;
  if (!obj) return null;
  const raw = obj?.data || {};

  // Prefer our Strapi-managed overrides if present (like we do for "description")
  const PES_COUNT_TOP = obj?.PES_COUNT ?? obj?.attributes?.PES_COUNT ?? null;
  const PES_POWER_TOP = obj?.PES_POWER ?? obj?.attributes?.PES_POWER ?? null;

  // Unified preferred values
  const PES_COUNT_PREF = clean(PES_COUNT_TOP != null ? PES_COUNT_TOP : raw.PES_COUNT);
  const PES_POWER_PREF = clean(PES_POWER_TOP != null ? PES_POWER_TOP : raw.PES_POWER);

  const incidentId = raw.VIOLATION_GUID_STR || obj.guid || null;

  const typeSrc = raw.VIOLATION_TYPE || obj.type || null;
  const type = TYPE_MAP[typeSrc] || TYPE_MAP[String(typeSrc || "").trim()] || null;

  const statusSrc = obj.STATUS_NAME || obj.status || raw.STATUS_NAME || null;
  const status =
    STATUS_NAME_MAP[String(statusSrc || "").trim().replace(/^./, (c) => c.toUpperCase())] || null;

  const timeCreate = toDateEDDS(raw.F81_060_EVENTDATETIME || obj.createDateTime, true) || null;

  const planDateClose =
    toDateEDDS(raw.F81_070_RESTOR_SUPPLAYDATETIME || obj.recoveryPlanDateTime, true) || null;

  const districtName = raw.DISTRICT || raw.SCNAME || obj.district || obj.dispCenter || null;
  const districtId = DISTRICT_MAP[districtName] || null;

  const countPeople = raw.POPULATION_COUNT ?? raw.population_count ?? obj.count_people ?? null;

  const fioWork = "Оперативный дежурный САЦ";
  const fioPhone = "+74957803976";

  const description = clean(obj?.description);

  const resources = Array.isArray(obj.resources) ? obj.resources : [5];

  const mkdAll = clean(raw.MKD_ALL);
  const clinicsAll = clean(raw.CLINICS_ALL);
  const hospitalsAll = clean(raw.HOSPITALS_ALL);
  const schoolsAll = clean(raw.SCHOOLS_ALL);
  const kindergartensAll = clean(raw.KINDERGARTENS_ALL);
  const boilerAll = clean(raw.BOILER_ALL);
  const ctpAll = clean(raw.CTP_ALL);
  const knsAll = clean(raw.KNS_ALL);
  const wellsAll = clean(raw.WELLS_ALL);
  const vnsAll = clean(raw.VNS_ALL);
  const rpsnAll = clean(raw.RPSN_ALL);
  const ps35All = clean(raw.PS35_ALL);
  const ps110All = clean(raw.PS110_ALL);
  const tpAll = clean(raw.TP_ALL);
  const line110All = clean(raw.LINE110_ALL);
  const line35All = clean(raw.LINE35_ALL);
  const lineSnAll = clean(raw.LINESN_ALL);
  const line04All = clean(raw.LINENN_ALL);
  const settlementCount = clean(raw.SETTLEMENT_COUNT);

  const involved = {
    involved_brigades: clean(raw.BRIGADECOUNT),
    involved_workers: clean(raw.EMPLOYEECOUNT),
    involved_equipment: clean(raw.SPECIALTECHNIQUECOUNT),
    // Use preferred value: top-level Strapi field overrides raw
    involved_emergency_power_supply: PES_COUNT_PREF,
  };

  const required = {
    required_brigades: valOrZero(raw.need_brigade_count),
    required_workers: valOrZero(raw.need_person_count),
    required_equipment: valOrZero(raw.need_equipment_count),
    required_emergency_power_supply: valOrZero(raw.need_reserve_power_source_count),
  };

  const socials = Array.isArray(raw.SocialObjects) ? raw.SocialObjects : [];
  function toKeyBySocialTyp(t) {
    const s = String(t || "").toLowerCase();
    if (s.includes("снт")) return "snt_objects";
    if (s.includes("школ")) return "school_objects";
    if (s.includes("детс") || s.includes("сад")) return "kindergarten_objects";
    if (s.includes("больниц")) return "hospital_objects";
    if (s.includes("поликлин")) return "polyclinic_objects";
    if (s.includes("котель")) return "boiler_room_objects";
    if (s.includes("взу")) return "water_intake_objects";
    if (s.includes("кнс")) return "canalization_pumping_objects";
    if (s.includes("мкд") || s.includes("дом")) return "mkd";
    return null;
  }

  const typedObjects = {
    snt_objects: [],
    school_objects: [],
    kindergarten_objects: [],
    hospital_objects: [],
    polyclinic_objects: [],
    boiler_room_objects: [],
    water_intake_objects: [],
    canalization_pumping_objects: [],
    mkd: [],
  };
  const seen = {
    snt_objects: new Set(),
    school_objects: new Set(),
    kindergarten_objects: new Set(),
    hospital_objects: new Set(),
    polyclinic_objects: new Set(),
    boiler_room_objects: new Set(),
    water_intake_objects: new Set(),
    canalization_pumping_objects: new Set(),
    mkd: new Set(),
  };

  socials.forEach((it) => {
    const key = toKeyBySocialTyp(it?.SocialTyp);
    const fias = clean(it?.FIAS)?.toLowerCase();
    if (!key || !fias) return;
    if (seen[key].has(fias)) return;

    if (key === "mkd") {
      typedObjects.mkd.push({ fias });
      seen.mkd.add(fias);
      return;
    }

    const entry = { fias };
    const name = clean(it?.Name);
    const lat = clean(it?.lat || it?.LAT);
    const lon = clean(it?.lon || it?.LON);
    if (name) entry.name = name;
    if (lat) entry.lat = String(lat);
    if (lon) entry.lon = String(lon);

    typedObjects[key].push(entry);
    seen[key].add(fias);
  });

  let mkd = typedObjects.mkd;
  if (mkd.length === 0) {
    mkd = buildMkdFromFiasList(raw.FIAS_LIST || obj.FIAS_LIST || obj.house_fias_list);
  }

  const out = {};
  if (incidentId) out.incident_id = String(incidentId);
  if (type) out.type = String(type);
  if (status) out.status = String(status);
  if (timeCreate) out.time_create = timeCreate;
  if (planDateClose) out.plan_date_close = planDateClose;
  if (districtId) out.district_id = String(districtId);
  if (countPeople != null) out.count_people = String(Number(countPeople));
  if (fioWork) out.fio_response_work = String(fioWork);
  if (fioPhone) out.fio_response_phone = String(fioPhone);
  if (description) out.description = String(description);
  if (Array.isArray(resources)) out.resources = resources.map(Number);

  if (mkdAll != null) out.mkd_count = String(mkdAll);
  if (settlementCount != null) out.places_count = String(settlementCount);

  if (hospitalsAll != null) out.hospital_count = String(hospitalsAll);
  if (clinicsAll != null) out.polyclinic_count = String(clinicsAll);
  if (schoolsAll != null) out.school_count = String(schoolsAll);
  if (kindergartensAll != null) out.kindergarten_count = String(kindergartensAll);
  if (boilerAll != null) out.boiler_room_count = String(boilerAll);
  if (wellsAll != null) out.water_intake_count = String(wellsAll);
  if (knsAll != null) out.canalization_pumping_count = String(knsAll);

  if (out.water_intake_count == null && typedObjects.water_intake_objects.length) {
    out.water_intake_count = String(typedObjects.water_intake_objects.length);
  }
  if (out.canalization_pumping_count == null && typedObjects.canalization_pumping_objects.length) {
    out.canalization_pumping_count = String(typedObjects.canalization_pumping_objects.length);
  }

  const socialParts = [mkdAll, clinicsAll, hospitalsAll, schoolsAll, kindergartensAll, boilerAll, wellsAll, knsAll].map(
    (v) => (v == null ? 0 : Number(v) || 0)
  );
  const socialSum = socialParts.reduce((a, b) => a + b, 0);
  if (socialSum > 0) out.social_objects_summ = String(socialSum);

  const electric_lines = {
    "110kv_count": line110All,
    "35kv_count": line35All,
    "6_20kv_count": lineSnAll,
    "04kv_count": line04All,
  };
  if (Object.values(electric_lines).some((v) => v != null)) {
    out.electric_lines = Object.fromEntries(Object.entries(electric_lines).filter(([, v]) => v != null));
  }

  const energy_substation = { "110kv_count": ps110All, "35kv_count": ps35All };
  if (Object.values(energy_substation).some((v) => v != null)) {
    out.energy_substation = Object.fromEntries(Object.entries(energy_substation).filter(([, v]) => v != null));
  }

  const transformer_station = { "6_20kv_count": tpAll };
  if (transformer_station["6_20kv_count"] != null) {
    out.transformer_station = transformer_station;
  }

  const distribution_station = { "6_20kv_count": rpsnAll };
  if (distribution_station["6_20kv_count"] != null) {
    out.distribution_station = distribution_station;
  }

  const involved_forces = {
    involved_brigades: involved.involved_brigades,
    involved_workers: involved.involved_workers,
    involved_equipment: involved.involved_equipment,
    involved_emergency_power_supply: involved.involved_emergency_power_supply,
  };
  if (Object.values(involved_forces).some((v) => v != null)) {
    out.involved_forces = Object.fromEntries(Object.entries(involved_forces).filter(([, v]) => v != null));
  }

  const required_forces = {
    required_brigades: required.required_brigades,
    required_workers: required.required_workers,
    required_equipment: required.required_equipment,
    required_emergency_power_supply: required.required_emergency_power_supply,
  };
  if (Object.values(required_forces).some((v) => v != null)) {
    out.required_forces = Object.fromEntries(Object.entries(required_forces).filter(([, v]) => v != null));
  }

  if (Array.isArray(mkd) && mkd.length > 0) out.mkd = mkd;

  if (typedObjects.snt_objects.length) out.snt_objects = typedObjects.snt_objects;
  if (typedObjects.school_objects.length) out.school_objects = typedObjects.school_objects;
  if (typedObjects.kindergarten_objects.length) out.kindergarten_objects = typedObjects.kindergarten_objects;
  if (typedObjects.hospital_objects.length) out.hospital_objects = typedObjects.hospital_objects;
  if (typedObjects.polyclinic_objects.length) out.polyclinic_objects = typedObjects.polyclinic_objects;
  if (typedObjects.boiler_room_objects.length) out.boiler_room_objects = typedObjects.boiler_room_objects;
  if (typedObjects.water_intake_objects.length) out.water_intake_objects = typedObjects.water_intake_objects;
  if (typedObjects.canalization_pumping_objects.length) out.canalization_pumping_objects = typedObjects.canalization_pumping_objects;

  const lat = clean(raw.lat || raw.LAT);
  const lon = clean(raw.lon || raw.LON);
  if (lat) out.lat = String(lat);
  if (lon) out.lon = String(lon);

  return out;
}

module.exports = {
  DISTRICT_MAP,
  TYPE_MAP,
  STATUS_NAME_MAP,
  toDateEDDS,
  clean,
  valOrZero,
  buildMkdFromFiasList,
  buildEddsPayload,
};
