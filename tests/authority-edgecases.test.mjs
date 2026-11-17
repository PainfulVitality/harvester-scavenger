import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { defaultRules, defaultState, ID } from "../scripts/rules.mjs";

const original = { timer: globalThis.setTimeout, now: Date.now, error: console.error, warn: console.warn };
afterEach(() => { globalThis.setTimeout = original.timer; Date.now = original.now; console.error = original.error; console.warn = original.warn; });
let iteration = 0;
async function harness(overrides = {}) {
  const rules = { ...defaultRules(), mode: "free", harvestLimit: 3, distance: 0,
    revealItems: true, base: { items: [{ uuid: "Item.reward", quantity: 2 }], tables: [] }, ...overrides };
  const state = defaultState();
  const writes = [], messages = [], errors = [], timers = [], notices = [], refreshes = [];
  globalThis.setTimeout = callback => { timers.push(callback); return timers.length; };
  console.error = (...args) => errors.push(args);
  console.warn = (...args) => errors.push(args);
  let now = 100000;
  Date.now = () => now;
  const gm = { id: "gm", isGM: true, isSelf: true, active: true };
  const player = { id: "player", name: "Player", active: true, isGM: false, viewedScene: "scene" };
  const other = { ...player, id: "other" };
  const scene = { id: "scene", grid: { size: 100 }, tokens: [] };
  const flags = { recipe: "recipe", enabled: true };
  const actor = { id: "hero", uuid: "Actor.hero", documentName: "Actor", name: "Hero", img: "hero.png", type: "character",
    testUserPermission: user => user.id === player.id || user.isGM, items: [], updates: [], creates: [] };
  actor.items.get = id => actor.items.find(item => item.id === id);
  actor.updateEmbeddedDocuments = async (_type, changes) => {
    actor.updates.push(changes); writes.push("inventory-update");
    return changes.map(change => { const doc = actor.items.get(change._id); doc.system.quantity = change["system.quantity"]; return doc; });
  };
  actor.createEmbeddedDocuments = async (_type, data) => {
    actor.creates.push(data); writes.push("inventory-create");
    return data.map(source => { const item = { id: `created${actor.items.length}`, uuid: `Actor.hero.Item.created${actor.items.length}`,
      system: structuredClone(source.system), toObject: () => structuredClone(source) }; actor.items.push(item); return item; });
  };
  const nodeActor = { id: "nodeActor", uuid: "Actor.nodeActor", name: "Creature", img: "creature.png",
    system: { attributes: { hp: { value: 0 } } }, testUserPermission: user => user.isGM };
  const node = { id: "node", uuid: "Scene.scene.Token.node", documentName: "Token", name: "Node", x: 0, y: 0,
    parent: scene, actor: nodeActor, texture: { src: "node.png" }, getSize: () => ({ width: 100, height: 100 }),
    getFlag: (_id, key) => flags[key] };
  const hero = { id: "heroToken", uuid: "Scene.scene.Token.heroToken", documentName: "Token", parent: scene,
    actor, x: 100, y: 0, getSize: () => ({ width: 100, height: 100 }), getFlag: () => undefined };
  scene.tokens.push(node, hero);
  const source = { _id: "reward", name: "Herb", type: "loot", img: "herb.png", system: { quantity: 19 }, effects: [] };
  const reward = { uuid: "Item.reward", name: source.name, documentName: "Item", type: source.type,
    parent: nodeActor, isOwner: false, testUserPermission: () => false,
    system: { ...source.system, getCardData: async options => {
      assert.equal(options.secrets, false); return { description: "Public description", item: { name: "Herb" } };
    } }, toObject: () => structuredClone(source) };
  const record = { id: "state", getFlag: () => state, update: async change => {
    writes.push("state"); Object.assign(state, change.flags[ID].state); return record;
  } };
  const recipe = { getFlag: () => rules };
  const records = new Map([[node.uuid,record]]);
  const pack = { getDocument: async () => recipe, getIndex: async () => [...records].map(([name,record]) => ({ _id: record.id, name })),
    getDocuments: async ({ _id }) => [...records.values()].filter(record=>record.id===_id), set() {} };
  const docs = new Map([[node.uuid, node], [hero.uuid, hero], [actor.uuid, actor], [reward.uuid, reward]]);
  const chat = new Map();
  const users = [gm, player, other]; users.get = id => users.find(user => user.id === id); users.activeGM = gm;
  globalThis.game = { user: gm, users, packs: { get: () => pack }, settings: { get: (_id, key) => ({
    defaultRecipe: "", interactionDistance: 2, doubleCritical: false, automaticFailure: true
  })[key] }, messages: chat, actors: [actor], scenes: [scene], modules: new Map() };
  globalThis.fromUuid = async uuid => docs.get(uuid) ?? null;
  globalThis.document = { createElement: () => ({ innerHTML: "", content: { querySelectorAll: () => [] } }) };
  globalThis.foundry = { utils: { deepClone: structuredClone, isEmpty: object => Object.keys(object).length === 0,
    diffObject: (a,b) => JSON.stringify(a) === JSON.stringify(b) ? {} : b, randomID: () => `nonce${++iteration}` },
    applications: { handlebars: { renderTemplate: async (_path, data) => { assert.ok(data.message); return "<article>Receipt</article>"; } } },
    audio: { AudioHelper: { play: () => Promise.resolve() } } };
  globalThis.CONFIG = { DND5E: { skills: { sur: {} }, abilities: { wis: {} }, tools: { herb: {} } },
    ChatMessage: { documentClass: { getSpeaker: ({ actor, token }) => ({ actor: actor?.id, token: token?.id }),
      create: async data => { messages.push(data); return { id: "message" }; } } } };
  globalThis.ui = { notifications: { error: message => notices.push(message) } };
  const handlers = new Map();
  globalThis.socketlib = { registerModule: () => ({ register: (name, callback) => handlers.set(name, callback),
    executeForEveryone: async (...args) => refreshes.push(args), executeAsUser: async () => true }) };
  const authority = await import(`../scripts/authority.mjs?edgecase=${++iteration}`);
  authority.initializeAuthority(() => {});
  const call = (action, data = {}, user = player, uuid = node.uuid) => handlers.get("request").call({ socketdata: { userId: user?.id } }, action, uuid, data);
  const begin = () => call("begin", { actorUuid: hero.uuid });
  const finish = lease => call("finish", { nonce: lease.value.nonce, messageId: "roll" });
  const roll = lease => {
    const message = { author: player, type: "check", getFlag: () => ({ nonce: lease.value.nonce, actorUuid: actor.uuid }),
      speaker: { actor: actor.id, token: hero.id }, system: { skill: "sur", ability: "wis", tool: "herb" },
      rolls: [{ total: 20, d20: { results: [{ active: true, discarded: false, result: 12 }] } }] };
    chat.set("roll", message); return message;
  };
  return { rules, state, writes, messages, errors, notices, actor, node, hero, reward, record, docs, player, other, gm, call, begin, finish, roll,
    timers, authority, handlers, records, expire: () => { now += 300001; timers.forEach(callback => callback()); } };
}

