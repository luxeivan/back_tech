// Публикация поста ОО в MAX-канал (Этап 8 POST МОДУСа).
// Формат v3: текст → PDF#1 → PDF#2 тремя сообщениями (MAX: max 1 file-вложение на сообщение).
// mid-поле: "mid1,mid2,mid3" через запятую; гашение (Этап 5.5 / DELETE-ручка) парсит запятые.
// ROLLBACK (пост «2 PNG + текст одним mid», картинки сверху): см. закомментированный блок в конце файла.
const axios = require("axios");
const { sendToChannel, uploadFile } = require("./tnMaxChannel");
const { generateTablesPdfs } = require("./pdf");
const { buildMaxPostText } = require("./postTextTemplate");

const SEND_PAUSE_MS = 600; // лимит MAX: 2 сообщ/сек
const RETRY_PAUSE_MS = 1200;
const MAX_SEND_ATTEMPTS = 3;
const MSK_OFFSET_MS = 3 * 60 * 60 * 1000; // MSK = UTC+3, без перехода на летнее время
const OPERATIONAL_DAY_START_HOUR_MSK = 8;

// Начало операционного окна: последняя 08:00 МСК ≤ now.
// TN в 07:30 попадает в окно, начавшееся вчера в 08:00.
function operationalWindowStart(now = new Date()) {
  const msk = new Date(now.getTime() + MSK_OFFSET_MS);
  const today0800Shifted = Date.UTC(
    msk.getUTCFullYear(), msk.getUTCMonth(), msk.getUTCDate(),
    OPERATIONAL_DAY_START_HOUR_MSK, 0, 0, 0
  );
  const startShifted = msk.getTime() < today0800Shifted
    ? today0800Shifted - 24 * 60 * 60 * 1000
    : today0800Shifted;
  return new Date(startShifted - MSK_OFFSET_MS);
}

// Порядковый номер аварийки в текущем операционном окне (с 08:00 МСК).
// Считаем аварийные (BASE_TYPE=0) без удалённых (-1) с createDateTime ≥ windowStart.
// Текущая ТН уже записана в Strapi к Этапу 8 — входит в счёт.
// При ошибке запроса возвращает null (fallback на номер МОДУСа в шаблоне).
async function calcSequenceNumber({ jwt, urlStrapi, now = new Date() }) {
  const windowStart = operationalWindowStart(now);
  const iso = windowStart.toISOString();
  try {
    const { data } = await axios.get(`${urlStrapi}/api/teh-narusheniyas`, {
      headers: { Authorization: `Bearer ${jwt}` },
      params: {
        "filters[BASE_TYPE][$eq]": 0,
        "filters[number][$ne]": -1,
        "filters[createDateTime][$gte]": iso,
        "pagination[pageSize]": 1,
        "sort[0]": "createDateTime:asc",
      },
      timeout: 15000,
    });
    const total = Number(data?.meta?.pagination?.total);
    console.log(
      `[tnmax] порядковый номер: total=${total} для окна с ${iso} (опер. окно с 08:00 МСК)`
    );
    return Number.isFinite(total) && total > 0 ? total : null;
  } catch (e) {
    console.warn(
      `[tnmax] Не удалось посчитать порядковый номер (окно с ${iso}):`,
      e?.response?.status || e?.message
    );
    return null;
  }
}

// Сохранение mid-поля и текста поста в Strapi ОТДЕЛЬНЫМИ PUT (mid первым):
// падение записи длинного текста не должно терять mid.
// Внимание: description_MAX_operativnayObstanovka обязан быть Text (long) в Strapi —
// short (VARCHAR 255) даёт 500 на 256-м символе.
async function savePostMeta({ jwt, urlStrapi, midDocId, mids, postText }) {
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
        `[tnmax] Strapi PUT failed (fields=${Object.keys(data).join(",")}, doc=${midDocId}): HTTP ${se?.response?.status} ${body}`
      );
      return se?.response?.status || se?.message;
    }
  };

  let midError = null;
  if (mids) midError = await put({ mid_MAX_operativnayObstanovka: mids });
  let textError = null;
  if (postText) textError = await put({ description_MAX_operativnayObstanovka: postText });

  return { midError, textError };
}

