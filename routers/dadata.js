const axios = require("axios");
require("dotenv").config();

const DADATA_TOKEN = process.env.DADATA_TOKEN;

async function fetchByFias(fiasId) {
  if (!fiasId) return null;
  if (!DADATA_TOKEN) {
    console.warn("[dadata] DADATA_TOKEN отсутствует в .env");
    return null;
  }

  try {
    const { data } = await axios.post(
      "https://suggestions.dadata.ru/suggestions/api/4_1/rs/findById/address",
      { query: String(fiasId).trim() },
      {
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Token ${DADATA_TOKEN}`,
        },
        timeout: 12000,
      }
    );

    const s = Array.isArray(data?.suggestions) ? data.suggestions[0] : null;
    if (!s) return null;

    return {
      fullAddress: s.unrestricted_value || s.value || null,
      lat: s?.data?.geo_lat || null,
      lon: s?.data?.geo_lon || null,
      all: s, // полный объект подсказки DaData (может пригодиться)
    };
  } catch (e) {
    const code = e?.response?.status || e?.code || "";
    console.warn(`[dadata] fetchByFias ${fiasId}:`, code, e?.message || "");
    return null;
  }
}

module.exports = { fetchByFias };
