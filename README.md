# back_tech

Бэкенд для оперативного мониторинга и управления электросетевым хозяйством — API для дашбордов, ЕДДС, ПЭС-модуля, аудита, SSE-событий и интеграций с внешними системами.

## Стек

| Слой | Технологии |
|------|-----------|
| Runtime | Node.js |
| Framework | Express 5 |
| HTTP-клиент | Axios |
| Парсинг тел | body-parser |
| Утилиты | Day.js, xlsx |
| Dev-режим | Nodemon |
| Конфиг | dotenv |
| Контейнеризация | Docker + Docker Compose |

## Установка

```bash
npm install
```

## Запуск

```bash
npm run dev      # dev-режим (nodemon, авто-рестарт)
npm start        # production (node app.js)
```

Сервер стартует на `PORT` (по умолчанию 3110).

## Переменные окружения (.env)

Создайте `.env` в корне проекта. Минимальный набор:

| Переменная | Описание |
|-----------|----------|
| `PORT` | Порт сервера (default: 5000, в .env: 3110) |
| `SECRET_FOR_MODUS` | Секрет для верификации запросов Модус |
| `URL_STRAPI` | URL CMS Strapi для хранения данных |
| `LOGIN_STRAPI` / `PASSWORD_STRAPI` | Логин/пароль Strapi |
| `EDDS_TOKEN` | Токен ЕДДС v2 |
| `EDDS_NEW_BASE_URL` | Базовый URL ЕДДС v2 API |
| `MES_MODE` | Режим МосЭнергоСбыт (test/prod) |
| `MES_LOGIN` / `MES_PASSWORD` | Логин/пароль МосЭнергоСбыт |
| `MES_TEST_AUTH_URL` / `MES_PROD_AUTH_URL` | URL авторизации СУВК |
| `MES_TEST_LOAD_URL` / `MES_PROD_LOAD_URL` | URL загрузки СУВК |
| `T3_BASE` / `T3_USER` / `T3_TOKEN` | API T3 (ПЭС) |
| `PES_MAX_BOT_TOKEN` | Токен MAX-бота (ПЭС) |
| `PES_MAX_BOT_ENABLED` | Включить MAX-бота (0/1) |
| `DADATA_TOKEN` | Токен Dadata (геокодирование) |
| `AUDIT_LOGGER_ENABLED` | Включить логгер аудита (0/1) |

## Структура проекта

```
back_tech/
├── app.js                  # точка входа, Express-сервер, маршрутизация
├── routers/                # API-роутеры
│   ├── modus.js            # Модус — приём/передача данных об авариях
│   ├── edds.js / eddsnew.js# ЕДДС v1/v2 — аварийные заявки
│   ├── mes.js (+ mes/)     # МосЭнергоСбыт / СУВК — уведомления потребителям
│   ├── pes.js              # ПЭС — основные эндпоинты
│   ├── pesModule.js        # ПЭС-модуль (детали модулей)
│   ├── pesMax.js           # ПЭС MAX-бот
│   ├── minenergo.js        # Минэнерго
│   ├── disconnected.js     # Отключённые потребители
│   ├── ai.js               # AI-интеграция
│   ├── audit.js            # Журнал аудита
│   ├── weather.js          # Погода
│   ├── webhooks.js         # Webhook-эндпоинты
│   ├── dadata.js           # Геокодирование через Dadata
│   ├── siteEmergencyOutages.js  # Аварийные отключения (сайт)
│   ├── sitePlannedOutages.js    # Плановые отключения (сайт)
│   ├── integrationMappings.js   # Маппинги интеграций
│   └── operationalDashboard.js  # Оперативный дашборд (статистика)
├── services/               # Бизнес-логика
│   ├── modus/              # Обработка данных Модус (EDDS-пейлоады, Strapi)
│   ├── edds/               # Логика ЕДДС (геолокация аварий)
│   ├── mes/                # Авторизация/загрузка СУВК
│   ├── pes/                # ПЭС-логика
│   │   ├── pesModuleData.js
│   │   ├── pesStrapiStore.js
│   │   ├── pesModuleSeed.js
│   │   ├── tg/             # Telegram-бот ПЭС
│   │   └── max/            # MAX-бот ПЭС (handlers, transport, subscriptions)
│   ├── auth.js             # Авторизация
│   ├── sse.js              # Server-Sent Events (realtime)
│   ├── auditLogger.js      # Логгер аудита (writing to Strapi)
│   ├── autoDescription.js  # Генерация описаний
│   ├── operationalDashboardStats.js  # Сбор статистики дашборда
│   └── weather.js          # Логика погоды
├── scripts/                # Утилиты и миграции данных
├── diagnostic-scripts/     # Диагностические скрипты
├── import_data/            # Импорт данных (Excel/JSON)
├── data/                   # Локальные state-файлы (боты, подписки)
├── Dockerfile
├── docker-compose.yml
└── nodemon.json
```

## Ключевые API-маршруты

| Префикс | Назначение |
|---------|-----------|
| `/services/modus` | Приём данных от Модус |
| `/services/edds` / `/services/eddsnew` | ЕДДС v1/v2 — аварийные заявки |
| `/services/mes` | СУВК / МосЭнергоСбыт — уведомления |
| `/services/pes` | ПЭС — основные данные |
| `/services/pes/module` | ПЭС-модуль |
| `/services/pes/max` | ПЭС MAX-бот |
| `/services/disconnected` | Отключённые потребители |
| `/services/minenergo` | Минэнерго |
| `/services/ai` | AI-интеграция |
| `/services/audit` | Журнал аудита |
| `/services/weather` | Погода |
| `/services/event` | SSE (GET — подписка, POST — broadcast) |
| `/services/webhooks` | Webhook-эндпоинты |
| `/services/operational-dashboard` | Оперативный дашборд |
| `/services/integration-mappings` | Маппинги интеграций |
| `/services/site/emergency-outages` | Аварийные отключения |
| `/services/site/planned-outages` | Плановые отключения |

## Docker

```bash
docker compose up --build
```
