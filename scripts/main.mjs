import { ID } from "./rules.mjs";
import { DEFAULT_RECIPE, cleanDeletedHarvest, isHarvest, isDefeated, canInteractHarvest, requiresDefeat, usesLootWording } from "./store.mjs";
import { nodeText } from "./wording.mjs";
import { initializeNameplates } from "./nameplates.mjs";
import { initializeAuthority } from "./authority.mjs";
import { initializeAppearance, setHarvestAppearance } from "./appearance.mjs";
import { HarvestConfig, closeHarvest, openConfig, openHarvest, refreshHarvest, refreshInteractions } from "./windows.mjs";

function renderHarvestHUD(hud, html) {
  const token = hud.object?.document;
  if (!game.user.isGM || !token?.actor || !isHarvest(token)) return;
  const column = html.querySelector(".col.right");
  if (!column || column.querySelector(".harvest-hud")) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "control-icon harvest-hud";
  button.setAttribute("aria-label", nodeText("Harvest Settings", usesLootWording(token)));
  button.setAttribute("data-tooltip", "");
  button.innerHTML = '<i class="fa-solid fa-leaf" inert></i>';
  button.addEventListener("click", event => {
    event.stopPropagation();
    openConfig(token);
  });
  column.append(button);
}

function harvestHeaderControl(app, controls) {
  let subject = app.document;
  if (subject?.documentName === "Actor") {
    subject = subject.isToken ? subject.token : game.actors.get(subject.id) === subject ? subject : null;
  }
  if (!["Actor", "Token"].includes(subject?.documentName) || controls.some(control => control.action === "configureHarvestTemplate")) return;
  controls.unshift({
    label: nodeText("Harvest Settings", usesLootWording(subject)),
    action: "configureHarvestTemplate",
    icon: "fa-solid fa-leaf",
    onClick: () => openConfig(subject)
  });
}

Hooks.once("init", () => {
  if (game.system.id !== "dnd5e") return;
  Handlebars.registerHelper("harvestText", (text, lootMode) => nodeText(text, lootMode === true));
  game.settings.registerMenu(ID, "configureDefaults", {
    name: "Harvest Defaults",
    label: "Configure Harvest Defaults",
    hint: "Set the starting rules and rewards for new harvests and actor templates.",
    icon: "fa-solid fa-leaf",
    type: HarvestConfig,
    restricted: true
  });
  game.settings.register(ID, DEFAULT_RECIPE, { scope: "world", config: false, type: String, default: "" });
  game.settings.register(ID, "interactionDistance", {
    name: "Interaction Distance",
    hint: "Maximum distance in grid units, measured between token edges. Set 0 for unlimited range. Each harvest can override this setting.",
    scope: "world", config: true, type: Number, default: 2,
    range: { min: 0, step: 1 },
    onChange: () => refreshInteractions()
  });
  game.settings.register(ID, "previewPermission", {
    name: "Reward Preview Access",
    hint: "Choose how much of a revealed reward's read-only item sheet players can inspect.",
    scope: "world", config: true, type: Number, default: 2,
    choices: { 1: "Limited", 2: "Observer" }
  });
  game.settings.register(ID, "doubleCritical", {
    name: "Double Harvest Rewards on a Natural 20",
    hint: "Double the rewards on a successful harvest check when the kept d20 shows 20. Each harvest can override this setting.",
    scope: "world", config: true, type: Boolean, default: false
  });
  game.settings.register(ID, "automaticFailure", {
    name: "Fail All Remaining Harvests on a Natural 1",
    hint: "A natural 1 turns every remaining harvest into a failed harvest and locks the node. Each node can override this setting.",
    scope: "world", config: true, type: Boolean, default: true
  });
});

Hooks.once("socketlib.ready", () => {
  if (game.system.id === "dnd5e") initializeAuthority((uuid, status) => {
    setHarvestAppearance(uuid, status);
    refreshHarvest(uuid);
  });
});

