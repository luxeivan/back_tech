const express = require("express");
const { logAuditFromReq } = require("../services/auditLogger");

const router = express.Router();

router.post("/event", async (req, res) => {
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    await logAuditFromReq(req, {
      username: body.username,
      role: body.role,
      page: body.page,
      action: body.action,
      entity: body.entity,
      entity_id: body.entity_id,
      details: body.details,
    });
    return res.json({ ok: true });
  } catch (e) {
    console.warn("[audit] write failed:", e?.message || e);
    return res.status(200).json({ ok: false, skipped: true });
  }
});

module.exports = router;
