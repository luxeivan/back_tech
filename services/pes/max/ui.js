// Текст и inline-клавиатуры MAX-бота для меню, филиалов и ПО.
const { getBranchesList, getPoListForBranch } = require("./catalog");
const { getSenderName, button, keyboard } = require("./context");
const { hasScope, makePoScopeName, parsePoScopeName } = require("./utils");

function buildMainMenuText(update) {
  const name = getSenderName(update);
  return [
    `Привет, ${name}.`,
    "Бот ПЭС в MAX запущен.",
    "Можно посмотреть филиалы и собрать подписки по филиалам и ПО.",
  ].join("\n");
}

function buildMainMenuAttachments() {
  return keyboard([
    [button("Филиалы", "list")],
    [button("Мои подписки", "my")],
    [
      button("Подписаться на все", "suball"),
      button("Очистить", "clear"),
    ],
  ]);
}

async function buildBranchesMenuAttachments() {
  const branches = await getBranchesList();
  const rows = branches.map((branch) => [button(branch, "open", branch)]);
  rows.push([button("Подписаться на все", "suball")]);
  rows.push([button("Мои подписки", "my"), button("В меню", "menu")]);
  return keyboard(rows);
}

async function buildPoMenuAttachments(user, branch) {
  const poList = await getPoListForBranch(branch);
  const rows = [];

  const branchChecked = hasScope(user?.branches, branch) ? "✅ " : "";
  rows.push([button(`${branchChecked}Филиал целиком`, "toggle", branch)]);

  for (const po of poList) {
    const scopeName = makePoScopeName(branch, po);
    const checked = hasScope(user?.branches, scopeName) ? "✅ " : "";
    rows.push([button(`${checked}${po}`, "toggle", scopeName)]);
  }

  rows.push([button("К филиалам", "list"), button("Мои подписки", "my")]);
  rows.push([button("В меню", "menu")]);
  return keyboard(rows);
}

function buildPoMenuText(branch) {
  return `Филиал: ${branch}\nВыбери ПО или подпишись на филиал целиком.`;
}

function resolveScopeBranch(scopeName) {
  const poScope = parsePoScopeName(scopeName);
  return poScope?.branch || scopeName;
}

module.exports = {
  buildMainMenuText,
  buildMainMenuAttachments,
  buildBranchesMenuAttachments,
  buildPoMenuAttachments,
  buildPoMenuText,
  resolveScopeBranch,
};
