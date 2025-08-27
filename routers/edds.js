const { exec } = require("node:child_process");
const express = require("express");
const axios = require("axios");

const router = express.Router();

// URL ЕДДС (фикс)
const EDDS_URL =
  "https://mvitu.arki.mosreg.ru/api/edds/api_incident/electricity/create.php";

// помощник: безопасно оборачиваем JSON для передачи в командную строку
function jsonForShell(data) {
  // делаем строку и экранируем одинарные кавычки для оболочки
  return JSON.stringify(data).replace(/'/g, `'\\''`);
}

// helper: mask secret values in logs
function maskToken(t) {
  if (!t || typeof t !== "string") return "";
  if (t.length <= 8) return "****";
  return `${t.slice(0, 4)}…${t.slice(-4)}`;
}

// helper: clip long strings when logging stdout/stderr
function clipLog(s, limit = 1200) {
  if (!s) return "";
  const str = s.toString();
  return str.length > limit ? `${str.slice(0, limit)}… (${str.length}b)` : str;
}

router.post("/", async (req, res) => {
  const debug = String(req.query.debug || "").trim() === "1";
  const reqId = req.headers["x-request-id"] || "";
  const ip = req.ip || req.headers["x-forwarded-for"] || req.connection?.remoteAddress;

  // basic request log
  try {
    const size = Buffer.byteLength(JSON.stringify(req.body || {}));
    console.log(`[edds] --> POST /services/edds debug=${debug} ip=${ip} reqId=${reqId} size=${size}b`);
  } catch {
    console.log(`[edds] --> POST /services/edds debug=${debug} ip=${ip} reqId=${reqId} size=?`);
  }

  // --- auth: verify Strapi JWT from Authorization header ---
  const authHeader = req.headers["authorization"] || "";
  if (!authHeader) {
    return res.status(403).json({ ok: false, error: "Нет токена авторизации" });
  }
  try {
    await axios.get(`${process.env.URL_STRAPI}/api/users/me`, {
      headers: { Authorization: authHeader },
    });
  } catch (e) {
    console.log("[edds] auth failed:", e?.response?.status, e?.response?.data || e.message);
    return res.status(403).json({ ok: false, error: "Доступ запрещён" });
  }
  // --- end auth ---

  try {
    const token = process.env.EDDS_TOKEN; // возьмём из .env
    console.log(`[edds] EDDS_TOKEN present=${!!process.env.EDDS_TOKEN} value=${maskToken(process.env.EDDS_TOKEN || "")}`);
    if (!token) {
      return res
        .status(500)
        .json({ ok: false, error: "EDDS_TOKEN не задан в .env" });
    }

    const payload = req.body ?? {};
    const jsonEscaped = jsonForShell(payload);

    // safe preview of payload
    try {
      const preview = JSON.stringify(payload).slice(0, 400);
      console.log(`[edds] payload: ${preview}${preview.length === 400 ? "…" : ""}`);
    } catch (e) {
      console.log(`[edds] payload: <unprintable> ${e.message}`);
    }

    // note: do not log the full command with token; print a redacted version if debug
    if (debug) {
      console.log(`[edds] curl (redacted): curl -sS -X POST -H "Content-Type: application/json" -H "HTTP-X-API-TOKEN: ${maskToken(token)}" -d '<payload>' "${EDDS_URL}" --insecure`);
    }

    // ВАЖНО: одинарные кавычки вокруг JSON и переменной токена,
    // --insecure оставляем, т.к. у них GOST/legacy TLS
    const command =
      `curl -sS -X POST ` +
      `-H "Content-Type: application/json" ` +
      `-H "HTTP-X-API-TOKEN: ${token}" ` +
      `-d '${jsonEscaped}' ` +
      `"${EDDS_URL}" --insecure`;

    exec(command, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      console.log("[edds] RAW stdout:", stdout?.toString());
      // collect logs
      const outClip = clipLog(stdout);
      const errClip = clipLog(stderr);

      if (err) {
        // Usually shell/network/cert errors get here
        const code = err.code != null ? err.code : "unknown";
        console.error(`[edds] curl ERROR code=${code} stderr=${errClip}`);
        if (debug) console.error(`[edds] stdout=${outClip}`);
        return res.status(502).json({
          ok: false,
          error: "curl error",
          message: err.message,
          code,
          stderr: errClip,
          ...(debug ? { stdout: outClip } : {}),
        });
      }

      // success path — log short stdout
      console.log(`[edds] curl OK stdout=${outClip}`);
      console.log("[edds] RAW stdout:", stdout?.toString());

      // ЕДДС обычно отвечает JSON
      try {
        const parsed = JSON.parse(stdout);
        // If debug requested — include raw as well
        return res.json(debug ? { ...parsed, _raw: outClip } : parsed);
      } catch {
        // if not JSON — return raw
        return res.json({ raw: stdout?.toString() });
      }
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
