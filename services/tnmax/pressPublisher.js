// Публикация в MAX-канал press «Мособлэнерго24» (Этап 9 POST МОДУСа).
// Плановые: текст по живому примеру канала + картинка округа (tn-okruga.img_plan).
// Внеплановые: текст по шаблону пресс-службы, без картинки.
// После отправки mid → mid_MAX_press, текст → description_MAX_press (поля Text/long).
const axios = require("axios");
const { sendToChannel, uploadImage, deleteStoredMids } = require("./tnMaxChannel");
const {
  buildPressPlannedText,
  buildPressPlannedGroupText,
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

// Метаданные округа: first_line_shablon (заголовок) + картинка img_plan.
// Ошибки картинки не валят результат — image будет null.
async function fetchDistrictInfo({ jwt, urlStrapi, district }) {
  const key = normalizeDistrictKey(district);
  if (!key) return { firstLine: null, image: null };

  const { data } = await axios.get(`${urlStrapi}/api/tn-okruga`, {
    headers: { Authorization: `Bearer ${jwt}` },
    params: {
      "pagination[pageSize]": 100,
      "fields[0]": "name",
      "fields[1]": "source_name",
      "fields[2]": "first_line_shablon",
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
  if (!hit) return { firstLine: null, image: null };

  const firstLine = hit.first_line_shablon || null;

  if (!hit.img_plan?.url) {
    console.warn(`[press] нет img_plan для округа "${district}" (key=${key})`);
    return { firstLine, image: null };
  }

  try {
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
    return { firstLine, image: { buffer: Buffer.from(resp.data), filename } };
  } catch (ie) {
    console.warn(
      `[press] скачивание картинки округа не удалось (key=${key}):`,
      ie?.response?.status || ie?.message
    );
    return { firstLine, image: null };
  }
}

// Сохранение mid и текста поста отдельными PUT (mid первым — падение записи
// длинного текста не должно терять mid). Как savePostMeta в postPublisher.
async function savePressMeta({ jwt, urlStrapi, midDocId, mids, postText }) {
  const put = async (data) => {
    try {
      await axios.put(`${urlStrapi}/api/teh-narusheniyas/${midDocId}`, { data }, {
        headers: { Authorization: `Bearer ${jwt}` },
        timeout: 15000,
      });
      return null;
    } catch (se) {
      const body = se?.response?.data ? JSON.stringify(se.response.data).slice(0, 200) : se?.message;
      console.error(
        `[press] Strapi PUT failed (fields=${Object.keys(data).join(",")}, doc=${midDocId}): HTTP ${se?.response?.status} ${body}`
      );
      return se?.response?.status || se?.message;
    }
  };

  let midError = null;
  if (mids) midError = await put({ mid_MAX_press: mids });
  let textError = null;
  if (postText) textError = await put({ description_MAX_press: postText });
  return { midError, textError };
}

// Публикация. { ok, message } — для stage-логера Этапа 9.
async function publishPressPost({ jwt, guid, raw, urlStrapi, midDocId }) {
  const data = raw?.data && typeof raw.data === "object" ? raw.data : {};
  const baseType = Number(raw?.BASE_TYPE ?? data.BASE_TYPE);
  const statusName = String(raw?.STATUS_NAME ?? data.STATUS_NAME ?? "").trim().toLowerCase();
  const isPlanned = baseType === 1;

  if (isPlanned && ["отменена", "удалена"].includes(statusName)) {
    return { ok: true, message: `статус «${statusName}» — пропущено` };
  }
  // Внеплановая: пост в канале только пока ТН открыта. Пришла уже
  // закрытой/запитанной/удаленной — не публикуем (и гасить нечего).
  if (!isPlanned && ["закрыта", "запитана", "удалена"].includes(statusName)) {
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
      const info = await fetchDistrictInfo({
        jwt,
        urlStrapi,
        district: data.DISTRICT || raw.DISTRICT || "",
      });
      image = info.image;
    } catch (ie) {
      imageNote = `; картинка НЕ отправлена: ${ie?.response?.status || ie?.message}`;
      console.warn(`[press] ошибка картинки округа (guid=${guid}):`, ie?.response?.status || ie?.message);
    }
  }

  const chunks = splitPressText(postText);
  const sentMids = [];
  try {
    for (let i = 0; i < chunks.length; i += 1) {
      // Все press-шаблоны — HTML (жирные лейблы/заголовки в <b>)
      const payload = { text: chunks[i], format: "html" };
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

  // Сохранение mid/текста в Strapi (для последующего редактирования/удаления)
  let saveNote = "";
  if (midDocId && sentMids.length) {
    const { midError, textError } = await savePressMeta({
      jwt,
      urlStrapi,
      midDocId,
      mids: sentMids.join(","),
      postText,
    });
    if (midError) {
      return {
        ok: false,
        message: `отправлено (mid=${sentMids.join(",")}), но mid НЕ сохранён: ${midError}${imageNote}`,
      };
    }
    saveNote = textError
      ? `, текст НЕ сохранён: ${textError} (поле должно быть Text/long)`
      : ", mid+текст сохранены";
  } else if (!midDocId) {
    saveNote = "; midDocId не передан — mid не сохранён";
  }

  return {
    ok: true,
    message:
      `${isPlanned ? "плановая" : "внеплановая"} guid=${guid} mid=${sentMids.join(",")}` +
      `${chunks.length > 1 ? ` сообщений=${chunks.length}` : ""}` +
      `${image && sentMids.length ? " +картинка" : ""}${saveNote}${imageNote}`,
  };
}

// Удаление поста press из канала + очистка mid_MAX_press.
// tnId — documentId/id записи; storedMid — если уже прочитан вызывающим.
async function deletePressPost({ jwt, urlStrapi, tnId, storedMid }) {
  if (!tnId && !storedMid) return { ok: false, message: "нет tnId и storedMid" };

  let mid = storedMid || null;
  if (!mid) {
    try {
      const r = await axios.get(`${urlStrapi}/api/teh-narusheniyas/${tnId}`, {
        headers: { Authorization: `Bearer ${jwt}` },
        timeout: 15000,
      });
      mid = r?.data?.data?.mid_MAX_press || null;
    } catch (e) {
      return { ok: false, message: `не удалось прочитать mid: ${e?.response?.status || e?.message}` };
    }
  }
  if (!mid) return { ok: true, message: "mid не сохранён — нечего удалять" };

  const { deleted, failed } = await deleteStoredMids(mid, "press");
  const remaining = failed.map((f) => f.mid).join(",") || null;

  if (tnId) {
    try {
      await axios.put(
        `${urlStrapi}/api/teh-narusheniyas/${tnId}`,
        { data: { mid_MAX_press: remaining } },
        { headers: { Authorization: `Bearer ${jwt}` }, timeout: 15000 }
      );
    } catch (ce) {
      return {
        ok: false,
        message: `mid=${deleted.join(",") || "-"} удалён, но поле не очищено: ${ce?.response?.status || ce?.message}`,
      };
    }
  }

  if (failed.length) {
    return {
      ok: false,
      message:
        `удалены ${deleted.join(",") || "—"}; не удалены: ${failed
          .map((f) => `${f.mid} (${f.error})`)
          .join("; ")}; в поле оставлено: ${remaining}`,
    };
  }
  return { ok: true, message: `mid=${deleted.join(",")} удалён, поле очищено` };
}

// Групповой пост плановых (округ + дата): один текст на всех, mid/текст → каждому участнику.
// entries: [{ start: Date, end: Date|null, address, reason }]
// members: [{ documentId, guid }] — кому сохраняем mid/текст.
async function publishPressGroupPost({ jwt, urlStrapi, district, entries, members }) {
  if (!entries?.length) return { ok: false, message: "пустая группа" };

  let firstLine = null;
  let image = null;
  let imageNote = "";
  try {
    const info = await fetchDistrictInfo({ jwt, urlStrapi, district });
    firstLine = info.firstLine;
    image = info.image;
  } catch (ie) {
    imageNote = `; метаданные округа не получены: ${ie?.response?.status || ie?.message}`;
    console.warn(`[press] ошибка метаданных округа "${district}":`, ie?.response?.status || ie?.message);
  }

  let postText;
  try {
    postText = buildPressPlannedGroupText(entries, { firstLine, district }) || "";
  } catch (te) {
    return { ok: false, message: `шаблон не собрался: ${te?.message}` };
  }
  if (!postText.trim()) return { ok: false, message: "пустой текст поста" };

  const chunks = splitPressText(postText);
  const sentMids = [];
  try {
    for (let i = 0; i < chunks.length; i += 1) {
      // Групповой шаблон тоже HTML (заголовок в <b>)
      const payload = { text: chunks[i], format: "html" };
      if (i === 0 && image) {
        try {
          const mediaToken = await uploadImage(image.buffer, image.filename, "press");
          payload.attachments = [{ type: "image", payload: { token: mediaToken } }];
        } catch (ue) {
          imageNote = `; картинка НЕ отправлена: ${ue?.response?.data?.message || ue?.message}`;
          console.warn(`[press] upload image failed (округ=${district}):`, ue?.message);
        }
      }
      await sendWithRetry(payload, `группа ${district} чанк ${i + 1}/${chunks.length}`, sentMids);
      if (i < chunks.length - 1) await new Promise((r) => setTimeout(r, SEND_PAUSE_MS));
    }
  } catch (se) {
    return {
      ok: false,
      message: `mid=${sentMids.join(",") || "-"}: ${se?.response?.data?.message || se?.message}${imageNote}`,
    };
  }

  // mid/текст — КАЖДОМУ участнику группы (дедуп по mid_MAX_press)
  const mids = sentMids.join(",");
  const saveErrors = [];
  for (const m of members) {
    if (!m.documentId) continue;
    const { midError, textError } = await savePressMeta({
      jwt,
      urlStrapi,
      midDocId: m.documentId,
      mids,
      postText,
    });
    if (midError) saveErrors.push(`${m.guid}: mid ${midError}`);
    else if (textError) saveErrors.push(`${m.guid}: текст ${textError}`);
  }

  return {
    ok: saveErrors.length === 0,
    message:
      `группа ${district}: ТН=${entries.length} mid=${mids}` +
      `${chunks.length > 1 ? ` сообщений=${chunks.length}` : ""}` +
      `${image && sentMids.length ? " +картинка" : ""}` +
      `${saveErrors.length ? `; НЕ сохранено: ${saveErrors.join("; ")}` : "; mid/текст всем участникам"}` +
      `${imageNote}`,
    sentMids,
    postText,
    guids: entries.map((e) => e.guid).filter(Boolean),
  };
}

module.exports = { publishPressPost, publishPressGroupPost, deletePressPost, fetchDistrictInfo };
