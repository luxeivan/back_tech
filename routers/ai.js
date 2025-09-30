const express = require("express");
const axios = require("axios");
const { randomUUID } = require("node:crypto");

const router = express.Router();

/** ===================== ВСПОМОГАТЕЛЬНОЕ ЛОГИРОВАНИЕ ===================== */
const LOG_PREFIX = "[AI]";
const MAX_PROMPT_LOG = 5000; // чтобы не залить логи километровыми промптами
const MAX_ANSWER_LOG = 1500;
const log = (...args) =>
  console.log(new Date().toISOString(), LOG_PREFIX, ...args);
const trimForLog = (s, n) =>
  typeof s === "string" && s.length > n
    ? s.slice(0, n) + `…(+${s.length - n})`
    : s;

/** ===================== НАСТРОЙКИ ПРОМПТА/МОДЕЛЕЙ ===================== */
const COMMON_SYS =
  "Вы — дружелюбный AI‑аналитик технологических нарушений в МО. " +
  "Готовьте краткие выводы для руководства: без воды и без кода. " +
  "Только русский язык. Никаких тегов, спецсимволов, Markdown/HTML, префиксов вида <s>, </s>, [OUT]/[IN] или эмодзи. " +
  "Ответ — чистый текст по пунктам, каждая мысль с новой строки.";

const MODELS = [
  "openai/gpt-4o-mini", // основной
  "anthropic/claude-3-haiku-20240307", // фоллбек 1
  "mistralai/mistral-7b-instruct", // фоллбек 2
];

function buildPrompt(mode, metrics) {
  const head =
    "Ниже метрики по технологическим нарушениям в JSON. " +
    "Сформируйте лаконичный ответ для руководства: короткие пункты, цифры, без Markdown и без кода.\n";
  const body = JSON.stringify(metrics);

  if (mode === "recs") {
    return (
      head +
      "Задача: дайте 5 приоритезированных рекомендаций, опираясь на метрики (укажите, на каких числах основано). " +
      "Формат: 3–5 пунктов, каждый на новой строке, без нумерации; начинайте с глагола. Без вводных и заключений. \n" +
      body
    );
  }
  if (mode === "anomalies") {
    return (
      head +
      "Задача: кратко перечислите аномалии из metrics.outliers с пояснениями, почему это аномалия. " +
      "Формат: короткие пункты. Если аномалий нет, ответ: «Аномалии не выявлены.»\n" +
      body
    );
  }
  // summary (по умолчанию)
  return (
    head +
    "Задача: дайте краткое резюме: сколько ТН, где концентрация, динамика, узкие места, 1‑2 конкретных вывода. " +
    "Формат: 4–6 коротких пунктов, без преамбул и выводов; только факты.\n" +
    body
  );
}

function sanitizeAnswer(raw, mode) {
  if (typeof raw !== "string") return "";
  let s = raw;
  // убрать кодовые блоки ```...```
  s = s.replace(/```[\s\S]*?```/g, (m) => m.replace(/```/g, ""));
  // убрать HTML/XML теги <...>
  s = s.replace(/<[^>]+>/g, "");
  // убрать служебные теги в квадратных скобках [OUT], [/OUT], [S] и т.п.
  s = s.replace(/\[\/?[\w\s-]+\]/gi, "");
  // убрать декоративные символы Markdown
  s = s.replace(/[\*_#>~`]+/g, "");
  // нормализовать пробелы, бережно к переносам строк
  s = s.replace(/\u00A0/g, " ");
  s = s
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length)
    .join("\n")
    .trim();

  if (!s) {
    if (mode === "anomalies") return "Аномалии не выявлены.";
    return "Нет итогового текста. Повторите попытку.";
  }
  return s;
}

/** ===================== CORS PREFLIGHT ===================== */
router.options("/analysis", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  return res.sendStatus(204);
});

/** ===================== ПИНГ (для быстрой проверки маршрута) ===================== */
router.get("/ping", (req, res) => {
  const reqId = randomUUID().slice(0, 8);
  log(`[${reqId}] GET /ai/ping — маршрут доступен`);
  res.setHeader("Access-Control-Allow-Origin", "*");
  return res.json({ ok: true, ts: Date.now() });
});

