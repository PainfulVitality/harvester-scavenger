import test from 'node:test';
import assert from 'node:assert/strict';
import { currencyDefinition, currencyDefinitions, validateCurrencyEntries, collectCurrency, prepareCurrency, grantCurrency } from '../scripts/currency.mjs';
import { defaultRules, normalizeRules, evaluateHarvest, defaultState, validateRules } from '../scripts/rules.mjs';
import { rewardPreview } from '../scripts/rewards.mjs';

const definitions={gp:{label:'Gold',conversion:1},sp:{label:'Silver',conversion:10},credits:{label:'Credits',abbreviation:'Cr',icon:'fa-solid fa-gem',fractionalDigits:2,conversion:0.5}};
function setup(extra={}) {
 const config=structuredClone({...definitions,...extra});
 const field={getInitialValue:()=>0,min:0,integer:false};
 const mapping={initialKeys:config,initialKeysOnly:true};
 const schema={getField:path=>path==='currency'?mapping:Object.hasOwn(config,path.slice(9))?field:null};
 globalThis.CONFIG={DND5E:{currencies:config},Actor:{dataModels:{character:{schema}}}};
 globalThis.game={i18n:{localize:value=>value}};
 return {config,field,mapping,schema};
}
function actor(wallet={gp:10,sp:0,credits:1.25},hook) {
 const {schema}=setup();const raw=structuredClone(wallet);
 return {system:{schema,currency:{...raw}},_source:{system:{currency:raw}},async update(updates,options){
   this.options=options;const changes=Object.fromEntries(Object.entries(updates).map(([key,value])=>[key.slice(16),value]));
   if(hook)return hook.call(this,changes);
   Object.assign(raw,changes);Object.assign(this.system.currency,changes);return this;
 }};
}
const entry=(denomination,quantity,extra={})=>({denomination,quantity,randomQuantity:false,...extra});
const source=(...currency)=>({items:[],tables:[],currency});

