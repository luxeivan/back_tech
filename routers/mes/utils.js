const dayjs = require("dayjs");
const { MES_REQUEST_LOG } = require("./config");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withRetry(fn, { attempts = 3, baseDelay = 1200 } = {}) {
  let lastErr;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i === attempts) break;
      await sleep(baseDelay * i);
    }
  }
  throw lastErr;
}

function clean(v) {
  if (v === undefined || v === null || v === "" || v === "—") return null;
  return String(v);
}

function toIsoT(v) {
  if (!v) return null;
  const d = dayjs(v);
  return d.isValid() ? d.format("YYYY-MM-DD[T]HH:mm:ss") : null;
}

function maskSecret(v) {
  if (!v) return null;
  const s = String(v);
  if (s.length <= 4) return "****";
  return `${s.slice(0, 2)}***${s.slice(-2)}`;
}

function maskSession(v) {
  if (!v) return null;
  const s = String(v);
  if (s.length <= 10) return "********";
  return `${s.slice(0, 6)}***${s.slice(-4)}`;
}

function sanitizeMesResponse(data) {
  if (!data || typeof data !== "object") return data;
  const copy = JSON.parse(JSON.stringify(data));
  if (Array.isArray(copy.data)) {
    copy.data = copy.data.map((row) => {
      if (row && typeof row === "object" && row.session) {
        return { ...row, session: maskSession(row.session) };
      }
      return row;
    });
  }
  return copy;
}

function logMes(...args) {
  if (MES_REQUEST_LOG) console.log(...args);
}

function splitFirst(v) {
  const val = clean(v);
  if (!val) return null;
  return (
    val
      .split(/[;,]/)
      .map((s) => s.trim())
      .filter(Boolean)[0] || null
  );
}

function normalizeBaseType(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

module.exports = {
  clean,
  logMes,
  maskSecret,
  maskSession,
  normalizeBaseType,
  sanitizeMesResponse,
  splitFirst,
  toIsoT,
  withRetry,
};
