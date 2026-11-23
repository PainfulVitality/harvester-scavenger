import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';

test('UI protection stays synchronized with module-owned styles and loads before other module layers',async()=>{
  const base=await readFile(new URL('../styles/harvest.css',import.meta.url));
  const shield=await readFile(new URL('../styles/ui-isolation.css',import.meta.url),'utf8');
  const manifest=JSON.parse(await readFile(new URL('../module.json',import.meta.url)));
  assert.ok(shield.includes(createHash('sha256').update(base).digest('hex')),'Regenerate UI protection with python tools/build_ui_isolation.py');
  assert.deepEqual(manifest.styles,['styles/ui-isolation.css','styles/harvest.css']);
  assert.ok(shield.includes('@layer harvest-owned-ui'));
  assert.ok(shield.indexOf('@layer overrides')<shield.indexOf('@layer defaults'));
});

test('UI protection retains tone colors, neutral fallback and native checkbox glyph protection',async()=>{
  const shield=await readFile(new URL('../styles/ui-isolation.css',import.meta.url),'utf8');
  for(const tone of ['green','orange','red'])assert.ok(shield.includes(`[data-dc-tone="${tone}"]`));
  assert.ok(shield.includes('color: inherit !important'));
  assert.ok(shield.includes('appearance: auto !important'));
  assert.ok(shield.includes('content: none !important'));
  assert.ok(shield.includes('--crlngn-font-family: var(--harvest-font) !important'));
});
