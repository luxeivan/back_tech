// Обмен с 1С: отчёт «РесурсыДляВыполненияАВР.Плоская» (ЗУП 3.1 × 2) → ФТ-44.
// Осн.ресурс = Σ(УЭЭ+Водители+СМУ+ТОиР ВЛ+ТОиР КЛ+ТОиР ТП,РП) по «Организация».
// ОВБ = Σ поля «ОВБ». «В смене» в 1С нет — остаётся ручным в Strapi.
// vmr резолвится только на прод-сервере (запись в /etc/hosts).

const axios = require("axios");
const https = require("https");
require("dotenv").config();
const { getJwt } = require("../modus/strapi");

// vmr — внутренняя публикация 1С с cert'ом корпоративного CA (CA-PKI-MOESK),
// в trust store Node/root его нет → без rejectUnauthorized: false падает
// «unable to verify the first certificate». Трафик идёт только по внутреннему контуру.
const onecHttpsAgent = new https.Agent({ rejectUnauthorized: false });

const REPORT_ID = "ДополнительныйОтчет.РесурсыДляВыполненияАВР.Плоская";
const RECIPIENT = "KPI";
const SOAP_ACTION =
  "https://mosoblenergo.ru/ExchangeReports#ExchangeReports:GetReportData";
const SOAP_NS = "https://mosoblenergo.ru/ExchangeReports";
const REQUEST_TIMEOUT_MS = 90000;
// Фиксированные «ныряния» в 1С по Москве (задача юзера 2026-10-21).
const SYNC_HOURS_MSK = [9, 11, 13];
const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;

const OSN_RESOURCE_COLUMNS = [
  "УЭЭ",
  "Водители",
  "СМУ",
  "ТОиР ВЛ",
  "ТОиР КЛ",
  "ТОиР ТП, РП",
];
const OVB_COLUMN = "ОВБ";

// Организация 1С → имя филиала в Strapi tn-filialies (name).
// Краснознаменские ЭС в отчёте нет — они внутри Одинцовского.
// «МОСОБЛЭНЕРГО АО» — не филиал, отбрасываем.
const ORG_TO_STRAPI_FILIAL = {
  "домодедовские электрические сети": "Домодедовский филиал",
  "коломенские электрические сети": "Коломенский филиал",
  "красногорские электрические сети": "Красногорский филиал",
  "мытищинские электрические сети": "Мытищинский филиал",
  "одинцовские электрические сети": "Одинцовский филиал",
  "орехово-зуевский филиал": "Орехово-Зуевский филиал",
  "орехово-зуевский филиал ао \"мособлэнерго\"": "Орехово-Зуевский филиал",
  "павлово-посадские электрические сети": "Павлово-Посадский филиал",
  "сергиево- посадские электрические сети": "Сергиево-Посадский филиал",
  "сергиево-посадские электрические сети": "Сергиево-Посадский филиал",
  "щелковский филиал": "Щёлковский филиал",
  "щелковский филиал ао \"мособлэнерго\"": "Щёлковский филиал",
  "щёлковский филиал": "Щёлковский филиал",
  "щёлковский филиал ао \"мособлэнерго\"": "Щёлковский филиал",
};

const log = (message, details) => {
  if (details === undefined) {
    console.error(`[onec-resources] ${message}`);
    return;
  }
  console.error(`[onec-resources] ${message}`, details);
};

const normalizeOrgName = (value) =>
  String(value || "")
    .replace(/ё/g, "е")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

const escapeXml = (value) =>
  String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const buildParametersJson = (periodDate) => {
  const period = periodDate || new Date().toISOString().slice(0, 10);
  return JSON.stringify({
    Параметры: [
      {
        Параметр: "ТекущаяДата",
        Значение: [{ Период: `${period}T00:00:00` }],
      },
    ],
    Отборы: [
      {
        Поле: "Организация",
        ВидСравнения: "В списке",
        Значение: "()",
      },
    ],
  });
};

const buildSoapEnvelope = (parametersJson) =>
  `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ex="${SOAP_NS}">
  <soap:Body>
    <ex:GetReportData>
      <ex:Recipient>${escapeXml(RECIPIENT)}</ex:Recipient>
      <ex:ReportID>${escapeXml(REPORT_ID)}</ex:ReportID>
      <ex:FormatParameters>json</ex:FormatParameters>
      <ex:Parameters>${escapeXml(parametersJson)}</ex:Parameters>
      <ex:FormatResult>json</ex:FormatResult>
    </ex:GetReportData>
  </soap:Body>
</soap:Envelope>`;

