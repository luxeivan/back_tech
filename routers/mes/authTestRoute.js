const express = require("express");
const {
  AUTH_BASE,
  MES_AUTH_METHOD,
  MES_AUTH_TIMEOUT_MS,
  MES_LOGIN,
  MES_MODE,
  MES_PASSWORD,
  normalizeHttpMethod,
} = require("./config");
const { makeAuthParams, mesAuthDiagnostic } = require("./authClient");
const { maskSecret, maskSession } = require("./utils");

const router = express.Router();

router.get("/", async (req, res) => {
  const startedAt = Date.now();
  const startedIso = new Date(startedAt).toISOString();
  const method = normalizeHttpMethod(req.query.method, MES_AUTH_METHOD);

  console.log("[МосЭнергоСбыт] Тест авторизации: старт");
  console.log(`[МосЭнергоСбыт] AUTH_BASE: ${AUTH_BASE || "не задан"}`);
  console.log(
    `[МосЭнергоСбыт] Режим диагностики: method=${method.toUpperCase()}, timeout=${MES_AUTH_TIMEOUT_MS}мс, retry=1`
  );
  console.log(
    `[МосЭнергоСбыт] Учетные данные: login=${MES_LOGIN || "не задан"}, password=${maskSecret(MES_PASSWORD) || "не задан"}`
  );

  try {
    const result = await mesAuthDiagnostic(method);
    const durationMs = Date.now() - startedAt;
    console.log(
      `[МосЭнергоСбыт] Тест авторизации: session получен успешно за ${durationMs}мс`
    );

    return res.json({
      ok: true,
      message: "Сессионный токен получен",
      session: maskSession(result.session),
      debug: {
        started_at: startedIso,
        duration_ms: durationMs,
        mode: MES_MODE,
        auth_url: AUTH_BASE,
        auth_method: method.toUpperCase(),
        timeout_ms: MES_AUTH_TIMEOUT_MS,
        retry_attempts: 1,
        credentials: {
          login: MES_LOGIN || null,
          password: maskSecret(MES_PASSWORD),
        },
        request: result.request,
        raw_response: result.raw,
      },
    });
  } catch (e) {
    const durationMs = Date.now() - startedAt;
    const status = e?.response?.status || 502;
    const details = e?.response?.data;

    console.error(
      `[МосЭнергоСбыт] Тест авторизации: ошибка через ${durationMs}мс - ${e?.message || "unknown"}`
    );
    if (e?.code) console.error(`[МосЭнергоСбыт] Код ошибки: ${e.code}`);
    if (details) {
      try {
        console.error(
          `[МосЭнергоСбыт] Ответ внешней системы: ${JSON.stringify(details)}`
        );
      } catch (_) {
        console.error("[МосЭнергоСбыт] Ответ внешней системы не удалось сериализовать");
      }
    }

    return res.status(status).json({
      ok: false,
      message: e?.message || "Ошибка авторизации в МосЭнергоСбыт",
      code: e?.code || null,
      details,
      debug: {
        started_at: startedIso,
        duration_ms: durationMs,
        auth_url: AUTH_BASE,
        timeout_ms: MES_AUTH_TIMEOUT_MS,
        retry_attempts: 1,
        credentials: {
          login: MES_LOGIN || null,
          password: maskSecret(MES_PASSWORD),
        },
        request: {
          method: method.toUpperCase(),
          url: AUTH_BASE,
          query: makeAuthParams(true),
          timeout_ms: MES_AUTH_TIMEOUT_MS,
        },
        http_status: e?.response?.status || null,
      },
    });
  }
});

module.exports = router;
