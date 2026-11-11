// Планировщик плановых отключений в press «Мособлэнерго24».
// Решение 06.11.2026 (Стас):
//  - основной прогон — раз в сутки в 07:30 МСК (batch, без спама);
//  - «за 3 дня» — календарное: дата старта (МСК) ≤ сегодня+3; публикация утром дня T-3;
//  - опоздавшие (МОДУС прислал <3 сут до старта, часто за 1 сут) — триггер из
//    Этапа 9 POST → debounce → прогон сразу, не дожидаясь 07:30.
// Группировка (округ+дата), mid-дедуп, картинка округа — в pressPublisher.
const axios = require("axios");
require("dotenv").config();
const { getJwt } = require("../modus/strapi");
const { publishPressGroupPost } = require("./pressPublisher");
const { normalizeDistrictKey } = require("./pressTextTemplate");

const RUN_AT_H_MSK = 7; // 07:30 МСК; в коде ниже сдвиг на +3h в UTC-поля,
const RUN_AT_M_MSK = 30; // вычитание 3h возвращает реальный момент
const DEBOUNCE_MS = 10 * 60 * 1000; // сборка пачки опоздавших ТН перед прогоном
const PAGE_SIZE = 100;

let dailyTimer = null;
let debounceTimer = null;
let runChain = Promise.resolve(); // сериализация прогонов (нет параллельных)

const mskDateKey = (d) =>
  new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Moscow" }).format(d); // YYYY-MM-DD

// Верхняя граница окна: конец календарного дня сегодня+3 (МСК).
// Вместе с нижней границей «start > now» окно = множество due-групп.
function windowUntilMsk() {
  const now = new Date();
  const msk = new Date(now.getTime() + 3 * 3600 * 1000);
  return new Date(
    Date.UTC(msk.getUTCFullYear(), msk.getUTCMonth(), msk.getUTCDate() + 4, 0, 0, 0) -
      3 * 3600 * 1000
  ); // 00:00 МСК следующего дня после today+3
}

// Due-правило: дата старта ≤ сегодня+3 (МСК). Календарно, не скользящие 72ч —
// иначе при тике 07:30 дневной старт «за 3 дня» уходил бы только завтра утром.
function isPressPlannedDue(startLike) {
  const start = new Date(startLike);
  if (Number.isNaN(start.getTime())) return false;
  const limit = mskDateKey(new Date(Date.now() + 3 * 86400000));
  return mskDateKey(start) <= limit;
}

async function fetchWindowTns(jwt, urlStrapi) {
  const now = new Date();
  const until = windowUntilMsk();
  const rows = [];
  let page = 1;
  let pageCount = 1;

  do {
    const { data } = await axios.get(`${urlStrapi}/api/teh-narusheniyas`, {
      headers: { Authorization: `Bearer ${jwt}` },
      params: {
        "filters[BASE_TYPE][$eq]": 1,
        "filters[STATUS_NAME][$eq]": "запланировано",
        "filters[createDateTime][$gt]": now.toISOString(),
        "filters[createDateTime][$lte]": until.toISOString(),
        "pagination[page]": page,
        "pagination[pageSize]": PAGE_SIZE,
        "sort[0]": "createDateTime:asc",
        "fields[0]": "guid",
        "fields[1]": "documentId",
        "fields[2]": "number",
        "fields[3]": "createDateTime",
        "fields[4]": "repairDateTime",
        "fields[5]": "mid_MAX_press",
        "fields[6]": "data",
      },
      timeout: 30000,
    });
    const chunk = Array.isArray(data?.data) ? data.data : [];
    rows.push(...chunk);
    pageCount = Number(data?.meta?.pagination?.pageCount || 1);
    page += 1;
  } while (page <= pageCount);

  return rows;
}

// Группировка: (округ, дата МСК старта). Участник уже опубликован (mid есть) —
// в пост не входит; если в группе ЕСТЬ новые участники — выходим постом-дополнением
// (анти-спам приоритетнее полноты; решение 06.11.2026 + доп-посты 11.11.2026).
function groupRows(rows) {
  const groups = new Map();
  for (const row of rows) {
    const data = row.data && typeof row.data === "object" ? row.data : {};
    const district = String(data.DISTRICT || "").trim();
    const start = row.createDateTime ? new Date(row.createDateTime) : null;
    if (!district || !start || Number.isNaN(start.getTime())) continue;

    const key = `${normalizeDistrictKey(district)}|${mskDateKey(start)}`;
    if (!groups.has(key)) groups.set(key, { district, rows: [] });
    groups.get(key).rows.push(row);
  }
  return [...groups.values()];
}

