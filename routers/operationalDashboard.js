const express = require("express");
const {
  getOperationalDashboardStatsPayload,
  refreshOperationalDashboardStats,
} = require("../services/operationalDashboardStats");

const router = express.Router();

router.get("/current-year-counts", async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ ok: false, message: "Нет Authorization header" });
  }

  try {
    const payload = await getOperationalDashboardStatsPayload();
    if (!payload?.rows) {
      return res.status(503).json({
        ok: false,
        message: "Статистика Дашборда ОО еще не рассчитана",
      });
    }

    return res.json({ ...payload, cached: true });
  } catch (error) {
    return res.status(error?.response?.status || 502).json({
      ok: false,
      message: error?.response?.data?.error?.message || error?.message || "Ошибка загрузки статистики",
    });
  }
});

router.post("/current-year-counts/refresh", async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ ok: false, message: "Нет Authorization header" });
  }

  try {
    const payload = await refreshOperationalDashboardStats({ reason: "manual-endpoint" });
    return res.json({ ...payload, cached: false });
  } catch (error) {
    return res.status(error?.response?.status || 502).json({
      ok: false,
      message: error?.response?.data?.error?.message || error?.message || "Ошибка пересчета статистики",
    });
  }
});

module.exports = router;
