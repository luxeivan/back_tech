// TN MAX (ОО): публикация и удаление сообщений в тестовом канале через бота.
// POST /services/tnmax/send — принимает JSON, шлёт пост в канал (chat_id из MAX_CHAT_ID_OO).
// DELETE /services/tnmax/messages/:mid — удаляет пост; ?guid=... чистит поле в Strapi.
const express = require("express");
const axios = require("axios");
const { getConfig, sendToChannel, deleteMessage } = require("../services/tnmax/tnMaxChannel");
const { getJwt } = require("../services/modus/strapi");

const router = express.Router();

router.post("/send", async (req, res) => {
  const text = String(req.body?.text ?? req.body?.message ?? "").trim();
  if (!text) {
    return res.status(400).json({ ok: false, message: "Поле text (или message) обязательно" });
  }
  if (text.length > 4000) {
    return res
      .status(400)
      .json({ ok: false, message: "text длиннее 4000 символов — лимит MAX" });
  }

  const { token, chatId } = getConfig();
  if (!token || !chatId) {
    console.error(
      `[tnmax] конфиг неполный: token=${Boolean(token)} chat_id=${chatId || null} (нужны TN_MAX_BOT_OO / MAX_CHAT_ID_OO)`
    );
    return res.status(500).json({
      ok: false,
      message: "Не настроены TN_MAX_BOT_OO / MAX_CHAT_ID_OO",
      token: Boolean(token),
      chat_id: chatId || null,
    });
  }

  const startedAt = Date.now();
  const attachmentsCount = Array.isArray(req.body?.attachments) ? req.body.attachments.length : 0;
  console.log(
    `[tnmax] → отправка в MAX: chat_id=${chatId}` +
      `, chars=${text.length}` +
      (attachmentsCount ? `, attachments=${attachmentsCount}` : "") +
      `, preview="${text.slice(0, 80)}${text.length > 80 ? "…" : ""}"`
  );

  try {
    const message = await sendToChannel({
      text,
      format: req.body?.format,
      attachments: req.body?.attachments,
      notify: req.body?.notify,
      disable_link_preview: req.body?.disable_link_preview,
    });
    const ms = Date.now() - startedAt;
    const sent = message?.message;
    console.log(
      `[tnmax] ✓ OK 200: chat_id=${chatId}` +
        `, mid=${sent?.body?.mid || "-"}` +
        `, url=${sent?.url || "-"}` +
        `, ${ms}ms`
    );
    res.json({ ok: true, chat_id: chatId, message });
  } catch (e) {
    const ms = Date.now() - startedAt;
    const status = e?.response?.status || "нет ответа";
    const maxData = e?.response?.data || null;
    console.error(
      `[tnmax] ✗ FAIL: chat_id=${chatId}, MAX HTTP ${status}` +
        `, ${maxData ? JSON.stringify(maxData) : e?.message}` +
        `, ${ms}ms`
    );
    res.status(502).json({
      ok: false,
      message: e?.response?.data?.message || e?.message || "Ошибка отправки в MAX",
      max: maxData,
    });
  }
});

router.delete("/messages/:mid", async (req, res) => {
  const mid = String(req.params.mid ?? "").trim();
  const guid = String(req.query.guid ?? "").trim() || null;

  if (!mid) {
    return res.status(400).json({ ok: false, message: "mid обязателен (в пути запроса)" });
  }

  const startedAt = Date.now();
  console.log(`[tnmax] → удаление из MAX: mid=${mid}${guid ? `, guid=${guid}` : ""}`);

  try {
    const result = await deleteMessage(mid);
    const ms = Date.now() - startedAt;
    console.log(`[tnmax] ✓ удалено: mid=${mid}, ${ms}ms`);

    let strapiCleared = null;
    if (guid) {
      try {
        const jwt = await getJwt();
        const urlStrapi = String(process.env.URL_STRAPI || "").replace(/\/$/, "");
        const found = await axios.get(`${urlStrapi}/api/teh-narusheniyas`, {
          headers: { Authorization: `Bearer ${jwt}` },
          params: { "filters[guid][$eq]": guid, "pagination[pageSize]": 1 },
          timeout: 15000,
        });
        const doc = found?.data?.data?.[0];
        if (doc) {
          await axios.put(
            `${urlStrapi}/api/teh-narusheniyas/${doc.documentId || doc.id}`,
            { data: { mid_MAX_operativnayObstanovka: null } },
            { headers: { Authorization: `Bearer ${jwt}` }, timeout: 15000 }
          );
          strapiCleared = true;
        } else {
          strapiCleared = false;
        }
      } catch (se) {
        console.warn(
          `[tnmax] mid удалён из MAX, но поле в Strapi не очищено (guid=${guid}):`,
          se?.response?.status || se?.message
        );
      }
    }

    res.json({ ok: true, mid, guid, strapi_cleared: strapiCleared, result });
  } catch (e) {
    const ms = Date.now() - startedAt;
    const status = e?.response?.status || "нет ответа";
    const maxData = e?.response?.data || null;
    console.error(
      `[tnmax] ✗ FAIL удаление: mid=${mid}, MAX HTTP ${status}` +
        `, ${maxData ? JSON.stringify(maxData) : e?.message}` +
        `, ${ms}ms`
    );
    res.status(502).json({
      ok: false,
      message: e?.response?.data?.message || e?.message || "Ошибка удаления в MAX",
      max: maxData,
    });
  }
});

module.exports = router;
