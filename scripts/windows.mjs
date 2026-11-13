import { matchingTool, toolLabel } from "./tools.mjs";
import { ID, normalizeRules } from "./rules.mjs";
import { getRecipeId, isHarvest, readHarvest, removeHarvest, saveRules } from "./store.mjs";
import { configureNode, request } from "./authority.mjs";
import { lookup, referenceRows } from "./rewards.mjs";
import { canConfigure, distanceWarning, gridDistance, inRange, interactionDistance } from "./interaction.mjs";
import { nodeText } from "./wording.mjs";
import { renderRewardPreview } from "./preview.mjs";

const { ApplicationV2, HandlebarsApplicationMixin, DialogV2 } = foundry.applications.api;
const BaseWindow = HandlebarsApplicationMixin(ApplicationV2);
const template = name => `modules/${ID}/templates/${name}.hbs`;
const playerWindows = new Map();
const configWindows = new Map();

const checkLabel = (mode, key) => {
  if (mode === "free") return "Free harvest";
  if (mode === "tool") return toolLabel(key);
  const config = mode === "skill" ? CONFIG.DND5E.skills : CONFIG.DND5E.abilities;
  return game.i18n.localize(config[key]?.label ?? key);
};

function report(error) {
  ui.notifications.warn(error.message);
}

function actorChoices(target, distance) {
  const choices = new Map();
  const controlled = canvas.tokens?.controlled ?? [];
  const placeables = [...(canvas.tokens?.placeables ?? [])].sort((first, second) =>
    gridDistance(first.document, target) - gridDistance(second.document, target));
  for (const token of [...controlled, ...placeables]) {
    if (!token.actor?.isOwner || token.document.hidden || isHarvest(token.document) || token.actor.uuid === target.actor?.uuid
      || !inRange(token.document, target, distance)) continue;
    if ((!game.user.isGM || controlled.includes(token) || token.actor.type === "character") && !choices.has(token.actor.uuid)) {
      choices.set(token.actor.uuid, { uuid: token.document.uuid, name: token.name, img: token.actor.img });
    }
  }
  const assigned = game.user.character;
  const worldActors = game.user.isGM ? game.actors.filter(actor => actor.type === "character" || actor === assigned)
    : distance === Infinity ? game.actors : [];
  for (const actor of worldActors) {
    if (!actor?.isOwner || actor.uuid === target.actor?.uuid || choices.has(actor.uuid)) continue;
    choices.set(actor.uuid, { uuid: actor.uuid, name: actor.name, img: actor.img });
  }
  const selected = controlled.find(token => choices.has(token.actor?.uuid))?.actor ?? assigned;
  return { choices: [...choices.values()], preferred: choices.get(selected?.uuid)?.uuid };
}

const rewardFields = { items: "Item", tables: "RollTable" };
const configurationLabels = {
  defaults: { title: "Harvest Defaults", save: "Save Defaults", remove: "Restore Factory Defaults" },
  Actor: { title: "Configure Harvest Template", save: "Save Template", remove: "Remove Template" },
  Token: { title: "Configure Harvest", save: "Save Harvest", remove: "Remove" }
};

export class HarvestConfig extends BaseWindow {
  static DEFAULT_OPTIONS = {
    classes: ["harvest-window", "harvest-config"],
    position: { width: 580, height: "auto" },
    window: { resizable: true },
    actions: {
      chooseSection: function (_event, target) {
        const tab = { settings: "rules", rewards: "rewards", bonuses: "bonuses" }[target.dataset.section];
        if (!tab || this.saving) return;
        this.tab = tab;
        return this.redraw();
      },
      chooseTab: function (_event, target) { this.tab = target.dataset.tab; return this.redraw(); },
      addTier: function () {
        this.draft.thresholds.push({ above: 19, double: false, items: [], tables: [] });
        return this.redraw();
      },
      removeTier: function (_event, target) {
        this.draft.thresholds.splice(Number(target.dataset.index), 1);
        return this.redraw();
      },
      removeReference: function (_event, target) {
        const { field, index } = target.dataset;
        if (field === "macro") this.draft.macro = null;
        else foundry.utils.getProperty(this.draft, field).splice(Number(index), 1);
        return this.redraw();
      },
      save: function () { return this.save(); },
      unlock: function () { return this.manage("unlock"); },
      reset: function () { return this.manage("reset"); },
      remove: function () { return this.manage("remove"); }
    }
  };

