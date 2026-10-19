// Real Electron, controlled DTO IPC, actual unmodified ReplayPlayer + Canvas.
// Browser skill absent; user explicitly requires Electron. Reuse repository CDP
// workflow rather than install a web-browser dependency or alter product seams.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync,mkdtempSync,readFileSync,writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { connectCdp,waitFor,withCleanup } from './smoke-runtime.mjs';
import { ProcessScope } from './installed-smoke-lifecycle.mjs';
import { makeFixtures } from './fixtures/replay-all-dead/fixtures.mjs';

const root=resolve('.'),baseline=process.argv.includes('--baseline'),referenceOnly=process.argv.includes('--reference-only'),emptyReferenceProbe=process.argv.includes('--empty-reference-probe');
assert.ok(!referenceOnly||baseline,'--reference-only is for focused baseline reproduction');
assert.ok(!emptyReferenceProbe||referenceOnly,'--empty-reference-probe needs focused baseline mode');
const out=resolve('.tmp/p7-all-dead',emptyReferenceProbe?'baseline-empty-reference':referenceOnly?'baseline-reference':baseline?'baseline':'fixed');mkdirSync(out,{recursive:true});
const require=createRequire(join(root,'apps/desktop/package.json'));
const seed=JSON.parse(readFileSync('.tmp/p7-all-dead/native-spatial-seed.json'));
const inventory=JSON.parse(readFileSync('.tmp/p7-all-dead/native-inventory.json'));
assert.equal(inventory.status,'PASS');assert.equal(inventory.formalAllDead.length,0,'If real formal events exist, run real DEM acceptance first');
assert.equal(inventory.files.filter(f=>f.status==='SCANNED').length,9,'complete current fixture inventory required');
for(const f of inventory.files.filter(f=>f.status==='SCANNED'))assert.equal(f.exactStateCoverage.complete,f.exactStateCoverage.queried,'no unknown death-tick roster: '+f.file);
const fixtures=makeFixtures(seed).filter(f=>!referenceOnly||f.noFloor),fixturePath=join(out,'controlled-fixtures.json');
writeFileSync(fixturePath,JSON.stringify(fixtures));
const {build}=await import(pathToFileURL(require.resolve('vite')).href);
const {default:react}=await import(pathToFileURL(require.resolve('@vitejs/plugin-react')).href);
await build({root:join(root,'scripts/fixtures/replay-all-dead'),configFile:false,base:'./',publicDir:false,
  plugins:[react()],resolve:{alias:{react:join(root,'apps/desktop/node_modules/react'),
    'react-dom':join(root,'apps/desktop/node_modules/react-dom'),'@fluentui/react-components':join(root,'apps/desktop/node_modules/@fluentui/react-components')}},
  build:{outDir:join(out,'harness-dist'),emptyOutDir:true,assetsInlineLimit:0}});