async function sendWithRetry(payload, label, sentMids, sentUrls) {
  let result = null;
  for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt += 1) {
    try {
      result = await sendToChannel(payload);
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
  if (result?.message?.url) sentUrls.push(result.message.url);
  console.log(`[tnmax] ✓ ${label}: mid=${mid || "-"} url=${result?.message?.url || "-"}`);
  return result;
}

// Публикация поста. Возвращает результат для stage-логера Этапа 8:
// { ok, message } — ok=false → islg.fail, ok=true → islg.success.
async function publishTnPost({ jwt, guid, raw, midDocId, urlStrapi }) {
  let postText = guid;
  try {
    const sequenceNumber = await calcSequenceNumber({ jwt, urlStrapi });
    postText = buildMaxPostText(raw, { sequenceNumber }) || guid;
  } catch (te) {
    console.warn(`[tnmax] Шаблон текста не собрался (guid=${guid}), отправляю guid:`, te?.message);
  }

  // ── СТАРЫЙ ФОРМАТ (ROLLBACK — не удалять): 2 PNG + текст ОДНИМ сообщением ──
  // Перенесён из routers/modus.js. Для отката: раскомментировать здесь и
  // закомментировать «НОВЫЙ ФОРМАТ» ниже; require-ы uploadImage/generateTablesPngs
  // добавить в tnMaxChannel/pdf и сюда.
  // let attachments = [];
  // let tablesNote = "";
  // try {
  //   const pngs = await generateTablesPngs({ jwt });
  //   console.log(
  //     `[tnmax] Таблицы сформированы для guid=${guid}: ${pngs.length} PNG (${pngs.map((p) => `${p.name}:${p.buffer.length}б`).join(", ")}), загружаю в MAX...`
  //   );
  //   for (const png of pngs) {
  //     const mediaToken = await uploadImage(png.buffer, png.name);
  //     attachments.push({ type: "image", payload: { token: mediaToken } });
  //   }
  //   tablesNote = ` таблиц=${attachments.length}`;
  // } catch (te) {
  //   attachments = [];
  //   tablesNote = ` таблицы НЕ отправлены: ${te?.message}`;
  //   console.warn(`[tnmax] Таблицы не сформированы для guid=${guid}:`, te?.message);
  // }
  // try {
  //   let maxResult = null;
  //   for (let attempt = 1; attempt <= 3; attempt++) {
  //     try {
  //       maxResult = await sendToChannel({ text: postText, attachments });
  //       break;
  //     } catch (se) {
  //       const code = se?.response?.data?.code;
  //       if (code === "attachment.not.ready" && attempt < 3) {
  //         await new Promise((r) => setTimeout(r, 1200));
  //         continue;
  //       }
  //       throw se;
  //     }
  //   }
  //   const mid = maxResult?.message?.body?.mid || "";
  //   const url = maxResult?.message?.url || "-";
  //   const { midError } = mid
  //     ? await savePostMeta({ jwt, urlStrapi, midDocId, mids: mid, postText: null })
  //     : { midError: null };
  //   if (midError) {
  //     return { ok: false, message: `отправлено (mid=${mid}), но mid не сохранён в Strapi: ${midError}` };
  //   }
  //   return {
  //     ok: true,
  //     message: `guid=${guid} mid=${mid || "-"} url=${url}${tablesNote}` +
  //       (mid ? "; mid сохранён в Strapi" : "; mid отсутствует в ответе MAX"),
  //   };
  // } catch (e) {
  //   return { ok: false, message: e?.response?.data?.message || e?.message };
  // }
  // ── КОНЕЦ СТАРОГО ФОРМАТА ──

  // ── НОВЫЙ ФОРМАТ: текст → PDF#1 → PDF#2 (3 отдельных сообщения) ──
  let pdfs = [];
  let tablesNote = "";
  try {
    pdfs = await generateTablesPdfs({ jwt });
    console.log(
      `[tnmax] PDF сформированы для guid=${guid}: ${pdfs.map((p) => `${p.name}:${p.buffer.length}б`).join(", ")}, загружаю в MAX...`
    );
  } catch (te) {
    pdfs = [];
    tablesNote = ` таблицы НЕ отправлены: ${te?.message}`;
    console.warn(`[tnmax] PDF не сформированы для guid=${guid}:`, te?.message);
  }

  const sentMids = [];
  const sentUrls = [];

  try {
    // 1) Текст (рич-шаблон, fallback guid)
    await sendWithRetry({ text: postText }, "текст", sentMids, sentUrls);
    await new Promise((r) => setTimeout(r, SEND_PAUSE_MS));

    // 2–3) PDF-файлы — по одному file-вложению на сообщение (лимит MAX)
    for (let i = 0; i < pdfs.length; i += 1) {
      const pdf = pdfs[i];
      try {
        const fileToken = await uploadFile(pdf.buffer, pdf.name);
        await sendWithRetry(
          { attachments: [{ type: "file", payload: { token: fileToken } }] },
          pdf.name,
          sentMids,
          sentUrls
        );
      } catch (fe) {
        tablesNote += ` ${pdf.name} НЕ отправлен: ${fe?.response?.data?.message || fe?.message};`;
        console.warn(`[tnmax] ${pdf.name} не отправлен (guid=${guid}):`, fe?.message);
      }
      if (i < pdfs.length - 1) await new Promise((r) => setTimeout(r, SEND_PAUSE_MS));
    }

    const midField = sentMids.join(",");
    const url = sentUrls[0] || "-";
    const { midError, textError } = await savePostMeta({
      jwt, urlStrapi, midDocId, mids: midField, postText,
    });

    const savedNote = midError
      ? `mid НЕ сохранён: ${midError}`
      : midField
        ? "mid сохранён"
        : "mid отсутствует в ответе MAX";
    const textNote = postText
      ? textError
        ? `, текст НЕ сохранён: ${textError} (проверь, что поле Text (long) в Strapi)`
        : ", текст сохранён"
      : "";

    if (midError) {
      return {
        ok: false,
        message: `отправлено (mid=${midField || "-"}), но ${savedNote}${textNote}`,
      };
    }
    if (textError) {
      // mid есть — это главное для гашения; текст добьём после правки типа поля
      return {
        ok: true,
        message: `guid=${guid} mid=${midField || "-"} url=${url} сообщений=${sentMids.length}${tablesNote}; ${savedNote}${textNote}`,
      };
    }
    return {
      ok: true,
      message: `guid=${guid} mid=${midField || "-"} url=${url} сообщений=${sentMids.length}${tablesNote}; ${savedNote}${textNote}`,
    };
  } catch (e) {
    // Текст мог уйти до падения PDF — сохраним хотя бы его mid + текст
    if (sentMids.length) {
      await savePostMeta({ jwt, urlStrapi, midDocId, mids: sentMids.join(","), postText });
    }
    return {
      ok: false,
      message: `guid=${guid} mid=${sentMids.join(",") || "-"}: ${e?.response?.data?.message || e?.message}`,
    };
  }
}

module.exports = {
  publishTnPost,
  savePostMeta,
  calcSequenceNumber,
  operationalWindowStart,
};
