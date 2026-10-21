// L3 local-library data operations acceptance (real Electron, dev build, owned LOCALAPPDATA).
// Import Dust2 once, export .cs2a, delete the active match, re-import the package offline,
// compare report/heatmap/replay hashes, then prove corrupt packages cannot replace it.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOwnedQaRun, qaLaunchOptions } from './owned-qa-run.mjs';
import { connectCdp, waitFor } from './smoke-runtime.mjs';
import { ProcessScope } from './installed-smoke-lifecycle.mjs';
import { verifyPortableArchive } from '../apps/desktop/electron/library-portable.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const fixture = resolve(process.argv[2] ?? 'E:/cs2-analyst/.demo/dust2.dem');
assert.match(fixture.replaceAll('\\', '/'), /\/(?:dust2|nuke|inferno|mirage|ancient|anubis|overpass|train|demo|demo1|demo2)\.dem$/);
const run = createOwnedQaRun('l3-data-ops', { parent: realpathSync(tmpdir()) });
const source = join(run.directory, fixture.split(/[\\/]/).at(-1));
const exportDirectory = join(run.directory, 'export');
const exportPath = join(exportDirectory, 'match.cs2a');
mkdirSync(exportDirectory);
const libraryRoot = join(run.localAppData, 'CS2 Analyst', 'MatchLibrary');
const result = { schemaVersion: 1, stage: 'L3', startedAt: new Date().toISOString(),
  run: { directory: run.directory, output: run.output, localAppData: run.localAppData },
  fixture: { fileName: source.split(/[\\/]/).at(-1) }, checks: [], timings: {} };
const digest = value => createHash('sha256').update(value).digest('hex');
const withoutSession = value => JSON.parse(JSON.stringify(value, (key, item) => key === 'sessionId' ? undefined : item));
const scope = new ProcessScope();
let app;
const checkpoint = phase => { result.phase = phase; writeFileSync(join(run.output, 'data-operations.json'), JSON.stringify(result, null, 2) + '\n'); console.log('L3 ' + phase); };

