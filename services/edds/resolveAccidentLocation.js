const axios = require("axios");
const { getJwt } = require("../modus/strapi");

const STRAPI_URL = String(process.env.URL_STRAPI || "").replace(/\/$/, "");
const ADDRESS_COLLECTION = process.env.STRAPI_ADDRESS_COLLECTION || "adress";
const BATCH_SIZE = 50;

async function resolveFiasCoordinates(fiasIds) {
  const jwt = await getJwt();
  if (!jwt) throw new Error("Не удалось получить JWT для Strapi");

  const ids = Array.from(
    new Set((fiasIds || []).map((x) => String(x).trim()).filter(Boolean))
  );
  if (!ids.length) return [];

  const results = [];

  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const batch = ids.slice(i, i + BATCH_SIZE);
    const filterParts = batch
      .map((id, idx) => `filters[fiasId][$eq][$${idx + 1}]=${encodeURIComponent(id)}`)
      .join("&");

    const url = `${STRAPI_URL}/api/${ADDRESS_COLLECTION}?${filterParts}&pagination[pageSize]=${batch.length}&fields[0]=fiasId&fields[1]=lat&fields[2]=lon`;

    try {
      const r = await axios.get(url, {
        headers: { Authorization: `Bearer ${jwt}` },
        timeout: 15000,
      });
      const rows = Array.isArray(r?.data?.data) ? r.data.data : [];
      for (const row of rows) {
        const attrs = row?.attributes || row;
        const lat = Number(attrs?.lat);
        const lon = Number(attrs?.lon);
        if (Number.isFinite(lat) && Number.isFinite(lon)) {
          results.push({ fiasId: attrs.fiasId, lat, lon });
        }
      }
    } catch (e) {
      console.warn(
        "[resolveAccidentLocation] Ошибка запроса адресов:",
        e?.response?.status || e?.message
      );
    }
  }

  return results;
}

function computeCentroid(coordinates) {
  if (!coordinates.length) return null;
  const sumLat = coordinates.reduce((s, c) => s + c.lat, 0);
  const sumLon = coordinates.reduce((s, c) => s + c.lon, 0);
  return {
    latitude: Math.round((sumLat / coordinates.length) * 1e6) / 1e6,
    longitude: Math.round((sumLon / coordinates.length) * 1e6) / 1e6,
  };
}

async function resolveAccidentLocation(payload) {
  let fiasIds = [];

  const shutdownInfo = payload?.shutdownInfo;
  if (shutdownInfo && Array.isArray(shutdownInfo.fiasIds) && shutdownInfo.fiasIds.length) {
    fiasIds = shutdownInfo.fiasIds;
  }

  if (!fiasIds.length) {
    const districtFiasIds = payload?.districtFiasIds;
    if (Array.isArray(districtFiasIds) && districtFiasIds.length) {
      fiasIds = [districtFiasIds[0]];
    }
  }

  if (!fiasIds.length) {
    const mkd = payload?.mkd;
    if (Array.isArray(mkd) && mkd.length) {
      fiasIds = mkd.map((m) => m.fias).filter(Boolean);
    }
  }

  if (!fiasIds.length) {
    return { ok: false, status: 422, message: "Нет ФИАС-идов для определения координат аварии" };
  }

  const coordinates = await resolveFiasCoordinates(fiasIds);
  const centroid = computeCentroid(coordinates);

  if (!centroid) {
    return { ok: false, status: 422, message: `Не удалось определить координаты для ${fiasIds.length} ФИАС-адресов` };
  }

  return { ok: true, accidentLocation: centroid, resolvedCount: coordinates.length, totalFias: fiasIds.length };
}

module.exports = { resolveAccidentLocation, resolveFiasCoordinates, computeCentroid };
