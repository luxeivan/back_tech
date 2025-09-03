const express = require("express");
const router = express.Router();
const { broadcast } = require("../services/sse");

router.all("/", (req, res) => {
  try {
    const method = req.method.toUpperCase();

    if (method === "GET" || method === "HEAD") {
      console.log("🔍 Вебхук: проверка доступности (", method, ")");
      return res.status(200).json({ message: "Эндпоинт вебхука доступен" });
    }

    if (method === "POST") {
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

      broadcast({
        type: "strapi-webhook",
        event: payload?.event,
        uid: payload?.uid,
        model: payload?.model,
        entry: payload?.entry,
        timestamp: Date.now(),
      });

      return res.json({ message: "Вебхук принят" });
    }

    // На всякий — остальные методы завершаем 204
    return res.sendStatus(204);
  } catch (e) {
    console.error("❗️ Вебхук: ошибка обработки:", e);
    return res.status(500).json({ error: "Ошибка обработки вебхука" });
  }
});

module.exports = router;