// Планировщик публикации плановых отключений в press «Мособлэнерго24» (ТЗ: за 3 дня).
// Отвязан от ручки МОДУСа: фоновый тик сам находит созревшие группы (округ+дата)
// и публикует один пост на группу. Публикация — только из этого модуля
// (Этап 9 POST плановые больше не шлёт).
//
// Логика окна: публикуем ТН, у которых start ∈ (now, now+72h] — тогда
// start−72h уже наступил (правило «за 3 дня»). ТН, пришедшая раньше чем за 3 сут,
// ждёт в окне до наступления срока; опоздавшая (пришла <3 сут до старта) — публикуется сразу.
const axios = require("axios");
require("dotenv").config();
const { getJwt } = require("../modus/strapi");
const { publishPressGroupPost } = require("./pressPublisher");
const { normalizeDistrictKey } = require("./pressTextTemplate");

const TICK_MS = 30 * 60 * 1000;
const WINDOW_MS = 72 * 60 * 60 * 1000; // 72ч вперёд от now
const PAGE_SIZE = 100;

let timer = null;

const mskDateKey = (d) =>
  new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Moscow" }).format(d); // YYYY-MM-DD

async function fetchWindowTns(jwt, urlStrapi) {
  const now = new Date();
  const until = new Date(now.getTime() + WINDOW_MS);
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
// вся группа пропускается (анти-спам приоритетнее полноты; решение 06.11.2026).
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
    if (g.rows.some((r) => r.mid_MAX_press)) {
      skipped += 1;
      continue; // уже публиковалась
    }

    const entries = g.rows
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

    const members = g.rows.map((r) => ({ documentId: r.documentId, guid: r.guid }));
    const label = `${g.district} (${mskDateKey(entries[0].start)}): ТН=${entries.length}`;

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

// Тик каждые 30 мин + прогон при старте. Включается только env
// PRESS_PLANNED_ENABLED=1 — иначе ручной запуск runPressPlannedOnce().
function startPressPlannedScheduler() {
  if (process.env.PRESS_PLANNED_ENABLED !== "1") {
    console.log(
      "[press-planned] планировщик выключен (PRESS_PLANNED_ENABLED=1) — " +
        "ручной запуск: runPressPlannedOnce()"
    );
    return;
  }
  if (timer) return;

  const scheduleNext = () => {
    timer = setTimeout(async () => {
      try {
        await runPressPlannedOnce({ reason: "tick" });
      } catch (e) {
        console.warn("[press-planned] ошибка тика:", e?.response?.status || e?.message);
      } finally {
        scheduleNext();
      }
    }, TICK_MS);
  };

  runPressPlannedOnce({ reason: "startup" }).catch((e) =>
    console.warn("[press-planned] ошибка стартового прогона:", e?.message)
  );
  scheduleNext();
  console.log("[press-planned] планировщик включён: тик каждые 30 мин, окно T-72h");
}

module.exports = { runPressPlannedOnce, startPressPlannedScheduler };
