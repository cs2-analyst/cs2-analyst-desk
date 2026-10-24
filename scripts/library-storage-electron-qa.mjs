// Serial GUI/IPC companion to library-storage-optimization-benchmark.mjs.
// node scripts/library-storage-electron-qa.mjs <benchmark directory or run.json> [--trials=3] [--requests=40]
// The caller builds first. This tool never builds, parses/copies a DEM, forces GC, or clears OS caches.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync,
  readdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { assertOwnedDirectory, assertOwnedPath, createOwnedQaRun, createOwnedTempDirectory, qaLaunchOptions } from './owned-qa-run.mjs';
import { ProcessScope } from './installed-smoke-lifecycle.mjs';
import { connectCdp, waitFor } from './smoke-runtime.mjs';
import { quantiles } from './library-spike-core.mjs';

const here = fileURLToPath(import.meta.url), repository = resolve(dirname(here), '..');
const desktop = join(repository, 'apps', 'desktop');
const allowed = ['demo1.dem', 'demo2.dem', 'dust2.dem', 'nuke.dem'];
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const require = createRequire(join(desktop, 'package.json'));

function save(owner, path, value) {
  assertOwnedPath(owner, path);
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
}
function readBenchmark(path) {
  const target = basename(path) === 'run.json' ? resolve(path) : join(resolve(path), 'run.json');
  const config = json(target);
  assertOwnedDirectory(config.owner);
  assert.equal(target, join(config.owner.directory, 'run.json'));
  assert.equal(config.repository, repository);
  assert.equal(config.synthetic, false, 'GUI comparison requires the real whitelist benchmark');
  assert.ok(config.fixtures.length >= 2 && config.fixtures.every(name => allowed.includes(name)));
  assert.equal(new Set(config.fixtures).size, config.fixtures.length);
  for (const name of config.fixtures) for (const version of [1, 2]) {
    const directory = assertOwnedPath(config.owner, join(config.owner.directory, basename(name, '.dem'), `v${version}`));
    const manifest = json(join(directory, 'manifest.json'));
    assert.equal(manifest.schemaVersion, version); assert.equal(manifest.summary.fileName, name);
    assert.ok(existsSync(join(dirname(directory), 'expected.json')));
  }
  return { ...config, configPath: target };
}
function readGuiConfig(path) {
  const config = json(path);
  assertOwnedDirectory(config.owner); assert.equal(resolve(path), join(config.owner.directory, 'gui-run.json'));
  assert.equal(config.repository, repository);
  for (const run of Object.values(config.runs)) assertOwnedDirectory(run);
  return config;
}

/** This internal mode uses the actual bundled Electron SQLite runtime and immutable commit path. */
async function seed(configPath, versionText) {
  assert.ok(process.versions.electron && process.env.ELECTRON_RUN_AS_NODE === '1');
  assert.equal(typeof global.gc, 'undefined');
  const config = readGuiConfig(configPath), benchmark = readBenchmark(config.benchmark), version = Number(versionText);
  assert.ok([1, 2].includes(version));
  const run = config.runs[version];
  const { LocalMatchLibrary, localMatchLibraryRoot } = await import('../apps/desktop/electron/local-library.ts');
  const { verifyLibraryArchive } = await import('../apps/desktop/electron/library-archive.ts');
  const root = localMatchLibraryRoot(run.localAppData);
  assert.equal(root, join(run.localAppData, 'CS2 Analyst', 'MatchLibrary'));
  assertOwnedPath(run, root);
  const library = await LocalMatchLibrary.open(root), entries = [];
  try {
    for (const name of benchmark.fixtures) {
      const source = assertOwnedPath(benchmark.owner, join(benchmark.owner.directory, basename(name, '.dem'), `v${version}`));
      const verified = await verifyLibraryArchive(source, { mode: 'compressed' });
      assert.equal(verified.manifest.summary.fileName, name);
      const staging = await library.createStaging(); assertOwnedPath(run, staging.directory);
      // Inventory has been validated by production code. Copy only its exact members, never a DEM.
      for (const member of ['manifest.json', ...verified.manifest.files.map(file => file.path)]) {
        assert.ok(!member.toLowerCase().endsWith('.dem'));
        const target = assertOwnedPath(run, join(staging.directory, ...member.split('/')));
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(join(source, ...member.split('/')), target);
      }
      const committed = await library.commitStaging(staging.id, undefined,
        { manifestHash: verified.manifestHash, storedBytes: verified.storedBytes }, undefined,
        verified.manifest.summary.players[0]?.id ?? null);
      assert.equal(committed.duplicate, false); assert.equal(committed.entry.state, 'ready');
      entries.push({ name, matchId: committed.entry.matchId, storedBytes: committed.entry.storedBytes });
    }
  } finally { library.close(); }
  save(config.owner, join(config.owner.directory, `seed-v${version}.json`), { runtime: process.versions, root, entries });
}

