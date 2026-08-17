const express = require("express");
const axios = require("axios");

const router = express.Router();

const OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast";
const OPEN_METEO_GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search";
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

const WEATHER_PARTS = [
  { key: "night", label: "Ночь", hour: 3 },
  { key: "morning", label: "Утро", hour: 9 },
  { key: "day", label: "День", hour: 15 },
  { key: "evening", label: "Вечер", hour: 21 },
];

const getWeatherHour = (time) => {
  const match = String(time || "").match(/T(\d{2})/);
  return match ? Number(match[1]) : NaN;
};

const buildWeatherParts = (hourly = {}) => {
  const times = Array.isArray(hourly.time) ? hourly.time : [];
  const temperatures = Array.isArray(hourly.temperature_2m) ? hourly.temperature_2m : [];
  const weatherCodes = Array.isArray(hourly.weather_code) ? hourly.weather_code : [];

  return WEATHER_PARTS.map((part) => {
    const index = times.findIndex((time) => getWeatherHour(time) === part.hour);

    return {
      key: part.key,
      label: part.label,
      hour: part.hour,
      time: index >= 0 ? times[index] : null,
      temperature: index >= 0 ? temperatures[index] : null,
      weatherCode: index >= 0 ? weatherCodes[index] : null,
    };
  });
};

const normalizeGeoText = (value) =>
  String(value || "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[—–-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const formatGeoLocation = (location = {}) => ({
  name: location.name,
  country: location.country,
  admin1: location.admin1,
  admin2: location.admin2,
  latitude: location.latitude,
  longitude: location.longitude,
});

const isRussiaGeoLocation = (location = {}) =>
  normalizeGeoText(location.country) === "россия" ||
  normalizeGeoText(location.country_code) === "ru";

const isMoscowRegionGeoLocation = (location = {}) => {
  const admin1 = normalizeGeoText(location.admin1);
  return isRussiaGeoLocation(location) && admin1.includes("московская") && admin1.includes("область");
};

const pickRussianWeatherLocation = (locations = []) =>
  locations.find(isMoscowRegionGeoLocation) || locations.find(isRussiaGeoLocation) || locations[0] || null;

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
        current: "temperature_2m,relative_humidity_2m,apparent_temperature,wind_speed_10m,cloud_cover,precipitation,weather_code,surface_pressure",
        hourly: "temperature_2m,weather_code",
        forecast_days: 1,
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
      pressure: current.surface_pressure,
      weatherCode: current.weather_code,
      parts: buildWeatherParts(response?.data?.hourly),
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

router.get("/test-by-place", async (req, res) => {
  const place = String(req.query.place || "").trim();
  if (!place) {
    return res.status(400).json({
      ok: false,
      message: "Передай название в query-параметре place, например ?place=Клин",
    });
  }

  try {
    const geoResponse = await axios.get(OPEN_METEO_GEOCODING_URL, {
      params: {
        name: place,
        count: 10,
        language: "ru",
        format: "json",
      },
      timeout: 10000,
    });

    const locations = Array.isArray(geoResponse?.data?.results) ? geoResponse.data.results : [];
    const location = pickRussianWeatherLocation(locations);

    if (!location) {
      return res.status(404).json({
        ok: false,
        source: "open-meteo-geocoding",
        place,
        message: "Локация не найдена",
      });
    }

    const weatherResponse = await axios.get(OPEN_METEO_URL, {
      params: {
        latitude: location.latitude,
        longitude: location.longitude,
        current: "temperature_2m,relative_humidity_2m,apparent_temperature,wind_speed_10m,cloud_cover,precipitation,weather_code,surface_pressure",
        hourly: "temperature_2m,weather_code",
        forecast_days: 1,
        wind_speed_unit: "ms",
        timezone: "Europe/Moscow",
      },
      timeout: 10000,
    });

    const current = weatherResponse?.data?.current || {};
    return res.json({
      ok: true,
      test: true,
      source: "open-meteo-geocoding + open-meteo-forecast",
      query: place,
      location: formatGeoLocation(location),
      candidates: locations.slice(0, 5).map(formatGeoLocation),
      weather: {
        updatedAt: current.time || null,
        temperature: current.temperature_2m,
        apparentTemperature: current.apparent_temperature,
        humidity: current.relative_humidity_2m,
        windSpeed: current.wind_speed_10m,
        cloudCover: current.cloud_cover,
        precipitation: current.precipitation,
        pressure: current.surface_pressure,
        weatherCode: current.weather_code,
        parts: buildWeatherParts(weatherResponse?.data?.hourly),
      },
    });
  } catch (error) {
    const message =
      error?.response?.data?.reason ||
      error?.response?.data?.error ||
      error?.message ||
      "Не удалось проверить погоду по названию";

    return res.status(502).json({
      ok: false,
      source: "open-meteo-geocoding + open-meteo-forecast",
      place,
      message,
    });
  }
});

module.exports = router;