// Один прогон. { reason, dryRun, onlyDistrict } → { ok, message }.
// dryRun=true — только лог, без отправки (безопасный тест на живых данных).
// onlyDistrict — публиковать только группы этого округа (тест: «пушкинский» / «Пушкинский г.о.»).
async function runPressPlannedOnce({ reason = "manual", dryRun = false, onlyDistrict = null } = {}) {
  const jwt = await getJwt();
  if (!jwt) return { ok: false, message: "JWT Strapi не получен" };
  const urlStrapi = process.env.URL_STRAPI;

  const rows = await fetchWindowTns(jwt, urlStrapi);
  let groups = groupRows(rows);
  if (onlyDistrict) {
    const want = normalizeDistrictKey(onlyDistrict);
    groups = groups.filter((g) => normalizeDistrictKey(g.district) === want);
  }

  let published = 0;
  let skipped = 0;
  let failed = 0;
  const notes = [];

  for (const g of groups) {
    const publishedRows = g.rows.filter((r) => r.mid_MAX_press);
    const freshRows = g.rows.filter((r) => !r.mid_MAX_press);
    if (!freshRows.length) {
      skipped += 1;
      continue; // группа уже опубликована, новых ТН нет
    }
    // В группу прилетели новые ТН после первой публикации — выходим отдельным
    // постом-дополнением с пометкой «ДОПОЛНИТЕЛЬНАЯ ИНФОРМАЦИЯ ПО ОТКЛЮЧЕНИЮ».
    const additional = publishedRows.length > 0;

    const entries = freshRows
      .map((r) => {
        const data = r.data && typeof r.data === "object" ? r.data : {};
        return {
          guid: r.guid,
          start: new Date(r.createDateTime),
          end: r.repairDateTime ? new Date(r.repairDateTime) : null,
          address: data.ADDRESS_LIST || "",
          reason: data.BRIGADE_ACTION || "Отключение для безопасного проведения работ",
        };
      })
      .sort((a, b) => a.start - b.start);

    const members = freshRows.map((r) => ({ documentId: r.documentId, guid: r.guid }));
    const label =
      `${g.district} (${mskDateKey(entries[0].start)}): ТН=${entries.length}` +
      `${additional ? " [доп]" : ""}`;

    if (dryRun) {
      published += 1;
      console.log(`[press-planned] DRY-RUN опубликовал бы: ${label}`);
      notes.push(`dry: ${label}`);
      continue;
    }

    try {
      const result = await publishPressGroupPost({
        jwt,
        urlStrapi,
        district: g.district,
        entries,
        members,
        additional,
      });
      if (result.ok) {
        published += 1;
        console.log(`[press-planned] ✓ ${label}: ${result.message}`);
        notes.push(`ok: ${label}`);
      } else {
        failed += 1;
        console.warn(`[press-planned] ✗ ${label}: ${result.message}`);
        notes.push(`fail: ${label} — ${result.message}`);
      }
    } catch (e) {
      failed += 1;
      console.warn(`[press-planned] ✗ ${label}:`, e?.response?.status || e?.message);
      notes.push(`fail: ${label} — ${e?.message}`);
    }
  }

  const message =
    `reason=${reason}${dryRun ? " dryRun" : ""}: окно=${rows.length} ТН, групп=${groups.length}, ` +
    `опубликовано=${published}, пропущено=${skipped}, ошибок=${failed}`;
  console.log(`[press-planned] ${message}`);
  if (notes.length) notes.forEach((n) => console.log(`[press-planned]   ${n}`));
  return { ok: failed === 0, message };
}

// Сериализация: прогон за прогоном, без параллельных запусков.
function enqueueRun(reason) {
  runChain = runChain
    .then(() => runPressPlannedOnce({ reason }))
    .catch((e) =>
      console.warn("[press-planned] прогон упал:", e?.response?.status || e?.message)
    );
  return runChain;
}

// Триггер «опоздавшей» ТН из Этапа 9 POST: debounce 10 мин, чтобы собрать
// пачку МОДУСа (один округ+дата прилетает десятками минут подряд).
function schedulePressPlannedRun(reason = "late-planned-tn") {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    console.log(`[press-planned] дебаунс истёк — запускаю прогон (${reason})`);
    enqueueRun(reason);
  }, DEBOUNCE_MS);
  console.log(
    `[press-planned] опоздавшая ТН — прогон через ${DEBOUNCE_MS / 60000} мин (${reason})`
  );
  return true;
}

// ms до следующих 07:30 МСК.
function msUntilNextRun(now = Date.now()) {
  const msk = new Date(now + 3 * 3600 * 1000);
  let next =
    Date.UTC(msk.getUTCFullYear(), msk.getUTCMonth(), msk.getUTCDate(), RUN_AT_H_MSK, RUN_AT_M_MSK, 0) -
    3 * 3600 * 1000;
  if (next <= now) {
    const t = new Date(now + 3 * 3600 * 1000 + 86400000);
    next =
      Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), RUN_AT_H_MSK, RUN_AT_M_MSK, 0) -
      3 * 3600 * 1000;
  }
  return next - now;
}

// Дневной прогон в 07:30 МСК, всегда активен (без env-флагов).
// Без автозапуска при старте: первое включение не разлетается залпом по всем
// due-группам — первый прогон в 07:30 (или ручной runPressPlannedOnce /
// триггер опоздавшей ТН). Если процесс упал до 07:30 — прогон сдвинется
// на следующие сутки (ручной запуск/триггер покрывают).
function startPressPlannedScheduler() {
  if (dailyTimer) return;

  const scheduleNext = () => {
    const delay = msUntilNextRun();
    console.log(
      `[press-planned] следующий дневной прогон через ${Math.round(delay / 60000)} мин (07:30 МСК)`
    );
    dailyTimer = setTimeout(async () => {
      await enqueueRun("daily-0730");
      scheduleNext();
    }, delay);
  };
  scheduleNext();
}

module.exports = {
  runPressPlannedOnce,
  startPressPlannedScheduler,
  schedulePressPlannedRun,
  isPressPlannedDue,
};
