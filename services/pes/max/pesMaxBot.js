// Головной файл MAX-бота: старт сервиса, long polling и marker updates.
const { canRunMaxBot, maxLog } = require("./config");
const { readState, writeState } = require("./storage");
const { fetchUpdates } = require("./transport");
const { processUpdate } = require("./handlers");

let pollingStarted = false;
let pollingMarker = null;

async function bootstrapMarkerToLatest() {
  if (Number.isFinite(Number(pollingMarker))) return;

  try {
    const page = await fetchUpdates({ timeout: 0, limit: 1 });
    if (Number.isFinite(Number(page.marker))) {
      pollingMarker = Number(page.marker);
      writeState(pollingMarker);
      maxLog(`marker инициализирован: ${pollingMarker}`);
    }
  } catch (e) {
    console.error(
      "[pes-max-bot] Не удалось инициализировать marker:",
      e?.message || e
    );
  }
}

async function pollLoop() {
  if (!canRunMaxBot()) return;

  try {
    const page = await fetchUpdates({
      marker: pollingMarker,
      timeout: 25,
      limit: 100,
    });

    for (const update of page.updates) {
      try {
        await processUpdate(update);
      } catch (e) {
        console.error(
          "[pes-max-bot] Ошибка обработки update:",
          e?.response?.data || e?.message || e
        );
      }
    }

    if (Number.isFinite(Number(page.marker))) {
      pollingMarker = Number(page.marker);
      writeState(pollingMarker);
    }
  } catch (e) {
    console.error(
      "[pes-max-bot] Ошибка polling:",
      e?.response?.data || e?.message || e
    );
  } finally {
    setTimeout(pollLoop, 1000);
  }
}

async function startPesMaxBotPolling() {
  if (!canRunMaxBot()) {
    maxLog("отключен (нет PES_MAX_BOT_TOKEN или PES_MAX_BOT_ENABLED=0)");
    return;
  }
  if (pollingStarted) return;

  pollingStarted = true;

  try {
    const state = readState();
    pollingMarker = Number.isFinite(Number(state.marker))
      ? Number(state.marker)
      : null;
    maxLog("polling запущен");
    await bootstrapMarkerToLatest();
    pollLoop();
  } catch (e) {
    pollingStarted = false;
    console.error("[pes-max-bot] Ошибка старта:", e?.message || e);
  }
}

module.exports = {
  startPesMaxBotPolling,
};