  static PARTS = { body: { template: template("shell"), scrollable: [".harvest-content"] } };

  constructor(subject = null, data = null, options = {}) {
    const scope = subject?.documentName ?? "defaults";
    const labels = configurationLabels[scope];
    const id = subject ? `${ID}-config-${scope.toLowerCase()}-${subject.id}` : `${ID}-defaults`;
    super(foundry.utils.mergeObject({ id, window: { title: labels.title } }, options));
    this.subject = subject;
    this.scope = scope;
    this.labels = labels;
    if (data) this.loadDraft(data);
    this.tab = "rules";
  }

  loadDraft({ rules, state, enabled }) {
    this.draft = normalizeRules(foundry.utils.deepClone(rules));
    this.draft.distance ??= null;
    this.progress = state;
    this.harvestEnabled = Boolean(enabled);
  }

  async _prepareContext() {
    const context = await this._prepareConfigContext();
    return { content: await foundry.applications.handlebars.renderTemplate(template("config"), context),
      lootMode: context.lootMode, showTabs: true, configurationOnly: true,
      isSettings: this.tab === "rules", isRewards: this.tab === "rewards", isBonuses: this.tab === "bonuses", pending: this.saving };
  }

  async _prepareConfigContext() {
    if (!this.draft) this.loadDraft(game.user.isGM ? await readHarvest(this.subject)
      : await request("configuration", this.subject));
    const subject = this.subject;
    const rules = this.draft;
    const lootMode = Boolean(rules.lootMode);
    this.options.window.title = nodeText(this.labels.title, lootMode);
    const options = (source, selected) => Object.entries(source).map(([value, entry]) => ({
      value, label: nodeText(game.i18n.localize(entry.label ?? entry), lootMode), selected: value === selected
    }));
    const source = async (data, field) => ({
      groups: await Promise.all(Object.entries(rewardFields).map(async ([key, type]) => ({
        field: `${field}.${key}`, type, name: key === "items" ? "Items" : "Roll Tables",
        rows: await referenceRows(data[key], type)
      })))
    });
    return {
      rules, lootMode, state: this.progress,
      sectionTitle: this.tab === "rewards" ? "Rewards" : this.tab === "bonuses" ? "Roll Outcomes" : nodeText("Harvest Settings", lootMode),
      labels: Object.fromEntries(Object.entries(this.labels).map(([key, value]) => [key, nodeText(value, lootMode)])), subjectName: subject?.name,
      namePlaceholder: subject?.name ?? "Use the actor or token name",
      img: this.scope === "Actor" ? subject.img : subject?.actor?.img ?? subject?.texture.src,
      existing: game.user.isGM && Boolean(getRecipeId(subject)),
      canReset: game.user.isGM && (this.progress.harvests || this.progress.failures),
      canUnlock: game.user.isGM && this.progress.locked,
      canEditMacro: game.user.isGM,
      useWorldDistance: rules.distance === null,
      worldDistance: game.settings.get(ID, "interactionDistance") || "Unlimited",
      isDefaults: this.scope === "defaults", isTemplate: this.scope === "Actor",
      harvestEnabled: this.harvestEnabled,
      isRules: this.tab === "rules", isRewards: this.tab === "rewards", isBonuses: this.tab === "bonuses",
      modes: options({ skill: "Skill Check", ability: "Ability Check", tool: "Tool Check", free: "Free Harvest" }, rules.mode),
      skills: options(CONFIG.DND5E.skills, rules.skill), abilities: options(CONFIG.DND5E.abilities, rules.ability),
      tools: options(Object.fromEntries(Object.keys(CONFIG.DND5E.tools).map(key => [key, toolLabel(key)])), rules.tool),
      isTool: rules.mode === "tool", isChecked: rules.mode !== "free",
      isSkill: rules.mode === "skill", isAbility: rules.mode === "ability",
      critical: options({ world: "Use World Setting", yes: "Double Rewards", no: "Standard Rewards", reward: "Alternate Rewards" }, rules.critical),
      naturalOne: options({
        world: "Use World Setting", none: "Do Nothing", fail: "Force Failure",
        lock: "Fail All Remaining Harvests", reward: "Alternate Rewards"
      }, rules.naturalOne),
      worldCritical: game.settings.get(ID, "doubleCritical") ? "on" : "off",
      worldNaturalOne: nodeText(game.settings.get(ID, "automaticFailure") ? "Fail all remaining harvests" : "Do nothing", lootMode),
      macroClients: options({ gm: "GM Client", player: "Harvester’s Client" }, rules.macroClient ?? "gm"),
      base: this.tab === "rewards" ? await source(rules.base, "base") : null,
      macro: this.tab === "rewards" ? await lookup(rules.macro, "Macro") : null,
      mishap: this.tab === "bonuses" && rules.naturalOne === "reward" ? await source(rules.mishap, "mishap") : null,
      criticalRewards: this.tab === "bonuses" && rules.critical === "reward"
        ? await source(rules.criticalRewards, "criticalRewards") : null,
      tiers: this.tab === "bonuses" ? await Promise.all(rules.thresholds.map(async (tier, index) => ({
        ...tier, index, path: `thresholds.${index}`, ...await source(tier, `thresholds.${index}`)
      }))) : []
    };
  }