const parseSoapReturn = (rawXml) => {
  const match = String(rawXml || "").match(
    /<m:return[^>]*>([\s\S]*?)<\/m:return>/,
  );
  if (!match) throw new Error("В ответе SOAP нет <m:return>");

  return match[1]
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
};

const parseCellValue = (value) => {
  const text = String(value ?? "").trim().replace(",", ".");
  if (!text) return 0;
  const number = Number(text);
  return Number.isFinite(number) ? number : 0;
};

const pivotReportCells = (report) => {
  const headerCells = Array.isArray(report?.Шапка) ? report.Шапка : [];
  const columnByIndex = new Map();
  headerCells.forEach((cell) => {
    Object.entries(cell || {}).forEach(([key, title]) => {
      const match = String(key).match(/^R\d+C(\d+)/);
      if (match) columnByIndex.set(Number(match[1]), String(title || "").trim());
    });
  });

  const rows = new Map();
  const dataCells = Array.isArray(report?.Данные) ? report.Данные : [];
  dataCells.forEach((cell) => {
    Object.entries(cell || {}).forEach(([key, value]) => {
      const match = String(key).match(/^R(\d+)C(\d+)/);
      if (!match) return;
      const rowIndex = Number(match[1]);
      const colIndex = Number(match[2]);
      if (!rows.has(rowIndex)) rows.set(rowIndex, new Map());
      rows.get(rowIndex).set(colIndex, value);
    });
  });

  return { columnByIndex, rows };
};

const aggregateFt44 = (report) => {
  const { columnByIndex, rows } = pivotReportCells(report);
  const orgColumn = [...columnByIndex.entries()].find(
    ([, title]) => title === "Организация",
  )?.[0];
  if (!orgColumn) throw new Error("В шапке отчёта нет колонки «Организация»");

  const osnColumns = OSN_RESOURCE_COLUMNS.map(
    (title) => [...columnByIndex.entries()].find(([, t]) => t === title)?.[0],
  );
  if (osnColumns.some((index) => index === undefined)) {
    throw new Error(
      `В шапке отчёта не хватает колонок осн.ресурса: ${OSN_RESOURCE_COLUMNS.join(", ")}`,
    );
  }
  const ovbColumn = [...columnByIndex.entries()].find(
    ([, title]) => title === OVB_COLUMN,
  )?.[0];
  if (ovbColumn === undefined) {
    throw new Error("В шапке отчёта нет колонки «ОВБ»");
  }

  const totals = new Map();
  rows.forEach((cells) => {
    const org = String(cells.get(orgColumn) || "").trim();
    if (!org) return;

    const key = normalizeOrgName(org);
    if (!ORG_TO_STRAPI_FILIAL[key]) return;

    const current = totals.get(key) || {
      org1c: org,
      filial: ORG_TO_STRAPI_FILIAL[key],
      mainResource: 0,
      ovb: 0,
    };
    osnColumns.forEach((column) => {
      current.mainResource += parseCellValue(cells.get(column));
    });
    current.ovb += parseCellValue(cells.get(ovbColumn));
    totals.set(key, current);
  });

  return totals;
};

const fetchReportFromBase = async ({ url, login, password, periodDate }) => {
  if (!url) throw new Error("Не задан URL базы 1С (SERVER_1C_ZUP1_URL / ZUP2)");

  const envelope = buildSoapEnvelope(buildParametersJson(periodDate));
  const response = await axios.post(url, envelope, {
    auth: login && password ? { username: login, password } : undefined,
    headers: {
      "Content-Type": "text/xml; charset=utf-8",
      SOAPAction: SOAP_ACTION,
    },
    timeout: REQUEST_TIMEOUT_MS,
    httpsAgent: onecHttpsAgent,
    transitional: { clarifyTimeoutError: true },
  });

  const rawReturn = parseSoapReturn(response?.data);
  const report = JSON.parse(rawReturn);
  if (report?.ТекстОшибки) {
    throw new Error(String(report.ТекстОшибки));
  }
  return report;
};

