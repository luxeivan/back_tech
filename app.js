const express = require("express");
const bodyParser = require("body-parser");
const modus = require("./routers/modus");
const eddsRoutes = require("./routers/edds");
const eddsNewRoutes = require("./routers/eddsnew");
const mesRoutes = require("./routers/mes");
const aiRouter = require("./routers/ai");
const pesRoutes = require("./routers/pes");
const pesModuleRoutes = require("./routers/pesModule");
const pesMaxRoutes = require("./routers/pesMax");
const disconnectedRoutes = require("./routers/disconnected");
const minEnergoRoutes = require("./routers/minenergo");
const siteEmergencyOutagesRoutes = require("./routers/siteEmergencyOutages");
const auditRoutes = require("./routers/audit");
const integrationMappingsRoutes = require("./routers/integrationMappings");

const webhooks = require("./routers/webhooks");
const { sseHandler, broadcast } = require("./services/sse");
require("dotenv").config();

const app = express();
const port = process.env.PORT || 5000;

app.use((req, res, next) => {
  const origin = req.headers.origin || "*";
  res.header("Access-Control-Allow-Origin", origin);
  res.header("Vary", "Origin");
  res.header(
    "Access-Control-Allow-Methods",
    "GET,POST,PUT,PATCH,DELETE,OPTIONS"
  );
  res.header(
    "Access-Control-Allow-Headers",
    "Authorization,Content-Type,X-Requested-With,X-Audit-Username,X-Audit-Role,X-Audit-Page,X-View-Role,X-Max-Bot-Api-Secret"
  );
  res.header("Access-Control-Allow-Credentials", "true");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(bodyParser.json({ limit: "20mb" }));
app.use(bodyParser.urlencoded({ extended: true, limit: "20mb" }));

app.use("/services/modus", modus);
app.use("/services/edds", eddsRoutes);
app.use("/services/eddsnew", eddsNewRoutes);
app.use("/services/mes", mesRoutes);
app.use("/services/ai", aiRouter);
app.use("/services/pes", pesRoutes);
app.use("/services/pes/module", pesModuleRoutes);
app.use("/services/pes/max", pesMaxRoutes);
app.use("/services/disconnected", disconnectedRoutes);
app.use("/services/minenergo", minEnergoRoutes);
app.use("/services/site/emergency-outages", siteEmergencyOutagesRoutes);
app.use("/services/audit", auditRoutes);
app.use("/services/integration-mappings", integrationMappingsRoutes);

app.use("/services/webhooks", webhooks);
app.get("/services/event", sseHandler);
app.post("/services/event", (req, res) => {
  try {
    broadcast({ type: "manual", payload: req.body, timestamp: Date.now() });
    res.json({ message: "Событие разослано клиентам" });
  } catch (e) {
    console.error("❗️ SSE POST error:", e);
    res.status(500).json({ error: "Ошибка рассылки события" });
  }
});

app.listen(port, () => {
  console.log(`Приложение запущено на ${port} порту и каким-то чудом работает в 2026 году`);
  console.log("[pes-max-bot] MAX работает через webhook");
});

//ПРОВЕРКА123