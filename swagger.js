const swaggerJsdoc = require("swagger-jsdoc");
const path = require("path");

const API_TITLE = "МКиМО — Документация API";
const API_DESCRIPTION = `
* 🔒 **Приватные** — требуют авторизацию (логин/пароль из Strapi)
* 🌐 **Публичные** — доступны без авторизации

#### Как авторизоваться
1. Нажмите зелёную кнопку **Авторизация** вверху справа.
2. Введите **логин** и **пароль** из Strapi.
3. Нажмите **Авторизация** → затем **Закрыть**.
   Теперь все 🔒 эндпоинты будут выполняться от имени пользователя.
`;

const options = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: API_TITLE,
      version: "1.0.0",
      description: API_DESCRIPTION,
    },

    components: {
      securitySchemes: {
        basicAuth: {
          type: "http",
          scheme: "basic",
          description: "Логин и пароль из Strapi",
        },
      },
    },

    tags: [
      { name: "Modus", description: "Приём данных от Модус" },
      { name: "EDDS", description: "Отправка данных в ЕДДС" },
      { name: "EDDS New", description: "Отправка данных в ЕДДС (новый API)" },
      { name: "MES", description: "МосЭнергоСбыт" },
      { name: "PES", description: "Подстанции электроснабжения (T3)" },
      { name: "PES Module", description: "Управление ПЭС: выдача команд, история" },
      { name: "PES MAX", description: "MAX-бот (webhook)" },
      { name: "Disconnected", description: "Отключённые потребители" },
      { name: "MinEnergo", description: "Данные для МинЭнерго РФ" },
      { name: "Site", description: "Данные для сайта (аварийные отключения)" },
      { name: "Audit", description: "Аудит-журнал" },
      { name: "Webhooks", description: "Вебхуки от Strapi" },
      { name: "Integration", description: "Маппинг интеграций" },
    ],
  },

  apis: [
    "./routers/*.js",
    "./routers/mes/*.js",
  ],
};

const specs = swaggerJsdoc(options);

module.exports = (app) => {
  app.get("/api-docs.json", (req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.send(specs);
  });

  app.get("/api-docs", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "swagger.html"));
  });
};
