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
      let jwt = "";
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

function jsonEq(a, b) {
  try { return JSON.stringify(a ?? null) === JSON.stringify(b ?? null); }
  catch { return false; }
}

function mapModusItem(item) {
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
}

function buildPatch(current, next) {
  const patch = {};
  Object.keys(next).forEach((key) => {
    const prevVal = current?.[key];
    const nextVal = next[key];
    const eq = typeof nextVal === "object" && nextVal !== null
      ? jsonEq(prevVal, nextVal)
      : prevVal === nextVal;
    if (!eq) patch[key] = nextVal;
  });
  return patch;
}

/**
 * На каждый FIAS:
 * - если нет такого адреса в Strapi → берём из DaData координаты и полный адрес
 * - сохраняем в коллекцию "Адрес" (API uid: /api/adress)
 */
async function upsertAddressesInStrapi(fiasIds, jwt) {
  for (const fiasId of fiasIds) {
    try {
      // ищем существующую запись по fiasId
      const search = await axios.get(`${urlStrapi}/api/adress`, {
        headers: { Authorization: `Bearer ${jwt}` },
        params: { "filters[fiasId][$eq]": fiasId, "pagination[pageSize]": 1 },
      });
      const existing = Array.isArray(search?.data?.data) ? search.data.data[0] : null;

      // подтягиваем из DaData всё, что можем
      const info = await fetchByFias(fiasId);
      const payload = {
        fiasId,
        ...(info?.fullAddress ? { fullAddress: info.fullAddress } : {}),
        ...(info?.lat ? { lat: String(info.lat) } : {}),
        ...(info?.lon ? { lon: String(info.lon) } : {}),
        ...(info?.all ? { all: info.all } : {}),
      };

      if (existing) {
        // обновляем недостающие поля и/или устаревший JSON "all"
        const existingAttrs = existing?.attributes || existing;
        const existingId = existing?.documentId || existing?.id;
        const patch = {};

        if (!existingAttrs?.fullAddress && payload.fullAddress) patch.fullAddress = payload.fullAddress;
        if (!existingAttrs?.lat && payload.lat) patch.lat = payload.lat;
        if (!existingAttrs?.lon && payload.lon) patch.lon = payload.lon;
        // Если all отсутствует, пустой {} или отличается — обновляем
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

      // если не нашли — создаём только когда есть данные из DaData (чтобы не плодить пустые строки)
      if (info) {
        await axios.post(
          `${urlStrapi}/api/adress`,
          { data: payload },
          { headers: { Authorization: `Bearer ${jwt}` } }
        );
      } else {
        // пропускаем пустые записи — попробуем позже повторно
        continue;
      }
    } catch (e) {
      console.warn(
        "[modus] upsertAddressesInStrapi error:",
        fiasId,
        e?.response?.status || e?.code || e?.message
      );
    }
  }
}

async function upsertTnInStrapi(mapped, jwt) {
  if (!mapped?.guid) return { success: false, error: "Не передан GUID записи" };

  // ищем существующую запись по guid
  const search = await axios.get(`${urlStrapi}/api/teh-narusheniyas`, {
    headers: { Authorization: `Bearer ${jwt}` },
    params: { "filters[guid][$eq]": mapped.guid, "pagination[pageSize]": 1 },
  });
  const found = search?.data?.data?.[0] || null;
  const documentId = found?.documentId || found?.id;
  const current = found || {};

  if (documentId) {
    const patch = buildPatch(current, mapped);
    if (Object.keys(patch).length) {
      await axios.put(
        `${urlStrapi}/api/teh-narusheniyas/${documentId}`,
        { data: patch },
        { headers: { Authorization: `Bearer ${jwt}` } }
      );
      try {
        broadcast({ type: "tn-upsert", source: "modus", action: "update", id: documentId, guid: mapped.guid, patch, timestamp: Date.now() });
      } catch {}
      return { success: true, id: documentId, updated: true };
    }
    return { success: true, id: documentId, updated: false };
  }

  // создаём
  const created = await axios.post(
    `${urlStrapi}/api/teh-narusheniyas`,
    { data: { ...mapped } },
    { headers: { Authorization: `Bearer ${jwt}` } }
  );
  const newId = created?.data?.data?.id;
  try {
    broadcast({ type: "tn-upsert", source: "modus", action: "create", id: newId, entry: { ...mapped, id: newId }, timestamp: Date.now() });
  } catch {}
  return { success: true, id: newId, created: true };
}

// --- PUT /services/modus --------------------------------------------------
router.put("/", async (req, res) => {
  try {
    if (!isAuthorized(req)) {
      return res.status(403).json({ status: "Forbidden" });
    }

    const items = req.body.data || req.body.Data;
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        status: "error",
        message:
          "Не хватает требуемых данных (ожидается Data или data: массив)",
      });
    }

    const jwt = await getJwt();
    if (!jwt) {
      return res
        .status(500)
        .json({ status: "error", message: "Не удалось авторизоваться в Strapi" });
    }

    const results = await items.reduce(async (prevPromise, rawItem, index) => {
      const acc = await prevPromise;
      const mapped = mapModusItem(rawItem);

      if (!mapped.guid) {
        acc.push({ success: false, index: index + 1, error: "Не передан GUID записи" });
        return acc;
      }

      try {
        // upsert по guid
        const r = await upsertTnInStrapi(mapped, jwt);
        acc.push({ success: true, index: index + 1, id: r.id, updated: !!r.updated, created: !!r.created });
      } catch (e) {
        const msg = e?.response?.data?.error?.message || e?.message || "Неизвестная ошибка";
        acc.push({ success: false, index: index + 1, error: msg });
      }

      return acc;
    }, Promise.resolve([]));

    return res.json({ status: "ok", results });
  } catch (e) {
    const msg = e?.message || "Внутренняя ошибка сервера";
    return res.status(500).json({ status: "error", message: msg });
  }
});

