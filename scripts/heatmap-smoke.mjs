// Actual built Electron preload -> Main -> Utility Process integration. No product test hooks.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { cpus, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Demoparser2Provider } from '../packages/dem-parser/dist/index.js';
import { projectMapHeatmap } from '../apps/desktop/shared/heatmap.ts';
import { dust2File, dust2Sha, jsonHash, realHeatmapRequests, verifyDust2 } from '../apps/desktop/tests/heatmap-real-fixture.mjs';
import { checkHeatmapUx, heatmapSnapshotExpression } from './heatmap-ux-checks.mjs';
import { closeApp, connectCdp, waitFor, withCleanup } from './smoke-runtime.mjs';
import { ProcessScope } from './installed-smoke-lifecycle.mjs';

const root = fileURLToPath(new URL('../', import.meta.url)), desktop = join(root, 'apps/desktop');
const qa = process.env.HEATMAP_QA_DIR ?? join(root, '.tmp/p73-qa');
mkdirSync(qa, { recursive: true });
assert.ok(existsSync(dust2File), 'BLOCKED: local .demo/dust2.dem missing; no download/substitute');
assert.ok(existsSync(join(desktop, 'dist/electron/main.js')), 'Build the desktop before this smoke');
await verifyDust2();
// Independent direct-function baseline in the controller process; production still parses once per import.
let parsed = await new Demoparser2Provider().parseWithReplay(dust2File);
assert.ok(parsed.replay); assert.ok(parsed.spatial);
const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const server = createServer();
await new Promise(resolvePort => server.listen(0, '127.0.0.1', resolvePort));
const port = server.address().port;
await new Promise(resolvePort => server.close(resolvePort));
await new Promise(resolvePort => server.listen(0, '127.0.0.1', resolvePort));
const inspectorPort = server.address().port;
await new Promise(resolvePort => server.close(resolvePort));
const profilePrefix = join(tmpdir(), 'cs2-analyst-p73-profile-'), profile = mkdtempSync(profilePrefix);
const env = { ...process.env, CS2_ANALYST_DEM_PATH: dust2File };
delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
const startedAt = Date.now();
const child = spawn(require('electron'), ['.', `--remote-debugging-port=${port}`, `--inspect=${inspectorPort}`, `--user-data-dir=${profile}`,
  '--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows'], {
  cwd: desktop, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
});
const scope = new ProcessScope(), tracked = scope.track(child, 'P7.3 heatmap built Electron', startedAt);
let logs = '', page, inspector, failure;
child.stdout.on('data', data => { logs += data; }); child.stderr.on('data', data => { logs += data; });
const metrics = { stage: 'P7.3', fixture: '.demo/dust2.dem', fixtureSha256: dust2Sha, fixtureBytes: 557650967,
  environment: { node: process.version, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model },
  method: 'Built Electron, real contextBridge/Main/Utility IPC, one timed call per case and five cached repeats. Times are individual observations, not p95. OS working set snapshots use scoped Win32_Process identity. No GC is forced inside Electron. A separate --expose-gc session test measures source-retention/cache/release stages.',
  requests: [], memory: [] };
