// Targeted real Nuke semantic QA. One import; no Replay playback, installer, or performance acceptance.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { heatmapSnapshotExpression } from './heatmap-ux-checks.mjs';
import { closeApp, connectCdp, waitFor, withCleanup } from './smoke-runtime.mjs';
import { ProcessScope } from './installed-smoke-lifecycle.mjs';
import { settleUi } from './window-shell-checks.mjs';

const root = fileURLToPath(new URL('../', import.meta.url)), desktop = join(root, 'apps/desktop');
const fixture = join(root, '.demo/nuke.dem'), sha256 = 'dea9382b9cc263fed9ee4ed7e71fa6be8c176cf888868f05b26d850af6f5cb3c';
const qa = resolve(process.env.P7_S2_QA_DIR ?? join(root, '.tmp/p7-s2'));
assert.ok(existsSync(fixture), 'Local .demo/nuke.dem required; no download/substitute');
assert.ok(existsSync(join(desktop, 'dist/electron/main.js')), 'Build desktop before running');
const hash = createHash('sha256'); for await (const chunk of createReadStream(fixture)) hash.update(chunk);
assert.equal(hash.digest('hex'), sha256); assert.equal(statSync(fixture).size, 471606780);
mkdirSync(qa, { recursive: true });
const metrics = { status: 'RUNNING', fixture: '.demo/nuke.dem', sha256, bytes: statSync(fixture).size, cases: [], layouts: [], exceptions: [], consoleErrors: [],
  method: 'Uses repository Electron/CDP runtime for local desktop process and Main IPC; Browser connector not used, no browser skill listed. React current tree read only; Main traffic observer delegates original handler. Synthetic inputs are not used.' };
