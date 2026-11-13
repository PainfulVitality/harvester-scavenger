// Opt-in integration harness: copy to qa.mjs in a DISPOSABLE harvest-qa world
// and add "qa.mjs" to that world's esmodules before starting Foundry.
// Install only this module, libWrapper and socketlib. Creates test documents.
Hooks.once("ready", async () => {
  if (game.world.id !== "harvest-qa") return;
  if (!game.user.isGM) {
    const target = canvas.scene.tokens.find(token => token.name === "Independent Harvest");
    if (target) await game.modules.get("harvester-scavenger").api.open(target);
    return;
  }
  const results = [];
  const check = (condition, message) => { if (!condition) throw new Error(message); results.push(message); };
  try {
    const expectedModules = new Set(["harvester-scavenger", "lib-wrapper", "socketlib"]);
    check([...game.modules.values()].filter(module => module.active).every(module => expectedModules.has(module.id)),
      "Only the module and its declared dependencies are active");
    check(!!game.modules.get("harvester-scavenger").api, "Module initialized independently");
    const { grantInventory } = await import("/modules/harvester-scavenger/scripts/inventory.mjs");
    const { collectRewards } = await import("/modules/harvester-scavenger/scripts/rewards.mjs");
    const { defaultRules } = await import("/modules/harvester-scavenger/scripts/rules.mjs");
    const { saveRules } = await import("/modules/harvester-scavenger/scripts/store.mjs");
    const { request } = await import("/modules/harvester-scavenger/scripts/authority.mjs");
    const actor = await Actor.create({ name: "Independent Recipient", type: "character" });
    const item = await Item.create({ name: "Independent Herb", type: "loot", system: { quantity: 37 } });
    const first = await grantInventory([{ item, quantity: 2 }], actor, "qa-first");
    check(actor.items.size === 1 && actor.items.contents[0].system.quantity === 2 && first[0].quantity === 2, "Native physical reward quantity and receipt");
    await grantInventory([{ item, quantity: 3 }], actor, "qa-stack");
    check(actor.items.size === 1 && actor.items.contents[0].system.quantity === 5, "Repeated deliveries stack in real D&D inventory");
    const feature = await Item.create({ name: "Independent Feature", type: "feat" });
    await grantInventory([{ item: feature, quantity: 2 }], actor, "qa-feature");
    check(actor.items.filter(item => item.type === "feat").length === 2, "Non-physical rewards create distinct native Items");
    const table = await RollTable.create({ name: "Independent Table", formula: "1d1", results: [{ type: CONST.TABLE_RESULT_TYPES.DOCUMENT, documentUuid: item.uuid, name: item.name, range: [1,1], weight: 1 }] });
    const sources = { items: [{ uuid: item.uuid, quantity: 2 }], tables: [{ uuid: table.uuid, quantity: 1 }] };
    const combined = await collectRewards([sources], 2);
    check(combined[0].quantity === 6, "Real Roll Table and direct reward quantities combine");
    const nodeActor = await Actor.create({ name: "Independent Harvest", type: "npc" });
    const nodeData = await nodeActor.getTokenDocument({ x: 600, y: 400, name: "Independent Harvest" });
    const [node] = await canvas.scene.createEmbeddedDocuments("Token", [nodeData.toObject()]);
    await saveRules(node, { ...defaultRules(), mode: "free", harvestLimit: 3, distance: 0, revealItems: true, revealTables: true, base: sources }, { enabled: true });
    const initial = await request("view", node);
    check(initial.items[0].name === item.name && initial.tables[0].results[0].previewKey, "Authority reveals direct and table rewards");
    const lease = await request("begin", node, { actorUuid: actor.uuid });
    const finished = await request("finish", node, { nonce: lease.nonce });
    check(!finished.warning && finished.harvests === 1 && actor.items.find(i => i.name === item.name).system.quantity === 8, "Complete harvest delivers rewards, advances progress and posts receipt");
    check(game.messages.contents.at(-1).content.includes("harvest-chat-card"), "Module-owned chat receipt rendered");
    await game.modules.get("harvester-scavenger").api.open(node);
    check(document.querySelector(".harvest-player .harvest-primary"), "Independent player window rendered");
    check(getComputedStyle(document.querySelector(".harvest-player")).getPropertyValue("--harvest-card").trim(), "Independent theme palette resolved");
    check(document.querySelector(".harvest-tab-rail"), "Module navigation rendered");
    const player = game.users.find(u => !u.isGM);
    const data = item.toObject(); data.ownership = { default: 0, [player.id]: 2 };
    const temporary = new CONFIG.Item.documentClass(data, { temporary: true });
    check(temporary.testUserPermission(player, "OBSERVER") && !temporary.testUserPermission(player, "OWNER"), "Real temporary item honors observer access");
    results.push("ALL NATIVE CHECKS PASSED");
  } catch (error) { results.push(`FAILED: ${error.stack}`); console.error(error); }
  class QAReport extends foundry.applications.api.ApplicationV2 {
    static DEFAULT_OPTIONS = { id: "independent-qa-report", position: { width: 650, height: "auto" }, window: { title: "Independent integration checks" } };
    async _renderHTML() { const pre = document.createElement("pre"); pre.style.cssText = "white-space:pre-wrap;padding:14px"; pre.textContent = results.join("\n"); return pre; }
    _replaceHTML(result, content) { content.replaceChildren(result); }
  }
  new QAReport().render({ force: true });
});