/** ===================== ОСНОВНОЙ МАРШРУТ АНАЛИТИКИ ===================== */
router.post("/analysis", async (req, res) => {
  const reqId = randomUUID().slice(0, 8);
  const { metrics, mode = "summary" } = req.body || {};

  log(`[${reqId}] POST /ai/analysis — входящий запрос`);
  if (!metrics) {
    log(`[${reqId}] ❌ Ошибка: не переданы metrics`);
    return res.status(400).json({ error: "Missing metrics" });
  }

  if (!process.env.OPENROUTER_API_KEY) {
    log(
      `[${reqId}] ⚠️ Предупреждение: переменная окружения OPENROUTER_API_KEY не установлена`
    );
  }

  // Формируем промпт и печатаем его полностью (с ограничением, чтобы не забить логи)
  const prompt = buildPrompt(mode, metrics);
  const keys = Object.keys(metrics || {});
  log(
    `[${reqId}] Принято: режим="${mode}", ключей в metrics=${
      keys.length ? keys.join(",") : "—"
    }`
  );
  log(
    `[${reqId}] → Промпт для OpenRouter (${prompt.length} симв.):\n` +
      trimForLog(prompt, MAX_PROMPT_LOG)
  );

  let answer = null;
  let usedModel = null;

  for (const model of MODELS) {
    const t0 = Date.now();
    log(
      `[${reqId}] → Вызов OpenRouter: модель="${model}", url=https://openrouter.ai/api/v1/chat/completions`
    );
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
        log(
          `[${reqId}] ← OK от модели "${model}" за ${ms}мс; длина ответа=${answer.length}`
        );
        break;
      } else {
        log(
          `[${reqId}] ← Пустой ответ от модели "${model}" за ${ms}мс — пробуем следующую`
        );
      }
    } catch (e) {
      const ms = Date.now() - t0;
      const status = e?.response?.status || "ERR";
      log(
        `[${reqId}] ⛔ Ошибка запроса к модели "${model}" за ${ms}мс; status=${status}; message=${e?.message}`
      );
      try {
        if (e?.response?.data) {
          const body =
            typeof e.response.data === "string"
              ? e.response.data
              : JSON.stringify(e.response.data);
          log(`[${reqId}]   Тело ошибки: ` + trimForLog(body, 800));
        }
      } catch {
        /* ignore */
      }
    }
  }

  if (!answer) {
    log(
      `[${reqId}] Все модели вернули ошибку/пусто — отдаем мягкий фоллбек, чтобы фронт не ломался`
    );
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.status(200).json({
      text: "LLM временно недоступен. Используйте локальное резюме на клиенте или повторите попытку позже.",
    });
  }

  const finalText = sanitizeAnswer(answer, mode);

  // Короткий предпросмотр ответа
  log(
    `[${reqId}] Возвращаю результат; модель="${usedModel}". Предпросмотр ответа:\n` +
      trimForLog(finalText, MAX_ANSWER_LOG)
  );

  // CORS + отладочные заголовки
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (usedModel) res.setHeader("X-AI-Model", usedModel);
  res.setHeader("X-AI-Request-Id", reqId);

  return res.json({ text: finalText });
});

module.exports = router;

// "use strict";

// const express = require("express");
// const axios = require("axios");
// const { randomUUID } = require("node:crypto");

// const router = express.Router();

// /** ===================== ВСПОМОГАТЕЛЬНОЕ ЛОГИРОВАНИЕ ===================== */
// const LOG_PREFIX = "[AI]";
// const MAX_PROMPT_LOG = 5000; // чтобы не залить логи километровыми промптами
// const MAX_ANSWER_LOG = 1500;
// const log = (...args) =>
//   console.log(new Date().toISOString(), LOG_PREFIX, ...args);
// const trimForLog = (s, n) =>
//   typeof s === "string" && s.length > n
//     ? s.slice(0, n) + `…(+${s.length - n})`
//     : s;

// /** ===================== НАСТРОЙКИ ПРОМПТА/МОДЕЛЕЙ ===================== */
// const COMMON_SYS =
//   "Вы — дружелюбный AI‑аналитик технологических нарушений в МО. " +
//   "Готовьте краткие выводы для руководства: без воды, без Markdown и без кода. " +
//   "Строго на русском языке. Формулировки чёткие, по пунктам.";

// const MODELS = [
//   "openai/gpt-4o-mini", // основной
//   "anthropic/claude-3-haiku-20240307", // фоллбек 1
//   "mistralai/mistral-7b-instruct", // фоллбек 2
// ];

// function buildPrompt(mode, metrics) {
//   const head =
//     "Ниже метрики по технологическим нарушениям в JSON. " +
//     "Сформируйте лаконичный ответ для руководства: короткие пункты, цифры, без Markdown и без кода.\n";
//   const body = JSON.stringify(metrics);

//   if (mode === "recs") {
//     return (
//       head +
//       "Задача: дайте 5 приоритезированных рекомендаций, опираясь на метрики (укажите, на каких числах основано). \n" +
//       body
//     );
//   }
//   if (mode === "anomalies") {
//     return (
//       head +
//       "Задача: кратко перечислите аномалии из metrics.outliers с пояснениями, почему это аномалия. \n" +
//       body
//     );
//   }
//   // summary (по умолчанию)
//   return (
//     head +
//     "Задача: дайте краткое резюме: сколько ТН, где концентрация, динамика, узкие места, 1‑2 конкретных вывода. \n" +
//     body
//   );
// }

