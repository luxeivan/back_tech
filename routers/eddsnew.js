const { exec } = require("node:child_process");
const express = require("express");
const axios = require("axios");
require("dotenv").config();
const { logAuditFromReq } = require("../services/auditLogger");
const { resolveAccidentLocation } = require("../services/edds/resolveAccidentLocation");

const router = express.Router();

const EDDS_NEW_BASE_URL = process.env.EDDS_NEW_BASE_URL;
const EDDS_TOKEN = process.env.EDDS_TOKEN;
const URL_STRAPI = process.env.URL_STRAPI;
const LOGIN_STRAPI = process.env.LOGIN_STRAPI;
const PASSWORD_STRAPI = process.env.PASSWORD_STRAPI;

function pretty(obj) {
  try { return JSON.stringify(obj, null, 2); } catch { return String(obj); }
}

function logPayload(payload, { debug = false } = {}) {
  const p = payload || {};
  const keys = Object.keys(p);
  console.log(`\n${"─".repeat(60)}`);
  console.log(`  ЕДДС-NEW → payload  (${keys.length} полей)`);
  console.log(`${"─".repeat(60)}`);
  if (debug) {
    console.log(pretty(p));
  } else {
    const short = {};
    if (p.districtFiasIds) short.districtFiasIds = p.districtFiasIds;
    if (p.equipmentType) short.equipmentType = p.equipmentType;
    if (p.equipmentName) short.equipmentName = p.equipmentName;
    if (p.accidentLocation) short.accidentLocation = p.accidentLocation;
    if (p.shutdownInfo) {
      short.shutdownInfo = {
        shutdownType: p.shutdownInfo.shutdownType,
        deenergizedType: p.shutdownInfo.deenergizedType,
        disabledAt: p.shutdownInfo.disabledAt,
        plannedInclusionAt: p.shutdownInfo.plannedInclusionAt,
        reasons: p.shutdownInfo.reasons,
        fiasCount: p.shutdownInfo.fiasIds?.length,
      };
    }
    if (p.affectedObjectsCount) short.affectedObjectsCount = p.affectedObjectsCount;
    if (p.comment?.text) short.commentLength = p.comment.text.length;
    console.log(pretty(short));
  }
  console.log(`${"─".repeat(60)}\n`);
}

function logResponse(resp, { url = "" } = {}) {
  if (resp.httpCode) {
    const icon = resp.httpCode >= 200 && resp.httpCode < 300 ? "✓" : "✗";
    console.log(`\n  ${icon} ЕДДС-NEW ← HTTP ${resp.httpCode}${url ? `  ${url}` : ""}`);
  } else if (resp.code) {
    console.log(`\n  ✗ ЕДДС-NEW ← curl error code=${resp.code}`);
    if (resp.stderr) console.log(`    ${resp.stderr}`);
  }
  if (resp.parsed) {
    console.log(`  Ответ ЕДДС:`);
    console.log(pretty(resp.parsed));
  } else if (resp.stdout) {
    console.log(`  Raw: ${resp.stdout}`);
  }
  console.log();
}

