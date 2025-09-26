const express = require("express");
const axios = require("axios");
const { broadcast } = require("../services/sse");
require("dotenv").config();
const { fetchByFias } = require("./dadata");

const router = express.Router();
const secretModus = process.env.SECRET_FOR_MODUS;

// Достаём Bearer-токен из заголовка и сравниваем только значение
const isAuthorized = (req) => {
  const raw = (
    req.get("authorization") ||
    req.get("Authorization") ||
    ""
  ).trim();
  const match = /^Bearer\s+(.+)$/i.exec(raw);
  const token = match ? match[1].trim() : "";
  const ok = token && token === String(secretModus || "");
  if (!ok) {
    // Временный диагностический лог (замаскирован):
    const mask = (s) => (s ? `${s.slice(0, 4)}…${s.slice(-4)}` : "<empty>");
    console.warn(
      "[modus] Forbidden: token=",
      mask(token),
      " expected=",
      mask(String(secretModus || ""))
    );
  }
  return ok;
};

const loginStrapi = process.env.LOGIN_STRAPI;
const passwordStrapi = process.env.PASSWORD_STRAPI;
const urlStrapi = process.env.URL_STRAPI;

async function getJwt() {
  try {
    const res = await axios.post(`${urlStrapi}/api/auth/local`, {
      identifier: loginStrapi,
      password: passwordStrapi,
    });
    if (res.data) {
      return res.data.jwt;
    } else {
      return false;
    }
  } catch (error) {
    console.log(error);
    return false;
  }
}

// --- адреса по FIAS -------------------------------------------------------
/** Вернуть массив GUID-ов FIAS из «сырых» данных МОДУС */
function extractFiasList(rawItem) {
  const raw =
    rawItem?.FIAS_LIST ||
    rawItem?.data?.FIAS_LIST ||
    rawItem?.data?.data?.FIAS_LIST ||
    "";
  return Array.from(
    new Set(
      String(raw)
        .split(/[;,]/)
        .map((s) => s.trim())
        .filter(Boolean)
    )
  );
}

/**
 * На каждый FIAS:
 * - если нет такого адреса в Strapi → берём из DaData координаты и полный адрес
 * - сохраняем в коллекцию "Адрес" (API uid: /api/adress)
 *
 * ВАЖНО: функция ограничивает параллелизм и не создаёт пустых адресов, если DaData не ответила.
 */
async function upsertAddressesInStrapi(fiasIds, jwt) {
  const ids = Array.from(new Set((fiasIds || []).map((x) => String(x).trim()).filter(Boolean)));
  if (!ids.length) return;

  const CONCURRENCY = Number(process.env.DADATA_CONCURRENCY || 2); // не душим DaData и Strapi
  const queue = ids.slice();

  async function worker() {
    while (queue.length) {
      const fiasId = queue.shift();
      try {
        // Ищем существующую запись
        const search = await axios.get(`${urlStrapi}/api/adress`, {
          headers: { Authorization: `Bearer ${jwt}` },
          params: { "filters[fiasId][$eq]": fiasId, "pagination[pageSize]": 1 },
        });
        const existing = Array.isArray(search?.data?.data) ? search.data.data[0] : null;

        // Тянем DaData
        const info = await fetchByFias(fiasId);
        const payload = {
          fiasId,
          ...(info?.fullAddress ? { fullAddress: info.fullAddress } : {}),
          ...(info?.lat ? { lat: String(info.lat) } : {}),
          ...(info?.lon ? { lon: String(info.lon) } : {}),
          ...(info?.all ? { all: info.all } : {}),
        };

        if (existing) {
          const existingAttrs = existing?.attributes || existing;
          const existingId = existing?.documentId || existing?.id;
          const patch = {};
          const jsonEq = (a, b) => {
            try { return JSON.stringify(a ?? null) === JSON.stringify(b ?? null); } catch { return false; }
          };
          if (!existingAttrs?.fullAddress && payload.fullAddress) patch.fullAddress = payload.fullAddress;
          if (!existingAttrs?.lat && payload.lat) patch.lat = payload.lat;
          if (!existingAttrs?.lon && payload.lon) patch.lon = payload.lon;
          if (payload.all && !jsonEq(existingAttrs?.all, payload.all)) patch.all = payload.all;

          if (Object.keys(patch).length) {
            await axios.put(
              `${urlStrapi}/api/adress/${existingId}`,
              { data: patch },
              { headers: { Authorization: `Bearer ${jwt}` } }
            );
          }
          continue;
        }

        // Не создаём пустых адресов, если DaData не ответила
        if (!info) continue;

        await axios.post(
          `${urlStrapi}/api/adress`,
          { data: payload },
          { headers: { Authorization: `Bearer ${jwt}` } }
        );
      } catch (e) {
        console.warn("[modus] upsertAddressesInStrapi error:", fiasId, e?.response?.status || e?.code || e?.message);
      }
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, ids.length) }, worker);
  await Promise.all(workers);
}

