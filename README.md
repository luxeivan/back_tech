# back_tech

Express-бэкенд для Портала технологических нарушений (ЖТН/ТН).

## Что делает сервис

- принимает и обрабатывает входящие события по ТН (интеграция с Modus);
- отправляет данные во внешние системы (ЕДДС, МосЭнергоСбыт);
- отдает сервисные API для фронтенда (AI-аналитика, PES, агрегаты);
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
    ai.js               # AI-аналитика через OpenRouter
    pes.js              # Данные по транспорту/экипажам
    disconnected.js     # Агрегаты по отключенным потребителям
    audit.js            # Аудит действий пользователя (логгер)
    webhooks.js         # Вебхуки Strapi -> broadcast в SSE
    dadata.js           # Обогащение по DaData (вспомогательный)
  services/
    sse.js              # SSE клиенты и broadcast
    auditLogger.js      # Запись аудита в ClickHouse
    auth.js             # Проверка/получение auth в Strapi
    autoDescription.js  # Автоформирование описания
```

## Основные эндпоинты

Базовый префикс: `/services`

- `PUT /services/modus` — обновление ТН из Modus
- `POST /services/modus` — создание/обработка ТН из Modus
- `POST /services/edds` — отправка ТН в ЕДДС
- `POST /services/mes/upload` — отправка в МосЭнергоСбыт
- `GET /services/mes/status` — статус отправки реестра в МЭС
- `GET /services/ai/ping` — проверка AI-модуля
- `POST /services/ai/analysis` — AI-аналитика по метрикам
- `GET /services/pes/vehicles` — транспорт/экипажи PES
- `GET /services/disconnected` — агрегаты по отключенным
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

### AI

- `OPENROUTER_API_KEY`

### PES / T3

- `T3_BASE`
- `T3_USER`
- `T3_PSWD`
- `T3_TOKEN`

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

- Проверка работоспособности сервера: `GET /services/ai/ping` и `GET /services/mes/ping`.
- При проблемах с live-данными первым делом проверить `GET /services/event`.
- При ошибках отправки в ЕДДС/МЭС смотреть логи роутов `routers/edds.js` и `routers/mes.js`.

## Аудит-логгер (ClickHouse)

Логгер пишет действия в таблицу `portal_logs.audit_events`:
- переходы по страницам (`page_view`, `page_leave`);
- клики в UI (дашборд, фильтры, AI, журнал);
- действия отправки/редактирования ТН;
- backend-события отправки (`edds_send`, `mes_upload`, `pes_command`).

Минимальная проверка, что логгер жив:

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

## Рекомендованные следующие шаги

- вынести маппинги в конфиг-файлы;
- добавить smoke-тесты ключевых ручек;
- добавить `.env.example` с обязательными переменными.
