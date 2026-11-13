import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { grantInventory } from "../scripts/inventory.mjs";
import { gridDistance, inRange } from "../scripts/interaction.mjs";
import { renderRewardPreview } from "../scripts/preview.mjs";
import { collectRewards, revealedItem, rewardPreview } from "../scripts/rewards.mjs";

const clone = structuredClone;
globalThis.foundry = { utils: { deepClone: clone }, applications: { api: { ApplicationV2: class {} } } };
globalThis.CONST = { DOCUMENT_OWNERSHIP_LEVELS: { NONE: 0, LIMITED: 1, OBSERVER: 2, OWNER: 3 } };
const source = (overrides = {}) => ({ _id: "source", name: "Herb", type: "loot", img: "herb.png",
  system: { quantity: 40, container: null, description: { value: "Fresh" } }, effects: [], ...overrides });
const doc = (data, id = data._id) => ({ id, uuid: `Actor.recipient.Item.${id}`, system: data.system,
  toObject: () => clone(data) });
function recipient(data = []) {
  const items = data.map(d => doc(clone(d)));
  items.get = id => items.find(item => item.id === id);
  return { items, updates: [], creates: [],
    async updateEmbeddedDocuments(type, updates, options) {
      assert.equal(type, "Item");
      this.updates.push({ updates, options });
      return updates.map(update => {
        const item = items.get(update._id);
        item.system.quantity = update["system.quantity"];
        return item;
      });
    },
    async createEmbeddedDocuments(type, data, options) {
      assert.equal(type, "Item");
      this.creates.push({ data, options });
      return data.map(d => { const item = doc(clone(d), `new${items.length}`); items.push(item); return item; });
    }
  };
}

test("native delivery uses reward units, updates matching stacks and preserves source data", async () => {
  const data = source();
  const actor = recipient([source({ _id: "existing", system: { ...data.system, quantity: 3 } })]);
  const receipt = await grantInventory([{ item: doc(data), quantity: 4 }], actor, "attempt");
  assert.equal(actor.items[0].system.quantity, 7);
  assert.equal(actor.creates.length, 0);
  assert.deepEqual(receipt, [{ name: "Herb", img: "herb.png", quantity: 4, uuid: "Actor.recipient.Item.existing" }]);
  assert.equal(actor.updates[0].options.harvestInteractionId, "attempt");
  assert.equal(data.system.quantity, 40);
});

test("new reward stacks coalesce within a delivery and discard source document placement", async () => {
  const data = source({ folder: "folder", ownership: { player: 3 }, system: { ...source().system, container: "old-bag" } });
  const actor = recipient();
  await grantInventory([{ item: doc(data), quantity: 2 }, { item: doc(data), quantity: 3 }], actor);
  assert.equal(actor.items.length, 1);
  assert.equal(actor.items[0].system.quantity, 5);
  const created = actor.creates[0].data[0];
  assert.equal(created.system.container, null);
  for (const key of ["_id", "folder", "ownership"]) assert.equal(Object.hasOwn(created, key), false);
  assert.equal(data.system.container, "old-bag");
});

test("different mechanics and items inside containers are kept separate", async () => {
  const actor = recipient([
    source({ _id: "inside", system: { ...source().system, container: "bag" } }),
    source({ _id: "altered", system: { ...source().system, description: { value: "Changed" } } })
  ]);
  await grantInventory([{ item: doc(source()), quantity: 2 }], actor);
  assert.equal(actor.items.length, 3);
  assert.equal(actor.items[2].system.quantity, 2);
});

test("containers and items without quantity fields are delivered as distinct documents", async () => {
  for (const data of [source({ type: "container" }), source({ type: "feat", system: {} })]) {
    const actor = recipient();
    const receipts = await grantInventory([{ item: doc(data), quantity: 3 }], actor);
    assert.equal(actor.items.length, 3);
    assert.equal(new Set(actor.items.map(item => item.id)).size, 3);
    assert.equal(receipts[0].quantity, 3);
    for (const item of actor.items) assert.equal(item.system.quantity, data.type === "container" ? 1 : undefined);
  }
});

test("empty grants do nothing; invalid quantities and hook-vetoed writes report failure", async () => {
  const actor = recipient();
  assert.deepEqual(await grantInventory([], actor), []);
  for (const quantity of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(grantInventory([{ item: doc(source()), quantity }], actor));
  }
  actor.createEmbeddedDocuments = async () => [];
  await assert.rejects(grantInventory([{ item: doc(source()), quantity: 2 }], actor), /prevented/);
  const stacked = recipient([source({ _id: "existing" })]);
  stacked.updateEmbeddedDocuments = async () => [];
  await assert.rejects(grantInventory([{ item: doc(source()), quantity: 2 }], stacked), /prevented/);
});

