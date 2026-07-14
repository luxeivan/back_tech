const express = require("express");
const axios = require("axios");

const router = express.Router();

const OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast";
const DEFAULT_LOCATION = {
  latitude: 55.7558,
  longitude: 37.6173,
  label: "Москва",
};
const CACHE_TTL_MS = 5 * 60 * 1000;

let cache = {
  expiresAt: 0,
  payload: null,
};

const toNumber = (value, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

router.get("/current", async (req, res) => {
  const now = Date.now();
  if (cache.payload && now < cache.expiresAt) {
    return res.json({ ...cache.payload, cached: true });
  }

  const latitude = toNumber(req.query.latitude, DEFAULT_LOCATION.latitude);
  const longitude = toNumber(req.query.longitude, DEFAULT_LOCATION.longitude);
  const label = String(req.query.label || DEFAULT_LOCATION.label).trim() || DEFAULT_LOCATION.label;

  try {
    const response = await axios.get(OPEN_METEO_URL, {
      params: {
        latitude,
        longitude,
        current: "temperature_2m,relative_humidity_2m,apparent_temperature,wind_speed_10m,cloud_cover,precipitation,weather_code",
        wind_speed_unit: "ms",
        timezone: "Europe/Moscow",
      },
      timeout: 10000,
    });

    const current = response?.data?.current || {};
    const payload = {
      ok: true,
      source: "open-meteo",
      label,
      latitude,
      longitude,
      updatedAt: current.time || new Date().toISOString(),
      temperature: current.temperature_2m,
      apparentTemperature: current.apparent_temperature,
      humidity: current.relative_humidity_2m,
      windSpeed: current.wind_speed_10m,
      cloudCover: current.cloud_cover,
      precipitation: current.precipitation,
      weatherCode: current.weather_code,
    };

    cache = {
      expiresAt: now + CACHE_TTL_MS,
      payload,
    };

    return res.json(payload);
  } catch (error) {
    const message =
      error?.response?.data?.reason ||
      error?.response?.data?.error ||
      error?.message ||
      "Не удалось получить погоду";

    return res.status(502).json({
      ok: false,
      source: "open-meteo",
      message,
    });
  }
});

module.exports = router;