function observer(role) {
  return `
// QA-only observer appended to an owned copy; production code above is byte-for-byte unchanged.
import { appendFileSync as __storageQaAppend } from 'node:fs';
${role === 'Main' ? "import { app as __storageQaApp } from 'electron';" : ''}
const __storageQaDirectory = process.env.CS2_STORAGE_QA_OBSERVATIONS;
const __storageQaTake = reason => {
  if (!__storageQaDirectory) return;
  try {
    const row = { at: Date.now(), role: ${JSON.stringify(role)}, pid: process.pid, reason,
      memory: process.memoryUsage(), lifetimeMaxRssBytes: process.resourceUsage().maxRSS * 1024 };
    ${role === 'Main' ? 'if (__storageQaApp.isReady()) row.processes = __storageQaApp.getAppMetrics();' : ''}
    __storageQaAppend(__storageQaDirectory + '/observer-${role}-' + process.pid + '.jsonl', JSON.stringify(row) + '\\n');
  } catch { /* Observers must not change product behavior. Missing evidence fails in the controller. */ }
};
__storageQaTake('observer-start');
const __storageQaTimer = setInterval(() => __storageQaTake('interval'), 100); __storageQaTimer.unref();
process.on('exit', () => __storageQaTake('exit'));
${role === 'Utility' ? "process.parentPort?.on('message', () => __storageQaTake('parent-message'));" : ''}
`;
}
function prepareApp(owner) {
  const target = assertOwnedPath(owner, join(owner.directory, 'observed-app')); mkdirSync(target);
  const sourceDist = join(desktop, 'dist');
  assert.ok(existsSync(join(sourceDist, 'electron', 'main.js')), 'Build the app before running this tool');
  const original = {};
  const visit = (path, relative = '') => {
    for (const item of readdirSync(path, { withFileTypes: true })) {
      assert.equal(item.isSymbolicLink(), false, 'built dist must not contain redirected members');
      const child = join(path, item.name), name = relative ? relative + '/' + item.name : item.name;
      if (item.isDirectory()) visit(child, name);
      else { assert.ok(item.isFile()); original[name] = { bytes: statSync(child).size, sha256: digest(readFileSync(child)) }; }
    }
  };
  visit(sourceDist);
  cpSync(sourceDist, join(target, 'dist'), { recursive: true, force: false, errorOnExist: true });
  writeFileSync(join(target, 'package.json'), JSON.stringify(json(join(desktop, 'package.json'))), { flag: 'wx' });
  // Module dependencies keep their installed ABI; the junction is never recursively removed by this tool.
  symlinkSync(realpathSync(join(desktop, 'node_modules')), join(target, 'node_modules'), 'junction');
  const instrumentation = [];
  for (const [file, role] of [['electron/main.js', 'Main'], ['electron/report-worker.js', 'Utility']]) {
    const path = join(target, 'dist', ...file.split('/')), originalBytes = readFileSync(path), extra = observer(role);
    assert.equal(digest(originalBytes), original[file].sha256);
    appendFileSync(path, extra);
    assert.ok(readFileSync(path).subarray(0, originalBytes.length).equals(originalBytes));
    instrumentation.push({ path: file, appendedBytes: Buffer.byteLength(extra), sha256: digest(readFileSync(path)) });
  }
  return { directory: target, sourceDist, original, instrumentation,
    note: 'All built files copied exactly. Only main.js and report-worker.js receive an appended 100ms memory observer. No production source, preload, Renderer, archive decoder, or budget is replaced.' };
}
async function freePort() {
  const server = createServer(); await new Promise(done => server.listen(0, '127.0.0.1', done));
  const port = server.address().port; await new Promise(done => server.close(done)); return port;
}
async function runSeed(electron, configPath, version) {
  const scope = new ProcessScope(), startedAt = Date.now();
  const child = spawn(electron, [here, '$seed', configPath, String(version)], { cwd: repository, windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const tracked = scope.track(child, `storage GUI seed v${version}`, startedAt);
  try {
    await scope.live();
    await waitFor(() => { if (tracked.error) throw tracked.error; return child.exitCode !== null; }, 90_000, 'SQLite archive seeding',
      { diagnostics: () => ({ stderr: tracked.stderr }) });
    assert.equal(child.exitCode, 0, tracked.stderr);
  } finally { await scope.cleanup(); }
}

// Hashes are calculated after each measured IPC interval; no full chunks are retained in the Renderer.
const browserHelpers = `(() => {
  window.__storageQaHash = async value => {
    const bytes=new TextEncoder().encode(JSON.stringify(value,(key,item)=>key==='sessionId'?undefined:item));
    const hash=await crypto.subtle.digest('SHA-256',bytes);
    return {bytes:bytes.byteLength,sha256:[...new Uint8Array(hash)].map(n=>n.toString(16).padStart(2,'0')).join('')};
  };
  window.__storageQaOpen = async id => {
    const at=performance.now(),reply=await window.cs2Analyst.library.open(id),ms=performance.now()-at;
    if(reply.kind!=='success')throw new Error(JSON.stringify(reply));
    window.__storageQaReport=reply.report;
    return {ms,metadata:reply.report.replay,heatmapAvailable:reply.report.heatmap?.available,
      report:await window.__storageQaHash(reply.report)};
  };
  window.__storageQaChunk = async request => {
    const at=performance.now(),reply=await window.cs2Analyst.replay.getChunk(request),ms=performance.now()-at;
    if(reply.kind!=='success')throw new Error(JSON.stringify(reply));
    return {ms,fingerprint:await window.__storageQaHash(reply.chunk),frames:reply.chunk.frames.length,
      utilities:reply.chunk.utilities?.length??0};
  };
})()`;
function targets(metadata, minimum) {
  const all = metadata.rounds.flatMap(round => round.blocks.map(block => ({ round: round.round, block: block.index })));
  assert.ok(all.length);
  const required = metadata.rounds.flatMap(round => [round.blocks[0], round.blocks.at(-1)]
    .filter(Boolean).map(block => ({ round: round.round, block: block.index })));
  required.push(all[0], all[Math.floor(all.length / 2)], all.at(-1));
  let seed = 0x552a;
  const shuffled = [...all];
  for (let index = shuffled.length - 1; index > 0; index--) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const other = seed % (index + 1); [shuffled[index], shuffled[other]] = [shuffled[other], shuffled[index]];
  }
  const selected = new Map(required.map(value => [`${value.round}:${value.block}`, value]));
  for (const value of shuffled) { if (selected.size >= Math.min(all.length, Math.max(minimum, required.length))) break;
    selected.set(`${value.round}:${value.block}`, value); }
  assert.ok(selected.size >= Math.min(minimum, all.length));
  return [...selected.values()];
}
function same(actual, expected, label) {
  assert.deepEqual(actual, { bytes: expected.bytes, sha256: expected.sha256 }, label);
}
export function readObservations(directory) {
  const rows = [];
  for (const file of readdirSync(directory).filter(name => /^observer-(Main|Utility)-\d+\.jsonl$/.test(name))) {
    const raw = readFileSync(join(directory, file), 'utf8');
    const lines = raw.split('\n');
    if (lines.at(-1) === '') lines.pop();
    for (const line of lines) rows.push(JSON.parse(line));
  }
  return rows.sort((a, b) => a.at - b.at);
}
export function summarizeMemory(rows, renderer, phases) {
  const nodeFields = ['rss', 'heapTotal', 'heapUsed', 'external', 'arrayBuffers'];
  const rendererFields = ['usedSize', 'totalSize', 'embedderHeapUsedSize', 'backingStorageSize'];
  const maximum = values => values.length ? Math.max(...values) : null;
  const peakFields = (values, fields, select = value => value) => values.length ? Object.fromEntries(fields.map(key => [key,
    maximum(values.map(value => select(value)[key]).filter(Number.isFinite))])) : null;
  const node = {};
  for (const role of ['Main', 'Utility']) {
    const subset = rows.filter(row => row.role === role); assert.ok(subset.length, `Missing ${role} observer`);
    node[role] = { processes: [...new Set(subset.map(row => row.pid))], samples: subset.length,
      peakSingleProcess: peakFields(subset, nodeFields, row => row.memory),
      lifetimeMaxRssBytes: Math.max(...subset.map(row => row.lifetimeMaxRssBytes)) };
  }
  const metricRows = rows.filter(row => row.processes);
  const workingSets = metricRows.map(row => ({ at: row.at, roles: {
    Main: row.processes.filter(p => p.type === 'Browser'), Renderer: row.processes.filter(p => p.type === 'Tab'),
    Utility: row.processes.filter(p => p.type === 'Utility' && /^CS2 /.test(p.serviceName ?? p.name ?? '')),
  } }));
  // Electron memory-info is KiB. Keep observer logs as returned and convert only this summary.
  const concurrentWorkingSet = (values, role) => values.map(row => row.roles[role].reduce((n, p) => n + p.memory.workingSetSize * 1024, 0));
  const byRole = Object.fromEntries(['Main', 'Renderer', 'Utility'].map(role => [role, {
    peakConcurrentWorkingSetBytes: maximum(concurrentWorkingSet(workingSets, role)),
    peakProcessWorkingSetBytes: maximum(workingSets.flatMap(row => row.roles[role].map(p => p.memory.peakWorkingSetSize * 1024))),
  }]));
  const windows = phases.map((phase, index) => {
    const end = phases[index + 1]?.at ?? Infinity;
    const values = workingSets.filter(row => row.at >= phase.at && row.at < end);
    const heaps = renderer.filter(row => row.at >= phase.at && row.at < end);
    const nodes = rows.filter(row => row.at >= phase.at && row.at < end);
    return { phase: phase.label, matchId: phase.matchId ?? null, at: phase.at, endAt: Number.isFinite(end) ? end : null,
      samples: values.length, rendererSamples: heaps.length,
      peakWorkingSetBytes: values.length ? Object.fromEntries(['Main', 'Renderer', 'Utility'].map(role => [role,
        maximum(concurrentWorkingSet(values, role))])) : null,
      peakNodeMemory: Object.fromEntries(['Main', 'Utility'].map(role => [role,
        peakFields(nodes.filter(row => row.role === role), nodeFields, row => row.memory)])),
      peakRendererHeap: peakFields(heaps, rendererFields),
      lastWorkingSetBytes: values.length ? Object.fromEntries(['Main', 'Renderer', 'Utility'].map(role => [role,
        values.at(-1).roles[role].reduce((n, p) => n + p.memory.workingSetSize * 1024, 0)])) : null,
      lastNodeMemory: Object.fromEntries(['Main', 'Utility'].map(role => [role,
        nodes.filter(row => row.role === role).at(-1)?.memory ?? null])),
      lastRendererHeap: heaps.at(-1) ?? null };
  });
  return { unit: 'bytes', observerIntervalMs: 100, node, workingSet: byRole, phases: windows,
    rendererHeapPeak: peakFields(renderer, rendererFields),
    interpretation: 'Node RSS and JS heap are different measurements. Node peaks are per-process role high waters; working-set values sum simultaneous processes within each role, including overlapping old/new Utilities during a switch. external includes native-bound objects; arrayBuffers is a subset and must not be added to it. Chromium backingStorage/embedder values are CDP observations, not a complete native heap. Working sets come from app.getAppMetrics; Node lifetime maxRSS catches RSS spikes between timers. No GC is requested. Brief JS heap spikes during blocking work can fall between samples. A phase with no observations returns null; an observed working-set sample with no active analysis Utility is measured zero. Whole-flow peaks include the alternate match; use the named phases and matchId for per-match open/seek/release comparisons.' };
}

async function sixViews(page, directory, matchId) {
  await page.evaluate(`document.querySelector('[data-library-entry="${matchId}"]').click()`);
  await waitFor(() => page.evaluate('document.querySelector("main")?.dataset.status === "success"'), 60_000, 'real library-row open');
  const views = [];
  for (const view of ['report', 'deep-review', 'timeline', 'analysis', 'replay', 'heatmap']) {
    await page.evaluate(`document.getElementById('${view}-tab').click()`);
    await waitFor(() => page.evaluate(`document.getElementById('${view}-panel')?.hidden===false`), 20_000, view + ' visible');
    if (view === 'replay') await waitFor(() => page.evaluate('Number(document.querySelector("#replay-panel canvas[role=img]")?.dataset.playerCount)>0'), 30_000, 'actual replay players');
    if (view === 'heatmap') await waitFor(() => page.evaluate('Boolean(document.querySelector("#heatmap-panel canvas"))'), 30_000, 'actual heatmap canvas');
    const content = await page.evaluate(`document.getElementById('${view}-panel').innerText`);
    assert.ok(content.length > 0, view + ' is empty');
    const screenshot = await page.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(directory, view + '.png'), Buffer.from(screenshot.data, 'base64'), { flag: 'wx' });
    views.push({ view, contentBytes: Buffer.byteLength(content), sha256: digest(content) });
  }
  await page.evaluate('document.querySelector("[data-nav-action=home]").click()');
  return views;
}

