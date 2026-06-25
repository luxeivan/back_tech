const { exec } = require("node:child_process");
const express = require("express");
const axios = require("axios");
require("dotenv").config();
const { logAuditFromReq } = require("../services/auditLogger");
const { resolveAccidentLocation } = require("../services/edds/resolveAccidentLocation");

const router = express.Router();

/**
 * @swagger
 * /services/edds:
 *   post:
 *     summary: Отправка данных в ЕДДС (старый API)
 *     tags: ["EDDS"]
 *     parameters:
 *       - in: query
 *         name: debug
 *         schema:
 *           type: string
 *         description: Включить отладочный режим (debug=1)
 *       - in: query
 *         name: dry
 *         schema:
 *           type: string
 *         description: Тестовый прогон без реальной отправки (dry=1)
 *       - in: query
 *         name: mode
 *         schema:
 *           type: string
 *           enum: [create, update]
 *         description: Режим отправки
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *     responses:
 *       200:
 *         description: Результат отправки
 *       502:
 *         description: Ошибка ЕДДС
 */

const EDDS_URL = process.env.EDDS_URL;
const EDDS_TOKEN = process.env.EDDS_TOKEN;
const EDDS_URL_PUT = process.env.EDDS_URL_PUT;


// === Journal (Strapi) helpers =============================================
const URL_STRAPI = process.env.URL_STRAPI;
const LOGIN_STRAPI =
  process.env.LOGIN_STRAPI ||
  process.env.LOGIN_STRAPI ||
  process.env.LOGIN_STRAPI;
const PASSWORD_STRAPI =
  process.env.PASSWORD_STRAPI ||
  process.env.PASSWORD_STRAPI ||
  process.env.PASSWORD_STRAPI;

// Try to fetch TN number by GUID from Strapi when it's not provided in the payload
async function fetchTnNumberByGuid(guid, jwt) {
  if (!guid || !URL_STRAPI || !jwt) return null;

  const headers = { Authorization: `Bearer ${jwt}` };
  const tryGet = async (qs) => {
    const r = await axios.get(`${URL_STRAPI}${qs}`, { headers, timeout: 15000 });
    const entry = Array.isArray(r?.data?.data) && r.data.data[0] ? r.data.data[0] : null;
    if (!entry) return null;
    const n = entry.attributes?.number ?? entry.number;
    return (n !== undefined && n !== null && String(n).trim() !== "") ? String(n) : null;
  };

  try {
    // 1) Нормальный путь: по верхнеуровневому полю guid
    const qs1 =
      `/api/teh-narusheniyas?filters[guid][$eq]=${encodeURIComponent(guid)}&pagination[pageSize]=1`;
    const byGuid = await tryGet(qs1);
    if (byGuid) return byGuid;

    // 2) Фолбэк: некоторые старые записи не имеют верхнеуровневого guid,
    // пробуем строковый поиск по JSON-полю data (по сути ищем VIOLATION_GUID_STR)
    const qs2 =
      `/api/teh-narusheniyas?filters[data][$containsi]=${encodeURIComponent(guid)}&pagination[pageSize]=1`;
    const byJsonContains = await tryGet(qs2);
    if (byJsonContains) return byJsonContains;

    return null;
  } catch (e) {
    console.warn("[ЕДДС][journal] Не удалось получить номер ТН из Strapi:", e?.response?.status || e?.message);
    return null;
  }
}

// Get (or create) a SINGLE journal record and return its {id, documentId, list}
async function getOrCreateJournalSingle(jwt) {
  if (!URL_STRAPI || !jwt) return null;
  try {
    // Take the first existing record (we'll reuse it every time)
    const r = await axios.get(
      `${URL_STRAPI}/api/zhurnal-otpravkis?pagination[page]=1&pagination[pageSize]=1`,
      { headers: { Authorization: `Bearer ${jwt}` }, timeout: 15000 }
    );
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

    // Create a new empty record if none exists
    const c = await axios.post(
      `${URL_STRAPI}/api/zhurnal-otpravkis`,
      { data: { data: [] } },
      { headers: { Authorization: `Bearer ${jwt}` }, timeout: 15000 }
    );
    const id = c?.data?.data?.id;
    const documentId = c?.data?.data?.documentId || null;
    return id ? { id, documentId, list: [] } : null;
  } catch (e) {
    console.warn("[ЕДДС][journal] Не удалось получить/создать запись журнала:", e?.response?.status || e?.message);
    return null;
  }
}

// Append a single line to the single journal JSON array (kept to last 2000 entries)
async function appendToJournalSingle(line, jwt) {
  const rec = await getOrCreateJournalSingle(jwt);
  if (!rec) return;
  const MAX = 2000;
  const list = rec.list || [];
  list.push(line);
  while (list.length > MAX) list.shift();

  const targetId = rec.documentId || rec.id; // Prefer documentId in Strapi v5
  const urlBase = `${URL_STRAPI}/api/zhurnal-otpravkis`;

  try {
    await axios.put(
      `${urlBase}/${targetId}`,
      { data: { data: list } },
      { headers: { Authorization: `Bearer ${jwt}` }, timeout: 20000 }
    );
  } catch (e) {
    // Fallback: if we tried documentId and Strapi expects numeric id, try rec.id
    if (rec.documentId && rec.id && e?.response?.status === 404) {
      await axios.put(
        `${urlBase}/${rec.id}`,
        { data: { data: list } },
        { headers: { Authorization: `Bearer ${jwt}` }, timeout: 20000 }
      );
    } else {
      throw e;
    }
  }
}

