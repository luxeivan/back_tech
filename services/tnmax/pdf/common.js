// Порт чистых хелперов из front src/components/dashboard/js/dashboardCommon.js
// (без import.meta.env — URL оттуда не нужен).

// Безопасный парсинг числа (включая { value }).
const toNumber = (v) => {
  const val = v != null && typeof v === "object" && "value" in v ? v.value : v;
  const n = Number(val);
  return Number.isFinite(n) ? n : 0;
};

// Унифицированный доступ к полям плоской/вложенной структуры.
const pick = (obj, key) =>
  obj?.[key] ?? obj?.attributes?.[key] ?? obj?.data?.[key] ?? obj?.data?.data?.[key] ?? null;

const s = (v) =>
  typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();

const startDate = (row) =>
  pick(row, "F81_060_EVENTDATETIME") ?? pick(row, "createDateTime") ?? null;

const getTnFilialName = (row) => {
  const filial = s(pick(row, "SC_FILIAL"));
  if (filial) return filial;

  const oldFilial = s(pick(row, "OWN_SCNAME"));
  if (oldFilial) return oldFilial;

  return null;
};

const getTnPoName = (row) => {
  const po = s(pick(row, "SC_PO"));
  if (po) return po;

  const oldPo = s(pick(row, "SCNAME"));
  if (oldPo) return oldPo;

  return null;
};

// Статус «открыто» для ТН.
const isOpenTN = (row) => {
  const v =
    row?.isActive ??
    row?.data?.isActive ??
    row?.data?.data?.isActive ??
    row?.attributes?.isActive ??
    (row?.attributes && row.attributes.isActive?.value);
  return v === true || v === 1 || v === "true";
};

// Для dashboard учитываем только аварийные/внеплановые ТН.
const baseTypeOf = (row) => {
  const raw =
    row?.BASE_TYPE ?? row?.attributes?.BASE_TYPE ?? row?.data?.BASE_TYPE ?? row?.data?.data?.BASE_TYPE ?? null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};

const isDashboardBaseType = (row) => baseTypeOf(row) === 0;

const statusNameOf = (row) => s(pick(row, "STATUS_NAME") ?? row?.STATUS_NAME);

const isNotDeletedTN = (row) => statusNameOf(row).toLowerCase() !== "удалена";

module.exports = {
  toNumber,
  pick,
  s,
  startDate,
  getTnFilialName,
  getTnPoName,
  isOpenTN,
  baseTypeOf,
  isDashboardBaseType,
  statusNameOf,
  isNotDeletedTN,
};