// /** ===================== CORS PREFLIGHT ===================== */
// router.options("/analysis", (req, res) => {
//   res.setHeader("Access-Control-Allow-Origin", "*");
//   res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
//   res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
//   return res.sendStatus(204);
// });

// /** ===================== ПИНГ (для быстрой проверки маршрута) ===================== */
// router.get("/ping", (req, res) => {
//   const reqId = randomUUID().slice(0, 8);
//   log(`[${reqId}] GET /ai/ping — маршрут доступен`);
//   res.setHeader("Access-Control-Allow-Origin", "*");
//   return res.json({ ok: true, ts: Date.now() });
// });

// /** ===================== ОСНОВНОЙ МАРШРУТ АНАЛИТИКИ ===================== */
// router.post("/analysis", async (req, res) => {
//   const reqId = randomUUID().slice(0, 8);
//   const { metrics, mode = "summary" } = req.body || {};

//   log(`[${reqId}] POST /ai/analysis — входящий запрос`);
//   if (!metrics) {
//     log(`[${reqId}] ❌ Ошибка: не переданы metrics`);
//     return res.status(400).json({ error: "Missing metrics" });
//   }

//   if (!process.env.OPENROUTER_API_KEY) {
//     log(
//       `[${reqId}] ⚠️ Предупреждение: переменная окружения OPENROUTER_API_KEY не установлена`
//     );
//   }

//   // Формируем промпт и печатаем его полностью (с ограничением, чтобы не забить логи)
//   const prompt = buildPrompt(mode, metrics);
//   const keys = Object.keys(metrics || {});
//   log(
//     `[${reqId}] Принято: режим="${mode}", ключей в metrics=${
//       keys.length ? keys.join(",") : "—"
//     }`
//   );
//   log(
//     `[${reqId}] → Промпт для OpenRouter (${prompt.length} симв.):\n` +
//       trimForLog(prompt, MAX_PROMPT_LOG)
//   );

//   let answer = null;
//   let usedModel = null;

//   for (const model of MODELS) {
//     const t0 = Date.now();
//     log(
//       `[${reqId}] → Вызов OpenRouter: модель="${model}", url=https://openrouter.ai/api/v1/chat/completions`
//     );
//     try {
//       const { data } = await axios.post(
//         "https://openrouter.ai/api/v1/chat/completions",
//         {
//           model,
//           messages: [
//             { role: "system", content: COMMON_SYS },
//             { role: "user", content: prompt },
//           ],
//         },
//         {
//           headers: {
//             Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
//             "Content-Type": "application/json",
//           },
//           timeout: 20000,
//         }
//       );

//       answer = data?.choices?.[0]?.message?.content?.trim();
//       usedModel = model;
//       const ms = Date.now() - t0;

//       if (answer) {
//         log(
//           `[${reqId}] ← OK от модели "${model}" за ${ms}мс; длина ответа=${answer.length}`
//         );
//         break;
//       } else {
//         log(
//           `[${reqId}] ← Пустой ответ от модели "${model}" за ${ms}мс — пробуем следующую`
//         );
//       }
//     } catch (e) {
//       const ms = Date.now() - t0;
//       const status = e?.response?.status || "ERR";
//       log(
//         `[${reqId}] ⛔ Ошибка запроса к модели "${model}" за ${ms}мс; status=${status}; message=${e?.message}`
//       );
//       try {
//         if (e?.response?.data) {
//           const body =
//             typeof e.response.data === "string"
//               ? e.response.data
//               : JSON.stringify(e.response.data);
//           log(`[${reqId}]   Тело ошибки: ` + trimForLog(body, 800));
//         }
//       } catch {
//         /* ignore */
//       }
//     }
//   }

//   if (!answer) {
//     log(
//       `[${reqId}] Все модели вернули ошибку/пусто — отдаем мягкий фоллбек, чтобы фронт не ломался`
//     );
//     res.setHeader("Access-Control-Allow-Origin", "*");
//     return res.status(200).json({
//       text: "LLM временно недоступен. Используйте локальное резюме на клиенте или повторите попытку позже.",
//     });
//   }

//   // Короткий предпросмотр ответа
//   log(
//     `[${reqId}] Возвращаю результат; модель="${usedModel}". Предпросмотр ответа:\n` +
//       trimForLog(answer, MAX_ANSWER_LOG)
//   );

//   // CORS + отладочные заголовки
//   res.setHeader("Access-Control-Allow-Origin", "*");
//   if (usedModel) res.setHeader("X-AI-Model", usedModel);
//   res.setHeader("X-AI-Request-Id", reqId);

//   return res.json({ text: answer });
// });

// module.exports = router;