async function getJwt() {
  try {
    const r = await axios.post(
      `${URL_STRAPI}/api/auth/local`,
      {
        identifier: LOGIN_STRAPI,
        password: PASSWORD_STRAPI,
      },
      { timeout: 15000 }
    );
    return r?.data?.jwt || null;
  } catch (e) {
    console.warn(
      "[ЕДДС][journal] Не получил JWT для Strapi:",
      e?.response?.status || e?.message
    );
    return null;
  }
}

function fmtRu(dt) {
  try {
    const d = dt ? new Date(dt) : new Date();
    // Форматируем строго в часовом поясе Москвы
    const s = d.toLocaleString("ru-RU", {
      timeZone: "Europe/Moscow",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    // toLocaleString для ru-RU возвращает строку вида "08.10.2025, 12:34:56"
    return s.replace(",", "");
  } catch {
    return "";
  }
}

async function writeJournal({ target, operation, reqBody, endpoint, result }) {
  try {
    const jwt = await getJwt();
    if (!jwt) return;

    const guid = reqBody?.incident_id || reqBody?._meta?.guid || null;

    let tnNumber = await fetchTnNumberByGuid(guid, jwt);

    const sentAt = new Date();
    const human = fmtRu(sentAt);

    // Compose message for journal
    let msg = "";
    if (result?.parsed) {
      if (typeof result.parsed.message === "string" && result.parsed.message.trim()) {
        msg = result.parsed.message.trim();
      } else if (result.parsed.success === true) {
        msg = "Данные приняты";
      } else if (result.parsed.success === false) {
        msg = "Ошибка";
      }
    } else if (typeof result?.stdout === "string" && /<html|<!DOCTYPE/i.test(result.stdout)) {
      msg = "HTML response from remote";
    } else if (result?.ok === false) {
      msg = "curl error";
    }

    const line = `№${tnNumber ?? "—"} - ${guid ?? "—"} - ${human} - ${target}${msg ? ` - ${msg}` : ""}`;

    // Append into a single JSON record (array of strings)
    try {
      await appendToJournalSingle(line, jwt);
      console.log("[ЕДДС][journal] запись добавлена:", line, result?.parsed?.success ? "(success)" : "(error)");
    } catch (e1) {
      console.warn("[ЕДДС][journal] append error:", e1?.response?.status || e1?.message);
    }
  } catch (e) {
    console.warn("[ЕДДС][journal] не удалось создать запись:", e?.response?.status, e?.message);
  }
}
// ===========================================================================

function jsonForShell(data) {
  return JSON.stringify(data).replace(/'/g, `'\\''`);
}

function maskToken(t) {
  if (!t || typeof t !== "string") return "";
  if (t.length <= 8) return "****";
  return `${t.slice(0, 4)}…${t.slice(-4)}`;
}

function pretty(obj) {
  try { return JSON.stringify(obj, null, 2); } catch { return String(obj); }
}

function logPayload(payload, { debug = false } = {}) {
  const p = payload || {};
  const keys = Object.keys(p);
  console.log(`\n${"─".repeat(60)}`);
  console.log(`  ЕДДС → payload  (${keys.length} полей)`);
  console.log(`${"─".repeat(60)}`);
  if (debug) {
    console.log(pretty(p));
  } else {
    const short = {};
    if (p.incident_id) short.incident_id = p.incident_id;
    if (p.type) short.type = p.type;
    if (p.status) short.status = p.status;
    if (p.district_id) short.district_id = p.district_id;
    if (p.time_create) short.time_create = p.time_create;
    if (p.mkd) short.mkdCount = p.mkd.length;
    if (p.involved_forces) short.involved_forces = p.involved_forces;
    console.log(pretty(short));
  }
  console.log(`${"─".repeat(60)}\n`);
}

function logResponse(resp, { url = "" } = {}) {
  if (resp.httpCode) {
    const icon = resp.httpCode >= 200 && resp.httpCode < 300 ? "✓" : "✗";
    console.log(`\n  ${icon} ЕДДС ← HTTP ${resp.httpCode}${url ? `  ${url}` : ""}`);
  } else if (resp.code) {
    console.log(`\n  ✗ ЕДДС ← curl error code=${resp.code}`);
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

function runCurl(url, payload, { debug } = {}) {
  return new Promise((resolve) => {
    try {
      const jsonEscaped = jsonForShell(payload);
      if (debug) {
        console.log(
          `[ЕДДС] curl -sS -X POST -H "Content-Type: application/json" ` +
          `-H "HTTP-X-API-TOKEN: ${maskToken(EDDS_TOKEN)}" -d '<payload>' "${url}" --insecure`
        );
      }
      const command =
        `curl -sS -X POST ` +
        `-H "Content-Type: application/json" ` +
        `-H "HTTP-X-API-TOKEN: ${EDDS_TOKEN}" ` +
        `-d '${jsonEscaped}' ` +
        `-w "\\nHTTP_CODE:%{http_code}" ` +
        `"${url}" --insecure`;

      exec(command, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          const code = err.code != null ? err.code : "unknown";
          console.error(`  ✗ ЕДДС ← curl error code=${code}`);
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

function isDuplicateError(resp) {
  try {
    const msg = String(
      (resp?.parsed && (resp.parsed.message || resp.parsed.error)) || resp?.stdout || ""
    );
    return /существует|уже существует/i.test(msg);
  } catch { return false; }
}

router.post("/", async (req, res) => {
  const startedAt = Date.now();
  res.on("finish", () => {
    setImmediate(() => {
      logAuditFromReq(req, {
        page: "/services/edds",
        action: "edds_send",
        entity: "tn",
        entity_id: String(req.body?.incident_id || req.body?.number || ""),
        details: {
          status: res.statusCode,
          duration_ms: Date.now() - startedAt,
          dry_run:
            String(req.query.dryRun || req.query.dry || "").trim() === "1",
        },
      }).catch(() => {});
    });
  });

  const debug = String(req.query.debug || "").trim() === "1";
  const dryRun = String(req.query.dryRun || req.query.dry || "").trim() === "1";
  const ip = req.ip || req.headers["x-forwarded-for"] || req.connection?.remoteAddress;

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  ЕДДС POST  dryRun=${dryRun}  ip=${ip}`);
  console.log(`${"═".repeat(60)}`);

  const authHeader = req.headers["authorization"] || "";
  if (!authHeader) {
    return res.status(403).json({ ok: false, error: "Нет токена авторизации" });
  }
  try {
    await axios.get(`${process.env.URL_STRAPI}/api/users/me`, {
      headers: { Authorization: authHeader },
    });
  } catch (e) {
    console.log("  ✗ Авторизация не пройдена:", e?.response?.status);
    return res.status(403).json({ ok: false, error: "Доступ запрещён" });
  }

  if (!EDDS_URL) return res.status(500).json({ ok: false, error: "EDDS_URL не задан в .env" });
  if (!EDDS_TOKEN && !dryRun) return res.status(500).json({ ok: false, error: "EDDS_TOKEN не задан в .env" });

  const payload = req.body ?? {};
  logPayload(payload, { debug });

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

  if (dryRun) {
    console.log("  DRY RUN — запрос не выполняется\n");
    return res.json({ ok: true, dryRun: true, debug, preview: payload });
  }

  try {
    const mode = String(req.query.mode || "").trim().toLowerCase();
    const forceUpdate = mode === "update" || String(req.query.update || "") === "1";
    const forceCreate = mode === "create" || String(req.query.create || "") === "1";

    if (forceUpdate && !EDDS_URL_PUT) {
      return res.status(500).json({ ok: false, error: "EDDS_URL_PUT не задан в .env" });
    }

    const primaryUrl = forceUpdate ? EDDS_URL_PUT || EDDS_URL : EDDS_URL;
    const fallbackUrl = !forceUpdate && !forceCreate && EDDS_URL_PUT ? EDDS_URL_PUT : null;

    const resp1 = await runCurl(primaryUrl, payload, { debug });

    if (!resp1.ok && !fallbackUrl) {
      logResponse(resp1, { url: primaryUrl });
      setImmediate(() => writeJournal({ target: "ЕДДС", operation: forceUpdate ? "update" : "create", reqBody: payload, endpoint: primaryUrl, result: resp1 }).catch(() => {}));
      return res.status(502).json({ ok: false, error: "Ошибка curl", code: resp1.code, stderr: resp1.stderr });
    }

    // Auto-fallback to update if duplicate
    if (resp1.ok && resp1.parsed?.success === false && fallbackUrl && isDuplicateError(resp1)) {
      console.log("  ⚡ Дубликат — пробуем update.php…");
      const resp2 = await runCurl(fallbackUrl, payload, { debug });
      logResponse(resp2, { url: fallbackUrl });

      setImmediate(() => writeJournal({ target: "ЕДДС", operation: "update", reqBody: payload, endpoint: fallbackUrl, result: resp2 }).catch(() => {}));

      if (!resp2.ok) {
        return res.status(502).json({ ok: false, error: "Ошибка curl (update)", code: resp2.code, stderr: resp2.stderr });
      }
      return res.json(debug ? { ...resp2.parsed, _via: "update" } : (resp2.parsed || { raw: resp2.stdout }));
    }

    logResponse(resp1, { url: primaryUrl });
    setImmediate(() => writeJournal({ target: "ЕДДС", operation: forceUpdate ? "update" : "create", reqBody: payload, endpoint: primaryUrl, result: resp1 }).catch(() => {}));
    return res.json(debug ? { ...resp1.parsed, _via: forceUpdate ? "update" : "create" } : (resp1.parsed || { raw: resp1.stdout }));
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
