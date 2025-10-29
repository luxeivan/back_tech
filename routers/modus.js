const express = require("express");
const axios = require("axios");
const { broadcast } = require("../services/sse");
require("dotenv").config();
const { fetchByFias } = require("./dadata");

const router = express.Router();
const secretModus = process.env.SECRET_FOR_MODUS;

const isAuthorized = (req) => {
  const raw = (
    req.get("authorization") ||
    req.get("Authorization") ||
    ""
  ).trim();
  const match = /^Bearer\s+(.+)$/i.exec(raw);
  const token = match ? match[1].trim() : "";
  const ok = token && token === String(secretModus || "");
  if (!ok) {
    const mask = (s) => (s ? `${s.slice(0, 4)}…${s.slice(-4)}` : "<empty>");
    console.warn(
      "[modus] Доступ запрещен: token=",
      mask(token),
      " ожидался=",
      mask(String(secretModus || ""))
    );
  }
  return ok;
};

const loginStrapi = process.env.LOGIN_STRAPI;
const passwordStrapi = process.env.PASSWORD_STRAPI;

const urlStrapi = process.env.URL_STRAPI;

const norm = (s) =>
  String(s || "")
    .trim()
    .toLowerCase();
const isFinalStatus = (s) =>
  ["закрыта", "запитана", "удалена"].includes(norm(s));

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
  "Неплановая заявка": "2",
  "Плановая заявка": "3",
  А: "1",
  В: "2",
  П: "3",
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
  const yyyy = d.getFullYear();
  const mm = pad2(d.getMonth() + 1);
  const dd = pad2(d.getDate());
  if (!withTime) return `${yyyy}-${mm}-${dd}`;
  const HH = pad2(d.getHours());
  const MM = pad2(d.getMinutes());
  const SS = pad2(d.getSeconds());
  return `${yyyy}-${mm}-${dd} ${HH}:${MM}:${SS}`;
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
  const PES_COUNT_PREF = clean(
    PES_COUNT_TOP != null ? PES_COUNT_TOP : raw.PES_COUNT
  );
  const PES_POWER_PREF = clean(
    PES_POWER_TOP != null ? PES_POWER_TOP : raw.PES_POWER
  );

  const incidentId = raw.VIOLATION_GUID_STR || obj.guid || null;

  const typeSrc = raw.VIOLATION_TYPE || obj.type || null;
  const type =
    TYPE_MAP[typeSrc] || TYPE_MAP[String(typeSrc || "").trim()] || null;

  const statusSrc = obj.STATUS_NAME || obj.status || raw.STATUS_NAME || null;
  const status =
    STATUS_NAME_MAP[
      String(statusSrc || "")
        .trim()
        .replace(/^./, (c) => c.toUpperCase())
    ] || null;

  const timeCreate =
    toDateEDDS(raw.F81_060_EVENTDATETIME || obj.createDateTime, true) || null;

  const planDateClose =
    toDateEDDS(
      raw.F81_070_RESTOR_SUPPLAYDATETIME || obj.recoveryPlanDateTime,
      true
    ) || null;

  const districtName =
    raw.DISTRICT || raw.SCNAME || obj.district || obj.dispCenter || null;
  const districtId = DISTRICT_MAP[districtName] || null;

  const countPeople =
    raw.POPULATION_COUNT ?? raw.population_count ?? obj.count_people ?? null;

  const fioWork = "Оперативный дежурный САЦ";
  const fioPhone = "84957803976";
  // const descriptionSrc =
  //   raw.REASON_OPER ??
  //   obj.REASON_OPER ??
  //   raw.reason_oper ??
  //   obj.reason_oper ??
  //   obj.description ??
  //   null;
  // const description = clean(descriptionSrc);

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
    required_emergency_power_supply: valOrZero(
      raw.need_reserve_power_source_count
    ),
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
    mkd = buildMkdFromFiasList(
      raw.FIAS_LIST || obj.FIAS_LIST || obj.house_fias_list
    );
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
  if (kindergartensAll != null)
    out.kindergarten_count = String(kindergartensAll);
  if (boilerAll != null) out.boiler_room_count = String(boilerAll);
  if (wellsAll != null) out.water_intake_count = String(wellsAll);
  if (knsAll != null) out.canalization_pumping_count = String(knsAll);

  if (
    out.water_intake_count == null &&
    typedObjects.water_intake_objects.length
  ) {
    out.water_intake_count = String(typedObjects.water_intake_objects.length);
  }
  if (
    out.canalization_pumping_count == null &&
    typedObjects.canalization_pumping_objects.length
  ) {
    out.canalization_pumping_count = String(
      typedObjects.canalization_pumping_objects.length
    );
  }

  const socialParts = [
    mkdAll,
    clinicsAll,
    hospitalsAll,
    schoolsAll,
    kindergartensAll,
    boilerAll,
    wellsAll,
    knsAll,
  ].map((v) => (v == null ? 0 : Number(v) || 0));
  const socialSum = socialParts.reduce((a, b) => a + b, 0);
  if (socialSum > 0) out.social_objects_summ = String(socialSum);

  const electric_lines = {
    "110kv_count": line110All,
    "35kv_count": line35All,
    "6_20kv_count": lineSnAll,
    "04kv_count": line04All,
  };
  if (Object.values(electric_lines).some((v) => v != null)) {
    out.electric_lines = Object.fromEntries(
      Object.entries(electric_lines).filter(([, v]) => v != null)
    );
  }

  const energy_substation = { "110kv_count": ps110All, "35kv_count": ps35All };
  if (Object.values(energy_substation).some((v) => v != null)) {
    out.energy_substation = Object.fromEntries(
      Object.entries(energy_substation).filter(([, v]) => v != null)
    );
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
    out.involved_forces = Object.fromEntries(
      Object.entries(involved_forces).filter(([, v]) => v != null)
    );
  }

  const required_forces = {
    required_brigades: required.required_brigades,
    required_workers: required.required_workers,
    required_equipment: required.required_equipment,
    required_emergency_power_supply: required.required_emergency_power_supply,
  };
  if (Object.values(required_forces).some((v) => v != null)) {
    out.required_forces = Object.fromEntries(
      Object.entries(required_forces).filter(([, v]) => v != null)
    );
  }

  if (Array.isArray(mkd) && mkd.length > 0) out.mkd = mkd;

  if (typedObjects.snt_objects.length)
    out.snt_objects = typedObjects.snt_objects;
  if (typedObjects.school_objects.length)
    out.school_objects = typedObjects.school_objects;
  if (typedObjects.kindergarten_objects.length)
    out.kindergarten_objects = typedObjects.kindergarten_objects;
  if (typedObjects.hospital_objects.length)
    out.hospital_objects = typedObjects.hospital_objects;
  if (typedObjects.polyclinic_objects.length)
    out.polyclinic_objects = typedObjects.polyclinic_objects;
  if (typedObjects.boiler_room_objects.length)
    out.boiler_room_objects = typedObjects.boiler_room_objects;
  if (typedObjects.water_intake_objects.length)
    out.water_intake_objects = typedObjects.water_intake_objects;
  if (typedObjects.canalization_pumping_objects.length)
    out.canalization_pumping_objects =
      typedObjects.canalization_pumping_objects;

  const lat = clean(raw.lat || raw.LAT);
  const lon = clean(raw.lon || raw.LON);
  if (lat) out.lat = String(lat);
  if (lon) out.lon = String(lon);

  return out;
}

