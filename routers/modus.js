const express = require("express");
const axios = require("axios");
require("dotenv").config();

const router = express.Router();
const secretModus = process.env.SECRET_FOR_MODUS;

// Достаём Bearer-токен из заголовка и сравниваем только значение
const isAuthorized = (req) => {
  const raw = (req.get("authorization") || req.get("Authorization") || "").trim();
  const match = /^Bearer\s+(.+)$/i.exec(raw);
  const token = match ? match[1].trim() : "";
  const ok = token && token === String(secretModus || "");
  if (!ok) {
    // Временный диагностический лог (замаскирован):
    const mask = (s) => (s ? `${s.slice(0,4)}…${s.slice(-4)}` : "<empty>");
    console.warn("[modus] Forbidden: token=", mask(token), " expected=", mask(String(secretModus || "")));
  }
  return ok;
}

const loginStrapi = process.env.LOGIN_STRAPI;
const passwordStrapi = process.env.PASSWORD_STRAPI;

const urlStrapi = process.env.URL_STRAPI;

// const jwt = "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6MSwiaWF0IjoxNzU2MTkyNTQxLCJleHAiOjE3NTg3ODQ1NDF9.Ouh4ddcvu4EuDe0kAgt48EMqa4SvDcCQr4klfsHztxA"

async function getJwt() {
  try {
    const res = await axios.post(`${urlStrapi}/api/auth/local`, {
      identifier: loginStrapi,
      password: passwordStrapi,
    });
    if (res.data) {
      console.log(res.data);

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

router.put("/", async (req, res) => {
  try {
    if (!isAuthorized(req)) {
      return res.status(403).json({ status: "Forbidden" });
    }

    if (!req.body?.data || !Array.isArray(req.body.data) || req.body.data.length === 0) {
      return res
        .status(400)
        .json({ status: "error", message: "Не хватает требуемых данных (ожидается data: массив)" });
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
        isActive,
        data: item,
      };
    };

    const buildPatch = (current, next) => {
      const patch = {};
      Object.keys(next).forEach((key) => {
        const prevVal = current?.[key];
        const nextVal = next[key];
        const areEqual =
          typeof nextVal === "object" && nextVal !== null
            ? JSON.stringify(prevVal) === JSON.stringify(nextVal)
            : prevVal === nextVal;
        if (!areEqual) patch[key] = nextVal;
      });
      return patch;
    };

    const jwt = await getJwt();
    if (!jwt) {
      return res.status(500).json({ status: "error", message: "Не удалось авторизоваться в Strapi" });
    }

    const items = req.body.data;
    const results = await items.reduce(async (prevPromise, rawItem, index) => {
      const acc = await prevPromise;
      const mapped = mapItem(rawItem);

      if (!mapped.guid) {
        acc.push({ success: false, index: index + 1, error: "Не передан GUID записи" });
        return acc;
      }

      try {
        const search = await axios.get(`${urlStrapi}/api/teh-narusheniyas`, {
          headers: { Authorization: `Bearer ${jwt}` },
          params: {
            "filters[guid][$eq]": mapped.guid,
            "pagination[pageSize]": 1,
          },
        });

        const found = search?.data?.data?.[0];
        const documentId = found?.documentId || found?.id;
        const current = found?.attributes || {};

        if (!documentId) {
          console.warn(`[modus] Не найдена запись по guid=${mapped.guid}`);
          acc.push({ success: false, index: index + 1, status: "not_found", error: "Запись с таким GUID не найдена" });
          return acc;
        }

        const patch = buildPatch(current, mapped);

        if (Object.keys(patch).length === 0) {
          acc.push({ success: true, index: index + 1, id, updated: false, message: "Изменений нет" });
          return acc;
        }

        const upd = await axios.put(
          `${urlStrapi}/api/teh-narusheniyas/${documentId}`,
          { data: patch },
          { headers: { Authorization: `Bearer ${jwt}` } }
        );

        acc.push({ success: true, index: index + 1, id: upd?.data?.data?.id || documentId, updated: true });
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

router.post("/", async (req, res) => {
  const authorization = req.get("Authorization");

  async function sendDataSequentially(dataArray) {
    const jwt = await getJwt();
    return dataArray.reduce(async (previousPromise, item, index) => {
      const accumulatedResults = await previousPromise;
      try {
        console.log(`Отправка элемента ${index + 1} из ${dataArray.length}`);
        const response = await axios.post(
          `${urlStrapi}/api/teh-narusheniyas`,
          {
            data: {
              ...item,
            },
          },
          {
            headers: {
              Authorization: `Bearer ${jwt}`,
            },
          }
        );
        accumulatedResults.push({
          success: true,
          // data: item,
          id: response.data?.data.id,
          index: index + 1,
        });

        console.log(`Элемент ${index + 1} успешно отправлен`);
      } catch (error) {
        console.error(
          `Ошибка при отправке элемента ${index + 1}:`,
          error.message
        );
        accumulatedResults.push({
          success: false,
          // data: item,
          error: error.message,
          // id: response.data?.data.id,
          index: index + 1,
        });
      }

      return accumulatedResults;
    }, Promise.resolve([]));
  }

  if (authorization === `Bearer ${secretModus}`) {
    if (!req.body?.Data) {
      return res
        .status(400)
        .json({ status: "error", message: "Не хватает требуемых данных" });
    }
    const data = req.body.Data;
    const prepareData = data.map((item) => {
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
        data: item,
      };
    });
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
