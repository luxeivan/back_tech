// Подписки MAX храним в Strapi, чтобы локалка и прод работали с одной моделью данных.
const { getReplyTarget, getSenderNode, getSenderUserId } = require("./context");
const {
  hasScope,
  norm,
  parsePoScopeName,
  scopeKeyByName,
} = require("./utils");
const {
  PES_ENDPOINTS,
  fetchAll,
  fetchFirst,
  createOne,
  updateOne,
  manyRelation,
} = require("../pesStrapiStore");

function normalizeSubscriber(row) {
  const branchScopes = manyRelation(row?.branches)
    .map((branch) => ({
      id: Number(branch.id || 0),
      name: norm(branch.name),
    }))
    .filter((branch) => branch.name);

  return {
    id: row?.id || null,
    documentId: row?.documentId || null,
    max_user_id: Number(row?.max_user_id || 0),
    max_chat_id: Number(row?.max_chat_id || 0),
    username: norm(row?.username),
    first_name: norm(row?.first_name),
    last_name: norm(row?.last_name),
    muted: Boolean(row?.muted),
    is_active: row?.is_active !== false,
    subscribe_all: Boolean(row?.subscribe_all),
    branchScopes,
    branches: branchScopes.map((branch) => branch.name),
  };
}

async function listUsers() {
  const rows = await fetchAll(PES_ENDPOINTS.MAX_SUBSCRIBERS, {
    params: {
      "filters[is_active][$eq]": true,
      populate: "branches",
      "sort[0]": "max_user_id:asc",
    },
  });
  return rows.map(normalizeSubscriber);
}

async function getUserByMaxUserId(userId) {
  const id = Number(userId || 0);
  if (!Number.isFinite(id) || id <= 0) return null;

  const rows = await fetchAll(PES_ENDPOINTS.MAX_SUBSCRIBERS, {
    params: {
      "filters[max_user_id][$eq]": id,
      populate: "branches",
      "sort[0]": "updatedAt:desc",
    },
  });
  const row = rows[0] || null;

  return row ? normalizeSubscriber(row) : null;
}

async function findUsersByMaxUserId(userId) {
  const id = Number(userId || 0);
  if (!Number.isFinite(id) || id <= 0) return [];

  return fetchAll(PES_ENDPOINTS.MAX_SUBSCRIBERS, {
    params: {
      "filters[max_user_id][$eq]": id,
      populate: "branches",
      "sort[0]": "updatedAt:desc",
    },
  });
}

async function ensureBranches(branchNames) {
  const names = Array.from(
    new Set((branchNames || []).map((item) => norm(item)).filter(Boolean))
  );
  if (!names.length) return [];

  const existing = await fetchAll(PES_ENDPOINTS.BRANCHES, {
    params: {
      "pagination[pageSize]": 500,
    },
  });

  const byNorm = new Map(
    existing
      .flatMap((row) => {
        const keys = new Set();
        const raw = norm(row.name_norm || "");
        const byName = scopeKeyByName(row.name);
        if (byName) keys.add(byName);
        if (raw) {
          keys.add(raw);
          if (!raw.includes(":")) keys.add(`br:${raw}`);
        }
        return Array.from(keys).map((key) => ({ key, row }));
      })
      .map((item) => [item.key, item.row])
  );

  const out = [];
  for (const name of names) {
    const key = scopeKeyByName(name);
    if (!key) continue;

    const found = byNorm.get(key);
    if (found) {
      if (found.is_active === false && found.documentId) {
        const updated = await updateOne(PES_ENDPOINTS.BRANCHES, found.documentId, {
          is_active: true,
        });
        byNorm.set(key, updated);
        out.push(updated);
      } else {
        out.push(found);
      }
      continue;
    }

    const created = await createOne(PES_ENDPOINTS.BRANCHES, {
      name,
      name_norm: key,
      is_active: true,
    });
    byNorm.set(key, created);
    out.push(created);
  }

  return out;
}