async function getJwt() {
  try {
    const res = await axios.post(`${urlStrapi}/api/auth/local`, {
      identifier: loginStrapi,
      password: passwordStrapi,
    });
    if (res.data) {
      return res.data.jwt;
    } else {
      return false;
    }
  } catch (error) {
    console.log("Ошибка авторизации в Strapi:", error);
    return false;
  }
}

// Helper to fetch description from Strapi by ID
async function fetchTnDescriptionById(id, jwt) {
  if (!id || !jwt) return undefined;
  try {
    const r = await axios.get(`${urlStrapi}/api/teh-narusheniyas/${id}`, {
      headers: { Authorization: `Bearer ${jwt}` },
      params: { "fields[0]": "description" },
      timeout: 15000,
    });
    const d = r?.data?.data;
    const attrs = d?.attributes || d || {};
    return attrs?.description;
  } catch (e) {
    console.warn(
      "[POST] Не удалось получить description из Strapi:",
      e?.response?.status || e?.message
    );
    return undefined;
  }
}

function extractFiasList(rawItem) {
  const raw =
    rawItem?.FIAS_LIST ||
    rawItem?.data?.FIAS_LIST ||
    rawItem?.data?.data?.FIAS_LIST ||
    "";

  const fiasCodes = Array.from(
    new Set(
      String(raw)
        .split(/[;,]/)
        .map((s) => s.trim())
        .filter(Boolean)
    )
  );

  return fiasCodes;
}