const probeSource=`(()=>{
 const traces=new WeakMap(),proto=CanvasRenderingContext2D.prototype;
 const clear=proto.clearRect,text=proto.fillText;
 proto.clearRect=function(...a){traces.set(this,[]);return clear.apply(this,a);};
 proto.fillText=function(...a){if(/^([1-9]|10)$/.test(String(a[0])))(traces.get(this)??[]).push(String(a[0]));return text.apply(this,a);};
 const pixels=c=>{const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let opaque=0,color=0,h=2166136261;
   for(let i=0;i<d.length;i+=4){if(d[i+3])opaque++;if(d[i+3]&&Math.max(d[i],d[i+1],d[i+2])>24)color++;if(i%64===0)for(let j=0;j<4;j++)h=Math.imul(h^d[i+j],16777619)>>>0;}
   return {width:c.width,height:c.height,opaque,color,hash:h};};
 window.readControlledPaint=()=>{
   const n=document.querySelector('[data-replay-session]');if(!n)return null;
   const c=n.querySelector('canvas[role=img]'),b=n.querySelector('canvas[aria-hidden=true]');if(!c?.dataset.tick)return null;
   let fiber=n[Object.keys(n).find(k=>k.startsWith('__reactFiber$'))];while(fiber&&!fiber.memoizedProps?.metadata)fiber=fiber.return;
   if(!fiber)throw new Error('Replay component missing');const refs=[];
   for(let h=fiber.memoizedState;h;h=h.next)if(h.memoizedState&&typeof h.memoizedState==='object'&&Object.hasOwn(h.memoizedState,'current'))refs.push(h.memoizedState.current);
   const live=refs.find(r=>r?.selectedPlayerId!==undefined),cache=refs.find(r=>r?.entries instanceof Map&&typeof r.put==='function'),clock=refs.find(r=>r?.anchorMs!==undefined);
   const tick=Number(c.dataset.tick),block=live.info.blocks.find(b=>Math.floor(tick)>=b.startTick&&Math.floor(tick)<=b.endTick);
   const buttons=[...n.querySelectorAll('[aria-label=回放玩家状态] button')],selected=buttons.findIndex(b=>b.getAttribute('aria-pressed')==='true');
   const rect=c.getBoundingClientRect();
   return {tick,uiTick:Number(n.dataset.replayTick),block:block?.index,chunkLoaded:!!cache.entries.get('1:'+block?.index),cacheKeys:[...cache.entries.keys()],playing:clock.playing,
     playerId:live.selectedPlayerId,sidebarPlayerId:fiber.memoizedProps.metadata.players[selected]?.id,sidebar:buttons.map(b=>b.textContent),
     baseLayer:b.dataset.layer,layer:live.layerId,floorStatus:c.dataset.floorStatus,imageReady:live.imageReady,
     allDead:c.dataset.allDead,followPlayer:c.dataset.followPlayer,followDeath:c.dataset.followDeath,followCause:c.dataset.followCause,
     drawn:Number(c.dataset.playerCount),markerPaints:traces.get(c.getContext('2d'))??[],effects:Number(c.dataset.effects),smoke:Number(c.dataset.smoke),
     notice:n.querySelector('[data-replay-floor-notice]')?.textContent??'',base:pixels(b),foreground:pixels(c),
     viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height}};
 };
})()`;

const result={schema:'p7-all-dead-controlled-electron-v1',createdAt:new Date().toISOString(),status:'COLLECTING',baseline,
  method:'Standalone sandboxed Electron + test-only IPC DTO → existing ReplayPlayer/load/cache/clock/floor/follow/effects → real Canvas; numeric marker paint trace and actual RGBA readback. No product injection seam changes.',
  realDemElectron:{status:'NOT RUN',reason:'No confirmed all-dead death tick within formal Replay windows in 9 available whitelist DEMs',inventory:'.tmp/p7-all-dead/native-inventory.json'},
  fixtureSha256:createHash('sha256').update(readFileSync(fixturePath)).digest('hex'),runs:[],defects:[]};