async function freePort() { const s = createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
const port = await freePort(), inspectorPort = await freePort(), require = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const profilePrefix = join(tmpdir(), 'cs2-analyst-s2-'), profile = mkdtempSync(profilePrefix), env = { ...process.env, CS2_ANALYST_DEM_PATH: fixture };
delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
const started = Date.now(), child = spawn(require('electron'), ['.', `--remote-debugging-port=${port}`, `--inspect=${inspectorPort}`, `--user-data-dir=${profile}`,
  '--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows'], { cwd: desktop, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const scope = new ProcessScope(), tracked = scope.track(child, 'P7-S2 targeted Nuke', started);
let page, inspector, failure;
const wait = (probe, label, timeout = 30_000) => waitFor(async () => {
  if (tracked.error) throw tracked.error;
  if (child.exitCode !== null) throw new Error(`Electron exited ${child.exitCode}: ${tracked.stderr}`);
  return probe();
}, timeout, label, { diagnostics: () => ({ stderr: tracked.stderr.slice(-3000) }) });
const targetAt = p => wait(async () => { try { return (await (await fetch(`http://127.0.0.1:${p}/json/list`, { signal: AbortSignal.timeout(1000) })).json())[0]; } catch { return null; } }, 'CDP target');
const asset = readFileSync(join(desktop, 'renderer/src/assets/replay-maps/de_nuke.png'));
metrics.radarSha256 = createHash('sha256').update(asset).digest('hex');
const compareBase = step => `(async() => {
  const c=document.querySelector('#heatmap-panel canvas'),a=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
  const image=new Image();image.src=${JSON.stringify('data:image/png;base64,' + asset.toString('base64'))};await image.decode();
  const r=document.createElement('canvas');r.width=c.width;r.height=c.height;const ctx=r.getContext('2d');ctx.drawImage(image,0,0,r.width,r.height);
  const b=ctx.getImageData(0,0,r.width,r.height).data;let opaque=0,expectedOpaque=0,alphaSamples=0,alphaMatches=0,interiorSamples=0,interiorMatches=0;
  for(let i=3;i<a.length;i+=4){if(a[i])opaque++;if(b[i])expectedOpaque++;}
  for(let y=0;y<c.height;y+=${step})for(let x=0;x<c.width;x+=${step}){
    const i=(y*c.width+x)*4;alphaSamples++;if((a[i+3]>0)===(b[i+3]>0))alphaMatches++;
    if(x<2||y<2||x>=c.width-2||y>=c.height-2)continue;
    let stable=true;for(let dy=-2;dy<=2&&stable;dy++)for(let dx=-2;dx<=2;dx++)if(b[((y+dy)*c.width+x+dx)*4+3]!==255){stable=false;break;}
    if(stable){interiorSamples++;if(a[i+3]===255&&[0,1,2].every(k=>Math.abs(a[i+k]-b[i+k])<=3))interiorMatches++;}
  }
  return {width:c.width,height:c.height,opaque,expectedOpaque,opaqueRatio:opaque/expectedOpaque,alphaSamples,alphaMatches,alphaMatch:alphaMatches/alphaSamples,interiorSamples,interiorMatches,interiorMatch:interiorMatches/interiorSamples};
})()`;
try {
  await scope.live(); page = await connectCdp((await targetAt(port)).webSocketDebuggerUrl, 120_000);
  scope.sessions.add(page.socket);
  page.socket.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.method === 'Runtime.exceptionThrown') metrics.exceptions.push(m.params);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') metrics.consoleErrors.push(m.params.args); });
  await page.send('Runtime.enable'); await page.send('Page.enable');
  const { evaluate, send } = page, snap = () => evaluate(heatmapSnapshotExpression);
  const painted = () => evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  const ready = () => wait(async () => { const s = await snap(); if (!s) return null; for (const l of s.enabled) {
    const state = s.results.layers[l]; if (state?.status === 'error') throw new Error(state.message);
    if (state?.status !== 'ready' || JSON.stringify(state.projection.scope.floor) !== JSON.stringify(s.scope.floor)) return null;
  } return s; }, 'current heatmap state');
  const shot = async name => { await settleUi(evaluate); const s = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); writeFileSync(join(qa, name + '.png'), Buffer.from(s.data, 'base64')); };
  const chooseFloor = async floor => { await evaluate(`(()=>{const s=document.querySelector('[aria-label="热力图楼层"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s,${JSON.stringify(floor ?? '')});s.dispatchEvent(new Event('change',{bubbles:true}));})()`); await ready(); await settleUi(evaluate); };
  await wait(() => evaluate('Boolean(window.cs2Analyst?.heatmap&&document.querySelector("main"))'), 'production preload');
  metrics.identity = await evaluate('({url:location.href,title:document.title,content:document.querySelector("main").innerText})');
  assert.equal(metrics.identity.title, 'CS2 Analyst'); assert.equal(metrics.identity.url, pathToFileURL(join(desktop, 'dist/renderer/index.html')).href); assert.ok(metrics.identity.content.length > 10);
  inspector = await connectCdp((await targetAt(inspectorPort)).webSocketDebuggerUrl); scope.sessions.add(inspector.socket);
  await inspector.evaluate(`(()=>{const {ipcMain}=process.getBuiltinModule('node:module').createRequire(${JSON.stringify(join(desktop, 'package.json'))})('electron'),original=ipcMain._invokeHandlers.get('heatmap:grid');if(!original)throw Error('handler missing');globalThis.__s2Traffic={calls:0,active:0};ipcMain.removeHandler('heatmap:grid');ipcMain.handle('heatmap:grid',async(e,r)=>{__s2Traffic.calls++;__s2Traffic.active++;try{return await original(e,r);}finally{__s2Traffic.active--;}});globalThis.__s2Restore=()=>{ipcMain.removeHandler('heatmap:grid');ipcMain.handle('heatmap:grid',original);};})()`);
  await evaluate(`document.querySelector('[data-sidebar-import]').click()`);
  await wait(() => evaluate(`document.querySelector('main').dataset.status==='success'`), 'real Nuke import', 120_000);
  const report = await evaluate(`(()=>{let f=document.getElementById('heatmap-panel')[Object.keys(document.getElementById('heatmap-panel')).find(k=>k.startsWith('__reactFiber$'))];while(f&&!f.memoizedProps?.report)f=f.return;return f.memoizedProps.report;})()`);
  assert.equal(report.heatmap.matchId, sha256); assert.equal(report.heatmap.map.id, 'de_nuke'); assert.equal(report.heatmap.map.alignment, 'unconfirmed');
  await evaluate(`document.getElementById('heatmap-tab').click()`); await ready(); await settleUi(evaluate);
  await evaluate(`for(const name of ['击杀位置','死亡位置'])document.querySelector('#heatmap-panel button[aria-label="'+name+'"]').click()`); await ready();
  for (const floor of [null, 'default', 'lower']) {
    await chooseFloor(floor); const s = await ready(); assert.deepEqual([...s.enabled].sort(), ['deaths', 'kills', 'positions']);
    const text = await evaluate(`document.getElementById('heatmap-panel').innerText`);
    assert.ok(text.includes('地图版本未确认')); if (floor === null) assert.ok(text.includes('全部楼层合并统计，底图为主层'));
    for (const layer of s.enabled) {
      const p = s.results.layers[layer].projection, request = { schemaVersion: 1, sessionId: s.metadata.sessionId, layer, resolution: s.resolution, scope: s.scope };
      const bridge = await evaluate(`window.cs2Analyst.heatmap.getGrid(${JSON.stringify(request)})`); assert.equal(bridge.kind, 'success'); assert.deepEqual(p, bridge.projection);
      const g = p[layer].grid; assert.equal(g.validPositionSamples, g.aggregatedSamples + g.outOfBounds + g.invalidMapping);
      const ui = await evaluate(`document.querySelector('[data-heatmap-stats=${layer}]').innerText`); assert.ok(ui.includes(`网格计数：${g.aggregatedSamples}`)); assert.ok(ui.includes(`其他楼层 ${g.otherFloor}`));
      if (layer !== 'positions') { assert.ok(ui.includes(`成功定位 / 楼层筛选前事件：${p[layer].locatableEvents} / ${p[layer].scopeEvents}`)); assert.ok(ui.includes('事件位置覆盖率（楼层筛选前）')); assert.ok(ui.includes('楼层只筛选网格')); }
      metrics.cases.push({ floor, layer, scope: p.scope, source: layer === 'positions' ? p.positions.observations : { scopeEvents: p[layer].scopeEvents, locatableEvents: p[layer].locatableEvents, coverage: p[layer].eventPositionCoverage, outsideWindowEvents: p[layer].outsideWindowEvents }, grid: { valid: g.validPositionSamples, aggregated: g.aggregatedSamples, outOfBounds: g.outOfBounds, invalidMapping: g.invalidMapping, unknownLayer: g.unknownLayer, otherFloor: g.otherFloor } });
    }
  }
  for (const layer of ['positions', 'kills', 'deaths']) {
    const cases = metrics.cases.filter(c => c.layer === layer); for (const c of cases) assert.deepEqual(c.source, cases[0].source, layer + ' source counts stay unchanged across floors');
  }
  await chooseFloor('default'); await evaluate(`document.querySelector('#heatmap-panel button[aria-label="玩家位置密度"]').click()`); await ready();
  for (const [width, height] of [[1024, 640], [1920, 1032]]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }); await settleUi(evaluate); await painted();
    const layout = await evaluate(`(()=>{const c=document.querySelector('#heatmap-panel canvas'),r=c.getBoundingClientRect(),a=document.querySelector('#heatmap-panel aside');return {viewport:[innerWidth,innerHeight],canvas:[c.width,c.height],css:[r.width,r.height],overflow:document.documentElement.scrollWidth>innerWidth||document.documentElement.scrollHeight>innerHeight,sideOverflow:getComputedStyle(a).overflowY};})()`);
    assert.equal(layout.overflow, false); assert.equal(layout.css[0], layout.css[1]); assert.equal(layout.sideOverflow, 'auto'); metrics.layouts.push(layout); await shot(`heatmap-${width}x${height}`);
  }
  await wait(async () => (await inspector.evaluate('__s2Traffic.active')) === 0, 'settled IPC'); const beforeOff = await inspector.evaluate('__s2Traffic.calls');
  await evaluate(`document.querySelectorAll('#heatmap-panel button[aria-pressed=true]').forEach(b=>b.click())`); await ready(); await settleUi(evaluate); await painted();
  assert.deepEqual((await snap()).enabled, []); assert.equal(await evaluate(`document.querySelectorAll('#heatmap-panel [data-heatmap-stats]').length`), 0);
  await evaluate(`(()=>{const canvas=document.querySelector('#heatmap-panel canvas'),proto=CanvasRenderingContext2D.prototype,original=proto.fillRect;window.__s2Fills=0;window.__s2RestoreFill=()=>{proto.fillRect=original;};proto.fillRect=function(...args){if(this.canvas===canvas)__s2Fills++;return original.apply(this,args);};window.dispatchEvent(new Event('resize'));})()`); await painted();
  metrics.allOff = await evaluate(compareBase(4)); metrics.allOff.overlayFillRects = await evaluate('__s2Fills');
  assert.ok(metrics.allOff.opaque > 0 && Math.abs(metrics.allOff.opaqueRatio - 1) <= .01); assert.ok(metrics.allOff.alphaMatch >= .999); assert.ok(metrics.allOff.interiorMatch >= .99); assert.equal(metrics.allOff.overlayFillRects, 0);
  assert.equal(await evaluate(`Boolean(document.querySelector('[data-heatmap-map] [role=status]'))`), false); await shot('heatmap-all-off');
  await evaluate(`document.getElementById('report-tab').click()`); await settleUi(evaluate); await evaluate(`document.getElementById('heatmap-tab').click()`); await settleUi(evaluate); await painted();
  assert.deepEqual((await snap()).enabled, []); metrics.afterTabReturn = await evaluate(compareBase(24));
  assert.ok(metrics.afterTabReturn.opaqueRatio >= .97 && metrics.afterTabReturn.alphaMatch >= .99 && metrics.afterTabReturn.interiorMatch >= .95);
  metrics.allOff.newIpcCalls = (await inspector.evaluate('__s2Traffic.calls')) - beforeOff; assert.equal(metrics.allOff.newIpcCalls, 0); assert.equal(await evaluate('__s2Fills'), 0); await evaluate('__s2RestoreFill();delete window.__s2RestoreFill;delete window.__s2Fills');
  const candidate = report.deepReview?.players.find(p => ['reviews', 'highlights', 'contexts'].some(g => p[g].some(f => f.ruleId === 'deep.teamplay.no-followup-pattern')));
  metrics.deepReview = { status: 'NOT RUN', reason: 'Real report contains no no-followup card' };
  if (candidate) {
    const nickname = report.players.find(p => p.id === candidate.playerId).nickname, group = ['reviews', 'highlights', 'contexts'].find(g => candidate[g].some(f => f.ruleId === 'deep.teamplay.no-followup-pattern'));
    await evaluate(`document.getElementById('deep-review-tab').click();document.querySelector('[aria-label="目标玩家"]').click()`);
    await wait(() => evaluate(`Boolean([...document.querySelectorAll('[role=option]')].find(o=>o.textContent===${JSON.stringify(nickname)}))`), 'real player option');
    await evaluate(`[...document.querySelectorAll('[role=option]')].find(o=>o.textContent===${JSON.stringify(nickname)}).click()`); await settleUi(evaluate);
    assert.equal(await evaluate(`document.querySelector('[data-deep-player]').dataset.deepPlayer`), candidate.playerId);
    await evaluate(`document.querySelector('[data-deep-tab=${group}]').click()`); await settleUi(evaluate);
    await evaluate(`document.querySelector('[data-deep-rule="deep.teamplay.no-followup-pattern"] summary').click()`); await settleUi(evaluate);
    const text = await evaluate(`document.querySelector('[data-deep-rule="deep.teamplay.no-followup-pattern"]').innerText`);
    assert.ok(text.includes('也包括受到伤害或被击杀')); assert.ok(text.includes('可能发生在队友阵亡之后')); assert.ok(text.includes('不能证明你在阵亡前已经参与')); assert.ok(text.includes('这不等同于补枪失败'));
    metrics.deepReview = { status: 'PASS', ruleId: 'deep.teamplay.no-followup-pattern', text }; await shot('real-no-followup-caveat');
  }
  metrics.pageHealth = await evaluate(`({status:document.querySelector('main').dataset.status,content:document.querySelector('main').innerText.length,frameworkOverlay:Boolean(document.querySelector('vite-error-overlay,webpack-dev-server-client-overlay'))})`);
  assert.equal(metrics.pageHealth.status, 'success'); assert.ok(metrics.pageHealth.content > 100); assert.equal(metrics.pageHealth.frameworkOverlay, false); assert.deepEqual(metrics.exceptions, []); assert.deepEqual(metrics.consoleErrors, []);
  await inspector.evaluate('__s2Restore();delete globalThis.__s2Restore;delete globalThis.__s2Traffic'); inspector.socket.close(); inspector = null;
  await closeApp({ child, evaluate, socket: page.socket }); await waitFor(async () => (await scope.live()).length === 0, 30_000, 'owned process exit'); metrics.lifecycle = { exitCode: child.exitCode, remaining: await scope.live() }; metrics.status = 'PASS';
} catch (error) {
  failure = error; metrics.status = 'FAIL'; metrics.error = String(error.stack ?? error);
  if (page && child.exitCode === null) try { const shot = await page.send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(qa, 'failure.png'), Buffer.from(shot.data, 'base64')); metrics.failureText = await page.evaluate('document.body.innerText'); } catch {}
} finally {
  try { await withCleanup(async () => {}, [async () => { if (inspector) await inspector.evaluate('globalThis.__s2Restore?.();delete globalThis.__s2Restore;delete globalThis.__s2Traffic'); },
    async () => { if (page && child.exitCode === null) await page.evaluate('window.__s2RestoreFill?.()'); }, () => { page?.socket.close(); inspector?.socket.close(); }, () => scope.cleanup(),
    async () => { assert.ok(resolve(profile).startsWith(resolve(profilePrefix))); await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); }]); }
  catch (error) { metrics.status = 'FAIL'; metrics.cleanupError = String(error.stack ?? error); failure ??= error; }
  writeFileSync(join(qa, 'p7-s2-electron.json'), JSON.stringify(metrics, null, 2) + '\n'); writeFileSync(join(qa, 'electron-output.log'), tracked.stdout + tracked.stderr);
}
if (failure) throw failure;
console.log(JSON.stringify({ status: metrics.status, cases: metrics.cases.length, deepReview: metrics.deepReview.status, report: join(qa, 'p7-s2-electron.json') }));