  _onRender(context, options) {
    super._onRender(context, options);
    this.activateRail();
    const root = this.element.querySelector("[data-harvest-config]");
    if (!root) return;
    root.querySelector("prose-mirror > .toggle")?.setAttribute("aria-label", "Edit description");
    const read = event => {
      const element = event.target;
      if (element.hasAttribute("data-random-quantity")) {
        const entry = foundry.utils.getProperty(this.draft, element.dataset.randomQuantity);
        entry.randomQuantity = element.checked;
        entry.minQuantity ??= 1;
        entry.maxQuantity ??= entry.quantity;
        return;
      }
      if (element.hasAttribute("data-world-distance")) {
        this.draft.distance = element.checked ? null : game.settings.get(ID, "interactionDistance");
        return;
      }
      if (element.hasAttribute("data-enable-harvest")) {
        this.harvestEnabled = element.checked;
        return;
      }
      if (!element.dataset.field) return;
      if (element.type === "number" && !element.validity.valid) return;
      const value = element.type === "checkbox" ? element.checked
        : element.type === "number" ? element.value === "" ? 0 : element.valueAsNumber : element.value;
      foundry.utils.setProperty(this.draft, element.dataset.field, value);
    };
    root.addEventListener("input", read);
    root.addEventListener("change", event => {
      read(event);
      if (event.target.hasAttribute("data-refresh")) this.redraw();
    });
    for (const zone of root.querySelectorAll("[data-drop]")) {
      zone.addEventListener("dragover", event => { event.preventDefault(); zone.classList.add("drag-over"); });
      zone.addEventListener("dragleave", event => {
        if (!zone.contains(event.relatedTarget)) zone.classList.remove("drag-over");
      });
      zone.addEventListener("drop", event => {
        event.preventDefault();
        event.stopPropagation();
        zone.classList.remove("drag-over");
        this.drop(event, zone).catch(report);
      });
    }
  }

  activateRail() {
    this.element.querySelector(".harvest-tab-rail")?.addEventListener("keydown", event => {
      const keys = ["ArrowUp", "ArrowDown", "Home", "End"];
      if (!keys.includes(event.key)) return;
      event.preventDefault();
      const buttons = [...event.currentTarget.querySelectorAll("button:not(:disabled)")];
      const current = buttons.indexOf(document.activeElement);
      const index = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
        : (current + (event.key === "ArrowUp" ? -1 : 1) + buttons.length) % buttons.length;
      buttons[index]?.click();
      this.railFocus = index;
    });
    if (this.railFocus !== undefined) {
      this.element.querySelectorAll(".harvest-tab-rail button")[this.railFocus]?.focus();
      this.railFocus = undefined;
    }
  }

  captureDescription() {
    const editor = this.element?.querySelector("prose-mirror");
    if (editor && this.draft) this.draft.description = editor.value;
  }

  redraw() {
    this.captureDescription();
    return this.render();
  }

