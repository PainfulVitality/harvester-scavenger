export const ID = "harvester-scavenger";

const rewardDefaults = () => ({ items: [], tables: [] });

export function defaultRules() {
  return {
    name: "",
    description: "",
    defeatedOnly: false,
    lootMode: false,
    mode: "skill",
    skill: "sur",
    ability: "wis",
    tool: "herb",
    dc: 12,
    distance: null,
    harvestLimit: 1,
    revealItems: false,
    revealTables: false,
    critical: "world",
    naturalOne: "world",
    base: rewardDefaults(),
    mishap: rewardDefaults(),
    criticalRewards: rewardDefaults(),
    thresholds: [],
    macro: null,
    macroClient: "gm"
  };
}

export function normalizeRules(data = {}) {
  const rules = { ...defaultRules(), ...data };
  // Preserve existing nodes from releases where defeated-only also selected Loot wording.
  if (!Object.hasOwn(data, "lootMode")) rules.lootMode = Boolean(data.defeatedOnly);
  if (rules.naturalOne === "normal") rules.naturalOne = "world";
  delete rules.failureLimit;
  delete rules.lockOnFailure;
  return rules;
}

export function defaultState() {
  return { failures: 0, harvests: 0, locked: false, lastOutcome: null };
}

export function availability(rules, state) {
  if (state.locked) return "locked";
  if (rules.harvestLimit && state.harvests + state.failures >= rules.harvestLimit) {
    return state.lastOutcome === "failure" ? "locked" : "depleted";
  }
  return "ready";
}

export function remainingHarvests(rules, state) {
  if (state.locked) return 0;
  return rules.harvestLimit ? Math.max(0, rules.harvestLimit - state.harvests - state.failures) : Infinity;
}

export function evaluateHarvest(rules, state, roll, worldCritical, worldAutomaticFailure = true) {
  const { total = null, natural = null } = roll ?? {};
  const checked = rules.mode !== "free";
  const naturalOne = rules.naturalOne === "world" ? worldAutomaticFailure ? "lock" : "none" : rules.naturalOne;
  const mishap = checked && natural === 1 ? naturalOne : "none";
  const critical = checked && natural === 20;
  const alternateOne = mishap === "reward";
  const alternateTwenty = critical && rules.critical === "reward";
  const forcedFailure = mishap === "fail" || mishap === "lock";
  const success = !checked || alternateOne || alternateTwenty || (!forcedFailure && total >= rules.dc);
  const next = { ...state };
  if (!success) {
    next.failures += mishap === "lock" && rules.harvestLimit
      ? Math.max(1, rules.harvestLimit - state.harvests - state.failures) : 1;
    next.locked = mishap === "lock" || (rules.harvestLimit > 0 && next.harvests + next.failures >= rules.harvestLimit);
    next.lastOutcome = "failure";
    return { success, outcome: "failure", next, total, natural };
  }

  next.harvests++;
  const doubleCritical = critical && (rules.critical === "yes" || (rules.critical === "world" && worldCritical));
  const alternate = alternateOne || alternateTwenty;
  const tiers = checked && !alternate ? rules.thresholds.filter(tier => total > tier.above) : [];
  const sources = alternateOne ? [rules.mishap] : alternateTwenty ? [rules.criticalRewards] : [rules.base, ...tiers];
  const multiplier = 2 ** (tiers.filter(tier => tier.double).length + Number(doubleCritical));
  const outcome = alternateOne ? "mishap" : critical ? "critical" : "success";
  next.lastOutcome = outcome;
  return { success, outcome, next, total, natural, sources, multiplier };
}
