// L2 offline restore acceptance: import once, delete the source DEM, reopen from the archive.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, createReadStream, existsSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOwnedQaRun, qaLaunchOptions } from './owned-qa-run.mjs';
import { connectCdp, waitFor } from './smoke-runtime.mjs';
import { ProcessScope } from './installed-smoke-lifecycle.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const fixture = resolve(process.argv[2] ?? 'E:/cs2-analyst/.demo/dust2.dem');
assert.match(fixture.replaceAll('\\', '/'), /\/(?:dust2|nuke|inferno|mirage|ancient|anubis|overpass|demo|demo1|demo2)\.dem$/);
const run = createOwnedQaRun('l2-restore', { parent: realpathSync(tmpdir()) });
const source = join(run.directory, fixture.split(/[\\/]/).at(-1));
const result = { schemaVersion: 1, stage: 'L2', startedAt: new Date().toISOString(), run, fixture: { fileName: source.split(/[\\/]/).at(-1) }, checks: [] };
const digest = value => createHash('sha256').update(value).digest('hex');
const withoutSession = value => JSON.parse(JSON.stringify(value, (key, item) => key === 'sessionId' ? undefined : item));
const scope = new ProcessScope();
let app;
const checkpoint = phase => { result.phase = phase; writeFileSync(join(run.output, 'restore.json'), JSON.stringify(result, null, 2) + '\n'); console.log('L2 ' + phase); };
async function launch(envExtra = {}) {
  const server = createServer(); await new Promise(done => server.listen(0, '127.0.0.1', done));
  const port = server.address().port; await new Promise(done => server.close(done));
  const options = qaLaunchOptions(run), env = { ...options.env, ...envExtra };
  delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL; delete env.CS2_ANALYST_TEST_DEM_PATH;
  if (!envExtra.CS2_ANALYST_DEM_PATH) delete env.CS2_ANALYST_DEM_PATH;
  const startedAt = Date.now();
  const child = spawn(require('electron'), ['.', ...options.applicationArgs, '--remote-debugging-port=' + port, '--disable-backgrounding-occluded-windows'],
    { cwd: join(root, 'apps/desktop'), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const tracked = scope.track(child, 'L2 product Electron', startedAt); await scope.live();
  const target = await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(tracked.stderr);
    try { return (await (await fetch('http://127.0.0.1:' + port + '/json/list', { signal: AbortSignal.timeout(1000) })).json()).find(item => item.type === 'page'); }
    catch { return null; }
  }, 30_000, 'L2 CDP');
  const page = await connectCdp(target.webSocketDebuggerUrl, 90_000); scope.sessions.add(page.socket);
  await waitFor(() => page.evaluate('Boolean(window.cs2Analyst?.library && document.querySelector("[data-import-card]"))'), 30_000, 'product preload');
  return { child, page, tracked };
}
async function close(current) {
  try { await current.page.evaluate('void window.cs2Analyst.window.close()'); } catch { /* Closing can disconnect CDP. */ }
  await waitFor(() => current.child.exitCode !== null, 15_000, 'product close', { diagnostics: () => ({ stderr: current.tracked.stderr }) });
  current.page.socket.close(); scope.sessions.delete(current.page.socket);
}
const reportExpression = `(() => {const node=document.getElementById('heatmap-panel');let f=node[Object.keys(node).find(k=>k.startsWith('__reactFiber$'))];while(f&&!f.memoizedProps?.report)f=f.return;return f.memoizedProps.report;})()`;
async function report(page) { return await page.evaluate(reportExpression); }
function heatmapRequests(metadata) {
  const scope = (rounds, playerIds, side, floor, freeze) => ({ rounds, playerIds, side, floor, includeFreezeTime: freeze, samplingSet: 'all-valid' });
  const requests = [
    { layer: 'positions', resolution: 32, scope: scope(null, null, 'all', null, false) },
    { layer: 'positions', resolution: 16, scope: scope([metadata.rounds[0]], [metadata.playerIds[0]], 'CT', null, true) },
  ];
  if (metadata.floors.length) requests.push({ layer: 'positions', resolution: 64, scope: scope(null, null, 'all', metadata.floors[0], false) });
  return requests.map(item => ({ schemaVersion: 1, sessionId: metadata.sessionId, ...item }));
}
async function heatmapHashes(page, metadata) {
  const hashes = [];
  for (const request of heatmapRequests(metadata)) {
    const reply = await page.evaluate('window.cs2Analyst.heatmap.getGrid(' + JSON.stringify(request) + ')');
    assert.equal(reply.kind, 'success', JSON.stringify(reply));
    hashes.push(digest(JSON.stringify(withoutSession(reply))));
  }
  return hashes;
}
async function replayHashes(page, metadata) {
  const indexes = [0, metadata.rounds.length - 1];
  const hashes = [];
  for (const index of indexes) {
    const round = metadata.rounds[index];
    const block = round.blocks[0].index;
    const reply = await page.evaluate('window.cs2Analyst.replay.getChunk(' + JSON.stringify({ sessionId: metadata.sessionId, round: round.round, block }) + ')');
    assert.equal(reply.kind, 'success', JSON.stringify(reply));
    hashes.push(digest(JSON.stringify(withoutSession(reply.chunk))));
  }
  return hashes;
}
async function sixViews(page, expected) {
  for (const [tab, panel] of [['report', 'report-panel'], ['deep-review', 'deep-review-panel'], ['timeline', 'timeline-panel'],
    ['analysis', 'analysis-panel'], ['replay', 'replay-panel'], ['heatmap', 'heatmap-panel']]) {
    await page.evaluate('document.getElementById("' + tab + '-tab").click()');
    await waitFor(() => page.evaluate('document.getElementById("' + panel + '")?.hidden === false'), 15_000, tab + ' panel');
    const text = await page.evaluate('document.getElementById("' + panel + '").innerText.length');
    assert.ok(text > 0, tab + ' panel must render content');
  }
  await page.evaluate('document.getElementById("replay-tab").click()');
  await waitFor(() => page.evaluate('Boolean(document.querySelector("[data-replay-session]"))'), 30_000, 'replay session');
  const session = await page.evaluate('document.querySelector("[data-replay-session]").dataset.replaySession');
  assert.equal(session, expected.replay.sessionId, 'Replay UI must use the fresh session');
  await page.evaluate('document.querySelector(\'[aria-label="直达最后"]\')?.click()');
  await waitFor(() => page.evaluate('document.querySelectorAll("[data-replay-event]").length > 0'), 30_000, 'Replay events');
  const endTick = await page.evaluate('Number(document.querySelector("[data-replay-session]").dataset.replayTick)');
  await page.evaluate('document.querySelector(\'[aria-label="回到最初"]\')?.click()');
  await waitFor(() => page.evaluate('Number(document.querySelector("[data-replay-session]").dataset.replayTick) < ' + endTick), 30_000, 'Replay return to start');
  const before = await page.evaluate('Number(document.querySelector("[data-replay-session]").dataset.replayTick)');
  await page.evaluate('document.querySelector(\'[aria-label="播放回放"]\')?.click()');
  await waitFor(() => page.evaluate('Number(document.querySelector("[data-replay-session]").dataset.replayTick) > ' + before), 20_000, 'Replay playback advances');
  await page.evaluate('document.querySelector(\'[aria-label="暂停回放"]\')?.click()');
}
try {
  checkpoint('fixture-hash');
  const hash = createHash('sha256'); for await (const bytes of createReadStream(fixture)) hash.update(bytes);
  result.fixture.sha256 = hash.digest('hex');
  copyFileSync(fixture, source);
  result.checks.push('source DEM copied only to an owned temporary directory for the absence simulation; the original local fixture is untouched');
  checkpoint('first-launch');
  app = await launch({ CS2_ANALYST_DEM_PATH: source });
  const importStart = performance.now();
  await app.page.evaluate('document.querySelector("[data-sidebar-import]").click()');
  await waitFor(() => app.page.evaluate('document.querySelector("main")?.dataset.status === "success"'), 120_000, 'initial import', {
    diagnostics: () => app.page.evaluate('({status:document.querySelector("main")?.dataset.status,text:document.body.innerText.slice(-1200)})') });
  result.importMs = performance.now() - importStart;
  result.productRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const first = await report(app.page);
  assert.equal(first.match.id, result.fixture.sha256);
  const catalogue = await app.page.evaluate('window.cs2Analyst.library.list()');
  assert.equal(catalogue.kind, 'success'); assert.equal(catalogue.total, 1);
  result.matchId = first.match.id; result.firstReportHash = digest(JSON.stringify(withoutSession(first)));
  result.firstReplaySessionId = first.replay?.sessionId ?? null;
  result.firstHeatmapHashes = await heatmapHashes(app.page, first.heatmap);
  result.firstReplayHashes = await replayHashes(app.page, first.replay);
  await close(app); app = null;
  rmSync(source);
  assert.equal(existsSync(source), false);
  result.sourceAbsent = !existsSync(source);
  result.checks.push('initial import persisted a ready catalogue entry and archived report/Replay/heatmap sources');
  checkpoint('source-removed');
  app = await launch();
  await waitFor(() => app.page.evaluate('document.querySelectorAll("[data-library-entry]").length === 1'), 30_000, 'library list entry');
  const openStart = performance.now();
  await app.page.evaluate('document.querySelector("[data-library-entry] button").click()');
  await waitFor(() => app.page.evaluate('document.querySelector("main")?.dataset.status === "success"'), 60_000, 'offline open', {
    diagnostics: () => app.page.evaluate('({status:document.querySelector("main")?.dataset.status,text:document.body.innerText.slice(-1200)})') });
  result.openMs = performance.now() - openStart;
  const restored = await report(app.page);
  assert.equal(restored.match.id, result.matchId);
  assert.notEqual(restored.replay?.sessionId, first.replay.sessionId, 'restore must issue a fresh Replay session');
  result.restoredReplaySessionId = restored.replay?.sessionId ?? null;
  result.freshReplaySession = result.restoredReplaySessionId !== result.firstReplaySessionId;
  result.restoredReportHash = digest(JSON.stringify(withoutSession(restored)));
  assert.equal(result.restoredReportHash, result.firstReportHash, 'report fingerprint must match');
  result.restoredHeatmapHashes = await heatmapHashes(app.page, restored.heatmap);
  assert.deepEqual(result.restoredHeatmapHashes, result.firstHeatmapHashes, 'every heatmap filter must match');
  result.restoredReplayHashes = await replayHashes(app.page, restored.replay);
  assert.deepEqual(result.restoredReplayHashes, result.firstReplayHashes, 'archived Replay chunks must match');
  result.checks.push('fresh Electron process reopened the match with the source DEM absent; report, filtered heatmaps and Replay chunks match');
  await sixViews(app.page, restored);
  result.checks.push('all six existing views render; Replay seeks, loads an archived block and advances from the fresh session');
  assert.equal(await app.page.evaluate('document.querySelectorAll("[data-library-entry]").length'), 0, 'report view replaces the library home');
  assert.equal(await app.page.evaluate('typeof window.require'), 'undefined');
  const listed = await app.page.evaluate('window.cs2Analyst.library.list()');
  assert.equal(listed.total, 1); assert.equal(listed.entries[0].matchId, result.matchId);
  result.catalogueTotal = listed.total; result.sixViewsRendered = true;
  result.checks.push('Renderer remains sandboxed and the catalogue still exposes exactly one ready match');
  await close(app); app = null;
  result.status = 'PASS'; checkpoint('restored');
} catch (error) {
  result.status = 'FAIL'; result.error = { message: error.message, stack: error.stack, appLogs: app?.tracked.stderr }; process.exitCode = 1;
} finally {
  if (app) try { await close(app); } catch (error) { result.cleanupError = error.message; }
  try { await scope.cleanup(); } catch (error) { result.cleanupError = error.message; result.status = 'FAIL'; process.exitCode = 1; }
  result.finishedAt = new Date().toISOString();
  writeFileSync(join(run.output, 'restore.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ status: result.status, evidence: join(run.output, 'restore.json'), error: result.error?.message }));
}
