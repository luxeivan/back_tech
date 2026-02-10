const express = require("express");
const axios = require("axios");
const { broadcast } = require("../services/sse");
const { buildAutoDescription } = require("../services/autoDescription");
const { buildEddsPayload } = require("../services/modus/eddsPayload");
const {
  extractFiasList,
  upsertAddressesInStrapi,
} = require("../services/modus/addresses");
const { getJwt, fetchTnDescriptionById } = require("../services/modus/strapi");
require("dotenv").config();

const router = express.Router();
const secretModus = process.env.SECRET_FOR_MODUS;

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
    const mask = (s) => (s ? `${s.slice(0, 4)}…${s.slice(-4)}` : "<empty>");
    console.warn(
      "[modus] Доступ запрещен: token=",
      mask(token),
      " ожидался=",
      mask(String(secretModus || ""))
    );
  }
  return ok;
};

const urlStrapi = process.env.URL_STRAPI;

const norm = (s) =>
  String(s || "")
    .trim()
    .toLowerCase();
const isFinalStatus = (s) =>
  ["закрыта", "запитана", "удалена"].includes(norm(s));

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
        // description: item.F81_042_DISPNAME,
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
      return res.status(500).json({
        status: "error",
        message: "Не удалось авторизоваться в Strapi",
      });
    }

    const fiasSet = new Set();

    const results = await items.reduce(async (prevPromise, rawItem, index) => {
      const acc = await prevPromise;
      const mapped = mapItem(rawItem);
      try {
        const fiasCodes = extractFiasList(rawItem);
        fiasCodes.forEach((id) => fiasSet.add(id));
      } catch (e) {
        console.warn(
          `[PUT] Ошибка при извлечении FIAS для элемента ${index + 1}:`,
          e.message
        );
      }

      if (!mapped.guid) {
        acc.push({
          success: false,
          index: index + 1,
          error: "Не передан GUID записи",
        });
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
        const current = found || {};
        const currentAttrs = current?.attributes || current || {};
        const currentRaw = currentAttrs?.data || current?.data || {};
        const prevStatus = norm(
          current?.STATUS_NAME || current?.attributes?.STATUS_NAME
        );
        const nextStatus = norm(mapped?.STATUS_NAME);
        const statusChanged = prevStatus !== nextStatus;
        const nextIsFinal = isFinalStatus(nextStatus);
        const needEdds = statusChanged && nextIsFinal;

        if (!documentId) {
          acc.push({
            success: false,
            index: index + 1,
            status: "not_found",
            error: "Запись с таким GUID не найдена",
          });
          return acc;
        }

        // Сначала считаем обычный патч по всем полям
        let patch = buildPatch(current, mapped);

        // Всегда объединяем сырые данные: то, что прилетело из MODUS (mapped.data),
        // накладываем поверх того, что уже хранится в Strapi (currentRaw)
        const mergedRaw = { ...(currentRaw || {}), ...(mapped.data || {}) };
        const rawChanged = JSON.stringify(mergedRaw) !== JSON.stringify(currentRaw || {});
        if (rawChanged) {
          patch.data = mergedRaw;
        }

        // Если статус стал финальным и нужно отправлять в ЕДДС —
        // не урезаем патч, а лишь гарантируем, что статусные поля совпадают
        if (needEdds) {
          if (currentAttrs?.STATUS_NAME !== mapped.STATUS_NAME) {
            patch.STATUS_NAME = mapped.STATUS_NAME;
          }
          const nextIsActive = nextStatus === "открыта";
          if (currentAttrs?.isActive !== nextIsActive) {
            patch.isActive = nextIsActive;
          }
          // и дублируем STATUS_NAME внутрь raw-объекта
          if ((mergedRaw?.STATUS_NAME || "") !== mapped.STATUS_NAME) {
            patch.data = { ...mergedRaw, STATUS_NAME: mapped.STATUS_NAME };
          }
        }
        // ── Auto‑description on update: fill only when empty (never overwrite manual edits) ──
        try {
          const isEmptyDesc = (t) => {
            const s = String(t ?? "").trim();
            return !s || s === "—";
          };

          const currentDesc = currentAttrs?.description ?? "";

          // Если описание пустое — генерим автоописание. Если дежурный редактировал — не трогаем.
          if (isEmptyDesc(currentDesc)) {
            const nextAuto = buildAutoDescription({
              ...(mergedRaw || {}),
            });

            if (nextAuto && String(nextAuto).trim()) {
              patch = patch || {};
              patch.description = nextAuto;
            }
          }
        } catch (e) {
          console.warn("[PUT] autoDescription generation skipped:", e?.message);
        }
        // ─────────────────────────────────────────────────────────────────────────────

        if (Object.keys(patch).length === 0) {
          acc.push({
            success: true,
            index: index + 1,
            id: documentId,
            updated: false,
            message: "Изменений нет",
          });
          return acc;
        }

        const upd = await axios.put(
          `${urlStrapi}/api/teh-narusheniyas/${documentId}`,
          { data: patch },
          { headers: { Authorization: `Bearer ${jwt}` } }
        );

        try {
          broadcast({
            type: "tn-upsert",
            source: "modus",
            action: "update",
            id: documentId,
            guid: mapped.guid,
            patch,
            timestamp: Date.now(),
          });
        } catch (e) {
          console.error("SSE broadcast error (update):", e?.message);
        }
        if (needEdds) {
          let strapiTn = null;
          try {
            const rFull = await axios.get(`${urlStrapi}/api/teh-narusheniyas`, {
              headers: { Authorization: `Bearer ${jwt}` },
              params: {
                "filters[guid][$eq]": mapped.guid,
                "pagination[pageSize]": 1,
                populate: "*",
              },
            });
            const full = rFull?.data?.data?.[0];
            strapiTn = full?.attributes || full || null;
          } catch (e) {
            console.warn(
              `[modus→edds] Не удалось подтянуть полную запись из Strapi по guid=${mapped.guid}:`,
              e?.response?.status || e?.message
            );
          }

          if (!strapiTn) {
            strapiTn = { ...mapped };
          }

          const mergedForPayload = { ...strapiTn };
          if (mapped?.STATUS_NAME != null)
            mergedForPayload.STATUS_NAME = mapped.STATUS_NAME;
          if (mapped?.recoveryFactDateTime != null)
            mergedForPayload.recoveryFactDateTime = mapped.recoveryFactDateTime;
          if (mapped?.recoveryPlanDateTime != null)
            mergedForPayload.recoveryPlanDateTime = mapped.recoveryPlanDateTime;
          if (mapped?.createDateTime != null)
            mergedForPayload.createDateTime = mapped.createDateTime;
          const payload = buildEddsPayload({ data: mergedForPayload });
          try {
            const dbg = {
              mergedForPayload,
              eddsPayload: payload,
            };
            const snap = JSON.stringify(dbg);
            const snapClip =
              snap.length > 4000
                ? snap.slice(0, 4000) + `… (${snap.length} chars)`
                : snap;
            console.log(`[modus→edds] payload snapshot: ${snapClip}`);
          } catch (e) {
            console.warn(
              "[modus→edds] Не удалось сформировать debug snapshot:",
              e?.message
            );
          }

          const explicitSelf = String(process.env.SELF_EDDS_URL || "").trim();
          const port = Number(
            process.env.PORT || process.env.BACK_PORT || 3110
          );
          const protocol = req.protocol || "http";
          const host = req.get("host");
          const qs = "debug=1";
          const candidates = [
            explicitSelf && `${explicitSelf}?${qs}`,
            `http://127.0.0.1:${port}/services/edds?${qs}`,
            `http://localhost:${port}/services/edds?${qs}`,
            `${protocol}://${host}/services/edds?${qs}`,
            `${protocol}://${host}/api/services/edds?${qs}`,
          ].filter(Boolean);

          console.log(`[modus→edds] candidates: ${candidates.join(", ")}`);
          setTimeout(async () => {
            let delivered = false;

            for (const url of candidates) {
              try {
                const resp = await axios.post(url, payload, {
                  headers: { Authorization: `Bearer ${jwt}` },
                  timeout: 30000,
                  validateStatus: () => true,
                });

                const body =
                  typeof resp?.data === "string"
                    ? resp.data
                    : JSON.stringify(
                        resp?.data ?? resp?.statusText ?? "",
                        null,
                        2
                      );
                const bodyClip =
                  body.length > 4000
                    ? body.slice(0, 4000) + `… (${body.length} chars)`
                    : body;

                console.log(
                  `[modus→edds] try ${url} → HTTP ${resp?.status}; body=${bodyClip}`
                );
                if (resp?.status !== 404) {
                  const claimId =
                    resp?.data?.data?.claim_id ?? resp?.data?.claim_id;
                  const ok =
                    resp?.status >= 200 &&
                    resp?.status < 300 &&
                    (resp?.data?.success === true || !!claimId);

                  if (ok) {
                    console.log(
                      `[modus→edds] ✅ GUID=${mapped.guid} отправлен в ЕДДС через ${url}` +
                        (claimId ? `; claim_id=${claimId}` : "")
                    );
                  } else {
                    console.warn(
                      `[modus→edds] ❌ ЕДДС не приняла GUID=${mapped.guid}: HTTP ${resp?.status}; success=${resp?.data?.success}; message=${resp?.data?.message}; тело=${bodyClip}`
                    );
                  }

                  delivered = true;
                  break;
                }
              } catch (e) {
                const code = e?.response?.status || e?.code || e?.message;
                console.warn(
                  `[modus→edds] Ошибка запроса ${url} для GUID=${mapped.guid}: ${code}`
                );
              }
            }

            if (!delivered) {
              console.error(
                `[modus→edds] ❌ Не удалось доставить GUID=${mapped.guid} до /services/edds — все кандидаты вернули 404`
              );
            }
          }, 0);
        }

        acc.push({
          success: true,
          index: index + 1,
          id: upd?.data?.data?.id || documentId,
          updated: true,
        });
      } catch (e) {
        const msg =
          e?.response?.data?.error?.message ||
          e?.message ||
          "Неизвестная ошибка";
        acc.push({ success: false, index: index + 1, error: msg });
      }

      return acc;
    }, Promise.resolve([]));

    setTimeout(() => {
      if (!fiasSet.size) {
        return;
      }
      console.log("[PUT] Запуск фоновой обработки адресов...");
      upsertAddressesInStrapi([...fiasSet], jwt).catch((e) =>
        console.warn("[modus] Ошибка фоновой обработки адресов:", e?.message)
      );
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

    const results = await dataArray.reduce(
      async (previousPromise, item, index) => {
        const accumulatedResults = await previousPromise;
        try {
          const guid = item?.guid;
          if (guid) {
            try {
              const search = await axios.get(
                `${urlStrapi}/api/teh-narusheniyas`,
                {
                  headers: { Authorization: `Bearer ${jwt}` },
                  params: {
                    "filters[guid][$eq]": guid,
                    "pagination[pageSize]": 1,
                  },
                }
              );
              const found = search?.data?.data?.[0];
              if (found) {
                const existingId = found?.documentId || found?.id;
                accumulatedResults.push({
                  success: false,
                  index: index + 1,
                  status: "duplicate",
                  error: "Запись с таким GUID уже существует",
                  guid,
                  id: existingId,
                });
                return accumulatedResults;
              }
            } catch (e) {
              console.warn(
                `[POST] Не удалось выполнить проверку дубликатов для guid=${guid}:`,
                e?.response?.status || e?.message
              );
            }
          }

          // Build payload with auto-description on create
          const payload = { ...item };
          try {
            const autoDesc = buildAutoDescription({
              ...(item?.data || {}),
              ...item,
            });
            if (autoDesc) payload.description = autoDesc;
          } catch (e) {
            console.warn("[POST] autoDescription generation failed:", e?.message);
          }
          const response = await axios.post(
            `${urlStrapi}/api/teh-narusheniyas`,
            { data: payload },
            { headers: { Authorization: `Bearer ${jwt}` } }
          );

          // Достаём реальные данные из ответа Strapi (v4/v5) и тянем дефолт из самой Strapi (без хардкода)
          const created = response?.data?.data;
          const createdId = created?.id || created?.documentId;
          const createdAttrs = created?.attributes || {};
          let descriptionFromStrapi = createdAttrs?.description;
          if (descriptionFromStrapi == null && createdId) {
            descriptionFromStrapi = await fetchTnDescriptionById(
              createdId,
              jwt
            );
          }

          accumulatedResults.push({
            success: true,
            id: createdId,
            index: index + 1,
          });
          console.log(`[POST] Элемент ${index + 1} успешно отправлен`);
          try {
            const fiasCodes = extractFiasList(item);
            fiasCodes.forEach((id) => fiasSet.add(id));
          } catch (e) {
            console.warn("[POST] Пропущено извлечение адресов:", e?.message);
          }
          try {
            const entryForSse = {
              ...item,
              id: createdId,
              // если фронт слушает только SSE — отдадим корректное описание из Strapi
              description: descriptionFromStrapi,
              // expose Strapi-managed PES fields (override-friendly)
              PES_COUNT: createdAttrs?.PES_COUNT ?? 0,
              PES_POWER: createdAttrs?.PES_POWER ?? 0,
            };
            broadcast({
              type: "tn-upsert",
              source: "modus",
              action: "create",
              id: createdId,
              entry: entryForSse,
              timestamp: Date.now(),
            });
          } catch (e) {
            console.error("Ошибка SSE broadcast (create):", e?.message);
          }
        } catch (error) {
          console.error(
            `[POST] Ошибка при отправке элемента ${index + 1}:`,
            error.message
          );
          accumulatedResults.push({
            success: false,
            error: error.message,
            index: index + 1,
          });
        }

        return accumulatedResults;
      },
      Promise.resolve([])
    );
    setTimeout(() => {
      if (!fiasSet.size) {
        return;
      }
      console.log("[POST] Запуск фоновой обработки адресов...");
      upsertAddressesInStrapi([...fiasSet], jwt).catch((e) =>
        console.warn("[POST] Ошибка фоновой обработки адресов:", e?.message)
      );
    }, 0);

    return results;
  }

  if (authorization === `Bearer ${secretModus}`) {
    if (!req.body?.Data) {
      return res
        .status(400)
        .json({ status: "error", message: "Не хватает требуемых данных" });
    }
    const data = req.body.Data;
    const prepareData = data.map((item) => ({
      guid: item.VIOLATION_GUID_STR,
      number: `${item.F81_010_NUMBER}`,
      energoObject: item.F81_041_ENERGOOBJECTNAME,
      createDateTime: item.F81_060_EVENTDATETIME,
      recoveryPlanDateTime: item.CREATE_DATETIME,
      addressList: item.ADDRESS_LIST,
      // description: item.F81_042_DISPNAME,
      recoveryFactDateTime: item.F81_290_RECOVERYDATETIME,
      dispCenter: item.DISPCENTER_NAME_,
      STATUS_NAME: (item.STATUS_NAME || "").toString().trim(),
      isActive:
        (item.STATUS_NAME || "").toString().trim().toLowerCase() === "открыта",
      data: item,
    }));

    const results = await sendDataSequentially(prepareData);
    if (!results) {
      return res.status(500).json({ status: "error" });
    }

    const anyCreated = results.some((r) => r?.success === true);
    const allDuplicates =
      results.length > 0 && results.every((r) => r?.status === "duplicate");

    if (allDuplicates && !anyCreated) {
      return res.status(409).json({
        status: "duplicate",
        message: "Запись с таким GUID уже существует",
        results,
      });
    }

    return res.json({ status: "ok", results });
  } else {
    res.status(403).json({ status: "Forbidden" });
  }
});

module.exports = router;
