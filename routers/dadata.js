const axios = require("axios");
require("dotenv").config();

const DADATA_TOKEN = process.env.DADATA_TOKEN;
const DADATA_SECRET = process.env.DADATA_SECRET || "";
const DADATA_RPS = Math.max(1, Number(process.env.DADATA_RPS || 2));
const DADATA_MAX_RETRY = Math.max(0, Number(process.env.DADATA_MAX_RETRY || 5));
const DADATA_TIMEOUT = Math.max(
  3000,
  Number(process.env.DADATA_TIMEOUT || 12000)
);

// Глобальный (для процесса) ограничитель частоты запросов
const MIN_INTERVAL_MS = Math.floor(1000 / DADATA_RPS);
let lastCallTs = 0;

// Простейший кэш на процесс, чтобы не дёргать DaData по одному и тому же FIAS
const cache = new Map(); // fiasId -> Promise | result

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchByFias(fiasId) {
  const id = String(fiasId || "").trim();
  // console.log(`[fetchByFias] Запрос данных для FIAS: ${id}`);

  if (!id) {
    console.log(`[fetchByFias] Пустой FIAS код`);
    return null;
  }

  if (!DADATA_TOKEN) {
    console.warn("[dadata] DADATA_TOKEN отсутствует в .env");
    return null;
  }

  if (cache.has(id)) {
    console.log(`[fetchByFias] Используем кэш для FIAS: ${id}`);
    return cache.get(id);
  }

  const exec = async () => {
    // Простой глобальный RPS‑лимитер (серии запросов с паузой между стартами)
    const now = Date.now();
    const wait = Math.max(0, MIN_INTERVAL_MS - (now - lastCallTs));
    if (wait) {
      // console.log(`[fetchByFias] Ждем ${wait} мс для соблюдения RPS`);
      await sleep(wait);
    }
    lastCallTs = Date.now();

    let attempt = 0;
    while (true) {
      try {
        // console.log(`[fetchByFias] Попытка ${attempt + 1} для FIAS: ${id}`);
        const { data } = await axios.post(
          "https://suggestions.dadata.ru/suggestions/api/4_1/rs/findById/address",
          { query: id },
          {
            headers: {
              Accept: "application/json",
              "Content-Type": "application/json",
              Authorization: `Token ${DADATA_TOKEN}`,
              ...(DADATA_SECRET ? { "X-Secret": DADATA_SECRET } : {}),
            },
            timeout: DADATA_TIMEOUT,
          }
        );

        // console.log(`[fetchByFias] Ответ от DaData для FIAS ${id}:`, {
        //   status: "OK",
        //   suggestions_count: data?.suggestions?.length || 0,
        // });

        const s = Array.isArray(data?.suggestions) ? data.suggestions[0] : null;
        if (!s) {
          // console.log(
          //   `[fetchByFias] Нет данных в ответе DaData для FIAS: ${id}`
          // );
          return null;
        }

        const result = {
          fullAddress: s.unrestricted_value || s.value || null,
          lat: s?.data?.geo_lat || null,
          lon: s?.data?.geo_lon || null,
          all: data,
        };

        // console.log(`[fetchByFias] Успешный ответ для FIAS ${id}:`, {
        //   fullAddress: result.fullAddress,
        //   lat: result.lat,
        //   lon: result.lon,
        // });

        return result;
      } catch (e) {
        const status = e?.response?.status;
        const code = e?.code;

        // 403 — неверный токен, нет доступа к методу или IP не в белом списке
        if (status === 403) {
          console.warn(
            `[dadata] 403 Forbidden for ${id} — проверь DADATA_TOKEN / белый список IP / доступ к Suggestions.`
          );
          return null;
        }

        // 429/503/сетевые — пробуем с экспоненциальным бэкоффом
        if (
          status === 429 ||
          status === 503 ||
          code === "ETIMEDOUT" ||
          code === "ECONNRESET" ||
          code === "EAI_AGAIN"
        ) {
          if (attempt < DADATA_MAX_RETRY) {
            const backoff =
              Math.min(15000, 400 * Math.pow(2, attempt)) +
              Math.floor(Math.random() * 200);
            attempt++;
            console.warn(
              `[fetchByFias] Ошибка ${
                status || code
              } для FIAS ${id}, повтор через ${backoff} мс, попытка ${attempt}`
            );
            await sleep(backoff);
            continue;
          }
        }

        console.warn(
          `[dadata] fetchByFias ${id}: ${status || code || ""} ${
            e?.message || ""
          }`
        );
        return null;
      }
    }
  };

  const p = exec();
  cache.set(id, p);
  try {
    const res = await p;
    cache.set(id, res);
    return res;
  } catch (err) {
    cache.delete(id);
    return null;
  }
}

