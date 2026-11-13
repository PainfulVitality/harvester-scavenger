import test from "node:test";
import assert from "node:assert/strict";
import { defaultRules, defaultState, normalizeRules, evaluateHarvest, availability, remainingHarvests } from "../scripts/rules.mjs";

const resolve = (overrides, state, total, natural, worldCritical = false, worldFailure = true) =>
  evaluateHarvest({ ...defaultRules(), ...overrides }, state, { total, natural }, worldCritical, worldFailure);

test("successes and failures spend the same pool, with retries until it is exhausted", () => {
  const rules = { harvestLimit: 3 };
  const failed = resolve(rules, defaultState(), 5, 5);
  assert.equal(remainingHarvests({ ...defaultRules(), ...rules }, failed.next), 2);
  assert.equal(availability(rules, failed.next), "ready");
  const success = resolve(rules, failed.next, 15, 15);
  const last = resolve(rules, success.next, 5, 5);
  assert.deepEqual([last.next.harvests, last.next.failures], [1, 2]);
  assert.equal(availability(rules, last.next), "locked");
});

test("natural one consumes all remaining slots despite a high total", () => {
  const result = resolve({ harvestLimit: 5 }, { ...defaultState(), harvests: 2 }, 50, 1);
  assert.equal(result.success, false);
  assert.equal(result.next.failures, 3);
  assert.equal(result.next.locked, true);
});

test("turning off world automatic failure resolves a natural one by its total", () => {
  const result = resolve({}, defaultState(), 30, 1, false, false);
  assert.equal(result.success, true);
  const override = resolve({ naturalOne: "fail", harvestLimit: 3 }, defaultState(), 30, 1, false, false);
  assert.equal(override.success, false);
  assert.equal(override.next.failures, 1);
  assert.equal(override.next.locked, false);
});

test("an unlimited pool supports ordinary failures but still locks on a natural one", () => {
  const normal = resolve({ harvestLimit: 0 }, defaultState(), 5, 5);
  assert.equal(normal.next.locked, false);
  assert.equal(remainingHarvests({ harvestLimit: 0 }, normal.next), Infinity);
  const fumbled = resolve({ harvestLimit: 0 }, normal.next, 40, 1);
  assert.equal(fumbled.next.locked, true);
});

test("only totals strictly above a threshold receive its extras and doubling", () => {
  const tier = { above: 20, double: true, items: [{ uuid: "extra" }], tables: [] };
  const exact = resolve({ thresholds: [tier] }, defaultState(), 20, 15);
  assert.equal(exact.sources.length, 1);
  assert.equal(exact.multiplier, 1);
  const above = resolve({ thresholds: [tier], critical: "yes" }, defaultState(), 25, 20);
  assert.equal(above.sources.length, 2);
  assert.equal(above.multiplier, 4);
});

test("natural 20 alternate rewards replace base and threshold rewards", () => {
  const rewards = { items: [{ uuid: "alternate" }], tables: [] };
  const result = resolve({ critical: "reward", criticalRewards: rewards, dc: 99,
    thresholds: [{ above: 1, double: true, items: [], tables: [] }] }, defaultState(), 20, 20, true);
  assert.equal(result.success, true);
  assert.deepEqual(result.sources, [rewards]);
  assert.equal(result.multiplier, 1);
});

test("natural one alternate rewards use their configured source", () => {
  const rewards = { items: [], tables: [{ uuid: "alternate-table" }] };
  const result = resolve({ naturalOne: "reward", mishap: rewards }, defaultState(), 1, 1);
  assert.equal(result.outcome, "mishap");
  assert.deepEqual(result.sources, [rewards]);
  assert.equal(result.next.locked, false);
});

test("free collection consumes one slot without applying critical rules", () => {
  const result = resolve({ mode: "free" }, defaultState(), null, null);
  assert.equal(result.success, true);
  assert.equal(availability({ harvestLimit: 1 }, result.next), "depleted");
});

test("new HP gating and Loot wording remain independent while legacy wording is preserved", () => {
  assert.equal(normalizeRules({ defeatedOnly: true }).lootMode, true);
  assert.equal(normalizeRules({ defeatedOnly: true, lootMode: false }).lootMode, false);
  assert.equal(normalizeRules({ defeatedOnly: false, lootMode: true }).lootMode, true);
  assert.equal(normalizeRules({ naturalOne: "normal" }).naturalOne, "world");
});
