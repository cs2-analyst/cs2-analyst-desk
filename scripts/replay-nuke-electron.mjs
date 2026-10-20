// Real built Electron S0 diagnosis. Reuses the repository's CDP/process lifecycle helpers.
// Browser plugin skill absent; existing Electron e2e/CDP workflow is used (no new dependency).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { closeApp, connectCdp, waitFor, withCleanup } from './smoke-runtime.mjs';
import { ProcessScope } from './installed-smoke-lifecycle.mjs';
import { replayDisplayFrame } from '../apps/desktop/renderer/src/replay-state.ts';
import { resolveReplayFollow } from '../apps/desktop/renderer/src/replay-follow.ts';
import { resolveMapLayer, worldToRadar } from '../apps/desktop/shared/replay-map-geometry.ts';
import { explainFrame, explainPlayer, summarizeObservedFrames } from './replay-diagnosis-core.mjs';
import { auditFloorContinuity } from './replay-floor-audit.mjs';
import { replayMapDefinitions } from '../apps/desktop/shared/replay-map-geometry.ts';

const s1 = process.argv.includes('--s1'),lifecycleOnly=process.argv.includes('--lifecycle-only');
assert.ok(!lifecycleOnly||s1,'--lifecycle-only requires --s1');
const input = resolve('.tmp/p7-nuke-s0'), sequencesOnly = process.argv.includes('--sequences'), fullOnly = process.argv.includes('--full-only');
const destination=s1?resolve('.tmp/p7-nuke-s1'):input;
const out = sequencesOnly ? join(destination, 'sequences') : lifecycleOnly?join(destination,'lifecycle'):destination; mkdirSync(out, { recursive: true });
const source = JSON.parse(readFileSync(join(input, 'source.json')));
// Explicit expected handoff resolver; this is checked against IPC source facts below,
// not against the Canvas' self-reported follow/floor labels alone.
function choose(ids, seed) {
  const candidates = [...new Set(ids)].sort();
  if (!candidates.length) return null;
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++) hash = Math.imul(hash ^ seed.charCodeAt(i), 16777619) >>> 0;
  return candidates[hash % candidates.length];
}
const fixture = resolve('.demo/nuke.dem'), digest = createHash('sha256');
for await (const chunk of createReadStream(fixture)) digest.update(chunk);
assert.equal(digest.digest('hex'), source.sha256, 'Fixture changed after native audit');
const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const server = createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port; await new Promise(r => server.close(r));
const prefix = join(tmpdir(), 'cs2-s0-nuke-'), profile = mkdtempSync(prefix);
const env = { ...process.env, NODE_PATH: '', CS2_ANALYST_TEST_DEM_PATH: fixture, CS2_ANALYST_DEM_PATH: fixture };
delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
const scope = new ProcessScope(), start = Date.now();
const child = spawn(require('electron'), ['.', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows'],
{ cwd: resolve('apps/desktop'), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
scope.track(child, 'S0 Nuke Electron', start);
let page, log = '', result = { schema: s1?'p7-s1-electron-v1':'p7-s0-electron-v1', fixtureSha256: source.sha256,
  measurement: sequencesOnly ? 'Visual sequence run includes pixel readback/CDP screenshot overhead; exclude from quantitative timing aggregates'
    : 'MutationObserver after actual Canvas paint; QA React/decision reads add overhead, no uninstrumented FPS claim',
  runs: [], screenshots: [], checks: {} };
if(fullOnly){
  const previous=JSON.parse(readFileSync(join(destination,'electron.json')));
  result={...previous,runs:previous.runs.filter(r=>r.label!=='full-r1-r2-auto-1'),status:'COLLECTING',
    attempts:[...(previous.attempts??[]),{status:'FAILED',scope:'Initial full R1/R2 trace retrieval',
      reason:'CDP connection closed on one-shot Runtime.evaluate(window.__s0.frames); successful 45 matrix and two boundary runs retained. Retry drains bounded batches.'}]};
}
child.stdout.on('data', d => log += d); child.stderr.on('data', d => log += d);
await withCleanup(async () => {
  await scope.live();
  const target = await waitFor(async () => {
    try { return (await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) })).json()).find(t => t.type === 'page'); }
    catch { return null; }
  }, 30000, 'S0 CDP');
  page = await connectCdp(target.webSocketDebuggerUrl);
  const evaluate = page.evaluate;
  await page.send('Runtime.enable'); await page.send('Page.enable');
  const exceptions = [];
  page.socket.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params); });
  await waitFor(() => evaluate('Boolean(window.cs2Analyst && document.querySelector("main"))'), 30000, 'React/preload');
  await page.send('Network.enable');
  await page.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  const importStart=Date.now();
  await evaluate('[...document.querySelectorAll("button")].find(b=>b.textContent.includes("选择 DEM")).click()');
  await waitFor(() => evaluate('document.querySelector("main")?.dataset.status === "success"'), 120000, 'Nuke import');
  result.importMs = Date.now() - importStart;
  result.processMemory=(await scope.live()).map(p=>({pid:p.pid,role:p.commandLine?.includes('node.mojom.NodeService')?'utility':'other',peak:p.peakWorkingSet,workingSet:p.workingSet}));
  const opened=Date.now();
  await evaluate('document.getElementById("replay-tab").click()');
  await waitFor(() => evaluate(`Boolean(document.querySelector('#replay-panel canvas[role=img]')?.dataset.tick)&&document.querySelector('[data-replay-session]')?.dataset.replayMapReady==='true'`), 30000, 'Replay canvas');
  result.firstFrameMs=Date.now()-opened;
  // QA reads current React tree; no state dispatch, cache access mutation, protocol or production edit.
  await evaluate(`(() => {
    const replayDisplayFrame=${replayDisplayFrame.toString()}, resolveMapLayer=${resolveMapLayer.toString()}, worldToRadar=${worldToRadar.toString()};
    const choose=${choose.toString()}, resolveReplayFollow=${resolveReplayFollow.toString()};
    const explainPlayer=${explainPlayer.toString()}, explainFrame=${explainFrame.toString()};
    window.__s0={frames:[],requests:[],record:false,ids:new WeakMap(),nextId:1};
    const identity=o=>{if(!window.__s0.ids.has(o))window.__s0.ids.set(o,window.__s0.nextId++);return window.__s0.ids.get(o);};
    window.__s0Read=()=>{
      const node=document.querySelector('[data-replay-session]');if(!node)return null;
      let root=node[Object.keys(node).find(k=>k.startsWith('__reactFiber$'))];while(root?.return)root=root.return;
      const visit=f=>!f?null:f.memoizedProps?.metadata?.sessionId&&f.memoizedProps?.initialPlayerId!==undefined?f:visit(f.child)||visit(f.sibling);
      const fiber=visit(root.stateNode.current);if(!fiber)throw new Error('Replay fiber not found');
      const hooks=[];for(let h=fiber.memoizedState;h;h=h.next)hooks.push(h.memoizedState);
      const refs=hooks.filter(h=>h&&typeof h==='object'&&Object.hasOwn(h,'current'));
      const live=refs.find(r=>r.current?.selectedPlayerId!==undefined)?.current;
      const cache=refs.find(r=>r.current?.entries instanceof Map&&typeof r.current.put==='function')?.current;
      const clock=refs.find(r=>r.current?.anchorMs!==undefined)?.current;
      const anchor=refs.find(r=>r.current?.sessionId&&typeof r.current?.playerId==='string')?.current;
      if(!live||!cache||!clock||!anchor)throw new Error('Replay refs not found');
      const canvas=document.querySelector('#replay-panel canvas[role=img]'),at=Number(canvas.dataset.tick),meta=fiber.memoizedProps.metadata;
      const block=live.info.blocks.find(b=>Math.floor(at)>=b.startTick&&Math.floor(at)<=b.endTick);
      const chunk=block?cache.entries.get(live.info.round+':'+block.index):null;
      const index=meta.players.findIndex(p=>p.id===live.selectedPlayerId);
      const base=document.querySelector('#replay-panel canvas[aria-hidden=true]');
      const images=refs.find(r=>r.current?.entries instanceof Map&&typeof r.current.dispose==='function')?.current;
      const mode=document.querySelector('[aria-label=回放楼层]').textContent==='跟随玩家'?'auto':live.layerId;
      const explained=chunk?explainFrame(chunk,at,meta,live.map,index,mode):null;
      const expectedFollow=chunk?resolveReplayFollow(chunk,anchor.playerId,at,meta.players.map(p=>p.id)):null;
      const deadPlayerIds=expectedFollow?.deadPlayerIds??[];
      const onLayer=chunk&&live.layerId?explainFrame(chunk,at,meta,live.map,index,live.layerId):null;
      // Exact native rows can contain stale alive=true after a confirmed death.
      // Keep raw tuples for inspection, but the lifecycle must exclude them from paint.
      const eligible=onLayer?.players.filter(p=>p.reason==='eligible'&&!deadPlayerIds.includes(p.id)).length??0;
      return {ms:performance.now(),round:live.info.round,tick:at,uiTick:Number(node.dataset.replayTick),clockTick:clock.tick,
        clockRead:clock.read(performance.now(),meta.tickRate),playing:clock.playing,speed:clock.speed,
        floorStatus:canvas.dataset.floorStatus??null,baseLayer:base.dataset.layer??null,drawP95:Number(canvas.dataset.drawP95??0),
        imageCacheId:images?identity(images):null,imageCache:images?[...images.entries].map(([id,e])=>({id,identity:identity(e.image),status:e.status,width:e.image.naturalWidth,height:e.image.naturalHeight,src:e.image.src})):null,
        playerId:live.selectedPlayerId,anchorId:anchor.playerId,expectedFollow,deadPlayerIds,
        followPlayer:canvas.dataset.followPlayer??null,mode,layerId:live.layerId,targetFloor:deadPlayerIds.includes(live.selectedPlayerId)?null:explained?.layerId??null,imageReady:live.imageReady,
        chunkLoaded:!!chunk,block:block?.index,cacheKeys:[...cache.entries.keys()],drawn:Number(canvas.dataset.playerCount),paintCalls:canvas.__s0PaintCalls??null,eligible,
        selected:explained?.selected??null,leftTick:explained?.leftTick,rightTick:explained?.rightTick,gap:explained?.gap,
        players:explained?.players??[],reasons:explained?.reasons??{}};
    };
    const canvas=document.querySelector('#replay-panel canvas[role=img]');
    const originalClear=CanvasRenderingContext2D.prototype.clearRect,originalText=CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.clearRect=function(...args){if(this.canvas===canvas)canvas.__s0PaintCalls=0;return originalClear.apply(this,args);};
    CanvasRenderingContext2D.prototype.fillText=function(text,...args){if(this.canvas===canvas&&/^\\d{1,2}$/.test(String(text)))canvas.__s0PaintCalls++;return originalText.call(this,text,...args);};
    window.__s0Restore=()=>{CanvasRenderingContext2D.prototype.clearRect=originalClear;CanvasRenderingContext2D.prototype.fillText=originalText;};
    const observer=new MutationObserver(()=>{if(window.__s0.record)window.__s0.frames.push(window.__s0Read());});
    observer.observe(canvas,{attributes:true,attributeFilter:['data-tick']});window.__s0Observer=observer;
  })()`);
  const metadata = await evaluate(`(() => {let f=document.querySelector('[data-replay-session]');f=f[Object.keys(f).find(k=>k.startsWith('__reactFiber$'))];while(f&&!f.memoizedProps?.metadata)f=f.return;return f.memoizedProps.metadata;})()`);
  assert.equal(metadata.matchId, source.sha256);
  // Compare every real worker -> Main -> IPC chunk frame to the independent source session.
  const fnv = text => { let h=2166136261; for(let i=0;i<text.length;i++)h=Math.imul(h^text.charCodeAt(i),16777619); return h>>>0; };
  const sourceChunks=JSON.parse(readFileSync(join(input,'chunks.json'))).chunks;
  result.ipc=[]; const followContexts=new Map(); let ipcBytes=0;
  for(const round of metadata.rounds)for(const block of round.blocks){
    const request={sessionId:metadata.sessionId,round:round.round,block:block.index};
    const actual=await evaluate(`(async()=>{const start=performance.now(),r=await window.cs2Analyst.replay.getChunk(${JSON.stringify(request)});if(r.kind!=='success')throw new Error(r.message);const text=JSON.stringify(r.chunk.frames);const fnv=${fnv.toString()};return {ms:performance.now()-start,hash:fnv(text),contentHash:fnv(JSON.stringify({events:r.chunk.events,utilities:r.chunk.utilities??[],blinds:r.chunk.blinds??[],burns:r.chunk.burns??[]})),follow:${block.index===0?'r.chunk.follow':'undefined'},followHash:fnv(JSON.stringify(r.chunk.follow)),bytes:new TextEncoder().encode(JSON.stringify(r.chunk)).byteLength,frames:r.chunk.frames.length,startTick:r.chunk.startTick,endTick:r.chunk.endTick};})()`);
    const expected=sourceChunks.find(c=>c.round===round.round&&c.block===block.index);
    assert.equal(actual.hash,fnv(JSON.stringify(expected.frames)),'IPC frame parity '+round.round+':'+block.index);
    assert.equal(actual.contentHash,fnv(JSON.stringify({events:expected.events,utilities:expected.utilities??[],blinds:expected.blinds??[],burns:expected.burns??[]})),'IPC event/utility parity '+round.round+':'+block.index);
    assert.equal(actual.startTick,expected.startTick);assert.equal(actual.endTick,expected.endTick);
    assert.ok(actual.bytes<=1024*1024,'Existing chunk byte cap');ipcBytes+=actual.bytes;
    if(block.index===0){
      assert.ok(actual.follow?.deaths&&actual.follow?.states&&actual.follow?.backgrounds,'Whole-round authoritative follow context required');
      followContexts.set(round.round,actual.follow);
      const chunks=sourceChunks.filter(c=>c.round===round.round);
      const events=[...new Map(chunks.flatMap(c=>c.events).filter(e=>e.type==='kill').map(e=>[e.id,e])).values()];
      const groups=Map.groupBy(events,e=>JSON.stringify([e.tick,e.targetId]));
      assert.equal(actual.follow.deaths.length,groups.size,'One death per independent source tick/victim');
      for(const death of actual.follow.deaths){
        const sourceDeaths=groups.get(JSON.stringify([death.tick,death.victimId]));assert.ok(sourceDeaths,'Source death ownership exists');
        const killers=[...new Set(sourceDeaths.map(e=>e.actorId))];
        assert.equal(death.killerId,killers.length===1?killers[0]:null,'Independent source killer attribution');
        const frame=chunks.flatMap(c=>c.frames).find(f=>f.tick===death.tick);
        assert.ok(frame,'Death has an exact source frame');
        const sameTickVictims=events.filter(e=>e.tick===death.tick).map(e=>e.targetId);
        for(const id of death.alivePlayerIds){
          const p=frame.players.find(p=>metadata.players[p[0]]?.id===id);
          assert.ok(p&&p[1]===death.tick&&p[7]===true&&!p[10]&&!sameTickVictims.includes(id),'Handoff candidate is an exact living source row, excluding all same-tick victims');
        }
      }
      for(const state of actual.follow.states){
        assert.equal(state.alivePlayerIds.some(id=>state.deadPlayerIds.includes(id)),false,'Life sets cannot conflict');
      }
      if(expected.follow)assert.deepEqual(actual.follow,expected.follow,'Independent source/IPC follow parity');
    }
    assert.equal(actual.followHash,fnv(JSON.stringify(followContexts.get(round.round))),'Every chunk carries the same whole-round context');
    result.ipc.push({round:round.round,block:block.index,...actual,follow:undefined});
  }
  assert.ok(ipcBytes<=64*1024*1024,'Existing session byte cap');
  result.checks.authoritativeFollowContext=true;result.ipcBytes=ipcBytes;
  result.metadata = metadata; result.page = await evaluate('({url:location.href,title:document.title,width:innerWidth,height:innerHeight,hidden:document.hidden,text:document.body.innerText.slice(0,400)})');
  result.sessions??=[];result.sessions.push({sessionId:metadata.sessionId,scope:sequencesOnly?'visual':fullOnly?'full-playback-retry':'matrix-and-full'});
  const dropdown = async (label, value) => {
    await evaluate(`document.querySelector('[aria-label="${label}"]').click()`);
    await waitFor(() => evaluate(`[...document.querySelectorAll('[role=option]')].some(o=>o.textContent.trim()===${JSON.stringify(value)})`), 10000, 'option ' + value);
    await evaluate(`[...document.querySelectorAll('[role=option]')].find(o=>o.textContent.trim()===${JSON.stringify(value)}).click()`);
    if(s1&&label==='回放楼层')await waitFor(()=>evaluate(`(()=>{const f=window.__s0Read();return ${JSON.stringify(value)}==='跟随玩家'?f.floorStatus!=='manual':f.floorStatus==='manual'&&f.layerId===${JSON.stringify(value==='下层'?'lower':'default')};})()`),5000,'floor committed');
  };
  const pause = async () => { await evaluate('document.querySelector("[aria-label=暂停回放]")?.click()'); await delay(150); };
  const seek = async tick => {
    await evaluate(`(()=>{const s=document.querySelector('[aria-label=回放进度]'),set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;for(const v of [${tick}===Number(s.min)?${tick}+1:${tick}-1,${tick}]){set.call(s,v);s.dispatchEvent(new Event('input',{bubbles:true}));}})()`);
    await waitFor(() => evaluate(`Math.abs(Number(document.querySelector('#replay-panel canvas[role=img]').dataset.tick)-${tick})<.01`), 20000, 'seek ' + tick);
    await delay(150);
  };
  const selectRound = async round => { await pause(); await dropdown('回放回合', 'R' + round); await delay(150); };
  const screenshot = async label => {
    const state = await evaluate(`(() => {const s=window.__s0Read();s.baseOpaque=[...document.querySelector('#replay-panel canvas[aria-hidden=true]').getContext('2d').getImageData(0,0,1,1).data];return s;})()`);
    // Full-base alpha readback. Main run captures while paused; --sequences deliberately
    // captures during playback, so that visual-only run must not enter timing aggregates.
    state.baseNonempty = await evaluate(`(()=>{const c=document.querySelector('#replay-panel canvas[aria-hidden=true]'),d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;return d.some((v,i)=>i%4===3&&v>0);})()`);
    const name = label + '.png', shot = await page.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(out, name), Buffer.from(shot.data, 'base64')); result.screenshots.push({ name, state });
  };
  const assertFollow = (f,label) => {
    if(!f.chunkLoaded)return;
    const expected=resolveReplayFollow({matchId:metadata.matchId,round:f.round,follow:followContexts.get(f.round)},f.anchorId,f.tick,metadata.players.map(p=>p.id));
    assert.deepEqual(f.expectedFollow,expected,label+': probe resolves the independently verified round context');
    assert.equal(f.playerId,expected.playerId,label+': effective target follows the last explicit manual anchor');
    assert.equal(f.followPlayer,expected.playerId,label+': actual Canvas target agrees');
    if(f.imageReady){assert.equal(f.baseLayer,f.layerId,label+': foreground/background layer agree');assert.equal(f.drawn,f.eligible,label+': every available living on-layer player is drawn');}
    const p=f.selected;
    const reliable=!expected.deadPlayerIds.includes(f.playerId)&&p?.[7]===true&&p[9]!==null&&!p[10]&&p.slice(2,5).every(v=>v!==null&&Number.isFinite(v));
    if(f.mode==='auto'&&reliable){
      const layer=resolveMapLayer(replayMapDefinitions.find(m=>m.id===metadata.map),p[4]);
      if(layer!==null){assert.equal(f.layerId,layer,label+': reliable current target determines floor');assert.equal(f.floorStatus,'known',label+': observed floor is known');}
    }
    return f;
  };
  const assertFreshAuto = (f,label) => {
    assertFollow(f,label);assert.equal(f.mode,'auto');
    const p=f.selected,map=replayMapDefinitions.find(m=>m.id===metadata.map);
    const reliable=!f.deadPlayerIds.includes(f.playerId)&&p?.[7]===true&&p[9]!==null&&!p[10]&&p.slice(2,5).every(v=>v!==null&&Number.isFinite(v));
    const layer=reliable?resolveMapLayer(map,p[4]):null;
    // A seek/mode/target reset may immediately observe the *new living target*.
    // Only an actually unavailable current target without all-dead evidence is unknown.
    if(layer===null&&!f.expectedFollow.allDead){assert.equal(f.floorStatus,'unknown',label+': no inherited floor');assert.equal(f.layerId,null);assert.equal(f.drawn,0);}
    else if(layer!==null){assert.equal(f.floorStatus,'known');assert.equal(f.layerId,layer);}
    return f;
  };
  const assertContinuedContext = (before,after,label) => {
    assertFollow(after,label);
    if(before.round===after.round&&before.playerId===after.playerId&&before.layerId&&after.targetFloor===null){
      assert.equal(after.layerId,before.layerId,label+': same-target forward clock preserves observed floor');
      assert.equal(after.floorStatus,'retained',label+': unavailable current target retains context');
    }
  };
  async function playRun(label, stop, timeout) {
    await evaluate('window.__s0.frames=[];window.__s0.record=true;document.querySelector("[aria-label=播放回放]")?.click()');
    const frames=[];let progressAt=Date.now();
    if(sequencesOnly){
      await delay(350);await screenshot(label+'-sequence0');
      await delay(100);await screenshot(label+'-sequence1');
      await delay(100);await screenshot(label+'-sequence2');
    }
    await waitFor(async()=>{
      const batch=await evaluate(`({done:${stop},frames:window.__s0.frames.splice(0,256)})`);
      frames.push(...batch.frames);
      if(Date.now()-progressAt>=30000){progressAt=Date.now();console.log(JSON.stringify({label,stage:'collecting',frames:frames.length,round:frames.at(-1)?.round,tick:frames.at(-1)?.tick}));}
      return batch.done;
    }, timeout, label, { intervalMs: 150 });
    await evaluate('window.__s0.record=false'); await pause();
    while(await evaluate('window.__s0.frames.length'))frames.push(...await evaluate('window.__s0.frames.splice(0,256)'));
    assert.ok(frames.length>0,'Actual paint observations required');
    assert.ok(frames.every(f=>f.paintCalls===f.drawn),'Canvas marker calls must agree with actual draw count');
    const filename = label + '-frames.json'; writeFileSync(join(out, filename), JSON.stringify(frames));
    if(s1&&label.startsWith('w')&&label.includes('跟随玩家')){
      const handoff=frames.find(f=>f.chunkLoaded&&f.expectedFollow?.deathId&&f.playerId!==f.anchorId);
      if(handoff){
        assertFollow(handoff,'Actual forward death handoff');
        assert.ok(!handoff.deadPlayerIds.includes(handoff.playerId),'Death hands off to a living identity');
      }else{
        const evidence=frames.find(f=>f.floorStatus==='retained'&&(label.startsWith('w5-')||f.drawn>0));
        assert.ok(evidence,'Unchanged target retains reliable background context during unavailable position');
      }
      if(label.startsWith('w1-'))assert.ok(frames.some(f=>f.tick>4352&&f.tick<4356&&f.drawn===9),'W1 death boundary draws nine survivors');
    }
    const summary = summarizeObservedFrames(frames);
    if(s1){
      for(const f of frames)assertFollow(f,label);
      // The history oracle resets on identity change. Confirmed dead source rows must
      // not count as current target/floor or drawable survivors, even if stale true.
      const observed=frames.map(f=>({...f,selected:f.deadPlayerIds.includes(f.playerId)?null:f.selected,
        players:f.players.filter(p=>!f.deadPlayerIds.includes(p.id))}));
      summary.floorAudit=auditFloorContinuity(observed,replayMapDefinitions.find(m=>m.id===metadata.map));
      assert.equal(summary.floorAudit.layerMismatches,0,'Independent observed history agrees with painted floor');
      assert.equal(summary.floorAudit.erroneousFrames,0,'Independent oracle finds no erroneous whole-map blanks');
      const mismatches=frames.filter(f=>f.imageReady&&f.baseLayer!==f.layerId);
      const erroneous=frames.filter(f=>f.floorStatus==='retained'&&f.eligible>0&&f.imageReady&&f.drawn===0);
      assert.equal(mismatches.length,0,'Base/players/effects use one floor');
      assert.equal(erroneous.length,0,'No erroneous whole-map blank with reliable history and survivors');
      assert.equal(summary.eligibleDrawMismatchFrames,0);
      summary.erroneousBlankFrames=erroneous.length;summary.baseLayerMismatchFrames=mismatches.length;
      summary.targetUnknownFrames=frames.filter(f=>['unknown','retained'].includes(f.floorStatus)).length;
      summary.retainedFrames=frames.filter(f=>f.floorStatus==='retained').length;
      summary.drawP95=Math.max(...frames.map(f=>f.drawP95));
    }
    // Actual unavailable-current-block intervals, as distinct from background prefetch requests.
    let waitStart = null, waitingMs = 0, waitCount = 0, maxWaitingClockAdvance = 0, waitTick = null;
    for (const f of frames) {
      if (!f.chunkLoaded && waitStart === null) { waitStart = f.ms; waitTick = f.tick; waitCount++; }
      if (waitStart !== null && !f.chunkLoaded) maxWaitingClockAdvance = Math.max(maxWaitingClockAdvance, Math.abs(f.tick - waitTick));
      if (waitStart !== null && f.chunkLoaded) { waitingMs += f.ms - waitStart; waitStart = null; }
    }
    if (waitStart !== null) waitingMs += frames.at(-1).ms - waitStart;
    result.runs.push({ label, filename, ...summary, waitCount, waitingMs, maxWaitingClockAdvance,
      first: frames[0], last: frames.at(-1) });
    writeFileSync(join(out, 'electron.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ label, ...summary, waitCount, waitingMs }));
  }
  // Five deterministic source windows, three floor modes, three speeds; actual playback.
  for (const [i, window] of (fullOnly||lifecycleOnly?[]:source.windows).entries()) {
    await selectRound(window.round);
    await evaluate(`document.querySelectorAll('[aria-label="回放玩家状态"] button')[${window.playerIndex}].click()`);
    for (const mode of ['跟随玩家', '主层', '下层']) {
      await dropdown('回放楼层', mode);
      for (const speed of sequencesOnly ? [1] : [1, 1.5, 4]) {
        await dropdown('回放倍速', speed + '×');
        const info = metadata.rounds.find(r => r.round === window.round);
        const from = Math.max(info.startTick, window.startTick - 32), to = Math.min(info.endTick, window.endTick + 96);
        await seek(from);
        await playRun(`w${i + 1}-${mode}-${speed}`, `window.__s0Read().tick>=${to}`, 15000);
        if (speed === 1) {
          if(s1)await screenshot(`w${i+1}-${mode}-played`);
          // Pause at both exact and inter-sample evidence, then show survivors after death.
          for (const tick of [window.startTick, window.tick, window.endTick + 0.5]) {
            // Slider intentionally accepts only integer ticks; fractional diagnostic seek is NOT used.
            if (!Number.isInteger(tick)) continue;
            await seek(tick); await screenshot(`w${i + 1}-${mode}-tick${tick}`);
          }
          await seek(Math.min(info.endTick, window.endTick + 1));
          await screenshot(`w${i + 1}-${mode}-after`);
        }
      }
    }
  }
  // Pause stability, repeated seek (cold/warm block), real cross-chunk and continuous cross-round.
  if(!fullOnly&&!lifecycleOnly){
  const stable = await evaluate('window.__s0Read().tick'); await delay(300);
  assert.equal(await evaluate('window.__s0Read().tick'), stable); result.checks.pauseStable = true;
  await selectRound(1); await dropdown('回放楼层', '跟随玩家');
  await evaluate('document.querySelectorAll("[aria-label=回放玩家状态] button")[0].click()');
  for (const t of [metadata.rounds[0].startTick, metadata.rounds[0].blocks[3].startTick, metadata.rounds[0].blocks[1].startTick, metadata.rounds[0].startTick]) await seek(t);
  result.checks.repeatedSeek = true;
  await dropdown('回放倍速', '4×'); await seek(metadata.rounds[0].blocks[2].startTick - 32);
  const boundary = metadata.rounds[0].blocks[2].startTick;
  await playRun('cross-chunk-4', `window.__s0Read().tick>${boundary + 64}`, 15000);
  await seek(metadata.rounds[0].endTick - 32);
  await playRun('continuous-r1-r2-4', 'window.__s0Read().round===2&&window.__s0Read().tick>' + (metadata.rounds[1].startTick + 64), 15000);
  }
  if (!process.argv.includes('--quick') && !sequencesOnly&&!lifecycleOnly) {
    await selectRound(1); await dropdown('回放倍速', '1×'); await seek(metadata.rounds[0].startTick);
    await dropdown('回放楼层','跟随玩家');
    await evaluate('document.querySelectorAll("[aria-label=回放玩家状态] button")[0].click()');
    // Completes R1 and R2 without seek, entering R3 through the real continuous mode.
    await playRun('full-r1-r2-auto-1', 'window.__s0Read().round===3', 360000);
  }
  result.processMemory.push(...(await scope.live()).map(p=>({pid:p.pid,role:p.commandLine?.includes('node.mojom.NodeService')?'utility':'other',peak:p.peakWorkingSet,workingSet:p.workingSet,phase:'after-playback'})));
  if(s1&&!sequencesOnly&&!process.argv.includes('--quick')){
    const checks=result.checks;
    await selectRound(1);await dropdown('回放楼层','跟随玩家');
    await evaluate(`document.querySelectorAll('[aria-label=回放玩家状态] button')[${source.windows[0].playerIndex}].click()`);
    // Every seek is discontinuous, even when the destination chunk is already warm.
    await seek(4352);assert.equal((await evaluate('window.__s0Read()')).floorStatus,'known');
    const imageIdentity=await evaluate('window.__s0Read().imageCache');
    const oldCacheId=await evaluate('window.__s0Read().imageCacheId');
    for(const at of [4354,4358,4354]){
      await seek(at);const f=await evaluate('window.__s0Read()');
      assertFreshAuto(f,'Cold/warm/reverse seek '+at);
    }
    checks.coldWarmReverseSeekReconstructsFollow=true;
    await screenshot('lifecycle-cold-death-follow');
    await dropdown('回放楼层','主层');assert.equal((await evaluate('window.__s0Read()')).drawn,9);
    await dropdown('回放楼层','跟随玩家');assertFreshAuto(await evaluate('window.__s0Read()'),'Manual-to-auto reset');
    checks.manualAutoClearsHistory=true;
    await seek(4352);
    await dropdown('回放倍速','1×');
    await evaluate('document.querySelector("[aria-label=播放回放]").click()');
    await waitFor(()=>evaluate('window.__s0Read().tick>4356'),5000,'W1 death playback');await pause();
    const afterDeath=assertFollow(await evaluate('window.__s0Read()'),'Natural W1 death');
    assert.notEqual(afterDeath.playerId,afterDeath.anchorId,'W1 follows an eligible survivor after death');
    await screenshot('lifecycle-w1-follow');
    const stopped=await evaluate('window.__s0Read()');await delay(200);
    assert.equal((await evaluate('window.__s0Read()')).tick,stopped.tick);
    for(const speed of ['1.5×','4×','1×']){
      await dropdown('回放倍速',speed);const f=assertFollow(await evaluate('window.__s0Read()'),'Paused speed '+speed);
      assert.equal(f.playerId,stopped.playerId);assert.equal(f.layerId,stopped.layerId);assert.equal(f.floorStatus,stopped.floorStatus);
    }
    await dropdown('回放倍速','4×');
    await evaluate('document.querySelector("[aria-label=播放回放]").click()');
    await evaluate('(()=>{const until=performance.now()+60;while(performance.now()<until){} })()');
    await delay(100);await pause();
    assertContinuedContext(stopped,await evaluate('window.__s0Read()'),'Slow frame 4x keeps correct follow/floor');checks.slowFrame4xKeepsContext=true;
    checks.pauseResumeSpeed=true;
    // A briefly selected different target must not leave the prior target's history.
    await evaluate(`document.querySelectorAll('[aria-label=回放玩家状态] button')[0].click();document.querySelectorAll('[aria-label=回放玩家状态] button')[${source.windows[0].playerIndex}].click()`);
    await delay(100);assertFreshAuto(await evaluate('window.__s0Read()'),'Rapid manual anchor reset');checks.rapidTargetReset=true;
    assert.deepEqual(await evaluate('window.__s0Read().imageCache'),imageIdentity,'All floor/unknown/seek modes reuse decoded images');
    checks.finiteDecodedImagesReused=true;
    await evaluate('document.getElementById("report-tab").click()');await delay(100);
    await evaluate('document.getElementById("replay-tab").click()');await delay(100);
    assert.deepEqual(await evaluate('window.__s0Read().imageCache'),imageIdentity);checks.inactiveTabReusesImages=true;
    await evaluate(`(()=>{let node=document.querySelector('[data-replay-session]'),f=node[Object.keys(node).find(k=>k.startsWith('__reactFiber$'))];while(f&&!f.memoizedProps?.metadata)f=f.return;for(let h=f.memoizedState;h;h=h.next){const c=h.memoizedState?.current;if(c?.entries instanceof Map&&typeof c.dispose==='function'){window.__oldS1Images=c;window.__oldS1Entries=[...c.entries.values()];}}})()`);
    const oldSession=await evaluate('document.querySelector("[data-replay-session]").dataset.replaySession');
    await evaluate('[...document.querySelectorAll("button")].find(b=>b.textContent.includes("选择 DEM")).click()');
    await waitFor(()=>evaluate(`document.querySelector('main')?.dataset.status==='success'&&document.querySelector('[data-replay-session]')?.dataset.replaySession!==${JSON.stringify(oldSession)}`),120000,'new DEM session');
    await evaluate('document.getElementById("replay-tab").click()');await delay(200);
    assert.equal(await evaluate('window.__oldS1Images.entries.size'),0);
    assert.equal(await evaluate('window.__oldS1Entries.every(e=>e.image.onload===null&&e.image.onerror===null&&!e.image.getAttribute("src"))'),true);
    await selectRound(1);await evaluate(`document.querySelectorAll('[aria-label=回放玩家状态] button')[${source.windows[0].playerIndex}].click()`);await seek(4354);
    assertFreshAuto(await evaluate('window.__s0Read()'),'New session re-derives follow without prior floor history');
    assert.notEqual((await evaluate('window.__s0Read()')).imageCacheId,oldCacheId);
    checks.newSessionRetiresImagesAndHistory=true;
    await evaluate('delete window.__oldS1Images;delete window.__oldS1Entries');
  }
  result.processMemory.push(...(await scope.live()).map(p=>({pid:p.pid,role:p.commandLine?.includes('node.mojom.NodeService')?'utility':'other',peak:p.peakWorkingSet,workingSet:p.workingSet,phase:'after-lifecycle'})));
  result.exceptions = exceptions; assert.deepEqual(exceptions, []);
  result.status = s1?'PASS':'DIAGNOSED';
  await evaluate('window.__s0Observer.disconnect();window.__s0Restore();delete window.__s0Restore;delete window.__s0Read;delete window.__s0Observer;delete window.__s0');
  await closeApp({ child, evaluate, socket: page.socket });
}, [
  () => { writeFileSync(join(out, 'electron.json'), JSON.stringify(result, null, 2)); writeFileSync(join(out, 'electron.log'), log); },
  () => page?.socket.close(), () => scope.cleanup(),
  async () => { assert.ok(resolve(profile).startsWith(resolve(prefix))); await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); },
]);
