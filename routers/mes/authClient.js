const axios = require("axios");
const {
  AUTH_BASE,
  MES_AUTH_METHOD,
  MES_AUTH_TIMEOUT_MS,
  MES_LOGIN,
  MES_MODE,
  MES_PASSWORD,
  MES_RETRY_ATTEMPTS,
  normalizeHttpMethod,
} = require("./config");
const {
  logMes,
  maskSecret,
  sanitizeMesResponse,
  withRetry,
} = require("./utils");

function makeAuthParams(masked = false) {
  return {
    action: "auth",
    login: MES_LOGIN,
    pwd_password: masked ? maskSecret(MES_PASSWORD) : MES_PASSWORD,
  };
}

async function sendMesAuthRequest({
  method = MES_AUTH_METHOD,
  timeoutMs = MES_AUTH_TIMEOUT_MS,
} = {}) {
  const params = makeAuthParams(false);
  const normalizedMethod = normalizeHttpMethod(method, MES_AUTH_METHOD);
  const startedAt = Date.now();

  const response =
    normalizedMethod === "get"
      ? await axios.get(AUTH_BASE, { params, timeout: timeoutMs })
      : await axios.post(AUTH_BASE, null, { params, timeout: timeoutMs });

  return {
    data: response.data,
    durationMs: Date.now() - startedAt,
    request: {
      method: normalizedMethod.toUpperCase(),
      url: AUTH_BASE,
      query: makeAuthParams(true),
      timeout_ms: timeoutMs,
    },
  };
}

async function mesAuth() {
  if (!AUTH_BASE || !MES_LOGIN || !MES_PASSWORD) {
    throw new Error("MES_* не настроены в .env");
  }

  logMes("[МосЭнергоСбыт] auth: отправляем запрос", {
    mode: MES_MODE,
    url: AUTH_BASE,
    method: MES_AUTH_METHOD.toUpperCase(),
    timeout_ms: MES_AUTH_TIMEOUT_MS,
    retry_attempts: MES_RETRY_ATTEMPTS,
    query: makeAuthParams(true),
  });

  const { data } = await withRetry(
    () =>
      sendMesAuthRequest({
        method: MES_AUTH_METHOD,
        timeoutMs: MES_AUTH_TIMEOUT_MS,
      }),
    { attempts: MES_RETRY_ATTEMPTS, baseDelay: 1500 }
  );

  const session = data?.data?.[0]?.session;
  if (!session) throw new Error("Не получили session от СУВК");
  return session;
}

async function mesAuthDiagnostic(method = MES_AUTH_METHOD) {
  if (!AUTH_BASE || !MES_LOGIN || !MES_PASSWORD) {
    throw new Error("MES_* не настроены в .env");
  }

  const normalizedMethod = normalizeHttpMethod(method, MES_AUTH_METHOD);

  console.log("[МосЭнергоСбыт] Диагностика: попытка 1 из 1");
  console.log(
    `[МосЭнергоСбыт] Диагностика: отправляем action=auth методом ${normalizedMethod.toUpperCase()}`
  );
  console.log(
    `[МосЭнергоСбыт] Диагностика: логин=${MES_LOGIN}, пароль=${maskSecret(MES_PASSWORD)}`
  );

  const { data, durationMs, request } = await sendMesAuthRequest({
    method: normalizedMethod,
    timeoutMs: MES_AUTH_TIMEOUT_MS,
  });

  console.log(`[МосЭнергоСбыт] Диагностика: внешний сервер ответил за ${durationMs}мс`);

  const session = data?.data?.[0]?.session;
  if (!session) throw new Error("Не получили session от СУВК");
  return { session, raw: sanitizeMesResponse(data), durationMs, request };
}

module.exports = {
  makeAuthParams,
  mesAuth,
  mesAuthDiagnostic,
  sendMesAuthRequest,
};
