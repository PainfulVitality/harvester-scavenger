import test from "node:test";
import assert from "node:assert/strict";
import { defaultRules, ID } from "../scripts/rules.mjs";
import { postRewardCard, expandRewardCard } from "../scripts/rewards.mjs";
import { initializeNameplates } from "../scripts/nameplates.mjs";
import { setHarvestAppearance } from "../scripts/appearance.mjs";
import { initializeAuthority } from "../scripts/authority.mjs";

function chatHarness() {
  const messages = [];
  globalThis.CONFIG = { ChatMessage: { documentClass: { create: async data => {
    messages.push(data); return { id: "chat-card" };
  } } } };
  const item = { uuid: "Item.reward", documentName: "Item", name: "Herb", img: "herb.png",
    system: { getCardData: async options => {
      assert.equal(options.secrets, false);
      return { item: { name: "Herb", uuid: "Item.reward" }, description: "<p>Full description</p>", concealed: false };
    } } };
  return { item, messages };
}

test("chat sharing creates a native persistent item card attributed to the requesting player", async () => {
  const { item, messages } = chatHarness();
  const player = { id: "player", name: "Player", character: { id: "hero", name: "Hero" } };
  await postRewardCard(item, player);
  assert.equal(messages.length, 1);
  const card = messages[0];
  assert.equal(card.author, player.id);
  assert.deepEqual(card.speaker, { alias: "Hero", actor: "hero" });
  assert.equal(card.type, "item");
  assert.equal(card.title, "Herb");
  assert.equal(card.flags[ID].sharedReward, true);
  assert.equal(card.flags.core.canPopout, true);
  assert.equal(card.system.description, "<p>Full description</p>");
  // No item use, inventory writes or activity rolls are available to this path.
  assert.equal(Object.hasOwn(card, "whisper"), false);
  await postRewardCard(item, { id: "unassigned", name: "Unassigned Player" });
  assert.deepEqual(messages[1].speaker, { alias: "Unassigned Player" });
});

test("shared card descriptions expand on render, while concealed and unrelated cards stay untouched", () => {
  let expanded = 0;
  const html = { querySelectorAll(selector) {
    assert.equal(selector, ".card-header, .card-description");
    return [0, 1].map(() => ({ classList: { remove(name) {
      assert.equal(name, "collapsed"); expanded++;
    } } }));
  } };
  expandRewardCard({ getFlag: () => true, system: { concealed: false } }, html);
  assert.equal(expanded, 2);
  expandRewardCard({ getFlag: () => true, system: { concealed: true } }, html);
  expandRewardCard({ getFlag: () => false, system: {} }, html);
  assert.equal(expanded, 2);
});

