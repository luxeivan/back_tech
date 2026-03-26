// Файловое состояние MAX-бота: marker polling и локальные подписки.
const fs = require("fs");
const path = require("path");

const STATE_FILE = path.resolve(
  __dirname,
  "../../../data/pesMaxBotState.json"
);
const SUBS_FILE = path.resolve(
  __dirname,
  "../../../data/pesMaxSubscriptions.json"
);

function ensureDataDir() {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonSafe(filePath, value) {
  ensureDataDir();
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function readState() {
  const raw = readJsonSafe(STATE_FILE, { marker: null });
  const marker = Number(raw?.marker);
  return { marker: Number.isFinite(marker) ? marker : null };
}

function writeState(marker) {
  writeJsonSafe(STATE_FILE, {
    marker: Number.isFinite(Number(marker)) ? Number(marker) : null,
    updatedAt: new Date().toISOString(),
  });
}

function readSubscriptionsStore() {
  const raw = readJsonSafe(SUBS_FILE, { users: {} });
  return raw && typeof raw === "object" ? raw : { users: {} };
}

function writeSubscriptionsStore(store) {
  writeJsonSafe(SUBS_FILE, store);
}

module.exports = {
  readState,
  writeState,
  readSubscriptionsStore,
  writeSubscriptionsStore,
};
