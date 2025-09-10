import express from "express";
import axios from "axios";

const router = express.Router();

const COMMON_SYS =
  "Вы — дружелюбный AI-аналитик технологических нарушений. " +
  "Кратко, по делу, без лишней воды. Чёткие формулировки на русском.";

const MODELS = [
  "openai/gpt-4o-mini",
  "anthropic/claude-3-haiku-20240307",
  "mistralai/mistral-7b-instruct",
];

function buildPrompt(mode, metrics) {
  const head =
    "Ниже метрики по технологическим нарушениям в JSON. " +
    "Сформируйте ответ для руководства: короткие пункты, числа, без Markdown-разметки, без кода.\n";
  const body = JSON.stringify(metrics);
  if (mode === "recs") {
    return head + "Задача: дайте 5 приоритезированных рекомендаций, опираясь на метрики.\n" + body;
  }
  if (mode === "anomalies") {
    return head + "Задача: кратко перечислите аномалии из metrics.outliers с пояснениями.\n" + body;
  }
  return head + "Задача: дайте краткое резюме и ключевые выводы.\n" + body;
}

router.post("/analysis", async (req, res) => {
  const { metrics, mode = "summary" } = req.body || {};
  if (!metrics) return res.status(400).json({ error: "Missing metrics" });

  const prompt = buildPrompt(mode, metrics);
  let answer = null;

  for (const model of MODELS) {
    try {
      const { data } = await axios.post(
        "https://openrouter.ai/api/v1/chat/completions",
        { model, messages: [{ role: "system", content: COMMON_SYS }, { role: "user", content: prompt }] },
        {
          headers: {
            Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
            "Content-Type": "application/json",
          },
          timeout: 20000,
        }
      );
      answer = data?.choices?.[0]?.message?.content?.trim();
      if (answer) break;
    } catch (e) {
      console.warn("openrouter failure for", model, e?.response?.status || e.message);
    }
  }

  if (!answer) {
    // мягкий фоллбек — чтоб фронт не пустел
    return res.status(200).json({ text: "LLM временно недоступен. Используйте локальное резюме на клиенте." });
  }

  // CORS для фронта (если надо)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.json({ text: answer });
});

export default router;