router.put("/", async (req, res) => {
  try {
    if (!isAuthorized(req)) {
      return res.status(403).json({ status: "Forbidden" });
    }

    const items = req.body.data || req.body.Data;
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        status: "error",
        message: "Не хватает требуемых данных (ожидается Data или data: массив)",
      });
    }

    const mapItem = (item) => {
      const status = (item.STATUS_NAME || "").toString().trim().toLowerCase();
      const isActive = status === "открыта";
      return {
        guid: item.VIOLATION_GUID_STR,
        number: `${item.F81_010_NUMBER}`,
        energoObject: item.F81_041_ENERGOOBJECTNAME,
        createDateTime: item.F81_060_EVENTDATETIME,
        recoveryPlanDateTime: item.CREATE_DATETIME,
        addressList: item.ADDRESS_LIST,
        description: item.F81_042_DISPNAME,
        recoveryFactDateTime: item.F81_290_RECOVERYDATETIME,
        dispCenter: item.DISPCENTER_NAME_,
        STATUS_NAME: (item.STATUS_NAME || "").toString().trim(),
        isActive,
        data: item,
      };
    };

    const buildPatch = (current, next) => {
      const patch = {};
      Object.keys(next).forEach((key) => {
        const prevVal = current?.[key];
        const nextVal = next[key];
        const eq =
          typeof nextVal === "object" && nextVal !== null
            ? JSON.stringify(prevVal) === JSON.stringify(nextVal)
            : prevVal === nextVal;
        if (!eq) patch[key] = nextVal;
      });
      return patch;
    };

    const jwt = await getJwt();
    if (!jwt) {
      return res.status(500).json({ status: "error", message: "Не удалось авторизоваться в Strapi" });
    }

    const fiasSet = new Set();

    const results = await items.reduce(async (prevPromise, rawItem, index) => {
      const acc = await prevPromise;
      const mapped = mapItem(rawItem);

      // собираем FIAS из входного элемента
      try { extractFiasList(rawItem).forEach((id) => fiasSet.add(id)); } catch {}

      if (!mapped.guid) {
        acc.push({ success: false, index: index + 1, error: "Не передан GUID записи" });
        return acc;
      }

      try {
        const search = await axios.get(`${urlStrapi}/api/teh-narusheniyas`, {
          headers: { Authorization: `Bearer ${jwt}` },
          params: { "filters[guid][$eq]": mapped.guid, "pagination[pageSize]": 1 },
        });

        const found = search?.data?.data?.[0];
        const documentId = found?.documentId || found?.id;
        const current = found || {};

        if (!documentId) {
          console.warn(`[modus] Не найдена запись по guid=${mapped.guid}`);
          acc.push({ success: false, index: index + 1, status: "not_found", error: "Запись с таким GUID не найдена" });
          return acc;
        }

        const patch = buildPatch(current, mapped);

        if (Object.keys(patch).length === 0) {
          acc.push({ success: true, index: index + 1, id: documentId, updated: false, message: "Изменений нет" });
          return acc;
        }

        const upd = await axios.put(
          `${urlStrapi}/api/teh-narusheniyas/${documentId}`,
          { data: patch },
          { headers: { Authorization: `Bearer ${jwt}` } }
        );

        try {
          broadcast({ type: "tn-upsert", source: "modus", action: "update", id: documentId, guid: mapped.guid, patch, timestamp: Date.now() });
        } catch (e) {
          console.error("SSE broadcast error (update):", e?.message);
        }

        acc.push({ success: true, index: index + 1, id: upd?.data?.data?.id || documentId, updated: true });
      } catch (e) {
        const msg = e?.response?.data?.error?.message || e?.message || "Неизвестная ошибка";
        acc.push({ success: false, index: index + 1, error: msg });
      }

      return acc;
    }, Promise.resolve([]));

    // Фоновая обработка адресов — не блокируем ответ
    setTimeout(() => {
      if (!fiasSet.size) return;
      upsertAddressesInStrapi([...fiasSet], jwt).catch((e) => console.warn("[modus] background address upsert failed:", e?.message));
    }, 0);

    return res.json({ status: "ok", results });
  } catch (e) {
    const msg = e?.message || "Внутренняя ошибка сервера";
    return res.status(500).json({ status: "error", message: msg });
  }
});

