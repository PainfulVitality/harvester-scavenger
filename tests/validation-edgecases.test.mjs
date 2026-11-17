import test from "node:test";
import assert from "node:assert/strict";
import { defaultRules, defaultState, validateRules, validateState, RuleValidationError } from "../scripts/rules.mjs";
import { collectRewards, itemQuantity, lookup, postReceipt } from "../scripts/rewards.mjs";
import { grantInventory } from "../scripts/inventory.mjs";

const badRules = [null, [], "rules", 42, { base: null }, { base: { items: null, tables: [] } },
  { thresholds: null }, { thresholds: [{}] }, { mode: "script" }, { dc: NaN }, { dc: 0 }, { dc: 100 },
  { harvestLimit: -1 }, { harvestLimit: 1.5 }, { distance: -1 }, { distance: Infinity },
  { revealItems: "yes" }, { macroClient: "server" }, { macro: "../../file" },
  { name: "x".repeat(121) }, { description: "x".repeat(100001) },
  { base: { items: [{ uuid: "Item.reward", quantity: -1 }], tables: [] } },
  { base: { items: [{ uuid: "Item.reward", quantity: 1.5 }], tables: [] } },
  { base: { items: [{ uuid: "Item.reward", quantity: 1000 }], tables: [] } },
  { base: { items: [{ uuid: "Item.reward", quantity: 1, randomQuantity: "true" }], tables: [] } },
  { base: { items: [{ uuid: "Item.reward", quantity: 1, randomQuantity: true, minQuantity: 5, maxQuantity: 1 }], tables: [] } },
  { base: { items: [{ uuid: "Item.reward", quantity: 1, randomQuantity: true, minQuantity: 0, maxQuantity: 1000 }], tables: [] } },
  { base: { items: [], tables: [{ uuid: "RollTable.reward", quantity: 21 }] } },
  { base: { items: [], tables: [{ uuid: "RollTable.reward", quantity: 1, randomQuantity: true }] } },
  { thresholds: Array.from({ length: 21 }, () => ({ above: 1, double: true, items: [], tables: [] })) },
  { base: { items: Array.from({ length: 101 }, () => ({ uuid: "Item.reward", quantity: 1 })), tables: [] } }
];
for (const [index, value] of badRules.entries()) {
  test(`invalid or oversized settings reject safely (${index + 1})`, () => {
    assert.throws(() => validateRules(value !== null && typeof value === "object" && !Array.isArray(value)
      ? { ...defaultRules(), ...value } : value), RuleValidationError);
  });
}

test("valid defaults, legacy wording, fixed/range quantities and unknown fields normalize without source mutation", () => {
  const original = { ...defaultRules(), unexpected: "do not save", base: { items: [{ uuid: "Item.reward", quantity: 999,
    randomQuantity: true, minQuantity: 0, maxQuantity: 999, unexpected: "do not save" }], tables: [] } };
  const result = validateRules(original);
  assert.equal(result.base.items[0].minQuantity, 0);
  assert.equal(Object.hasOwn(result, "unexpected"), false);
  assert.equal(Object.hasOwn(result.base.items[0], "unexpected"), false);
  assert.equal(original.unexpected, "do not save");
  assert.equal(original.base.items[0].unexpected, "do not save");
  assert.equal(validateRules({ defeatedOnly: true }).lootMode, true);
  assert.equal(validateRules({ naturalOne: "normal" }).naturalOne, "world");
  assert.deepEqual(validateRules(defaultRules()), defaultRules());
});

test("fixed mode can discard an invalid inactive range without affecting its saved fixed quantity", () => {
  const rules = validateRules({ base: { items: [{ uuid: "Item.reward", quantity: 3, randomQuantity: false,
    minQuantity: 8, maxQuantity: 1 }], tables: [] } });
  assert.equal(rules.base.items[0].quantity, 3);
  assert.equal(Object.hasOwn(rules.base.items[0], "minQuantity"), false);
});