test('current system names, icons, precision, and custom denominations drive rows',()=>{
 const {config}=setup();config.gp.label='Crowns';
 assert.equal(currencyDefinition('gp').name,'Crowns');
 const credits=currencyDefinitions().find(def=>def.key==='credits');assert.equal(credits.step,0.01);assert.equal(credits.img,'');assert.equal(credits.icon,'fa-solid fa-gem');assert.equal(credits.supported,true);
 config.credits.icon='icons/custom.svg';assert.equal(currencyDefinition('credits').img,'icons/custom.svg');
});
for(const denomination of ['__proto__','constructor','prototype','gp.foo','../gp','gp[0]','gp\\x','gp\n','']) test(`unsafe denomination ${JSON.stringify(denomination)} is rejected`,()=>{
 setup();assert.throws(()=>validateCurrencyEntries([entry(denomination,1)]));
});
for(const quantity of [-1,NaN,Infinity,'4',null,undefined,Number.MAX_SAFE_INTEGER+1]) test(`invalid amount ${String(quantity)} is rejected`,()=>{
 setup();assert.throws(()=>validateCurrencyEntries([entry('gp',quantity)]));
});
test('invalid arrays, ranges, and amount modes are rejected',()=>{
 setup();for(const value of [null,{},Array(101).fill(entry('gp',1))])assert.throws(()=>validateCurrencyEntries(value));
 for(const extra of [{randomQuantity:'true'},{randomQuantity:true,minQuantity:3,maxQuantity:2},{randomQuantity:true,minQuantity:-1,maxQuantity:3}])assert.throws(()=>validateCurrencyEntries([entry('gp',1,extra)]));
});
test('legacy reward sources migrate without mutating original data',()=>{
 setup();const old={base:{items:[],tables:[]},thresholds:[{above:15,double:false,items:[],tables:[]}]};const migrated=normalizeRules(old);
 assert.deepEqual(migrated.base.currency,[]);assert.deepEqual(migrated.thresholds[0].currency,[]);assert.equal(old.base.currency,undefined);
 assert.throws(()=>validateRules({...defaultRules(),base:{items:[],tables:[],currency:null}}));
});
test('fixed currencies aggregate across sources and share reward multipliers',async()=>{
 const recipient=actor();assert.deepEqual(await collectCurrency([source(entry('credits',0.1),entry('gp',2)),source(entry('credits',0.2))],2,recipient),[{denomination:'credits',quantity:0.6},{denomination:'gp',quantity:4}]);
});
test('currency shares threshold and alternate reward selection',async()=>{
 const recipient=actor();const rules={...defaultRules(),critical:'yes',base:source(entry('gp',1)),thresholds:[{above:15,double:true,...source(entry('gp',2))}]};
 const result=evaluateHarvest(rules,defaultState(),{total:21,natural:20},false,true);
 assert.deepEqual(await collectCurrency(result.sources,result.multiplier,recipient),[{denomination:'gp',quantity:12}]);
 rules.critical='reward';rules.criticalRewards=source(entry('credits',3.5));const alternate=evaluateHarvest(rules,defaultState(),{total:21,natural:20},false,true);
 assert.deepEqual(await collectCurrency(alternate.sources,alternate.multiplier,recipient),[{denomination:'credits',quantity:3.5}]);
});
test('decimal random ranges use native rolls and include both endpoints',async()=>{
 const recipient=actor();let formula;globalThis.Roll=class{constructor(text){formula=text;}async evaluate(){return {total:125};}};
 const ranges=[source(entry('credits',1,{randomQuantity:true,minQuantity:1.25,maxQuantity:1.5}))];
 assert.deepEqual(await collectCurrency(ranges,1,recipient),[{denomination:'credits',quantity:1.25}]);assert.equal(formula,'1d26 + 124');
 globalThis.Roll=class{async evaluate(){return {total:150};}};assert.equal((await collectCurrency(ranges,1,recipient))[0].quantity,1.5);
 globalThis.Roll=class{async evaluate(){return {total:151};}};await assert.rejects(collectCurrency(ranges,1,recipient));
});
test('equal and zero ranges need no roll; removed zero rewards do not block',async()=>{
 const recipient=actor();globalThis.Roll=class{constructor(){throw Error('unnecessary roll');}};
 assert.deepEqual(await collectCurrency([source(entry('credits',1,{randomQuantity:true,minQuantity:2.5,maxQuantity:2.5}),entry('removed',0))],1,recipient),[{denomination:'credits',quantity:2.5}]);
 assert.deepEqual(await collectCurrency([source(entry('credits',1,{randomQuantity:true,minQuantity:0,maxQuantity:0}))],1,recipient),[]);
});
test('removed denominations remain editable but cannot be delivered',async()=>{
 const recipient=actor();delete CONFIG.DND5E.currencies.credits;
 assert.equal(validateCurrencyEntries([entry('credits',1)])[0].denomination,'credits');
 await assert.rejects(collectCurrency([source(entry('credits',1))],1,recipient));
});
test('schema support and current precision are checked before delivery',async()=>{
 const recipient=actor();recipient.system.schema.getField('currency').initialKeys=Object.keys(CONFIG.DND5E.currencies);CONFIG.DND5E.currencies.extra={label:'Extra'};
 assert.equal(currencyDefinition('extra',recipient).supported,false);
 await assert.rejects(collectCurrency([source(entry('gp',0.5))],1,recipient));
 CONFIG.DND5E.currencies.credits.fractionalDigits=1;await assert.rejects(collectCurrency([source(entry('credits',0.25))],1,recipient));
});
test('unrestricted and high-precision definitions support simple amounts safely',async()=>{
 const recipient=actor();CONFIG.DND5E.currencies.credits.fractionalDigits=Infinity;
 assert.equal((await collectCurrency([source(entry('credits',0.1234))],1,recipient))[0].quantity,0.1234);
 CONFIG.DND5E.currencies.credits.fractionalDigits=20;
 assert.equal((await collectCurrency([source(entry('credits',2))],1,recipient))[0].quantity,2);
});
test('overflow and unsupported custom storage stop before a document update',async()=>{
 const recipient=actor({gp:Number.MAX_SAFE_INTEGER,credits:0});assert.throws(()=>prepareCurrency(recipient,[entry('gp',1)]));
 recipient._source.system.currency.gp={value:1};assert.throws(()=>prepareCurrency(recipient,[entry('gp',1)]));
 await assert.rejects(collectCurrency([source(entry('gp',Number.MAX_SAFE_INTEGER))],2,recipient));
});
test('native numeric field limits are respected',()=>{
 const recipient=actor();const field=recipient.system.schema.getField('currency.gp');field.max=10;
 assert.throws(()=>prepareCurrency(recipient,[entry('gp',1)]));
});
test('document updates use raw stored amounts and preserve unrelated denominations',async()=>{
 const recipient=actor();recipient.system.currency.gp=1000;
 const rows=await grantCurrency(recipient,[entry('gp',2),entry('credits',0.25)],'award');
 assert.deepEqual(recipient._source.system.currency,{gp:12,sp:0,credits:1.5});assert.equal(rows[1].name,'Credits');assert.equal(recipient.options.harvestInteractionId,'award');
});
test('an update hook can convert the award using current system conversion rates',async()=>{
 const recipient=actor({gp:10,sp:0,credits:0},function(changes){this._source.system.currency.sp+=(changes.gp-10)*10;return this;});
 await grantCurrency(recipient,[entry('gp',2)],'convert');assert.equal(recipient._source.system.currency.sp,20);
});
test('vetoed, incomplete, and non-equivalent updates are detected without retry',async()=>{
 for(const mode of ['veto','unchanged','partial','unrelated']){
  let calls=0;const recipient=actor({gp:10,sp:0,credits:0},function(){calls++;if(mode==='veto')return undefined;if(mode==='partial')this._source.system.currency.gp++;if(mode==='unrelated')this._source.system.currency.sp=1;return this;});
  await assert.rejects(grantCurrency(recipient,[entry('gp',2)],'veto'));assert.equal(calls,1);
 }
});
test('non-convertible custom currency verifies exact balances',async()=>{
 const recipient=actor();delete CONFIG.DND5E.currencies.credits.conversion;await grantCurrency(recipient,[entry('credits',0.25)],'custom');assert.equal(recipient._source.system.currency.credits,1.5);
});
test('small decimal awards cannot be silently lost in very large wallets',async()=>{
 const recipient=actor({gp:100000000000000,credits:0},function(){return this;});await assert.rejects(grantCurrency(recipient,[entry('credits',0.01)],'tiny'));
});
test('currency-only previews hide amounts and denominations until explicitly revealed',async()=>{
 setup();const rules={...defaultRules(),base:source(entry('credits',1.25))};
 const hidden=await rewardPreview(rules);assert.deepEqual(hidden.currency,[{unknown:true,name:'Unknown currency'}]);assert.deepEqual(hidden.items,[]);assert.equal(JSON.stringify(hidden).includes('1.25'),false);
 rules.revealCurrency=true;const shown=await rewardPreview(rules);assert.equal(shown.currency[0].name,'Credits');assert.equal(shown.currency[0].amountLabel,'1.25');
});

test('derived bonuses on an absent stored denomination are not counted twice',async()=>{
 const recipient=actor({gp:10});recipient.system.currency.credits=20;
 await grantCurrency(recipient,[entry('credits',0.25)],'derived');assert.equal(recipient._source.system.currency.credits,0.25);
});

test('a hidden former fixed amount does not invalidate a new random range',async()=>{
 const recipient=actor();assert.deepEqual(await collectCurrency([source(entry('gp',1.25,{randomQuantity:true,minQuantity:2,maxQuantity:2}))],1,recipient),[{denomination:'gp',quantity:2}]);
});