const fetchMergedFt44Totals = async ({ periodDate } = {}) => {
  const login = process.env.SERVER_1C_LOGIN || "obmen_dashbord_tn";
  const password = process.env.SERVER_1C_PASSWORD || "";
  const bases = [
    { name: "ЗУП1", url: process.env.SERVER_1C_ZUP1_URL },
    { name: "ЗУП2", url: process.env.SERVER_1C_ZUP2_URL },
  ];

  const merged = new Map();
  const baseResults = [];

  for (const base of bases) {
    if (!base.url) {
      log(`${base.name}: URL не задан — пропускаю`);
      baseResults.push({ base: base.name, ok: false, error: "URL не задан" });
      continue;
    }

    try {
      const report = await fetchReportFromBase({
        url: base.url,
        login,
        password,
        periodDate,
      });
      const totals = aggregateFt44(report);
      totals.forEach((value, key) => {
        const current = merged.get(key);
        if (!current) {
          merged.set(key, { ...value });
          return;
        }
        current.mainResource += value.mainResource;
        current.ovb += value.ovb;
      });
      baseResults.push({
        base: base.name,
        ok: true,
        rows: Number(report?.КоличествоСтрок || 0),
        orgs: totals.size,
        generatedAt: report?.ДатаФормирования || null,
      });
      log(
        `${base.name}: ok, строк=${report?.КоличествоСтрок}, организаций=${totals.size}`,
      );
    } catch (error) {
      const message =
        error?.response?.data?.slice?.(0, 200) ||
        error?.message ||
        "unknown error";
      log(`${base.name}: ошибка — ${message}`);
      baseResults.push({ base: base.name, ok: false, error: message });
    }
  }

  if (!merged.size) {
    const detail = baseResults
      .map((item) => `${item.base}: ${item.error || "нет данных"}`)
      .join("; ");
    throw new Error(`Нет данных ни из одной базы 1С. ${detail}`);
  }

  return {
    totals: [...merged.values()].sort((a, b) =>
      a.filial.localeCompare(b.filial, "ru"),
    ),
    bases: baseResults,
  };
};

const toStrapiNumberString = (value) => String(Math.round(Number(value) || 0));

const writeTotalsToStrapi = async (totals) => {
  const jwt = await getJwt();
  if (!jwt) throw new Error("Не удалось получить JWT Strapi");

  const base = String(process.env.URL_STRAPI || "").replace(/\/$/, "");
  if (!base) throw new Error("URL_STRAPI не задан");

  const listResponse = await axios.get(`${base}/api/tn-filialies`, {
    headers: { Authorization: `Bearer ${jwt}` },
    params: {
      "pagination[pageSize]": 100,
      "fields[0]": "name",
      "fields[1]": "ovb",
      "fields[2]": "osn_resours",
      "fields[3]": "documentId",
      "fields[4]": "is_active",
    },
    timeout: 30000,
  });

  const filialRows = Array.isArray(listResponse?.data?.data)
    ? listResponse.data.data
    : [];
  const byName = new Map(
    filialRows.map((row) => [String(row?.name || "").trim(), row]),
  );

  const updated = [];
  const unchanged = [];
  const skipped = [];
  const failed = [];

  for (const total of totals) {
    const row = byName.get(total.filial);
    if (!row?.documentId) {
      skipped.push({
        filial: total.filial,
        reason: "не найден в tn-filialies",
      });
      continue;
    }

    // v_smene НЕ трогаем — в 1С поля «В смене» нет, значение остаётся ручным.
    const nextOsn = toStrapiNumberString(total.mainResource);
    const nextOvb = toStrapiNumberString(total.ovb);
    const prevOsn = String(row.osn_resours ?? "").trim();
    const prevOvb = String(row.ovb ?? "").trim();

    if (prevOsn === nextOsn && prevOvb === nextOvb) {
      unchanged.push({
        filial: total.filial,
        osn_resours: nextOsn,
        ovb: nextOvb,
      });
      continue;
    }

    const body = {
      data: {
        osn_resours: nextOsn,
        ovb: nextOvb,
      },
    };

    try {
      await axios.put(
        `${base}/api/tn-filialies/${row.documentId}`,
        body,
        {
          headers: { Authorization: `Bearer ${jwt}` },
          timeout: 30000,
        },
      );
      updated.push({
        filial: total.filial,
        org1c: total.org1c,
        osn_resours: nextOsn,
        ovb: nextOvb,
        previous: {
          osn_resours: row.osn_resours,
          ovb: row.ovb,
        },
      });
    } catch (error) {
      failed.push({
        filial: total.filial,
        error: error?.response?.data || error?.message,
      });
      log(`Strapi PUT ${total.filial}: ошибка`, error?.message);
    }
  }

  return { updated, unchanged, skipped, failed };
};