async function upsertAddressesInStrapi(fiasIds, jwt) {
  const ids = Array.from(
    new Set((fiasIds || []).map((x) => String(x).trim()).filter(Boolean))
  );

  if (!ids.length) {
    return;
  }

  const CONCURRENCY = Number(process.env.DADATA_CONCURRENCY || 2);
  const queue = ids.slice();

  async function worker() {
    while (queue.length) {
      const fiasId = queue.shift();
      try {
        const search = await axios.get(`${urlStrapi}/api/adress`, {
          headers: { Authorization: `Bearer ${jwt}` },
          params: { "filters[fiasId][$eq]": fiasId, "pagination[pageSize]": 1 },
        });
        const existing = Array.isArray(search?.data?.data)
          ? search.data.data[0]
          : null;
        if (existing) {
        } else {
        }

        const info = await fetchByFias(fiasId);

        if (info) {
        } else {
        }

        const payload = {
          fiasId,
          ...(info?.fullAddress ? { fullAddress: info.fullAddress } : {}),
          ...(info?.lat ? { lat: String(info.lat) } : {}),
          ...(info?.lon ? { lon: String(info.lon) } : {}),
          ...(info?.all ? { all: info.all } : {}),
        };

        if (existing) {
          const existingAttrs = existing?.attributes || existing;
          const existingId = existing?.documentId || existing?.id;
          const patch = {};
          const jsonEq = (a, b) => {
            try {
              return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
            } catch {
              return false;
            }
          };

          if (!existingAttrs?.fullAddress && payload.fullAddress)
            patch.fullAddress = payload.fullAddress;
          if (!existingAttrs?.lat && payload.lat) patch.lat = payload.lat;
          if (!existingAttrs?.lon && payload.lon) patch.lon = payload.lon;
          if (payload.all && !jsonEq(existingAttrs?.all, payload.all))
            patch.all = payload.all;

          if (Object.keys(patch).length) {
            const updateResponse = await axios.put(
              `${urlStrapi}/api/adress/${existingId}`,
              { data: patch },
              { headers: { Authorization: `Bearer ${jwt}` } }
            );
          } else {
            console.log(
              `[upsertAddressesInStrapi] Изменений нет, обновление не требуется для FIAS: ${fiasId}`
            );
          }
          continue;
        }

        if (!info) {
          continue;
        }
        const createResponse = await axios.post(
          `${urlStrapi}/api/adress`,
          { data: payload },
          { headers: { Authorization: `Bearer ${jwt}` } }
        );
      } catch (e) {
        console.error(
          `[upsertAddressesInStrapi] Ошибка при обработке FIAS ${fiasId}:`,
          {
            статус: e?.response?.status,
            сообщение: e?.message,
            данные: e?.response?.data,
            url: e?.config?.url,
          }
        );
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(CONCURRENCY, ids.length) },
    worker
  );
  await Promise.all(workers);
}

router.put("/", async (req, res) => {
  try {
    if (!isAuthorized(req)) {
      return res.status(403).json({ status: "Forbidden" });
    }

    const items = req.body.data || req.body.Data;
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        status: "error",
        message:
          "Не хватает требуемых данных (ожидается Data или data: массив)",
      });
    }

    const mapItem = (item) => {
      const status = (item.STATUS_NAME || "").toString().trim().toLowerCase();
      const isActive = status === "открыта";
      return {
        guid: item.VIOLATION_GUID_STR,
        number: `${item.F81_010_NUMBER}`,
        energoObject: item.F81_041_ENERGOOBJECTNAME,
        createDateTime: item.F81_060_EVENTDATETIME,
        recoveryPlanDateTime: item.CREATE_DATETIME,
        addressList: item.ADDRESS_LIST,
        // description: item.F81_042_DISPNAME,
        recoveryFactDateTime: item.F81_290_RECOVERYDATETIME,
        dispCenter: item.DISPCENTER_NAME_,
        STATUS_NAME: (item.STATUS_NAME || "").toString().trim(),
        isActive,
        data: item,
      };
    };

    const buildPatch = (current, next) => {
      const patch = {};
      Object.keys(next).forEach((key) => {
        const prevVal = current?.[key];
        const nextVal = next[key];
        const eq =
          typeof nextVal === "object" && nextVal !== null
            ? JSON.stringify(prevVal) === JSON.stringify(nextVal)
            : prevVal === nextVal;
        if (!eq) patch[key] = nextVal;
      });
      return patch;
    };

    const jwt = await getJwt();
    if (!jwt) {
      return res.status(500).json({
        status: "error",
        message: "Не удалось авторизоваться в Strapi",
      });
    }

    const fiasSet = new Set();

    const results = await items.reduce(async (prevPromise, rawItem, index) => {
      const acc = await prevPromise;
      const mapped = mapItem(rawItem);
      try {
        const fiasCodes = extractFiasList(rawItem);
        fiasCodes.forEach((id) => fiasSet.add(id));
      } catch (e) {
        console.warn(
          `[PUT] Ошибка при извлечении FIAS для элемента ${index + 1}:`,
          e.message
        );
      }

      if (!mapped.guid) {
        acc.push({
          success: false,
          index: index + 1,
          error: "Не передан GUID записи",
        });
        return acc;
      }

      try {
        const search = await axios.get(`${urlStrapi}/api/teh-narusheniyas`, {
          headers: { Authorization: `Bearer ${jwt}` },
          params: {
            "filters[guid][$eq]": mapped.guid,
            "pagination[pageSize]": 1,
          },
        });

        const found = search?.data?.data?.[0];
        const documentId = found?.documentId || found?.id;
        const current = found || {};
        const currentAttrs = current?.attributes || current || {};
        const currentRaw = currentAttrs?.data || current?.data || {};
        const prevStatus = norm(
          current?.STATUS_NAME || current?.attributes?.STATUS_NAME
        );
        const nextStatus = norm(mapped?.STATUS_NAME);
        const statusChanged = prevStatus !== nextStatus;
        const nextIsFinal = isFinalStatus(nextStatus);
        const needEdds = statusChanged && nextIsFinal;

        if (!documentId) {
          acc.push({
            success: false,
            index: index + 1,
            status: "not_found",
            error: "Запись с таким GUID не найдена",
          });
          return acc;
        }

        let patch;
        if (needEdds) {
          patch = {};
          if (currentAttrs?.STATUS_NAME !== mapped.STATUS_NAME) {
            patch.STATUS_NAME = mapped.STATUS_NAME;
          }
          const nextIsActive = nextStatus === "открыта";
          if (currentAttrs?.isActive !== nextIsActive) {
            patch.isActive = nextIsActive;
          }
          if ((currentRaw?.STATUS_NAME || "") !== mapped.STATUS_NAME) {
            patch.data = {
              ...(currentRaw || {}),
              STATUS_NAME: mapped.STATUS_NAME,
            };
          }
        } else {
          patch = buildPatch(current, mapped);
        }

        if (Object.keys(patch).length === 0) {
          acc.push({
            success: true,
            index: index + 1,
            id: documentId,
            updated: false,
            message: "Изменений нет",
          });
          return acc;
        }

        const upd = await axios.put(
          `${urlStrapi}/api/teh-narusheniyas/${documentId}`,
          { data: patch },
          { headers: { Authorization: `Bearer ${jwt}` } }
        );

        try {
          broadcast({
            type: "tn-upsert",
            source: "modus",
            action: "update",
            id: documentId,
            guid: mapped.guid,
            patch,
            timestamp: Date.now(),
          });
        } catch (e) {
          console.error("SSE broadcast error (update):", e?.message);
        }
        if (needEdds) {
          let strapiTn = null;
          try {
            const rFull = await axios.get(`${urlStrapi}/api/teh-narusheniyas`, {
              headers: { Authorization: `Bearer ${jwt}` },
              params: {
                "filters[guid][$eq]": mapped.guid,
                "pagination[pageSize]": 1,
                populate: "*",
              },
            });
            const full = rFull?.data?.data?.[0];
            strapiTn = full?.attributes || full || null;
          } catch (e) {
            console.warn(
              `[modus→edds] Не удалось подтянуть полную запись из Strapi по guid=${mapped.guid}:`,
              e?.response?.status || e?.message
            );
          }

          if (!strapiTn) {
            strapiTn = { ...mapped };
          }

          const mergedForPayload = { ...strapiTn };
          if (mapped?.STATUS_NAME != null)
            mergedForPayload.STATUS_NAME = mapped.STATUS_NAME;
          if (mapped?.recoveryFactDateTime != null)
            mergedForPayload.recoveryFactDateTime = mapped.recoveryFactDateTime;
          if (mapped?.recoveryPlanDateTime != null)
            mergedForPayload.recoveryPlanDateTime = mapped.recoveryPlanDateTime;
          if (mapped?.createDateTime != null)
            mergedForPayload.createDateTime = mapped.createDateTime;
          const payload = buildEddsPayload({ data: mergedForPayload });
          try {
            const dbg = {
              mergedForPayload,
              eddsPayload: payload,
            };
            const snap = JSON.stringify(dbg);
            const snapClip =
              snap.length > 4000
                ? snap.slice(0, 4000) + `… (${snap.length} chars)`
                : snap;
            console.log(`[modus→edds] payload snapshot: ${snapClip}`);
          } catch (e) {
            console.warn(
              "[modus→edds] Не удалось сформировать debug snapshot:",
              e?.message
            );
          }

          const explicitSelf = String(process.env.SELF_EDDS_URL || "").trim();
          const port = Number(
            process.env.PORT || process.env.BACK_PORT || 3110
          );
          const protocol = req.protocol || "http";
          const host = req.get("host");
          const qs = "debug=1";
          const candidates = [
            explicitSelf && `${explicitSelf}?${qs}`,
            `http://127.0.0.1:${port}/services/edds?${qs}`,
            `http://localhost:${port}/services/edds?${qs}`,
            `${protocol}://${host}/services/edds?${qs}`,
            `${protocol}://${host}/api/services/edds?${qs}`,
          ].filter(Boolean);

          console.log(`[modus→edds] candidates: ${candidates.join(", ")}`);
          setTimeout(async () => {
            let delivered = false;

            for (const url of candidates) {
              try {
                const resp = await axios.post(url, payload, {
                  headers: { Authorization: `Bearer ${jwt}` },
                  timeout: 30000,
                  validateStatus: () => true,
                });

                const body =
                  typeof resp?.data === "string"
                    ? resp.data
                    : JSON.stringify(
                        resp?.data ?? resp?.statusText ?? "",
                        null,
                        2
                      );
                const bodyClip =
                  body.length > 4000
                    ? body.slice(0, 4000) + `… (${body.length} chars)`
                    : body;

                console.log(
                  `[modus→edds] try ${url} → HTTP ${resp?.status}; body=${bodyClip}`
                );
                if (resp?.status !== 404) {
                  const claimId =
                    resp?.data?.data?.claim_id ?? resp?.data?.claim_id;
                  const ok =
                    resp?.status >= 200 &&
                    resp?.status < 300 &&
                    (resp?.data?.success === true || !!claimId);

                  if (ok) {
                    console.log(
                      `[modus→edds] ✅ GUID=${mapped.guid} отправлен в ЕДДС через ${url}` +
                        (claimId ? `; claim_id=${claimId}` : "")
                    );
                  } else {
                    console.warn(
                      `[modus→edds] ❌ ЕДДС не приняла GUID=${mapped.guid}: HTTP ${resp?.status}; success=${resp?.data?.success}; message=${resp?.data?.message}; тело=${bodyClip}`
                    );
                  }

                  delivered = true;
                  break;
                }
              } catch (e) {
                const code = e?.response?.status || e?.code || e?.message;
                console.warn(
                  `[modus→edds] Ошибка запроса ${url} для GUID=${mapped.guid}: ${code}`
                );
              }
            }

            if (!delivered) {
              console.error(
                `[modus→edds] ❌ Не удалось доставить GUID=${mapped.guid} до /services/edds — все кандидаты вернули 404`
              );
            }
          }, 0);
        }

        acc.push({
          success: true,
          index: index + 1,
          id: upd?.data?.data?.id || documentId,
          updated: true,
        });
      } catch (e) {
        const msg =
          e?.response?.data?.error?.message ||
          e?.message ||
          "Неизвестная ошибка";
        acc.push({ success: false, index: index + 1, error: msg });
      }

      return acc;
    }, Promise.resolve([]));

    setTimeout(() => {
      if (!fiasSet.size) {
        return;
      }
      console.log("[PUT] Запуск фоновой обработки адресов...");
      upsertAddressesInStrapi([...fiasSet], jwt).catch((e) =>
        console.warn("[modus] Ошибка фоновой обработки адресов:", e?.message)
      );
    }, 0);

    return res.json({ status: "ok", results });
  } catch (e) {
    const msg = e?.message || "Внутренняя ошибка сервера";
    return res.status(500).json({ status: "error", message: msg });
  }
});