for(const [width,height] of [[1024,640],[1920,1032]]){
 const server=createServer();await new Promise(ok=>server.listen(0,'127.0.0.1',ok));const port=server.address().port;await new Promise(ok=>server.close(ok));
 const prefix=join(tmpdir(),'cs2-all-dead-'),profile=mkdtempSync(prefix);
 const env={...process.env,P7_WIDTH:String(width),P7_HEIGHT:String(height),P7_ALL_DEAD_FIXTURES:fixturePath,P7_ALL_DEAD_HTML:join(out,'harness-dist/index.html')};
 delete env.ELECTRON_RUN_AS_NODE;delete env.ELECTRON_RENDERER_URL;
 const startedAt=Date.now();
 const child=spawn(require('electron'),[join(root,'scripts/fixtures/replay-all-dead/main.cjs'),'--remote-debugging-port='+port,'--user-data-dir='+profile,
   '--disable-features=CalculateNativeWinOcclusion','--disable-backgrounding-occluded-windows'],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
 const scope=new ProcessScope();scope.track(child,'controlled all-dead Electron',startedAt);let page,logs='';
 child.stdout.on('data',d=>logs+=d);child.stderr.on('data',d=>logs+=d);
 await withCleanup(async()=>{
  try{
   const target=await waitFor(async()=>{try{return(await(await fetch('http://127.0.0.1:'+port+'/json/list',{signal:AbortSignal.timeout(1000)})).json()).find(t=>t.type==='page');}catch{return null;}},30000,'test Electron');
   page=await connectCdp(target.webSocketDebuggerUrl);const {evaluate,send}=page;
   const exceptions=[],consoleMessages=[];
   page.socket.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.method==='Runtime.exceptionThrown')exceptions.push(m.params);if(m.method==='Runtime.consoleAPICalled'&&['error','warning'].includes(m.params.type))consoleMessages.push(m.params);});
   await send('Runtime.enable');await send('Page.enable');
   await send('Page.addScriptToEvaluateOnNewDocument',{source:probeSource});await send('Page.reload');
   const wait=(probe,label)=>waitFor(probe,30000,label,{intervalMs:50,diagnostics:async()=>({logs:logs.slice(-2000),state:await evaluate('window.readControlledPaint?.()'),text:await evaluate('document.body.innerText'),exceptions})});
   await wait(()=>evaluate('typeof window.mountControlledReplay==="function"'),'test React ready');
   const read=()=>evaluate('window.readControlledPaint()');
   const seek=async tick=>{
     await evaluate(`(()=>{const s=document.querySelector('[aria-label=回放进度]'),set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;for(const v of [${tick}-1,${tick}]){set.call(s,v);s.dispatchEvent(new Event('input',{bubbles:true}));}})()`);
     await wait(async()=>{const s=await read();return s&&Math.abs(s.tick-tick)<.01&&s.chunkLoaded;},'actual slider Seek '+tick);await delay(130);return read();
   };
   const choose=async value=>{
     await evaluate('document.querySelector("[aria-label=回放楼层]").click()');
     await wait(()=>evaluate(`Boolean([...document.querySelectorAll('[role=option]')].find(o=>o.checkVisibility()&&o.textContent.trim()===${JSON.stringify(value)}))`),'floor option');
     await evaluate(`[...document.querySelectorAll('[role=option]')].find(o=>o.checkVisibility()&&o.textContent.trim()===${JSON.stringify(value)}).click()`);await delay(150);
   };
   const pause=async()=>{await evaluate('document.querySelector("[aria-label=暂停回放]")?.click()');await delay(130);};
   for(const fixture of fixtures){
     const run={id:fixture.id,viewport:{width,height},provenance:fixture.provenance,status:'COLLECTING',states:[],screenshots:[]};result.runs.push(run);
     const capture=async label=>{const state=await read(),file=join(out,`${width}x${height}-${fixture.id}-${label}.png`);
       writeFileSync(file,Buffer.from((await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false})).data,'base64'));
       run.screenshots.push({label,file,state});return state;};
     await evaluate(`window.mountControlledReplay(${JSON.stringify(fixture.id)})`);
     await wait(async()=>{const s=await read();return s?.tick===18000&&s.chunkLoaded&&s.viewport.width===width;},'fixture mounted');
     if(fixture.noFloor){
       const cold=await read();assert.equal(cold.layer,null);assert.equal(cold.base.opaque,0);assert.equal(cold.floorStatus,'unknown');
       run.noEvidenceCold=cold;
       if(!baseline||emptyReferenceProbe){
         await seek(fixture.deathTick);const empty=await capture('cold-all-dead');run.noEvidenceAllDead=empty;
         assert.equal(empty.allDead,'true');assert.equal(empty.drawn,0);assert.deepEqual(empty.markerPaints,[]);
         if(!empty.base.color){
           result.defects.push({id:'cold-all-dead-no-background',state:empty,
             reproduction:'fresh session with all XYZ null and no historical floors → directly Seek all-dead tick in auto mode',
             rootCause:'allDead background depends solely on reliable history or a previously drawn texture; neither exists on a fresh unknown-floor session',
             scope:'ReplayPlayer background-only fallback to the first available reference texture when allDead is confirmed; explicitly not current-floor evidence; no XYZ/follow resolver changes'});
           if(!baseline)assert.fail('confirmed all-dead must retain or show an explicitly non-spatial reference texture');
         }else{
           assert.equal(empty.floorStatus,'retained');assert.equal(empty.layer,fixture.expectedLayer);
           assert.ok(empty.base.color>empty.base.width*empty.base.height*.1);assert.match(empty.notice,/仅作参考.*不代表当前楼层/);
         }
         const reverse=await seek(18000);run.reverseFromNoEvidenceAllDead=reverse;
         assert.equal(reverse.allDead,'false');assert.equal(reverse.layer,null);assert.equal(reverse.floorStatus,'unknown');
         assert.equal(reverse.base.opaque,0,'reference texture cannot become reliable history for an unlocated living player');
       }
       // A user-chosen reference texture is not reliable spatial evidence.
       await choose(fixture.expectedLayer==='lower'?'下层':'主层');
     }else await wait(async()=>(await read())?.imageReady,'real radar loaded');
     const before=await seek(fixture.deathTick-24);await capture('before');
     assert.ok(before.base.color>before.base.width*before.base.height*.1,'actual visible non-black radar before death');
     assert.ok(fixture.noFloor||before.drawn>0,'actual living player drawn before death');
     assert.equal(before.allDead,'false');
     await seek(fixture.deathTick);if(fixture.noFloor){
       const manual=await capture('manual-reference-death');
       if(!/仅作参考.*不代表当前楼层/.test(manual.notice)){
         result.defects.push({id:'manual-reference-provenance',state:manual,
           reproduction:'fresh no-floor DTO → manually choose reference texture → final unknown death, remain in manual mode',
           rootCause:'floor notice is gated by auto mode, so manual reference has no spatial disclaimer',
           scope:'Only all-dead map notice condition/text in replay-player.tsx'});
         if(!baseline)assert.fail('manual all-dead reference must disclaim current-floor evidence');
       }
       await choose('跟随玩家');
     }
     const death=await capture('death');
     const assertDead=(s,committed=true)=>{
       assert.equal(s.allDead,'true');assert.equal(s.drawn,0);assert.deepEqual(s.markerPaints,[],'no numeric living-player glyph painted');
       assert.equal(s.playerId,fixture.anchor);assert.equal(s.followPlayer,fixture.anchor);assert.equal(s.sidebarPlayerId,fixture.anchor);
       // Canvas paints every RAF; the existing sidebar commits on the 100ms UI
       // cadence. Check its own committed tick, then separately check stable shots.
       if(committed)assert.ok(s.sidebar.every(t=>t.includes('阵亡')),'all settled sidebar rows dead');
       assert.equal(s.layer,fixture.expectedLayer);assert.equal(s.baseLayer,fixture.expectedLayer);assert.equal(s.floorStatus,'retained');assert.equal(s.imageReady,true);
       assert.ok(s.base.color>s.base.width*s.base.height*.1,'actual colored map pixels, not DOM existence');
       assert.equal(s.base.hash,before.base.hash,'actual correct texture retained');
       assert.ok(s.rect.width>200&&s.rect.height>200&&s.rect.x>=0&&s.rect.y>=0&&s.rect.x+s.rect.width<=width&&s.rect.y+s.rect.height<=height,'Canvas visible in viewport');
       if(committed){assert.match(s.notice,/全员阵亡/);assert.doesNotMatch(s.notice,/请手动选层/);}
       assert.equal(s.followCause,fixture.id==='suicide'?'suicide':fixture.id==='posthumous-he'?'kill':'unknown');
     };
     assertDead(death);assert.equal(death.smoke,1);assert.ok(death.foreground.opaque>0,'real utility pixels after players die');
     // A background without any reliable floor must explicitly disclaim spatial meaning.
     if(fixture.noFloor&&!/仅作参考.*不代表当前楼层/.test(death.notice)){
       result.defects.push({id:'reference-map-provenance',viewport:{width,height},state:death,
         reproduction:'fresh no-floor DTO → choose reference floor manually → final unknown death → follow-player mode',
         rootCause:'all-dead retained notice calls a manually chosen texture reliable without disclosing that it is not current spatial evidence',
         scope:'Only retained all-dead floor notice text in replay-player.tsx; no follow/floor behavior changes'});
       if(!baseline)assert.fail('reference background must explicitly disclaim current-floor evidence');
     }
     for(const tick of [18400,18400,18401,18496,18500,18376,18400,18900,18400,18376,18400]){
       const state=await seek(tick);if(tick>=18400)assertDead(state);else{assert.equal(state.allDead,'false');assert.equal(state.playerId,fixture.anchor);}
       if(tick===18500){assert.equal(state.smoke,0);assert.equal(state.foreground.opaque,0,'no stale utility, corpse or invented player point');}
       run.states.push(state);
     }
     const same=run.states.filter(s=>s.tick===18400).map(s=>({layer:s.layer,hash:s.base.hash,foreground:s.foreground.hash,player:s.playerId,drawn:s.drawn,smoke:s.smoke}));
     assert.ok(same.every(s=>JSON.stringify(s)===JSON.stringify(same[0])),'same tick identical actual pixels and identity');
     // Force eviction using normal UI, then direct-seek into the uncached death block.
     await seek(19000);await delay(500);const coldBefore=await read();assert.ok(!coldBefore.cacheKeys.includes('1:3'));
     const coldAfter=await seek(18400);assertDead(coldAfter);run.coldSeek={before:coldBefore,after:coldAfter};
     await seek(18360);
     if(fixture.noFloor)await choose(fixture.expectedLayer==='lower'?'下层':'主层');
     await evaluate(`window.controlledFrames=[];window.controlledObserver=new MutationObserver(()=>window.controlledFrames.push(window.readControlledPaint()));window.controlledObserver.observe(document.querySelector('canvas[role=img]'),{attributes:true,attributeFilter:['data-tick']});document.querySelector('[aria-label=播放回放]').click();`);
     await wait(async()=>(await read()).tick>=18432,'natural death and chunk crossing');await pause();
     const paused=await read();assert.equal(paused.playing,false);await delay(200);assert.equal((await read()).tick,paused.tick);
     if(fixture.noFloor)await choose('跟随玩家');
     assertDead(await read());
     await evaluate('document.querySelector("[aria-label=播放回放]").click()');
     await wait(async()=>(await read()).tick>=18560,'resume across next chunk');await pause();
     const frames=await evaluate('window.controlledObserver.disconnect();window.controlledFrames');
     writeFileSync(join(out,`${width}x${height}-${fixture.id}-frames.json`),JSON.stringify(frames,null,2));
     assert.ok(frames.some(s=>s.tick<18400)&&frames.some(s=>s.tick>=18400));
     assert.ok(new Set(frames.filter(s=>s.chunkLoaded).map(s=>s.block)).size>=3,'actual playback crossed multiple chunks');
     for(const state of frames.filter(s=>s.chunkLoaded)){
       assert.ok(state.base.color>state.base.width*state.base.height*.1,'no transient black radar');
       if(state.tick>=18400){
         // Manual reference mode during no-evidence playback is intentional until auto mode is restored.
         if(fixture.noFloor&&state.floorStatus==='manual'){
           assert.equal(state.drawn,0);assert.deepEqual(state.markerPaints,[]);assert.equal(state.playerId,fixture.anchor);
           if(!baseline&&state.uiTick>=18416)assert.match(state.notice,/仅作参考.*不代表当前楼层/);
         }
         else assertDead(state,false);
       }
     }
     run.playback={samples:frames.length,blocks:[...new Set(frames.map(s=>s.block))],pause:paused};
     await seek(18560);const after=await capture('after');assertDead(after);assert.equal(after.foreground.opaque,0);run.status='PASS';
     console.log(JSON.stringify({id:run.id,viewport:run.viewport,status:run.status,samples:frames.length}));
   }
   result.page=await evaluate('({url:location.href,title:document.title,text:document.body.innerText,overlay:Boolean(document.querySelector("vite-error-overlay"))})');
   assert.match(result.page.url,/harness-dist\/index.html$/);assert.match(result.page.title,/controlled all-dead/);assert.match(result.page.text,/比赛回放/);assert.equal(result.page.overlay,false);
   assert.deepEqual(exceptions,[]);const unexpected=consoleMessages.filter(m=>!m.args.some(a=>a.value?.includes?.('Electron Security Warning (Insecure Content-Security-Policy)')));
   assert.deepEqual(unexpected,[]);result.consoleHealth={exceptions,unexpected};
   await evaluate('window.acceptance.close()').catch(()=>{});await wait(()=>child.exitCode!==null,'test Electron exit');assert.equal(child.exitCode,0);
  }catch(error){result.status='FAIL';result.error={message:error.message,stack:error.stack};throw error;}
 },[()=>{writeFileSync(join(out,'electron.json'),JSON.stringify(result,null,2));writeFileSync(join(out,`${width}x${height}-electron.log`),logs);},()=>page?.socket.close(),()=>scope.cleanup(),
   async()=>{assert.ok(resolve(profile).startsWith(resolve(prefix)));await rm(profile,{recursive:true,force:true,maxRetries:8,retryDelay:250});}]);
}
result.status=baseline&&result.defects.length?'BASELINE DEFECT REPRODUCED':'PASS';writeFileSync(join(out,'electron.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({status:result.status,runs:result.runs.length,defects:result.defects.length,out}));
