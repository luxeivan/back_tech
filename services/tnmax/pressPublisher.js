// Публикация в MAX-канал press «Мособлэнерго24» (Этап 9 POST МОДУСа).
// Плановые: текст по живому примеру канала + картинка округа (tn-okruga.img_plan).
// Внеплановые: текст по шаблону пресс-службы; ADDRESS_LIST пустой → не публикуем;
// картинка — статичный файл из репо assets/ (оригинал: Media Library Strapi /social/avarini).
// После отправки mid → mid_MAX_press, текст → description_MAX_press (поля Text/long).
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { sendToChannel, uploadImage, deleteStoredMids } = require("./tnMaxChannel");
const {
  mirrorToWall,
  deleteWallPost,
  isVkPressEnabled,
} = require("../vk/vkWall");
const {
  buildPressPlannedText,
  buildPressPlannedGroupText,
  buildPressEmergencyText,
  normalizeDistrictKey,
  cleanAddressList,
  splitPressText,
} = require("./pressTextTemplate");

const SEND_PAUSE_MS = 600;
const RETRY_PAUSE_MS = 1200;
const MAX_SEND_ATTEMPTS = 3;

// Картинка аварийного поста (одна на все внеплановые). Оригинал живёт в Strapi
// Media Library /social/avarini; в репо лежит копия — замена = положить файл
// с тем же именем.
const EMERGENCY_IMAGE_PATH = path.join(__dirname, "../../assets/press-avariynaya.jpeg");
let emergencyImageCache = null;

function loadEmergencyImage() {
  if (emergencyImageCache) return emergencyImageCache;
  try {
    emergencyImageCache = {
      buffer: fs.readFileSync(EMERGENCY_IMAGE_PATH),
      filename: path.basename(EMERGENCY_IMAGE_PATH),
    };
  } catch (e) {
    console.warn(`[press] картинка аварийного поста не найдена (${EMERGENCY_IMAGE_PATH}):`, e.message);
    emergencyImageCache = null;
  }
  return emergencyImageCache;
}

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