function runCurl(url, payload, { method = "POST", debug = {} } = {}) {
  return new Promise((resolve) => {
    try {
      const jsonEscaped = JSON.stringify(payload).replace(/'/g, `'\\''`);
      const authHeader = `Service: ${EDDS_TOKEN}`;
      if (debug) {
        console.log(`[ЕДДС-NEW] curl -X ${method} "${url}"`);
      }
      const command =
        `curl -sS -X ${method} ` +
        `-H "Content-Type: application/json" ` +
        `-H "Authorization: ${authHeader}" ` +
        `-d '${jsonEscaped}' ` +
        `-w "\\nHTTP_CODE:%{http_code}" ` +
        `"${url}" --insecure`;

      exec(command, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          const code = err.code != null ? err.code : "unknown";
          console.error(`  ✗ ЕДДС-NEW ← curl error code=${code}`);
          if (stderr) console.error(`    ${stderr}`);
          if (debug && stdout) console.log(`    stdout: ${stdout}`);
          return resolve({ ok: false, code, stdout: stdout || "", stderr: stderr || "" });
        }

        let httpCode = null;
        let body = stdout;
        const codeMatch = stdout.match(/\nHTTP_CODE:(\d+)/);
        if (codeMatch) {
          httpCode = Number(codeMatch[1]);
          body = stdout.slice(0, codeMatch.index).trim();
        }

        let parsed = null;
        try { parsed = JSON.parse(body); } catch { /* raw */ }

        resolve({ ok: true, httpCode, parsed, stdout: body });
      });
    } catch (e) {
      return resolve({ ok: false, error: e.message });
    }
  });
}

// ─── POST — create ─────────────────────────────────────────────────────────
router.post("/", async (req, res) => {
  const debug = String(req.query.debug || "").trim() === "1";
  const ip = req.ip || req.headers["x-forwarded-for"] || req.connection?.remoteAddress;

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  ЕДДС-NEW POST  ip=${ip}`);
  console.log(`${"═".repeat(60)}`);

  if (!EDDS_NEW_BASE_URL) return res.status(500).json({ ok: false, error: "EDDS_NEW_BASE_URL не задан в .env" });
  if (!EDDS_TOKEN) return res.status(500).json({ ok: false, error: "EDDS_TOKEN не задан в .env" });

  const payload = req.body ?? {};
  logPayload(payload, { debug });

  // accidentLocation — optional, non-blocking
  try {
    const locationResult = await resolveAccidentLocation(payload);
    if (locationResult.ok) {
      payload.accidentLocation = locationResult.accidentLocation;
      console.log(`  📍 accidentLocation: ${JSON.stringify(locationResult.accidentLocation)} (${locationResult.resolvedCount}/${locationResult.totalFias} FIAS)`);
    } else {
      console.log(`  ⚠ accidentLocation: ${locationResult.message} — отправка продолжается`);
    }
  } catch (e) {
    console.log(`  ⚠ accidentLocation error: ${e?.message} — отправка продолжается`);
  }

  const url = `${EDDS_NEW_BASE_URL}/edds/external/requests/electricity`;
  const resp = await runCurl(url, payload, { method: "POST", debug });
  logResponse(resp, { url });

  // Save request ID for future updates
  const requestId = resp.parsed?.data?.id || null;
  if (requestId) {
    console.log(`  💾 edds_electricityRequestId: ${requestId}`);
  }

  setImmediate(() => writeJournal({ operation: "create", reqBody: payload, result: resp }).catch(() => {}));

  if (!resp.ok) {
    return res.status(502).json({ ok: false, error: "Ошибка curl", code: resp.code, stderr: resp.stderr });
  }

  return res.json({ ok: true, httpCode: resp.httpCode, data: resp.parsed?.data || null, requestId });
});

// ─── PUT — update ──────────────────────────────────────────────────────────
router.put("/:requestId", async (req, res) => {
  const { requestId } = req.params;
  const debug = String(req.query.debug || "").trim() === "1";
  const ip = req.ip || req.headers["x-forwarded-for"] || req.connection?.remoteAddress;

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  ЕДДС-NEW PUT  requestId=${requestId}  ip=${ip}`);
  console.log(`${"═".repeat(60)}`);

  if (!EDDS_NEW_BASE_URL) return res.status(500).json({ ok: false, error: "EDDS_NEW_BASE_URL не задан в .env" });
  if (!EDDS_TOKEN) return res.status(500).json({ ok: false, error: "EDDS_TOKEN не задан в .env" });

  const payload = req.body ?? {};
  logPayload(payload, { debug });

  const url = `${EDDS_NEW_BASE_URL}/edds/external/requests/electricity/${requestId}`;
  const resp = await runCurl(url, payload, { method: "PUT", debug });
  logResponse(resp, { url });

  setImmediate(() => writeJournal({ operation: "update", reqBody: { ...payload, _requestId: requestId }, result: resp }).catch(() => {}));

  if (!resp.ok) {
    return res.status(502).json({ ok: false, error: "Ошибка curl", code: resp.code, stderr: resp.stderr });
  }

  return res.json({ ok: true, httpCode: resp.httpCode, data: resp.parsed?.data || null });
});

// ─── Journal helpers ────────────────────────────────────────────────────────
async function fetchTnNumberByGuid(guid, jwt) {
  if (!guid || !URL_STRAPI || !jwt) return null;
  const headers = { Authorization: `Bearer ${jwt}` };
  const tryGet = async (qs) => {
    const r = await axios.get(`${URL_STRAPI}${qs}`, { headers, timeout: 15000 });
    const entry = Array.isArray(r?.data?.data) && r.data.data[0] ? r.data.data[0] : null;
    if (!entry) return null;
    const n = entry.attributes?.number ?? entry.number;
    return (n != null && String(n).trim() !== "") ? String(n) : null;
  };

  try {
    const byGuid = await tryGet(`/api/teh-narusheniyas?filters[guid][$eq]=${encodeURIComponent(guid)}&pagination[pageSize]=1`);
    if (byGuid) return byGuid;
    return await tryGet(`/api/teh-narusheniyas?filters[data][$containsi]=${encodeURIComponent(guid)}&pagination[pageSize]=1`);
  } catch { return null; }
}

async function getJwt() {
  try {
    const r = await axios.post(`${URL_STRAPI}/api/auth/local`, {
      identifier: LOGIN_STRAPI, password: PASSWORD_STRAPI,
    }, { timeout: 15000 });
    return r?.data?.jwt || null;
  } catch { return null; }
}

function fmtRu(dt) {
  try {
    const d = dt ? new Date(dt) : new Date();
    return d.toLocaleString("ru-RU", {
      timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    }).replace(",", "");
  } catch { return ""; }
}

async function getOrCreateJournalSingle(jwt) {
  if (!URL_STRAPI || !jwt) return null;
  try {
    const r = await axios.get(`${URL_STRAPI}/api/zhurnal-otpravkis?pagination[page]=1&pagination[pageSize]=1`, {
      headers: { Authorization: `Bearer ${jwt}` }, timeout: 15000,
    });
    const arr = r?.data?.data || [];
    if (arr.length > 0) {
      const item = arr[0];
      const id = item.id;
      const documentId = item.documentId || item.documentID || item.document_id || null;
      const dataField = item.data ?? item.attributes?.data;
      let list = [];
      if (Array.isArray(dataField)) list = dataField.slice();
      else if (typeof dataField === "string") list = [dataField];
      else if (dataField && typeof dataField === "object" && Array.isArray(dataField.lines)) list = dataField.lines.slice();
      return { id, documentId, list };
    }
    const c = await axios.post(`${URL_STRAPI}/api/zhurnal-otpravkis`, { data: { data: [] } }, {
      headers: { Authorization: `Bearer ${jwt}` }, timeout: 15000,
    });
    const id = c?.data?.data?.id;
    const documentId = c?.data?.data?.documentId || null;
    return id ? { id, documentId, list: [] } : null;
  } catch { return null; }
}

async function appendToJournalSingle(line, jwt) {
  const rec = await getOrCreateJournalSingle(jwt);
  if (!rec) return;
  const MAX = 2000;
  const list = rec.list || [];
  list.push(line);
  while (list.length > MAX) list.shift();

  const targetId = rec.documentId || rec.id;
  const urlBase = `${URL_STRAPI}/api/zhurnal-otpravkis`;

  try {
    await axios.put(`${urlBase}/${targetId}`, { data: { data: list } }, {
      headers: { Authorization: `Bearer ${jwt}` }, timeout: 20000,
    });
  } catch (e) {
    if (rec.documentId && rec.id && e?.response?.status === 404) {
      await axios.put(`${urlBase}/${rec.id}`, { data: { data: list } }, {
        headers: { Authorization: `Bearer ${jwt}` }, timeout: 20000,
      });
    } else {
      throw e;
    }
  }
}

async function writeJournal({ operation, reqBody, result }) {
  try {
    const jwt = await getJwt();
    if (!jwt) return;

    const guid = reqBody?.incident_id || reqBody?._meta?.guid || null;
    const tnNumber = await fetchTnNumberByGuid(guid, jwt);
    const human = fmtRu(new Date());

    let msg = "";
    if (result?.parsed) {
      if (typeof result.parsed.message === "string" && result.parsed.message.trim()) {
        msg = result.parsed.message.trim();
      } else if (result.parsed.success === true) {
        msg = "Данные приняты";
      } else if (result.parsed.success === false) {
        msg = "Ошибка";
      }
    } else if (result?.ok === false) {
      msg = "curl error";
    }

    const line = `[NEW-v2] №${tnNumber ?? "—"} - ${guid ?? "—"} - ${human} - ${operation}${msg ? ` - ${msg}` : ""}`;

    try {
      await appendToJournalSingle(line, jwt);
    } catch {}
  } catch {}
}

module.exports = router;