  async drop(event, zone) {
    const { type, uuid } = foundry.applications.ux.TextEditor.implementation.getDragEventData(event);
    const expected = zone.dataset.type;
    if (type !== expected || !await lookup(uuid, expected)) {
      throw new Error(`Drop a ${expected === "RollTable" ? "Roll Table" : expected} here.`);
    }
    const field = zone.dataset.drop;
    if (field === "macro") this.draft.macro = uuid;
    else {
      const list = foundry.utils.getProperty(this.draft, field);
      if (list.some(entry => entry.uuid === uuid)) throw new Error("This document is already in the list.");
      list.push({ uuid, quantity: 1 });
    }
    await this.redraw();
  }

  async save() {
    if ((this.subject ? !canConfigure(this.subject) : !game.user.isGM) || this.saving) return;
    const invalid = this.element.querySelector("input:invalid");
    if (invalid) return invalid.reportValidity();
    const sources = [this.draft.base, this.draft.mishap, this.draft.criticalRewards, ...this.draft.thresholds];
    if (sources.some(source => source.items.some(entry => entry.randomQuantity
      && (!Number.isInteger(entry.minQuantity) || !Number.isInteger(entry.maxQuantity)
        || entry.minQuantity < 0 || entry.maxQuantity < entry.minQuantity)))) {
      return report(new Error("Each item’s maximum quantity must be at least its minimum quantity."));
    }
    this.captureDescription();
    this.saving = true;
    try {
      this.draft.name = this.draft.name.trim();
      const options = { enabled: this.harvestEnabled };
      if (!game.user.isGM) await request("configuration.save", this.subject, { rules: this.draft, enabled: this.harvestEnabled });
      else if (this.scope === "Token") await configureNode(this.subject, "save", this.draft, options);
      else await saveRules(this.subject, this.draft, options);
      const message = {
        defaults: "Harvest defaults saved.",
        Actor: `Harvest template saved for ${this.subject?.name}.`,
        Token: `Harvest saved for ${this.subject?.name}.`
      }[this.scope];
      ui.notifications.info(nodeText(message, this.draft.lootMode));
      await this.onSaved();
    } catch (error) {
      report(error);
    } finally {
      this.saving = false;
      if (this.rendered) await this.render();
    }
  }

  async onSaved() {
    await this.close();
  }

  async manage(action) {
    if (!game.user.isGM || this.saving) return;
    const label = nodeText(action === "remove" ? this.labels.remove : "Reset Harvest", this.draft.lootMode);
    const removePrompt = {
      defaults: "Restore the original defaults for new harvests?",
      Actor: "Remove the harvest template from this actor?",
      Token: "Remove the harvest configuration and progress from this token?"
    }[this.scope];
    if (action !== "unlock" && !await DialogV2.confirm({
      window: { title: label },
      content: nodeText(action === "reset"
        ? "<p>Restore every harvest and clear failed harvests for this token?</p>"
        : `<p>${removePrompt}</p>`, this.draft.lootMode),
      rejectClose: false
    })) return;
    this.captureDescription();
    this.saving = true;
    try {
      if (this.scope === "Token") {
        await configureNode(this.subject, action);
        if (action === "remove") return await this.close();
        this.progress = (await readHarvest(this.subject)).state;
      } else {
        await removeHarvest(this.subject);
        if (this.subject) return await this.close();
        this.loadDraft(await readHarvest());
        this.tab = "rules";
      }
    } catch (error) {
      report(error);
    } finally {
      this.saving = false;
      if (this.rendered) await this.render();
    }
  }

  _onClose(options) {
    if (this.subject && configWindows.get(this.subject.uuid) === this) configWindows.delete(this.subject.uuid);
    super._onClose(options);
  }
}

