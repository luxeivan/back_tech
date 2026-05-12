const express = require("express");
const { logAuditFromReq } = require("../../services/auditLogger");
const authTestRoute = require("./authTestRoute");
const {
  AUTH_BASE,
  LOAD_BASE,
  MES_AUTH_METHOD,
  MES_AUTH_TIMEOUT_MS,
  MES_MODE,
  MES_RETRY_ATTEMPTS,
  MES_UPLOAD_TIMEOUT_MS,
  logMesEndpoints,
} = require("./config");
const {
  buildRegistryExternalId,
  buildRegistryItem,
  buildRegistryItemFromMesPayload,
  getExternalIdFromPayload,
  getExternalIdFromTn,
} = require("./registryMapper");
const { mesCheckStatus, mesUploadRegistry } = require("./uploadClient");
const { maskSession } = require("./utils");

logMesEndpoints();

const router = express.Router();

router.post("/upload", express.json({ limit: "20mb" }), async (req, res) => {
  const startedAt = Date.now();
  let auditDetails = { result: "unknown" };
  try {
    const body = req.body || {};
    let items = [];
    let externalId = null;

    const list = Array.isArray(body?.tns)
      ? body.tns
      : [body?.tn].filter(Boolean);
    if (list.length) {
      items = list.map((tn, i) => buildRegistryItem(tn, i + 1));
      externalId = getExternalIdFromTn(list[0]);
    }

    const looksLikeMes =
      body &&
      (body.date_off ||
        body.massage ||
        body.status ||
        body.base_type !== undefined ||
        body.BASE_TYPE !== undefined ||
        body.external_id ||
        body.condition ||
        body.fias ||
        body.Guid2 ||
        body.FIAS_LIST);
    if (!items.length && looksLikeMes) {
      items = [buildRegistryItemFromMesPayload(body, 1)];
      externalId = getExternalIdFromPayload(body);
    }

    if (!items.length) {
      return res.status(400).json({
        ok: false,
        message:
          "Передай tn/tns или MES-поля (date_off/.../condition/base_type) + fias/Guid2/FIAS_LIST",
      });
    }

    if (req.query.dryRun === "1") {
      const fakeId = `TEST-${Date.now()}`;
      console.log(
        `МосЭнергоСбыт DRY-RUN: строк реестра = ${items.length}, id_registry = ${fakeId}`
      );
      auditDetails = { result: "dry-run", rows: items.length };
      return res.json({
        ok: true,
        dryRun: true,
        id_registry: fakeId,
        session: "TEST-SESSION",
        id_registry_ext: buildRegistryExternalId(externalId),
        vl_registry: items,
      });
    }

    console.log(`МосЭнергоСбыт UPLOAD: строк реестра = ${items.length}`);
    const { idRegistry, idRegistryExt, session } = await mesUploadRegistry(items, {
      externalId,
    });
    console.log("МосЭнергоСбыт: id_registry =", idRegistry);
    console.log("МосЭнергоСбыт: id_registry_ext =", idRegistryExt);

    auditDetails = {
      result: "ok",
      rows: items.length,
      id_registry: idRegistry,
      id_registry_ext: idRegistryExt,
    };
    return res.json({
      ok: true,
      id_registry: idRegistry,
      id_registry_ext: idRegistryExt,
      session: maskSession(session),
    });
  } catch (e) {
    const status = e?.response?.status || 502;
    const details = e?.response?.data;
    console.error(
      "Ошибка UPLOAD MES:",
      e?.message,
      details ? ` | details: ${JSON.stringify(details)}` : ""
    );
    auditDetails = {
      result: "error",
      status,
      message: e?.message || "Ошибка загрузки",
    };
    return res.status(status).json({
      ok: false,
      message: e?.message || "Ошибка загрузки",
      code: e?.code,
      details,
    });
  } finally {
    setImmediate(() => {
      logAuditFromReq(req, {
        page: "/services/mes/upload",
        action: "mes_upload",
        entity: "mes",
        entity_id: String(
          req.body?.tn?.data?.number ||
            req.body?.number ||
            req.body?.external_id ||
            req.body?.VIOLATION_GUID_STR ||
            ""
        ),
        details: {
          ...auditDetails,
          duration_ms: Date.now() - startedAt,
        },
      }).catch(() => {});
    });
  }
});

router.get("/status", async (req, res) => {
  try {
    const session = req.query.session;
    const idRegistry = req.query.id_registry;
    if (!session || !idRegistry) {
      return res
        .status(400)
        .json({ ok: false, message: "Нужны session и id_registry" });
    }
    const data = await mesCheckStatus({ session, idRegistry });
    return res.json({ ok: true, data });
  } catch (e) {
    const status = e?.response?.status || 502;
    return res.status(status).json({
      ok: false,
      message: e?.message || "Ошибка проверки статуса",
      code: e?.code,
      details: e?.response?.data,
    });
  }
});

router.get("/ping", async (req, res) => {
  try {
    if (!AUTH_BASE && !LOAD_BASE) {
      return res
        .status(500)
        .json({ ok: false, message: "MES_* URL не настроены" });
    }
    return res.json({
      ok: true,
      mode: MES_MODE,
      AUTH_BASE: !!AUTH_BASE,
      LOAD_BASE: !!LOAD_BASE,
      auth_url: AUTH_BASE || null,
      load_url: LOAD_BASE || null,
      auth_method: MES_AUTH_METHOD.toUpperCase(),
      auth_timeout_ms: MES_AUTH_TIMEOUT_MS,
      upload_timeout_ms: MES_UPLOAD_TIMEOUT_MS,
      retry_attempts: MES_RETRY_ATTEMPTS,
    });
  } catch (e) {
    return res
      .status(500)
      .json({ ok: false, message: e?.message || "ping failed" });
  }
});

router.use("/auth-test", authTestRoute);

module.exports = router;
