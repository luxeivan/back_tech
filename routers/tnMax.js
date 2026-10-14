// TN MAX (ОО): публикация сообщений в тестовый канал через бота.
// POST /services/tnmax/send — принимает JSON, шлёт пост в канал из MAX_CHANEL_OO.
const express = require("express");
const { getConfig, sendToChannel } = require("../services/tnmax/tnMaxChannel");

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

module.exports = router;