const utilityProcesses = async () => (await scope.live()).filter(p => p.commandLine?.includes('node.mojom.NodeService'));
async function liveWait(probe, label, timeout = 30_000) {
  return waitFor(async () => {
    if (tracked.error) throw tracked.error;
    if (child.exitCode !== null) throw new Error(`Electron exited: ${child.exitCode}; ${logs}`);
    return probe();
  }, timeout, label, { diagnostics: () => ({ logs: logs.slice(-3000) }) });
}
async function memory(label) {
  const workers = await utilityProcesses();
  const rendererLive = page && child.exitCode === null && page.socket.readyState === WebSocket.OPEN;
  metrics.memory.push({ label,
    processes: (await scope.live()).map(p=>({pid:p.pid,name:p.name,workingSet:p.workingSet,peakWorkingSet:p.peakWorkingSet})),
    renderer: rendererLive ? await page.send('Runtime.getHeapUsage') : null,
    canvas: rendererLive ? await page.evaluate(`(() => {const c=document.querySelector('#heatmap-panel canvas');return c?{count:document.querySelectorAll('#heatmap-panel canvas').length,width:c.width,height:c.height,dpr:devicePixelRatio,pixelBytes:c.width*c.height*4}:null;})()`) : null,
    workers: workers.map(p => ({ pid: p.pid, created: p.created, workingSet: p.workingSet, peakWorkingSet: p.peakWorkingSet })) });
  return workers;
}
try {
  await scope.live();
  const target = await liveWait(async () => {
    try { return (await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) })).json()).find(t => t.type === 'page'); }
    catch { return null; }
  }, 'Electron CDP page');
  page = await connectCdp(target.webSocketDebuggerUrl, 180_000);
  const { evaluate } = page;
  const exceptions = [];
  page.socket.addEventListener('message', e => { const message = JSON.parse(e.data); if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params); });
  await page.send('Runtime.enable');
  page.socket.addEventListener('message', e => { const m=JSON.parse(e.data); if(m.method==='Runtime.consoleAPICalled'&&m.params.type==='error')console.error('Renderer console:',JSON.stringify(m.params.args)); });
  await liveWait(() => evaluate('Boolean(window.cs2Analyst?.heatmap&&window.cs2Analyst?.session&&document.querySelector("main"))'), 'typed preload API');
  assert.equal(await evaluate('typeof window.require'), 'undefined');
  await memory('before-import-no-utility');
  await evaluate(`window.__p73ImportStart=performance.now();document.querySelector('[data-sidebar-import]').click()`);
  await liveWait(async () => (await utilityProcesses()).length > 0, 'Utility spawn');
  await memory('utility-observed-during-import');
  await liveWait(()=>evaluate(`document.querySelector('main').dataset.status==='success'`),'actual Renderer import',120_000);
  const imported = await evaluate(`({result:{kind:'success',report:(()=>{let f=document.getElementById('heatmap-panel')[Object.keys(document.getElementById('heatmap-panel')).find(k=>k.startsWith('__reactFiber$'))];while(f&&!f.memoizedProps?.report)f=f.return;return f.memoizedProps.report;})()},ms:performance.now()-window.__p73ImportStart})`);
  assert.equal(imported.result.kind, 'success');
  const report = imported.result.report, metadata = report.heatmap;
  assert.equal(report.schemaVersion, 2); assert.equal(metadata.available, true);
  assert.equal(metadata.matchId, dust2Sha); assert.equal(metadata.map.alignment, 'unconfirmed');
  assert.equal(metadata.map.precision, 'schematic-position-distribution');
  assert.equal(report.replay.available, true); assert.equal(report.replay.sessionId, metadata.sessionId);
  metrics.electron = await page.evaluate('navigator.userAgent'); metrics.importMs = imported.ms;
  metrics.metadataBytes = Buffer.byteLength(JSON.stringify(metadata));
  metrics.metadata = metadata;
  const initialWorkers = await memory('after-import-both-session-caches');
  assert.equal(initialWorkers.length, 1, 'One existing analysis worker owns both sessions');
  const cases = realHeatmapRequests(metadata);
  console.log(JSON.stringify({ stage: 'heatmap-import', importMs: imported.ms, workerCount: initialWorkers.length }));
  const filteredBatchStart = performance.now();
  for (const { label, request } of cases) {
    const checked = await evaluate(`(async()=>{const start=performance.now();const result=await window.cs2Analyst.heatmap.getGrid(${JSON.stringify(request)});return {result,ms:performance.now()-start};})()`);
    assert.equal(checked.result.kind, 'success', `${label}: ${checked.result.message}`);
    const projection = checked.result.projection;
    const direct = projectMapHeatmap(parsed.match, parsed.replay, parsed.spatial,
      { ...request.scope, resolution: request.resolution, layers: [request.layer] });
    assert.deepEqual(projection, direct, `Real IPC/direct parity ${label}`);
    for (const layer of ['positions', 'kills', 'deaths']) assert.equal(projection[layer] === null, layer !== request.layer);
    const bytes = Buffer.byteLength(JSON.stringify(checked.result)); assert.ok(bytes <= 512 * 1024);
    metrics.requests.push({ label, request, ipcMs: checked.ms, responseBytes: bytes, projectionHash: jsonHash(projection) });
  }
  metrics.filteredBatchWallMs = performance.now() - filteredBatchStart;
  metrics.filteredIpcTotalMs = metrics.requests.reduce((total, item) => total + item.ipcMs, 0);
  console.log(JSON.stringify({ stage: 'heatmap-real-ipc', count: metrics.requests.length, totalIpcMs: metrics.filteredIpcTotalMs }));
  // Opt-in QA inspector observes the existing Main handler; its validation and limits remain intact.
  const inspectorTarget = await liveWait(async()=>{try{return (await (await fetch(`http://127.0.0.1:${inspectorPort}/json/list`,{signal:AbortSignal.timeout(1000)})).json())[0];}catch{return null;}}, 'Main QA inspector');
  inspector = await connectCdp(inspectorTarget.webSocketDebuggerUrl);
  await inspector.evaluate(`(() => {const {ipcMain}=process.getBuiltinModule('node:module').createRequire(${JSON.stringify(join(desktop,'package.json'))})('electron');const original=ipcMain._invokeHandlers.get('heatmap:grid');if(!original)throw new Error('Heatmap handler missing');globalThis.__qaHeatmapTraffic={active:0,max:0,requests:[]};ipcMain.removeHandler('heatmap:grid');ipcMain.handle('heatmap:grid',async(event,request)=>{const q=globalThis.__qaHeatmapTraffic,start=performance.now();q.active++;q.max=Math.max(q.max,q.active);try{const result=await original(event,request);q.requests.push({request,kind:result.kind,ms:performance.now()-start});return result;}finally{q.active--;}});globalThis.__qaRestoreHeatmap=()=>{ipcMain.removeHandler('heatmap:grid');ipcMain.handle('heatmap:grid',original);};})()`);
  await withCleanup(async()=>{
    metrics.ui = await checkHeatmapUx(evaluate, page.send, {qaDir:qa, expectedDust2:true, full:true, memory, direct:request=>projectMapHeatmap(parsed.match,parsed.replay,parsed.spatial,{...request.scope,resolution:request.resolution,layers:[request.layer]})});
    metrics.ui.traffic=await inspector.evaluate('globalThis.__qaHeatmapTraffic');
    assert.equal(metrics.ui.traffic.max,2,'Actual Renderer/Main in-flight peak');
    assert.equal(metrics.ui.traffic.active,0);
  },[()=>inspector.evaluate('globalThis.__qaRestoreHeatmap();delete globalThis.__qaRestoreHeatmap;delete globalThis.__qaHeatmapTraffic')]);
  inspector.socket.close(); inspector = null;
  parsed = null;
  const cachedRequest = cases.find(c => c.label === 'positions-32').request;
  const cachedHash = metrics.requests.find(c => c.label === 'positions-32').projectionHash;
  metrics.cachedRepeatIpcMs = [];
  for (let i = 0; i < 5; i++) {
    const checked = await evaluate(`(async()=>{const start=performance.now();const result=await window.cs2Analyst.heatmap.getGrid(${JSON.stringify(cachedRequest)});return {result,ms:performance.now()-start};})()`);
    assert.equal(checked.result.kind, 'success'); assert.equal(jsonHash(checked.result.projection), cachedHash);
    metrics.cachedRepeatIpcMs.push(checked.ms);
  }
  const defaultPosition = await evaluate(`window.cs2Analyst.heatmap.getGrid(${JSON.stringify(cachedRequest)})`);
  assert.equal(defaultPosition.projection.positions.observations.validPositionSamples, 178514);
  for (const [layer, located] of [['kills', 161], ['deaths', 162]]) {
    const checked = await evaluate(`window.cs2Analyst.heatmap.getGrid(${JSON.stringify({ ...cachedRequest, layer })})`);
    assert.equal(checked.projection[layer].scopeEvents, 162); assert.equal(checked.projection[layer].locatableEvents, located);
    assert.equal(checked.projection[layer].outsideWindowEvents, 4);
    if (layer === 'kills') assert.equal(checked.projection[layer].unlocatableReasons.worldActor, 1);
  }
  const concurrentRequest = { ...cachedRequest, resolution: 64, scope: { ...cachedRequest.scope, side: 'CT' } };
  const concurrent = await evaluate(`Promise.all(Array.from({length:3},()=>window.cs2Analyst.heatmap.getGrid(${JSON.stringify(concurrentRequest)})))`);
  assert.deepEqual(concurrent.map(r => r.kind), ['success', 'success', 'error']);
  metrics.concurrency = { attempted: 3, success: 2, rejected: 1 };
  await memory('after-30-filtered-and-repeated-concurrent-requests');
  const replayChunk = await evaluate(`window.cs2Analyst.replay.getChunk({sessionId:${JSON.stringify(metadata.sessionId)},round:1,block:0})`);
  assert.equal(replayChunk.kind, 'success', 'Heatmap requests preserve existing Replay');
  // New import invalidates old requests immediately. Cancel the new parse without waiting for completion.
  const replaced = await evaluate(`(async()=>{const pending=window.cs2Analyst.heatmap.getGrid(${JSON.stringify(concurrentRequest)});const importing=window.cs2Analyst.importDemo();const stale=await window.cs2Analyst.heatmap.getGrid(${JSON.stringify(cachedRequest)});await window.cs2Analyst.cancelImport();return {pending:await pending,stale,imported:await importing};})()`);
  assert.equal(replaced.pending.kind, 'error'); assert.equal(replaced.stale.kind, 'error'); assert.equal(replaced.imported.kind, 'cancelled');
  await liveWait(async () => (await utilityProcesses()).length === 0, 'cancel/reimport Utility cleanup');
  await memory('cancelled-replacement-no-utility');
  const second = await evaluate('window.cs2Analyst.importDemo()'); assert.equal(second.kind, 'success');
  const secondRequest = { ...concurrentRequest, sessionId: second.report.heatmap.sessionId };
  assert.notEqual(secondRequest.sessionId, metadata.sessionId);
  assert.equal((await evaluate(`window.cs2Analyst.heatmap.getGrid(${JSON.stringify(cachedRequest)})`)).kind, 'error');
  const released = await evaluate(`(async()=>{const requests=Array.from({length:2},()=>window.cs2Analyst.heatmap.getGrid(${JSON.stringify(secondRequest)}));await window.cs2Analyst.session.release(${JSON.stringify(secondRequest.sessionId)});return Promise.all(requests);})()`);
  assert.ok(released.every(r => r.kind === 'error'), 'Release settles all pending requests');
  assert.equal((await evaluate(`window.cs2Analyst.heatmap.getGrid(${JSON.stringify(secondRequest)})`)).kind, 'error');
  await liveWait(async () => (await utilityProcesses()).length === 0, 'released Utility exits');
  await memory('released-no-utility');
  // Exercise replacement and session-ended UI through the real store, rather than API calls alone.
  await evaluate(`document.querySelector('[data-sidebar-import]').click()`);
  await liveWait(() => evaluate(`document.querySelector('main')?.dataset.status==='success'&&document.querySelector('[data-heatmap-session]')?.dataset.heatmapSession!==${JSON.stringify(metadata.sessionId)}`), 'UI recovery and fresh session', 120_000);
  assert.equal(await evaluate(`document.getElementById('report-tab').getAttribute('aria-selected')`), 'true');
  assert.equal(await evaluate(`document.querySelectorAll('#heatmap-panel button[aria-pressed=true]').length`), 1, 'fresh report opens with the position layer on');
  assert.equal(await evaluate(`document.querySelectorAll('#heatmap-panel button[aria-pressed=false]').length`), 2, 'kill/death layers start off');
  await memory('after-ui-session-replacement');
  await evaluate(`document.getElementById('heatmap-tab').click()`);
  await liveWait(() => evaluate(`Boolean(document.querySelector('[data-heatmap-stats=positions]'))`), 'replacement UI layer');
  await evaluate(`window.cs2Analyst.session.release(document.querySelector('[data-heatmap-session]').dataset.heatmapSession)`);
  await evaluate(`document.querySelector('[aria-label="热力图阵营"]').click()`);
  await liveWait(() => evaluate(`Boolean([...document.querySelectorAll('[role=option]')].find(o=>o.checkVisibility()&&o.getAttribute('data-value')==='CT'))`), 'side option');
  await evaluate(`[...document.querySelectorAll('[role=option]')].find(o=>o.checkVisibility()&&o.getAttribute('data-value')==='CT').click()`);
  await liveWait(() => evaluate(`!document.querySelector('#heatmap-panel .fui-Spinner')&&[...document.querySelectorAll('#heatmap-panel button')].some(b=>b.textContent==='重试')&&!document.querySelector('[data-heatmap-stats]')`), 'ended-session request error terminates loading');
  metrics.sessionEndedUi = 'PASS: current request errors, no Spinner or stale statistics';
  await evaluate(`document.querySelector('[data-sidebar-import]').click()`);
  await liveWait(async () => (await utilityProcesses()).length > 0, 'Utility before close during import');
  await closeApp({ child, evaluate, socket: page.socket });
  await waitFor(async () => (await utilityProcesses()).length === 0, 30_000, 'no orphan Utility after close');
  await memory('after-window-close-no-utility');
  assert.deepEqual(exceptions, []);
  metrics.lifecycle = 'PASS: requests settled on replacement/cancel/release, stale sessions rejected, close-during-import leaves no Utility';
  metrics.timeout = 'Controlled timeout/fault injection belongs to runtime IPC tests; no timeout was manufactured in this actual Electron run.';
  metrics.status = 'PASS';
} catch (error) {
  failure = new Error(`P7.3 built Electron heatmap smoke failed\n${logs}`, { cause: error });
  metrics.status = 'FAIL'; metrics.error = String(error.stack ?? error);
  if(page)try{writeFileSync(join(qa,'failure-state.json'),JSON.stringify({text:await page.evaluate('document.body.innerText'),state:await page.evaluate(heatmapSnapshotExpression)},null,2));const shot=await page.send('Page.captureScreenshot',{format:'png'});writeFileSync(join(qa,'failure.png'),Buffer.from(shot.data,'base64'));}catch{}
  if(page&&child.exitCode===null)try{await closeApp({child,evaluate:page.evaluate,socket:page.socket});}catch{}
} finally {
  writeFileSync(join(qa, 'heatmap-electron.json'), JSON.stringify(metrics, null, 2) + '\n');
  await withCleanup(() => { if (failure) throw failure; }, [
    () => { page?.socket.close(); inspector?.socket.close(); }, () => scope.cleanup(),
    async () => { assert.ok(resolve(profile).startsWith(resolve(profilePrefix))); await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); },
  ]);
}
console.log(JSON.stringify({ status: metrics.status, requests: metrics.requests.length, importMs: metrics.importMs,
  cachedRepeatIpcMs: metrics.cachedRepeatIpcMs, reportFile: join(qa, 'heatmap-electron.json') }));
