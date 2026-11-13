// Generated labels only. Document names, descriptions, identifiers and macro arguments stay intact.
export function nodeText(text, lootMode = false) {
  if (!lootMode) return text;
  const words = { harvest: "loot", harvests: "loot attempts", harvested: "looted",
    harvesting: "looting", harvestable: "lootable", harvester: "looter", harvesters: "looters" };
  return text.replace(/\bone harvest\b/g, "one loot attempt")
    .replace(/\b(harvestable|harvesters|harvester|harvesting|harvested|harvests|harvest)\b/gi, word => {
    const replacement = words[word.toLowerCase()];
    return word === word.toUpperCase() ? replacement.toUpperCase()
      : word[0] === word[0].toUpperCase() ? replacement[0].toUpperCase() + replacement.slice(1) : replacement;
  });
}