test("distance keeps edge-based behavior for overlap, adjacency, size and scene boundaries", () => {
  const scene = { id: "scene", grid: { size: 100 } };
  const token = (x, y, width = 100, height = 100) => ({ x, y, parent: scene, getSize: () => ({ width, height }) });
  const origin = token(0, 0);
  for (const [other, expected] of [[token(0, 0), 1], [token(100, 0), 1], [token(200, 0), 2],
    [token(200, 200), 2], [token(300, 0), 3], [token(-200, 0, 200), 1]]) {
    assert.equal(gridDistance(origin, other), expected);
    assert.equal(gridDistance(other, origin), expected);
  }
  assert.equal(gridDistance(origin, { ...origin, parent: { id: "other" } }), Infinity);
  assert.equal(inRange(origin, token(1000, 0), 2, { isGM: true }), true);
  assert.equal(inRange(origin, token(300, 0), 2, { isGM: false }), false);
});

test("previews isolate ownership and use only the module's setting for modern and legacy sheets", async () => {
  const data = source({ ownership: { default: 3, stranger: 3 } });
  let snapshot;
  let previewOptions;
  let renderArgs;
  globalThis.game = { user: { id: "player" }, settings: { get(namespace, key) {
    assert.equal(namespace, "harvester-scavenger"); assert.equal(key, "previewPermission"); return 2;
  } } };
  for (const modern of [true, false]) {
    const sheet = modern ? new foundry.applications.api.ApplicationV2() : { options: {} };
    sheet.render = (...args) => { renderArgs = args; };
    globalThis.CONFIG = { Item: { documentClass: class {
      constructor(data, options) { snapshot = data; previewOptions = options; this.sheet = sheet; }
    } } };
    await renderRewardPreview(data);
    assert.deepEqual(snapshot.ownership, { default: 0, player: 2 });
    assert.equal(snapshot._id, undefined);
    assert.equal(previewOptions.temporary, true);
    assert.equal(renderArgs[modern ? 0 : 1].editable, false);
    assert.equal(renderArgs[modern ? 0 : 1].submitOnChange, false);
  }
  assert.deepEqual(data.ownership, { default: 3, stranger: 3 });
  game.settings.get = () => 3; // Invalid settings never grant owner access.
  await renderRewardPreview(data);
  assert.equal(snapshot.ownership.player, 2);
  game.settings.get = () => 1;
  await renderRewardPreview(data);
  assert.equal(snapshot.ownership.player, 1);
});

test("direct and table rewards combine and multiply before native delivery", async () => {
  const herb = { ...doc(source(), "herb"), documentName: "Item" };
  const result = { id: "result", name: "Herb", documentUuid: "Item.herb", range: [1, 20] };
  const results = [result]; results.get = id => results.find(result => result.id === id);
  const table = { name: "Plants", documentName: "RollTable", results, roll: async () => ({ results }) };
  globalThis.fromUuid = async uuid => ({ "Item.herb": herb, "RollTable.plants": table })[uuid];
  const base = { items: [{ uuid: "Item.herb", quantity: 2 }], tables: [{ uuid: "RollTable.plants", quantity: 2 }] };
  const rewards = await collectRewards([base], 2);
  assert.equal(rewards[0].quantity, 8);
  const actor = recipient();
  assert.equal((await grantInventory(rewards, actor))[0].quantity, 8);
  const rules = { base, revealItems: true, revealTables: true };
  const preview = await rewardPreview(rules);
  assert.equal(preview.tables[0].results[0].previewKey, "table:0:result");
  assert.equal(await revealedItem(rules, "table:0:result"), herb);
  assert.equal(await revealedItem({ ...rules, revealTables: false }, "table:0:result"), null);
  assert.equal(await revealedItem({ ...rules, revealItems: false }, "item:0"), null);
});

test("module manifest declares its runtime files and required modules", async () => {
  const manifest = JSON.parse(await readFile(new URL("../module.json", import.meta.url)));
  assert.deepEqual(manifest.relationships.requires.map(entry => entry.id), ["lib-wrapper", "socketlib"]);
  assert.equal(manifest.relationships.systems[0].id, "dnd5e");
  for (const file of [...manifest.esmodules, ...manifest.styles]) {
    assert.ok((await readFile(new URL(`../${file}`, import.meta.url))).length, file);
  }
});
