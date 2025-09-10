import express from "express";
import axios from "axios";
import { randomUUID } from "node:crypto";

const router = express.Router();

// ====== Logging helpers ======
const LOG_PREFIX = "[AI]";
const MAX_PROMPT_LOG = 4000; // avoid flooding logs
const MAX_ANSWER_LOG = 800;
const log = (...args) => console.log(new Date().toISOString(), LOG_PREFIX, ...args);
const trimForLog = (s, n) =>
  typeof s === "string" && s.length > n ? s.slice(0, n) + `…(+${s.length - n})` : s;

// ====== Prompt/Models config ======
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
    return (
      head +
      "Задача: дайте 5 приоритезированных рекомендаций, опираясь на метрики.\n" +
      body
    );
  }
  if (mode === "anomalies") {
    return head + "Задача: кратко перечислите аномалии из metrics.outliers с пояснениями.\n" + body;
  }
  return head + "Задача: дайте краткое резюме и ключевые выводы.\n" + body;
}

router.post("/analysis", async (req, res) => {
  const { metrics, mode = "summary" } = req.body || {};
  const reqId = randomUUID().slice(0, 8);

  if (!metrics) {
    log(`[${reqId}] /ai/analysis -> 400 Missing metrics`);
    return res.status(400).json({ error: "Missing metrics" });
  }

  // Build prompt & initial request log
  const prompt = buildPrompt(mode, metrics);
  const keys = Object.keys(metrics || {});
  log(`[${reqId}] /ai/analysis accepted: mode=${mode}; metricsKeys=${keys.length ? keys.join(",") : "—"}`);
  log(`[${reqId}] -> OpenRouter prompt (${prompt.length} chars):\n` + trimForLog(prompt, MAX_PROMPT_LOG));

  let answer = null;
  let usedModel = null;

  for (const model of MODELS) {
    const t0 = Date.now();
    log(`[${reqId}] -> calling OpenRouter model=${model} url=https://openrouter.ai/api/v1/chat/completions`);
    try {
      const { data } = await axios.post(
        "https://openrouter.ai/api/v1/chat/completions",
        {
          model,
          messages: [
            { role: "system", content: COMMON_SYS },
            { role: "user", content: prompt },
          ],
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
            "Content-Type": "application/json",
          },
          timeout: 20000,
        }
      );
      answer = data?.choices?.[0]?.message?.content?.trim();
      usedModel = model;
      const ms = Date.now() - t0;
      if (answer) {
        log(`[${reqId}] <- model=${model} OK ${ms}ms; answerLen=${answer.length}`);
        break;
      } else {
        log(`[${reqId}] <- model=${model} empty answer ${ms}ms`);
      }
    } catch (e) {
      const ms = Date.now() - t0;
      const status = e?.response?.status || "ERR";
      log(`[${reqId}] x model=${model} ${ms}ms status=${status} msg=${e?.message}`);
      try {
        if (e?.response?.data) {
          const body = typeof e.response.data === "string" ? e.response.data : JSON.stringify(e.response.data);
          log(`[${reqId}]   responseBody: ` + trimForLog(body, 600));
        }
      } catch {}
    }
  }

  if (!answer) {
    log(`[${reqId}] all models failed — returning fallback text`);
    // мягкий фоллбек — чтоб фронт не пустел
    return res
      .status(200)
      .json({ text: "LLM временно недоступен. Используйте локальное резюме на клиенте." });
  }

  log(`[${reqId}] returning model=${usedModel}; answerPreview:\n` + trimForLog(answer, MAX_ANSWER_LOG));

  // CORS & debug headers for frontend
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (usedModel) res.setHeader("X-AI-Model", usedModel);
  res.setHeader("X-AI-Request-Id", reqId);

  res.json({ text: answer });
});

export default router;