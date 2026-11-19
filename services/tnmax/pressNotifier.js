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
  fmtWindow,
  parseDate,
  escapeHtml,
  splitPressText,
} = require("./pressTextTemplate");
const { sendMessage } = require("./pressBot");

// Эмодзи-шапка отдельной строкой, дальше пустая строка и основной текст (спека 17.11.2026).
const BADGE_EMERGENCY = "❗️❗️🚨❗️❗️";
const BADGE_PLANNED = "❗️❗️⚡ ❗️❗️";

const TEXTS = {
  // Внеплановая — HTML (format:"html" в sendMessage), спека пресс-службы 16.11.2026.
  emergency: (district, raw) => buildEmergencyText(district, raw),
  // Плановая — HTML; raw = { entries, additional } из pressPlannedScheduler (спека 17.11.2026).
  planned: (district, raw) => buildPlannedText(district, raw),
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
    BADGE_EMERGENCY,
    "",
    `<b>${escapeHtml(firstLine)} произошло внеплановое отключение электроэнергии</b>`,
    "",
    `<b>Адрес:</b> ${address ? escapeHtml(address) : "—"}`,
    "",
    `<b>Дата / Время отключения:</b> ${when}`,
    "",
    `Прогнозируемое время включения: <b>2 ч</b>`,
  ].join("\n");
}

// Текст планового оповещения: шапка + first_line округа, блок «Адрес/Время/Причина»
// на каждую ТН группы (📍 — разделитель, как в постах канала). additional=true →
// маркер доп.информации (как в канале).
// Без адреса ни у одной ТН — возвращаем null, notifyDistrict не шлёт (спека 17.11.2026).
async function buildPlannedText(district, raw = {}) {
  const entries = Array.isArray(raw.entries) ? raw.entries : [];
  const withAddr = entries.filter((e) => cleanAddressList(e?.address));
  if (!withAddr.length) return null;

  const firstLine = (
    (await fetchFirstLine(district)) || `В г.о. ${districtTitle(district) || ""}`
  ).trim();

  const lines = [BADGE_PLANNED, ""];
  if (raw.additional) {
    lines.push("ДОПОЛНИТЕЛЬНАЯ ИНФОРМАЦИЯ ПО ОТКЛЮЧЕНИЮ", "");
  }
  lines.push(
    `<b>${escapeHtml(firstLine)} произойдет плановое отключение электроэнергии</b>`,
    ""
  );

  withAddr.forEach((e, i) => {
    if (i) lines.push("");
    const address = cleanAddressList(e.address);
    const start = e.start instanceof Date ? e.start : parseDate(e.start);
    const end = e.end instanceof Date ? e.end : parseDate(e.end);
    const window = fmtWindow(start, end);
    const when = start ? `${fmtDmy(start)}${window ? ` ${window}` : ""}` : "—";
    // 📍 — та же «красная иголка», что разделяет ТН в постах канала.
    lines.push(`📍 <b>Адрес:</b> ${escapeHtml(address)}`);
    lines.push("");
    lines.push(`<b>Дата / Время возможного отключения:</b> ${when}`);
    const reason = String(e.reason || "")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/[.\s]+$/, "");
    if (reason) {
      lines.push("", `<b>Причина отключения:</b> ${escapeHtml(reason)}`);
    }
  });
  return lines.join("\n");
}

// Шлёт оповещение всем подписчикам округа; своих ошибок наружу не отдаёт.
async function notifyDistrict(districtRaw, kind, raw) {
  try {
    const district = String(districtRaw || "").trim();
    const key = normalizeDistrictKey(district);
    const textFor = TEXTS[kind];
    if (!key || !textFor) return { sent: 0, reason: "bad-args" };

    // Внеплановую без адреса подписчикам не шлём (спека пресс-службы 17.11.2026).
    if (kind === "emergency") {
      const data = raw?.data && typeof raw.data === "object" ? raw.data : {};
      const address = cleanAddressList(raw?.addressList || data.ADDRESS_LIST);
      if (!address) {
        log(
          `оповещение [аварийная]: нет адреса в ТН округа «${district}» — пропускаю`
        );
        return { sent: 0, reason: "no-address" };
      }
    }

    const subs = (await getAllSubscribers()).filter(
      (s) => s.isActive && s.districts.some((d) => normalizeDistrictKey(d) === key)
    );
    if (!subs.length) {
      log(`оповещение [${KIND_RU[kind]}]: нет подписчиков округа «${district}»`);
      return { sent: 0 };
    }

    const text = await textFor(district, raw);
    // Плановая без адреса (buildPlannedText вернула null) — не шлём.
    if (!text) {
      log(
        `оповещение [плановая]: нет адреса в ТН округа «${district}» — пропускаю`
      );
      return { sent: 0, reason: "no-address" };
    }
    // Лимит MAX на text — 4000 симв. (массовый ТН, кейс 18.11: 85 адресов = 12145);
    // сплит как в канале, иначе весь текст отвергается proto.payload.
    const chunks = splitPressText(text);
    const format = "html";
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
        for (let i = 0; i < chunks.length; i++) {
          const resp = await sendMessage(target, chunks[i], null, format);
          const mid = resp?.message?.body?.mid || null;
          if (mid) mids.push(mid);
          // История в ЛС подписчика (не валяет отправку)
          appendHistory(s.maxUserId, { dir: "out", kind, text: chunks[i], mid }).catch(() => {});
          if (i < chunks.length - 1) {
            await new Promise((r) => setTimeout(r, 600));
          }
        }
        sent += 1;
        log(
          `оповещение [${KIND_RU[kind]}] → user ${s.maxUserId}: ok${chunks.length > 1 ? ` (чанков: ${chunks.length})` : ""}`,
          target
        );
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
