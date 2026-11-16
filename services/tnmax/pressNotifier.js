// Оповещения подписчикам press-бота о ТН в их округе (ЛС; шаблоны канала не трогаем).
const axios = require("axios");
const { getJwt } = require("../modus/strapi");
const { getAllSubscribers, appendHistory } = require("./pressSubsStore");
const {
  normalizeDistrictKey,
  districtTitle,
  cleanAddressList,
  fmtDmy,
  fmtHm,
  parseDate,
  escapeHtml,
} = require("./pressTextTemplate");
const { sendMessage } = require("./pressBot");

const TEXTS = {
  // Внеплановая — HTML (format:"html" в sendMessage), спека пресс-службы 16.11.2026.
  emergency: (district, raw) => buildEmergencyText(district, raw),
  planned: (district) => `В вашем ГО будет плановая ТН (${district})`,
};

const KIND_RU = { emergency: "аварийная", planned: "плановая" };

// Лог с префиксом [press-bot].
const log = (tag, payload) =>
  payload === undefined
    ? console.log(`[press-bot] ${tag}`)
    : console.log(`[press-bot] ${tag}`, payload);

// first_line_shablon округа из tn-okruga (без картинки); нет — null.
async function fetchFirstLine(district) {
  const key = normalizeDistrictKey(district);
  if (!key) return null;
  try {
    const jwt = await getJwt();
    if (!jwt) return null;
    const { data } = await axios.get(`${process.env.URL_STRAPI}/api/tn-okruga`, {
      headers: { Authorization: `Bearer ${jwt}` },
      params: {
        "pagination[pageSize]": 100,
        "fields[0]": "name",
        "fields[1]": "source_name",
        "fields[2]": "first_line_shablon",
      },
      timeout: 15000,
    });
    const hit = (data?.data || []).find(
      (r) =>
        normalizeDistrictKey(r.name) === key ||
        normalizeDistrictKey(r.source_name) === key
    );
    return hit?.first_line_shablon || null;
  } catch (e) {
    log("first_line_shablon не получен:", e?.response?.status || e?.message);
    return null;
  }
}

// Текст аварийного оповещения по образцу пресс-службы (7 строк, HTML).
async function buildEmergencyText(district, raw = {}) {
  const data = raw.data && typeof raw.data === "object" ? raw.data : {};
  const start = parseDate(raw.createDateTime || data.F81_060_EVENTDATETIME);
  const address = cleanAddressList(raw.addressList || data.ADDRESS_LIST);
  const firstLine = (
    (await fetchFirstLine(district)) || `В г.о. ${districtTitle(district) || ""}`
  ).trim();
  const when = start ? `${fmtDmy(start)} ${fmtHm(start)}` : "—";

  return [
    `<b>${escapeHtml(firstLine)} произошло внеплановое отключение электроэнергии</b>`,
    "",
    `<b>Адрес:</b> ${address ? escapeHtml(address) : "—"}`,
    "",
    `<b>Дата / Время отключения:</b> ${when}`,
    "",
    `Прогнозируемое время включения: <b>2 ч</b>`,
  ].join("\n");
}

// Шлёт оповещение всем подписчикам округа; своих ошибок наружу не отдаёт.
async function notifyDistrict(districtRaw, kind, raw) {
  try {
    const district = String(districtRaw || "").trim();
    const key = normalizeDistrictKey(district);
    const textFor = TEXTS[kind];
    if (!key || !textFor) return { sent: 0, reason: "bad-args" };

    const subs = (await getAllSubscribers()).filter(
      (s) => s.isActive && s.districts.some((d) => normalizeDistrictKey(d) === key)
    );
    if (!subs.length) {
      log(`оповещение [${KIND_RU[kind]}]: нет подписчиков округа «${district}»`);
      return { sent: 0 };
    }

    const text = await textFor(district, raw);
    const format = kind === "emergency" ? "html" : undefined;
    let sent = 0;
    const mids = [];
    for (const s of subs) {
      const target = s.maxChatId
        ? { chat_id: s.maxChatId }
        : s.maxUserId
          ? { user_id: s.maxUserId }
          : null;
      if (!target) continue;
      try {
        const resp = await sendMessage(target, text, null, format);
        sent += 1;
        const mid = resp?.message?.body?.mid || null;
        if (mid) mids.push(mid);
        log(`оповещение [${KIND_RU[kind]}] → user ${s.maxUserId}: ok`, target);
        // История в ЛС подписчика (не валяет отправку)
        appendHistory(s.maxUserId, { dir: "out", kind, text, mid }).catch(() => {});
      } catch (e) {
        log(
          `оповещение [${KIND_RU[kind]}] → user ${s.maxUserId}: ошибка`,
          e?.response?.data || e?.message || e
        );
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    log(`оповещение [${KIND_RU[kind]}]: «${district}» → отправлено ${sent}/${subs.length}`);
    return { sent, total: subs.length, mids };
  } catch (e) {
    log(`оповещение [${kind}]: сбой`, e?.message || e);
    return { sent: 0, mids: [], error: e?.message || String(e) };
  }
}

// Дописывает mid оповещений в поле mid_press_bot документа ТН (CSV, без дублей).
async function appendPressBotMids({ jwt, urlStrapi, documentId, mids }) {
  if (!jwt || !urlStrapi || !documentId || !mids?.length) return { saved: false };
  const url = `${urlStrapi}/api/teh-narusheniyas/${documentId}`;
  const headers = { Authorization: `Bearer ${jwt}` };
  const r = await axios.get(url, { headers, timeout: 15000 });
  const cur = String(r?.data?.data?.mid_press_bot || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const merged = [...new Set([...cur, ...mids])].join(",");
  await axios.put(url, { data: { mid_press_bot: merged } }, { headers, timeout: 15000 });
  return { saved: true };
}

module.exports = { notifyDistrict, appendPressBotMids };
