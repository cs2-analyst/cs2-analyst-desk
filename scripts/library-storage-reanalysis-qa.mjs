// Run AFTER all GUI performance trials; reanalysis intentionally replaces their owned snapshots.
// node scripts/library-storage-reanalysis-qa.mjs <storage-electron-qa gui-run.json>
// Four original whitelist DEMs, four real Utility parses, no DEM copy/rename/download or explicit GC.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { assertOwnedDirectory, assertOwnedPath, createOwnedTempDirectory, qaLaunchOptions } from './owned-qa-run.mjs';
import { ProcessScope } from './installed-smoke-lifecycle.mjs';
import { connectCdp, waitFor } from './smoke-runtime.mjs';

const here = fileURLToPath(import.meta.url), repository = resolve(dirname(here), '..');
const require = createRequire(join(repository, 'apps/desktop/package.json'));
const allowed = ['demo1.dem', 'demo2.dem', 'dust2.dem', 'nuke.dem'];
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const hash = value => createHash('sha256').update(value).digest('hex');
const fingerprint = value => {
  const raw = JSON.stringify(value, (key, item) => key === 'sessionId' ? undefined : item);
  return { bytes: Buffer.byteLength(raw), sha256: hash(raw) };
};
const same = (actual, expected, label) => assert.deepEqual(actual, { bytes: expected.bytes, sha256: expected.sha256 }, label);
function save(owner, path, value) {
  assertOwnedPath(owner, path); writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
}
function input(path) {
  const configPath = basename(path) === 'gui-run.json' ? resolve(path) : join(resolve(path), 'gui-run.json');
  const gui = json(configPath);
  assertOwnedDirectory(gui.owner); assert.equal(configPath, join(gui.owner.directory, 'gui-run.json'));
  assert.equal(gui.repository, repository);
  for (const run of Object.values(gui.runs)) assertOwnedDirectory(run);
  assertOwnedPath(gui.owner, gui.app.directory);
  const benchmark = json(gui.benchmark); assertOwnedDirectory(benchmark.owner);
  assert.equal(gui.benchmark, join(benchmark.owner.directory, 'run.json')); assert.equal(benchmark.repository, repository);
  assert.deepEqual([...benchmark.fixtures].sort(), [...allowed].sort(), 'All four requested fixtures must have been benchmarked');
  const completed = json(join(gui.owner.directory, 'results.json'));
  assert.equal(completed.results.length, gui.trials * 2 * allowed.length);
  assert.ok(completed.results.every(result => result.status === 'PASS'), 'Do not reanalyze until every GUI timing trial passes');
  return { gui, benchmark, configPath };
}
function config(path) {
  const value = json(path); assertOwnedDirectory(value.owner);
  assert.equal(resolve(path), join(value.owner.directory, 'run.json')); assert.equal(value.repository, repository);
  return { ...value, ...input(value.guiConfig) };
}
function selectedCase(state, name) {
  const item = state.cases.find(item => item.name === name); assert.ok(item && allowed.includes(name));
  const run = state.gui.runs[item.version], directory = assertOwnedPath(state.owner, join(state.owner.directory, basename(name, '.dem')));
  const libraryRoot = assertOwnedPath(run, join(run.localAppData, 'CS2 Analyst', 'MatchLibrary'));
  const expected = json(join(state.benchmark.owner.directory, basename(name, '.dem'), 'expected.json'));
  const capture = json(join(state.benchmark.owner.directory, basename(name, '.dem'), 'capture.json'));
  assert.equal(capture.source.fileName, name);
  return { ...item, run, directory, libraryRoot, expected, capture, matchId: capture.source.sha256 };
}
async function fileHash(path) {
  const digest = createHash('sha256'); for await (const bytes of createReadStream(path)) digest.update(bytes); return digest.digest('hex');
}
async function databaseRow(libraryRoot, matchId) {
  const { DatabaseSync } = await import('node:sqlite');
  const database = new DatabaseSync(join(libraryRoot, 'library.db'), { readOnly: true });
  try {
    assert.equal(database.prepare('PRAGMA user_version').get().user_version, 3);
    const row = database.prepare('SELECT match_id,archive_key,imported_at,self_player_id,manifest_hash,state,stored_bytes FROM matches WHERE match_id=?').get(matchId);
    assert.ok(row); assert.equal(row.state, 'ready');
    assert.ok(row.archive_key === matchId || new RegExp('^' + matchId + '\\.[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$').test(row.archive_key));
    return { ...row };
  } finally { database.close(); }
}

