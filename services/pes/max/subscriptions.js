// Локальное хранение и операции над подписками пользователя в MAX.
const { getSenderNode, getSenderUserId } = require("./context");
const {
  hasScope,
  norm,
  parsePoScopeName,
  scopeKeyByName,
} = require("./utils");
const {
  readSubscriptionsStore,
  writeSubscriptionsStore,
} = require("./storage");

function getUserState(userId) {
  const store = readSubscriptionsStore();
  const key = String(userId || "");
  const row = store?.users?.[key];
  if (!row || typeof row !== "object") {
    return {
      user_id: Number(userId) || 0,
      first_name: "",
      last_name: "",
      username: "",
      subscribe_all: false,
      branches: [],
    };
  }
  return {
    user_id: Number(row.user_id || userId || 0),
    first_name: norm(row.first_name),
    last_name: norm(row.last_name),
    username: norm(row.username),
    subscribe_all: Boolean(row.subscribe_all),
    branches: Array.isArray(row.branches)
      ? row.branches.map(norm).filter(Boolean)
      : [],
  };
}

function saveUserState(user) {
  const store = readSubscriptionsStore();
  const key = String(user.user_id || "");
  if (!key) return user;

  store.users[key] = {
    user_id: Number(user.user_id) || 0,
    first_name: norm(user.first_name),
    last_name: norm(user.last_name),
    username: norm(user.username),
    subscribe_all: Boolean(user.subscribe_all),
    branches: Array.isArray(user.branches)
      ? user.branches.map(norm).filter(Boolean)
      : [],
    updatedAt: new Date().toISOString(),
  };

  writeSubscriptionsStore(store);
  return store.users[key];
}

function upsertUserState(update) {
  const userId = getSenderUserId(update);
  if (!Number.isFinite(userId)) return null;

  const sender = getSenderNode(update) || {};
  const current = getUserState(userId);
  const next = {
    ...current,
    user_id: userId,
    first_name: norm(sender.first_name) || current.first_name,
    last_name: norm(sender.last_name) || current.last_name,
    username: norm(sender.username) || current.username,
  };

  return saveUserState(next);
}

function setUserScopes(user, scopes) {
  return saveUserState({
    ...user,
    subscribe_all: false,
    branches: Array.from(
      new Set((Array.isArray(scopes) ? scopes : []).map(norm).filter(Boolean))
    ),
  });
}

function setUserSubscribeAll(user) {
  return saveUserState({
    ...user,
    subscribe_all: true,
    branches: [],
  });
}

function clearUserScopes(user) {
  return saveUserState({
    ...user,
    subscribe_all: false,
    branches: [],
  });
}

function toggleScope(user, scopeName) {
  const current = Array.isArray(user.branches) ? user.branches : [];
  if (hasScope(current, scopeName)) {
    return setUserScopes(
      user,
      current.filter((x) => scopeKeyByName(x) !== scopeKeyByName(scopeName))
    );
  }
  return setUserScopes(user, [...current, scopeName]);
}

function formatUserSubs(user) {
  if (!user) return "Подписки не найдены.";
  if (user.subscribe_all) return "Вы подписаны на все филиалы.";

  const raw = Array.isArray(user.branches) ? user.branches : [];
  const branches = raw.filter((x) => !parsePoScopeName(x));
  const poScopes = raw
    .map((x) => parsePoScopeName(x))
    .filter(Boolean)
    .map((x) => `${x.branch} / ${x.po}`);

  if (!branches.length && !poScopes.length) {
    return "У вас пока нет подписок.";
  }

  const lines = ["Ваши подписки:"];
  if (branches.length) {
    lines.push("Филиалы:");
    branches.forEach((x) => lines.push(`- ${x}`));
  }
  if (poScopes.length) {
    lines.push("ПО:");
    poScopes.forEach((x) => lines.push(`- ${x}`));
  }
  return lines.join("\n");
}

module.exports = {
  getUserState,
  saveUserState,
  upsertUserState,
  setUserSubscribeAll,
  clearUserScopes,
  toggleScope,
  formatUserSubs,
};