module.exports = { fetchByFias };

// const axios = require("axios");
// require("dotenv").config();

// const DADATA_TOKEN = process.env.DADATA_TOKEN;
// const DADATA_SECRET = process.env.DADATA_SECRET || "";
// const DADATA_RPS = Math.max(1, Number(process.env.DADATA_RPS || 2));
// const DADATA_MAX_RETRY = Math.max(0, Number(process.env.DADATA_MAX_RETRY || 5));
// const DADATA_TIMEOUT = Math.max(3000, Number(process.env.DADATA_TIMEOUT || 12000));

// // Глобальный (для процесса) ограничитель частоты запросов
// const MIN_INTERVAL_MS = Math.floor(1000 / DADATA_RPS);
// let lastCallTs = 0;

// // Простейший кэш на процесс, чтобы не дёргать DaData по одному и тому же FIAS
// const cache = new Map(); // fiasId -> Promise | result

// const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// async function fetchByFias(fiasId) {
//   const id = String(fiasId || "").trim();
//   console.log(`[fetchByFias] Запрос данных для FIAS: ${id}`);
//   if (!id) return null;
//   if (!DADATA_TOKEN) {
//     console.warn("[dadata] DADATA_TOKEN отсутствует в .env");
//     return null;
//   }

//   if (cache.has(id)) return cache.get(id);

//   const exec = async () => {
//     // Простой глобальный RPS‑лимитер (серии запросов с паузой между стартами)
//     const now = Date.now();
//     const wait = Math.max(0, MIN_INTERVAL_MS - (now - lastCallTs));
//     if (wait) await sleep(wait);
//     lastCallTs = Date.now();

//     let attempt = 0;
//     while (true) {
//       try {
//         const { data } = await axios.post(
//           "https://suggestions.dadata.ru/suggestions/api/4_1/rs/findById/address",
//           { query: id },
//           {
//             headers: {
//               Accept: "application/json",
//               "Content-Type": "application/json",
//               Authorization: `Token ${DADATA_TOKEN}`,
//               ...(DADATA_SECRET ? { "X-Secret": DADATA_SECRET } : {}),
//             },
//             timeout: DADATA_TIMEOUT,
//           }
//         );

//         const s = Array.isArray(data?.suggestions) ? data.suggestions[0] : null;
//         if (!s) return null;

//         return {
//           fullAddress: s.unrestricted_value || s.value || null,
//           lat: s?.data?.geo_lat || null,
//           lon: s?.data?.geo_lon || null,
//           all: data,
//         };
//       } catch (e) {
//         const status = e?.response?.status;
//         const code = e?.code;

//         // 403 — неверный токен, нет доступа к методу или IP не в белом списке
//         if (status === 403) {
//           console.warn(`[dadata] 403 Forbidden for ${id} — проверь DADATA_TOKEN / белый список IP / доступ к Suggestions.`);
//           return null;
//         }

//         // 429/503/сетевые — пробуем с экспоненциальным бэкоффом
//         if (status === 429 || status === 503 || code === "ETIMEDOUT" || code === "ECONNRESET" || code === "EAI_AGAIN") {
//           if (attempt < DADATA_MAX_RETRY) {
//             const backoff = Math.min(15000, 400 * Math.pow(2, attempt)) + Math.floor(Math.random() * 200);
//             attempt++;
//             await sleep(backoff);
//             continue;
//           }
//         }

//         console.warn(`[dadata] fetchByFias ${id}: ${status || code || ""} ${e?.message || ""}`);
//         return null;
//       }
//     }
//   };

//   const p = exec();
//   cache.set(id, p);
//   try {
//     const res = await p;
//     cache.set(id, res);
//     return res;
//   } catch (err) {
//     cache.delete(id);
//     return null;
//   }
// }

// module.exports = { fetchByFias };
