// Переключатель автоотправки аварийных ТН в ЕДДС.
// Состояние — Strapi-коллекция tn-avtootpravkas (поле status_live).

const express = require("express");
const axios = require("axios");
require("dotenv").config();
const {
  getAutoSendState,
  setAutoSendState,
} = require("../services/modus/autoSend");
const { logAuditFromReq } = require("../services/auditLogger");

const router = express.Router();

async function requireUser(req, res) {
  const authHeader = req.headers["authorization"] || "";
  if (!authHeader) {
    res.status(403).json({ ok: false, error: "Нет токена авторизации" });
    return null;
  }
  try {
    const r = await axios.get(`${process.env.URL_STRAPI}/api/users/me`, {
      headers: { Authorization: authHeader },
      timeout: 15000,
    });
    return r?.data || null;
  } catch {
    res.status(403).json({ ok: false, error: "Доступ запрещён" });
    return null;
  }
}

router.get("/", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  try {
    const { enabled } = await getAutoSendState();
    res.json({ ok: true, enabled });
  } catch (e) {
    console.warn(
      "[autosend] GET error:",
      e?.response?.status || e?.message
    );
    res.status(500).json({ ok: false, error: e?.message || "Ошибка чтения состояния" });
  }
});

router.put("/", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  const enabled = Boolean(req?.body?.enabled);
  try {
    await setAutoSendState(enabled);
    logAuditFromReq(req, {
      page: "/services/autosend",
      action: "autosend_toggle",
      entity: "autosend",
      entity_id: "tn-avtootpravkas",
      details: { enabled },
    }).catch(() => {});
    res.json({ ok: true, enabled });
  } catch (e) {
    console.warn(
      "[autosend] PUT error:",
      e?.response?.status || e?.message
    );
    res.status(500).json({ ok: false, error: e?.message || "Ошибка записи состояния" });
  }
});

module.exports = router;