async function launchTrial(config, benchmark, version, trial, name) {
  const run = config.runs[version], directory = assertOwnedPath(run, join(run.output, `${basename(name, '.dem')}-trial-${trial}`));
  mkdirSync(directory);
  const seeded = json(join(config.owner.directory, `seed-v${version}.json`)).entries;
  const primary = seeded.find(entry => entry.name === name), alternate = seeded.find(entry => entry.name !== name);
  assert.ok(primary && alternate);
  const expected = json(join(benchmark.owner.directory, basename(name, '.dem'), 'expected.json'));
  const phases = [], observations = [], consoleMessages = [], errors = [];
  const result = { name, version, trial, primary, alternate, phases, startupAt: Date.now(),
    sourceRevision: config.sourceRevision, sourceWorktreeDirty: config.sourceWorktreeDirty,
    builtEntryFingerprints: config.builtEntryFingerprints,
    coldDefinition: 'First archive open in a new GUI Electron process. OS filesystem cache is not cleared; profile is reused within this format.',
    baselineDefinition: 'v1 and v2 both use the current common production reader/worker. This isolates format differences; it is not the original 9318ed9 worker with its former repeated source decoding.',
    directIpcExcludesReactRendering: true, explicitGc: false, osFileCacheCleared: false };
  let phaseMatchId = primary.matchId;
  const phase = (label, matchId = phaseMatchId) => { phaseMatchId = matchId; phases.push({ label, matchId, at: Date.now() }); };
  const scope = new ProcessScope(), port = await freePort(), options = qaLaunchOptions(run), env = { ...options.env,
    CS2_STORAGE_QA_OBSERVATIONS: directory };
  for (const key of Object.keys(env)) if (['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL'].includes(key)
    || /^CS2_ANALYST_(?:DEM|TEST_DEM|IMPORT|EXPORT)_PATH$/.test(key)) delete env[key];
  // Existing development-only dialog seams. The copied app is an unpackaged built app.
  // Production packaged binaries ignore these variables; no new path IPC is introduced.
  env.CS2_ANALYST_EXPORT_PATH = join(directory, 'portable.cs2a');
  env.CS2_ANALYST_IMPORT_PATH = env.CS2_ANALYST_EXPORT_PATH;
  const startedAt = Date.now();
  const child = spawn(require('electron'), [config.app.directory, ...options.applicationArgs,
    '--remote-debugging-port=' + port, '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
    '--disable-features=CalculateNativeWinOcclusion'], { cwd: config.app.directory, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const tracked = scope.track(child, `storage GUI v${version}/${name}/${trial}`, startedAt);
  let page, timer, polling = null, closing = false;
  try {
    await scope.live();
    const target = await waitFor(async () => {
      if (tracked.error) throw tracked.error;
      if (child.exitCode !== null) throw new Error(`GUI exited ${child.exitCode}: ${tracked.stderr}`);
      try { return (await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) })).json()).find(item => item.type === 'page'); }
      catch { return null; }
    }, 30_000, 'GUI CDP');
    page = await connectCdp(target.webSocketDebuggerUrl, 90_000); scope.sessions.add(page.socket);
    page.socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.method === 'Runtime.exceptionThrown') errors.push(message.params);
      if (message.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(message.params.type))
        consoleMessages.push({ at: Date.now(), type: message.params.type, text: message.params.args.map(arg => arg.value ?? arg.description ?? '').join(' ') });
      if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') errors.push(message.params.entry);
    });
    await page.send('Runtime.enable'); await page.send('Log.enable'); await page.send('Network.enable');
    await page.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await waitFor(() => page.evaluate('Boolean(window.cs2Analyst?.library && document.querySelector("[data-sidebar-import]"))'), 30_000, 'production preload');
    assert.equal(await page.evaluate('typeof window.require'), 'undefined');
    await page.evaluate('document.getElementById("global-library-tab")?.click()');
    await waitFor(() => page.evaluate(`document.querySelectorAll('[data-library-entry]').length===${seeded.length}`), 30_000, 'meaningful seeded library rows');
    await page.evaluate(browserHelpers);
    const poll = () => {
      if (polling || closing) return;
      polling = page.send('Runtime.getHeapUsage').then(value => observations.push({ at: Date.now(), ...value }))
        .catch(error => { if (!closing) errors.push({ observer: 'renderer-heap', message: error.message }); })
        .finally(() => { polling = null; });
    };
    timer = setInterval(poll, 100); poll();
    phase('shared-library-storage-before');
    const storageBefore = await page.evaluate('window.cs2Analyst.library.storage()'); assert.equal(storageBefore.kind, 'success');
    result.storage = { before: storageBefore, sharedIndexBytesBefore: storageBefore.indexBytes, persistentReplayCacheBytes: 0,
      note: 'SQLite/WAL is a shared catalogue for all seeded matches, not a per-match archive cost. storage() enumerates library metadata before the first timed open. Exported portable files are outside the library and are not a persistent replay cache.' };
    phase('idle-before-open'); await delay(300);
    const open = async (id, label, expectedReport) => {
      phase(label, id);
      const opened = await page.evaluate(`window.__storageQaOpen(${JSON.stringify(id)})`);
      assert.ok(opened.metadata?.available && opened.heatmapAvailable, 'GUI restore must retain Replay and Heatmap');
      if (expectedReport) same(opened.report, expectedReport, label + ' full report');
      return opened;
    };
    const cold = await open(primary.matchId, 'new-process-first-open', expected.report);
    result.newProcessFirstOpenMs = cold.ms;
    result.sessionId = cold.metadata.sessionId;
    const requests = targets(cold.metadata, config.requests), misses = [], hits = [];
    phase('serial-random-seek');
    for (const target of requests) {
      const request = { ...target, sessionId: cold.metadata.sessionId }, key = `${target.round}:${target.block}`;
      const miss = await page.evaluate(`window.__storageQaChunk(${JSON.stringify(request)})`);
      same(miss.fingerprint, expected.chunks[key], key + ' uncached IPC chunk'); misses.push({ ...target, ...miss });
      const hit = await page.evaluate(`window.__storageQaChunk(${JSON.stringify(request)})`);
      same(hit.fingerprint, expected.chunks[key], key + ' repeated IPC chunk'); hits.push({ ...target, ...hit });
    }
    result.seek = { unique: quantiles(misses.map(item => item.ms)), repeated: quantiles(hits.map(item => item.ms)),
      requests: misses, repeats: hits, wholeChunkJsonByteExact: true,
      cacheMeaning: version === 2 ? 'Each unique block misses the bounded derived-chunk LRU; its immediate repeat hits it.'
        : 'v1 has no application chunk cache. Repeated requests are OS-cache-warm file reads and decompression.' };
    const repeated = await open(primary.matchId, 'same-process-reopen', expected.report);
    result.sameProcessReopenMs = repeated.ms;
    assert.notEqual(repeated.metadata.sessionId, cold.metadata.sessionId);
    const staleAfterReopen = await page.evaluate(`window.cs2Analyst.replay.getChunk(${JSON.stringify({ ...requests[0], sessionId: cold.metadata.sessionId })})`);
    assert.equal(staleAfterReopen.kind, 'error');
    const switched = await open(alternate.matchId, 'switch-match'); result.switchOpenMs = switched.ms;
    const staleAfterSwitch = await page.evaluate(`window.cs2Analyst.replay.getChunk(${JSON.stringify({ ...requests[0], sessionId: repeated.metadata.sessionId })})`);
    assert.equal(staleAfterSwitch.kind, 'error');
    phase('rapid-seek-and-release');
    const burst = targets(switched.metadata, 8).slice(0, 8).map(target => ({ ...target, sessionId: switched.metadata.sessionId }));
    result.release = await page.evaluate(`(async()=>{
      const pending=${JSON.stringify(burst)}.map(request=>window.cs2Analyst.replay.getChunk(request).then(reply=>({kind:reply.kind,at:performance.now()})));
      const at=performance.now();await window.cs2Analyst.session.release(${JSON.stringify(switched.metadata.sessionId)});
      const releasedAt=performance.now(),replies=await Promise.all(pending);
      const stale=await window.cs2Analyst.replay.getChunk(${JSON.stringify(burst[0])});
      window.__storageQaReport=null;
      return {ms:releasedAt-at,releasedAt,replies,staleKind:stale.kind};
    })()`);
    assert.equal(result.release.staleKind, 'error');
    assert.ok(result.release.replies.every(reply => reply.kind !== 'success' || reply.at <= result.release.releasedAt),
      'A successful burst reply arrived after release confirmation');
    result.release.allSuccessfulRepliesPrecededReleaseConfirmation = true;
    result.release.directRepliesWereNotInsertedIntoUiCache = true;
    phase('released-idle'); await delay(1500);
    if (trial === 0) {
      phase('portable-export-in-main', primary.matchId);
      result.portable = await page.evaluate(`(async()=>{const at=performance.now();const reply=await window.cs2Analyst.library.exportMatch(${JSON.stringify(primary.matchId)});return {exportMs:performance.now()-at,export:reply};})()`);
      assert.equal(result.portable.export.kind, 'success', JSON.stringify(result.portable.export));
      assert.ok(existsSync(env.CS2_ANALYST_EXPORT_PATH));
      phase('portable-delete-in-main');
      const removed = await page.evaluate(`window.cs2Analyst.library.remove([${JSON.stringify(primary.matchId)}])`);
      assert.equal(removed.kind, 'success'); assert.deepEqual(removed.removed, [primary.matchId]); assert.deepEqual(removed.failed, []);
      phase('portable-import-in-main');
      const imported = await page.evaluate(`(async()=>{const at=performance.now();const reply=await window.cs2Analyst.library.importArchive();return {ms:performance.now()-at,reply};})()`);
      assert.equal(imported.reply.kind, 'success', JSON.stringify(imported.reply)); assert.equal(imported.reply.duplicate, false);
      assert.equal(imported.reply.entry.matchId, primary.matchId); assert.equal(imported.reply.entry.versions.archive, version);
      result.portable.importMs = imported.ms; result.portable.deletedAndRestoredSameId = true;
      const importedOpen = await open(primary.matchId, 'portable-offline-reopen', expected.report);
      const portableChunk = await page.evaluate(`window.__storageQaChunk(${JSON.stringify({ ...requests.at(-1), sessionId: importedOpen.metadata.sessionId })})`);
      same(portableChunk.fingerprint, expected.chunks[`${requests.at(-1).round}:${requests.at(-1).block}`], 'portable Main round-trip final chunk');
      await page.evaluate(`window.cs2Analyst.session.release(${JSON.stringify(importedOpen.metadata.sessionId)})`);
      await page.evaluate('window.__storageQaReport=null');
      phase('portable-released-idle'); await delay(1000);
    }
    if (trial === 0 && name === benchmark.fixtures[0]) {
      phase('actual-six-view-ui', primary.matchId); result.views = await sixViews(page, directory, primary.matchId);
      phase('ui-returned-home'); await delay(500);
    }
    phase('shared-library-storage-after');
    const storageAfter = await page.evaluate('window.cs2Analyst.library.storage()'); assert.equal(storageAfter.kind, 'success');
    result.storage.after = storageAfter; result.storage.sharedIndexBytesAfter = storageAfter.indexBytes;
    const overlay = await page.evaluate('Boolean(document.querySelector("vite-error-overlay,#webpack-dev-server-client-overlay,[data-nextjs-dialog]"))');
    assert.equal(overlay, false);
    result.console = consoleMessages;
    result.knownDevelopmentWarnings = consoleMessages.filter(item => /Electron Security Warning.*Content-Security-Policy|Insecure Content-Security-Policy/s.test(item.text));
    const unexpected = consoleMessages.filter(item => !result.knownDevelopmentWarnings.includes(item));
    assert.deepEqual(unexpected, [], 'Unexpected Renderer console warnings/errors');
    assert.deepEqual(errors, [], 'Unhandled Renderer exceptions or resource errors');
    phase('before-close');
    closing = true; clearInterval(timer); timer = null; if (polling) await polling;
    try { await page.evaluate('void window.cs2Analyst.window.close()'); } catch { /* A closed socket requires actual exit below. */ }
    await waitFor(() => child.exitCode !== null, 20_000, 'GUI process exit', { diagnostics: () => ({ stderr: tracked.stderr }) });
    assert.equal(child.exitCode, 0, tracked.stderr);
    page.socket.close(); scope.sessions.delete(page.socket);
    const rows = readObservations(directory);
    result.memory = summarizeMemory(rows, observations, phases);
    result.rendererHeapObservations = observations;
    const released = rows.filter(row => row.processes && row.at >= phases.find(item => item.label === 'released-idle').at
      && row.at < (phases.find(item => item.label === 'actual-six-view-ui')?.at ?? phases.find(item => item.label === 'before-close').at));
    assert.ok(released.length, 'No release memory observations');
    assert.ok(released.slice(-2).every(row => !row.processes.some(p => /^CS2 /.test(p.serviceName ?? p.name ?? ''))), 'Analysis Utility survives release');
    result.staleAfterReopenRejected = true; result.staleAfterSwitchRejected = true; result.releasedUtilityExited = true;
    result.status = 'PASS';
  } catch (error) {
    result.status = 'FAIL'; result.error = { message: error.message, stack: error.stack };
    result.console = consoleMessages; result.rendererErrors = errors;
    if (page) { try { const shot = await page.send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(directory, 'failure.png'), Buffer.from(shot.data, 'base64')); } catch {} }
    throw error;
  } finally {
    closing = true; if (timer) clearInterval(timer); if (polling) await polling;
    page?.socket.close();
    let cleanupError;
    try { await scope.cleanup(); }
    catch (error) { cleanupError = error; result.cleanupError = { message: error.message, stack: error.stack }; }
    writeFileSync(join(directory, 'electron.stdout.log'), tracked.stdout);
    writeFileSync(join(directory, 'electron.stderr.log'), tracked.stderr);
    const primaryFailed = result.status === 'FAIL';
    if (cleanupError && !primaryFailed) { result.status = 'FAIL'; result.error = result.cleanupError; }
    save(run, join(directory, 'result.json'), result);
    if (cleanupError && !primaryFailed) throw cleanupError;
  }
  return result;
}

