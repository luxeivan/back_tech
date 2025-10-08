const { exec } = require("node:child_process");
const express = require("express");
const axios = require("axios");
require("dotenv").config();

const router = express.Router();

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

function clipLog(s, limit = 1500) {
  if (!s) return "";
  const str = s.toString();
  return str.length > limit
    ? `${str.slice(0, limit)}… (${str.length} символов)`
    : str;
}

function runCurl(url, payload, { debug } = {}) {
  return new Promise((resolve) => {
    try {
      const jsonEscaped = jsonForShell(payload);
      if (debug) {
        console.log(
          `[ЕДДС] Выполняется curl (токен скрыт): curl -sS -X POST -H "Content-Type: application/json" -H "HTTP-X-API-TOKEN: ${maskToken(
            EDDS_TOKEN
          )}" -d '<payload>' "${url}" --insecure`
        );
      }
      const command =
        `curl -sS -X POST ` +
        `-H "Content-Type: application/json" ` +
        `-H "HTTP-X-API-TOKEN: ${EDDS_TOKEN}" ` +
        `-d '${jsonEscaped}' ` +
        `"${url}" --insecure`;

      exec(command, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
        const outClip = clipLog(stdout);
        const errClip = clipLog(stderr);

        if (err) {
          const code = err.code != null ? err.code : "unknown";
          console.error(`[ЕДДС] Ошибка curl, код=${code}, stderr=${errClip}`);
          if (debug) console.error(`[ЕДДС] stdout=${outClip}`);
          return resolve({
            ok: false,
            code,
            stdout: outClip,
            stderr: errClip,
          });
        }

        console.log(`[ЕДДС] Ответ curl: ${outClip}`);
        let parsed = null;
        try {
          parsed = JSON.parse(stdout);
          console.log("[ЕДДС] Распарсенный ответ:", parsed);
        } catch {
          /* raw only */
        }
        return resolve({ ok: true, parsed, stdout: outClip });
      });
    } catch (e) {
      return resolve({ ok: false, error: e.message });
    }
  });
}

function isDuplicateError(resp) {
  try {
    const msg = String(
      (resp && resp.parsed && (resp.parsed.message || resp.parsed.error)) ||
        resp?.stdout ||
        ""
    );
    return /существует|уже существует/i.test(msg);
  } catch {
    return false;
  }
}