class HarvestWindow extends HarvestConfig {
  static DEFAULT_OPTIONS = {
    classes: ["harvest-window"],
    position: { width: 550, height: "auto" },
    window: {
      resizable: true,
      controls: [{ action: "configure", icon: "fa-solid fa-gear", label: "Settings", visible: () => game.user.isGM }]
    },
    actions: {
      harvest: function (event) { return this.attempt(event); },
      inspectReward: async function (_event, target) {
        try {
          const preview = await request("inspect", this.token, { reference: target.dataset.reference });
          if (game.user.isGM) {
            const source = await fromUuid(preview.uuid);
            if (source?.isOwner) return source.sheet.render({ force: true });
          }
          return renderRewardPreview(preview.item);
        } catch (error) { report(error); }
      },
      configure: function () { return this.changeSection("settings"); },
      chooseSection: function (_event, target) { return this.changeSection(target.dataset.section); },
      unlockHarvest: function () { return this.unlock(); },
      leave: function () { return this.close(); }
    }
  };

  static PARTS = { body: { template: template("shell"), scrollable: [".harvest-content"] } };

  constructor(token, data) {
    super(token, null, { id: `${ID}-view-${token.id}`, window: { title: data.name } });
    this.token = token;
    this.data = data;
    this.section = "harvest";
  }

  async _prepareContext() {
    const configurable = canConfigure(this.token);
    if (!configurable) this.section = "harvest";
    const settings = this.section !== "harvest";
    if (!settings) this.options.window.title = this.data.name;
    if (settings) this.tab = this.section === "settings" ? "rules" : this.section;
    this.element?.classList.toggle("harvest-config", settings);
    const context = settings ? await this._prepareConfigContext() : await this.harvestContext();
    return {
      content: await foundry.applications.handlebars.renderTemplate(template(settings ? "config" : "harvest"), context),
      lootMode: context.lootMode, showTabs: configurable, isHarvest: !settings, isSettings: this.section === "settings",
      isRewards: this.section === "rewards", isBonuses: this.section === "bonuses", pending: this.pending || this.saving
    };
  }

  async harvestContext() {
    const data = this.data;
    const lootMode = Boolean(data.lootMode);
    const { choices, preferred } = actorChoices(this.token, data.distance || Infinity);
    if (!choices.some(choice => choice.uuid === this.actorUuid)) {
      this.actorUuid = preferred ?? choices[0]?.uuid;
    }
    const actor = choices.find(choice => choice.uuid === this.actorUuid);
    const harvesterDocument = actor ? await fromUuid(actor.uuid) : null;
    const harvesterActor = harvesterDocument?.actor ?? harvesterDocument;
    const missingTool = data.mode === "tool" && actor && !matchingTool(harvesterActor, data.key);
    const description = await foundry.applications.ux.TextEditor.implementation.enrichHTML(data.description, {
      secrets: false, relativeTo: this.token.actor
    });
    const outcome = this.result?.outcome;
    const resultLabel = {
      failure: "Harvest Failed", success: "Success", critical: "Critical Success", mishap: "Something Happens"
    }[outcome];
    const resultIcon = {
      failure: "fa-xmark", success: "fa-check", critical: "fa-star", mishap: "fa-triangle-exclamation"
    }[outcome];
    const checked = data.mode !== "free";
    const check = checkLabel(data.mode, data.key);
    const failed = data.status === "locked"
      || (data.status === "ready" && data.failures > 0 && (outcome ?? data.lastOutcome) === "failure");
    const titles = {
      locked: "Harvest Failed", depleted: "Fully Harvested", blocked: "Not Defeated",
      ready: failed ? "Harvest Failed" : checked ? `${check} Check` : "Ready to Collect"
    };
    const help = {
      locked: "Seems like you weren't lucky this time.",
      depleted: "There is nothing left...",
      blocked: "Harvest is available only at 0 hit points or fewer.",
      ready: failed ? "Seems like you weren't lucky this time."
        : checked ? "A success will automatically add the items to your inventory." : "Items will automatically be added to your inventory."
    };
    let statusTitle = titles[data.status];
    let statusHelp = help[data.status];
    let statusIcon = { locked: "fa-xmark", depleted: "fa-box-open", blocked: "fa-heart-pulse",
      ready: failed ? "fa-xmark" : checked ? "fa-dice-d20" : "fa-hand" }[data.status];
    if (this.pending || data.busy) {
      statusTitle = this.pending ? this.phase === "rolling" ? "Waiting for Your Roll" : "Resolving" : "In Progress";
      statusHelp = this.pending ? this.phase === "rolling" ? "Complete the check in the roll dialog." : "Applying the harvest result…"
        : "Another character is harvesting this node.";
      statusIcon = "fa-spinner fa-spin";
    }
    const harvestSlots = data.harvestLimit > 0 && data.harvestLimit <= 9
      ? Array.from({ length: data.harvestLimit }, (_, index) => index < data.harvests ? "success"
        : index < data.harvests + data.failures ? "failure" : "available") : [];
    const harvestSlotGroups = [
      { state: "available", label: "Available" },
      { state: "success", label: "Successful" },
      { state: "failure", label: "Failed" }
    ].map(group => ({ ...group, slots: harvestSlots.filter(state => state === group.state) }))
      .filter(group => group.slots.length);
    return {
      ...data, lootMode, description, actor, choices,
      noActorHint: data.distance ? distanceWarning(data.distance, lootMode) : nodeText("Select a token you own or assign a character to harvest.", lootMode),
      check: nodeText(check, lootMode), checked, statusTitle: nodeText(statusTitle, lootMode), statusHelp: nodeText(statusHelp, lootMode), statusIcon,
      harvestSlots, harvestSlotGroups,
      progressLabel: nodeText(`${data.remaining ?? "Unlimited"} harvests remaining; ${data.harvests} successful; ${data.failures} failed.`, lootMode),
      cardOutcome: failed ? "failure" : data.status === "depleted" ? "success" : "",
      showDC: checked && data.status === "ready" && !this.pending && !data.busy,
      canUnlock: game.user.isGM && data.status === "locked",
      managing: this.managing,
      showFailures: data.failures > 0,
      remaining: data.remaining ?? "Unlimited",
      requirementId: `${this.id}-tool-requirement`,
      missingTool: missingTool ? `${actor.name} needs ${check} in their inventory to make this check.` : null,
      pending: this.pending, disabled: this.pending || data.busy || data.status !== "ready" || !actor || missingTool,
      button: this.pending ? this.phase === "rolling" ? "Waiting for roll…" : "Resolving…" : data.busy ? "In progress" : data.status === "locked" ? "Failed"
        : data.status === "blocked" ? "Not defeated" : data.status === "depleted" ? "Nothing left" : missingTool ? "Tool required" : data.mode === "free" ? "Collect" : `${failed ? "Retry" : "Roll"} ${check}`,
      result: this.result, resultLabel: nodeText(resultLabel ?? "", lootMode), resultIcon
    };
  }

