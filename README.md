# back_tech

Express-бэкенд для Портала технологических нарушений (ЖТН/ТН).

## Что делает сервис

- принимает и обрабатывает входящие события по ТН (интеграция с Modus);
- отправляет данные во внешние системы (ЕДДС, МосЭнергоСбыт);
- отдает сервисные API для фронтенда (ПЭС, агрегаты, МинЭнерго РФ);
- пушит live-обновления на фронт через SSE;
- принимает вебхуки от Strapi и транслирует изменения в SSE-канал.

## Стек

- Node.js
- Express 5
- Axios
- dotenv
- body-parser

## Быстрый старт

```bash
npm install
npm run dev
```

Прод-запуск:

```bash
npm start
```

По умолчанию сервер стартует на `PORT=5000`.

## Структура проекта

```text
back_tech/
  app.js                # Точка входа, монтирование роутов
  routers/
    modus.js            # Прием/обновление ТН, логика интеграции и enrich
    edds.js             # Отправка в ЕДДС + журнал отправок
    mes.js              # Отправка в МосЭнергоСбыт
    pes.js              # Данные по транспорту/экипажам из T3
    pesModule.js        # Модуль ПЭС для фронта
    disconnected.js     # Агрегаты по отключенным потребителям
    minenergo.js        # GET-выгрузка открытых аварийных ТН для МинЭнерго РФ
    audit.js            # Аудит действий пользователя
    webhooks.js         # Вебхуки Strapi -> broadcast в SSE
  services/
    sse.js              # SSE клиенты и broadcast
    auditLogger.js      # Запись аудита в ClickHouse (сейчас временно не используется как обязательный контур)
    auth.js             # Проверка/получение auth в Strapi
    autoDescription.js  # Автоформирование описания
    pes/
      pesModuleData.js  # Загрузка данных ПЭС для модуля
      pesStrapiStore.js # Обёртки для работы со Strapi по ПЭС
      pesModuleSeed.js  # Начальные данные/сидирование для модуля ПЭС
      tg/
        pesBot.js       # Telegram-бот ПЭС и подписки
        pesTelegram.js  # Формирование Telegram-сообщений
      max/
        pesMaxBot.js    # Головной файл MAX-бота, long polling
        config.js       # Конфиг и флаги запуска MAX
        storage.js      # Хранение marker/state MAX-бота
        transport.js    # HTTP-обмен с MAX API
        handlers.js     # Обработка update'ов MAX
        catalog.js      # Каталог филиалов/ПО для MAX
        subscriptions.js# Подписки пользователей MAX
        context.js      # Контекст и состояние диалогов MAX
        ui.js           # Кнопки и текстовые меню MAX
        utils.js        # Вспомогательные утилиты MAX
```

## Основные эндпоинты

Базовый префикс: `/services`

- `PUT /services/modus` — обновление ТН из Modus
- `POST /services/modus` — создание/обработка ТН из Modus
- `POST /services/edds` — отправка ТН в ЕДДС
- `POST /services/mes/upload` — отправка в МосЭнергоСбыт
- `GET /services/mes/status` — статус отправки реестра в МЭС
- `GET /services/mes/auth-test` — диагностическая проверка авторизации в МЭС
- `GET /services/pes/vehicles` — транспорт/экипажи PES
- `GET /services/pes/module/*` — API модуля ПЭС
- `GET /services/disconnected` — агрегаты по отключенным
- `GET /services/minenergo` — агрегаты по открытым аварийным ТН для МинЭнерго РФ
- `POST /services/audit/event` — ручная/фронтовая запись аудита
- `ALL /services/webhooks` — прием вебхуков Strapi
- `GET /services/event` — SSE-канал для фронта
- `POST /services/event` — ручной broadcast события в SSE

## Переменные окружения

### Общие

- `PORT`
- `URL_STRAPI`
- `LOGIN_STRAPI`
- `PASSWORD_STRAPI`

### Modus / внутренняя обработка

- `SECRET_FOR_MODUS`
- `DADATA_CONCURRENCY`
- `SELF_EDDS_URL`
- `BACK_PORT`

### DaData

- `DADATA_TOKEN`
- `DADATA_SECRET`
- `DADATA_RPS`
- `DADATA_MAX_RETRY`
- `DADATA_TIMEOUT`

### ЕДДС

- `EDDS_URL`
- `EDDS_URL_PUT`
- `EDDS_TOKEN`

### МосЭнергоСбыт (MES)

- `MES_BASE_URL`
- `MES_AUTH_URL`
- `MES_LOAD_URL`
- `MES_LOGIN`
- `MES_PASSWORD`
- `MES_SYSTEM_CONTACT`
- `MES_CHANNEL`
- `MES_ORG_CODE`
- `MES_FAKE`