/** Never download: reuse the checked-out Electron dist through the documented override. */
function ensureElectronBinary() {
  if (process.env.ELECTRON_OVERRIDE_DIST_PATH) return;
  if (existsSync(join(root, 'apps/desktop/node_modules/electron/dist/electron.exe'))) return;
  const cache = join(dirname(resolve(root)), 'cs2-analyst', 'node_modules', '.pnpm');
  if (existsSync(cache)) {
    for (const entry of readdirSync(cache)) {
      if (!entry.startsWith('electron@')) continue;
      const candidate = join(cache, entry, 'node_modules/electron/dist');
      if (existsSync(join(candidate, 'electron.exe'))) { process.env.ELECTRON_OVERRIDE_DIST_PATH = candidate; return; }
    }
  }
  throw new Error('Electron dist is unavailable; set ELECTRON_OVERRIDE_DIST_PATH (no download is attempted).');
}
async function launch(envExtra = {}) {
  ensureElectronBinary();
  const server = createServer(); await new Promise(done => server.listen(0, '127.0.0.1', done));
  const port = server.address().port; await new Promise(done => server.close(done));
  const options = qaLaunchOptions(run), env = { ...options.env, ...envExtra };
  for (const name of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'CS2_ANALYST_TEST_DEM_PATH', 'CS2_ANALYST_DEM_PATH',
    'CS2_ANALYST_IMPORT_PATH', 'CS2_ANALYST_EXPORT_PATH']) if (!(name in envExtra)) delete env[name];
  const startedAt = Date.now();
  const child = spawn(require('electron'), ['.', ...options.applicationArgs, '--remote-debugging-port=' + port, '--disable-backgrounding-occluded-windows'],
    { cwd: join(root, 'apps/desktop'), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const tracked = scope.track(child, 'L3 product Electron', startedAt); await scope.live();
  const target = await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(tracked.stderr);
    try { return (await (await fetch('http://127.0.0.1:' + port + '/json/list', { signal: AbortSignal.timeout(1000) })).json()).find(item => item.type === 'page'); }
    catch { return null; }
  }, 30_000, 'L3 CDP');
  const page = await connectCdp(target.webSocketDebuggerUrl, 90_000); scope.sessions.add(page.socket);
  await waitFor(() => page.evaluate('Boolean(window.cs2Analyst?.library && (document.querySelector("[data-library-page]") || document.querySelector("[data-import-card]")))'), 30_000, 'product preload');
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
  const requestScope = (rounds, playerIds, side, floor, freeze) => ({ rounds, playerIds, side, floor, includeFreezeTime: freeze, samplingSet: 'all-valid' });
  const requests = [
    { layer: 'positions', resolution: 32, scope: requestScope(null, null, 'all', null, false) },
    { layer: 'positions', resolution: 16, scope: requestScope([metadata.rounds[0]], [metadata.playerIds[0]], 'CT', null, true) },
  ];
  if (metadata.floors.length) requests.push({ layer: 'positions', resolution: 64, scope: requestScope(null, null, 'all', metadata.floors[0], false) });
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
  const indexes = [0, metadata.rounds.length - 1], hashes = [];
  for (const index of indexes) {
    const round = metadata.rounds[index], block = round.blocks[0].index;
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
    assert.ok(await page.evaluate('document.getElementById("' + panel + '").innerText.length') > 0, tab + ' must render');
  }
  await page.evaluate('document.getElementById("replay-tab").click()');
  await waitFor(() => page.evaluate('Boolean(document.querySelector("[data-replay-session]"))'), 30_000, 'replay session');
  assert.equal(await page.evaluate('document.querySelector("[data-replay-session]").dataset.replaySession'), expected.replay.sessionId);
  await page.evaluate('document.querySelector(\'[aria-label="直达最后"]\')?.click()');
  await waitFor(() => page.evaluate('document.querySelectorAll("[data-replay-event]").length > 0'), 30_000, 'replay events');
}
async function openLibraryEntry(page) {
  await waitFor(() => page.evaluate('document.querySelectorAll("[data-library-entry]").length === 1'), 30_000, 'library entry');
  await page.evaluate('document.querySelector("[data-library-entry] button").click()');
  await waitFor(() => page.evaluate('document.querySelector("main")?.dataset.status === "success"'), 60_000, 'offline open', {
    diagnostics: () => page.evaluate('({status:document.querySelector("main")?.dataset.status,text:document.body.innerText.slice(-1200)})') });
}
try {
  checkpoint('fixture-hash');
  const hash = createHash('sha256'); for await (const bytes of createReadStream(fixture)) hash.update(bytes);
  result.fixture.sha256 = hash.digest('hex');
  copyFileSync(fixture, source);
  result.checks.push('source DEM copied only to the owned temporary run; original local fixture untouched');
  result.productRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

  checkpoint('import-export-delete');
  app = await launch({ CS2_ANALYST_DEM_PATH: source, CS2_ANALYST_EXPORT_PATH: exportPath });
  const importStart = performance.now();
  await app.page.evaluate('document.querySelector("[data-sidebar-import]").click()');
  await waitFor(() => app.page.evaluate('document.querySelector("main")?.dataset.status === "success"'), 120_000, 'initial import', {
    diagnostics: () => app.page.evaluate('({status:document.querySelector("main")?.dataset.status,text:document.body.innerText.slice(-1200)})') });
  result.timings.importMs = performance.now() - importStart;
  const first = await report(app.page);
  assert.equal(first.match.id, result.fixture.sha256);
  result.matchId = first.match.id;
  result.first = { reportHash: digest(JSON.stringify(withoutSession(first))), replaySessionId: first.replay?.sessionId ?? null };
  result.first.heatmapHashes = await heatmapHashes(app.page, first.heatmap);
  result.first.replayHashes = await replayHashes(app.page, first.replay);
  const catalogue = await app.page.evaluate('window.cs2Analyst.library.list()');
  assert.equal(catalogue.kind, 'success'); assert.equal(catalogue.total, 1);
  result.storageAfterImport = await app.page.evaluate('window.cs2Analyst.library.storage()');
  assert.equal(result.storageAfterImport.kind, 'success'); assert.ok(result.storageAfterImport.archiveBytes > 0);

  const exportStart = performance.now();
  const exported = await app.page.evaluate('window.cs2Analyst.library.exportMatch(' + JSON.stringify(first.match.id) + ')');
  result.timings.exportMs = performance.now() - exportStart;
  result.export = exported;
  assert.equal(exported.kind, 'success', JSON.stringify(exported));
  assert.deepEqual(Object.keys(exported).sort(), ['bytes', 'fileName', 'kind']);
  assert.equal(JSON.stringify(exported).includes(run.directory), false, 'no absolute path may cross to Renderer');
  assert.equal(exported.fileName, 'match.cs2a');
  assert.equal(exported.bytes, statSync(exportPath).size);
  const packageInfo = await verifyPortableArchive(exportPath);
  result.exported = { ...exported, sha256: digest(await readFileSync(exportPath)), files: packageInfo.header.files.length,
    headerMatchId: packageInfo.header.matchId, archiveSchemaVersion: packageInfo.header.archiveSchemaVersion };
  assert.equal(packageInfo.header.matchId, first.match.id);
  const inventory = packageInfo.header.files.map(file => file.path);
  assert.deepEqual(inventory.slice(0, 5), ['manifest.json', 'report.json.gz', 'heatmap/match.json.gz',
    'heatmap/replay.json.gz', 'heatmap/spatial.json.gz']);
  assert.ok(inventory.slice(5).every(path => /^replay\/r[1-9]\d*-b(?:0|[1-9]\d*)\.json\.gz$/.test(path)));
  result.checks.push('export produced a verified .cs2a with manifest/report/3 heatmap sources and all replay chunks');

  const deleteStart = performance.now();
  const removed = await app.page.evaluate('window.cs2Analyst.library.remove(' + JSON.stringify([first.match.id]) + ')');
  result.timings.deleteMs = performance.now() - deleteStart;
  result.remove = removed;
  assert.equal(removed.kind, 'success', JSON.stringify(removed));
  assert.deepEqual(Array.from(removed.removed), [first.match.id]); assert.equal(removed.failed.length, 0);
  const staleReplay = await app.page.evaluate('window.cs2Analyst.replay.getChunk(' + JSON.stringify({ sessionId: first.replay.sessionId,
    round: first.replay.rounds[0].round, block: first.replay.rounds[0].blocks[0].index }) + ')');
  assert.equal(staleReplay.kind, 'error', 'the active worker must be released before deletion');
  const staleHeatmap = await app.page.evaluate('window.cs2Analyst.heatmap.getGrid(' + JSON.stringify({ schemaVersion: 1,
    sessionId: first.heatmap.sessionId, layer: 'positions', resolution: 32,
    scope: { rounds: null, playerIds: null, side: 'all', floor: null, includeFreezeTime: false, samplingSet: 'all-valid' } }) + ')');
  assert.equal(staleHeatmap.kind, 'error');
  const afterDeleteCatalogue = await app.page.evaluate('window.cs2Analyst.library.list()');
  assert.equal(afterDeleteCatalogue.total, 0);
  result.storageAfterDelete = await app.page.evaluate('window.cs2Analyst.library.storage()');
  assert.equal(result.storageAfterDelete.kind, 'success');
  assert.equal(result.storageAfterDelete.matchCount, 0);
  assert.equal(result.storageAfterDelete.archiveBytes, 0);
  assert.equal(readdirSync(join(libraryRoot, 'matches')).length, 0, 'no archive directory may survive deletion');
  assert.equal(readdirSync(join(libraryRoot, 'staging')).length, 0, 'no staging directory may survive deletion');
  result.checks.push('active-match delete stopped the worker first, removed the row and archive, and storage now reports zero archive bytes');
  await close(app); app = null;
  rmSync(source);
  result.sourceAbsent = !existsSync(source);
  assert.equal(result.sourceAbsent, true);

  checkpoint('offline-import');
  app = await launch({ CS2_ANALYST_IMPORT_PATH: exportPath });
  const importArchiveStart = performance.now();
  const imported = await app.page.evaluate('window.cs2Analyst.library.importArchive()');
  result.timings.importArchiveMs = performance.now() - importArchiveStart;
  result.importArchive = imported;
  assert.equal(imported.kind, 'success', JSON.stringify(imported));
  assert.equal(imported.duplicate, false); assert.equal(imported.entry.matchId, first.match.id);
  assert.equal(JSON.stringify(imported).includes(run.directory), false);
  const importedCatalogue = await app.page.evaluate('window.cs2Analyst.library.list()');
  assert.equal(importedCatalogue.total, 1);
  assert.equal(readdirSync(join(libraryRoot, 'staging')).length, 0);
  result.checks.push('offline import streamed the package into staging, verified it and committed one ready match');
  await close(app); app = null;

  checkpoint('cold-open');
  app = await launch({});
  await waitFor(() => app.page.evaluate('document.querySelectorAll("[data-library-entry]").length === 1'), 30_000, 'library entry');
  const openStart = performance.now();
  await openLibraryEntry(app.page);
  result.timings.openMs = performance.now() - openStart;
  const restored = await report(app.page);
  assert.equal(restored.match.id, first.match.id);
  assert.notEqual(restored.replay?.sessionId, first.replay.sessionId, 'cold open must issue a fresh Replay session');
  result.restored = { reportHash: digest(JSON.stringify(withoutSession(restored))), replaySessionId: restored.replay?.sessionId ?? null };
  result.restored.heatmapHashes = await heatmapHashes(app.page, restored.heatmap);
  result.restored.replayHashes = await replayHashes(app.page, restored.replay);
  assert.equal(result.restored.reportHash, result.first.reportHash, 'report fingerprint must match after export/import');
  assert.deepEqual(result.restored.heatmapHashes, result.first.heatmapHashes, 'every heatmap filter must match');
  assert.deepEqual(result.restored.replayHashes, result.first.replayHashes, 'archived replay chunks must match');
  await sixViews(app.page, restored);
  result.sixViewsRendered = true;
  result.checks.push('cold offline open from the imported package matched report, all heatmap filters and replay chunk hashes and rendered six views');
  await close(app); app = null;

  checkpoint('corrupt-import');
  const exportedBytes = readFileSync(exportPath);
  const corrupted = [
    { kind: 'flipped-payload', bytes: (() => { const copy = Buffer.from(exportedBytes); copy[copy.length - 1] ^= 1; return copy; })() },
    { kind: 'truncated-package', bytes: exportedBytes.subarray(0, exportedBytes.length - 1) },
  ];
  result.corruptions = [];
  for (const item of corrupted) {
    const path = join(run.directory, item.kind + '.cs2a');
    writeFileSync(path, item.bytes);
    app = await launch({ CS2_ANALYST_IMPORT_PATH: path });
    const started = performance.now();
    const rejected = await app.page.evaluate('window.cs2Analyst.library.importArchive()');
    const evidence = { kind: item.kind, result: rejected, ms: performance.now() - started };
    assert.equal(rejected.kind, 'error', JSON.stringify(rejected));
    assert.equal(JSON.stringify(rejected).includes(run.directory), false);
    const catalogueAfterReject = await app.page.evaluate('window.cs2Analyst.library.list()');
    assert.equal(catalogueAfterReject.total, 1, 'a rejected package must not add or replace a match');
    await openLibraryEntry(app.page);
    const stillOpenable = await report(app.page);
    evidence.existingStillOpenable = stillOpenable.match.id === first.match.id;
    evidence.existingReportHash = digest(JSON.stringify(withoutSession(stillOpenable)));
    evidence.hashMatch = evidence.existingReportHash === result.first.reportHash;
    assert.equal(evidence.existingStillOpenable, true);
    assert.equal(evidence.hashMatch, true);
    evidence.stagingEmpty = readdirSync(join(libraryRoot, 'staging')).length === 0;
    assert.equal(evidence.stagingEmpty, true);
    result.corruptions.push(evidence);
    await close(app); app = null;
  }
  result.checks.push('flipped and truncated packages were rejected with no staging leftovers and the existing match still opened with identical hashes');
  result.status = 'PASS'; checkpoint('complete');
} catch (error) {
  result.status = 'FAIL'; result.error = { message: error.message, stack: error.stack, appLogs: app?.tracked.stderr }; process.exitCode = 1;
} finally {
  if (app) try { await close(app); } catch (error) { result.cleanupError = error.message; }
  try { await scope.cleanup(); } catch (error) { result.cleanupError = error.message; result.status = 'FAIL'; process.exitCode = 1; }
  result.finishedAt = new Date().toISOString();
  writeFileSync(join(run.output, 'data-operations.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ status: result.status, evidence: join(run.output, 'data-operations.json'), error: result.error?.message }));
}