/** Internal modes execute only with the bundled Electron ABI, while the GUI is closed. */
async function internal(mode, configPath, name) {
  assert.ok(process.versions.electron && process.env.ELECTRON_RUN_AS_NODE === '1');
  assert.equal(typeof global.gc, 'undefined');
  const state = config(configPath), sample = selectedCase(state, name);
  const { LocalMatchLibrary } = await import('../apps/desktop/electron/local-library.ts');
  const archive = await import('../apps/desktop/electron/library-archive.ts');
  if (mode === '$prepare') {
    const library = await LocalMatchLibrary.open(sample.libraryRoot);
    let before;
    try {
      const entry = library.get(sample.matchId); assert.ok(entry && entry.state === 'ready');
      const directory = await library.archiveDirectory(sample.matchId), manifest = await archive.readArchiveManifest(directory);
      assert.equal(manifest.schemaVersion, sample.version);
      const report = await archive.readArchiveReport(directory, manifest, randomUUID());
      same(fingerprint(report), sample.expected.report, 'pre-reanalysis complete report');
      const selfPlayerId = sample.self === 'null' ? null : report.selectedPlayer;
      const updated = await library.setSelfPlayer(sample.matchId, selfPlayerId);
      assert.equal(updated.kind, 'success');
      before = { entry: library.get(sample.matchId), directory, manifestHash: archive.archiveManifestHash(manifest),
        schemaVersion: manifest.schemaVersion, selfPlayerId, report: fingerprint(report) };
    } finally { library.close(); }
    before.row = await databaseRow(sample.libraryRoot, sample.matchId);
    assert.equal(before.row.self_player_id, before.selfPlayerId);
    save(state.owner, join(sample.directory, 'before.json'), { ...before, runtime: process.versions });
  } else if (mode === '$verify') {
    const before = json(join(sample.directory, 'before.json')), after = await databaseRow(sample.libraryRoot, sample.matchId);
    assert.equal(after.match_id, before.row.match_id); assert.equal(after.imported_at, before.row.imported_at);
    assert.equal(after.self_player_id, before.row.self_player_id);
    assert.notEqual(after.archive_key, before.row.archive_key); assert.ok(after.archive_key.startsWith(sample.matchId + '.'));
    const directory = assertOwnedPath(sample.run, join(sample.libraryRoot, 'matches', after.archive_key));
    const oldGenerationInitiallyPresent = existsSync(before.directory);
    // Verify full report and all canonical fields in a fresh process, without any DEM parse.
    const loaded = await archive.loadLibraryArchive(directory);
    assert.equal(loaded.manifest.schemaVersion, 2); assert.equal(loaded.manifest.versions.archive, 2);
    assert.equal(loaded.manifest.createdAt, before.entry.importedAt);
    assert.equal(loaded.manifestHash, after.manifest_hash); assert.equal(loaded.storedBytes, after.stored_bytes);
    assert.ok(loaded.report && loaded.sources);
    same(fingerprint(loaded.report), sample.expected.report, 'reanalysis full saved report JSON');
    for (const role of ['match', 'replay', 'spatial']) same(fingerprint(loaded.sources[role]), sample.expected.sources[role], 'reanalysis entire canonical ' + role);
    same(fingerprint(loaded.report.replay), sample.expected.replayMetadata, 'reanalysis Replay metadata');
    same(fingerprint(loaded.report.heatmap), sample.expected.heatmapMetadata, 'reanalysis Heatmap metadata');
    const library = await LocalMatchLibrary.open(sample.libraryRoot);
    try {
      assert.equal(await library.archiveDirectory(sample.matchId), directory);
      assert.equal(library.get(sample.matchId).selfPlayerId ?? null, before.selfPlayerId);
    } finally { library.close(); }
    assert.equal(existsSync(before.directory), false, 'superseded generation must be cleaned after restart');
    assert.ok(existsSync(directory), 'startup cleanup must preserve the new referenced generation');
    assert.deepEqual(await databaseRow(sample.libraryRoot, sample.matchId), after);
    save(state.owner, join(sample.directory, 'verify.json'), { before: before.row, after, directory,
      oldGenerationCleanupInitiallyDeferred: oldGenerationInitiallyPresent, oldGenerationCleaned: true,
      fullReportCanonicalSourcesAndMetadataByteExact: true, runtime: process.versions });
  } else if (mode === '$final') {
    const verified = json(join(sample.directory, 'verify.json'));
    assert.deepEqual(await databaseRow(sample.libraryRoot, sample.matchId), verified.after, 'offline open must not rewrite or reanalyze');
    assert.ok(existsSync(verified.directory));
    save(state.owner, join(sample.directory, 'final.json'), { pointerUnchangedByOfflineOpen: true, runtime: process.versions });
  } else throw new Error('Unknown internal mode');
}
async function child(mode, configPath, name) {
  const scope = new ProcessScope(), startedAt = Date.now();
  const process = spawn(require('electron'), [here, mode, configPath, name], { cwd: repository, windowsHide: true,
    env: { ...globalThis.process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const tracked = scope.track(process, `reanalysis ${mode}/${name}`, startedAt);
  try {
    await scope.live();
    await waitFor(() => { if (tracked.error) throw tracked.error; return process.exitCode !== null; }, 120_000, mode,
      { diagnostics: () => ({ stdout: tracked.stdout, stderr: tracked.stderr }) });
    assert.equal(process.exitCode, 0, tracked.stderr);
  } finally { await scope.cleanup(); }
}
async function port() {
  const server = createServer(); await new Promise(done => server.listen(0, '127.0.0.1', done));
  const value = server.address().port; await new Promise(done => server.close(done)); return value;
}
const helpers = `(() => {
  window.__reanalysisQaHash=async value=>{const bytes=new TextEncoder().encode(JSON.stringify(value,(key,item)=>key==='sessionId'?undefined:item));
    const hash=await crypto.subtle.digest('SHA-256',bytes);return {bytes:bytes.byteLength,sha256:[...new Uint8Array(hash)].map(n=>n.toString(16).padStart(2,'0')).join('')};};
  window.__reanalysisQaReport=async reply=>{if(reply.kind!=='success')throw new Error(JSON.stringify(reply));
    const report=reply.report;return {report:await window.__reanalysisQaHash(report),replay:report.replay,heatmap:report.heatmap,selfPlayerId:reply.selfPlayerId??null};};
  window.__reanalysisQaChunk=async request=>{const reply=await window.cs2Analyst.replay.getChunk(request);if(reply.kind!=='success')throw new Error(JSON.stringify(reply));return window.__reanalysisQaHash(reply.chunk);};
})()`;
async function guiCase(state, sample, offline) {
  const output = assertOwnedPath(state.owner, join(sample.directory, offline ? 'offline' : 'reanalyze')); mkdirSync(output);
  const options = qaLaunchOptions(sample.run), env = { ...options.env, CS2_STORAGE_QA_OBSERVATIONS: output };
  for (const key of Object.keys(env)) if (['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL'].includes(key)
    || /^CS2_ANALYST_(?:DEM|TEST_DEM|IMPORT|EXPORT)_PATH$/.test(key)) delete env[key];
  if (!offline) env.CS2_ANALYST_DEM_PATH = join(repository, '.demo', sample.name);
  const scope = new ProcessScope(), debugPort = await port(), startedAt = Date.now();
  const process = spawn(require('electron'), [state.gui.app.directory, ...options.applicationArgs,
    '--remote-debugging-port=' + debugPort, '--disable-backgrounding-occluded-windows'], { cwd: state.gui.app.directory,
    env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const tracked = scope.track(process, `real ${offline ? 'offline reopen' : 'reanalysis'}/${sample.name}`, startedAt);
  const observed = { name: sample.name, initialArchiveVersion: sample.version, offline, startedAt, phases: [],
    sourceDemInjected: !offline, noExplicitGc: true, console: [], rendererExceptions: [] };
  const phase = label => observed.phases.push({ label, at: Date.now() });
  let page;
  try {
    await scope.live();
    const target = await waitFor(async () => {
      if (tracked.error) throw tracked.error;
      if (process.exitCode !== null) throw new Error(`GUI exited ${process.exitCode}: ${tracked.stderr}`);
      try { return (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`, { signal: AbortSignal.timeout(1000) })).json()).find(item => item.type === 'page'); }
      catch { return null; }
    }, 30_000, 'reanalysis GUI CDP');
    // Native parsing can take well beyond ordinary replay IPC deadlines. This is a test-controller deadline only.
    page = await connectCdp(target.webSocketDebuggerUrl, 240_000); scope.sessions.add(page.socket);
    page.socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.method === 'Runtime.exceptionThrown') observed.rendererExceptions.push(message.params);
      if (message.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(message.params.type)) observed.console.push({ type: message.params.type,
        text: message.params.args.map(arg => arg.value ?? arg.description ?? '').join(' ') });
    });
    await page.send('Runtime.enable'); await page.send('Network.enable');
    await page.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await waitFor(() => page.evaluate('Boolean(window.cs2Analyst?.library)'), 30_000, 'reanalysis preload');
    await page.evaluate(helpers);
    const before = json(join(sample.directory, 'before.json'));
    const listed = await page.evaluate('window.cs2Analyst.library.list({limit:100})');
    assert.equal(listed.kind, 'success'); const entry = listed.entries.find(entry => entry.matchId === sample.matchId); assert.ok(entry);
    assert.equal(entry.importedAt, before.entry.importedAt); assert.equal(entry.selfPlayerId ?? null, before.selfPlayerId);
    phase(offline ? 'offline-open' : 'old-generation-open');
    let opened = await page.evaluate(`window.cs2Analyst.library.open(${JSON.stringify(sample.matchId)}).then(window.__reanalysisQaReport)`);
    same(opened.report, sample.expected.report, 'entire opened report');
    const oldSession = opened.replay.sessionId;
    if (!offline) {
      phase('real-dem-parse-save-and-activate');
      const reply = await page.evaluate(`(async()=>{const at=performance.now();const reply=await window.cs2Analyst.library.reanalyze(${JSON.stringify(sample.matchId)});return {ms:performance.now()-at,kind:reply.kind,message:reply.message,savedMatchId:reply.savedMatchId,
        result:reply.kind==='success'?await window.__reanalysisQaReport(reply):null};})()`);
      observed.reanalysisMs = reply.ms;
      // Preserve a durable-save/activation failure exactly; never describe it as a rollback.
      observed.reply = { kind: reply.kind, message: reply.message, savedMatchId: reply.savedMatchId };
      assert.equal(reply.kind, 'success', JSON.stringify(reply)); opened = reply.result;
      same(opened.report, sample.expected.report, 'entire reanalyzed report JSON');
      assert.equal(opened.selfPlayerId, before.selfPlayerId); assert.notEqual(opened.replay.sessionId, oldSession);
      const firstRound = opened.replay.rounds[0], first = firstRound.blocks[0];
      const stale = await page.evaluate(`window.cs2Analyst.replay.getChunk(${JSON.stringify({ sessionId: oldSession, round: firstRound.round, block: first.index })})`);
      assert.equal(stale.kind, 'error'); observed.previousSessionRejected = true;
    }
    assert.ok(opened.replay.available && opened.heatmap.available, 'Reanalysis may not lose replay or Heatmap capability');
    same(await page.evaluate(`window.__reanalysisQaHash(${JSON.stringify(opened.replay)})`), sample.expected.replayMetadata, 'all replay metadata');
    same(await page.evaluate(`window.__reanalysisQaHash(${JSON.stringify(opened.heatmap)})`), sample.expected.heatmapMetadata, 'all Heatmap metadata');
    const rounds = opened.replay.rounds;
    const targets = offline ? rounds.flatMap(round => round.blocks.map(block => ({ round: round.round, block: block.index })))
      : rounds.flatMap(round => [round.blocks[0], round.blocks.at(-1)].filter(Boolean).map(block => ({ round: round.round, block: block.index })));
    phase(offline ? 'all-offline-chunks' : 'activation-round-boundaries');
    const seen = new Set();
    for (const target of targets) {
      const key = `${target.round}:${target.block}`; if (seen.has(key)) continue; seen.add(key);
      const reply = await page.evaluate(`window.__reanalysisQaChunk(${JSON.stringify({ ...target, sessionId: opened.replay.sessionId })})`);
      same(reply, sample.expected.chunks[key], 'entire replay chunk ' + key);
    }
    observed.checkedChunks = seen.size; observed.totalChunks = Object.keys(sample.expected.chunks).length;
    if (offline) assert.equal(seen.size, observed.totalChunks);
    phase(offline ? 'all-offline-heatmap-filters' : 'activation-heatmap-filters');
    const heatmaps = offline ? sample.expected.heatmaps : sample.expected.heatmaps.filter((_, index) => index % 41 === 0);
    for (const expected of heatmaps) {
      const request = { ...expected.request, sessionId: opened.heatmap.sessionId };
      const reply = await page.evaluate(`(async()=>{const reply=await window.cs2Analyst.heatmap.getGrid(${JSON.stringify(request)});if(reply.kind!=='success')throw new Error(JSON.stringify(reply));return window.__reanalysisQaHash(reply);})()`);
      same(reply, expected, 'entire filtered Heatmap result');
    }
    observed.checkedHeatmaps = heatmaps.length; observed.entireReportMetadataChunksAndFiltersByteExact = true;
    phase('released'); await page.evaluate(`window.cs2Analyst.session.release(${JSON.stringify(opened.replay.sessionId)})`);
    const request = { ...targets[0], sessionId: opened.replay.sessionId };
    assert.equal((await page.evaluate(`window.cs2Analyst.replay.getChunk(${JSON.stringify(request)})`)).kind, 'error');
    assert.deepEqual(observed.rendererExceptions, []);
    observed.knownDevelopmentWarnings = observed.console.filter(item => /Insecure Content-Security-Policy/.test(item.text));
    assert.deepEqual(observed.console.filter(item => !observed.knownDevelopmentWarnings.includes(item)), []);
    try { await page.evaluate('void window.cs2Analyst.window.close()'); } catch { /* Must prove actual exit below. */ }
    await waitFor(() => process.exitCode !== null, 20_000, 'reanalysis GUI close', { diagnostics: () => ({ stderr: tracked.stderr }) });
    assert.equal(process.exitCode, 0, tracked.stderr); observed.status = 'PASS';
  } catch (error) {
    observed.status = 'FAIL'; observed.error = { message: error.message, stack: error.stack };
    if (page) { try { const shot = await page.send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(output, 'failure.png'), Buffer.from(shot.data, 'base64')); } catch {} }
    throw error;
  } finally {
    page?.socket.close(); let cleanupError;
    try { await scope.cleanup(); } catch (error) { cleanupError = error; observed.cleanupError = { message: error.message, stack: error.stack }; }
    const primaryFailed = observed.status === 'FAIL';
    if (cleanupError && !primaryFailed) { observed.status = 'FAIL'; observed.error = observed.cleanupError; }
    writeFileSync(join(output, 'electron.stdout.log'), tracked.stdout);
    writeFileSync(join(output, 'electron.stderr.log'), tracked.stderr);
    save(state.owner, join(output, 'result.json'), observed);
    if (cleanupError && !primaryFailed) throw cleanupError;
  }
  return observed;
}

async function main(path) {
  if (!path || path === '--help') {
    console.log('Usage: node scripts/library-storage-reanalysis-qa.mjs <completed GUI run directory or gui-run.json>\nRuns 4 real whitelist DEM reanalyses only after every GUI timing trial passes. Uses original .demo files in place; no copy, rename, download, GC or user-library access.'); return;
  }
  assert.equal(process.platform, 'win32'); assert.equal(typeof global.gc, 'undefined');
  const loaded = input(path), owner = createOwnedTempDirectory('storage-reanalysis-qa', { parent: realpathSync(tmpdir()) });
  const cases = allowed.map((name, index) => ({ name, version: index < 2 ? 1 : 2, self: index % 2 === 0 ? 'null' : 'selected-player' }));
  const state = { schemaVersion: 1, owner, repository, guiConfig: loaded.configPath, cases, createdAt: new Date().toISOString() };
  const configPath = join(owner.directory, 'run.json'); save(owner, configPath, state);
  console.log(JSON.stringify({ run: owner.directory, guiRun: loaded.configPath, cases }));
  const results = [];
  try {
    for (const item of cases) {
      const sample = selectedCase({ ...state, ...loaded }, item.name); mkdirSync(sample.directory);
      const dem = join(repository, '.demo', sample.name);
      assert.equal(basename(dem), sample.name); assert.ok(allowed.includes(basename(dem)));
      assert.equal(statSync(dem).size, sample.capture.source.bytes);
      const beforeHash = await fileHash(dem); assert.equal(beforeHash, sample.matchId);
      console.log(JSON.stringify({ phase: 'real-reanalysis', name: sample.name, from: sample.version, to: 2 }));
      await child('$prepare', configPath, sample.name);
      const reanalyzed = await guiCase({ ...state, ...loaded }, sample, false);
      await child('$verify', configPath, sample.name);
      const offline = await guiCase({ ...state, ...loaded }, sample, true);
      await child('$final', configPath, sample.name);
      assert.equal(await fileHash(dem), beforeHash, 'Original DEM bytes must remain unchanged');
      results.push({ name: sample.name, sourceSha256: beforeHash, fromArchiveVersion: sample.version, toArchiveVersion: 2,
        self: item.self, reanalysisMs: reanalyzed.reanalysisMs, canonical: json(join(sample.directory, 'verify.json')),
        offlineChunks: offline.checkedChunks, offlineHeatmapCases: offline.checkedHeatmaps,
        importedAtAndSelfPreserved: true, generationChanged: true, sourceDemUnmodified: true, status: 'PASS' });
    }
    save(owner, join(owner.directory, 'results.json'), { schemaVersion: 1, createdAt: state.createdAt, guiRun: state.guiConfig,
      serial: true, nativeDemParses: 4, explicitGc: false, demCopiedRenamedOrDownloaded: false, results,
      limits: ['Development built app with the existing Main DEM-dialog seam; no packaged native-dialog automation.',
        'Original DEMs remain in place. Offline opens have no DEM path injection and use library.open; no claim of OS-level access denial.',
        'Cancellation, wrong DEM, I/O/transaction faults and process interruption use the focused Main/library regression suites; this four-parse script exercises successful native reanalysis and offline restoration.'] });
    console.log(JSON.stringify({ success: true, results: join(owner.directory, 'results.json') }));
  } catch (error) {
    save(owner, join(owner.directory, 'failure.json'), { message: error.message, stack: error.stack, completed: results }); throw error;
  }
}
const [mode, ...args] = process.argv.slice(2);
if (mode?.startsWith('$')) await internal(mode, ...args);
else await main(mode);