  _onRender(context, options) {
    super._onRender(context, options);
    this.element.classList.toggle("harvest-config", this.section !== "harvest");
    for (const link of this.element.querySelectorAll('[data-action="inspectReward"]')) {
      link.addEventListener("keydown", event => {
        if (!["Enter", " "].includes(event.key)) return;
        event.preventDefault();
        link.click();
      });
    }
    this.element.querySelector("[data-harvester]")?.addEventListener("change", event => {
      this.actorUuid = event.target.value;
      this.render();
    });
  }

  async changeSection(section) {
    if (!["harvest", "rewards", "bonuses", "settings"].includes(section)
      || this.pending || this.saving || (section !== "harvest" && !canConfigure(this.token))) return;
    this.captureDescription();
    this.section = section;
    await this.render();
  }

  async onSaved() {
    if (!isHarvest(this.token)) return this.close();
    this.draft = null;
    this.section = "harvest";
    await this.refresh();
  }

  async refresh() {
    if (this.pending || this.managing || !this.rendered) return;
    if (!isHarvest(this.token)) return this.close();
    const revision = this.refreshRevision = (this.refreshRevision ?? 0) + 1;
    try {
      this.captureDescription();
      const data = await request("view", this.token);
      if (revision !== this.refreshRevision || this.pending || this.managing || !this.rendered) return;
      if (data.failures < this.data.failures || data.harvests < this.data.harvests) this.result = null;
      this.data = data;
      if (this.rendered && !this.pending) await this.render();
    } catch (error) {
      if (revision !== this.refreshRevision || this.pending || this.managing || !this.rendered) return;
      await this.close();
      report(error);
    }
  }

