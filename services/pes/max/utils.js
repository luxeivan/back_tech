// Нормализация и сравнение филиалов, ПО и подписочных scope-имен.
function norm(v) {
  return String(v == null ? "" : v).replace(/\s+/g, " ").trim();
}

function branchNorm(v) {
  return norm(v)
    .toLowerCase()
    .replace(/\bфилиал\b/g, "")
    .replace(/[^а-яa-z0-9]/gi, "");
}

function poNorm(v) {
  return norm(v)
    .toLowerCase()
    .replace(/\bпо\b/g, "")
    .replace(/[^а-яa-z0-9]/gi, "");
}

function sameBranch(a, b) {
  return branchNorm(a) === branchNorm(b);
}

function makePoScopeName(branch, po) {
  return `ПО: ${norm(branch)} / ${norm(po)}`;
}

function parsePoScopeName(name) {
  const match = /^ПО:\s*(.+?)\s*\/\s*(.+)$/i.exec(norm(name));
  if (!match) return null;
  return {
    branch: norm(match[1]),
    po: norm(match[2]),
  };
}

function scopeKeyByName(name) {
  const poScope = parsePoScopeName(name);
  if (poScope) {
    return `po:${branchNorm(poScope.branch)}:${poNorm(poScope.po)}`;
  }
  return `br:${branchNorm(name)}`;
}

function hasScope(list, scopeName) {
  const target = scopeKeyByName(scopeName);
  return (Array.isArray(list) ? list : []).some(
    (item) => scopeKeyByName(item) === target
  );
}

module.exports = {
  norm,
  branchNorm,
  poNorm,
  sameBranch,
  makePoScopeName,
  parsePoScopeName,
  scopeKeyByName,
  hasScope,
};
