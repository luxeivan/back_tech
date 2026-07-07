const axios = require("axios");
const { getJwt } = require("../modus/strapi");

const STRAPI_URL = String(process.env.URL_STRAPI || "").replace(/\/$/, "");
const ADDRESS_COLLECTION = process.env.STRAPI_ADDRESS_COLLECTION || "adress";
const BATCH_SIZE = 50;

const DISTRICT_COORDS = {
  "d77fcba7-6fd9-4e15-a70f-dba0e96a116e": { lat: 55.5553, lon: 38.2234 },
  "213a1aca-5c9e-4b94-a4e0-c5333882cba0": { lat: 55.7466, lon: 37.9720 },
  "d1954143-4569-4938-b06a-2c51d07b8fe3": { lat: 55.8460, lon: 38.4530 },
  "5a5f9a40-b6a3-4ad8-af28-aff545e17b84": { lat: 56.0349, lon: 35.8610 },
  "28ae170a-f54c-4ec4-8fcc-920f20871ea3": { lat: 55.3208, lon: 38.6544 },
  "646f3a1d-1087-454a-a412-c7c9831d67d0": { lat: 55.8686, lon: 37.8466 },
  "07044206-f77f-4bbf-83b9-ce4f0432eaea": { lat: 56.3453, lon: 37.5234 },
  "79ba1e00-2b3f-466d-88db-50deeb27c4c9": { lat: 55.9473, lon: 37.5152 },
  "af2085e0-ca38-4a98-9bec-e43b7057ba6c": { lat: 55.4075, lon: 37.7764 },
  "819d73c8-9375-4e39-8853-ddf003b42217": { lat: 56.7433, lon: 37.1868 },
  "d8737d58-293f-4d6b-9d37-b1d588c04eaa": { lat: 55.7420, lon: 39.0358 },
  "f205bd3d-c738-4743-be7e-4a21084cb22f": { lat: 55.6940, lon: 38.1210 },
  "42d90380-b3b2-42d3-bae2-3d3652a2e50d": { lat: 55.9170, lon: 36.8593 },
  "3e5c43e5-95ec-4faf-9b4d-8612e6003a52": { lat: 54.8415, lon: 38.1310 },
  "d3757aca-5857-47ed-9566-5adc2b57afac": { lat: 56.3270, lon: 36.7393 },
  "6e68c7e7-10ab-4965-aada-478aeae821db": { lat: 55.0796, lon: 38.7780 },
  "9d737e81-e677-43cb-83d2-4e11e5e5dc2c": { lat: 55.9167, lon: 37.8567 },
  "5277759e-be05-4a2d-ba89-d8478add5a0c": { lat: 55.6542, lon: 38.0602 },
  "d55b49ba-475a-4141-b11f-9cb3f29e2205": { lat: 55.8206, lon: 37.3300 },
  "c2c325fc-435f-4ab7-88fc-d632f6b33c87": { lat: 55.4200, lon: 37.5100 },
  "36b29bf3-2a90-4c6c-9bc2-8dc59e890ef3": { lat: 56.0140, lon: 37.4760 },
  "9132b305-951c-423e-9bba-0b29d23fddd6": { lat: 55.8963, lon: 38.0483 },
  "2e1b7a2a-55de-42be-aacf-6c625cad5ff5": { lat: 55.6770, lon: 37.8940 },
  "d75a3e6e-3d43-4404-97d7-a0bb0ad01459": { lat: 55.3093, lon: 36.0160 },
  "aa29f2e6-5d7d-4e7b-b062-56c4fe0f39fe": { lat: 55.9100, lon: 37.7360 },
  "0d5fdd1b-a7fa-452e-bde7-6f752016d67b": { lat: 55.3840, lon: 36.7360 },
  "b4d06790-77eb-44d8-8cfd-035404fb2fb7": { lat: 55.6720, lon: 37.2920 },
  "57e6e3c2-486a-4265-afc6-af1c2d6729dc": { lat: 55.6700, lon: 38.9700 },
  "560e4d42-b5a8-4b34-9462-e8d4f048c964": { lat: 55.7844, lon: 38.4467 },
  "26149e92-3a76-4bba-b332-1facc35f9311": { lat: 55.4240, lon: 37.5470 },
  "113003b5-dae9-46de-99cf-28eb47763625": { lat: 56.0117, lon: 37.8488 },
  "98b2ade5-8a1b-4a98-b569-6aeefcb2ab8e": { lat: 55.7167, lon: 38.2667 },
  "26580099-b45e-4834-b085-527485d692b7": { lat: 55.9726, lon: 36.1957 },
  "ed7da874-3df1-4f99-a1f4-302a27be0d95": { lat: 56.3100, lon: 38.1300 },
  "ef67af07-1d09-4924-a7e4-f2429428b581": { lat: 54.9000, lon: 37.4100 },
  "885695b8-1384-4c12-990e-1a2961a337b2": { lat: 56.1800, lon: 36.9800 },
  "ec488b61-384c-48ff-a78d-117bc22c9674": { lat: 54.8860, lon: 37.0700 },
  "cd03d381-6681-4970-8d7a-f77b2bf108fa": { lat: 55.8900, lon: 37.4200 },
  "d000a228-e8ec-4e5f-8903-98a209c78d68": { lat: 55.1500, lon: 37.4700 },
  "277e8ad7-99a4-498a-8385-6f94c1dcac28": { lat: 55.9800, lon: 37.9900 },
  "b433362d-7f0c-48dd-91ae-2af6aed54879": { lat: 55.7900, lon: 38.4400 },
  "89184dde-a93f-40ae-b6d5-8645833bddb3": { lat: 55.4900, lon: 37.5600 },
  "044de8a0-d790-49b3-a3e3-7ee7ea56e79c": { lat: 55.0900, lon: 38.7900 },
  "462cc323-d81e-4564-9dc8-ee30f9a46b0a": { lat: 55.5800, lon: 37.9000 },
  "f602fcc3-8b8b-4a03-b215-4aab8ca4e390": { lat: 55.7400, lon: 37.3700 },
  "d34042a0-5440-40c5-8bc7-09383bd38cab": { lat: 55.6000, lon: 36.6000 },
  "bc6c3bd3-95b9-4258-9726-089a9d207f13": { lat: 55.3800, lon: 37.3800 },
  "93c36278-3ece-468d-a74f-5a77f8a1b863": { lat: 55.5800, lon: 38.0700 },
  "292ca80f-50ec-4160-b7c8-adeb53774645": { lat: 55.2500, lon: 38.0700 },
  "4613a114-016a-4b72-9a9c-57a6961e1971": { lat: 55.8800, lon: 38.0600 },
  "b6515ab8-66eb-4f6d-8b9d-3667b287004d": { lat: 56.1000, lon: 35.8000 },
  "70ce2cc9-ded3-492a-9bda-a26dceb3bcd2": { lat: 56.3200, lon: 37.5300 },
  "a5845777-83fb-4cf0-bf14-6f24d900b389": { lat: 55.9600, lon: 37.8600 },
  "d9b693fc-2211-424c-b570-d4a9f3c8d709": { lat: 56.0500, lon: 38.3800 },
  "ef438532-11fe-459f-99b4-873b7f216125": { lat: 55.5800, lon: 39.2700 },
  "36087d43-b081-40fc-855c-8d65681d5cef": { lat: 56.0300, lon: 35.5200 },
  "0c5b2444-70a0-4932-980c-b4dc0d3f02b5": { lat: 55.7558, lon: 37.6173 },
};

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
    const params = new URLSearchParams();
    batch.forEach((id, idx) => {
      params.append(`filters[fiasId][$in][${idx}]`, id);
    });
    params.append("pagination[pageSize]", String(batch.length));
    params.append("fields[0]", "fiasId");
    params.append("fields[1]", "lat");
    params.append("fields[2]", "lon");

    const url = `${STRAPI_URL}/api/${ADDRESS_COLLECTION}?${params.toString()}`;

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