router.post("/", async (req, res) => {
  const debug = String(req.query.debug || "").trim() === "1";
  const dryRun = String(req.query.dryRun || req.query.dry || "").trim() === "1";
  const reqId = req.headers["x-request-id"] || "";
  const ip =
    req.ip || req.headers["x-forwarded-for"] || req.connection?.remoteAddress;

  try {
    const size = Buffer.byteLength(JSON.stringify(req.body || {}));
    console.log(
      `[ЕДДС] Запрос POST /services/edds debug=${debug} dryRun=${dryRun} ip=${ip} reqId=${reqId} размер=${size} байт`
    );
  } catch {
    console.log(
      `[ЕДДС] Запрос POST /services/edds debug=${debug} dryRun=${dryRun} ip=${ip} reqId=${reqId} размер=?`
    );
  }

  const authHeader = req.headers["authorization"] || "";
  if (!authHeader) {
    return res.status(403).json({ ok: false, error: "Нет токена авторизации" });
  }
  try {
    await axios.get(`${process.env.URL_STRAPI}/api/users/me`, {
      headers: { Authorization: authHeader },
    });
  } catch (e) {
    console.log(
      "[ЕДДС] Ошибка авторизации:",
      e?.response?.status,
      e?.response?.data || e.message
    );
    return res.status(403).json({ ok: false, error: "Доступ запрещён" });
  }

  if (!EDDS_URL) {
    return res
      .status(500)
      .json({ ok: false, error: "EDDS_URL не задан в .env" });
  }
  if (!EDDS_TOKEN && !dryRun) {
    return res
      .status(500)
      .json({ ok: false, error: "EDDS_TOKEN не задан в .env" });
  }

  const payload = req.body ?? {};

  try {
    const rawStr = JSON.stringify(payload, null, 2);
    console.log(
      `[ЕДДС] Входящий JSON (${Buffer.byteLength(
        rawStr,
        "utf8"
      )} байт):\n${rawStr}`
    );
  } catch (e) {
    console.log(`[ЕДДС] Входящий JSON не читается: ${e.message}`);
  }

  if (dryRun) {
    console.log(`[ЕДДС] Режим DRY RUN — внешний запрос не выполняется`);
    return res.json({ ok: true, dryRun: true, debug, preview: payload });
  }

  try {
    const mode = String(req.query.mode || "")
      .trim()
      .toLowerCase();
    const forceUpdate =
      mode === "update" || String(req.query.update || "") === "1";
    const forceCreate =
      mode === "create" || String(req.query.create || "") === "1";

    if (forceUpdate && !EDDS_URL_PUT) {
      return res
        .status(500)
        .json({ ok: false, error: "EDDS_URL_PUT не задан в .env" });
    }

    const primaryUrl = forceUpdate ? EDDS_URL_PUT || EDDS_URL : EDDS_URL;
    const fallbackUrl =
      !forceUpdate && !forceCreate && EDDS_URL_PUT ? EDDS_URL_PUT : null;

    // Первый вызов: обычно create.php (или сразу update.php при принудительном режиме)
    const resp1 = await runCurl(primaryUrl, payload, { debug });


    // Если exec упал — отдаём 502
    if (!resp1.ok && !fallbackUrl) {
      // journal async, do not block
      setImmediate(() => {
        writeJournal({
          target: "ЕДДС",
          operation: forceUpdate ? "update" : "create",
          reqBody: payload,
          endpoint: primaryUrl,
          result: resp1,
        }).catch(() => {});
      });
      return res.status(502).json({
        ok: false,
        error: "Ошибка при выполнении curl",
        code: resp1.code,
        stderr: resp1.stderr,
        ...(debug ? { stdout: resp1.stdout } : {}),
      });
    }

    // Авто‑фоллбек: если create вернул "уже существует" — пробуем update.php
    if (
      resp1.ok &&
      resp1.parsed &&
      resp1.parsed.success === false &&
      fallbackUrl &&
      isDuplicateError(resp1)
    ) {
      console.log(
        "[ЕДДС] Похоже, инцидент уже существует — пробуем update.php…"
      );
      const resp2 = await runCurl(fallbackUrl, payload, { debug });

      if (!resp2.ok) {
        setImmediate(() => {
          writeJournal({
            target: "ЕДДС",
            operation: "update",
            reqBody: payload,
            endpoint: fallbackUrl,
            result: resp2,
          }).catch(() => {});
        });
        return res.status(502).json({
          ok: false,
          error: "Ошибка при выполнении curl (update)",
          code: resp2.code,
          stderr: resp2.stderr,
          ...(debug ? { stdout: resp2.stdout } : {}),
        });
      }

      setImmediate(() => {
        writeJournal({
          target: "ЕДДС",
          operation: "update",
          reqBody: payload,
          endpoint: fallbackUrl,
          result: resp2,
        }).catch(() => {});
      });

      const out2 = resp2.parsed || { raw: resp2.stdout };
      return res.json(debug ? { ...out2, _via: "update" } : out2);
    }

    const out1 = (resp1 && (resp1.parsed || { raw: resp1.stdout })) || { ok: false };
    // journal async, after we have a result; do not block response
    setImmediate(() => {
      writeJournal({
        target: "ЕДДС",
        operation: forceUpdate ? "update" : "create",
        reqBody: payload,
        endpoint: primaryUrl,
        result: resp1,
      }).catch(() => {});
    });
    return res.json(debug ? { ...out1, _via: forceUpdate ? "update" : "create" } : out1);
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;

// const { exec } = require("node:child_process");
// const express = require("express");
// const axios = require("axios");

// const router = express.Router();

// const EDDS_URL = process.env.EDDS_URL;
// const EDDS_TOKEN = process.env.EDDS_TOKEN;
// const EDDS_URL_PUT = process.env.EDDS_URL_PUT;

// function jsonForShell(data) {
//   return JSON.stringify(data).replace(/'/g, `'\\''`);
// }

// function maskToken(t) {
//   if (!t || typeof t !== "string") return "";
//   if (t.length <= 8) return "****";
//   return `${t.slice(0, 4)}…${t.slice(-4)}`;
// }

// function clipLog(s, limit = 1500) {
//   if (!s) return "";
//   const str = s.toString();
//   return str.length > limit
//     ? `${str.slice(0, limit)}… (${str.length} символов)`
//     : str;
// }

// function runCurl(url, payload, { debug } = {}) {
//   return new Promise((resolve) => {
//     try {
//       const jsonEscaped = jsonForShell(payload);
//       if (debug) {
//         console.log(
//           `[ЕДДС] Выполняется curl (токен скрыт): curl -sS -X POST -H "Content-Type: application/json" -H "HTTP-X-API-TOKEN: ${maskToken(
//             EDDS_TOKEN
//           )}" -d '<payload>' "${url}" --insecure`
//         );
//       }
//       const command =
//         `curl -sS -X POST ` +
//         `-H "Content-Type: application/json" ` +
//         `-H "HTTP-X-API-TOKEN: ${EDDS_TOKEN}" ` +
//         `-d '${jsonEscaped}' ` +
//         `"${url}" --insecure`;

//       exec(command, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
//         const outClip = clipLog(stdout);
//         const errClip = clipLog(stderr);

//         if (err) {
//           const code = err.code != null ? err.code : "unknown";
//           console.error(`[ЕДДС] Ошибка curl, код=${code}, stderr=${errClip}`);
//           if (debug) console.error(`[ЕДДС] stdout=${outClip}`);
//           return resolve({
//             ok: false,
//             code,
//             stdout: outClip,
//             stderr: errClip,
//           });
//         }

//         console.log(`[ЕДДС] Ответ curl: ${outClip}`);
//         let parsed = null;
//         try {
//           parsed = JSON.parse(stdout);
//           console.log("[ЕДДС] Распарсенный ответ:", parsed);
//         } catch {
//           /* raw only */
//         }
//         return resolve({ ok: true, parsed, stdout: outClip });
//       });
//     } catch (e) {
//       return resolve({ ok: false, error: e.message });
//     }
//   });
// }

// function isDuplicateError(resp) {
//   try {
//     const msg = String(
//       (resp && resp.parsed && (resp.parsed.message || resp.parsed.error)) ||
//         resp?.stdout ||
//         ""
//     );
//     return /существует|уже существует/i.test(msg);
//   } catch {
//     return false;
//   }
// }

// router.post("/", async (req, res) => {
//   const debug = String(req.query.debug || "").trim() === "1";
//   const dryRun = String(req.query.dryRun || req.query.dry || "").trim() === "1";
//   const reqId = req.headers["x-request-id"] || "";
//   const ip =
//     req.ip || req.headers["x-forwarded-for"] || req.connection?.remoteAddress;

//   try {
//     const size = Buffer.byteLength(JSON.stringify(req.body || {}));
//     console.log(
//       `[ЕДДС] Запрос POST /services/edds debug=${debug} dryRun=${dryRun} ip=${ip} reqId=${reqId} размер=${size} байт`
//     );
//   } catch {
//     console.log(
//       `[ЕДДС] Запрос POST /services/edds debug=${debug} dryRun=${dryRun} ip=${ip} reqId=${reqId} размер=?`
//     );
//   }

//   const authHeader = req.headers["authorization"] || "";
//   if (!authHeader) {
//     return res.status(403).json({ ok: false, error: "Нет токена авторизации" });
//   }
//   try {
//     await axios.get(`${process.env.URL_STRAPI}/api/users/me`, {
//       headers: { Authorization: authHeader },
//     });
//   } catch (e) {
//     console.log(
//       "[ЕДДС] Ошибка авторизации:",
//       e?.response?.status,
//       e?.response?.data || e.message
//     );
//     return res.status(403).json({ ok: false, error: "Доступ запрещён" });
//   }

//   if (!EDDS_URL) {
//     return res
//       .status(500)
//       .json({ ok: false, error: "EDDS_URL не задан в .env" });
//   }
//   if (!EDDS_TOKEN && !dryRun) {
//     return res
//       .status(500)
//       .json({ ok: false, error: "EDDS_TOKEN не задан в .env" });
//   }

//   const payload = req.body ?? {};

//   try {
//     const rawStr = JSON.stringify(payload, null, 2);
//     console.log(
//       `[ЕДДС] Входящий JSON (${Buffer.byteLength(
//         rawStr,
//         "utf8"
//       )} байт):\n${rawStr}`
//     );
//   } catch (e) {
//     console.log(`[ЕДДС] Входящий JSON не читается: ${e.message}`);
//   }

//   if (dryRun) {
//     console.log(`[ЕДДС] Режим DRY RUN — внешний запрос не выполняется`);
//     return res.json({ ok: true, dryRun: true, debug, preview: payload });
//   }

//   try {
//     const mode = String(req.query.mode || "").trim().toLowerCase();
//     const forceUpdate = mode === "update" || String(req.query.update || "") === "1";
//     const forceCreate = mode === "create" || String(req.query.create || "") === "1";

//     if (forceUpdate && !EDDS_URL_PUT) {
//       return res.status(500).json({ ok: false, error: "EDDS_URL_PUT не задан в .env" });
//     }

//     const primaryUrl = forceUpdate ? (EDDS_URL_PUT || EDDS_URL) : EDDS_URL;
//     const fallbackUrl = !forceUpdate && !forceCreate && EDDS_URL_PUT ? EDDS_URL_PUT : null;

//     // Первый вызов: обычно create.php (или сразу update.php при принудительном режиме)
//     const resp1 = await runCurl(primaryUrl, payload, { debug });

//     // Если exec упал — отдаём 502
//     if (!resp1.ok && !fallbackUrl) {
//       return res.status(502).json({
//         ok: false,
//         error: "Ошибка при выполнении curl",
//         code: resp1.code,
//         stderr: resp1.stderr,
//         ...(debug ? { stdout: resp1.stdout } : {}),
//       });
//     }

//     // Авто‑фоллбек: если create вернул "уже существует" — пробуем update.php
//     if (
//       resp1.ok &&
//       resp1.parsed &&
//       resp1.parsed.success === false &&
//       fallbackUrl &&
//       isDuplicateError(resp1)
//     ) {
//       console.log("[ЕДДС] Похоже, инцидент уже существует — пробуем update.php…");
//       const resp2 = await runCurl(fallbackUrl, payload, { debug });

//       if (!resp2.ok) {
//         return res.status(502).json({
//           ok: false,
//           error: "Ошибка при выполнении curl (update)",
//           code: resp2.code,
//           stderr: resp2.stderr,
//           ...(debug ? { stdout: resp2.stdout } : {}),
//         });
//       }

//       const out2 = resp2.parsed || { raw: resp2.stdout };
//       return res.json(debug ? { ...out2, _via: "update" } : out2);
//     }

//     // Иначе — отдаём ответ первого вызова
//     const out1 = (resp1 && (resp1.parsed || { raw: resp1.stdout })) || { ok: false };
//     return res.json(debug ? { ...out1, _via: forceUpdate ? "update" : "create" } : out1);
//   } catch (e) {
//     return res.status(500).json({ ok: false, error: e.message });
//   }
// });

// module.exports = router;