async function saveUserState(user) {
  const userId = Number(user?.max_user_id || user?.user_id || 0);
  if (!Number.isFinite(userId) || userId <= 0) return user || null;
  const chatId = Number(user?.max_chat_id || user?.chat_id || 0);

  const existingRows = await findUsersByMaxUserId(userId);
  const existing = existingRows[0] || null;

  const branches = Array.isArray(user?.branches)
    ? user.branches.map(norm).filter(Boolean)
    : [];
  const subscribeAll = Boolean(user?.subscribe_all);
  const branchRows = subscribeAll ? [] : await ensureBranches(branches);
  const branchIds = branchRows
    .map((branch) => Number(branch.id))
    .filter((id) => Number.isFinite(id) && id > 0);

  const payload = {
    max_user_id: userId,
    max_chat_id: Number.isFinite(chatId) && chatId > 0 ? chatId : null,
    username: norm(user?.username) || null,
    first_name: norm(user?.first_name) || null,
    last_name: norm(user?.last_name) || null,
    muted: Boolean(user?.muted),
    is_active: user?.is_active !== false,
    subscribe_all: subscribeAll,
    branches: branchIds,
    last_interaction_at: new Date().toISOString(),
  };

  let row = null;
  if (existingRows.length > 1) {
    console.warn(
      `[pes-max-bot] Найдено дублей подписчика MAX max_user_id=${userId}: ${existingRows.length}. Синхронизирую все записи.`
    );
  }

  if (existingRows.length) {
    for (const item of existingRows) {
      if (!item?.documentId) continue;
      const updated = await updateOne(PES_ENDPOINTS.MAX_SUBSCRIBERS, item.documentId, payload);
      if (!row) row = updated;
    }
  } else {
    row = await createOne(PES_ENDPOINTS.MAX_SUBSCRIBERS, payload);
  }

  const fresh = await getUserByMaxUserId(userId);
  return fresh || normalizeSubscriber(row);
}

async function upsertUserState(update) {
  const userId = getSenderUserId(update);
  if (!Number.isFinite(userId)) return null;

  const sender = getSenderNode(update) || {};
  const target = getReplyTarget(update);
  const targetChatId = Number(target?.chat_id || 0);
  const current = (await getUserByMaxUserId(userId)) || {};
  const next = {
    ...current,
    max_user_id: userId,
    max_chat_id:
      Number.isFinite(targetChatId) && targetChatId > 0
        ? targetChatId
        : current.max_chat_id,
    username: norm(sender.username) || current.username,
    first_name: norm(sender.first_name) || current.first_name,
    last_name: norm(sender.last_name) || current.last_name,
    muted: Boolean(current.muted),
    is_active: current.is_active !== false,
    subscribe_all: Boolean(current.subscribe_all),
    branches: Array.isArray(current.branches) ? current.branches : [],
  };

  return saveUserState(next);
}

async function setUserScopes(user, scopes) {
  return saveUserState({
    ...user,
    subscribe_all: false,
    branches: Array.from(
      new Set((Array.isArray(scopes) ? scopes : []).map(norm).filter(Boolean))
    ),
  });
}

async function setUserSubscribeAll(user) {
  return saveUserState({
    ...user,
    subscribe_all: true,
    branches: [],
  });
}

async function clearUserScopes(user) {
  return saveUserState({
    ...user,
    subscribe_all: false,
    branches: [],
  });
}

async function toggleScope(user, scopeName) {
  const current = Array.isArray(user?.branches) ? user.branches : [];
  if (hasScope(current, scopeName)) {
    return setUserScopes(
      user,
      current.filter((item) => scopeKeyByName(item) !== scopeKeyByName(scopeName))
    );
  }
  return setUserScopes(user, [...current, scopeName]);
}

function formatUserSubs(user) {
  if (!user) return "Подписки не найдены.";
  if (user.subscribe_all) return "Вы подписаны на все филиалы.";

  const raw = Array.isArray(user.branches) ? user.branches : [];
  const branches = raw.filter((item) => !parsePoScopeName(item));
  const poScopes = raw
    .map((item) => parsePoScopeName(item))
    .filter(Boolean)
    .map((item) => `${item.branch} / ${item.po}`);

  if (!branches.length && !poScopes.length) {
    return "У вас пока нет подписок.";
  }

  const lines = ["Ваши подписки:"];
  if (branches.length) {
    lines.push("Филиалы:");
    branches.forEach((item) => lines.push(`- ${item}`));
  }
  if (poScopes.length) {
    lines.push("ПО:");
    poScopes.forEach((item) => lines.push(`- ${item}`));
  }
  return lines.join("\n");
}

module.exports = {
  listUsers,
  getUserByMaxUserId,
  saveUserState,
  upsertUserState,
  setUserSubscribeAll,
  clearUserScopes,
  toggleScope,
  formatUserSubs,
};
