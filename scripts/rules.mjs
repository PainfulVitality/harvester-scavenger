import { validateCurrencyEntries } from "./currency.mjs";
export const ID = "harvester-scavenger";

export class RuleValidationError extends Error {}

function requireRule(condition, message) {
  if (!condition) throw new RuleValidationError(message);
}

const plainObject = value => value !== null && typeof value === "object"
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const reference = value => typeof value === "string" && value.length <= 2048 && /^[\w.-]+$/.test(value);

const rewardDefaults = () => ({ items: [], tables: [], currency: [] });

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
    revealCurrency: false,
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
  for (const key of ["base", "mishap", "criticalRewards"]) {
    if (plainObject(rules[key])) rules[key] = { ...rules[key], currency: Object.hasOwn(rules[key], "currency") ? rules[key].currency : [] };
  }
  if (Array.isArray(rules.thresholds)) rules.thresholds = rules.thresholds.map(tier => plainObject(tier)
    ? { ...tier, currency: Object.hasOwn(tier, "currency") ? tier.currency : [] } : tier);
  delete rules.failureLimit;
  delete rules.lockOnFailure;
  return rules;
}

/** Validate at the authority/storage boundary; UI constraints alone are not authoritative. */
export function validateRules(data) {
  requireRule(plainObject(data), "The harvest settings must be an object.");
  const normalized = normalizeRules(data);
  const rules = Object.fromEntries(Object.keys(defaultRules()).map(key => [key, normalized[key]]));
  for (const key of ["name", "description", "skill", "ability", "tool"]) {
    requireRule(typeof rules[key] === "string" && rules[key].length <= (key === "description" ? 100000 : 120),
      `The harvest ${key} is invalid or too long.`);
  }
  for (const key of ["defeatedOnly", "lootMode", "revealItems", "revealTables", "revealCurrency"]) {
    requireRule(typeof rules[key] === "boolean", `The harvest ${key} setting must be true or false.`);
  }
  for (const [key, choices] of Object.entries({
    mode: ["skill", "ability", "tool", "free"], critical: ["world", "yes", "no", "reward"],
    naturalOne: ["world", "none", "fail", "lock", "reward"], macroClient: ["gm", "player"]
  })) requireRule(choices.includes(rules[key]), `The harvest ${key} setting is invalid.`);
  const checkConfig = globalThis.CONFIG?.DND5E?.[{ skill: "skills", ability: "abilities", tool: "tools" }[rules.mode]];
  if (checkConfig) requireRule(Object.hasOwn(checkConfig, rules[{ skill: "skill", ability: "ability", tool: "tool" }[rules.mode]]),
    "The selected harvest check is not available in this system.");
  requireRule(integer(rules.dc, 1, 99), "Difficulty Class must be a whole number from 1 to 99.");
  requireRule(integer(rules.harvestLimit, 0, 999), "Available harvests must be a whole number from 0 to 999.");
  requireRule(rules.distance === null || (Number.isFinite(rules.distance) && rules.distance >= 0),
    "Interaction distance must be empty or a nonnegative number.");
  requireRule(rules.macro === null || reference(rules.macro), "The reward macro reference is invalid.");
  requireRule(Array.isArray(rules.thresholds) && rules.thresholds.length <= 20, "Use at most 20 reward thresholds.");
  let references = 0;
  const source = (value, label) => {
    requireRule(plainObject(value), `${label} must contain item and table lists.`);
    const result = {};
    for (const field of ["items", "tables"]) {
      requireRule(Array.isArray(value[field]) && value[field].length <= 100, `${label}: use at most 100 ${field}.`);
      references += value[field].length;
      result[field] = value[field].map(entry => {
        requireRule(plainObject(entry) && reference(entry.uuid), `${label} contains an invalid reward reference.`);
        const randomQuantity = field === "items" && entry.randomQuantity === true;
        requireRule(entry.randomQuantity === undefined || typeof entry.randomQuantity === "boolean",
          `${label} contains an invalid quantity mode.`);
        requireRule(field === "items" || !entry.randomQuantity, "Roll tables must use a fixed number of draws.");
        // Fixed quantity is retained when switching an item to a random range.
        requireRule(integer(entry.quantity, 1, field === "tables" ? 20 : 999),
          `${label}: quantities must be whole numbers from 1 to ${field === "tables" ? 20 : 999}.`);
        const result = { uuid: entry.uuid, quantity: entry.quantity };
        if (field === "items") {
          result.randomQuantity = randomQuantity;
          const validRange = integer(entry.minQuantity, 0, 999) && integer(entry.maxQuantity, 0, 999)
            && entry.minQuantity <= entry.maxQuantity;
          if (randomQuantity) requireRule(validRange,
            `${label}: each item range must use whole numbers from 0 to 999, with Min no greater than Max.`);
          if (validRange) {
            result.minQuantity = entry.minQuantity;
            result.maxQuantity = entry.maxQuantity;
          }
        }
        return result;
      });
    }
    result.currency = validateCurrencyEntries(value.currency === undefined ? [] : value.currency, label);
    references += result.currency.length;
    return result;
  };
  for (const key of ["base", "mishap", "criticalRewards"]) rules[key] = source(rules[key], key);
  rules.thresholds = rules.thresholds.map(tier => {
    requireRule(plainObject(tier) && integer(tier.above, -99, 999) && typeof tier.double === "boolean",
      "Each threshold needs a whole-number total from -99 to 999 and a valid doubling setting.");
    return { above: tier.above, double: tier.double, ...source(tier, "Threshold") };
  });
  requireRule(references <= 500, "Use at most 500 reward references across all sections.");
  return rules;
}

export function validateState(state) {
  requireRule(plainObject(state) && integer(state.harvests, 0, Number.MAX_SAFE_INTEGER - 1)
    && integer(state.failures, 0, Number.MAX_SAFE_INTEGER - 1)
    && Number.isSafeInteger(state.harvests + state.failures) && typeof state.locked === "boolean"
    && [undefined, null, "success", "critical", "mishap", "failure"].includes(state.lastOutcome),
  "The saved harvest progress is invalid. Ask the GM to review or reset it.");
  return { harvests: state.harvests, failures: state.failures, locked: state.locked, lastOutcome: state.lastOutcome ?? null };
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
