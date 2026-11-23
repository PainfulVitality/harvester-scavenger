import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { isHarvest, isDefeated, canInteractHarvest, requiresDefeat, usesLootWording } from "../scripts/store.mjs";

const source = readFileSync(new URL("../scripts/main.mjs", import.meta.url), "utf8").replace(/^import .*;\n/gm, "");
function harness({ gm = false, hp = 10, gated = true, enabled = true } = {}) {
  const callbacks = new Map(), wrappers = new Map(), calls = [], created = [];
  const flags = { recipe: "recipe", enabled, defeatedOnly: gated };
  const token = { documentName: "Token", actor: { system: { attributes: { hp: { value: hp } } } },
    getFlag: (_id,key) => flags[key] };
  const user = { isGM: gm };
  const node = { document: token, isVisible: true, layer: { active: true } };
  const module = {};
  const context = vm.createContext({
    ID: "harvester-scavenger", DEFAULT_RECIPE: "defaultRecipe", isHarvest, isDefeated, canInteractHarvest, requiresDefeat, usesLootWording,
    nodeText: text => text, game: { system: { id: "dnd5e" }, user, modules: { get: () => module } },
    CONFIG: { Canvas: { rulerClass: { canMeasure: false } } },
    canvas: { regions: {}, controls: { ruler: { active: false } } },
    Hooks: { once: (name,callback) => callbacks.set(name,callback), on: (name,callback) => callbacks.set(name,callback) },
    libWrapper: { register: (_id,path,callback) => wrappers.set(path.split('.').at(-1),callback) },
    document: { createElement() { const button = { setAttribute() {}, addEventListener(name,fn) { button[name] = fn; } }; created.push(button); return button; } },
    openHarvest: doc => calls.push(["harvest",doc]), openConfig: doc => calls.push(["config",doc]),
    initializeAppearance() {}, initializeNameplates() {}, initializeAuthority() {}, registerPresentationSettings() {},
    setHarvestAppearance() {}, refreshHarvest() {}, refreshInteractions() {}, closeHarvest() {}, expandRewardCard() {}, cleanDeletedHarvest() {}
  });
  vm.runInContext(source,context);
  callbacks.get("setup")();
  const wrapped = (...args) => { calls.push(["native",...args]); return "native-sheet"; };
  const event = { type: "dblclick", altKey: false, stopPropagation: () => calls.push(["stopped"]) };
  return { callbacks, wrappers, calls, created, token, node, user, wrapped, event, context };
}

for (const gm of [false,true]) for (const hp of [10,1]) {
  test(`${gm ? "GM" : "player"} above 0 HP keeps normal sheet permission checks and double-click behavior (HP ${hp})`, () => {
    const h = harness({gm,hp});
    assert.equal(h.wrappers.get("_canView").call(h.node,h.wrapped,h.user,h.event),"native-sheet");
    assert.equal(h.wrappers.get("_onClickLeft2").call(h.node,h.wrapped,h.event),"native-sheet");
    assert.deepEqual(h.calls.map(call=>call[0]),["native","native"]);
  });
}
for (const hp of [0,-1]) {
  test(`HP ${hp} opens the module instead of the sheet when defeated-only is enabled`, () => {
    const h = harness({hp});
    assert.equal(h.wrappers.get("_canView").call(h.node,h.wrapped,h.user,h.event),true);
    h.wrappers.get("_onClickLeft2").call(h.node,h.wrapped,h.event);
    assert.deepEqual(h.calls.map(call=>call[0]),["stopped","harvest"]);
  });
}

test("disabling defeated-only enables harvesting before 0 HP, and disabling harvesting restores native behavior", () => {
  let h = harness({hp:10,gated:false});
  h.wrappers.get("_onClickLeft2").call(h.node,h.wrapped,h.event);
  assert.equal(h.calls.at(-1)[0],"harvest");
  h = harness({hp:0,enabled:false});
  h.wrappers.get("_onClickLeft2").call(h.node,h.wrapped,h.event);
  assert.equal(h.calls.at(-1)[0],"native");
});

test("GM Alt-double-click continues to open the underlying sheet after defeat", () => {
  const h = harness({gm:true,hp:0}); h.event.altKey=true;
  h.wrappers.get("_onClickLeft2").call(h.node,h.wrapped,h.event);
  assert.deepEqual(h.calls.map(call=>call[0]),["native"]);
});
for (const hp of [10,0]) {
  test(`the GM right-click HUD keeps the Harvester icon before and after defeat (HP ${hp})`, () => {
    const h = harness({gm:true,hp}); const appended=[];
    const column={querySelector:()=>null,append:button=>appended.push(button)};
    h.callbacks.get("renderTokenHUD")({object:{document:h.token}},{querySelector:()=>column});
    assert.equal(appended.length,1); assert.equal(appended[0].className,"control-icon harvest-hud");
    appended[0].click({stopPropagation(){}});
    assert.equal(h.calls.at(-1)[0],"config");
  });
}

test("the HUD does not expose configuration controls to players or on non-harvest tokens", () => {
  for (const options of [{gm:false},{gm:true,enabled:false}]) {
    const h=harness(options);
    h.callbacks.get("renderTokenHUD")({object:{document:h.token}},{querySelector:()=>assert.fail("Unexpected configuration control")});
    assert.equal(h.created.length,0);
  }
});

test("living defeated-only tokens retain native appearance, with border restoration when revived", async () => {
  const {initializeAppearance}=await import('../scripts/appearance.mjs');
  const hooks=new Map();globalThis.Hooks={on:(name,callback)=>hooks.set(name,callback)};
  globalThis.foundry={utils:{Color:{from:value=>({value,valueOf:()=>value,multiply:()=>value})}}};
  const hp={value:10};const flags={recipe:'recipe',enabled:true,defeatedOnly:true};
  const token={document:{uuid:'Scene.scene.Token.appearance',alpha:1,texture:{tint:123},actor:{system:{attributes:{hp}}},getFlag:(_id,key)=>flags[key]},
    alpha:1,controlled:false,mesh:{alpha:0.7,tint:321},border:{renderable:true}};
  initializeAppearance();
  hooks.get('refreshToken')(token);
  assert.equal(token.border.renderable,true);assert.equal(token.mesh.alpha,0.7);assert.equal(token.mesh.tint,321);
  hp.value=0;hooks.get('refreshToken')(token);
  assert.equal(token.border.renderable,false);
  hp.value=1;hooks.get('refreshToken')(token);
  assert.equal(token.border.renderable,true);
});

test("effect, actor flag and synthetic-token changes refresh open interaction windows",()=>{
  const h=harness();let refreshed=0;h.context.refreshInteractions=()=>{refreshed++;};
  for(const name of ['createActiveEffect','updateActiveEffect','deleteActiveEffect']){
    h.callbacks.get(name)({parent:{documentName:'Actor'}});
    h.callbacks.get(name)({parent:{documentName:'Item',parent:{documentName:'Actor'}}});
  }
  assert.equal(refreshed,6);
  h.callbacks.get('updateActiveEffect')({parent:{documentName:'Item'}});assert.equal(refreshed,6);
  h.callbacks.get('updateActor')({},{flags:{dnd5e:{halflingLucky:true}}});
  h.callbacks.get('updateToken')({uuid:'Token.hero',parent:{id:'scene'}},{delta:{effects:[]}});
  for(const name of ['updateWorldTime','updateCombat','updateCombatant'])h.callbacks.get(name)();
  assert.equal(refreshed,11);
});
