import { getHarvestStatus } from "./appearance.mjs";
import { isHarvest, usesLootWording } from "./store.mjs";
import { ID } from "./rules.mjs";
import { nodeText } from "./wording.mjs";

const plateId = `${ID}-status`;
const managed = new WeakSet();
let registered = false;

function plate(value, position, sort, style) {
  return { id: `${plateId}-${position}`, enabled: true, value, position, sort,
    display: "default", autoAnchor: true, anchor: { x: 0.5, y: 0 },
    padding: { x: 0, y: 0 }, align: "center", angle: 0, alpha: 1,
    fontDispositionColor: false, style };
}

function registerIntegration() {
  if (registered || !game.modules.get("token-nameplates")?.active
    || typeof CONFIG.Token.objectClass.prototype.getNameplateFlags !== "function") return;
  libWrapper.register(ID, "CONFIG.Token.objectClass.prototype.getNameplateFlags", function (wrapped, ...args) {
    const original = wrapped(...args);
    if (!isHarvest(this.document) || getHarvestStatus(this.document) === "blocked") {
      if (managed.has(this)) {
        // Nameplates hides these when its configuration is enabled; restore the native labels on removal.
        if (this.nameplate) this.nameplate.renderable = true;
        if (this.tooltip) this.tooltip.renderable = true;
        managed.delete(this);
      }
      return original;
    }
    const status = getHarvestStatus(this.document);
    const config = foundry.utils.deepClone(original);
    managed.add(this);
    if (!config.enabled) {
      // Preserve native name/elevation behavior rather than activating the user's disabled custom plates.
      const nativeStyle = text => {
        const style = text?.style ?? CONFIG.canvasTextStyle;
        return Object.fromEntries(["fontFamily", "fontSize", "fontWeight", "fontStyle", "fill", "stroke", "strokeThickness",
          "dropShadow", "dropShadowColor", "dropShadowAlpha", "dropShadowBlur", "dropShadowAngle", "dropShadowDistance"]
          .filter(key => style[key] !== undefined).map(key => [key, style[key]]));
      };
      config.nameplates = [plate("{name}", "bottom", 0, nativeStyle(this.nameplate)),
        plate("{tooltip}", "top", 0, nativeStyle(this.tooltip))];
    }
    config.enabled = true;
    config.nameplates = (config.nameplates ?? []).filter(entry => entry.id !== plateId);
    const bottom = config.nameplates.filter(entry => entry.position === "bottom");
    const sort = Math.max(0, ...bottom.map(entry => Number(entry.sort) || 0)) + 1;
    const primary = config.nameplates.find(entry => /\{(?:name|actor\.name)\}/.test(entry.value ?? ""))
      ?? bottom.toSorted((a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0))[0];
    const baseStyle = bottom[0]?.style ?? {};
    const text = status === "depleted" ? "Harvested" : status === "locked" ? "Fumbled" : "Harvestable";
    const fill = status === "depleted" ? "#9297a3" : status === "locked" ? "#e38b95" : "#d6e6da";
    config.nameplates.push({ ...plate(nodeText(text, usesLootWording(this.document)), "bottom", sort,
      { fontFamily: baseStyle.fontFamily ?? CONFIG.canvasTextStyle.fontFamily, fontSize: 14,
        fill, stroke: "#202328", strokeThickness: 2, align: "center" }), id: plateId, display: primary?.display ?? "default" });
    return config;
  }, "WRAPPER");
  registered = true;
}

export function initializeNameplates() {
  Hooks.on("canvasConfig", registerIntegration);
  Hooks.once("ready", registerIntegration);
}
