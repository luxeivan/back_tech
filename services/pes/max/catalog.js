// Справочник филиалов и ПО для MAX-бота на базе текущего реестра ПЭС.
const { loadPesItems } = require("../pesModuleData");
const { branchNorm, sameBranch, norm } = require("./utils");

async function getBranchesList() {
  const items = await loadPesItems();
  return Array.from(
    new Set(items.map((x) => norm(x.branch)).filter(Boolean))
  ).sort((a, b) => a.localeCompare(b, "ru"));
}

async function getPoListForBranch(branch) {
  const items = await loadPesItems();
  return Array.from(
    new Set(
      items
        .filter((x) => sameBranch(x?.branch, branch))
        .map((x) => norm(x?.po))
        .filter(Boolean)
    )
  ).sort((a, b) => a.localeCompare(b, "ru"));
}

function findBranchByText(text, branches) {
  const needle = branchNorm(text);
  if (!needle) return "";
  const exact = branches.find((branch) => branchNorm(branch) === needle);
  if (exact) return exact;
  return (
    branches.find((branch) => {
      const key = branchNorm(branch);
      return key.includes(needle) || needle.includes(key);
    }) || ""
  );
}

module.exports = {
  getBranchesList,
  getPoListForBranch,
  findBranchByText,
};
