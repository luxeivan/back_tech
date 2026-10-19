# back_tech

BFF/API для системы управления технологическими нарушениями (ТН). МОДУС шлёт аварии/плановые → мы пишем в Strapi → раздаём фронтам (SSE) и уводим в ЕДДС, MAX-каналы, МосЭнергоСбыт, сайт.

## Стек

Node.js · Express 5 · Axios · Strapi (как БД, только REST) · SSE для realtime · Docker (только локально)

## Запуск

```bash
npm install
npm run dev    # nodemon
npm start      # node app.js
```

Порт — из `PORT` в `.env` (в проде 3110).

## .env

| Группа | Переменные |
|--------|-----------|
| Ядро | `PORT`, `SECRET_FOR_MODUS`, `URL_STRAPI`, `LOGIN_STRAPI`, `PASSWORD_STRAPI` |
| ЕДДС | `EDDS_URL`, `EDDS_URL_PUT`, `EDDS_TOKEN`, `EDDS_NEW_BASE_URL` |
| МосЭнергоСбыт | `MES_MODE`, `MES_LOGIN`, `MES_PASSWORD`, `MES_TEST_*`/`MES_PROD_*` |
| MAX ОО (канал «Оперативная обстановка») | `TN_MAX_BOT_OO`, `MAX_CHAT_ID_OO`, `MAX_CHANEL_OO`, `TN_MAX_API_BASE` |
| MAX И / ПЭС | `TN_MAX_BOT_I`, `MAX_GROUP_I`, `MAX_CHANEL_I`, `PES_MAX_BOT_TOKEN`, `PES_MAX_BOT_ENABLED`, `MAX_WEBHOOK_*` |
| ПРОЧЕЕ | `T3_*`, `DADATA_TOKEN`, `AUDIT_LOGGER_ENABLED`, `LOGIN_STRAPI`/`PASSWORD_STRAPI` |

`.env` содержит прод-секреты и не коммитится в дистрибутивах (см. `.dockerignore`).

## Структура

```
app.js              точка входа, монтирование роутеров
routers/            API: modus, edds/eddsnew, mes, pes*, tnmax, autosend,
                    site*, audit, weather, ai, webhooks, operationalDashboard…
services/
  modus/            маппинг МОДУС, payload ЕДДС, автоотправка
  tnmax/            посты в MAX-канал ОО: postPublisher (Этап 8/8.5),
                    postTextTemplate (шаблоны текста), pdf/ (таблицы → PDF/PNG), tnMaxChannel (HTTP-клиент)
  autoDescription.js  шаблон описания ТН (ЕДДС/модалка/MAX)
  pes/              ПЭС-модуль, max/ (webhook-бот)
  sse.js, auditLogger.js, auth.js, weather.js…
scripts/            разовые утилиты (запуск вручную: node scripts/…)
diagnostic-scripts/ разовая диагностика Strapi
```

## Маршруты

| Префикс | Что |
|---------|-----|
| `/services/modus` | приём от МОДУСа (POST аварий / PUT обновления) |
| `/services/edds`, `/services/eddsnew` | отправка в ЕДДС (v1 curl / v2 JSON) |
| `/services/tnmax` | MAX-канал ОО: `POST /send`, `DELETE /messages/:mid` |
| `/services/autosend` | свитч автоотправки ТН в ЕДДС |
| `/services/mes` | МосЭнергоСбыт / СУВК |
| `/services/pes`, `/services/pes/module`, `/services/pes/max` | ПЭС |
| `/services/event` | SSE (GET подписка / POST broadcast) |
| `/services/site/*` | данные для публичного сайта |
| `/services/audit`, `/weather`, `/ai`, `/webhooks`, `/disconnected`, `/minenergo`, `/operational-dashboard`, `/integration-mappings` | прочее |

Swagger: `/api-docs` (спека `/api-docs.json`).

## Docker (только локально)

```bash
docker compose up -d --build
```

На проде Docker нет: `apt install poppler-utils`, `npm install`, запуск `node app.js` напрямую.
