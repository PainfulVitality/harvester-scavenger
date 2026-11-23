import test from "node:test";
import assert from "node:assert/strict";
import { checkFailureChance, failureTone, dcTone } from "../scripts/chance.mjs";
import { registerPresentationSettings } from "../scripts/settings.mjs";

for (const [dc,expected] of [[1,"green"],[6,"green"],[7,""],[14,""],[15,"orange"],[18,"orange"],[19,"red"],[21,"red"]]) {
  test(`DC ${dc} with no bonus gives the requested tint`,()=>{
    assert.equal(failureTone(checkFailureChance(dc,0)),expected);
  });
}

test("thresholds use inclusive 25%, 70% and 90% failure boundaries",()=>{
  for(const [chance,tone] of [[0,"green"],[0.25,"green"],[0.25001,""],[0.69999,""],[0.7,"orange"],[0.89999,"orange"],[0.9,"red"],[1,"red"]]) {
    assert.equal(failureTone(chance),tone);
  }
});

function testActor({mod = 0, bonus = "0", mode = 0} = {}) {
  globalThis.CONFIG = { DND5E: { skills: {sur:{ability:"wis"}}, tools:{herb:{ability:"wis"}} }, Dice: {D20Roll:{
    constructParts(parts,data){return {parts:Object.keys(parts).filter(k=>parts[k]!=null).map(k=>`@${k}`),data:{...data,...Object.fromEntries(Object.entries(parts).filter(([,v])=>v!=null))}}}
  }}};
  globalThis.dnd5e={dataModels:{actor:{CommonTemplate:{calculateSkillToolProficiency:(actor,ability,process)=>process.prof ?? actor.system[process.skill ? "skills" : "tools"][process.skill ?? process.tool]?.prof}}}};
  class Modifiers { static combineFields(system){return {bonus:system.effectBonus,advantage:system.effectMode===1,disadvantage:system.effectMode===-1,...system.range};} }
  const actor = {system:{effectBonus:bonus,effectMode:mode,range:{},schema:{getField:()=>({constructor:Modifiers})},
    skills:{sur:{ability:"wis",value:1,prof:{multiplier:1}}},tools:{herb:{ability:"wis",value:1,prof:{multiplier:1}}},
    abilities:{wis:{mod,check:{prof:{hasProficiency:false,multiplier:0}}},int:{mod:3,check:{prof:{hasProficiency:false,multiplier:0}}}}},items:[],
    getRollData(){return {roll:{}};},getFlag(){return false;},addConditionRollReduction(){},
    _buildSkillToolConfig(type,host,process,config){config.parts=["@mod","@bonus"];config.data={mod:this.system.abilities[process.ability].mod,bonus:this.system.effectBonus};}
  };
  globalThis.Roll=class {
    constructor(formula,data){
      this.formula=formula.replace(/@([a-zA-Z0-9_.]+)/g,(_,path)=>String(path.split('.').reduce((o,k)=>o?.[k],data)));
      this.isDeterministic=!/[dD]/.test(this.formula);
    }
    evaluateSync(){
      assert.ok(this.isDeterministic,"Estimates must never roll random dice");
      if(!/^[\d+\- .]+$/.test(this.formula))throw new Error("Invalid formula");
      return {total:this.formula.replace(/\s/g,"").replace(/\+-/g,"-").match(/[+-]?(?:\d+(?:\.\d*)?|\.\d+)/g).reduce((sum,n)=>sum+Number(n),0)};
    }
  };
  return actor;
}

test("current skill and ability formulas respond to changes in bonuses and penalties",()=>{
  const actor=testActor();const check={mode:"skill",key:"sur",dc:15};
  assert.equal(dcTone(actor,check),"orange");
  actor.system.effectBonus="10";assert.equal(dcTone(actor,check),"green");
  actor.system.effectBonus="-4";assert.equal(dcTone(actor,check),"red");
  actor.system.effectBonus="9";assert.equal(dcTone(actor,{...check,mode:"ability",key:"wis"}),"green");
});

