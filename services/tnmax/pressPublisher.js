// Публикация в MAX-канал press «Мособлэнерго24» (Этап 9 POST МОДУСа).
// Плановые: текст по живому примеру канала + картинка округа (tn-okruga.img_plan).
// Внеплановые: текст по шаблону пресс-службы, без картинки.
// mid НЕ сохраняется (нет Strapi-поля) — при необходимости добавить позже для гашения.
const axios = require("axios");
const { sendToChannel, uploadImage } = require("./tnMaxChannel");
const {
  buildPressPlannedText,
  buildPressEmergencyText,
  normalizeDistrictKey,
  splitPressText,
} = require("./pressTextTemplate");

const SEND_PAUSE_MS = 600;
const RETRY_PAUSE_MS = 1200;
const MAX_SEND_ATTEMPTS = 3;

async function sendWithRetry(payload, label, sentMids) {
  let result = null;
  for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt += 1) {
    try {
      result = await sendToChannel({ ...payload, target: "press" });
      break;
    } catch (se) {
      const code = se?.response?.data?.code;
      if (code === "attachment.not.ready" && attempt < MAX_SEND_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, RETRY_PAUSE_MS));
        continue;
      }
      throw se;
    }
  }
  const mid = result?.message?.body?.mid || "";
  if (mid) sentMids.push(mid);
  console.log(`[press] ✓ ${label}: mid=${mid || "-"} url=${result?.message?.url || "-"}`);
  return result;
}

// Картинка округа: DISTRICT ТН → tn-okruga (name/source_name) → img_plan.
// Ошибки — не валят пост (отправим текст без картинки).
async function fetchDistrictImage({ jwt, urlStrapi, district }) {
  const key = normalizeDistrictKey(district);
  if (!key) return null;

  const { data } = await axios.get(`${urlStrapi}/api/tn-okruga`, {
    headers: { Authorization: `Bearer ${jwt}` },
    params: {
      "pagination[pageSize]": 100,
      "fields[0]": "name",
      "fields[1]": "source_name",
      "populate[img_plan][fields][0]": "url",
      "populate[img_plan][fields][1]": "name",
      "populate[img_plan][fields][2]": "ext",
    },
    timeout: 15000,
  });
  const rows = data?.data || [];
  const hit = rows.find(
    (r) =>
      normalizeDistrictKey(r.name) === key ||
      normalizeDistrictKey(r.source_name) === key
  );
  if (!hit?.img_plan?.url) {
    console.warn(`[press] нет img_plan для округа "${district}" (key=${key})`);
    return null;
  }

  const fileUrl = /^https?:/i.test(hit.img_plan.url)
    ? hit.img_plan.url
    : `${String(urlStrapi).replace(/\/$/, "")}${hit.img_plan.url}`;
  const filename = hit.img_plan.name || `okrug${hit.img_plan.ext || ".png"}`;

  const resp = await axios.get(fileUrl, {
    responseType: "arraybuffer",
    timeout: 30000,
    headers: jwt ? { Authorization: `Bearer ${jwt}` } : undefined,
  });
  console.log(`[press] картинка округа: ${filename} (${resp.data.length} б)`);
  return { buffer: Buffer.from(resp.data), filename };
}

// Публикация. { ok, message } — для stage-логера Этапа 9.
async function publishPressPost({ jwt, guid, raw, urlStrapi }) {
  const data = raw?.data && typeof raw.data === "object" ? raw.data : {};
  const baseType = Number(raw?.BASE_TYPE ?? data.BASE_TYPE);
  const statusName = String(raw?.STATUS_NAME ?? data.STATUS_NAME ?? "").trim().toLowerCase();
  const isPlanned = baseType === 1;

  if (isPlanned && ["отменена", "удалена"].includes(statusName)) {
    return { ok: true, message: `статус «${statusName}» — пропущено` };
  }

  let postText;
  try {
    postText = (isPlanned ? buildPressPlannedText : buildPressEmergencyText)(raw) || "";
  } catch (te) {
    return { ok: false, message: `шаблон не собрался: ${te?.message}` };
  }
  if (!postText.trim()) return { ok: false, message: "пустой текст поста" };

  // Картинка только у плановых; падение картинки не валит пост
  let image = null;
  let imageNote = "";
  if (isPlanned) {
    try {
      image = await fetchDistrictImage({
        jwt,
        urlStrapi,
        district: data.DISTRICT || raw.DISTRICT || "",
      });
    } catch (ie) {
      imageNote = `; картинка НЕ отправлена: ${ie?.response?.status || ie?.message}`;
      console.warn(`[press] ошибка картинки округа (guid=${guid}):`, ie?.response?.status || ie?.message);
    }
  }

  const chunks = splitPressText(postText);
  const sentMids = [];
  try {
    for (let i = 0; i < chunks.length; i += 1) {
      const payload = { text: chunks[i] };
      if (i === 0 && image) {
        try {
          const mediaToken = await uploadImage(image.buffer, image.filename, "press");
          payload.attachments = [{ type: "image", payload: { token: mediaToken } }];
        } catch (ue) {
          imageNote = `; картинка НЕ отправлена: ${ue?.response?.data?.message || ue?.message}`;
          console.warn(`[press] upload image failed (guid=${guid}):`, ue?.message);
        }
      }
      await sendWithRetry(payload, isPlanned ? `плановая чанк ${i + 1}/${chunks.length}` : `внеплановая чанк ${i + 1}/${chunks.length}`, sentMids);
      if (i < chunks.length - 1) await new Promise((r) => setTimeout(r, SEND_PAUSE_MS));
    }
  } catch (se) {
    return {
      ok: false,
      message: `mid=${sentMids.join(",") || "-"}: ${se?.response?.data?.message || se?.message}${imageNote}`,
    };
  }

  return {
    ok: true,
    message:
      `${isPlanned ? "плановая" : "внеплановая"} guid=${guid} mid=${sentMids.join(",")}` +
      `${chunks.length > 1 ? ` сообщений=${chunks.length}` : ""}` +
      `${image && sentMids.length ? " +картинка" : ""}${imageNote}`,
  };
}

module.exports = { publishPressPost };
