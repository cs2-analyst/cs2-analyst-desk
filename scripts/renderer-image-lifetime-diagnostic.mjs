// Same bundled Electron and real archive operations; deliberately not a RAM benchmark.
// node scripts/renderer-image-lifetime-diagnostic.mjs <existing gui-run.json>
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { soakRun } from './library-storage-electron-qa.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const metadata = { kind: 'image-loader-versus-helper-diagnostic', scriptSha256: sha(readFileSync(fileURLToPath(import.meta.url))),
  variants: ['helper-remove', 'helper-empty', 'helper-handlers', 'helper-remove-retained-disposer', 'direct-remove', 'direct-empty', 'direct-handlers'],
  note: 'Small image ownership controls, not artificial heap pressure. The retained-disposer group intentionally keeps only an already-disposed callback to test its captured scope. No GC, snapshot, pressure or object-query commands.' };
const diagnostics = {
  metadata,
  async setup(page, config) {
    const path = Object.keys(config.app.original).find(path => /^renderer\/assets\/index-.*\.js$/.test(path));
    assert.ok(path);
    const bundle = readFileSync(join(config.app.directory, 'dist', ...path.split('/')), 'utf8');
    const start = bundle.indexOf('function mountReplayEffectImages('), end = bundle.indexOf('\nfunction releaseReplayCanvases(', start);
    assert.ok(start >= 0 && end > start, 'Diagnostic requires the exact candidate production helper');
    const helper = bundle.slice(start, end);
    const cleanup = ['image.removeAttribute("src");', 'image.src = "";'].find(code => helper.includes(code));
    assert.ok(cleanup, 'Identify the current production source-clear statement before deriving controls');
    const removeHelper = helper.replace(cleanup, 'image.removeAttribute("src");');
    const emptyHelper = helper.replace(cleanup, 'image.src = "";');
    const handlerHelper = helper.replace(cleanup, '');
    const prefixes = ['smokegrenade', 'flashbang', 'hegrenade', 'molotov', 'incgrenade', 'decoy', 'inferno', 'fire-atlas'];
    const assets = prefixes.map(prefix => {
      const paths = Object.keys(config.app.original).filter(path => path.startsWith(`renderer/assets/${prefix}-`));
      assert.equal(paths.length, 1); return paths[0].slice('renderer/'.length);
    });
    const expression = `(async()=>{
      const urls=Object.fromEntries(${JSON.stringify(assets)}.map((path,index)=>['asset'+index,new URL('./'+path,location.href).href]));
      window.__imageDiagnosticRefs=[];window.__imageDiagnosticDisposers=[];
      const remember=(group,image)=>window.__imageDiagnosticRefs.push({group,ref:new WeakRef(image)});
      const original=(${removeHelper});
      const empty=(${emptyHelper});
      const handlers=(${handlerHelper});
      for(const [group,mount,retain] of [['helper-remove',original,false],['helper-empty',empty,false],['helper-handlers',handlers,false],['helper-remove-retained-disposer',original,true]]){
        await new Promise(resolve=>{let loaded=0;const dispose=mount(urls,(_key,image)=>{
          remember(group,image);if(++loaded===8)queueMicrotask(()=>{dispose();if(retain)window.__imageDiagnosticDisposers.push(dispose);resolve();});
        });});
      }
      for(const mode of ['remove','empty','handlers']){
        let images=[];
        await new Promise(resolve=>{let loaded=0;for(const url of Object.values(urls)){
          const image=new Image();images.push(image);image.onload=()=>{remember('direct-'+mode,image);if(++loaded===8)resolve();};image.src=url;
        }});
        for(const image of images){image.onload=image.onerror=null;if(mode==='remove')image.removeAttribute('src');if(mode==='empty')image.src='';}
        images=[];
      }
      window.__imageDiagnosticState=()=>{
        const groups={};for(const item of window.__imageDiagnosticRefs){
          const row=groups[item.group]??={live:0,dead:0,complete:0,missingSrc:0,emptySrc:0,nonemptySrc:0,nonnullHandlers:0,currentSrcPresent:0};
          const image=item.ref.deref();if(!image){row.dead++;continue;}row.live++;if(image.complete)row.complete++;
          const src=image.getAttribute('src');row[src===null?'missingSrc':src===''?'emptySrc':'nonemptySrc']++;
          if(image.onload||image.onerror)row.nonnullHandlers++;if(image.currentSrc)row.currentSrcPresent++;
        }return {groups,registered:window.__imageDiagnosticRefs.length,retainedDisposedCallbacks:window.__imageDiagnosticDisposers.length};
      };
      return window.__imageDiagnosticState();
    })()`;
    const created = await page.evaluate(expression);
    assert.equal(created.registered, 56); assert.equal(created.retainedDisposedCallbacks, 1);
    console.log(JSON.stringify({ phase: 'image-diagnostic-created', helperSha256: sha(helper), state: created }));
  },
  async sample(page) { return page.evaluate('window.__imageDiagnosticState()'); },
};
assert.ok(process.argv[2], 'Provide an existing owned GUI configuration');
await soakRun(process.argv[2], 'nuke.dem', 1, 3, 1000, 10000, 0, 0, diagnostics);
