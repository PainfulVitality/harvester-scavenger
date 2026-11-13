// Match the system classification, never the displayed item name or proficiency alone.
export function matchingTool(actor, key) {
  if (!CONFIG.DND5E.tools[key]) return null;
  return actor?.items?.find(item => item.type === "tool"
    && item.system.type?.baseItem === key && item.system.quantity > 0) ?? null;
}

export function toolLabel(key) {
  return dnd5e.documents.Trait.keyLabel(key, { trait: "tool" }) ?? key;
}

export function checkKey(rules) {
  return rules.mode === "skill" ? rules.skill : rules.mode === "tool" ? rules.tool : rules.ability;
}
