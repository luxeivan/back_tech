// Оповещения подписчиков press-бота о ТН в их округе (базовые шаблоны).
const { getAllSubscribers } = require("./pressSubsStore");
const { normalizeDistrictKey } = require("./pressTextTemplate");
const { sendMessage } = require("./pressBot");

const TEXTS = {
  emergency: (district) => `В вашем ГО будет аварийная ТН (${district})`,
  planned: (district) => `В вашем ГО будет плановая ТН (${district})`,
};

const KIND_RU = { emergency: "аварийная", planned: "плановая" };

// Лог с префиксом [press-bot].
const log = (tag, payload) =>
  payload === undefined
    ? console.log(`[press-bot] ${tag}`)
    : console.log(`[press-bot] ${tag}`, payload);

// Шлёт оповещение всем подписчикам округа; своих ошибок наружу не отдаёт.
async function notifyDistrict(districtRaw, kind) {
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

    const text = textFor(district);
    let sent = 0;
    for (const s of subs) {
      const target = s.maxChatId
        ? { chat_id: s.maxChatId }
        : s.maxUserId
          ? { user_id: s.maxUserId }
          : null;
      if (!target) continue;
      try {
        await sendMessage(target, text);
        sent += 1;
        log(`оповещение [${KIND_RU[kind]}] → user ${s.maxUserId}: ok`, target);
      } catch (e) {
        log(
          `оповещение [${KIND_RU[kind]}] → user ${s.maxUserId}: ошибка`,
          e?.response?.data || e?.message || e
        );
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    log(`оповещение [${KIND_RU[kind]}]: «${district}» → отправлено ${sent}/${subs.length}`);
    return { sent, total: subs.length };
  } catch (e) {
    log(`оповещение [${kind}]: сбой`, e?.message || e);
    return { sent: 0, error: e?.message || String(e) };
  }
}

module.exports = { notifyDistrict };