test("concurrent begins and duplicate finishes deliver exactly once, after recording progress", async () => {
  const h = await harness();
  const attempts = await Promise.all(Array.from({ length: 10 }, () => h.begin()));
  assert.equal(attempts.filter(result => result.ok).length, 1);
  const lease = attempts.find(result => result.ok);
  const finished = await Promise.all(Array.from({ length: 10 }, () => h.finish(lease)));
  assert.equal(finished.filter(result => result.ok).length, 1);
  assert.equal(h.state.harvests, 1);
  assert.equal(h.actor.items[0].system.quantity, 2);
  assert.deepEqual(h.writes, ["state", "inventory-create"]);
  assert.equal(h.messages.length, 1);
  assert.equal(h.errors.length, 0);
});

test("cancellation, expiry, wrong nonce and another user cannot redeem a lease", async () => {
  const h = await harness();
  let lease = await h.begin();
  assert.equal((await h.call("finish", { nonce: "wrong" })).ok, false);
  assert.equal((await h.call("finish", { nonce: lease.value.nonce }, h.other)).ok, false);
  await h.call("cancel", { nonce: lease.value.nonce }, h.other);
  assert.equal((await h.finish(lease)).ok, true);
  lease = await h.begin();
  await h.call("cancel", { nonce: lease.value.nonce });
  assert.equal((await h.finish(lease)).ok, false);
  lease = await h.begin(); h.expire();
  assert.equal((await h.finish(lease)).ok, false);
  assert.equal(h.state.harvests, 1);
  assert.equal(h.errors.length, 0);
});