Hooks.once("setup", () => {
  if (game.system.id !== "dnd5e") return;
  initializeAppearance(refreshHarvest);
  initializeNameplates();
  libWrapper.register(ID, "CONFIG.Token.objectClass.prototype._canView", function (wrapped, user, event) {
    if (!user.isGM && isHarvest(this.document) && requiresDefeat(this.document) && !isDefeated(this.document)) return false;
    if (!user.isGM && canInteractHarvest(this.document) && !this.document.hidden && !this.document.isSecret && this.isVisible && this.layer.active
      && !canvas.regions._placementContext && !this.layer._draggedToken && !canvas.controls.ruler.active
      && !(CONFIG.Canvas.rulerClass.canMeasure && event?.type === "pointerdown")) return true;
    return wrapped(user, event);
  }, "MIXED");
  libWrapper.register(ID, "CONFIG.Token.objectClass.prototype._onClickLeft2", function (wrapped, event, ...args) {
    if (!game.user.isGM && isHarvest(this.document) && requiresDefeat(this.document) && !isDefeated(this.document)) {
      event.stopPropagation();
      return;
    }
    if (!canInteractHarvest(this.document) || (game.user.isGM && event.altKey)) return wrapped(event, ...args);
    event.stopPropagation();
    return openHarvest(this.document);
  }, "MIXED");

  Hooks.on("renderTokenHUD", renderHarvestHUD);
  Hooks.on("getActorContextOptions", (directory, options) => {
    if (!game.user.isGM || directory.collection !== game.actors) return;
    const getActor = entry => directory.collection.get(entry.dataset.entryId ?? entry.dataset.documentId);
    for (const lootMode of [false, true]) options.push({
      label: nodeText("Configure Harvest Template", lootMode), icon: "fa-solid fa-leaf",
      visible: entry => Boolean(getActor(entry)?.prototypeToken) && usesLootWording(getActor(entry)) === lootMode,
      onClick: (_event, entry) => openConfig(getActor(entry))
    });
  });
  Hooks.on("getHeaderControlsApplicationV2", (app, controls) => {
    if (game.user.isGM) harvestHeaderControl(app, controls);
  });
  Hooks.on("updateToken", (token, changes) => {
    if (changes.flags?.[ID] || changes.name !== undefined || changes.hidden !== undefined) refreshHarvest(token.uuid);
    if (changes.flags?.[ID] && canvas.hud?.token?.object?.document === token) canvas.hud.token.render({ force: true });
    if (["x", "y", "width", "height", "hidden", "actorId", "actorLink"].some(key => Object.hasOwn(changes, key))) {
      refreshInteractions(token.parent.id);
    }
  });
  Hooks.on("deleteToken", token => {
    closeHarvest(token.uuid);
    if (game.users.activeGM?.isSelf) cleanDeletedHarvest(token);
  });
  Hooks.on("updateActor", (actor, changes) => {
    if (changes.system || changes.items) refreshInteractions();
    if (!changes.ownership) return;
    refreshHarvest(actor.uuid);
    for (const token of canvas?.scene?.tokens ?? []) {
      if (token.actor?.uuid === actor.uuid || (!actor.isToken && token.actorId === actor.id)) refreshHarvest(token.uuid);
    }
  });
  for (const hook of ["createItem", "updateItem", "deleteItem"]) {
    Hooks.on(hook, item => { if (item.parent?.documentName === "Actor") refreshInteractions(); });
  }
  Hooks.on("deleteActor", actor => {
    closeHarvest(actor.uuid);
    if (game.users.activeGM?.isSelf) cleanDeletedHarvest(actor);
  });
  Hooks.on("canvasTearDown", canvas => canvas.scene?.tokens.forEach(token => closeHarvest(token.uuid)));
  game.modules.get(ID).api = {
    open: token => openHarvest(token.document ?? token),
    configure: subject => openConfig(subject.document ?? subject)
  };
});
