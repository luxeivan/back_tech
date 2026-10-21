const express = require("express");
const {
  syncFilialResourcesFrom1C,
  getLastSyncResult,
} = require("../services/onec/resourceReport");

const router = express.Router();

const requireAuth = (req, res, next) => {
  if (!req.headers.authorization) {
    return res.status(401).json({ ok: false, message: "Нет Authorization header" });
  }
  next();
};

router.get("/filial-resources", requireAuth, (req, res) => {
  const last = getLastSyncResult();
  if (!last) {
    return res.status(503).json({
      ok: false,
      message: "Синхронизация ресурсов из 1С ещё не выполнялась",
    });
  }
  return res.json(last);
});

router.post("/filial-resources/sync", requireAuth, async (req, res) => {
  try {
    const result = await syncFilialResourcesFrom1C({ reason: "manual-endpoint" });
    return res.json(result);
  } catch (error) {
    return res.status(502).json({
      ok: false,
      message: error?.message || "Ошибка синхронизации ресурсов из 1С",
    });
  }
});

module.exports = router;
