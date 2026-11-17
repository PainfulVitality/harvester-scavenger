import { ID } from "./rules.mjs";

const nameplateDefaults = {
  harvestReadyLabel: "Harvestable", harvestFailedLabel: "Fumbled", harvestDepletedLabel: "Harvested",
  lootReadyLabel: "Lootable", lootFailedLabel: "Fumbled", lootDepletedLabel: "Looted"
};

export function windowOutcomeMessage(outcome, fallback) {
  const key = outcome === "failure" ? "failureMessage" : "successMessage";
  const text = game.settings.get(ID, key);
  return typeof text === "string" && text.trim() ? text.trim() : fallback;
}

export function statusNameplateText(status, lootMode = false) {
  const state = status === "depleted" ? "Depleted" : status === "locked" ? "Failed" : "Ready";
  const key = `${lootMode ? "loot" : "harvest"}${state}Label`;
  const text = game.settings.get(ID, key);
  return typeof text === "string" && text.trim() ? text.trim() : nameplateDefaults[key];
}

export function refreshStatusNameplate(token) {
  if (game.modules.get("token-nameplates")?.active && typeof token.refreshNameplates === "function") {
    try {
      token.refreshNameplates(true)?.catch?.(error => console.debug(`${ID} | Optional nameplate refresh was unavailable`, error));
    }
    catch (error) { console.debug(`${ID} | Optional nameplate refresh was unavailable`, error); }
  }
}

export function registerPresentationSettings(onRefresh) {
  for (const [key, name, hint] of [
    ["successMessage", "Success Message", "Text shown in the harvest or loot window after a success, including when fully depleted. Leave empty to use the default message for each state."],
    ["failureMessage", "Failure Message", "Text shown in the harvest or loot window after a failure. Leave empty to use the default message."]
  ]) {
    game.settings.register(ID, key, {
      name, hint, scope: "world", config: true, type: String, default: "", onChange: onRefresh
    });
  }
  const names = {
    harvestReadyLabel: "Harvest Nameplate: Available", harvestFailedLabel: "Harvest Nameplate: Failed",
    harvestDepletedLabel: "Harvest Nameplate: Depleted", lootReadyLabel: "Loot Nameplate: Available",
    lootFailedLabel: "Loot Nameplate: Failed", lootDepletedLabel: "Loot Nameplate: Depleted"
  };
  for (const [key, defaultText] of Object.entries(nameplateDefaults)) {
    game.settings.register(ID, key, {
      name: names[key], hint: `Status text shown by Token Nameplates. Leave empty to use “${defaultText}”.`,
      scope: "world", config: Boolean(game.modules.get("token-nameplates")?.active),
      type: String, default: defaultText,
      onChange: () => {
        if (!game.modules.get("token-nameplates")?.active) return;
        for (const token of canvas?.tokens?.placeables ?? []) refreshStatusNameplate(token);
      }
    });
  }
}
