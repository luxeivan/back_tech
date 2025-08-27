const { exec } = require("node:child_process");
const express = require("express");

const router = express.Router();

// URL ЕДДС (фикс)
const EDDS_URL =
  "https://mvitu.arki.mosreg.ru/api/edds/api_incident/electricity/create.php";

// помощник: безопасно оборачиваем JSON для передачи в командную строку
function jsonForShell(data) {
  // делаем строку и экранируем одинарные кавычки для оболочки
  return JSON.stringify(data).replace(/'/g, `'\\''`);
}

router.post("/send", async (req, res) => {
  try {
    const token = process.env.EDDS_TOKEN; // возьмём из .env
    if (!token) {
      return res
        .status(500)
        .json({ ok: false, error: "EDDS_TOKEN не задан в .env" });
    }

    const payload = req.body ?? {};
    const jsonEscaped = jsonForShell(payload);

    // ВАЖНО: одинарные кавычки вокруг JSON и переменной токена,
    // --insecure оставляем, т.к. у них GOST/legacy TLS
    const command =
      `curl -sS -X POST ` +
      `-H "Content-Type: application/json" ` +
      `-H "HTTP-X-API-TOKEN: ${token}" ` +
      `-d '${jsonEscaped}' ` +
      `"${EDDS_URL}" --insecure`;

    exec(command, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        // Обычно сюда попадают ошибки оболочки/сети/серта
        return res.status(502).json({
          ok: false,
          error: "curl error",
          message: err.message,
          stderr: stderr?.toString(),
        });
      }

      // ЕДДС обычно отвечает JSON
      try {
        const parsed = JSON.parse(stdout);
        return res.json(parsed);
      } catch {
        // если вдруг не JSON — отдадим как есть
        return res.json({ raw: stdout?.toString() });
      }
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