test("authority allows revealed items and table items, and rejects concealed or spoofed references", async () => {
  const { item, messages } = chatHarness();
  const rules = { ...defaultRules(), distance: 0, revealItems: true, revealTables: true,
    base: { items: [{ uuid: item.uuid, quantity: 1 }], tables: [{ uuid: "RollTable.rewards", quantity: 1 }] } };
  const player = { id: "player", name: "Player", active: true, isGM: false, viewedScene: "scene" };
  const token = { uuid: "Scene.scene.Token.node", documentName: "Token", name: "Node",
    parent: { id: "scene", tokens: [] }, texture: { src: "node.png" },
    getFlag: (_id, key) => ({ recipe: "recipe", enabled: true })[key] };
  const results = [{ id: "result", name: item.name, range: [1, 1], documentUuid: item.uuid }];
  results.get = id => results.find(result => result.id === id);
  const table = { documentName: "RollTable", name: "Rewards", results };
  globalThis.fromUuid = async uuid => ({ [token.uuid]: token, [item.uuid]: item, "RollTable.rewards": table })[uuid] ?? null;
  globalThis.document = { createElement: () => ({ innerHTML: "", content: { querySelectorAll: () => [] } }) };
  globalThis.foundry = { utils: { deepClone: structuredClone } };
  const pack = { getDocument: async () => ({ getFlag: () => rules }), getIndex: async () => [] };
  globalThis.game = { user: { isGM: true }, users: { activeGM: { isSelf: true }, get: () => player },
    packs: { get: () => pack } };
  let handler;
  globalThis.socketlib = { registerModule: () => ({ register(name, callback) {
    if (name === "request") handler = callback;
  } }) };
  initializeAuthority(() => {});
  const share = reference => handler.call({ socketdata: { userId: player.id } }, "shareReward", token.uuid, { reference });
  assert.equal((await share("item:0")).ok, true);
  assert.equal((await share("table:0:result")).ok, true);
  assert.equal(messages.length, 2);
  rules.revealItems = false;
  rules.revealTables = false;
  for (const reference of ["item:0", "table:0:result", "Item.reward", "item:999"]) {
    assert.equal((await share(reference)).ok, false);
  }
  rules.revealItems = true;
  token.hidden = true;
  assert.equal((await share("item:0")).ok, false);
  token.hidden = false;
  player.viewedScene = "another-scene";
  assert.equal((await share("item:0")).ok, false);
  player.viewedScene = "scene";
  rules.defeatedOnly = true;
  token.actor = { system: { attributes: { hp: { value: 5 } } }, testUserPermission: () => false };
  assert.equal((await share("item:0")).ok, false);
  assert.equal(messages.length, 2);
});

for (const entry of [undefined, { active: false }]) {
  test(`absent or disabled nameplates registers no hooks and calls no integration methods (${JSON.stringify(entry)})`, () => {
    globalThis.game = { modules: { get: () => entry } };
    globalThis.Hooks = { on() { assert.fail("Unexpected integration hook"); }, once() { assert.fail("Unexpected integration hook"); } };
    globalThis.libWrapper = { register() { assert.fail("Unexpected wrapper registration"); } };
    globalThis.CONFIG = {}; // The optional API is completely absent.
    initializeNameplates();
    let refreshed = false;
    globalThis.fromUuidSync = () => ({ object: { refreshNameplates() { assert.fail("Unexpected optional API call"); },
      renderFlags: { set() { refreshed = true; } } } });
    setHarvestAppearance("Scene.scene.Token.node", "ready");
    assert.equal(refreshed, true);
  });
}

test("active nameplates integration registers once when the API becomes available and refreshes safely", () => {
  const callbacks = [];
  const wrappers = [];
  globalThis.game = { modules: { get: () => ({ active: true }) } };
  globalThis.Hooks = { on: (_name, fn) => callbacks.push(fn), once: (_name, fn) => callbacks.push(fn) };
  globalThis.CONFIG = { Token: { objectClass: class {} } };
  globalThis.libWrapper = { register: (...args) => wrappers.push(args) };
  initializeNameplates();
  callbacks[0]();
  assert.equal(wrappers.length, 0);
  CONFIG.Token.objectClass.prototype.getNameplateFlags = () => ({});
  callbacks[1](); callbacks[0]();
  assert.equal(wrappers.length, 1);
  let refreshed = false;
  globalThis.fromUuidSync = () => ({ object: { refreshNameplates(force) { refreshed = force; }, renderFlags: { set() {} } } });
  setHarvestAppearance("Scene.scene.Token.node", "ready");
  assert.equal(refreshed, true);
  globalThis.fromUuidSync = () => ({ object: { renderFlags: { set() {} } } });
  assert.doesNotThrow(() => setHarvestAppearance("Scene.scene.Token.node", "ready"));
});