async function main(args) {
  if (!args.length || args[0] === '--help') {
    console.log('Usage: node scripts/library-storage-electron-qa.mjs <benchmark directory or run.json> [--trials=3] [--requests=40]\nBuild first. Serial GUI processes; no DEM access, GC, downloads, OS cache clearing, or user-library access.');
    return;
  }
  assert.equal(process.platform, 'win32', 'This measurement uses the bundled Windows Electron runtime');
  assert.equal(typeof global.gc, 'undefined');
  const benchmark = readBenchmark(args[0]);
  const flags = Object.fromEntries(args.slice(1).map(arg => { const match = /^--(trials|requests)=(\d+)$/.exec(arg); assert.ok(match, 'Unknown argument'); return [match[1], Number(match[2])]; }));
  const trials = flags.trials ?? 3, requests = flags.requests ?? 40;
  assert.ok(Number.isInteger(trials) && trials >= 3 && trials <= 10);
  assert.ok(Number.isInteger(requests) && requests >= 40 && requests <= 512);
  const owner = createOwnedTempDirectory('storage-electron-qa', { parent: realpathSync.native(tmpdir()) });
  const runs = Object.fromEntries([1, 2].map(version => [version, createOwnedQaRun(`storage-gui-v${version}`, { parent: owner.directory })]));
  const app = prepareApp(owner);
  const sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8', windowsHide: true }).trim();
  const sourceWorktreeDirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: repository, encoding: 'utf8', windowsHide: true }).trim().length > 0;
  const builtEntryFingerprints = { main: app.original['electron/main.js'], reportWorker: app.original['electron/report-worker.js'] };
  const config = { schemaVersion: 1, owner, repository, benchmark: benchmark.configPath, trials, requests, runs, app,
    sourceRevision, sourceWorktreeDirty, builtEntryFingerprints,
    buildPrecondition: 'Caller must build before running. repo HEAD/dirty state is recorded at run creation; the original dist fingerprints identify the exact measured bytes and do not independently prove which source revision built them.',
    createdAt: new Date().toISOString() };
  const configPath = join(owner.directory, 'gui-run.json'); save(owner, configPath, config);
  console.log(JSON.stringify({ guiRun: owner.directory, benchmark: benchmark.configPath, trials, requests, serial: true }));
  const electron = require('electron'), results = [];
  try {
    for (const version of [1, 2]) await runSeed(electron, configPath, version);
    // Every fixture gets a genuinely new app process for each format/trial; no parallel pressure.
    for (let trial = 0; trial < trials; trial++) for (const name of benchmark.fixtures) for (const version of [1, 2]) {
      console.log(JSON.stringify({ phase: 'GUI', trial, name, version }));
      results.push(await launchTrial(config, benchmark, version, trial, name));
    }
    save(owner, join(owner.directory, 'results.json'), { schemaVersion: 1, createdAt: config.createdAt, benchmark: benchmark.configPath,
      sourceRevision, sourceWorktreeDirty, builtEntryFingerprints, buildPrecondition: config.buildPrecondition,
      trials, requests, serial: true, explicitGc: false, osFileCacheCleared: false,
      scope: 'Built desktop GUI with current Main/preload/Renderer/Utility code plus passive QA-only memory observers. Both formats use the current common production reader; original 9318ed9 worker speed is not measured. New-process open is not cold disk; direct IPC timings exclude React UI rendering. Each fixture/format performs a Main portable export/delete/import in trial 0. One real row open and six rendered views are separately checked per format.',
      results });
    console.log(JSON.stringify({ success: true, results: join(owner.directory, 'results.json') }));
  } catch (error) {
    save(owner, join(owner.directory, 'failure.json'), { message: error.message, stack: error.stack, completed: results.length });
    throw error;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === here) {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === '$seed') await seed(...args);
  else await main(mode ? [mode, ...args] : []);
}
