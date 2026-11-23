import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const source=readFileSync(new URL('../scripts/windows.mjs',import.meta.url),'utf8');
const code=source.slice(source.indexOf('const refreshScenes ='),source.indexOf('export function closeHarvest')).replaceAll('export function','function');
function harness(){
  const calls=[],errors=[];
  const apps=new Map(['one','two'].map(scene=>[scene,{token:{parent:{id:scene}},refresh:async()=>{calls.push(scene);}}]));
  const configWindows=new Map();
  const context=vm.createContext({playerWindows:apps,configWindows,queueMicrotask,report:error=>errors.push(error)});
  vm.runInContext(code,context);
  return {calls,errors,apps,configWindows,refresh:vm.runInContext('refreshInteractions',context),settings:vm.runInContext('refreshSettings',context)};
}
const flush=()=>new Promise(resolve=>setImmediate(resolve));

test('rapid effect and actor notifications refresh each window once per microtask',async()=>{
  const h=harness();for(let i=0;i<20;i++)h.refresh();assert.deepEqual(h.calls,[]);
  await flush();assert.deepEqual(h.calls,['one','two']);
  h.refresh();await flush();assert.deepEqual(h.calls,['one','two','one','two']);
});

test('scene refreshes merge, while a global actor/effect update refreshes every scene',async()=>{
  const h=harness();h.refresh('one');h.refresh('one');await flush();assert.deepEqual(h.calls,['one']);
  h.refresh('one');h.refresh('two');await flush();assert.deepEqual(h.calls,['one','one','two']);
  h.refresh('one');h.refresh();await flush();assert.deepEqual(h.calls,['one','one','two','one','two']);
});

test('refresh failures are handled and do not break future updates',async()=>{
  const h=harness();h.apps.get('one').refresh=async()=>{throw new Error('Window temporarily unavailable');};
  h.refresh();await flush();assert.equal(h.errors.length,1);assert.deepEqual(h.calls,['two']);
  h.apps.delete('one');h.refresh();await flush();assert.deepEqual(h.calls,['two','two']);
});


test('currency-related settings refresh configuration metadata without discarding drafts',async()=>{
 const h=harness();let rendered=0;const draft={currency:'unsaved'};h.configWindows.set('config',{rendered:true,draft,redraw:async()=>{rendered++;}});
 for(let i=0;i<10;i++)h.settings();await flush();assert.equal(rendered,1);assert.equal(h.configWindows.get('config').draft,draft);assert.deepEqual(h.calls,['one','two']);
});
