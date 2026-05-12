require("dotenv").config();

function readPositiveIntEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function normalizeHttpMethod(v, fallback = "post") {
  const method = String(v || fallback).trim().toLowerCase();
  return method === "get" ? "get" : "post";
}

const MES_MODE = String(process.env.MES_MODE || process.env.MES_ENV || "test")
  .trim()
  .toLowerCase();

const MES_TEST_AUTH_URL = process.env.MES_TEST_AUTH_URL;
const MES_TEST_LOAD_URL = process.env.MES_TEST_LOAD_URL;
const MES_PROD_AUTH_URL = process.env.MES_PROD_AUTH_URL;
const MES_PROD_LOAD_URL = process.env.MES_PROD_LOAD_URL;

const AUTH_BASE = MES_MODE === "prod" ? MES_PROD_AUTH_URL : MES_TEST_AUTH_URL;
const LOAD_BASE = MES_MODE === "prod" ? MES_PROD_LOAD_URL : MES_TEST_LOAD_URL;

const MES_LOGIN = process.env.MES_LOGIN;
const MES_PASSWORD = process.env.MES_PASSWORD;
const SYS_CONTACT = process.env.MES_SYSTEM_CONTACT || "102";
const KD_CHANNEL = process.env.MES_CHANNEL || "3";
const KD_ORG = process.env.MES_ORG_CODE || "2";
const FACILITY_ID = process.env.MES_FACILITY_ID || "1";
const CAMPAIGN_TYPE = process.env.MES_CAMPAIGN_TYPE || "SETI_NOTICE";
const MES_REQUEST_LOG = String(process.env.MES_REQUEST_LOG || "1") !== "0";
const MES_AUTH_METHOD = normalizeHttpMethod(process.env.MES_AUTH_METHOD, "post");
const MES_AUTH_TIMEOUT_MS = readPositiveIntEnv("MES_AUTH_TIMEOUT_MS", 12000);
const MES_UPLOAD_TIMEOUT_MS = readPositiveIntEnv("MES_UPLOAD_TIMEOUT_MS", 30000);
const MES_RETRY_ATTEMPTS = readPositiveIntEnv("MES_RETRY_ATTEMPTS", 1);

function logMesEndpoints() {
  try {
    console.log(`[MES] mode=${MES_MODE}`);
    console.log(`[MES] AUTH_BASE: ${AUTH_BASE}`);
    console.log(`[MES] LOAD_BASE: ${LOAD_BASE}`);
  } catch (_) {}
}

module.exports = {
  AUTH_BASE,
  CAMPAIGN_TYPE,
  FACILITY_ID,
  KD_CHANNEL,
  KD_ORG,
  LOAD_BASE,
  MES_AUTH_METHOD,
  MES_AUTH_TIMEOUT_MS,
  MES_LOGIN,
  MES_MODE,
  MES_PASSWORD,
  MES_REQUEST_LOG,
  MES_RETRY_ATTEMPTS,
  MES_UPLOAD_TIMEOUT_MS,
  SYS_CONTACT,
  logMesEndpoints,
  normalizeHttpMethod,
};