### PES / T3

- `T3_BASE`
- `T3_USER`
- `T3_PSWD`
- `T3_TOKEN`
- `PES_TELEGRAM_BOT_TOKEN`
- `PES_BOT_ENABLED`
- `PES_MAX_BOT_TOKEN`
- `PES_MAX_BOT_ENABLED`
- `PES_MAX_API_BASE` (опционально, по умолчанию `https://platform-api.max.ru`)

### Аудит / ClickHouse

- `DB_NAME` (например: `portal_logs`)
- `DB_USER` (например: `portal_logger`)
- `DB_PASSWORD`
- `DB_HOST` (обычно: `127.0.0.1`)
- `DB_DIALECT` (должно быть: `clickhouse`)
- `DB_PORT` (TCP, можно оставить `9000`)
- `DB_HTTP_PORT` (HTTP для insert, обычно `8123`; при локальном SSH-туннеле `18123`)

## Важно для фронта

- CORS открыт динамически по `Origin` в `app.js`.
- SSE используется для live-обновления таблицы ТН и дашборда.
- При изменениях в Strapi рекомендуется отправлять вебхук в `/services/webhooks`, чтобы фронт обновлялся без ручного refresh.

## Диагностика

- Проверка работоспособности сервера: `GET /services/mes/ping` и `GET /services/webhooks`.
- При проблемах с live-данными первым делом проверить `GET /services/event`.
- При ошибках отправки в ЕДДС/МЭС смотреть логи роутов `routers/edds.js` и `routers/mes.js`.
- Для МинЭнерго РФ проверять `GET /services/minenergo`.

## ПЭС / Telegram / MAX

Текущая логика ПЭС разделена на три части:

- `routers/pes.js` - интеграция с T3 и выдача транспорта/экипажей;
- `routers/pesModule.js` - основной backend API модуля ПЭС для фронта;
- `services/pes/tg/*` и `services/pes/max/*` - отдельные контуры ботов.

Что важно по текущему состоянию:

- Telegram-бот в коде сохранен, но его polling сейчас временно не стартует из `app.js`, чтобы не шуметь `409` и не мешать диагностике;
- MAX-бот стартует вместе с приложением через `startPesMaxBotPolling()`;
- логика подписок MAX сейчас живет в локальных JSON/state-файлах, а не в отдельной коллекции Strapi;
- общие данные для модуля ПЭС поднимаются через `services/pes/pesModuleData.js` и `services/pes/pesStrapiStore.js`.

## Аудит-логгер (ClickHouse)

Маршрут аудита `POST /services/audit/event` в коде сохранен, но сам контур записи в ClickHouse сейчас временно не считается обязательным.

Причина:
- историю с ClickHouse уже дважды ловили как источник перегруза сервера;
- пока логгер не используется как критичный прод-контур;
- к его стабильному включению вернемся отдельно.

Что важно понимать сейчас:

- основная работа бэкенда не должна зависеть от ClickHouse;
- если запись аудита не удалась, это не должно валить основные интеграции;
- блок `services/auditLogger.js` сохранен в проекте и может быть быстро возвращен в более активный режим позже;
- переменные `DB_*` в `.env` остаются, но использовать контур аудита сейчас нужно аккуратно.

Если понадобится локально проверить запись в ClickHouse после отдельного включения, можно использовать:

```bash
curl -X POST http://localhost:3110/services/audit/event \
  -H "Content-Type: application/json" \
  -d '{"username":"Тест","role":"standart","page":"/","action":"manual_test","entity":"ui","details":"check"}'
```

```sql
SELECT created_at, username, role, page, action, details
FROM portal_logs.audit_events
ORDER BY created_at DESC
LIMIT 30;
```

### DBeaver: подключение через SSH-туннель (рекомендуется)

На локальной машине держать отдельное окно терминала:

```bash
ssh -N -L 18123:127.0.0.1:8123 root@78.155.197.207
```

Параметры в DBeaver:
- Host: `127.0.0.1`
- Port: `18123`
- Database: `portal_logs`
- User: `portal_logger`
- Password: `<пароль>`

### Очистка таблицы аудита

`portal_logger` обычно не имеет `TRUNCATE`. Чистить под `default`:

```bash
clickhouse-client --host 127.0.0.1 --port 9000 --user default --password --database portal_logs
```

```sql
TRUNCATE TABLE audit_events;
SELECT count() FROM audit_events;
```

## Текущие ограничения

- Автотесты пока не настроены (`npm test` заглушка).
- Часть бизнес-логики и маппингов (районы/статусы/типы) захардкожена в роутерах.
