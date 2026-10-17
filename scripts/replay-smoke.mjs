// Real built/installed Electron validation, using only the explicitly selected local Dust2 DEM.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream,existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,statSync,writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { dirname,join,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { closeApp, connectCdp, waitFor as waitForState, withCleanup } from './smoke-runtime.mjs';
import { ProcessScope } from './installed-smoke-lifecycle.mjs';
import { inspectReplayPackage } from './replay-package-inspection.mjs';
import { assertNoPageScroll, assertLocalScroll, waitForUi, settleUi } from './window-shell-checks.mjs';
/** Map Replay must behave like a tool surface: no page scroll, square radar, locally scrolling rail. */
async function checkReplayLayout(evaluate, label) {
  await waitForUi(evaluate, `(() => {
    const c = document.querySelector('#replay-panel canvas[role=img]');
    return c && Math.abs(c.width - c.getBoundingClientRect().width * devicePixelRatio) <= 1 && [...c.parentElement.querySelectorAll('canvas')].every(canvas => canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data.some((v, i) => i % 4 === 3 && v > 0));
  })()`, label + ' Canvas resize');
  await assertNoPageScroll(evaluate, label);
  const layout = await evaluate(`(() => {
    const panel = document.getElementById('replay-panel');
    const canvas = panel.querySelector('canvas[role=img]'), map = canvas.parentElement, host = map.parentElement;
    const r = map.getBoundingClientRect(), h = host.getBoundingClientRect(), s = getComputedStyle(host);
    const left = h.left + parseFloat(s.borderLeftWidth) + parseFloat(s.paddingLeft);
    const top = h.top + parseFloat(s.borderTopWidth) + parseFloat(s.paddingTop);
    const right = h.right - parseFloat(s.borderRightWidth) - parseFloat(s.paddingRight);
    const bottom = h.bottom - parseFloat(s.borderBottomWidth) - parseFloat(s.paddingBottom);
    const contained = e => { const r = e.getBoundingClientRect(), p = panel.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.left >= p.left - 1 && r.right <= p.right + 1 && r.top >= p.top - 1 && r.bottom <= p.bottom + 1; };
    const bitmapNonempty = c => { const ctx = c.getContext('2d'), data = ctx.getImageData(0, 0, c.width, c.height).data; return data.some((v, i) => i % 4 === 3 && v > 0); };
    return { panelOverflow: panel.scrollHeight - panel.clientHeight,
      square: Math.abs(r.width - r.height) <= 1, size: r.width, available: Math.min(right - left, bottom - top),
      contained: r.left >= left - .1 && r.right <= right + .1 && r.top >= top - .1 && r.bottom <= bottom + .1,
      canvases: [...map.querySelectorAll('canvas')].map(c => ({ pixels: c.width, height: c.height, css: c.getBoundingClientRect().width, dpr: devicePixelRatio, drawn: bitmapNonempty(c) })),
      controls: contained(document.querySelector('[aria-label="播放回放"], [aria-label="暂停回放"]')),
      timeline: contained(document.querySelector('[aria-label="回放进度"]')),
      players: !!panel.querySelector('[aria-label="回放玩家状态"] button'), events: !!panel.querySelector('[aria-label="回放事件浏览"]') };
  })()`);
  assert.ok(layout.panelOverflow <= 1, `${label}: panel must not clip overflow`);
  assert.equal(layout.square, true, `${label}: radar must be square`);
  assert.equal(layout.contained, true, `${label}: radar exceeds padding/border content bounds ${JSON.stringify(layout)}`);
  assert.ok(layout.size > 0 && layout.size >= Math.floor(layout.available) - 1, `${label}: radar uses the available square`);
  for (const c of layout.canvases) {
    assert.equal(c.pixels, c.height);
    assert.ok(Math.abs(c.pixels - c.css * c.dpr) <= 1, `${label}: DPR bitmap mismatch`);
    assert.equal(c.drawn, true, `${label}: Canvas must be redrawn after resize`);
  }
  assert.equal(layout.controls, true, `${label}: playback control clipped`);
  assert.equal(layout.timeline, true, `${label}: bottom timeline clipped`);
  assert.equal(layout.players, true); assert.equal(layout.events, true);
  const narrow=await evaluate('innerWidth <= 860');
  // Narrow mode deliberately delegates the visible-overflow rail to the body scroller.
  await assertLocalScroll(evaluate, '[data-replay-body], ' + (narrow ? '' : '[data-replay-rail], ') + '[aria-label="回放玩家状态"], [aria-label="回放事件浏览"]', label);
  await assertReplayContentAccessible(evaluate,label);
}

