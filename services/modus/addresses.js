// Вынесено из routers/modus.js (нулевой рефактор): FIAS-лист и upsert адресов в Strapi.

const axios = require("axios");
const { fetchByFias } = require("../../routers/dadata");

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
  const urlStrapi = process.env.URL_STRAPI;
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

module.exports = { extractFiasList, upsertAddressesInStrapi };
