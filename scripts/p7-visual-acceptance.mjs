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
import { replayTrajectorySample, replayTrajectoryTrail } from '../apps/desktop/renderer/src/replay-effects.ts';
import { replayMapDefinitions, worldToRadar } from '../apps/desktop/shared/replay-map-geometry.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const label = process.env.P7_VISUAL_LABEL ?? 'after';
assert.match(label, /^[a-z-]+$/);
const qa = join(root, '.tmp/p7-visual-' + label), demo = join(root, '.demo/dust2.dem');
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
const child = spawn(require('electron'), ['.', '--inspect=0', '--remote-debugging-port=' + port, '--user-data-dir=' + profile,
  '--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows'], {
  cwd: join(root, 'apps/desktop'), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
});
const scope = new ProcessScope(); scope.track(child, 'P7 visual acceptance', Date.now());
let page, mainInspector, failure, logs = '';
child.stdout.on('data', data => { logs += data; }); child.stderr.on('data', data => { logs += data; });
const metrics = { label, fixture: '.demo/dust2.dem', screenshots: [], checks: [], scenes: {} };
const wait = (probe, name, ms = 30000) => waitFor(probe, ms, name, { intervalMs: 50, diagnostics: () => logs.slice(-2500) });
const canvas = 'document.querySelector("#replay-panel canvas[role=img]")';
const fingerprint = value => createHash('sha256').update(value).digest('hex');
try {
  await scope.live();
  const target = await wait(async () => { try { return (await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()).find(t => t.type === 'page'); } catch { return null; } }, 'CDP');
  page = await connectCdp(target.webSocketDebuggerUrl);
  // Electron has no Browser.getWindowForTarget CDP method. Use its development-only
  // main-process inspector to resize this test window through Electron's real API.
  mainInspector = await connectCdp(await wait(() => /Debugger listening on (ws:\/\/\S+)/.exec(logs)?.[1], 'main inspector'));
  const nativeWindow = "process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron').BrowserWindow.getAllWindows()[0]";
  const evaluate = page.evaluate, exceptions = [];
  page.socket.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params); });
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
  const readRound = async round => evaluate(`(async()=>{const chunks=[];for(let block=0;block<20;block++){const r=await window.cs2Analyst.replay.getChunk({sessionId:${JSON.stringify(sessionId)},round:${round},block});if(r.kind!=='success')break;chunks.push(r.chunk);}return chunks;})()`);
  const rounds = [await readRound(1), await readRound(2)];
  const utilities = rounds.map(chunks => [...new Map(chunks.flatMap(c => c.utilities ?? []).map(u => [u.id, u])).values()]);
  const smoke = utilities[0].find(u => u.kind === 'smoke' && u.endTick - u.tick > 500);
  const fire = utilities[1].find(u => u.kind === 'fire' && u.endTick - u.tick > 200);
  const he = utilities[1].find(u => u.kind === 'hegrenade');
  assert.ok(smoke && fire);
  metrics.scenes.smoke = smoke; metrics.scenes.fire = fire;
  const roundTwo = process.env.P7_ROUND_TWO === '1';
  if(roundTwo){
    await wait(()=>evaluate(`Number(${canvas}.dataset.effectAssets)===8`),'all local sprites and official icons decoded');
    metrics.page=await evaluate('({url:location.href,title:document.title,text:document.getElementById("replay-panel").innerText})');
    assert.match(metrics.page.url,/index\.html$/);assert.ok(metrics.page.title);
    assert.ok(metrics.page.text.includes('比赛回放')&&!/vite-error-overlay/.test(metrics.page.text));
    for(const c of rounds.flat())for(const e of c.events.filter(e=>['utility','utility_throw'].includes(e.type)))assert.ok(!/smoke|flashbang|hegrenade|molotov|incendiary|decoy|fire/.test(e.description));
    const state=await evaluate('([...document.querySelectorAll("#replay-panel [role=switch]")].map(s=>({label:s.parentElement.innerText,checked:s.checked})))');
    assert.equal(state[0].checked,true);assert.match(state[0].label,/连续播放/);
    assert.equal(state[1].checked,false);assert.match(state[1].label,/显示昵称/);
  }
  const choose = async (name, value) => {
    await evaluate(`document.querySelector('[aria-label=${name}]').click()`);
    await wait(() => evaluate(`[...document.querySelectorAll('[role=option]')].some(o=>o.textContent.trim()===${JSON.stringify(value)})`), name + ' option');
    await evaluate(`[...document.querySelectorAll('[role=option]')].find(o=>o.textContent.trim()===${JSON.stringify(value)}).click()`);
  };
  const round = async number => {
    await choose('回放回合', 'R' + number);
    await wait(() => evaluate(`document.querySelector('[data-replay-session]').dataset.replayRound==='${number}'`), 'round ' + number);
  };
  const seek = async tick => {
    await evaluate(`(()=>{const s=document.querySelector('[aria-label=回放进度]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(s,${tick});s.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await wait(() => evaluate(`Math.abs(Number(${canvas}.dataset.tick)-${tick})<.01&&Number(${canvas}.dataset.playerCount)>0`), 'seek loaded ' + tick);
  };
  // Compare the actual composited radar. Canvas readback can switch GPU/CPU raster
  // backends and introduce dithering; compositor capture also includes the real map.
  const bitmap = async () => {
    const clip = await evaluate(`(async()=>{await new Promise(ok=>requestAnimationFrame(()=>requestAnimationFrame(ok)));const r=${canvas}.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,scale:1};})()`);
    return 'data:image/png;base64,' + (await page.send('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: false })).data;
  };
  const shot = async name => {
    await settleUi(evaluate, 'screenshot ' + name);
    await evaluate('new Promise(ok=>requestAnimationFrame(()=>requestAnimationFrame(ok)))');
    const result = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const path = join(qa, name + '.png'); writeFileSync(path, Buffer.from(result.data, 'base64')); metrics.screenshots.push(path);
  };
  const length = points => points.slice(1).reduce((sum, b, i) => sum + Math.hypot(b.x - points[i].x, b.y - points[i].y), 0);
  const candidates = [];
  for (let ri = 0; ri < utilities.length; ri++) for (const u of utilities[ri]) if (u.trajectory) {
    for (let tick = u.trajectory.startTick + 52; tick < u.tick; tick += 4) {
      const sample = replayTrajectorySample(u.trajectory, tick, 64);
      if (sample && sample.speed > 50) {
        const amount=Math.min(1,Math.max(0,(sample.speed-100)/900));
        candidates.push({ round: ri + 1, utility: u.id, tick, speed: sample.speed, trail: length(replayTrajectoryTrail(u.trajectory, tick, 64, label==='before'?.34:undefined)), baseline: length(replayTrajectoryTrail(u.trajectory,tick,64,.30+.48*amount*amount*(3-2*amount))), previousRoundTwo: length(replayTrajectoryTrail(u.trajectory,tick,64,.30+1.05*amount*amount*(3-2*amount))), fixed34: length(replayTrajectoryTrail(u.trajectory, tick, 64, .34)), fixed65: length(replayTrajectoryTrail(u.trajectory, tick, 64, .65)) });
      }
    }
  }
  // Stable fixture/ticks across before/after; local current speed also lengthens the history.
  const fast = candidates.filter(c => c.speed > 900).sort((a,b) => b.speed - a.speed)[0];
  const slow = candidates.filter(c => c.speed < 160).sort((a,b) => a.speed - b.speed)[0];
  assert.ok(fast && slow); metrics.scenes.trails = { fast, slow };
  const trimmed=roundTwo?candidates.filter(c=>c.speed>700&&c.previousRoundTwo>c.trail*1.1).sort((a,b)=>b.speed-a.speed)[0]:null;
  if(roundTwo){assert.ok(trimmed,'a fast real flight demonstrates the reduced coefficient');metrics.scenes.trails.trimmed=trimmed;}
  for (const [width, height] of [[1024,640],[1920,1032]]) {
    const bounds = await mainInspector.evaluate(`(()=>{const w=${nativeWindow};w.unmaximize();w.setBounds({x:0,y:0,width:${width},height:${height}});return w.getBounds();})()`);
    assert.equal(bounds.width,width); assert.equal(bounds.height,height);
    await wait(() => evaluate(`innerWidth===${width}&&innerHeight===${height}`), 'native window size');
    await settleUi(evaluate, 'resize ' + width);
    await round(1);
    for (const [phase, tick] of [['early',smoke.tick+10],['middle',smoke.tick+Math.floor((smoke.endTick-smoke.tick)/2)],['fade',smoke.endTick-35]]) {
      await seek(tick); await shot(`smoke-${phase}-${width}`);
    }
    for (const [name, scene] of Object.entries({ fast, slow })) { await round(scene.round); await seek(scene.tick); await shot(`trail-${name}-${width}`); }
    if(trimmed){await round(trimmed.round);await seek(trimmed.tick);await shot(`trail-trimmed-${width}`);}
    await round(2);
    for (let i=0;i<5;i++) { await seek(fire.tick+64+i*11); await shot(`fire-${i}-${width}`); }
    if(roundTwo){
      await seek(fire.tick+64);
      await wait(()=>evaluate(`Number(${canvas}.dataset.nicknameCount)<=1`),'nicknames default off');
      await shot(`nicknames-off-${width}`);
      await evaluate('document.querySelectorAll("#replay-panel [role=switch]")[1].click()');
      await wait(()=>evaluate(`document.querySelectorAll("#replay-panel [role=switch]")[1].checked&&Number(${canvas}.dataset.nicknameCount)>1&&Number(${canvas}.dataset.nicknameCount)===Number(${canvas}.dataset.playerCount)`),'all player nicknames');
      await shot(`nicknames-on-${width}`);
      await evaluate('document.getElementById("report-tab").click()');
      assert.equal(await evaluate('[...document.querySelectorAll("[role=switch]")].some(s=>s.checkVisibility()&&s.parentElement.innerText.includes("显示昵称"))'),false);
      await evaluate('document.getElementById("replay-tab").click()');
      await wait(()=>evaluate('document.querySelectorAll("#replay-panel [role=switch]")[1].checked'),'nickname view state survives tab switch');
      await evaluate('document.querySelectorAll("#replay-panel [role=switch]")[1].click()');
      assert.ok(he);metrics.scenes.he=he;
      for(const delta of [0,4,8,16,24,33]){await seek(he.tick+delta);await shot(`he-${delta}-${width}`);}
      await seek(he.tick+8);const shards=await bitmap();await delay(180);assert.equal(await bitmap(),shards,'HE pause');
      await seek(he.tick+20);assert.notEqual(await bitmap(),shards,'HE fragments move');
      await seek(he.tick+8);assert.equal(await bitmap(),shards,'HE reverse seek repeats');
      await seek(he.tick+32);
      assert.equal(await evaluate(`Number(${canvas}.dataset.explosions)`),utilities[1].filter(u=>u.kind==='hegrenade'&&he.tick+32>=u.tick&&he.tick+32<u.tick+Math.min(u.endTick-u.tick,32)).length,'HE clears at half a second');
      await round(1);
      const events=[...new Map(rounds[0].flatMap(c=>c.events).map(e=>[e.id,e])).values()];
      const release=events.find(e=>e.type==='utility_throw'&&e.description.includes('烟雾弹'));
      assert.ok(release);metrics.scenes.release=release;
      await seek(release.tick);
      await wait(()=>evaluate(`Boolean(document.querySelector('[data-replay-event="${release.id}"]'))`),'real release visible at native tick');
      await shot(`throw-chinese-${width}`);
      await evaluate(`document.querySelector('[data-replay-event="${release.id}"]').click()`);
      assert.equal(await evaluate(`Number(${canvas}.dataset.tick)`),release.tick);
      await seek(smoke.tick);
      await shot(`effect-chinese-${width}`);
      await seek(release.tick-1);
      assert.equal(await evaluate(`Boolean(document.querySelector('[data-replay-event="${release.id}"]'))`),false,'backward hides future throw');
      metrics.checks.push(`native ${width}x${height}: nickname on/off/tab isolation; HE motion/pause/reverse; Chinese release/effect; exact release seek`);
    }
    assert.ok(await evaluate('document.documentElement.scrollHeight-innerHeight<=1'));
  }
  if (process.env.P7_CAPTURE_FIRE === '1') {
    // A real 1x playback excerpt, captured from Electron's compositor, for human animation review.
    await round(2); await choose('回放倍速', '1×'); await seek(fire.tick + 32);
    const point = worldToRadar(replayMapDefinitions.find(map=>map.id==='de_dust2'), {x:fire.position[0],y:fire.position[1]});
    const clip = await evaluate(`(()=>{const r=${canvas}.getBoundingClientRect();return {x:Math.round(r.x+${point.x}/1024*r.width-100),y:Math.round(r.y+${point.y}/1024*r.height-80),width:200,height:160,scale:1};})()`);
    metrics.firePlaybackFrames=[];
    await evaluate("document.querySelector('[aria-label=播放回放]').click()");
    for(let frame=0;frame<16;frame++) {
      await delay(100);
      const state=await evaluate(`({tick:Number(${canvas}.dataset.tick),time:performance.now()})`);
      const shot=await page.send('Page.captureScreenshot',{format:'png',clip,captureBeyondViewport:false});
      const path=join(qa,`fire-play-${String(frame).padStart(2,'0')}.png`);
      writeFileSync(path,Buffer.from(shot.data,'base64'));metrics.firePlaybackFrames.push({...state,path});
    }
    await evaluate("document.querySelector('[aria-label=暂停回放]').click()");
    assert.ok(metrics.firePlaybackFrames.at(-1).tick>metrics.firePlaybackFrames[0].tick);
  }
  await round(1); await seek(smoke.tick+160);
  const before = await bitmap();
  metrics.pauseBefore=await evaluate(`({data:{...${canvas}.dataset},width:${canvas}.width,height:${canvas}.height,paused:!!document.querySelector('[aria-label=播放回放]')})`);
  await delay(400); const pausedBitmap=await bitmap();
  metrics.pauseAfter=await evaluate(`({data:{...${canvas}.dataset},width:${canvas}.width,height:${canvas}.height,paused:!!document.querySelector('[aria-label=播放回放]')})`);
  if(pausedBitmap!==before){writeFileSync(join(qa,'pause-before.png'),Buffer.from(before.split(',')[1],'base64'));writeFileSync(join(qa,'pause-after.png'),Buffer.from(pausedBitmap.split(',')[1],'base64'));}
  assert.equal(fingerprint(pausedBitmap), fingerprint(before), 'pause freezes all pixels');
  await seek(smoke.tick+200); assert.notEqual(await bitmap(), before, 'local smoke changes with tick');
  await seek(smoke.tick+160); assert.equal(await bitmap(), before, 'repeat seek identical pixels');
  metrics.checks.push('pause pixel equality; same-tick seek pixel equality; smoke local motion');
  await seek(smoke.tick-1);
  const expectedSmoke = utilities[0].filter(u => u.kind==='smoke' && smoke.tick-1>=u.tick && smoke.tick-1<=u.endTick).length;
  assert.equal(await evaluate('Number(' + canvas + '.dataset.smoke)'), expectedSmoke, 'backward clears future smoke');
  await seek(smoke.endTick+1);
  assert.equal(await evaluate('Number(' + canvas + '.dataset.smoke)'), utilities[0].filter(u=>u.kind==='smoke'&&smoke.endTick+1>=u.tick&&smoke.endTick+1<=u.endTick).length);
  await round(2); await seek(fire.endTick+1);
  assert.equal(await evaluate('Number(' + canvas + '.dataset.fire)'), utilities[1].filter(u=>u.kind==='fire'&&fire.endTick+1>=u.tick&&fire.endTick+1<=u.endTick).length);
  metrics.checks.push('backward seek; exact smoke/fire end without residue');
  await seek(fire.tick+64); const firePixels = await bitmap();
  await seek(fire.tick+75); assert.notEqual(await bitmap(), firePixels, 'fire local animation changes');
  await seek(fire.tick+64); assert.equal(await bitmap(), firePixels, 'fire seek deterministic');
  // Actual playback clock at each speed, then an isolated steady-scene draw sample.
  // Dynamic playback p95 is also measured by the separate replay-smoke regression.
  metrics.playback = [];
  for (const speed of [1,2,4]) {
    await choose('回放倍速', speed+'×'); await seek(fire.tick+40);
    const start = await evaluate(`(()=>{document.querySelector('[aria-label=播放回放]').click();return {time:performance.now(),tick:Number(${canvas}.dataset.tick)};})()`);
    await delay(500);
    const end = await evaluate(`(()=>{document.querySelector('[aria-label=暂停回放]').click();return {time:performance.now(),tick:Number(${canvas}.dataset.tick),p95:Number(${canvas}.dataset.drawP95)};})()`);
    const ratio = (end.tick-start.tick)/64/((end.time-start.time)/1000);
    assert.ok(Math.abs(ratio-speed)<speed*.25, 'speed follows Replay clock');
    // Instrumentation retains 120 frames; let this paused scene replace prior history.
    await delay(2200);
    end.p95=await evaluate('Number('+canvas+'.dataset.drawP95)');
    const frozen = await bitmap(); await delay(180); assert.equal(await bitmap(), frozen);
    metrics.playback.push({ speed, ratio, drawP95Ms: end.p95 });
  }
  metrics.checks.push('1x/2x/4x clock and paused bitmap');
  // Multi-effect scene and same sampled cross-chunk state when directly seeking back.
  const multi = utilities.flatMap((list,index)=>list.filter(u=>u.kind==='smoke').map(u=>({round:index+1,tick:u.tick+64,count:list.filter(v=>v.kind==='smoke'&&u.tick+64>=v.tick&&u.tick+64<=v.endTick).length}))).sort((a,b)=>b.count-a.count)[0];
  assert.ok(multi.count>1); await round(multi.round); await seek(multi.tick); await shot('multiple-smoke-1920'); metrics.scenes.multi=multi;
  await round(1);
  const firstChunk=rounds[0][0], secondChunk=rounds[0][1];
  await seek(firstChunk.endTick); const boundary=await bitmap();
  await seek(secondChunk.startTick+8); await seek(firstChunk.endTick); assert.equal(await bitmap(),boundary);
  await round(2); assert.equal(await evaluate('Number('+canvas+'.dataset.effects)'),0);
  metrics.checks.push('multi smoke; cross chunk reverse seek; round reset');
  metrics.pixelFingerprints={smoke:fingerprint(before),fire:fingerprint(firePixels)};
  if(roundTwo){
    await evaluate('document.querySelectorAll("#replay-panel [role=switch]")[1].click()');
    await wait(()=>evaluate('document.querySelectorAll("#replay-panel [role=switch]")[1].checked'),'nickname before reimport');
    await evaluate('document.querySelector("[data-sidebar-import]").click()');
    await wait(()=>evaluate('document.querySelector("main").dataset.status==="success"&&document.querySelector("[data-replay-session]")?.dataset.replaySession!=='+JSON.stringify(sessionId)),'new real import resets replay',120000);
    await evaluate('document.getElementById("replay-tab").click()');
    await wait(()=>evaluate('document.querySelectorAll("#replay-panel [role=switch]").length===2'),'new replay ready');
    assert.equal(await evaluate('document.querySelectorAll("#replay-panel [role=switch]")[1].checked'),false);
    metrics.checks.push('new DEM session resets nickname switch to off');
  }
  assert.deepEqual(exceptions,[]); metrics.status='PASS';
} catch(error) { failure=error; metrics.status='FAIL'; metrics.error=String(error.stack||error); }
finally {
  writeFileSync(join(qa,'metrics.json'),JSON.stringify(metrics,null,2)+'\n');
  await withCleanup(()=>{if(failure)throw failure;},[
    ()=>{mainInspector?.socket.close();},
    async()=>{if(page)await closeApp({child,evaluate:page.evaluate,socket:page.socket});},
    ()=>{page?.socket.close();},()=>scope.cleanup(),
    async()=>{assert.ok(profile.startsWith(prefix));await rm(profile,{recursive:true,force:true,maxRetries:8,retryDelay:250});},
  ]);
}
console.log(JSON.stringify({status:metrics.status,qa,playback:metrics.playback,importUiMs:metrics.importUiMs}));