function isValidCoordinatePair(value) {
  if (!value || typeof value !== "object") return false;
  if (
    value.latitude === null ||
    value.latitude === undefined ||
    value.latitude === "" ||
    value.longitude === null ||
    value.longitude === undefined ||
    value.longitude === ""
  ) {
    return false;
  }
  const latitude = Number(value.latitude);
  const longitude = Number(value.longitude);
  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
  );
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

function resolveDistrictFallback(fiasIds) {
  for (const fiasId of fiasIds) {
    const fallback = DISTRICT_COORDS[fiasId];
    if (fallback) {
      console.log(`[resolveAccidentLocation] Fallback координаты района: ${fiasId} → ${fallback.lat}, ${fallback.lon}`);
      return {
        ok: true,
        accidentLocation: { latitude: fallback.lat, longitude: fallback.lon },
        resolvedCount: 1,
        totalFias: fiasIds.length,
      };
    }
  }
  return null;
}

async function resolveAccidentLocation(payload) {
  if (isValidCoordinatePair(payload?.accidentLocation)) {
    return {
      ok: true,
      accidentLocation: {
        latitude: Math.round(Number(payload.accidentLocation.latitude) * 1e6) / 1e6,
        longitude: Math.round(Number(payload.accidentLocation.longitude) * 1e6) / 1e6,
      },
      resolvedCount: 1,
      totalFias: 0,
      source: "payload",
    };
  }

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

  const districtFallback = resolveDistrictFallback(fiasIds);
  if (districtFallback) {
    return districtFallback;
  }

  const coordinates = await resolveFiasCoordinates(fiasIds);
  const centroid = computeCentroid(coordinates);

  if (!centroid) {
    return { ok: false, status: 422, message: `Не удалось определить координаты для ${fiasIds.length} ФИАС-адресов` };
  }

  return { ok: true, accidentLocation: centroid, resolvedCount: coordinates.length, totalFias: fiasIds.length };
}

module.exports = { resolveAccidentLocation, resolveFiasCoordinates, computeCentroid };
