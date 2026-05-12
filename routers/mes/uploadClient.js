const axios = require("axios");
const FormData = require("form-data");
const dayjs = require("dayjs");
const {
  CAMPAIGN_TYPE,
  FACILITY_ID,
  KD_CHANNEL,
  LOAD_BASE,
  MES_MODE,
  MES_RETRY_ATTEMPTS,
  MES_UPLOAD_TIMEOUT_MS,
  SYS_CONTACT,
} = require("./config");
const { mesAuth } = require("./authClient");
const { buildRegistryExternalId } = require("./registryMapper");
const { logMes, maskSession, sanitizeMesResponse, withRetry } = require("./utils");

async function mesUploadRegistry(items, { externalId } = {}) {
  const session = await mesAuth();
  const idRegistryExt = buildRegistryExternalId(externalId);

  const params = {
    action: "upload",
    query: "FwdRegistryLoad",
    session,
    id_registry_ext: idRegistryExt,
    kd_system_contact: SYS_CONTACT,
    kd_channel: KD_CHANNEL,
    dt_campaign_beg: dayjs().format("YYYY-MM-DD"),
    dt_campaign_end: dayjs().add(3, "day").format("YYYY-MM-DD"),
    id_facility: FACILITY_ID,
    kd_tp_campaign: CAMPAIGN_TYPE,
  };

  const form = new FormData();
  form.append("vl_registry", Buffer.from(JSON.stringify(items, null, 2)), {
    filename: "registry.json",
    contentType: "application/json",
  });

  logMes("[МосЭнергоСбыт] upload: отправляем реестр", {
    mode: MES_MODE,
    url: LOAD_BASE,
    query: { ...params, session: maskSession(session) },
    rows: items.length,
    vl_registry: items,
  });

  const { data } = await withRetry(
    () =>
      axios.post(LOAD_BASE, form, {
        params,
        headers: form.getHeaders(),
        timeout: MES_UPLOAD_TIMEOUT_MS,
        maxBodyLength: Infinity,
      }),
    { attempts: MES_RETRY_ATTEMPTS, baseDelay: 1500 }
  );

  const idRegistry = data?.data?.[0]?.id_registry;
  if (!idRegistry) throw new Error("Не получили id_registry в ответе СУВК");
  logMes("[МосЭнергоСбыт] upload: ответ внешней системы", sanitizeMesResponse(data));
  return { idRegistry, idRegistryExt, session, raw: data };
}

async function mesCheckStatus({ session, idRegistry }) {
  const { data } = await axios.get(LOAD_BASE, {
    params: {
      query: "FwdRegistryCheckStatus",
      session,
      id_registry: idRegistry,
    },
    timeout: 30000,
  });
  return data;
}

module.exports = {
  mesCheckStatus,
  mesUploadRegistry,
};
