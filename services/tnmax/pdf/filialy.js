// Порт из front src/utils/tnFilialyApi.js: только чтение/развёртывание relation-строк
// и загрузка списка tn-filialies. JWT передаётся параметром (не localStorage).
const axios = require("axios");

const PAGE_SIZE = 100;
const TN_FILIALIES_STATUS = "draft";

function strapiBase() {
  const base = String(process.env.URL_STRAPI || "").replace(/\/$/, "");
  if (!base) throw new Error("URL_STRAPI не задан");
  return base;
}

const mapStrapiItem = (item) =>
  item?.attributes
    ? { id: item.id, documentId: item.documentId, ...item.attributes }
    : item;

const unwrapTnFilialyRelation = (relation) => {
  if (!relation) return null;
  if (Array.isArray(relation)) return relation.map(mapStrapiItem).filter(Boolean);
  if (Array.isArray(relation.data)) return relation.data.map(mapStrapiItem).filter(Boolean);
  if (relation.data) return mapStrapiItem(relation.data);
  return mapStrapiItem(relation);
};

const toRelationList = (...relations) =>
  relations.flatMap((relation) => {
    const value = unwrapTnFilialyRelation(relation);
    if (Array.isArray(value)) return value;
    return value ? [value] : [];
  });

const getRelationKey = (row) =>
  String(row?.documentId || row?.id || row?.name || "").trim();

const uniqueRelationsByKey = (rows) => {
  const seen = new Set();
  return rows.filter((row) => {
    const key = getRelationKey(row);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const getTnFilialyOkrugaRows = (filialRow) =>
  uniqueRelationsByKey(toRelationList(filialRow?.tn_okruga, filialRow?.tn_okrugs));

const getTnFilialyPoRows = (filialRow) =>
  uniqueRelationsByKey(toRelationList(filialRow?.tn_pos, filialRow?.tn_po));

const getTnFilialyPoOkrugaRows = (poRow) =>
  uniqueRelationsByKey(toRelationList(poRow?.tn_okruga, poRow?.tn_okrugs));

const createDirectOkrugPoRow = (okrugRow, filialRow) => {
  const name = okrugRow?.name || okrugRow?.source_name || "";
  if (!name) return null;

  return {
    id: `direct-okrug-${okrugRow?.documentId || okrugRow?.id || name}`,
    documentId: `direct-okrug-${okrugRow?.documentId || okrugRow?.id || name}`,
    name,
    sort_order: okrugRow?.sort_order,
    is_active: okrugRow?.is_active,
    ovb: okrugRow?.ovb,
    osn_resours: okrugRow?.osn_resours,
    tn_okruga: [okrugRow],
    tn_filialy: filialRow,
    tn_filialies: [filialRow],
    __is_direct_okrug_po: true,
  };
};

const getTnFilialyAreaPoRows = (filialRow) => {
  const poRows = getTnFilialyPoRows(filialRow).filter((poRow) => poRow?.is_active !== false);
  if (poRows.length) return poRows;

  return getTnFilialyOkrugaRows(filialRow)
    .filter((okrugRow) => okrugRow?.is_active !== false)
    .map((okrugRow) => createDirectOkrugPoRow(okrugRow, filialRow))
    .filter(Boolean);
};

// Постраничная загрузка активных филиалов (параметры 1-в-1 как на фронте).
async function fetchTnFilialyRows(jwt) {
  const endpoint = `${strapiBase()}/api/tn-filialies`;
  const headers = jwt ? { Authorization: `Bearer ${jwt}` } : undefined;
  const rows = [];
  let page = 1;
  let pageCount = 1;

  do {
    const { data } = await axios.get(endpoint, {
      params: {
        status: TN_FILIALIES_STATUS,
        "filters[is_active][$eq]": true,
        "fields[0]": "name",
        "fields[1]": "rezim",
        "fields[2]": "is_active",
        "fields[3]": "sort_order",
        "fields[4]": "ovb",
        "fields[5]": "osn_resours",
        "fields[6]": "v_smene",
        "pagination[page]": page,
        "pagination[pageSize]": PAGE_SIZE,
        "populate[tn_okruga][fields][0]": "name",
        "populate[tn_okruga][fields][1]": "source_name",
        "populate[tn_okruga][fields][2]": "geometry",
        "populate[tn_okruga][fields][3]": "properties",
        "populate[tn_okruga][fields][4]": "sort_order",
        "populate[tn_okruga][fields][5]": "is_active",
        "populate[tn_okruga][fields][6]": "ovb",
        "populate[tn_okruga][fields][7]": "osn_resours",
        "populate[tn_pos][fields][0]": "name",
        "populate[tn_pos][fields][1]": "sort_order",
        "populate[tn_pos][fields][2]": "is_active",
        "populate[tn_pos][fields][3]": "ovb",
        "populate[tn_pos][fields][4]": "osn_resours",
        "populate[tn_pos][populate][tn_okruga][fields][0]": "name",
        "populate[tn_pos][populate][tn_okruga][fields][1]": "source_name",
        "populate[tn_pos][populate][tn_okruga][fields][2]": "geometry",
        "populate[tn_pos][populate][tn_okruga][fields][3]": "properties",
        "populate[tn_pos][populate][tn_okruga][fields][4]": "sort_order",
        "populate[tn_pos][populate][tn_okruga][fields][5]": "is_active",
        "populate[tn_pos][populate][tn_okruga][fields][6]": "ovb",
        "populate[tn_pos][populate][tn_okruga][fields][7]": "osn_resours",
        "sort[0]": "sort_order:asc",
      },
      headers,
      timeout: 30000,
    });

    rows.push(...(Array.isArray(data?.data) ? data.data.map(mapStrapiItem) : []));
    pageCount = Number(data?.meta?.pagination?.pageCount || 1);
    page += 1;
  } while (page <= pageCount);

  return rows;
}

module.exports = {
  mapStrapiItem,
  unwrapTnFilialyRelation,
  toRelationList,
  getRelationKey,
  uniqueRelationsByKey,
  getTnFilialyOkrugaRows,
  getTnFilialyPoRows,
  getTnFilialyPoOkrugaRows,
  createDirectOkrugPoRow,
  getTnFilialyAreaPoRows,
  fetchTnFilialyRows,
};