// Зеркало press-поста в стену VK (best-effort): ошибка VK не валит публикацию —
// только лог + сноска в сообщении этапа. post_id → post_id_press_vk.
async function mirrorPressToVk({ postText, image, label }) {
  if (!isVkPressEnabled()) return { postId: null, note: "" };
  try {
    const r = await mirrorToWall({ html: postText, image });
    console.log(`[press] ✓ ВК ${label}: post_id=${r.post_id} url=${r.url || "-"}`);
    return { postId: r.post_id || null, note: `; ВК post_id=${r.post_id || "-"}` };
  } catch (e) {
    const msg = e?.vk ? `${e.vk.error_code}: ${e.vk.error_msg}` : e?.message || e;
    console.error(`[press] ВК-зеркало не удалось (${label}):`, msg);
    return { postId: null, note: `; ВК НЕ отправлено: ${msg}` };
  }
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
    // Имя файла в Strapi (/uploads/<publicFile>) — для og:image-зеркала VK.
    const publicFile = path.posix.basename(String(hit.img_plan.url || ""));
    const resp = await axios.get(fileUrl, {
      responseType: "arraybuffer",
      timeout: 30000,
      headers: jwt ? { Authorization: `Bearer ${jwt}` } : undefined,
    });
    console.log(`[press] картинка округа: ${filename} (${resp.data.length} б)`);
    return { firstLine, image: { buffer: Buffer.from(resp.data), filename, publicFile } };
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
async function savePressMeta({ jwt, urlStrapi, midDocId, mids, postText, vkPostId }) {
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
  let vkError = null;
  if (vkPostId) vkError = await put({ post_id_press_vk: String(vkPostId) });
  let textError = null;
  if (postText) textError = await put({ description_MAX_press: postText });
  return { midError, textError, vkError };
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

  // Внеплановая без адреса (пустой ADDRESS_LIST) — пост не делаем (спека 11.11.2026).
  if (!isPlanned && !cleanAddressList(raw?.addressList || data.ADDRESS_LIST)) {
    return { ok: true, message: "ADDRESS_LIST пуст — пост не публикуется" };
  }

  let postText;
  try {
    postText = (isPlanned ? buildPressPlannedText : buildPressEmergencyText)(raw) || "";
  } catch (te) {
    return { ok: false, message: `шаблон не собрался: ${te?.message}` };
  }
  if (!postText.trim()) return { ok: false, message: "пустой текст поста" };

  // Картинка: у плановых — округа (tn-okruga.img_plan), у внеплановых — статичная
  // из assets/. Падение картинки не валит пост.
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
  } else {
    image = loadEmergencyImage();
    if (!image) imageNote = "; картинка из assets/ не найдена";
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

  // Зеркало поста в VK-стену (после успешного MAX; до сохранения — post_id нужен в PUT).
  const vk = await mirrorPressToVk({
    postText,
    image,
    label: `${isPlanned ? "плановая" : "внеплановая"} guid=${guid}`,
  });

  // Сохранение mid/текста в Strapi (для последующего редактирования/удаления)
  let saveNote = "";
  if (midDocId && sentMids.length) {
    const { midError, textError, vkError } = await savePressMeta({
      jwt,
      urlStrapi,
      midDocId,
      mids: sentMids.join(","),
      postText,
      vkPostId: vk.postId,
    });
    if (midError) {
      return {
        ok: false,
        message: `отправлено (mid=${sentMids.join(",")}), но mid НЕ сохранён: ${midError}${imageNote}${vk.note}`,
      };
    }
    saveNote = textError
      ? `, текст НЕ сохранён: ${textError} (поле должно быть Text/long)`
      : ", mid+текст сохранены";
    if (vk.postId && vkError) {
      saveNote += `; ВК post_id НЕ сохранён: ${vkError}`;
    }
  } else if (!midDocId) {
    saveNote = "; midDocId не передан — mid не сохранён";
  }

  return {
    ok: true,
    message:
      `${isPlanned ? "плановая" : "внеплановая"} guid=${guid} mid=${sentMids.join(",")}` +
      `${chunks.length > 1 ? ` сообщений=${chunks.length}` : ""}` +
      `${image && sentMids.length ? " +картинка" : ""}${saveNote}${vk.note}${imageNote}`,
  };
}

// Удаление поста press из канала + очистка mid_MAX_press (+ зеркало в VK:
// wall.delete по post_id_press_vk, очистка поля). VK — best-effort, не валит ok.
// tnId — documentId/id записи; storedMid — если уже прочитан вызывающим.
async function deletePressPost({ jwt, urlStrapi, tnId, storedMid }) {
  if (!tnId && !storedMid) return { ok: false, message: "нет tnId и storedMid" };

  const vkEnabled = isVkPressEnabled();
  let mid = storedMid || null;
  let vkPostId = null;
  if (tnId && (!mid || vkEnabled)) {
    try {
      const r = await axios.get(`${urlStrapi}/api/teh-narusheniyas/${tnId}`, {
        headers: { Authorization: `Bearer ${jwt}` },
        timeout: 15000,
      });
      if (!mid) mid = r?.data?.data?.mid_MAX_press || null;
      vkPostId = r?.data?.data?.post_id_press_vk || null;
    } catch (e) {
      if (!mid) {
        return { ok: false, message: `не удалось прочитать mid: ${e?.response?.status || e?.message}` };
      }
      console.warn(
        `[press] не удалось прочитать post_id_press_vk (doc=${tnId}): ${e?.response?.status || e?.message}`
      );
    }
  }

  // VK wall.delete — до очистки полей (при падении MAX-части id останется для повтора).
  let vkNote = "";
  let vkCleared = false;
  if (vkEnabled && vkPostId) {
    try {
      const d = await deleteWallPost(vkPostId);
      if (d.ok) {
        vkCleared = true;
        vkNote = `; ВК post_id=${vkPostId} удалён`;
      } else {
        vkNote = `; ВК post_id=${vkPostId} не удалён: ${d.reason || "нет ответа"}`;
      }
    } catch (e) {
      const msg = e?.vk ? `${e.vk.error_code}: ${e.vk.error_msg}` : e?.message || e;
      vkNote = `; ВК post_id=${vkPostId} НЕ удалён: ${msg}`;
      console.error(`[press] ВК wall.delete не удался (post_id=${vkPostId}):`, msg);
    }
  }

  const clearVkField = async () => {
    if (!vkCleared || !tnId) return null;
    try {
      await axios.put(
        `${urlStrapi}/api/teh-narusheniyas/${tnId}`,
        { data: { post_id_press_vk: null } },
        { headers: { Authorization: `Bearer ${jwt}` }, timeout: 15000 }
      );
      return null;
    } catch (ce) {
      return ce?.response?.status || ce?.message;
    }
  };

  if (!mid) {
    const vkClearError = await clearVkField();
    if (vkClearError) {
      return { ok: false, message: `mid не сохранён; ВК удалён, но поле не очищено: ${vkClearError}` };
    }
    if (!vkNote) return { ok: true, message: "mid не сохранён — нечего удалять" };
    return { ok: true, message: `mid не сохранён${vkNote}` };
  }

  const { deleted, failed } = await deleteStoredMids(mid, "press");
  const remaining = failed.map((f) => f.mid).join(",") || null;

  if (tnId) {
    try {
      await axios.put(
        `${urlStrapi}/api/teh-narusheniyas/${tnId}`,
        {
          data: {
            mid_MAX_press: remaining,
            ...(vkCleared ? { post_id_press_vk: null } : {}),
          },
        },
        { headers: { Authorization: `Bearer ${jwt}` }, timeout: 15000 }
      );
    } catch (ce) {
      return {
        ok: false,
        message: `mid=${deleted.join(",") || "-"} удалён, но поле не очищено: ${ce?.response?.status || ce?.message}${vkNote}`,
      };
    }
  }

  if (failed.length) {
    return {
      ok: false,
      message:
        `удалены ${deleted.join(",") || "—"}; не удалены: ${failed
          .map((f) => `${f.mid} (${f.error})`)
          .join("; ")}; в поле оставлено: ${remaining}${vkNote}`,
    };
  }
  return { ok: true, message: `mid=${deleted.join(",")} удалён, поле очищено${vkNote}` };
}

// Групповой пост плановых (округ + дата): один текст на всех, mid/текст → каждому участнику.
// entries: [{ start: Date, end: Date|null, address, reason }]
// members: [{ documentId, guid }] — кому сохраняем mid/текст.
async function publishPressGroupPost({ jwt, urlStrapi, district, entries, members, additional = false }) {
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
    postText = buildPressPlannedGroupText(entries, { firstLine, district, additional }) || "";
  } catch (te) {
    return { ok: false, message: `шаблон не собрался: ${te?.message}` };
  }
  if (!postText.trim()) return { ok: false, message: "пустой текст поста" };

  const chunks = splitPressText(postText);
  const sentMids = [];
  try {
    for (let i = 0; i < chunks.length; i += 1) {
      // Групповой шаблон тоже HTML (заголовок <h2>, дата/причина в <b>)
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

  // Зеркало группового поста в VK-стену (после успешного MAX).
  const vk = await mirrorPressToVk({
    postText,
    image,
    label: `группа ${district}`,
  });

  // mid/текст — КАЖДОМУ участнику группы (дедуп по mid_MAX_press)
  const mids = sentMids.join(",");
  const saveErrors = [];
  for (const m of members) {
    if (!m.documentId) continue;
    const { midError, textError, vkError } = await savePressMeta({
      jwt,
      urlStrapi,
      midDocId: m.documentId,
      mids,
      postText,
      vkPostId: vk.postId,
    });
    if (midError) saveErrors.push(`${m.guid}: mid ${midError}`);
    else if (textError) saveErrors.push(`${m.guid}: текст ${textError}`);
    else if (vk.postId && vkError) saveErrors.push(`${m.guid}: ВК post_id ${vkError}`);
  }

  return {
    ok: saveErrors.length === 0,
    message:
      `группа ${district}: ТН=${entries.length} mid=${mids}` +
      `${chunks.length > 1 ? ` сообщений=${chunks.length}` : ""}` +
      `${image && sentMids.length ? " +картинка" : ""}` +
      `${saveErrors.length ? `; НЕ сохранено: ${saveErrors.join("; ")}` : "; mid/текст всем участникам"}` +
      `${vk.note}${imageNote}`,
    sentMids,
    postText,
    guids: entries.map((e) => e.guid).filter(Boolean),
  };
}

module.exports = { publishPressPost, publishPressGroupPost, deletePressPost, fetchDistrictInfo };
