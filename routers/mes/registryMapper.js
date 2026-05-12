const dayjs = require("dayjs");
const { KD_ORG } = require("./config");
const { clean, normalizeBaseType, splitFirst, toIsoT } = require("./utils");

function getBaseTypeFromPayload(p = {}) {
  return normalizeBaseType(p.base_type ?? p.BASE_TYPE);
}

function getBaseTypeFromTn(tn) {
  const raw = tn?.data?.data || {};
  const obj = tn?.data || {};
  return normalizeBaseType(obj.BASE_TYPE ?? raw.BASE_TYPE);
}

function getExternalIdFromPayload(p = {}) {
  return (
    clean(p.external_id) ||
    clean(p.VIOLATION_GUID_STR) ||
    clean(p.guid) ||
    clean(p.id_registry_ext) ||
    null
  );
}

function getExternalIdFromTn(tn) {
  const raw = tn?.data?.data || {};
  const obj = tn?.data || {};
  return (
    clean(raw.VIOLATION_GUID_STR) ||
    clean(obj.guid) ||
    clean(obj.documentId) ||
    clean(obj.id) ||
    null
  );
}

function buildRegistryExternalId(externalId) {
  const base = clean(externalId) || "mosoblenergo";
  const safeBase = base.replace(/[^\w.-]+/g, "_").slice(0, 80);
  return `${safeBase}_${dayjs().format("YYYYMMDDHHmmss")}`;
}

function mapNotification(tn) {
  const raw = tn?.data?.data || {};
  const status = clean(raw.STATUS_NAME || tn?.data?.STATUS_NAME) || "";
  const s = status.toLowerCase();
  if (s.includes("запитан") || s.includes("закрыт")) return "2";
  if (getBaseTypeFromTn(tn) === 1) return "3";
  return "1";
}

function firstFiasHouse(tn) {
  const raw = tn?.data?.data || {};
  return splitFirst(
    raw.FIAS_LIST || tn?.data?.FIAS_LIST || tn?.data?.house_fias_list
  );
}

function buildRegistryItemFromMesPayload(p, idx = 1) {
  const fias = splitFirst(p.fias) || splitFirst(p.Guid2) || splitFirst(p.FIAS_LIST) || "";
  const cond = (clean(p.condition) || "").toLowerCase();
  const baseType = getBaseTypeFromPayload(p);
  let kdNotif = "1";
  if (cond.includes("запитан") || cond.includes("закрыт")) kdNotif = "2";
  else if (baseType === 1) kdNotif = "3";

  const item = {
    id_regline_ext: String(p.id_regline_ext || idx),
    kd_tp_client: 1,
    KD_TP_NOTIFICATION: kdNotif,
    KD_ORG,
  };

  if (fias !== "") item.GUID_FIAS_HOUSE = fias;

  const dateOff = toIsoT(p.date_off);
  const datePlan = toIsoT(p.date_on_plan);
  const dateFact = toIsoT(p.date_on_fact);

  if (dateOff) item.DT_OUTAGE_TIME_PLANNED = dateOff;
  if (kdNotif === "2") {
    if (dateFact) item.DT_RESTORATION_TIME_PLANNED = dateFact;
    else if (datePlan) item.DT_RESTORATION_TIME_PLANNED = datePlan;
  } else if (datePlan) {
    item.DT_RESTORATION_TIME_PLANNED = datePlan;
  }

  const reason = clean(p.massage);
  if (reason) item.NM_REASON = reason.toLowerCase();

  return item;
}

function buildRegistryItem(tn, idx = 1) {
  const raw = tn?.data?.data || {};
  const obj = tn?.data || {};

  const dateOff = toIsoT(raw.F81_060_EVENTDATETIME || obj.createDateTime);
  const datePlan = toIsoT(
    raw.F81_070_RESTOR_SUPPLAYDATETIME || obj.recoveryPlanDateTime
  );
  const dateFact = toIsoT(
    raw.F81_290_RECOVERYDATETIME || obj.recoveryFactDateTime || obj.recoveryDateTime
  );
  const reason = (
    clean(obj.description) ||
    clean(raw.DESCRIPTION) ||
    ""
  ).toLowerCase();
  const kdNotif = mapNotification(tn);

  const item = {
    id_regline_ext: String(obj.documentId || obj.id || idx),
    kd_tp_client: 1,
    KD_TP_NOTIFICATION: kdNotif,
    KD_ORG,
  };

  const fias = firstFiasHouse(tn);
  if (fias) item.GUID_FIAS_HOUSE = fias;

  if (dateOff) item.DT_OUTAGE_TIME_PLANNED = dateOff;
  if (kdNotif === "2") {
    if (dateFact) item.DT_RESTORATION_TIME_PLANNED = dateFact;
    else if (datePlan) item.DT_RESTORATION_TIME_PLANNED = datePlan;
  } else if (datePlan) {
    item.DT_RESTORATION_TIME_PLANNED = datePlan;
  }
  if (reason) item.NM_REASON = reason;

  return item;
}

module.exports = {
  buildRegistryExternalId,
  buildRegistryItem,
  buildRegistryItemFromMesPayload,
  getExternalIdFromPayload,
  getExternalIdFromTn,
};