router.post("/", async (req, res) => {
  const authorization = req.get("Authorization");

  async function sendDataSequentially(dataArray) {
    const jwt = await getJwt();
    const fiasSet = new Set();

    const results = await dataArray.reduce(
      async (previousPromise, item, index) => {
        const accumulatedResults = await previousPromise;
        try {
          const guid = item?.guid;
          if (guid) {
            try {
              const search = await axios.get(
                `${urlStrapi}/api/teh-narusheniyas`,
                {
                  headers: { Authorization: `Bearer ${jwt}` },
                  params: {
                    "filters[guid][$eq]": guid,
                    "pagination[pageSize]": 1,
                  },
                }
              );
              const found = search?.data?.data?.[0];
              if (found) {
                const existingId = found?.documentId || found?.id;
                accumulatedResults.push({
                  success: false,
                  index: index + 1,
                  status: "duplicate",
                  error: "Запись с таким GUID уже существует",
                  guid,
                  id: existingId,
                });
                return accumulatedResults;
              }
            } catch (e) {
              console.warn(
                `[POST] Не удалось выполнить проверку дубликатов для guid=${guid}:`,
                e?.response?.status || e?.message
              );
            }
          }

          const response = await axios.post(
            `${urlStrapi}/api/teh-narusheniyas`,
            { data: { ...item } },
            { headers: { Authorization: `Bearer ${jwt}` } }
          );

          // Достаём реальные данные из ответа Strapi (v4/v5) и тянем дефолт из самой Strapi (без хардкода)
          const created = response?.data?.data;
          const createdId = created?.id || created?.documentId;
          const createdAttrs = created?.attributes || {};
          let descriptionFromStrapi = createdAttrs?.description;
          if (descriptionFromStrapi == null && createdId) {
            descriptionFromStrapi = await fetchTnDescriptionById(
              createdId,
              jwt
            );
          }

          accumulatedResults.push({
            success: true,
            id: createdId,
            index: index + 1,
          });
          console.log(`[POST] Элемент ${index + 1} успешно отправлен`);
          try {
            const fiasCodes = extractFiasList(item);
            fiasCodes.forEach((id) => fiasSet.add(id));
          } catch (e) {
            console.warn("[POST] Пропущено извлечение адресов:", e?.message);
          }
          try {
            const entryForSse = {
              ...item,
              id: createdId,
              // если фронт слушает только SSE — отдадим корректное описание из Strapi
              description: descriptionFromStrapi,
              // expose Strapi-managed PES fields (override-friendly)
              PES_COUNT: createdAttrs?.PES_COUNT ?? 0,
              PES_POWER: createdAttrs?.PES_POWER ?? 0,
            };
            broadcast({
              type: "tn-upsert",
              source: "modus",
              action: "create",
              id: createdId,
              entry: entryForSse,
              timestamp: Date.now(),
            });
          } catch (e) {
            console.error("Ошибка SSE broadcast (create):", e?.message);
          }
        } catch (error) {
          console.error(
            `[POST] Ошибка при отправке элемента ${index + 1}:`,
            error.message
          );
          accumulatedResults.push({
            success: false,
            error: error.message,
            index: index + 1,
          });
        }

        return accumulatedResults;
      },
      Promise.resolve([])
    );
    setTimeout(() => {
      if (!fiasSet.size) {
        return;
      }
      console.log("[POST] Запуск фоновой обработки адресов...");
      upsertAddressesInStrapi([...fiasSet], jwt).catch((e) =>
        console.warn("[POST] Ошибка фоновой обработки адресов:", e?.message)
      );
    }, 0);

    return results;
  }

  if (authorization === `Bearer ${secretModus}`) {
    if (!req.body?.Data) {
      return res
        .status(400)
        .json({ status: "error", message: "Не хватает требуемых данных" });
    }
    const data = req.body.Data;
    const prepareData = data.map((item) => ({
      guid: item.VIOLATION_GUID_STR,
      number: `${item.F81_010_NUMBER}`,
      energoObject: item.F81_041_ENERGOOBJECTNAME,
      createDateTime: item.F81_060_EVENTDATETIME,
      recoveryPlanDateTime: item.CREATE_DATETIME,
      addressList: item.ADDRESS_LIST,
      // description: item.F81_042_DISPNAME,
      recoveryFactDateTime: item.F81_290_RECOVERYDATETIME,
      dispCenter: item.DISPCENTER_NAME_,
      STATUS_NAME: (item.STATUS_NAME || "").toString().trim(),
      isActive:
        (item.STATUS_NAME || "").toString().trim().toLowerCase() === "открыта",
      data: item,
    }));

    const results = await sendDataSequentially(prepareData);
    if (!results) {
      return res.status(500).json({ status: "error" });
    }

    const anyCreated = results.some((r) => r?.success === true);
    const allDuplicates =
      results.length > 0 && results.every((r) => r?.status === "duplicate");

    if (allDuplicates && !anyCreated) {
      return res.status(409).json({
        status: "duplicate",
        message: "Запись с таким GUID уже существует",
        results,
      });
    }

    return res.json({ status: "ok", results });
  } else {
    res.status(403).json({ status: "Forbidden" });
  }
});

module.exports = router;
