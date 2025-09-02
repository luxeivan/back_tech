const express = require("express");
const router = express.Router();
const { broadcast } = require("../services/sse");

// Простой ping, удобно для кнопки Trigger в Strapi
router.get("/", (req, res) => {
  console.log("🔍 Вебхук: GET-проверка доступности");
  res.status(200).json({ message: "Эндпоинт вебхука доступен" });
});

// Прием событий от Strapi
router.post("/", (req, res) => {
  try {
    const payload = req.body;
    console.log("📬 Вебхук: получен POST от Strapi");
    console.log("📦 Полезная нагрузка:", JSON.stringify(payload, null, 2));
    const uidOrModel = String(payload?.uid || payload?.model || "");
    const looksLikeTN =
      uidOrModel.includes("teh-narusheniya") || uidOrModel.includes("tn");

    if (!looksLikeTN) {
      console.log("⚠️ Вебхук: это не ТН, пропускаем");
      return res.json({ skipped: true });
    }

    console.log("✔️ ТН событие:", payload?.event);

    // Разошлём всем подключенным клиентам (SSE)
    broadcast({
      type: "strapi-webhook",
      event: payload?.event,
      uid: payload?.uid,
      model: payload?.model,
      entry: payload?.entry,
      timestamp: Date.now(),
    });

    res.json({ message: "Вебхук принят" });
  } catch (e) {
    console.error("❗️ Вебхук: ошибка обработки:", e);
    res.status(500).json({ error: "Ошибка обработки вебхука" });
  }
});

module.exports = router;
