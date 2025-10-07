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
    const d = new Date(dt);
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(d.getDate())}.${pad(
      d.getMonth() + 1
    )}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(
      d.getSeconds()
    )}`;
  } catch {
    return new Date().toISOString();
  }
}

async function writeJournal({ target, operation, reqBody, endpoint, result }) {
  try {
    const jwt = await getJwt();
    if (!jwt) return;

    const guid = reqBody?.incident_id || reqBody?._meta?.guid || null;
    const tnNumber =
      reqBody?._meta?.tn_number ||
      reqBody?.NUMBER ||
      reqBody?.RAW?.F81_010_NUMBER ||
      null;

    const sentAt = new Date();
    const human = fmtRu(sentAt);

    const success = Boolean(
      result?.parsed?.success === true || (result?.ok && !result?.parsed)
    );
    const claimId = result?.parsed?.data?.claim_id ?? null;
    const message = result?.parsed?.message || (success ? "OK" : "Ошибка");

    const display = `№${tnNumber ?? "—"} - ${
      guid ?? "—"
    } - ${human} - ${target}${operation ? ` (${operation})` : ""}`;

    const payload = {
      display,
      guid,
      tnNumber,
      target,
      operation,
      endpoint,
      sentAt: sentAt.toISOString(),
      success,
      claimId,
      message,
      request: reqBody,
      response: result?.parsed || { raw: result?.stdout || null },
    };

    await axios.post(
      `${URL_STRAPI}/api/zhurnal-otpravkis`,
      { data: { data: payload } },
      {
        headers: { Authorization: `Bearer ${jwt}` },
        timeout: 15000,
      }
    );
    console.log("[ЕДДС][journal] запись создана:", display);
  } catch (e) {
    console.warn(
      "[ЕДДС][journal] не удалось создать запись:",
      e?.response?.status,
      e?.message
    );
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
      // log failure to journal
      writeJournal({
        target: "ЕДДС",
        operation: forceUpdate ? "update" : "create",
        reqBody: payload,
        endpoint: primaryUrl,
        result: resp1,
      }).catch(() => {});
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
        writeJournal({
          target: "ЕДДС",
          operation: "update",
          reqBody: payload,
          endpoint: fallbackUrl,
          result: resp2,
        }).catch(() => {});
        return res.status(502).json({
          ok: false,
          error: "Ошибка при выполнении curl (update)",
          code: resp2.code,
          stderr: resp2.stderr,
          ...(debug ? { stdout: resp2.stdout } : {}),
        });
      }

      writeJournal({
        target: "ЕДДС",
        operation: "update",
        reqBody: payload,
        endpoint: fallbackUrl,
        result: resp2,
      }).catch(() => {});

      const out2 = resp2.parsed || { raw: resp2.stdout };
      return res.json(debug ? { ...out2, _via: "update" } : out2);
    }

    writeJournal({
      target: "ЕДДС",
      operation: forceUpdate ? "update" : "create",
      reqBody: payload,
      endpoint: primaryUrl,
      result: resp1,
    }).catch(() => {});

    const out1 = (resp1 && (resp1.parsed || { raw: resp1.stdout })) || {
      ok: false,
    };
    return res.json(
      debug ? { ...out1, _via: forceUpdate ? "update" : "create" } : out1
    );
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