  async unlock() {
    if (!game.user.isGM || this.managing) return;
    this.refreshRevision = (this.refreshRevision ?? 0) + 1;
    this.managing = true;
    await this.render();
    try {
      this.data = await request("unlock", this.token);
      this.result = null;
    } catch (error) {
      report(error);
    } finally {
      this.managing = false;
      if (this.rendered) await this.render();
    }
  }

  async attempt(event) {
    if (this.pending || this.saving || this.managing || !this.actorUuid) return;
    this.refreshRevision = (this.refreshRevision ?? 0) + 1;
    this.pending = true;
    this.phase = this.data.mode === "free" ? "collecting" : "rolling";
    this.result = null;
    this.render();
    let lease;
    try {
      const actorUuid = this.actorUuid;
      lease = await request("begin", this.token, { actorUuid });
      const document = await fromUuid(actorUuid);
      const token = document?.documentName === "Token" ? document : null;
      const actor = token?.actor ?? document;
      let messageId;
      if (lease.mode !== "free") {
        const config = { event, target: lease.dc, [lease.mode]: lease.key };
        const message = { data: {
          speaker: CONFIG.ChatMessage.documentClass.getSpeaker({ actor, token }),
          flags: { [ID]: { check: { nonce: lease.nonce, actorUuid: actor.uuid } } }
        } };
        const tool = lease.mode === "tool" ? matchingTool(actor, lease.key) : null;
        if (lease.mode === "tool" && !tool) throw new Error("The required tool is no longer in your inventory.");
        if (tool) Object.assign(config, {
          ability: tool.system.ability || undefined, bonus: tool.system.bonus, prof: tool.system.prof, item: tool
        });
        const rolls = lease.mode === "tool"
          ? await actor.rollToolCheck(config, {}, message)
          : lease.mode === "skill"
          ? await actor.rollSkill(config, {}, message)
          : await actor.rollAbilityCheck(config, {}, message);
        if (!rolls?.length) return;
        messageId = rolls[0].parent?.id;
        if (!messageId) throw new Error("The D&D check did not create a chat message.");
      }
      this.phase = "collecting";
      if (this.rendered) await this.render();
      this.result = await request("finish", this.token, { nonce: lease.nonce, messageId });
      this.data = { ...this.data, ...this.result, busy: false };
      lease = null;
    } catch (error) {
      report(error);
    } finally {
      if (lease) {
        try { await request("cancel", this.token, { nonce: lease.nonce }); }
        catch (error) { console.debug(`${ID} | Could not release harvest attempt`, error); }
      }
      this.pending = false;
      if (this.result && this.rendered) await this.render();
      else await this.refresh();
    }
  }

  _onClose(options) {
    this.refreshRevision = (this.refreshRevision ?? 0) + 1;
    playerWindows.delete(this.token.uuid);
    super._onClose(options);
  }
}

export async function openHarvest(token) {
  const existing = playerWindows.get(token.uuid);
  if (existing) return existing.render({ force: true, focus: true });
  try {
    const data = await request("view", token);
    if (playerWindows.has(token.uuid)) return;
    const app = new HarvestWindow(token, data);
    playerWindows.set(token.uuid, app);
    return await app.render({ force: true, focus: true });
  } catch (error) {
    playerWindows.delete(token.uuid);
    report(error);
  }
}

export async function openConfig(subject) {
  if (!canConfigure(subject)) return;
  const existing = configWindows.get(subject.uuid);
  if (existing) return existing.render({ force: true, focus: true });
  try {
    const data = game.user.isGM ? await readHarvest(subject) : await request("configuration", subject);
    if (configWindows.has(subject.uuid)) return;
    const app = new HarvestConfig(subject, data);
    configWindows.set(subject.uuid, app);
    return await app.render({ force: true, focus: true });
  } catch (error) {
    configWindows.delete(subject.uuid);
    report(error);
  }
}

export function refreshHarvest(uuid) {
  const config = configWindows.get(uuid);
  if (config && !canConfigure(config.subject)) config.close();
  playerWindows.get(uuid)?.refresh();
}

export function refreshInteractions(sceneId) {
  for (const app of playerWindows.values()) {
    if (!sceneId || app.token.parent.id === sceneId) app.refresh();
  }
}

export function closeHarvest(uuid) {
  playerWindows.get(uuid)?.close();
  configWindows.get(uuid)?.close();
}