for (const state of [null, [], { ...defaultState(), harvests: -1 }, { ...defaultState(), failures: NaN },
  { ...defaultState(), locked: "yes" }, { ...defaultState(), lastOutcome: "unknown" },
  { ...defaultState(), harvests: Number.MAX_SAFE_INTEGER }, { ...defaultState(), harvests: 2 ** 52, failures: 2 ** 52 }]) {
  test(`corrupt progress rejects instead of granting additional attempts (${JSON.stringify(state)})`, () => {
    assert.throws(() => validateState(state), RuleValidationError);
  });
}

test("invalid multipliers and excessive table draws stop before resolving any source documents", async () => {
  globalThis.fromUuid = async () => assert.fail("No documents should be read");
  for (const multiplier of [0, -1, 1.5, Infinity, NaN]) await assert.rejects(collectRewards([], multiplier), /multiplier/);
  for (const quantity of [0,-1,1.5,21,Infinity]) await assert.rejects(collectRewards([{ items: [], tables: [{ uuid: "RollTable.reward", quantity }] }],1), /draws/);
  await assert.rejects(collectRewards([{ items: [], tables: Array.from({ length: 11 }, () => ({ uuid: "RollTable.reward", quantity: 20 })) }],1), /200 draws/);
});

test("non-stackable rewards are bounded before allocations or inventory writes", async () => {
  globalThis.foundry = { utils: { deepClone: structuredClone } };
  const actor = { get items() { assert.fail("Oversized deliveries must stop before accessing inventory"); } };
  for (const data of [{ type: "container", system: { quantity: 1 } }, { type: "feat", system: {} }]) {
    const item = { ...data, toObject: () => structuredClone(data) };
    await assert.rejects(grantInventory([{ item, quantity: 501 }],actor), /500 inventory documents/);
  }
});

test("random quantity supports zero and equal bounds, and rejects invalid dice results", async () => {
  assert.equal(await itemQuantity({ randomQuantity: true, minQuantity: 0, maxQuantity: 0 }),0);
  assert.equal(await itemQuantity({ randomQuantity: true, minQuantity: 999, maxQuantity: 999 }),999);
  for (const quantity of [0,-1,1.1,Infinity,NaN,1000]) await assert.rejects(itemQuantity({ quantity }),/quantity/);
  globalThis.Roll = class { async evaluate() { return { total: 9999 }; } };
  await assert.rejects(itemQuantity({ randomQuantity: true, minQuantity: 0, maxQuantity: 5 }),/invalid result/);
});

test("malformed document references never reach Foundry's UUID resolver", async () => {
  globalThis.fromUuid = async () => assert.fail("Invalid UUID should not be resolved");
  for (const uuid of [undefined,null,0,{},"", "../../file", "Item.white space", "x".repeat(2049)]) assert.equal(await lookup(uuid,"Item"),null);
});

test("blind and private receipts preserve recipients without requiring a whisper array", async () => {
  const receipts = [];
  const gm = { id: "gm", isGM: true }; const player = { id: "player" };
  globalThis.game = { users: [gm,player] };
  globalThis.foundry = { applications: { handlebars: { renderTemplate: async () => "Receipt" } } };
  globalThis.CONFIG = { ChatMessage: { documentClass: { getSpeaker: () => ({}), create: async data => { receipts.push(data); } } } };
  const token = { texture: { src: "node.png" } }; const actor = { name: "Hero" };
  await postReceipt(token,"Node",actor,null,"success",[],false,player,{ blind: true });
  assert.deepEqual(receipts[0].whisper,["gm"]); assert.equal(receipts[0].blind,true);
  await postReceipt(token,"Node",actor,null,"success",[],false,player,{ whisper: ["gm"] });
  assert.deepEqual(receipts[1].whisper,["gm","player"]);
  await postReceipt(token,"Node",actor,null,"success",[],false,player,null);
  assert.deepEqual(receipts[2].whisper,[]);
});