for (const mutation of ["move", "hide", "ownership", "revive", "recipe", "tool"]) {
  test(`finish rechecks ${mutation} changes and never delivers an unauthorized reward`, async () => {
    const h = await harness({ distance: 2, defeatedOnly: true, ...(mutation === "tool" ? { mode: "tool" } : {}) });
    h.actor.items.push({ type: "tool", system: { quantity: 1, type: { baseItem: "herb" } }, toObject: () => ({ type: "tool", system: {} }) });
    const lease = await h.begin(); assert.equal(lease.ok, true); h.roll(lease);
    if (mutation === "move") h.hero.x = 1000;
    if (mutation === "hide") h.hero.hidden = true;
    if (mutation === "ownership") h.actor.testUserPermission = () => false;
    if (mutation === "revive") h.node.actor.system.attributes.hp.value = 1;
    if (mutation === "recipe") h.node.getFlag = (_id, key) => key === "recipe" ? "changedRecipe" : true;
    if (mutation === "tool") h.actor.items.length = 0;
    assert.equal((await h.finish(lease)).ok, false);
    assert.equal(h.writes.length, 0);
    assert.equal(h.messages.length, 0);
    assert.equal(h.errors.length, 0);
  });
}

for (const mode of ["skill", "ability", "tool"]) {
  test(`native ${mode} check validates the author, speaker, nonce, check key and kept d20`, async () => {
    const h = await harness({ mode });
    if (mode === "tool") h.actor.items.push({ type: "tool", system: { quantity: 1, type: { baseItem: "herb" } },
      toObject: () => ({ type: "tool", system: {} }) });
    const lease = await h.begin(); const message = h.roll(lease);
    assert.equal((await h.finish(lease)).ok, true);
    assert.equal(h.state.harvests, 1);
    assert.equal(message.rolls[0].total, 20);
    assert.equal(h.errors.length, 0);
  });
}

for (const mutate of [
  m => { m.author = { id: "other" }; }, m => { m.type = "item"; },
  m => { m.getFlag = () => ({ nonce: "wrong" }); }, m => { m.speaker.actor = "other"; },
  m => { m.speaker.token = "other"; }, m => { m.system.skill = "different"; },
  m => { m.rolls[0].total = Infinity; }, m => { m.rolls[0].d20.results[0].result = 21; },
  m => { m.rolls[0].d20.results[0].discarded = true; }, m => { m.rolls[0].d20.results = {}; },
  m => { delete m.rolls; }, m => { m.rolls = []; }
]) {
  test(`malformed or mismatched roll is rejected without internal errors (${mutate})`, async () => {
    const h = await harness({ mode: "skill" }); const lease = await h.begin(); mutate(h.roll(lease));
    assert.equal((await h.finish(lease)).ok, false);
    assert.equal(h.writes.length, 0);
    assert.equal(h.errors.length, 0);
  });
}

test("a failed state write cannot deliver rewards; a failed delivery cannot be retried for duplicates", async () => {
  const h = await harness();
  h.record.update = async () => { throw new Error("Disk unavailable"); };
  let lease = await h.begin();
  assert.equal((await h.finish(lease)).ok, false);
  assert.equal(h.actor.creates.length, 0);
  h.record.update = async change => { Object.assign(h.state, change.flags[ID].state); return h.record; };
  h.actor.createEmbeddedDocuments = async () => { throw new Error("Item creation vetoed"); };
  lease = await h.begin();
  const result = await h.finish(lease);
  assert.equal(result.ok, true); assert.match(result.value.warning, /review reward delivery/);
  assert.equal(h.state.harvests, 1);
  assert.equal((await h.finish(lease)).ok, false);
});

test("missing configured rewards stop before progress is consumed", async () => {
  const h = await harness(); h.docs.delete(h.reward.uuid);
  assert.equal((await h.finish(await h.begin())).ok, false);
  assert.equal(h.state.harvests, 0); assert.equal(h.writes.length, 0);
});

test("players can preview and share revealed items on unowned source actors, while hidden rewards stay inaccessible", async () => {
  const h = await harness();
  assert.equal(h.reward.parent.testUserPermission(h.player), false);
  assert.equal(h.reward.testUserPermission(h.player), false);
  assert.equal((await h.call("inspect", { reference: "item:0" })).ok, true);
  assert.equal((await h.call("shareReward", { reference: "item:0" })).ok, true);
  assert.equal(h.messages[0].author, h.player.id);
  h.rules.revealItems = false;
  assert.equal((await h.call("inspect", { reference: "item:0" })).ok, false);
  assert.equal((await h.call("shareReward", { reference: "item:0" })).ok, false);
  assert.equal(h.errors.length, 0);
});

test("malformed requests, foreign actors and player unlocks are rejected without state changes or internal errors", async () => {
  const h = await harness();
  for (const [action, data, uuid] of [["eval", {}, h.node.uuid], ["begin", null, h.node.uuid], ["begin", [], h.node.uuid],
    ["view", {}, "../../etc/passwd"], ["view", {}, null], ["begin", {}, h.node.uuid],
    ["begin", { actorUuid: h.node.actor.uuid }, h.node.uuid], ["unlock", {}, h.node.uuid]]) {
    assert.equal((await h.call(action, data, h.player, uuid)).ok, false);
  }
  h.player.active = false;
  assert.equal((await h.call("view")).ok, false);
  assert.equal(h.errors.length, 0); assert.equal(h.writes.length, 0);
});