test("natural-one overrides and alternate natural-20 rewards affect the estimate",()=>{
  assert.equal(checkFailureChance(1,100,{naturalOne:"lock"}),0.05);
  assert.equal(checkFailureChance(1,100,{naturalOne:"fail"}),0.05);
  assert.equal(checkFailureChance(1,100,{naturalOne:"none"}),0);
  assert.equal(checkFailureChance(99,0,{naturalOne:"reward"}),0.95);
  assert.equal(checkFailureChance(99,0,{alternateTwenty:true}),0.95);
  assert.equal(checkFailureChance(99,0,{naturalOne:"reward",alternateTwenty:true}),0.9);
});

test("unknown, missing, nonfinite or unchecked data keeps the normal gold appearance",()=>{
  for(const value of [null,undefined,NaN,Infinity,-1,2])assert.equal(failureTone(value),"");
  assert.equal(checkFailureChance(12,undefined),null);
  assert.equal(dcTone(null,{mode:"skill",key:"sur",dc:15}),"");
  assert.equal(dcTone({system:{}},{mode:"skill",key:"sur",dc:15}),"");
  assert.equal(dcTone({system:{}},{mode:"ability",key:"wis",dc:15}),"");
  assert.equal(dcTone({system:{}},{mode:"free",dc:15}),"");
});

function toolActor() {
  const actor=testActor();
  const item={type:"tool",system:{quantity:1,type:{baseItem:"herb"},ability:"int",bonus:"2",prof:{flat:4,multiplier:1}}};
  actor.items=[item];
  actor._buildSkillToolConfig=function(type,host,process,config){
    assert.equal(type,"tool");assert.equal(host,null);assert.equal(process.item,item);assert.equal(process.ability,"int");
    assert.equal(process.prof,item.system.prof);assert.equal(process.bonus,"2");config.parts=["@mod","@prof","@bonus"];config.data={mod:3,prof:4,bonus:2};
  };
  return actor;
}

test("tool estimates use the same inventory item, ability, proficiency and bonuses without rolling dice",()=>{
  const actor=toolActor();
  globalThis.Roll=class{constructor(formula,data){assert.equal(formula,"@mod + @prof + @bonus");assert.deepEqual(data,{mod:3,prof:4,bonus:2});this.isDeterministic=true;}evaluateSync(){return {total:9};}};
  assert.equal(dcTone(actor,{mode:"tool",key:"herb",dc:15}),"green");
  actor.items=[];assert.equal(dcTone(actor,{mode:"tool",key:"herb",dc:15}),"");
});

test("random tool formulas and custom-system failures do not roll dice or break the window",()=>{
  const actor=toolActor();
  globalThis.Roll=class{isDeterministic=false;evaluateSync(){assert.fail("Random dice must not be rolled for a tint");}};
  assert.equal(dcTone(actor,{mode:"tool",key:"herb",dc:15}),"");
  actor._buildSkillToolConfig=()=>{throw new Error("Custom check unavailable");};
  assert.equal(dcTone(actor,{mode:"tool",key:"herb",dc:15}),"");
});

test("Turn off DC colors is a false-by-default world toggle and refreshes existing windows",()=>{
  const settings=new Map();let refreshed=false;
  globalThis.game={modules:{get:()=>undefined},settings:{register:(_id,key,value)=>settings.set(key,value)}};
  registerPresentationSettings(()=>{refreshed=true;});
  const setting=settings.get("disableDCColors");assert.equal(setting.name,"Turn off DC colors");assert.equal(setting.scope,"world");
  assert.equal(setting.default,false);assert.equal(setting.type,Boolean);setting.onChange();assert.equal(refreshed,true);
});