async function assertReplayContentAccessible(evaluate,label) {
  const accessible=await evaluate(`(() => {
    const panel=document.getElementById('replay-panel');
    const saved=[panel,...panel.querySelectorAll('*')].filter(e=>typeof e.scrollTo==='function').map(e=>[e,e.scrollTop,e.scrollLeft]);
    const selectors=['[aria-label="回放玩家状态"] button:first-child','[aria-label="回放玩家状态"] button:last-child','[aria-label="回放事件浏览"] > :first-child','[aria-label="回放事件浏览"] > :last-child','[aria-label="回放进度"]','[aria-label="回放回合"]'];
    try{return selectors.map(selector=>{
      const element=panel.querySelector(selector);if(!element)return {selector,ok:false};
      element.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});
      const r=element.getBoundingClientRect();
      let ok=r.width>0&&r.height>0&&r.left>=-1&&r.right<=innerWidth+1&&r.top>=-1&&r.bottom<=innerHeight+1;
      for(let ancestor=element.parentElement;ancestor;ancestor=ancestor.parentElement){
        const style=getComputedStyle(ancestor),a=ancestor.getBoundingClientRect();
        // scrollIntoView can programmatically scroll hidden containers; users cannot.
        if(['hidden','clip'].includes(style.overflowY)&&ancestor.scrollHeight-ancestor.clientHeight>1)ok=false;
        if(['auto','scroll','hidden','clip'].includes(style.overflowY))ok=ok&&r.top>=a.top+ancestor.clientTop-1&&r.bottom<=a.top+ancestor.clientTop+ancestor.clientHeight+1;
      }
      return {selector,ok};
    });}finally{for(const [e,top,left] of saved)e.scrollTo({top,left,behavior:'instant'});}
  })()`);
  for(const item of accessible)assert.equal(item.ok,true,`${label}: unreachable ${item.selector}`);
}
async function waitForPausedFrame(evaluate, label) {
  // The button commits before the next rAF paints the clock's final paused tick.
  // Require that final frame, then the existing exact 250ms stability assertion can observe it.
  await waitForUi(evaluate, `Boolean(document.querySelector('[aria-label=播放回放]'))&&document.querySelector('#replay-panel canvas[role=img]').dataset.tick===document.querySelector('[data-replay-session]').dataset.replayTick`, label);
}
const root=fileURLToPath(new URL('../',import.meta.url)),desktop=join(root,'apps/desktop');
const require=createRequire(new URL('../apps/desktop/package.json',import.meta.url));
const production=process.argv.includes('--production'),broken=process.argv.includes('--broken'),noMaps=process.argv.includes('--no-map'),nuke=process.argv.includes('--nuke');
const qa=join(root,'.tmp/p6-qa');mkdirSync(qa,{recursive:true});
const resourceManifest=JSON.parse(readFileSync(join(root,'docs/replay-resources.json'),'utf8'));
const expectedImages=resourceManifest.maps.flatMap(map=>map.images.map(image=>({prefix:`${map.map}${image.id==='default'?'':'_'+image.id}-`,...image})));
if(broken)writeFileSync(join(qa,'broken.dem'),'synthetic corrupt input, not a real DEM fixture');
const demo=broken?join(qa,'broken.dem'):join(root,nuke?'.demo/nuke.dem':'.demo/dust2.dem');assert.ok(existsSync(demo),'Selected local DEM required; no downloads');
if(!broken&&!nuke){
  assert.equal(statSync(demo).size,557650967);
  const digest=createHash('sha256');for await(const chunk of createReadStream(demo))digest.update(chunk);
  assert.equal(digest.digest('hex'),'db90fe85aab023a1d2c8a5996182e6120d98ef494f02a070b17982b235e4958c','Wrong local Dust2 bytes; no substitute');
}
const executableArgument=process.argv.slice(2).find(arg=>!arg.startsWith('--'));
const installed=executableArgument?resolve(executableArgument):null;
const executable=installed??require('electron');assert.ok(existsSync(executable));
const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));
const profilePrefix=join(tmpdir(),'cs2-analyst-replay-profile-');
const profile=mkdtempSync(profilePrefix);
const env={...process.env,NODE_PATH:'',CS2_ANALYST_DEM_PATH:demo,CS2_ANALYST_TEST_DEM_PATH:demo};delete env.ELECTRON_RUN_AS_NODE;delete env.ELECTRON_RENDERER_URL;
const startedAt=Date.now();
const child=spawn(executable,[...(installed?[]:['.']),`--remote-debugging-port=${port}`,`--user-data-dir=${profile}`,'--disable-features=CalculateNativeWinOcclusion','--disable-backgrounding-occluded-windows'],{cwd:installed?dirname(installed):desktop,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
const scope=new ProcessScope(),tracked=scope.track(child,'replay Electron',startedAt);
let logs='',page,browser,metrics={};child.stdout.on('data',d=>logs+=d);child.stderr.on('data',d=>logs+=d);
async function waitFor(fn,label,timeout=30_000){
  return waitForState(async()=>{
    if(tracked.error)throw new Error(`Electron launcher failed: ${tracked.error.message}`,{cause:tracked.error});
    const result=await fn();if(result)return result;
    if(child.exitCode!==null||child.signalCode!==null)throw new Error(`Electron exited while waiting for ${label}: ${child.exitCode} ${logs}`);
    return result;
  },timeout,label,{intervalMs:50,diagnostics:async()=>({pid:child.pid,exitCode:child.exitCode,logs:logs.slice(-4000),state:page?await page.evaluate('({status:document.querySelector("main")?.dataset.status,replay:document.querySelector("[data-replay-session]")?.dataset,text:document.body.innerText.slice(-1500)})'):null})});
}
const connect=connectCdp;
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function processTree(){
  return (await scope.live()).filter(p=>p.pid!==child.pid).map(p=>({Id:p.pid,Role:p.commandLine?.includes('node.mojom.NodeService')?'analysis-utility':p.commandLine?.includes('--type=renderer')?'renderer':p.commandLine?.includes('--type=gpu-process')?'gpu':'other',PeakWorkingSet64:p.peakWorkingSet,WorkingSet64:p.workingSet}));
}
const quantiles=values=>{const s=values.toSorted((a,b)=>a-b);return {count:s.length,p50:s[Math.floor(s.length*.5)],p95:s[Math.floor(s.length*.95)],max:s.at(-1)};};
let reportFingerprint,runFailure;
try{
  await scope.live();
  const target=await waitFor(async()=>{try{return (await(await fetch(`http://127.0.0.1:${port}/json/list`,{signal:AbortSignal.timeout(1000)})).json()).find(p=>p.type==='page');}catch{return null;}},'CDP page');
  page=await connect(target.webSocketDebuggerUrl);const version=await(await fetch(`http://127.0.0.1:${port}/json/version`,{signal:AbortSignal.timeout(1000)})).json();browser=await connect(version.webSocketDebuggerUrl);
  const exceptions=[];page.socket.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.method==='Runtime.exceptionThrown')exceptions.push(m.params);});
  const evaluate=async expression=>{const r=await page.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result?.value;};
  const canvasSelector='#replay-panel canvas[role=img]';
  const seekReplay=async tick=>{
    await evaluate(`(()=>{const slider=document.querySelector('[aria-label="回放进度"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(slider,${tick});slider.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await waitFor(()=>evaluate(`Math.abs(Number(document.querySelector('${canvasSelector}').dataset.tick)-${tick})<.01`),'utility seek '+tick);
  };
  const selectReplayRound=async round=>{
    await evaluate('document.querySelector("[aria-label=回放回合]").click()');
    await waitForUi(evaluate, `Boolean([...document.querySelectorAll('[role=option]')].find(o=>o.textContent.trim()===${JSON.stringify('R'+round)}))`,'round option R'+round);
    await evaluate(`[...document.querySelectorAll('[role=option]')].find(o=>o.textContent.trim()===${JSON.stringify('R'+round)}).click()`);
    await waitFor(()=>evaluate(`document.querySelector('[data-replay-session]').dataset.replayRound===${JSON.stringify(String(round))}`),'round selection R'+round);
  };
  const effectCount=async name=>Number(await evaluate(`Number(document.querySelector('${canvasSelector}').dataset.${name})||0`));
  const capture=async name=>{const shot=await page.send('Page.captureScreenshot',{format:'png'});writeFileSync(join(qa,name),Buffer.from(shot.data,'base64'));};
  await page.send('Runtime.enable');await page.send('Page.enable');await page.send('Network.enable');await page.send('Network.emulateNetworkConditions',{offline:true,latency:0,downloadThroughput:-1,uploadThroughput:-1});
  await waitFor(()=>evaluate('Boolean(window.cs2Analyst&&document.querySelector("main"))'),'preload/React');
  assert.equal(await evaluate('typeof window.require'),'undefined');
  const packageInfo=installed?inspectReplayPackage(dirname(installed),production?'production':'test-seam'):null;
  const imagePaths=packageInfo?.imagePaths??readdirSync(join(desktop,'dist/renderer/assets')).filter(f=>expectedImages.some(image=>f.startsWith(image.prefix)&&f.endsWith('.png'))).map(f=>'assets/'+f);
  const decoded=await evaluate(`Promise.all(${JSON.stringify(imagePaths)}.map(path=>new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>resolve({url:image.src,width:image.naturalWidth,height:image.naturalHeight});image.onerror=()=>reject(new Error('Offline radar failed: '+path));image.src=new URL(path,location.href).href;})))`);
  assert.equal(decoded.length,noMaps?0:expectedImages.length);
  for(const image of noMaps?[]:expectedImages){const matches=decoded.filter(i=>i.url.split('/').at(-1).startsWith(image.prefix));assert.equal(matches.length,1);assert.equal(matches[0].width,image.width);assert.equal(matches[0].height,image.height);}
  if(installed)assert.ok(decoded.every(i=>i.url.includes('/resources/app.asar/dist/renderer/assets/')));
  if(production||broken||noMaps){
    metrics={mode:noMaps?'built-event-only':production?'installed-production-startup':installed?'installed-broken':'built-broken',packageInfo,offlineDecodedImages:decoded};
    if(noMaps){await evaluate('[...document.querySelectorAll("button")].find(b=>b.textContent.includes("选择 DEM")).click()');await waitFor(()=>evaluate('document.querySelector("main")?.dataset.status==="success"'),'event-only report',120000);await evaluate('document.getElementById("replay-tab").click()');await waitFor(()=>evaluate('Number(document.querySelector("[data-replay-session]")?.dataset.replayRevision)>0'),'event-only data');assert.ok((await evaluate('document.getElementById("replay-panel").innerText')).includes('本机没有配套雷达资源'));assert.equal(await evaluate('document.querySelectorAll("#replay-panel canvas").length'),0);assert.ok(await evaluate('document.querySelectorAll("[aria-label=回放玩家状态] button").length>0'));metrics.eventOnlyFallback='PASS';}
    else if(broken){await evaluate('[...document.querySelectorAll("button")].find(b=>b.textContent.includes("选择 DEM")).click()');await waitFor(()=>evaluate('document.querySelector("main")?.dataset.status==="error"'),'corrupt DEM error');assert.ok((await evaluate('document.body.innerText')).includes('无法分析此 DEM'));await waitFor(async()=>!(await processTree()).some(p=>p.Role==='analysis-utility'),'failed import worker cleanup');metrics.corruptError='PASS';}
    else assert.equal(await evaluate('document.querySelector("main").dataset.status'),'idle');
    await closeApp({child,evaluate,socket:page.socket});
  }else{
  const before=(await processTree()).map(p=>p.Id);
  const imported=await evaluate('(async()=>{const start=performance.now();window.__p6=await window.cs2Analyst.importDemo();return {result:window.__p6,totalMs:performance.now()-start};})()');
  assert.equal(imported.result.kind,'success');const report=imported.result.report,meta=report.replay;
  assert.equal(meta.available,true,meta.unavailableReason??'Replay unavailable');assert.equal(report.schemaVersion,2);assert.equal(meta.perspective,'global');
  const {replay,heatmap,...baseReport}=report;reportFingerprint=hash(baseReport);
  const processes=(await browser.send('SystemInfo.getProcessInfo')).processInfo;
  const osProcesses=(await processTree());
  const workerIds=osProcesses.filter(p=>!before.includes(p.Id)&&p.Role==='analysis-utility').map(p=>p.Id);
  assert.ok(workerIds.length>0,'A real persistent Utility Process must exist');
  metrics={mode:installed?'installed-test-seam':nuke?'built-nuke':'built-electron',fixtureSha256:meta.matchId,totalImportMs:imported.totalMs,metadataBytes:Buffer.byteLength(JSON.stringify(meta)),processes,workerIds,processMemory:osProcesses};
  metrics.packageInfo=packageInfo;metrics.offlineDecodedImages=decoded;
  assert.ok(osProcesses.filter(p=>workerIds.includes(p.Id)).every(p=>p.PeakWorkingSet64<=2.5*1024**3),'Analysis utility peak stays within 2.5 GiB');
  const requests=meta.rounds.flatMap(r=>[r.blocks[0],r.blocks.at(-1)].map(b=>({sessionId:meta.sessionId,round:r.round,block:b.index}))).slice(0,12);
  const timings=[],sizes=[];
  for(const request of requests){const checked=await evaluate(`(async()=>{const start=performance.now(),r=await window.cs2Analyst.replay.getChunk(${JSON.stringify(request)});return {result:r,ms:performance.now()-start};})()`);assert.equal(checked.result.kind,'success');sizes.push(Buffer.byteLength(JSON.stringify(checked.result.chunk)));timings.push(checked.ms);}
  metrics.ipcMs=quantiles(timings);metrics.chunkBytes=quantiles(sizes);assert.ok(metrics.chunkBytes.max<=1024*1024);assert.ok(metrics.ipcMs.p95<=250);assert.ok(metrics.totalImportMs<=15_000,`Actual import ${metrics.totalImportMs}ms exceeds existing 15000ms acceptance budget`);
  console.log(JSON.stringify({stage:'real-ipc',...metrics.ipcMs,totalImportMs:metrics.totalImportMs}));
  // Enter through the actual import UI. This also verifies replacement of the earlier API session.
  await evaluate('[...document.querySelectorAll("button")].find(b=>b.textContent.includes("选择 DEM")).click()');
  await waitFor(()=>evaluate('document.querySelector("main")?.dataset.status==="success"&&Boolean(document.getElementById("replay-tab"))'),'UI report',120_000);
  const rejected=await evaluate(`window.cs2Analyst.replay.getChunk(${JSON.stringify(requests[0])})`);assert.equal(rejected.kind,'error');
  const opened=await evaluate('(()=>{const start=performance.now();document.getElementById("replay-tab").click();return start;})()');
  await waitFor(()=>evaluate('document.querySelector("[data-replay-session]")?.dataset.replayMapReady==="true"&&Number(document.querySelector("[data-replay-session]")?.dataset.replayRevision)>0&&Boolean(document.querySelector("#replay-panel canvas[role=img]")?.dataset.tick)'),'first Canvas frame');
  metrics.firstFrameMs=await evaluate(`performance.now()-${opened}`);assert.ok(metrics.firstFrameMs<=1500);
  const replayText = await evaluate('document.getElementById("replay-panel").innerText');
  assert.ok(replayText.includes('比赛回放'), 'the replay surface uses the unified 比赛回放 title');
  assert.equal(replayText.includes('地图回放'), false, 'no stale 地图回放 label remains');
  assert.ok(replayText.includes('地图版本未确认')); assert.equal(replayText.includes('仅示意'), false, 'map version label is shortened only');
  assert.equal(await evaluate('document.querySelector("[data-replay-session]").dataset.replayContinuous'), 'on');
  assert.equal(await evaluate('document.querySelector("#replay-panel [role=switch]").checked'), true, 'continuous playback defaults on');
  assert.ok((await evaluate('document.querySelector("#replay-panel [role=switch]").parentElement.innerText')).includes('连续播放'));
  await evaluate('document.querySelector("#replay-panel [aria-label=地图说明]").focus()');
  assert.equal(await evaluate('document.activeElement?.getAttribute("aria-label")==="地图说明"'),true,'keyboard focus reaches the map info icon');
  await waitFor(()=>evaluate(`[...document.querySelectorAll('[role=tooltip]')].some(t=>t.textContent.includes('全局比赛观察视角'))`),'map info tooltip on keyboard focus',10000);
  assert.ok(await evaluate(`[...document.querySelectorAll('[role=tooltip]')].some(t=>t.textContent.includes('白框为选中玩家'))`));
  await evaluate('document.activeElement.blur()');
  await checkReplayLayout(evaluate, '比赛回放默认窗口');
  // P7 utility evidence: real projectile runs and real effect windows, not fabricated lines.
  const effectProbe=await evaluate(`(async()=>{
    const session=document.querySelector('[data-replay-session]'),chunks=[];
    for(const block of [0,1,2,3,4,5,6,7]){const r=await window.cs2Analyst.replay.getChunk({sessionId:session.dataset.replaySession,round:1,block});if(r.kind==='success')chunks.push(r.chunk);}
    const utilities=chunks.flatMap(c=>c.utilities??[]),events=chunks.flatMap(c=>c.events);
    const withFlight=kind=>utilities.find(u=>u.kind===kind&&u.trajectory&&u.trajectory.points.length>=2);
    return {smoke:withFlight('smoke'),flash:withFlight('flashbang'),he:withFlight('hegrenade'),
      utilityEvent:events.find(e=>e.type==='utility'&&e.description.includes('投掷了')&&!e.description.includes('decoy')),
      killEvent:events.find(e=>e.type==='kill')??events.find(e=>e.type==='bomb')};
  })()`);
  assert.ok(effectProbe.smoke,'real smoke trajectory required');assert.ok(effectProbe.flash,'real flash trajectory required');
  assert.ok(effectProbe.he,'real HE trajectory required');assert.ok(effectProbe.utilityEvent,'real utility event copy required');
  assert.ok(effectProbe.killEvent&&!effectProbe.killEvent.description.includes('投掷了'),'non-utility copy stays unchanged');
  const flightTick=Math.floor((effectProbe.smoke.trajectory.startTick+effectProbe.smoke.trajectory.endTick)/2);
  await seekReplay(flightTick);
  await waitFor(()=>evaluate(`Number(document.querySelector('${canvasSelector}').dataset.flying)>0`),'flying utility icon and trail');
  assert.equal(await effectCount('smoke'),0,'a projectile is not drawn as an area before detonation');
  await capture('p7-utility-trajectory.png');
  const smokeTick=effectProbe.smoke.tick+Math.min(128,Math.floor((effectProbe.smoke.endTick-effectProbe.smoke.tick)/2));
  await seekReplay(smokeTick);
  await waitFor(()=>evaluate(`Number(document.querySelector('${canvasSelector}').dataset.smoke)>0`),'smoke area window');
  assert.equal(await effectCount('flying'),0,'the detonated projectile is no longer flying');
  await capture('p7-utility-smoke.png');
  await seekReplay(effectProbe.smoke.trajectory.startTick-20);
  await waitFor(()=>evaluate(`Number(document.querySelector('${canvasSelector}').dataset.effects)===0`),'backward seek clears future effects');
  await seekReplay(effectProbe.flash.tick+2);
  await waitFor(()=>evaluate(`Number(document.querySelector('${canvasSelector}').dataset.flashes)>0`),'flash burst');
  await waitFor(()=>evaluate(`Number(document.querySelector('${canvasSelector}').dataset.blind)>0`),'real blind victim window');
  await capture('p7-utility-flash-blind.png');
  await seekReplay(effectProbe.he.tick+32);
  await waitFor(()=>evaluate(`Number(document.querySelector('${canvasSelector}').dataset.explosions)>0`),'HE burst');
  await capture('p7-utility-he.png');
  await seekReplay(effectProbe.he.tick+Math.round(meta.tickRate)+2);
  await waitFor(()=>evaluate(`Number(document.querySelector('${canvasSelector}').dataset.explosions)===0`),'HE burst ends after one second');
  await seekReplay(effectProbe.utilityEvent.tick);
  await waitFor(()=>evaluate(`Boolean(document.querySelector('[data-replay-event="${effectProbe.utilityEvent.id}"]'))`),'utility key event row');
  const utilityText=await evaluate(`document.querySelector('[data-replay-event="${effectProbe.utilityEvent.id}"]').textContent`);
  assert.ok(utilityText.includes(effectProbe.utilityEvent.description),'key event row uses the real thrower copy');
  assert.ok(utilityText.includes('投掷了'));
  await evaluate(`document.querySelector('[data-replay-event="${effectProbe.utilityEvent.id}"]').click()`);
  await waitFor(()=>evaluate(`Math.abs(Number(document.querySelector('${canvasSelector}').dataset.tick)-${effectProbe.utilityEvent.tick})<.01`),'key event click seek');
  await waitFor(()=>evaluate(`Number(document.querySelector('${canvasSelector}').dataset.effects)>0`),'effect state after event click');
  await seekReplay(effectProbe.killEvent.tick);
  await waitFor(()=>evaluate(`Boolean(document.querySelector('[data-replay-event="${effectProbe.killEvent.id}"]'))`),'kill key event row');
  const killText=await evaluate(`document.querySelector('[data-replay-event="${effectProbe.killEvent.id}"]').textContent`);
  assert.ok(killText.includes(effectProbe.killEvent.description)&&!killText.includes('投掷了'),'kill copy is unchanged');
  const revisionBeforeRound=await evaluate('Number(document.querySelector("[data-replay-session]").dataset.replayRevision)');
  await selectReplayRound(2);
  await waitFor(()=>evaluate(`Number(document.querySelector('[data-replay-session]').dataset.replayRevision)>${revisionBeforeRound}`),'R2 replay block load');
  await waitFor(()=>evaluate(`Number(document.querySelector('${canvasSelector}').dataset.effects)===0&&Number(document.querySelector('${canvasSelector}').dataset.flying)===0`),'round switch clears all old effects');
  const fireProbe=await evaluate(`(async()=>{
    const session=document.querySelector('[data-replay-session]'),chunks=[];
    for(const block of [0,1,2,3]){const r=await window.cs2Analyst.replay.getChunk({sessionId:session.dataset.replaySession,round:2,block});if(r.kind==='success')chunks.push(r.chunk);}
    return (chunks.flatMap(c=>c.utilities??[])).find(u=>u.kind==='fire'&&u.trajectory&&u.trajectory.points.length>=2)??null;
  })()`);
  assert.ok(fireProbe,'real fire trajectory required');
  await seekReplay(fireProbe.tick+64);
  await waitFor(()=>evaluate(`Number(document.querySelector('${canvasSelector}').dataset.fire)>0`),'fire area window');
  await capture('p7-utility-fire.png');
  await selectReplayRound(1);
  const roundOne=meta.rounds.find(round=>round.round===1);
  await waitFor(()=>evaluate(`Number(document.querySelector('[data-replay-session]').dataset.replayTick)===${roundOne.startTick}`),'R1 start tick');
  await waitFor(()=>evaluate(`Number(document.querySelector('${canvasSelector}').dataset.effects)===0&&Number(document.querySelector('${canvasSelector}').dataset.flying)===0`),'round return starts from clean effect state');
  // Round menu: compact cap, internal scroll, selected option reveal, keyboard-close.
  await evaluate('document.querySelector("[aria-label=回放回合]").click()');
  await waitForUi(evaluate, `Boolean([...document.querySelectorAll('[role=listbox]')].at(-1)?.querySelector('[role=option]'))`, 'round menu open');
  const menu = await evaluate(`(() => {
    const box=[...document.querySelectorAll('[role=listbox]')].at(-1), r=box.getBoundingClientRect(), selected=box.querySelector('[aria-selected=true]'), sr=selected?.getBoundingClientRect();
    return { height:r.height, top:r.top, bottom:r.bottom, viewport:innerHeight, scrollHeight:box.scrollHeight, clientHeight:box.clientHeight,
      overflow:getComputedStyle(box).overflowY, options:box.querySelectorAll('[role=option]').length,
      selectedVisible: Boolean(sr && sr.top>=r.top-1 && sr.bottom<=r.bottom+1) };
  })()`);
  assert.equal(menu.options, meta.rounds.length, 'the menu exposes exactly the metadata rounds');
  assert.ok(menu.height <= 320.5, 'round menu height is capped at 320px');
  assert.ok(menu.top >= -1 && menu.bottom <= menu.viewport + 1, 'round menu stays inside the application viewport');
  assert.equal(menu.overflow, 'auto');
  assert.ok(menu.scrollHeight > menu.clientHeight, 'a long round list scrolls inside the popup');
  assert.equal(menu.selectedVisible, true, 'the selected round is revealed when the menu opens');
  const menuShot = await page.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(qa, 'p7-round-menu-320.png'), Buffer.from(menuShot.data, 'base64'));
  await evaluate('document.querySelector("[aria-label=回放回合]").focus()');
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await waitForUi(evaluate, `(() => {const b=document.querySelector('[role=listbox]');return !b||!b.checkVisibility();})()`, 'round menu Escape close');
  if(nuke){
    assert.equal(meta.map,'de_nuke');
    const base=`document.querySelector('#replay-panel canvas[aria-hidden=true]')`;
    // Record the exact decoded asset actually painted into the real base Canvas.
    // Repeated GPU readback can switch Chromium to software resampling; encoded/pixel equality
    // across those backends is not a reliable test of which floor was drawn.
    await evaluate(`(() => {const original=CanvasRenderingContext2D.prototype.drawImage;window.__qaFloorDraws=[];
      window.__qaRestoreFloorDraw=()=>{CanvasRenderingContext2D.prototype.drawImage=original;};
      CanvasRenderingContext2D.prototype.drawImage=function(image,...args){if(this.canvas===${base})window.__qaFloorDraws.push({source:image.src,width:image.naturalWidth,height:image.naturalHeight,args});return original.call(this,image,...args);};})()`);
    await withCleanup(async()=>{
    for(const label of ['下层','主层','跟随玩家']){
      await evaluate(`document.querySelector('[aria-label="回放楼层"]').click()`);
      await waitForUi(evaluate, `Boolean([...document.querySelectorAll('[role=option]')].find(o=>o.textContent.trim()===${JSON.stringify(label)}))`, 'floor options '+label);
      await evaluate(`[...document.querySelectorAll('[role=option]')].find(o=>o.textContent.trim()===${JSON.stringify(label)}).click()`);
      await waitForUi(evaluate, `document.querySelector('[aria-label="回放楼层"]').textContent===${JSON.stringify(label)}&&document.querySelector('[data-replay-session]').dataset.replayMapReady==='true'&&${base}.getContext('2d').getImageData(0,0,${base}.width,${base}.height).data.some((v,i)=>i%4===3&&v>0)`, 'floor image ready '+label);
      const expectedImage=decoded.find(i=>i.url.split('/').at(-1).startsWith(label==='下层'?'de_nuke_lower-':'de_nuke-'));
      assert.ok(expectedImage,'known decoded Nuke floor asset');
      await waitForUi(evaluate, `(()=>{const last=window.__qaFloorDraws.at(-1),b=${base};return last?.source===${JSON.stringify(expectedImage.url)}&&last.width===1024&&last.height===1024&&JSON.stringify(last.args)===JSON.stringify([0,0,b.width,b.height]);})()`, 'correct decoded floor painted '+label);
      if(label==='下层') {
        // R1 freeze-frame players are on the main floor: no overlay marks is the expected result.
        await waitForUi(evaluate, `Number(document.querySelector('#replay-panel canvas[role=img]').dataset.playerCount)===0`, 'lower-floor overlay repaint');
        const state=await evaluate(`(async()=>{const session=document.querySelector('[data-replay-session]');const result=await window.cs2Analyst.replay.getChunk({sessionId:session.dataset.replaySession,round:1,block:0});return {result,drawn:Number(document.querySelector('#replay-panel canvas[role=img]').dataset.playerCount)};})()`);
        assert.equal(state.result.kind,'success');
        const firstFrame=state.result.chunk.frames[0];
        assert.ok(firstFrame.players.every(p=>p[4]!==null&&p[4]>-495),'fixture must independently prove no players on the lower floor');
        assert.equal(state.drawn,0,'other-floor players must not be painted on the lower floor');
        await assertReplayContentAccessible(evaluate,'Nuke lower-floor controls and rail');
      } else await checkReplayLayout(evaluate,'Nuke '+label);
      const shot=await page.send('Page.captureScreenshot',{format:'png'});writeFileSync(join(qa,`built-nuke-floor-${label}.png`),Buffer.from(shot.data,'base64'));
    }
    },[()=>evaluate('window.__qaRestoreFloorDraw();delete window.__qaRestoreFloorDraw;delete window.__qaFloorDraws')]);
    metrics.floorSwitch='PASS (real Nuke DEM; main/lower/automatic and distinct bitmaps)';
  }

  const uiStart=await evaluate('Number(document.querySelector("[data-replay-session]").dataset.replayTick)');
  await evaluate('document.querySelector("[aria-label=播放回放]").click()');
  await waitFor(()=>evaluate(`Number(document.querySelector('#replay-panel canvas[role=img]')?.dataset.tick)>${uiStart}`),'playback frame advances');
  await evaluate('document.querySelector("[aria-label=暂停回放]").click()');await waitForPausedFrame(evaluate, 'paused clock frame');
  // A bounded 250ms observation verifies the paused clock stays stable.
  const paused=await evaluate('Number(document.querySelector("#replay-panel canvas[role=img]").dataset.tick)');assert.ok(paused>uiStart);await delay(250);assert.equal(await evaluate('Number(document.querySelector("#replay-panel canvas[role=img]").dataset.tick)'),paused);
  await evaluate('document.querySelector("[aria-label=回放倍速]").click()');
  await evaluate('[...document.querySelectorAll("[role=option]")].find(o=>o.textContent.trim()==="2×").click()');
  const speedStart=await evaluate('Number(document.querySelector("#replay-panel canvas[role=img]").dataset.tick)');
  await evaluate('document.querySelector("[aria-label=播放回放]").click()');await waitFor(()=>evaluate(`Number(document.querySelector('#replay-panel canvas[role=img]')?.dataset.tick)-${speedStart}>40`),'2x playback advances >40 ticks');await evaluate('document.querySelector("[aria-label=暂停回放]").click()');await waitForPausedFrame(evaluate, '2x paused clock frame');
  const speedEnd=await evaluate('Number(document.querySelector("#replay-panel canvas[role=img]").dataset.tick)');assert.ok(speedEnd-speedStart>40,'2x playback advances the unified clock');
  const boundary=meta.rounds[0].blocks[0].endTick;
  await evaluate(`(()=>{const slider=document.querySelector('[aria-label="回放进度"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(slider,${boundary-4});slider.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await waitFor(()=>evaluate(`Math.abs(Number(document.querySelector('#replay-panel canvas[role=img]').dataset.tick)-${boundary-4})<.01`),'slider seek');
  await evaluate('document.querySelector("[aria-label=播放回放]").click()');await waitFor(()=>evaluate('Number(document.querySelector("[data-replay-session]").dataset.replayBlock)>=1'),'playback crosses real chunk boundary');await evaluate('document.querySelector("[aria-label=暂停回放]").click()');await waitForUi(evaluate, `Boolean(document.querySelector('[aria-label=播放回放]'))`, 'paused after boundary');
  assert.ok(await evaluate('Number(document.querySelector("[data-replay-session]").dataset.replayBlock)>=1'),'Continuous playback crosses a real chunk boundary');
  await evaluate('document.querySelector("[aria-label=回放回合]").click()');await evaluate('[...document.querySelectorAll("[role=option]")].find(o=>o.textContent.trim()==="R2").click()');
  await waitFor(()=>evaluate('document.querySelector("[data-replay-session]").dataset.replayRound==="2"'),'round selection');
  await evaluate('document.querySelector("#replay-panel canvas[role=img]").focus()');await page.send('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39});await page.send('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39});await waitFor(()=>evaluate(`Number(document.querySelector("#replay-panel canvas[role=img]").dataset.tick)>=${meta.rounds[1].startTick+63}`),'keyboard seek frame');
  assert.ok(await evaluate(`Number(document.querySelector("#replay-panel canvas[role=img]").dataset.tick)>=${meta.rounds[1].startTick+63}`));
  await evaluate('document.getElementById("timeline-tab").click();document.querySelector("[data-round-summary]").click()');
  const linkedTick=await evaluate('(()=>{const b=document.querySelector("[data-timeline-replay-tick]");const tick=Number(b.dataset.timelineReplayTick);b.click();return tick;})()');
  await waitFor(()=>evaluate(`Math.abs(Number(document.querySelector("#replay-panel canvas[role=img]")?.dataset.tick)-${linkedTick})<.01&&Number(document.querySelector('#replay-panel canvas[role=img]')?.dataset.playerCount)>0`),'Timeline exact tick link and rendered living players');
  await evaluate('document.querySelector("[aria-label=回放玩家状态] button:nth-child(2)").click()');assert.equal(await evaluate('document.querySelector("[aria-label=回放玩家状态] button:nth-child(2)").getAttribute("aria-pressed")'),'true');
  metrics.drawP95Ms=await evaluate('Number(document.querySelector("#replay-panel canvas[role=img]").dataset.drawP95)');assert.ok(metrics.drawP95Ms<=16.7);assert.ok(await evaluate('Number(document.querySelector("[data-replay-session]").dataset.replayCache)<=3'));
  metrics.sliderRail=await evaluate('(()=>{const e=document.querySelector("#replay-panel .fui-Slider__rail"),r=e.getBoundingClientRect(),t=document.querySelector("#replay-panel .fui-Slider__thumb").getBoundingClientRect(),c=getComputedStyle(e);return {width:r.width,height:r.height,background:c.background,display:c.display,opacity:c.opacity,centerGap:Math.abs(r.y+r.height/2-t.y-t.height/2)};})()');
  assert.ok(metrics.sliderRail.width>100&&metrics.sliderRail.height>=2&&metrics.sliderRail.centerGap<=1,'The visible progress rail aligns with its thumb');
  const finding=report.findings.find(f=>f.playerId===report.selectedPlayer&&f.evidence.some(e=>e.round!==undefined&&meta.rounds.some(r=>r.round===e.round)));
  if(finding){const index=meta.players.findIndex(p=>p.id===finding.playerId);await evaluate(`document.querySelector('[aria-label="回放玩家状态"] button:nth-child(${index+1})').click();document.getElementById('report-tab').click();document.querySelector('#report-panel details summary').click()`);
    const linked=await evaluate('(()=>{const b=document.querySelector("#report-panel [data-finding-replay-round]");if(!b)return null;const value={round:Number(b.dataset.findingReplayRound),tick:b.dataset.findingReplayTick?Number(b.dataset.findingReplayTick):null};b.click();return value;})()');assert.ok(linked);
    const r=meta.rounds.find(r=>r.round===linked.round),expected=linked.tick===null||linked.tick<r.startTick||linked.tick>r.endTick?r.startTick:linked.tick;
    await waitFor(()=>evaluate(`Number(document.querySelector('[data-replay-session]')?.dataset.replayRound)===${linked.round}&&Math.abs(Number(document.querySelector('#replay-panel canvas[role=img]')?.dataset.tick)-${expected})<.01`),'Finding evidence link');metrics.findingLink='PASS';
  }else metrics.findingLink='not eligible';
  metrics.screenshotSizing='CDP viewport/DPR simulation; native maximize/restore checked separately';
  await selectReplayRound(1);
  await waitFor(()=>evaluate(`Number(document.querySelector('[data-replay-session]').dataset.replayTick)===${roundOne.startTick}`),'R1 start for responsive screenshots');
  await seekReplay(smokeTick);
  await waitFor(()=>evaluate(`Number(document.querySelector('${canvasSelector}').dataset.smoke)>0`),'smoke visible for responsive screenshots');
  for(const [width,height,dpr] of [[1280,800,1],[1024,640,1],[1920,1032,1],[1280,800,2],[800,600,1],[1280,800,1]]){
    await page.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:dpr,mobile:false});
    await waitForUi(evaluate, `innerWidth === ${width} && innerHeight === ${height}`, 'viewport resize');
    assert.equal(await evaluate('document.documentElement.scrollWidth>window.innerWidth'),false,`horizontal overflow ${width}`);
    await checkReplayLayout(evaluate, `比赛回放 ${width}×${height}`);
    if(width===800){
      await evaluate(`(() => { const rail=document.querySelector('[data-replay-rail]'); window.__railStyle=rail.getAttribute('style'); rail.style.maxHeight='100px'; rail.style.overflowY='hidden'; })()`);
      await withCleanup(()=>assert.rejects(()=>assertReplayContentAccessible(evaluate,'intentional hidden rail probe'),/unreachable/),
        [()=>evaluate(`(() => { const rail=document.querySelector('[data-replay-rail]'); if(window.__railStyle===null)rail.removeAttribute('style');else rail.setAttribute('style',window.__railStyle); delete window.__railStyle; })()`)]);
      await checkReplayLayout(evaluate,'窄布局反向裁切检查后恢复');
    }
    const screenshot=await page.send('Page.captureScreenshot',{format:'png'});writeFileSync(join(qa,`${metrics.mode}-${width}x${height}.png`),Buffer.from(screenshot.data,'base64'));
  }
  await evaluate('document.querySelector("[data-sidebar-toggle]").click()');
  await waitForUi(evaluate, `document.querySelector('[data-app-sidebar]').dataset.collapsed === 'true' && document.getAnimations().every(a => a.playState !== 'running')`, 'replay collapsed sidebar');
  await checkReplayLayout(evaluate, '比赛回放折叠导航');
  await evaluate('document.querySelector("[data-sidebar-toggle]").click()');
  await waitForUi(evaluate, `document.querySelector('[data-app-sidebar]').dataset.collapsed === 'false' && document.getAnimations().every(a => a.playState !== 'running')`, 'replay expanded sidebar');
  await checkReplayLayout(evaluate, '比赛回放展开导航');
  await page.send('Emulation.clearDeviceMetricsOverride');
  // Real OS minimize: the page must pause, then restore through the existing native window controls.
  await evaluate('document.querySelector("[aria-label=播放回放]").click();window.cs2Analyst.window.minimize()');
  await waitFor(()=>evaluate('document.hidden&&Boolean(document.querySelector("[aria-label=播放回放]"))'),'native minimize visibility and paused state');
  // Observe 250ms in the background to detect unintended clock advancement.
  const backgroundTick=await evaluate('Number(document.querySelector("[data-replay-session]").dataset.replayTick)');await delay(250);
  assert.equal(await evaluate('Number(document.querySelector("[data-replay-session]").dataset.replayTick)'),backgroundTick);
  await evaluate('window.cs2Analyst.window.toggleMaximize()');await waitFor(()=>evaluate('!document.hidden'),'native restore');await evaluate('window.cs2Analyst.window.toggleMaximize()');
  await waitFor(()=>evaluate('Boolean(document.querySelector("[aria-label=播放回放]"))'),'restored playback stays paused');await settleUi(evaluate,'restore geometry');
  const restoredTick=await evaluate('Number(document.querySelector("#replay-panel canvas[role=img]").dataset.tick)');
  assert.ok(restoredTick>=backgroundTick&&restoredTick-backgroundTick<=meta.tickRate*.25,'Restore must not advance by background elapsed time');await delay(300);
  assert.equal(await evaluate('Number(document.querySelector("#replay-panel canvas[role=img]").dataset.tick)'),restoredTick,'Paused clock stays stable after restore');metrics.nativeBackgroundPause='PASS';
  const beforeCancel=await evaluate('document.querySelector("[data-replay-session]").dataset.replaySession');
  await evaluate('[...document.querySelectorAll("button")].find(b=>b.textContent.includes("重新选择 DEM")).click()');
  await waitFor(()=>evaluate('[...document.querySelectorAll("button")].some(b=>b.textContent==="取消导入")'),'cancel button');
  await evaluate('[...document.querySelectorAll("button")].find(b=>b.textContent==="取消导入").click()');
  await waitFor(()=>evaluate('document.querySelector("main").dataset.status==="success"'),'cancel retains previous report');
  assert.equal((await evaluate(`window.cs2Analyst.replay.getChunk({sessionId:${JSON.stringify(beforeCancel)},round:1,block:0})`)).kind,'error');
  await waitFor(async()=>!(await processTree()).some(p=>p.Role==='analysis-utility'),'cancelled worker cleanup');
  await evaluate('[...document.querySelectorAll("button")].find(b=>b.textContent.includes("重新选择 DEM")).click()');
  await waitFor(()=>evaluate('document.querySelector("main").dataset.status==="success"&&Boolean(document.querySelector("[data-replay-session]"))'),'successful reimport after cancellation',120_000);metrics.cancelAndReimport='PASS';
  // A current session can be explicitly released; it must reject requests and terminate its worker.
  const current=await evaluate('document.querySelector("[data-replay-session]").dataset.replaySession');
  const currentWorkerIds=(await processTree()).filter(p=>p.Role==='analysis-utility').map(p=>p.Id);assert.ok(currentWorkerIds.length>0);
  await evaluate(`window.cs2Analyst.replay.release(${JSON.stringify(current)})`);
  assert.equal((await evaluate(`window.cs2Analyst.replay.getChunk({sessionId:${JSON.stringify(current)},round:1,block:0})`)).kind,'error');
  await waitFor(async()=>!(await processTree()).some(p=>currentWorkerIds.includes(p.Id)),'current worker cleanup');
  assert.deepEqual(exceptions,[]);
  await evaluate('[...document.querySelectorAll("button")].find(b=>b.textContent.includes("重新选择 DEM")).click()');
  await waitFor(async()=>(await processTree()).some(p=>p.Role==='analysis-utility'),'worker exists before close');
  assert.ok(['parsing','analyzing'].includes(await evaluate('document.querySelector("main").dataset.status')),'Close-during-parse check must observe an in-flight import');
  await closeApp({child,evaluate,socket:page.socket});
  await waitFor(async()=>!(await processTree()).some(p=>p.Role==='analysis-utility'),'no orphan worker');metrics.closeDuringParse='PASS';
  }
}catch(error){
  runFailure=new Error(`Replay Electron check failed\n${logs}`,{cause:error});
  if(page)try{const bitmap=await page.evaluate(`document.querySelector('#replay-panel canvas[aria-hidden=true]')?.toDataURL()`);if(bitmap)writeFileSync(join(qa,'failure-base.png'),Buffer.from(bitmap.split(',')[1],'base64'));const state=await page.send('Runtime.evaluate',{expression:'({text:document.body.innerText,root:document.querySelector("[data-replay-session]")?.outerHTML.slice(0,1000),canvas:[...document.querySelectorAll("#replay-panel canvas")].map(c=>({width:c.width,height:c.height,data:{...c.dataset}}))})',returnByValue:true});writeFileSync(join(qa,'failure-state.json'),JSON.stringify(state,null,2));const shot=await page.send('Page.captureScreenshot',{format:'png'});writeFileSync(join(qa,'failure.png'),Buffer.from(shot.data,'base64'));}catch(diagnosticError){console.warn('Failure diagnostic capture failed:',diagnosticError.message);}
}
finally{
  await withCleanup(()=>{if(runFailure)throw runFailure;},[
    ()=>{page?.socket.close();browser?.socket.close();},
    ()=>scope.cleanup(),
    async()=>{assert.ok(resolve(profile).startsWith(resolve(profilePrefix)),'Profile cleanup stays within this task temporary profile');await rm(profile,{recursive:true,force:true,maxRetries:8,retryDelay:250});}
  ]);
}
// The unchanged public report path must equal the worker's report, excluding additive replay metadata.
if(!production&&!broken&&!noMaps){const { analyzeDemoFile }=await import('../apps/desktop/electron/report.ts');const baseline=await analyzeDemoFile(demo);assert.equal(baseline.kind,'success');assert.equal(hash(baseline.report),reportFingerprint);metrics.reportUnchanged=true;metrics.reportFingerprint=reportFingerprint;}
metrics.status='PASS';writeFileSync(join(qa,`${metrics.mode}.json`),JSON.stringify(metrics,null,2)+'\n');
console.log(JSON.stringify({stage:'PASS',mode:metrics.mode,firstFrameMs:metrics.firstFrameMs,drawP95Ms:metrics.drawP95Ms,reportUnchanged:metrics.reportUnchanged??'not-run-in-this-mode'}));