test("corrupt rules/state and oversized definition payloads fail before inventory operations", async () => {
  const h = await harness();
  h.rules.base.items[0].quantity = -10;
  assert.equal((await h.begin()).ok, false);
  h.rules.base.items[0].quantity = 1;
  h.state.harvests = -1;
  assert.equal((await h.begin()).ok, false);
  assert.equal(h.writes.length, 0); assert.equal(h.errors.length, 0);
});

test("a lost GM or an uninitialized client transport reports a usable error", async () => {
  const h = await harness();
  game.users.activeGM = null;
  await assert.rejects(h.authority.request("view", h.node), /active GM/);
  const cold = await import(`../scripts/authority.mjs?cold=${++iteration}`);
  game.users.activeGM = { isSelf: false };
  await assert.rejects(cold.request("view", h.node), /still starting/);
});

test("simultaneous harvests from different nodes serialize inventory writes for the same recipient", async () => {
  const h=await harness();
  const second={...h.node,id:'second',uuid:'Scene.scene.Token.second'};
  h.docs.set(second.uuid,second);h.node.parent.tokens.push(second);
  const state=defaultState();const record={id:'state2',getFlag:()=>state,update:async change=>{Object.assign(state,change.flags[ID].state);return record;}};
  h.records.set(second.uuid,record);
  const create=h.actor.createEmbeddedDocuments;
  h.actor.createEmbeddedDocuments=async(...args)=>{await new Promise(resolve=>setImmediate(resolve));return create(...args);};
  const [one,two]=await Promise.all([h.begin(),h.call('begin',{actorUuid:h.hero.uuid},h.player,second.uuid)]);
  assert.equal(one.ok,true);assert.equal(two.ok,true);
  const results=await Promise.all([h.finish(one),h.call('finish',{nonce:two.value.nonce},h.player,second.uuid)]);
  assert.equal(results.every(result=>result.ok&&!result.value.warning),true);
  assert.equal(h.actor.items.length,1);assert.equal(h.actor.items[0].system.quantity,4);
  assert.equal(h.actor.creates.length,1);assert.equal(h.actor.updates.length,1);
  assert.equal(h.errors.length,0);
});

test("missing or unauthorized macros stop before progress or items are changed", async () => {
  const h=await harness({macro:'Macro.reward',macroClient:'player'});
  assert.equal((await h.finish(await h.begin())).ok,false);
  assert.equal(h.writes.length,0);
  h.docs.set('Macro.reward',{documentName:'Macro',canExecute:true,testUserPermission:()=>false});
  assert.equal((await h.finish(await h.begin())).ok,false);
  assert.equal(h.writes.length,0);
});

test("a macro failure preserves delivered inventory, records the attempt and prevents duplicate retries", async () => {
  const h=await harness({macro:'Macro.reward'});
  h.docs.set('Macro.reward',{documentName:'Macro',canExecute:true,execute:async()=>{throw new Error('Macro test failure');}});
  const lease=await h.begin();const result=await h.finish(lease);
  assert.equal(result.ok,true);assert.match(result.value.warning,/review reward delivery/);
  assert.equal(h.actor.items[0].system.quantity,2);assert.equal(h.state.harvests,1);
  assert.equal((await h.finish(lease)).ok,false);
});

test("players cannot invoke the GM-to-client macro callback or forge refresh notifications", async () => {
  const h=await harness();
  assert.equal(await h.handlers.get('runMacro').call({socketdata:{userId:h.player.id}},'Macro.arbitrary',h.node.uuid,h.hero.uuid,{}),false);
  assert.equal(h.writes.length,0);assert.equal(h.errors.length,0);
});

test("blind native checks hide totals and whisper receipts only to GMs", async () => {
  const h=await harness({mode:'skill'});const lease=await h.begin();const message=h.roll(lease);message.blind=true;
  const result=await h.finish(lease);assert.equal(result.ok,true);assert.equal(result.value.total,null);
  assert.deepEqual(h.messages[0].whisper,[h.gm.id]);assert.equal(h.messages[0].blind,true);
  assert.equal(h.errors.length,0);
});

test("an explicit GM reset repairs invalid progress without granting rewards", async () => {
  const h=await harness();h.state.harvests=-10;h.state.failures=NaN;
  assert.equal((await h.begin()).ok,false);
  await h.authority.configureNode(h.node,'reset');
  assert.deepEqual(h.state,defaultState());assert.equal(h.actor.items.length,0);
  assert.equal((await h.begin()).ok,true);
});