let refreshInFlight = null;
let lastResult = null;

const syncFilialResourcesFrom1C = async ({ reason = "manual" } = {}) => {
  if (refreshInFlight) {
    log(`Синхронизация уже идёт, подключаюсь (${reason})`);
    return refreshInFlight;
  }

  refreshInFlight = (async () => {
    const startedAt = Date.now();
    log(`Старт синхронизации, причина: ${reason}`);

    const { totals, bases } = await fetchMergedFt44Totals();
    const writeResult = await writeTotalsToStrapi(totals);

    lastResult = {
      ok: writeResult.failed.length === 0,
      reason,
      calculatedAt: new Date().toISOString(),
      ms: Date.now() - startedAt,
      bases,
      resources: totals,
      strapi: writeResult,
    };

    log(
      `Готово: обновлено ${writeResult.updated.length}, без изменений ${writeResult.unchanged.length}, пропущено ${writeResult.skipped.length}, ошибок ${writeResult.failed.length}, ${lastResult.ms} мс`,
    );
    return lastResult;
  })();

  try {
    return await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
};

const getLastSyncResult = () => lastResult;

const getMskNow = () => new Date(Date.now() + MSK_OFFSET_MS);

// Unix-ms следующего запуска (один из SYNC_HOURS_MSK, время МСК без DST).
const getMsUntilNextSync = () => {
  const msk = getMskNow();
  const dayStartUtcFields = Date.UTC(
    msk.getUTCFullYear(),
    msk.getUTCMonth(),
    msk.getUTCDate(),
  );

  const candidates = SYNC_HOURS_MSK.map((hour) => {
    // hour как «местное» МСК → абсолютный UTC = hour − 3
    return dayStartUtcFields + (hour - 3) * 60 * 60 * 1000;
  });

  const nextToday = candidates.find((at) => at > Date.now());
  if (nextToday !== undefined) {
    return Math.max(1000, nextToday - Date.now());
  }

  // Все часы сегодня уже прошли — завтра в первое окно.
  const tomorrowFirst =
    dayStartUtcFields + 24 * 60 * 60 * 1000 + (SYNC_HOURS_MSK[0] - 3) * 60 * 60 * 1000;
  return Math.max(1000, tomorrowFirst - Date.now());
};

const formatMskClock = (date) =>
  new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    hour: "2-digit",
    minute: "2-digit",
    day: "2-digit",
    month: "2-digit",
  }).format(date);

let refreshTimer = null;

const scheduleNextFilialResourcesSync = () => {
  const delayMs = getMsUntilNextSync();
  const fireAt = new Date(Date.now() + delayMs);
  log(
    `Следующая синхронизация 1С: ${formatMskClock(fireAt)} МСК (через ${Math.round(delayMs / 60000)} мин)`,
  );

  refreshTimer = setTimeout(() => {
    syncFilialResourcesFrom1C({ reason: "schedule" })
      .catch((error) => {
        log("Ошибка плановой синхронизации ресурсов 1С", error?.message);
      })
      .finally(() => {
        scheduleNextFilialResourcesSync();
      });
  }, delayMs);
};

const startFilialResourcesScheduler = () => {
  if (refreshTimer) return;

  const hoursLabel = SYNC_HOURS_MSK.map((h) => `${String(h).padStart(2, "0")}:00`).join(", ");
  log(`Планировщик ресурсов 1С: ${hoursLabel} МСК (плюс один прогон при старте)`);

  syncFilialResourcesFrom1C({ reason: "startup" }).catch((error) => {
    log("Ошибка стартовой синхронизации ресурсов 1С", error?.message);
  });

  scheduleNextFilialResourcesSync();
};

module.exports = {
  REPORT_ID,
  ORG_TO_STRAPI_FILIAL,
  aggregateFt44,
  fetchMergedFt44Totals,
  syncFilialResourcesFrom1C,
  getLastSyncResult,
  startFilialResourcesScheduler,
};
