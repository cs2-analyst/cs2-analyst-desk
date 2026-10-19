// Verify the test harness is outside every production input/output and installer root.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync,readFileSync,writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join,relative,resolve } from 'node:path';
const root=resolve('.'),require=createRequire(import.meta.url);
const config=require('../apps/desktop/electron-builder.config.cjs');
assert.deepEqual(config.files,['dist/**','package.json','!node_modules/**','!**/*.map']);
assert.deepEqual(config.extraResources,[{from:'resources/branding/cs2-analyst-mark.png',to:'branding/cs2-analyst-mark.png'}]);
const vite=readFileSync('apps/desktop/electron.vite.config.ts','utf8');
assert.ok(!vite.includes('replay-all-dead')&&!vite.includes('scripts/fixtures'));
const markers=['P7 controlled all-dead Replay acceptance','测试专用受控 DTO','acceptance:fixture','P7_ALL_DEAD_FIXTURES','controlled-test-only.dto'];
const files=[];
function walk(dir){for(const entry of readdirSync(dir,{withFileTypes:true})){
  const file=join(dir,entry.name);if(entry.isDirectory())walk(file);else{
    assert.ok(!file.includes('replay-all-dead'));const bytes=readFileSync(file);
    if(/\.(js|cjs|html|json)$/.test(file))for(const marker of markers)assert.ok(!bytes.includes(Buffer.from(marker)),'test marker leaked: '+file+' '+marker);
    files.push({file:relative(root,file).replaceAll('\\','/'),bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
  }
}}
walk(resolve('apps/desktop/dist'));assert.ok(files.length>10);
writeFileSync('.tmp/p7-all-dead/package-isolation.json',JSON.stringify({schema:'p7-all-dead-package-isolation-v1',status:'PASS',
  scope:'Production build outputs and current installer whitelist; no installer generated this round',
  installerFiles:config.files,extraResources:config.extraResources,excludedHarnessRoot:'scripts/fixtures/replay-all-dead',
  excludedOutputRoot:'.tmp/p7-all-dead',markers,files},null,2)+'\n');
console.log(JSON.stringify({status:'PASS',productionFiles:files.length,testHarnessIncluded:false,installerBuilt:false}));