test("window message settings preserve defaults and custom text without changing chat receipts", async () => {
  const { windowOutcomeMessage } = await import("../scripts/settings.mjs");
  const values = { successMessage: "Collected safely!", failureMessage: "Try another approach." };
  globalThis.game = { settings: { get: (_id, key) => values[key] } };
  assert.equal(windowOutcomeMessage("success", "Default success"), "Collected safely!");
  assert.equal(windowOutcomeMessage("critical", "Default success"), "Collected safely!");
  assert.equal(windowOutcomeMessage("failure", "Default failure"), "Try another approach.");
  values.successMessage = "   "; values.failureMessage = "";
  assert.equal(windowOutcomeMessage("success", "There is nothing left..."), "There is nothing left...");
  assert.equal(windowOutcomeMessage("failure", "Seems like you weren't lucky this time."), "Seems like you weren't lucky this time.");
});

test("Harvest and Loot labels are independently configurable with distinct default depleted text", async () => {
  const { statusNameplateText } = await import("../scripts/settings.mjs");
  const values = {};
  globalThis.game = { settings: { get: (_id, key) => values[key] } };
  assert.equal(statusNameplateText("ready"), "Harvestable");
  assert.equal(statusNameplateText("ready", true), "Lootable");
  assert.equal(statusNameplateText("locked"), "Fumbled");
  assert.equal(statusNameplateText("depleted"), "Harvested");
  assert.equal(statusNameplateText("depleted", true), "Looted");
  values.harvestDepletedLabel = "Gathered"; values.lootDepletedLabel = "Picked Clean";
  values.harvestFailedLabel = "Try Again";
  assert.equal(statusNameplateText("depleted"), "Gathered");
  assert.equal(statusNameplateText("depleted", true), "Picked Clean");
  assert.equal(statusNameplateText("locked"), "Try Again");
  assert.equal(statusNameplateText("locked", true), "Fumbled");
});

for (const active of [false, true]) {
  test(`presentation settings use world scope and offer nameplate labels only with the optional module active (${active})`, async () => {
    const { registerPresentationSettings } = await import("../scripts/settings.mjs");
    const settings = new Map();
    let refreshed = 0;
    globalThis.game = { modules: { get: () => active ? { active } : undefined }, settings: {
      register(namespace, key, definition) { assert.equal(namespace, ID); settings.set(key, definition); }
    } };
    globalThis.canvas = { tokens: { placeables: [{ refreshNameplates() { refreshed++; } }] } };
    const refresh = () => { refreshed++; };
    registerPresentationSettings(refresh);
    assert.equal(settings.size, 8);
    for (const setting of settings.values()) assert.equal(setting.scope, "world");
    assert.equal(settings.get("successMessage").config, true);
    assert.equal(settings.get("failureMessage").config, true);
    assert.equal(settings.get("lootDepletedLabel").config, active);
    settings.get("lootDepletedLabel").onChange();
    assert.equal(refreshed, active ? 1 : 0);
    settings.get("successMessage").onChange();
    assert.equal(refreshed, active ? 2 : 1);
  });
}

test("Token Nameplates is declared only as an optional recommendation", async () => {
  const { readFile } = await import("node:fs/promises");
  const manifest = JSON.parse(await readFile(new URL("../module.json", import.meta.url)));
  assert.equal(manifest.relationships.requires.some(entry => entry.id === "token-nameplates"), false);
  assert.equal(manifest.relationships.recommends.some(entry => entry.id === "token-nameplates" && entry.type === "module"), true);
});

for (const asynchronous of [false,true]) {
  test(`a failing optional nameplate refresh does not interrupt the module (${asynchronous ? 'async' : 'sync'})`, async () => {
    const { refreshStatusNameplate }=await import('../scripts/settings.mjs');
    globalThis.game={modules:{get:()=>({active:true})}};
    const debug=console.debug;let logged=0;console.debug=()=>{logged++;};
    try {
      const token={refreshNameplates(){if(asynchronous)return Promise.reject(new Error('Optional integration failed'));throw new Error('Optional integration failed');}};
      assert.doesNotThrow(()=>refreshStatusNameplate(token));await Promise.resolve();assert.equal(logged,1);
    } finally {console.debug=debug;}
  });
}