router.post("/", async (req, res) => {
  const authorization = req.get("Authorization");

  async function sendDataSequentially(dataArray) {
    const jwt = await getJwt();
    const fiasSet = new Set();

    const results = await dataArray.reduce(async (previousPromise, item, index) => {
      const accumulatedResults = await previousPromise;
      try {
        console.log(`Отправка элемента ${index + 1} из ${dataArray.length}`);
        const response = await axios.post(
          `${urlStrapi}/api/teh-narusheniyas`,
          { data: { ...item } },
          { headers: { Authorization: `Bearer ${jwt}` } }
        );
        accumulatedResults.push({ success: true, id: response.data?.data.id, index: index + 1 });
        console.log(`Элемент ${index + 1} успешно отправлен`);

        // Копим FIAS — обработаем одним фоном
        try { extractFiasList(item).forEach((id) => fiasSet.add(id)); } catch (e) { console.warn("[modus] address parsing skipped:", e?.message); }

        // Рассылка в SSE — создание ТН
        try {
          broadcast({ type: "tn-upsert", source: "modus", action: "create", id: response.data?.data?.id, entry: { ...item, id: response.data?.data?.id }, timestamp: Date.now() });
        } catch (e) {
          console.error("SSE broadcast error (create):", e?.message);
        }
      } catch (error) {
        console.error(`Ошибка при отправке элемента ${index + 1}:`, error.message);
        accumulatedResults.push({ success: false, error: error.message, index: index + 1 });
      }

      return accumulatedResults;
    }, Promise.resolve([]));

    // Фоновая обработка адресов — не блокируем ответ МОДУСу
    setTimeout(() => {
      if (!fiasSet.size) return;
      upsertAddressesInStrapi([...fiasSet], jwt).catch((e) =>
        console.warn("[modus] background address upsert failed:", e?.message)
      );
    }, 0);

    return results;
  }

  if (authorization === `Bearer ${secretModus}`) {
    if (!req.body?.Data) {
      return res.status(400).json({ status: "error", message: "Не хватает требуемых данных" });
    }
    const data = req.body.Data;
    const prepareData = data.map((item) => ({
      guid: item.VIOLATION_GUID_STR,
      number: `${item.F81_010_NUMBER}`,
      energoObject: item.F81_041_ENERGOOBJECTNAME,
      createDateTime: item.F81_060_EVENTDATETIME,
      recoveryPlanDateTime: item.CREATE_DATETIME,
      addressList: item.ADDRESS_LIST,
      description: item.F81_042_DISPNAME,
      recoveryFactDateTime: item.F81_290_RECOVERYDATETIME,
      dispCenter: item.DISPCENTER_NAME_,
      STATUS_NAME: (item.STATUS_NAME || "").toString().trim(),
      isActive: ((item.STATUS_NAME || "").toString().trim().toLowerCase() === "открыта"),
      data: item,
    }));

    const results = await sendDataSequentially(prepareData);
    if (results) {
      return res.json({ status: "ok", results });
    } else {
      return res.status(500).json({ status: "error" });
    }
  } else {
    res.status(403).json({ status: "Forbidden" });
  }
});

module.exports = router;