// --- POST /services/modus -------------------------------------------------
router.post("/", async (req, res) => {
  const authorization = req.get("Authorization");

  if (authorization !== `Bearer ${secretModus}`) {
    return res.status(403).json({ status: "Forbidden" });
  }

  if (!req.body?.Data) {
    return res.status(400).json({ status: "error", message: "Не хватает требуемых данных" });
  }

  const data = req.body.Data;
  const prepareData = data.map(mapModusItem);

  try {
    const jwt = await getJwt();
    if (!jwt) {
      return res.status(500).json({ status: "error", message: "Не удалось авторизоваться в Strapi" });
    }

    const fiasSet = new Set();
    const results = [];

    for (let i = 0; i < prepareData.length; i++) {
      const mapped = prepareData[i];
      try {
        const r = await upsertTnInStrapi(mapped, jwt);
        results.push({ success: true, index: i + 1, id: r.id, created: !!r.created, updated: !!r.updated });
        // соберём FIAS из "сырых" данных для фоновой обработки
        try { extractFiasList(mapped.data).forEach((id) => fiasSet.add(id)); } catch {}
      } catch (error) {
        console.error(`Ошибка при сохранении элемента ${i + 1}:`, error.message);
        results.push({ success: false, index: i + 1, error: error.message });
      }
    }

    // Быстрый ответ МОДУСу
    res.json({ status: "ok", results });

    // Фоновое заполнение коллекции "Адрес" — уже после ответа клиенту
    setImmediate(async () => {
      try {
        const ids = Array.from(fiasSet);
        if (ids.length) await upsertAddressesInStrapi(ids, jwt);
      } catch (e) {
        console.warn("[modus] background address enrichment error:", e?.message || e);
      }
    });
  } catch (e) {
    console.error("[modus] POST processing failed:", e?.message || e);
    return res.status(500).json({ status: "error", message: e?.message || "Внутренняя ошибка сервера" });
  }
});

module.exports = router;