test("multiple actors keep independent current modifiers and effect modes",()=>{
  const weak=testActor({bonus:"-4"});const strong=testActor({bonus:"10"});const average=testActor();
  const check={mode:"skill",key:"sur",dc:15};
  assert.equal(dcTone(weak,check),"red");assert.equal(dcTone(strong,check),"green");assert.equal(dcTone(average,check),"orange");
  strong.system.effectBonus="-8";assert.equal(dcTone(strong,check),"red");assert.equal(dcTone(weak,check),"red");
  weak.system.effectBonus="10";assert.equal(dcTone(weak,check),"green");
});

test("advantage, disadvantage and cancellation use the correct d20 distribution",()=>{
  assert.equal(checkFailureChance(15,0,{advantage:true}),0.49);
  assert.equal(checkFailureChance(15,0,{disadvantage:true}),0.91);
  assert.equal(checkFailureChance(15,0,{advantage:true,disadvantage:true}),0.7);
  const actor=testActor();const check={mode:"skill",key:"sur",dc:15};
  actor.system.effectMode=-1;assert.equal(dcTone(actor,check),"red");
  actor.system.effectMode=1;assert.equal(dcTone(actor,check),"");
  actor.system.effectMode=0;assert.equal(dcTone(actor,check),"orange");
});

test("minimums, maximums and known reroll traits are deterministic; invalid ranges revert to gold",()=>{
  assert.equal(checkFailureChance(10,0,{minimum:10}),0);
  assert.equal(checkFailureChance(10,0,{reliableTalent:true}),0);
  assert.equal(checkFailureChance(15,0,{maximum:10}),1);
  assert.equal(checkFailureChance(1,100,{halflingLucky:true,naturalOne:"lock"}),0.0025);
  assert.equal(checkFailureChance(12,0,{minimum:15,maximum:10}),null);
});

for(const formula of ["1d4","-1d4","@missing","@nested", "malformed(", "1 / 0"]){
  test(`unresolved skill and ability bonus restores gold (${formula})`,()=>{
    const actor=testActor({bonus:formula});const check={mode:"skill",key:"sur",dc:19};
    assert.equal(dcTone(actor,check),"");assert.equal(dcTone(actor,{...check,mode:"ability",key:"wis"}),"");
  });
}

test("unsupported or unavailable system formula APIs restore gold instead of trusting stale prepared totals",()=>{
  const actor=testActor({bonus:"10"});actor.system.skills.sur.total=100;
  delete actor.system.schema;assert.equal(dcTone(actor,{mode:"skill",key:"sur",dc:15}),"");
  assert.equal(dcTone(actor,null),"");
});

test("missing proficiency or an unknown custom roll option restores gold",()=>{
  const actor=testActor({bonus:'10'});const check={mode:'skill',key:'sur',dc:15};
  actor.system.skills.sur.prof=null;assert.equal(dcTone(actor,check),'');
  actor.system.skills.sur.prof={multiplier:1};
  const build=actor._buildSkillToolConfig;actor._buildSkillToolConfig=function(...args){build.apply(this,args);args[3].options={customReroll:true};};
  assert.equal(dcTone(actor,check),'');
});

test("boolean trait flags and unsupported check bounds fail safely",()=>{
  const actor=testActor();actor.getFlag=()=>false;
  actor.system.range={minimum:30};assert.equal(dcTone(actor,{mode:'skill',key:'sur',dc:15}),'');
  assert.equal(checkFailureChance(15,0,{maximum:NaN}),null);
});

test("native roll-option defaults and known advantage overrides remain resolvable",()=>{
  const actor=testActor();const check={mode:'skill',key:'sur',dc:15};const build=actor._buildSkillToolConfig;
  let options={minimum:-Infinity,maximum:Infinity,advantage:undefined,disadvantage:undefined};
  actor._buildSkillToolConfig=function(...args){build.apply(this,args);args[3].options=options;};
  assert.equal(dcTone(actor,check),'orange');options={...options,advantage:true};assert.equal(dcTone(actor,check),'');
  options={...options,advantage:false,disadvantage:true};assert.equal(dcTone(actor,check),'red');
});
