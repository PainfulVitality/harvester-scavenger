import { matchingTool } from "./tools.mjs";

/** Enumerate the current d20 distribution without rolling dice or changing documents. */
export function checkFailureChance(dc, modifier, {
  naturalOne = "none", alternateTwenty = false, advantage = false, disadvantage = false,
  minimum = 1, maximum = 20, halflingLucky = false, reliableTalent = false
} = {}) {
  if (!Number.isFinite(dc) || !Number.isFinite(modifier)) return null;
  if (minimum === -Infinity || minimum == null) minimum = 1;
  if (maximum === Infinity || maximum == null) maximum = 20;
  if (reliableTalent) minimum = Math.max(minimum, 10);
  if (!Number.isInteger(minimum) || !Number.isInteger(maximum) || minimum < 1 || maximum > 20 || minimum > maximum) return null;
  const base = halflingLucky ? 400 : 20;
  const count = natural => halflingLucky ? natural === 1 ? 1 : 21 : 1;
  const mode = Boolean(advantage) === Boolean(disadvantage) ? 0 : advantage ? 1 : -1;
  const total = mode ? base * base : base;
  let failures = 0;
  let cumulative = 0;
  for (let natural = 1; natural <= 20; natural++) {
    const weight = count(natural);
    const ways = mode === 1 ? (cumulative + weight) ** 2 - cumulative ** 2
      : mode === -1 ? (base - cumulative) ** 2 - (base - cumulative - weight) ** 2 : weight;
    cumulative += weight;
    const result = Math.min(maximum, Math.max(minimum, natural)) + modifier;
    const success = natural === 1 && naturalOne === "reward" ? true
      : natural === 1 && ["fail", "lock"].includes(naturalOne) ? false
      : natural === 20 && alternateTwenty ? true : result >= dc;
    if (!success) failures += ways;
  }
  return failures / total;
}

export function failureTone(chance) {
  if (!Number.isFinite(chance) || chance < 0 || chance > 1) return "";
  if (chance >= 0.9) return "red";
  if (chance >= 0.7) return "orange";
  if (chance <= 0.25) return "green";
  return "";
}

function getProperty(object, path) {
  return path.split(".").reduce((value, key) => value?.[key], object);
}

/** Foundry normally substitutes zero for missing formula references; an estimate must not. */
function resolvedFormula(formula, data, visited = new Set()) {
  if (typeof formula !== "string" || formula.length > 10000) return false;
  for (const [, path] of formula.matchAll(/@([a-zA-Z0-9_.]+)/g)) {
    if (visited.has(path) || visited.size >= 20) return false;
    const value = getProperty(data, path);
    if (typeof value === "number") { if (!Number.isFinite(value)) return false; }
    else if (typeof value === "string" && value.trim()) {
      if (!resolvedFormula(value, data, new Set([...visited, path]))) return false;
    } else return false;
  }
  return true;
}

function checkProfile(actor, check) {
  const system = actor.system;
  const fields = system?.schema?.getField("rolls.ability.check")?.constructor;
  if (typeof fields?.combineFields !== "function" || typeof actor.getRollData !== "function") return null;
  const type = check.mode;
  let relevant, ability, tool;
  if (type === "ability") {
    ability = check.key;
    relevant = system.abilities?.[ability]?.check;
  } else if (type === "skill") {
    relevant = system.skills?.[check.key];
    ability = relevant?.ability ?? CONFIG.DND5E.skills[check.key]?.ability;
  } else if (type === "tool") {
    tool = matchingTool(actor, check.key);
    if (!tool) return null;
    relevant = system.tools?.[check.key];
    ability = tool.system.ability || relevant?.ability || CONFIG.DND5E.tools[check.key]?.ability || "int";
  } else return null;
  if (!ability || !system.abilities?.[ability] || (type !== "tool" && !relevant)) return null;
  const process = { [type]: check.key, ability,
    ...(tool ? { item: tool, bonus: tool.system.bonus, prof: tool.system.prof } : {}) };
  const calculate = globalThis.dnd5e?.dataModels?.actor?.CommonTemplate?.calculateSkillToolProficiency;
  if (type !== "ability" && typeof calculate !== "function") return null;
  const prof = type === "ability" ? relevant.prof : calculate(actor, ability, process);
  if (!prof || !Number.isFinite(prof.multiplier)) return null;
  const rollData = actor.getRollData({ roll: true });
  rollData.roll = { ...rollData.roll, ability, proficient: prof?.multiplier >= 1,
    type: type === "ability" ? "ability" : type, ...(type === "ability" ? {} : { [type]: check.key }) };
  const paths = [`abilities.${ability}.check.roll`, "rolls.ability.check"];
  if (type !== "ability") paths.push(`rolls.ability.${type}`, `${type}s.${check.key}.roll`);
  const options = fields.combineFields(system, paths, { rules: { category: "check", actor, rollData } });
  let config;
  if (type === "ability") {
    config = CONFIG.Dice.D20Roll.constructParts({ mod: system.abilities[ability].mod,
      prof: prof?.hasProficiency ? prof.term : null, ruleBonus: options.bonus }, rollData);
    actor.addConditionRollReduction(config.parts, config.data);
  } else {
    if (typeof actor._buildSkillToolConfig !== "function") return null;
    const host = type === "skill" && actor.isPolymorphed && actor.flags?.dnd5e?.transformOptions?.mergeSkills
      ? game.actors.get(actor.flags.dnd5e.originalActor) : null;
    config = {};
    actor._buildSkillToolConfig(type, host, process, config);
    if (Object.keys(config.options ?? {}).some(key => !["minimum", "maximum", "advantage", "disadvantage"].includes(key))) return null;
    Object.assign(options, { minimum: config.options?.minimum ?? options.minimum,
      maximum: config.options?.maximum ?? options.maximum,
      advantage: Boolean(options.advantage || config.options?.advantage),
      disadvantage: Boolean(options.disadvantage || config.options?.disadvantage) });
  }
  if (!Array.isArray(config.parts) || !config.parts.length) return null;
  const formula = config.parts.join(" + ");
  if (!resolvedFormula(formula, config.data)) return null;
  const roll = new Roll(formula, config.data);
  if (!roll.isDeterministic) return null;
  const modifier = roll.evaluateSync().total;
  if (!Number.isFinite(modifier)) return null;
  return { modifier, ...options, halflingLucky: actor.getFlag("dnd5e", "halflingLucky") === true,
    reliableTalent: type !== "ability" && relevant?.value >= 1 && Boolean(actor.getFlag("dnd5e", "reliableTalent")) };
}

export function dcTone(actor, check) {
  try {
    if (!actor || !check || check.mode === "free") return "";
    const profile = checkProfile(actor, check);
    if (!profile) return "";
    return failureTone(checkFailureChance(check.dc, profile.modifier, { ...check.chanceRules, ...profile }));
  } catch {
    // Missing, random, malformed or custom-system data must restore the normal gold appearance.
    return "";
  }
}
