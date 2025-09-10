const express = require("express");
const bodyParser = require("body-parser");
const modus = require("./routers/modus");
const eddsRoutes = require("./routers/edds");
const mesRoutes = require("./routers/mes");
import aiRouter from "./routes/ai.js";

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
    "Authorization,Content-Type,X-Requested-With"
  );
  res.header("Access-Control-Allow-Credentials", "true");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(bodyParser.json({ limit: "20mb" }));
app.use(bodyParser.urlencoded({ extended: true, limit: "20mb" }));

app.use("/services/modus", modus);
app.use("/services/edds", eddsRoutes);
app.use("/services/mes", mesRoutes);
app.use("/services/ai", aiRouter);

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
  console.log(`Приложение запущено на ${port} порту и каким-то чудом работает`);
});

// const express = require('express')
// const auth = require('./services/auth')
// const bodyParser = require('body-parser')
// const modus = require('./routers/modus')
// const eddsRoutes = require('./routers/edds');
// const router = express.Router();
// const app = express()

// require('dotenv').config()

// const port = process.env.PORT || 5000

// // parse application/json
// app.use(bodyParser.json())

// app.get('/', (req, res) => {
//     res.send('Hello World!')
// })

// //Прием данных от Модус
// app.use("/services/modus", modus);
// app.use('/services/edds', eddsRoutes);

// // app.post('/services/modus', (req, res) => {
// //     const authorization = req.get("Authorization")
// //     if (!req.body?.Data) {
// //         return res.status(400).json({ status: "error",message:"Не хватает требуемых данных" })
// //     }
// //     const data = req.body.Data
// //     // console.log(authorization);
// //     if (authorization === `Bearer ${secretModus}`) {
// //         res.json({ status: "ok" })
// //     } else {
// //         res.status(403).json({ status: "error" })
// //     }
// // })

// //Отправка данных в ЕДДС
// // app.post('/services/edds', async (req, res) => {
// //     const authorization = req.get("Authorization")
// //     // console.log(authorization);
// //     const me = await auth.fetchAuth(authorization)
// //     if (me) {
// //         res.json({ status: "ok", me })
// //     } else {
// //         res.status(403).json({ status: "forbidden" })
// //     }
// // })

// app.listen(port, () => {
//     console.log(`Приложение запущено на порту: ${port}`)
// })
