// Real built Electron + unchanged local Dust2; no synthetic Canvas or product test hooks.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { closeApp, connectCdp, waitFor, withCleanup } from './smoke-runtime.mjs';
import { ProcessScope } from './installed-smoke-lifecycle.mjs';
import { settleUi } from './window-shell-checks.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const label = 'transport';
assert.match(label, /^[a-z-]+$/);
const qa = join(tmpdir(), 'cs2-p7-transport-evidence'), demo = join(root, '.demo/dust2.dem');
mkdirSync(qa, { recursive: true });
assert.equal(createHash('sha256').update(readFileSync(demo)).digest('hex'), 'db90fe85aab023a1d2c8a5996182e6120d98ef494f02a070b17982b235e4958c');
const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const server = createServer();
await new Promise(ok => server.listen(0, '127.0.0.1', ok));
const port = server.address().port;
await new Promise(ok => server.close(ok));
const prefix = join(tmpdir(), 'cs2-p7-visual-'), profile = mkdtempSync(prefix);
const env = { ...process.env, CS2_ANALYST_DEM_PATH: demo };
delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
const startedAt = Date.now();
const child = spawn(require('electron'), ['.', '--inspect=0', '--remote-debugging-port=' + port, '--user-data-dir=' + profile,
  '--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows'], {
  cwd: join(root, 'apps/desktop'), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
});
const scope = new ProcessScope(); scope.track(child, 'P7 visual acceptance', startedAt);
let page, mainInspector, failure, logs = '';
child.stdout.on('data', data => { logs += data; }); child.stderr.on('data', data => { logs += data; });
const metrics = { label, fixture: '.demo/dust2.dem', screenshots: [], checks: [], scenes: {} };
const wait = (probe, name, ms = 30000) => waitFor(probe, ms, name, { intervalMs: 50, diagnostics: () => logs.slice(-2500) });
const canvas = 'document.querySelector("#replay-panel canvas[role=img]")';
try {
  await scope.live();
  const target = await wait(async () => { try { return (await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()).find(t => t.type === 'page'); } catch { return null; } }, 'CDP');
  page = await connectCdp(target.webSocketDebuggerUrl);
  // Electron has no Browser.getWindowForTarget CDP method. Use its development-only
  // main-process inspector to resize this test window through Electron's real API.
  mainInspector = await connectCdp(await wait(() => /Debugger listening on (ws:\/\/\S+)/.exec(logs)?.[1], 'main inspector'));
  const nativeWindow = "process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron').BrowserWindow.getAllWindows()[0]";
  const evaluate = page.evaluate, exceptions = [];
  metrics.console=[];
  page.socket.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params);
    if (m.method === 'Runtime.consoleAPICalled' && ['error','warning'].includes(m.params.type)) metrics.console.push(m.params);
  });
  await page.send('Runtime.enable'); await page.send('Page.enable');
  await wait(() => evaluate('Boolean(window.cs2Analyst&&document.querySelector("[data-sidebar-import]"))'), 'React ready');
  const started = Date.now();
  await evaluate('document.querySelector("[data-sidebar-import]").click()');
  await wait(() => evaluate('document.querySelector("main").dataset.status==="success"'), 'real import', 120000);
  metrics.importUiMs = Date.now() - started;
  metrics.processMemory = (await scope.live()).map(p => ({ pid: p.pid, peakWorkingSet: p.peakWorkingSet, role: p.commandLine?.includes('node.mojom.NodeService') ? 'analysis-utility' : 'other' }));
  await evaluate('document.getElementById("replay-tab").click()');
  await wait(() => evaluate('document.querySelector("[data-replay-session]")?.dataset.replayMapReady==="true"&&Number(' + canvas + '?.dataset.tick)>0'), 'radar');
  await settleUi(evaluate, 'initial replay');
  const sessionId = await evaluate('document.querySelector("[data-replay-session]").dataset.replaySession');
  const reportExpr='(()=>{const n=document.getElementById("replay-panel");let f=n[Object.keys(n).find(k=>k.startsWith("__reactFiber$"))];while(f&&!f.memoizedProps?.report)f=f.return;return f.memoizedProps.report;})()';
  const report=await evaluate(reportExpr),meta=report.replay,first=meta.rounds[0],second=meta.rounds[1],rate=meta.tickRate;
  const state=()=>evaluate(`({tick:Number(${canvas}.dataset.tick),round:Number(document.querySelector('[data-replay-session]').dataset.replayRound),playing:Boolean(document.querySelector('[aria-label=暂停回放]')),time:document.querySelector('[data-replay-time]').textContent,duration:document.querySelector('[data-replay-duration]').textContent})`);
  const cachedBlocks=()=>evaluate(`(() => {
    const n=document.querySelector('[data-replay-session]');
    let f=n[Object.keys(n).find(k=>k.startsWith('__reactFiber$'))];
    while(f&&f.memoizedProps?.metadata?.sessionId!==${JSON.stringify(sessionId)})f=f.return;
    for(let h=f?.memoizedState;h;h=h.next){const c=h.memoizedState?.current;if(c?.entries instanceof Map&&typeof c.put==='function')return [...c.entries.keys()];}
    throw new Error('Replay cache ref not found');
  })()`);
  // Observe completed real paints, including paint's early return for a missing
  // chunk. That path clears the foreground but leaves dataset.tick/playerCount
  // at their prior values, so neither attribute identifies buffering reliably.
  await evaluate(`(() => {
    const canvas=${canvas},originalClear=CanvasRenderingContext2D.prototype.clearRect,originalText=CanvasRenderingContext2D.prototype.fillText;
    let paintSequence=0,markerCalls=0;
    window.__transportFrames=[];window.__transportWatch=false;
    window.__transportRead=()=>{
      const n=document.querySelector('[data-replay-session]');let f=n[Object.keys(n).find(k=>k.startsWith('__reactFiber$'))];
      while(f&&f.memoizedProps?.metadata?.sessionId!==${JSON.stringify(sessionId)})f=f.return;
      const refs=[];for(let h=f?.memoizedState;h;h=h.next)if(h.memoizedState&&typeof h.memoizedState==='object'&&Object.hasOwn(h.memoizedState,'current'))refs.push(h.memoizedState.current);
      const live=refs.find(r=>r?.selectedPlayerId!==undefined),clock=refs.find(r=>r?.anchorMs!==undefined),cache=refs.find(r=>r?.entries instanceof Map&&typeof r.put==='function');
      if(!live||!clock||!cache)throw new Error('Replay observation refs not found');
      // While buffering the real paused clock holds the sought tick; the Canvas
      // attributes are stale. While loaded, use the completed paint's exact tick
      // so a later microtask timestamp cannot cross a block before its next RAF.
      const tick=clock.playing?Number(canvas.dataset.tick):clock.tick,needed=live.info.blocks.find(b=>Math.floor(tick)>=b.startTick&&Math.floor(tick)<=b.endTick);
      return {now:performance.now(),round:live.info.round,tick,clockTick:clock.tick,clockRead:clock.read(performance.now(),${rate}),clockPlaying:clock.playing,
        neededBlock:needed?.index??null,chunkLoaded:!!needed&&cache.entries.has(live.info.round+':'+needed.index),cacheKeys:[...cache.entries.keys()],
        paintTick:Number(canvas.dataset.tick),players:Number(canvas.dataset.playerCount),markerCalls,paintSequence};
    };
    CanvasRenderingContext2D.prototype.fillText=function(text,...args){if(this.canvas===canvas&&/^\\d{1,2}$/.test(String(text)))markerCalls++;return originalText.call(this,text,...args);};
    CanvasRenderingContext2D.prototype.clearRect=function(...args){
      const returned=originalClear.apply(this,args);
      if(this.canvas===canvas){
        markerCalls=0;const sequence=++paintSequence,fullClear=args[0]===0&&args[1]===0&&args[2]===canvas.width&&args[3]===canvas.height;
        if(window.__transportWatch)queueMicrotask(()=>{
          if(!window.__transportWatch)return;
          const sample=window.__transportRead();sample.paintSequence=sequence;sample.fullClear=fullClear;
          if(!sample.chunkLoaded){const rgba=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;sample.foregroundEmpty=!rgba.some((v,i)=>i%4===3&&v!==0);}
          window.__transportFrames.push(sample);
        });
      }
      return returned;
    };
    window.__transportRestore=()=>{CanvasRenderingContext2D.prototype.clearRect=originalClear;CanvasRenderingContext2D.prototype.fillText=originalText;};
  })()`);
  const click=label=>evaluate(`document.querySelector('[aria-label="${label}"]').click()`);
  const ready=()=>wait(()=>evaluate(`Number(${canvas}.dataset.playerCount)>0`),'target chunk loaded');
  const seek=async tick=>{
    await evaluate(`(()=>{const s=document.querySelector('[aria-label=回放进度]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(s,${tick});s.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await wait(async()=>Math.abs((await state()).tick-tick)<.01,'seek '+tick);await ready();
  };
  const choose=async(label,text)=>{
    await click(label);await wait(()=>evaluate(`Boolean([...document.querySelectorAll('[role=option]')].find(o=>o.checkVisibility()&&o.textContent.trim()===${JSON.stringify(text)}))`),'option '+text);
    await evaluate(`[...document.querySelectorAll('[role=option]')].find(o=>o.checkVisibility()&&o.textContent.trim()===${JSON.stringify(text)}).click()`);
  };
  const shot=async name=>{
    await settleUi(evaluate,name);await evaluate('new Promise(ok=>requestAnimationFrame(()=>requestAnimationFrame(ok)))');
    const path=join(qa,name+'.png');writeFileSync(path,Buffer.from((await page.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false})).data,'base64'));metrics.screenshots.push(path);
  };
  const key=async(key,code,vk)=>{for(const type of ['keyDown','keyUp'])await page.send('Input.dispatchKeyEvent',{type,key,code,windowsVirtualKeyCode:vk});};
  const format=seconds=>{seconds=Math.floor(seconds);return String(Math.floor(seconds/60)).padStart(2,'0')+':'+String(seconds%60).padStart(2,'0');};
  assert.equal((await state()).time,'00:00');
  assert.equal((await state()).duration,format((first.endTick-first.startTick)/rate));
  assert.equal(await evaluate('document.querySelector("[data-replay-filename]").textContent'),report.match.fileName);
  assert.equal(await evaluate('document.querySelector("[aria-label=回放倍速]").textContent.trim()'),'1×');
  assert.deepEqual(await evaluate('[...document.querySelectorAll("[data-replay-playback] button")].map(b=>({label:b.getAttribute("aria-label"),text:b.textContent,svg:Boolean(b.querySelector("svg"))}))'),
    ['回到最初','倒退 10 秒','播放回放','前进 30 秒','直达最后'].map(label=>({label,text:'',svg:true})));
  // Paused controls: exact target ticks and both boundary clamps.
  const middle=first.startTick+rate*40;
  await seek(middle);await click('倒退 10 秒');await ready();
  await wait(async()=>(await state()).tick===middle-10*rate,'rewind exact');
  await click('前进 30 秒');await wait(async()=>(await state()).tick===middle+20*rate,'forward exact');
  await click('回到最初');await wait(async()=>(await state()).tick===first.startTick,'start exact');
  assert.equal((await state()).time,'00:00');await click('倒退 10 秒');assert.equal((await state()).tick,first.startTick);
  await click('直达最后');await wait(async()=>(await state()).tick===first.endTick,'end exact');
  await ready();assert.equal((await state()).time,(await state()).duration);
  await click('前进 30 秒');await delay(200);assert.deepEqual([(await state()).tick,(await state()).round,(await state()).playing],[first.endTick,first.round,false]);
  metrics.checks.push('paused four buttons, exact ticks, relative times and both clamps');

  // In-play 1x -> 1.5x -> 0.5x: samples use renderer performance.now with Canvas tick.
  await seek(middle);await click('播放回放');
  await wait(async()=>(await state()).playing,'playing before speed');
  const sample=()=>evaluate(`({tick:Number(${canvas}.dataset.tick),now:performance.now()})`);
  const before=await sample();await choose('回放倍速','1.5×');const after=await sample();
  assert.ok(after.tick>=before.tick&&after.tick-before.tick<(after.now-before.now)/1000*rate*1.5+rate*.2,'speed selection stays continuous');
  await delay(1000);const later=await sample(),ratio=(later.tick-after.tick)/((later.now-after.now)/1000*rate);
  assert.ok(Math.abs(ratio-1.5)<.15,'real 1.5x: '+ratio);assert.equal((await state()).playing,true);
  await choose('回放倍速','0.5×');const half=await sample();await delay(650);const halfEnd=await sample();
  assert.ok(Math.abs((halfEnd.tick-half.tick)/((halfEnd.now-half.now)/1000*rate)-.5)<.15);
  await click('暂停回放');const paused=await state();await delay(180);assert.equal((await state()).tick,paused.tick);
  metrics.speed={ratio,before,after,later};metrics.checks.push('actual 1.5x and in-play speed change continuity');

  // A far seek targets an uncached block (renderer cache is capped at 3). Observe
  // rAF samples until loaded: no missing-data frame may advance its tick.
  await choose('回放倍速','1×');await seek(first.startTick+rate*2);await click('播放回放');
  await wait(async()=>(await state()).playing,'playing relative seek');
  await evaluate('window.__transportFrames=[];window.__transportWatch=true');
  const playingBefore=await sample();await click('前进 30 秒');
  await wait(async()=>(await state()).playing&&(await state()).tick>playingBefore.tick+rate*30,'relative seek resumes');
  const playingAfter=await sample();assert.ok(playingAfter.tick<playingBefore.tick+rate*33);
  await click('倒退 10 秒');await wait(async()=>(await state()).playing&&(await state()).tick<playingAfter.tick-rate*8,'playing rewind');
  await evaluate('window.__transportWatch=false');metrics.chunkFrames=await evaluate('window.__transportFrames');
  for(let i=1;i<metrics.chunkFrames.length;i++){
    const a=metrics.chunkFrames[i-1],b=metrics.chunkFrames[i];
    if(!a.chunkLoaded&&!b.chunkLoaded){
      assert.equal(a.clockPlaying,false);assert.equal(b.clockPlaying,false);
      assert.equal(a.clockTick,b.clockTick,'clock frozen while chunk absent');
      assert.equal(a.tick,b.tick,'missing-data observation tick frozen');
    }
  }
  await click('回到最初');await delay(120);assert.deepEqual([(await state()).tick,(await state()).playing],[first.startTick,false]);
  await click('播放回放');await wait(async()=>(await state()).playing,'play before end');await click('直达最后');
  await delay(180);assert.deepEqual([(await state()).tick,(await state()).round,(await state()).playing],[first.endTick,first.round,false]);
  metrics.checks.push('playing relative seeks resume safely; start/end stop; end cannot auto-switch');
  // Delay the existing Main IPC handler's real response in this disposable test
  // process. This creates deterministic buffering without synthetic chunks or DEMs.
  const ipcExpr="process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron').ipcMain";
  await mainInspector.evaluate(`(()=>{const ipc=${ipcExpr};globalThis.__p7ChunkOriginal=ipc._invokeHandlers.get('replay:chunk');globalThis.__p7ChunkDelays=[];ipc.removeHandler('replay:chunk');ipc.handle('replay:chunk',async(...args)=>{const record={request:args[1],requestedAt:Date.now(),delayMs:650};globalThis.__p7ChunkDelays.push(record);const result=await globalThis.__p7ChunkOriginal(...args);record.responseReadyAt=Date.now();record.kind=result.kind;const notBefore=record.responseReadyAt+650;while(Date.now()<notBefore)await new Promise(ok=>setTimeout(ok,notBefore-Date.now()));record.releasedAt=Date.now();return result;});})()`);
  const cold=meta.rounds[2];assert.ok(cold.blocks.length>3);
  await choose('回放回合','R'+cold.round);await ready();
  // +30s from +2s lands in the normally prefetched block 1, so delaying IPC
  // cannot force buffering there. Start late enough in block 0 to target block 2.
  const delayedBlock=cold.blocks[2],delayedTarget=delayedBlock.startTick+Math.min(rate*2,Math.floor((delayedBlock.endTick-delayedBlock.startTick)/2));
  const coldFrom=delayedTarget-rate*30;
  assert.ok(coldFrom>=cold.blocks[0].startTick&&coldFrom<=cold.blocks[0].endTick);
  await seek(coldFrom);await click('播放回放');
  await wait(async()=>(await state()).playing,'cold round playing');
  await evaluate('window.__transportFrames=[];window.__transportWatch=true');
  const coldCache=await cachedBlocks();
  assert.ok(coldCache.length<=3);assert.ok(!coldCache.includes(cold.round+':'+delayedBlock.index),'delayed relative seek target must actually be uncached');
  metrics.delayedChunkPrecondition={round:cold.round,fromTick:coldFrom,targetBlock:delayedBlock.index,cacheKeys:coldCache};
  await click('前进 30 秒');
  await wait(()=>evaluate(`window.__transportFrames.filter(f=>!f.chunkLoaded&&f.neededBlock===${delayedBlock.index}&&f.round===${cold.round}).length>=2`),'observed missing chunk');
  const stalled=await evaluate('window.__transportRead()');assert.equal(stalled.clockPlaying,false);assert.equal(stalled.chunkLoaded,false);
  await wait(()=>evaluate(`window.__transportFrames.some(f=>f.chunkLoaded&&f.clockPlaying&&f.round===${cold.round}&&f.neededBlock===${delayedBlock.index}&&f.paintTick>${stalled.clockTick}&&f.markerCalls>0&&f.players>0)`),'cold seek resumes after real data and paints players');
  await evaluate('window.__transportWatch=false');metrics.delayedChunkFrames=await evaluate('window.__transportFrames');
  const missing=metrics.delayedChunkFrames.filter(f=>!f.chunkLoaded&&f.round===cold.round&&f.neededBlock===delayedBlock.index);
  assert.ok(new Set(missing.map(f=>f.paintSequence)).size>=2,'At least two distinct actual missing-chunk paints');
  for(const f of missing){assert.equal(f.clockPlaying,false);assert.equal(f.fullClear,true);assert.equal(f.markerCalls,0);assert.equal(f.foregroundEmpty,true,'Real foreground RGBA is transparent during missing chunk');}
  for(let i=1;i<metrics.delayedChunkFrames.length;i++){
    const a=metrics.delayedChunkFrames[i-1],b=metrics.delayedChunkFrames[i];
    if(!a.chunkLoaded&&!b.chunkLoaded){assert.equal(a.clockTick,b.clockTick,'delayed chunk real clock frozen');assert.equal(a.tick,b.tick,'delayed missing-data observation tick frozen');}
  }
  const recovered=metrics.delayedChunkFrames.filter(f=>f.chunkLoaded&&f.clockPlaying&&f.round===cold.round&&f.neededBlock===delayedBlock.index&&f.paintTick>stalled.clockTick);
  assert.ok(recovered.some(f=>f.markerCalls>0&&f.players>0),'Real player marks return after loading');
  for(const f of recovered)assert.equal(f.markerCalls,f.players,'Actual numeric player marks match completed paint count');
  await click('暂停回放');
  metrics.delayedChunkResponses=await mainInspector.evaluate('globalThis.__p7ChunkDelays');
  const delayedResponse=metrics.delayedChunkResponses.find(r=>r.request?.sessionId===sessionId&&r.request?.round===cold.round&&r.request?.block===delayedBlock.index&&r.releasedAt);
  assert.ok(delayedResponse,'Main delayed the actual requested block response');assert.equal(delayedResponse.kind,'success');
  assert.ok(delayedResponse.releasedAt-delayedResponse.responseReadyAt>=650,'Real successful Chunk response held at least 650ms');
  metrics.delayedChunkMethod='Unchanged SHA-verified real Dust2 DEM and real Chunk payload; controlled >=650ms Main IPC response delay in disposable built Electron. Post-clear microtask observes each actual foreground paint, real clock/ref/cache without cache.get/LRU mutation, numeric player marks and missing-frame RGBA. Instrumented diagnostic timing, not a natural network/IPC performance measurement.';
  await mainInspector.evaluate(`(()=>{const ipc=${ipcExpr};ipc.removeHandler('replay:chunk');ipc.handle('replay:chunk',globalThis.__p7ChunkOriginal);delete globalThis.__p7ChunkOriginal;delete globalThis.__p7ChunkDelays;})()`);
  await evaluate('window.__transportRestore();delete window.__transportRestore;delete window.__transportRead;delete window.__transportFrames;delete window.__transportWatch');
  await choose('回放回合','R'+first.round);await ready();
  metrics.checks.push('deterministic delayed real Chunk: multiple missing-data frames freeze tick then resume');
  // Natural end still advances; manual selection still pauses at its own origin.
  await seek(first.endTick-8);await click('播放回放');
  await wait(async()=>(await state()).round===second.round&&(await state()).playing,'natural continuous next round');
  await choose('回放回合','R'+first.round);await ready();
  assert.deepEqual([(await state()).round,(await state()).tick,(await state()).playing],[first.round,first.startTick,false]);
  metrics.checks.push('natural continuous transition and manual round selection');

  const pageInfo=await evaluate('({url:location.href,title:document.title,text:document.getElementById("replay-panel").innerText,overlay:Boolean(document.querySelector("vite-error-overlay"))})');
  assert.match(pageInfo.url,/index\.html$/);assert.ok(pageInfo.title&&pageInfo.text.includes('比赛回放'));assert.equal(pageInfo.overlay,false);metrics.page=pageInfo;
  for(const [width,height] of [[1024,640],[1920,1032]]){
    const bounds=await mainInspector.evaluate(`(()=>{const w=${nativeWindow};w.unmaximize();w.setBounds({x:0,y:0,width:${width},height:${height}});return w.getBounds();})()`);
    assert.equal(bounds.width,width);assert.equal(bounds.height,height);
    await wait(()=>evaluate(`innerWidth===${width}&&innerHeight===${height}`),'native window '+width);await settleUi(evaluate,'resize '+width);
    const layout=await evaluate(`(()=>{const t=document.querySelector('[data-replay-transport]'),m=document.querySelector('[data-replay-map]'),g=document.querySelector('[data-replay-playback]');const r=t.getBoundingClientRect(),mr=m.getBoundingClientRect(),gr=g.getBoundingClientRect();const buttons=[...g.querySelectorAll('button')];return {center:Math.abs((r.left+r.right-gr.left-gr.right)/2),map:[mr.left,mr.right,mr.height],transport:[r.left,r.right,r.height],overflow:[document.documentElement.scrollWidth-innerWidth,document.documentElement.scrollHeight-innerHeight],buttons:buttons.map(b=>{const q=b.getBoundingClientRect();return {left:q.left,right:q.right,top:q.top,bottom:q.bottom,width:q.width,height:q.height};}),outside:[...t.querySelectorAll('button,[data-replay-filename]')].filter(e=>{const q=e.getBoundingClientRect();return e.checkVisibility()&&(q.left<r.left-1||q.right>r.right+1||q.top<r.top-1||q.bottom>r.bottom+1);}).length};})()`);
    metrics['layout'+width]=layout;
    assert.ok(layout.center<=1,'whole transport center '+width);assert.equal(layout.outside,0,'controls contained');
    const phase=await evaluate('(()=>{const b=document.querySelector("[data-replay-phase]"),m=document.querySelector("[data-replay-map]"),q=b.getBoundingClientRect(),r=m.getBoundingClientRect();return {left:q.left-r.left,bottom:r.bottom-q.bottom,width:q.width,inMap:m.contains(b),inTransport:Boolean(document.querySelector("[data-replay-transport] [data-replay-phase]"))};})()');
    assert.ok(phase.left>=10&&phase.left<=12&&phase.bottom>=10&&phase.bottom<=12&&phase.width<80&&phase.inMap&&!phase.inTransport,'freeze tag fits content at map bottom-left');
    assert.ok(layout.overflow.every(v=>v<=1),'no page overflow');assert.ok(Math.abs(layout.map[0]-layout.transport[0])<=1&&Math.abs(layout.map[1]-layout.transport[1])<=1);
    assert.ok(layout.map[2]>height*.4,'map keeps useful height');
    assert.ok(layout.buttons[2].height>layout.buttons[0].height&&layout.buttons[2].width>layout.buttons[0].width);
    for(let i=1;i<5;i++)assert.ok(layout.buttons[i].left>layout.buttons[i-1].right,'buttons do not overlap');
    metrics['layout'+width]=layout;await shot('transport-'+width+'x'+height);
    // True keyboard Tab focus must reach each icon and expose Fluent Tooltip text.
    await evaluate('document.querySelector("[data-replay-filename]").focus()');
    const expected=['回到最初','倒退 10 秒','播放','前进 30 秒','直达最后'];
    for(let i=0;i<5;i++){
      await key('Tab','Tab',9);
      assert.equal(await evaluate('document.activeElement.getAttribute("aria-label")'),i===2?'播放回放':expected[i]);
      await wait(()=>evaluate(`[...document.querySelectorAll('[role=tooltip]')].some(t=>t.checkVisibility()&&t.textContent===${JSON.stringify(expected[i])})`),'focus tooltip '+expected[i]);
    }
    await evaluate('document.querySelector("[aria-label=回放回合]").focus()');
    await click('回放回合');await wait(()=>evaluate('[...document.querySelectorAll("[role=listbox]")].some(b=>b.checkVisibility())'),'round list');
    const winOption=await evaluate('(()=>{const b=[...document.querySelectorAll("[role=listbox]")].find(b=>b.checkVisibility()),opts=[...b.querySelectorAll("[role=option]")],picked=opts.find(o=>o.getAttribute("aria-selected")==="true"),other=opts.find(o=>o.getAttribute("aria-selected")==="false");return {selected:Boolean(picked),other:Boolean(other),selectedBar:picked&&getComputedStyle(picked,"::before").opacity,unselectedBar:other&&getComputedStyle(other,"::before").opacity,checkIcons:b.querySelectorAll(".fui-Option__checkIcon").length};})()');
    assert.deepEqual(winOption,{selected:true,other:true,selectedBar:'1',unselectedBar:'0',checkIcons:0},'WinUI accent bar replaces the default Fluent checkmark');
    try{
      await page.send('Emulation.setEmulatedMedia',{features:[{name:'forced-colors',value:'none'}]});
      await shot('round-menu-normal-'+width);
    }finally{
      await page.send('Emulation.setEmulatedMedia',{features:[]});
    }
    // Exercise both system palettes: opacity alone cannot detect a bar forced
    // to the same background colour as its selected option.
    for(const scheme of ['light','dark']){
      try{
        await page.send('Emulation.setEmulatedMedia',{features:[{name:'forced-colors',value:'active'},{name:'prefers-color-scheme',value:scheme}]});
        await settleUi(evaluate,'forced colors '+scheme);
        const contrast=await evaluate('(()=>{const b=[...document.querySelectorAll("[role=listbox]")].find(b=>b.checkVisibility()),o=b.querySelector("[aria-selected=true]"),other=b.querySelector("[aria-selected=false]"),s=getComputedStyle(o),bar=getComputedStyle(o,"::before");return {active:matchMedia("(forced-colors: active)").matches,background:s.backgroundColor,foreground:s.color,barColor:bar.borderLeftColor,barStyle:bar.borderLeftStyle,barWidth:bar.borderLeftWidth,width:bar.width,height:bar.height,boxSizing:bar.boxSizing,opacity:bar.opacity,otherOpacity:getComputedStyle(other,"::before").opacity};})()');
        assert.equal(contrast.active,true);
        assert.equal(contrast.barColor,contrast.foreground,'selection bar follows the system foreground');
        assert.notEqual(contrast.barColor,contrast.background,'selection bar contrasts with selected row');
        assert.deepEqual([contrast.barStyle,contrast.barWidth,contrast.width,contrast.height,contrast.boxSizing,contrast.opacity,contrast.otherOpacity],['solid','3px','3px','16px','border-box','1','0']);
        metrics['winOption'+width+scheme]=contrast;
        await shot('round-menu-contrast-'+scheme+'-'+width);
      }finally{
        await page.send('Emulation.setEmulatedMedia',{features:[]});
      }
    }
    const menu=await evaluate('(()=>{const b=[...document.querySelectorAll("[role=listbox]")].find(b=>b.checkVisibility()),r=b.getBoundingClientRect();return {height:r.height,top:r.top,bottom:r.bottom,overflow:getComputedStyle(b).overflowY,scroll:b.scrollHeight-b.clientHeight};})()');
    assert.ok(menu.height<=320.5&&menu.top>=0&&menu.bottom<=height);assert.equal(menu.overflow,'auto');assert.ok(menu.scroll>0);
    await key('Escape','Escape',27);await wait(()=>evaluate('![...document.querySelectorAll("[role=listbox]")].some(b=>b.checkVisibility())'),'menu escape');
  }
  metrics.checks.push('real native 1024x640 / 1920x1032, center/overflow/map alignment, icon keyboard Tooltip, round scroll and forced-color selection bars');

  // Synthetic presentation prop only: real DEM bytes/session are untouched.
  const longName='very-long-demo-name-'.repeat(20)+'.dem';
  await evaluate(`${reportExpr}.match.fileName=${JSON.stringify(longName)}`);
  const targetText=await evaluate('document.querySelector("[aria-label=目标玩家]").textContent.trim()');
  await click('目标玩家');await wait(()=>evaluate('[...document.querySelectorAll("[role=option]")].some(o=>o.checkVisibility())'),'target player');
  await evaluate(`[...document.querySelectorAll('[role=option]')].find(o=>o.checkVisibility()&&o.textContent.trim()!==${JSON.stringify(targetText)}).click()`);
  await wait(()=>evaluate(`document.querySelector('[data-replay-filename]').textContent===${JSON.stringify(longName)}`),'filename prop update');
  const filename=await evaluate('(()=>{const e=document.querySelector("[data-replay-filename]"),s=getComputedStyle(e);return {overflow:s.overflow,textOverflow:s.textOverflow,whiteSpace:s.whiteSpace,clipped:e.scrollWidth>e.clientWidth};})()');
  assert.deepEqual(filename,{overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',clipped:true});
  await evaluate('document.querySelector("[data-replay-time]").focus()');
  await evaluate('document.querySelector("[aria-label=回放进度]").focus()');await key('Tab','Tab',9);
  await wait(()=>evaluate(`[...document.querySelectorAll('[role=tooltip]')].some(t=>t.checkVisibility()&&t.textContent===${JSON.stringify(longName)})`),'full filename tooltip');
  await shot('long-filename-tooltip');
  // Reimport the allowed file: new session and filename return to actual report data.
  await evaluate('document.querySelector("[data-sidebar-import]").click()');
  await wait(()=>evaluate(`document.querySelector('main').dataset.status==='success'&&document.querySelector('[data-replay-session]')?.dataset.replaySession!==${JSON.stringify(sessionId)}`),'reimport',120000);
  await evaluate('document.getElementById("replay-tab").click()');await ready();
  assert.equal(await evaluate('document.querySelector("[data-replay-filename]").textContent'),'dust2.dem');
  metrics.checks.push('long filename ellipsis/full Tooltip (synthetic prop); actual DEM reimport resets filename');
  // Unpackaged Electron emits this existing sandbox warning. Retain it in evidence;
  // all application warnings/errors still fail this UI acceptance.
  metrics.appConsole=metrics.console.filter(entry=>!(entry.type==='warning'
    &&entry.args[0]?.value==='%cElectron Security Warning (Insecure Content-Security-Policy)'
    &&entry.stackTrace?.callFrames?.[0]?.url==='node:electron/js2c/sandbox_bundle'));
  assert.deepEqual(exceptions,[]);assert.deepEqual(metrics.appConsole,[]);metrics.status='PASS';
}catch(error){failure=error;metrics.status='FAIL';metrics.error=String(error.stack||error);if(page)try{const path=join(qa,'failure.png');writeFileSync(path,Buffer.from((await page.send('Page.captureScreenshot',{format:'png'})).data,'base64'));}catch{}}
finally{
  writeFileSync(join(qa,'metrics.json'),JSON.stringify(metrics,null,2)+'\n');
  await withCleanup(()=>{if(failure)throw failure;},[
    ()=>mainInspector?.socket.close(),async()=>{if(page)await closeApp({child,evaluate:page.evaluate,socket:page.socket});},
    ()=>page?.socket.close(),()=>scope.cleanup(),
    async()=>{assert.ok(profile.startsWith(prefix));await rm(profile,{recursive:true,force:true,maxRetries:8,retryDelay:250});},
  ]);
}
console.log(JSON.stringify({status:metrics.status,qa,checks:metrics.checks,speed:metrics.speed}));
