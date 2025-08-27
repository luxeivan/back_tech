const { exec } = require("node:child_process");
const express = require("express");
const axios = require("axios");

const router = express.Router();

const EDDS_URL = process.env.EDDS_URL;
const EDDS_TOKEN = process.env.EDDS_TOKEN;

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
    const jsonEscaped = jsonForShell(payload);

    if (debug) {
      console.log(
        `[ЕДДС] Выполняется curl (токен скрыт): curl -sS -X POST -H "Content-Type: application/json" -H "HTTP-X-API-TOKEN: ${maskToken(
          EDDS_TOKEN
        )}" -d '<payload>' "${EDDS_URL}" --insecure`
      );
    }

    const command =
      `curl -sS -X POST ` +
      `-H "Content-Type: application/json" ` +
      `-H "HTTP-X-API-TOKEN: ${EDDS_TOKEN}" ` +
      `-d '${jsonEscaped}' ` +
      `"${EDDS_URL}" --insecure`;

    exec(command, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      const outClip = clipLog(stdout);
      const errClip = clipLog(stderr);

      if (err) {
        const code = err.code != null ? err.code : "unknown";
        console.error(`[ЕДДС] Ошибка curl, код=${code}, stderr=${errClip}`);
        if (debug) console.error(`[ЕДДС] stdout=${outClip}`);
        return res.status(502).json({
          ok: false,
          error: "Ошибка при выполнении curl",
          message: err.message,
          code,
          stderr: errClip,
          ...(debug ? { stdout: outClip } : {}),
        });
      }

      console.log(`[ЕДДС] Ответ curl: ${outClip}`);

      try {
        const parsed = JSON.parse(stdout);
        console.log("[ЕДДС] Распарсенный ответ:", parsed);
        return res.json(debug ? { ...parsed, _raw: outClip } : parsed);
      } catch {
        return res.json({ raw: stdout?.toString() });
      }
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
