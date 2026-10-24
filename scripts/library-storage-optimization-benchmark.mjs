// Disposable, serial production-code comparison. Never opens the user's library.
// node scripts/library-storage-optimization-benchmark.mjs run [demo1.dem ...]
// node scripts/library-storage-optimization-benchmark.mjs synthetic
// Cold means a new process; this tool does NOT clear the OS filesystem cache.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { createOwnedTempDirectory, assertOwnedDirectory, assertOwnedPath } from './owned-qa-run.mjs';
import { heatmapCases, quantiles } from './library-spike-core.mjs';

const here = fileURLToPath(import.meta.url), repository = resolve(dirname(here), '..');
const allowed = ['demo1.dem', 'demo2.dem', 'dust2.dem', 'nuke.dem'];
const normalize = value => JSON.stringify(value, (key, item) => key === 'sessionId' ? undefined : item);
const hash = value => createHash('sha256').update(value).digest('hex');
const fingerprint = value => { const raw = normalize(value); return { bytes: Buffer.byteLength(raw), sha256: hash(raw) }; };
const currentRevision = () => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8', windowsHide: true }).trim();
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const fixturePath = name => {
  assert.ok(allowed.includes(name), 'Only demo1.dem, demo2.dem, dust2.dem and nuke.dem are permitted');
  return join(repository, '.demo', name);
};
function writeResult(config, path, value) {
  assertOwnedPath(config.owner, path);
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
}
function loadConfig(path) {
  assert.equal(basename(path), 'run.json');
  const config = json(resolve(path));
  assertOwnedDirectory(config.owner);
  assert.equal(resolve(path), join(config.owner.directory, 'run.json'));
  assert.equal(config.repository, repository);
  assert.ok(Number.isSafeInteger(config.samples) && config.samples >= 3 && config.samples <= 10);
  assert.ok(Array.isArray(config.fixtures) && config.fixtures.length > 0
    && new Set(config.fixtures).size === config.fixtures.length
    && config.fixtures.every(name => allowed.includes(name) || (config.synthetic === true && name === 'synthetic')));
  return config;
}
function dataDirectory(config, name) {
  assert.ok(config.fixtures.includes(name));
  return assertOwnedPath(config.owner, join(config.owner.directory, name.replace(/\.dem$/, '')));
}
async function fileHash(path) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
}
function memoryRecorder() {
  const observations = [], started = performance.now();
  let phase = 'initialization';
  const take = label => {
    const memory = process.memoryUsage();
    observations.push({ elapsedMs: performance.now() - started, phase: label ?? phase, ...memory });
  };
  take();
  const timer = setInterval(() => take(), 40);
  timer.unref();
  return {
    phase(label) { phase = label; take(); },
    snapshot: take,
    finish() {
      clearInterval(timer); take('finish');
      const keys = ['rss', 'heapTotal', 'heapUsed', 'external', 'arrayBuffers'];
      return { unit: 'bytes', observationIntervalMs: 40,
        peakObserved: Object.fromEntries(keys.map(key => [key, Math.max(...observations.map(item => item[key]))])),
        processLifetimeMaxRssBytes: process.resourceUsage().maxRSS * 1024,
        observations,
        interpretation: 'Electron run-as-node tool process. RSS includes native allocations; external includes ArrayBuffer memory and must not be added to arrayBuffers. No claim of a complete native heap breakdown. JS-blocking operations may fall between timer samples; resourceUsage maxRSS is process lifetime high water.' };
    },
  };
}
async function imports() {
  const [archive, derived, heatmap, portable, replay] = await Promise.all([
    import('../apps/desktop/electron/library-archive.ts'),
    import('../apps/desktop/electron/library-derived-replay.ts'),
    import('../apps/desktop/electron/heatmap-session.ts'),
    import('../apps/desktop/electron/library-portable.ts'),
    import('../apps/desktop/electron/replay-session.ts'),
  ]);
  return { archive, derived, heatmap, portable, replay };
}
function versions(metadata, archive, sourceRevision) {
  const version = path => json(join(repository, path, 'package.json')).version;
  return { application: version('apps/desktop'), archive, report: 2, replay: 1,
    analysis: `analytics:${version('packages/analytics')};findings:${version('packages/findings')};deep-review:${version('packages/deep-review')};heatmap:p7.1-v1;benchmark`,
    parser: version('packages/dem-parser'), native: version('packages/demoparser-native'),
    sampling: metadata.samplingVersion, mapResource: metadata.resourceId, sourceRevision };
}
async function inventory(directory, receipt, api) {
  const manifestBytes = (await stat(join(directory, 'manifest.json'))).size;
  const roles = {}, members = [];
  for (const member of receipt.manifest.files) {
    const actual = (await stat(join(directory, member.path))).size;
    assert.equal(actual, api.archiveCompressedBytes(member));
    roles[member.role] ??= { members: 0, storedBytes: 0, rawBytes: 0 };
    roles[member.role].members++; roles[member.role].storedBytes += actual; roles[member.role].rawBytes += member.rawBytes;
    members.push({ path: member.path, storedBytes: actual, rawBytes: member.rawBytes });
  }
  const totalBytes = manifestBytes + members.reduce((sum, item) => sum + item.storedBytes, 0);
  assert.equal(totalBytes, receipt.storedBytes);
  return { totalBytes, manifestBytes, roles, members, persistentCacheBytes: 0,
    cachePolicy: receipt.manifest.schemaVersion === 2 ? 'No disk replay cache; Utility LRU <= 3 MiB; canonical sources shared with Heatmap.' : 'Stored UI replay chunks; no additional disk replay cache.' };
}
async function syntheticData() {
  const { fixture } = await import('../apps/desktop/tests/heatmap-fixture.mjs');
  const f = fixture();
  const id = hash('storage-optimization-synthetic');
  f.match.id = id; f.match.map = 'de_dust2'; f.replay.matchId = id; f.spatial.matchId = id;
  f.match.players.forEach(p => { p.nickname = 'Synthetic'; });
  return { parsed: f, report: { schemaVersion: 2,
    match: { id, fileName: 'dust2.dem', map: f.match.map, rounds: f.match.rounds.length, score: null },
    selectedPlayer: '1', players: f.match.players.map(p => ({ id: p.steamId, nickname: p.nickname })),
    analytics: [], findings: [], timeline: [], analysis: { players: [], perPlayer: [] }, deepReview: { available: false, players: [] } } };
}
async function capture(config, name, memory) {
  const api = await imports(), directory = dataDirectory(config, name);
  await mkdir(directory);
  const started = performance.now(); memory.phase('parse');
  let parsed, report, source;
  if (name === 'synthetic') {
    ({ parsed, report } = await syntheticData()); source = { synthetic: true };
  } else {
    const path = fixturePath(name);
    const { Demoparser2Provider } = await import('../packages/dem-parser/dist/index.js');
    const { buildDesktopReport } = await import('../apps/desktop/electron/report.ts');
    const sha256 = await fileHash(path);
    parsed = await new Demoparser2Provider().parseWithReplay(path);
    assert.equal(parsed.match.id, sha256);
    memory.phase('report'); report = buildDesktopReport(parsed.match, path, parsed.spatial);
    source = { fileName: name, sha256, bytes: (await stat(path)).size };
  }
  const parseAndReportMs = performance.now() - started;
  assert.ok(parsed.replay && parsed.spatial, 'Do not compare archives with omitted canonical evidence');
  const sessionId = randomUUID(); memory.phase('initial-replay');
  const replay = new api.replay.ReplaySession(parsed.match, parsed.replay, sessionId);
  memory.phase('heatmap-admission');
  const heatmap = api.heatmap.createHeatmapSession(parsed.match, parsed.replay, parsed.spatial, sessionId);
  if (!heatmap.session || !heatmap.metadata.available) {
    const failure = { source, heatmapMetadata: heatmap.metadata, memory: memory.finish(), runtime: process.versions };
    writeResult(config, join(directory, 'capture-heatmap-failure.json'), failure);
    throw new Error(`Production Heatmap admission failed without explicit GC: ${JSON.stringify(heatmap.metadata)}`);
  }
  report.replay = replay.metadata; report.heatmap = heatmap.metadata;
  memory.phase('fingerprints');
  const expected = { report: fingerprint(report), sources: { match: fingerprint(parsed.match), replay: fingerprint(parsed.replay), spatial: fingerprint(parsed.spatial) },
    replayMetadata: fingerprint(report.replay), heatmapMetadata: fingerprint(report.heatmap),
    chunks: Object.fromEntries([...replay.chunks].map(([key, json]) => [key, fingerprint(JSON.parse(json))])), heatmaps: [] };
  memory.phase('heatmap-filter-matrix');
  for (const request of heatmapCases(heatmap.metadata)) {
    const result = heatmap.session.get(request);
    assert.equal(result.kind, 'success', `Heatmap case failed: ${JSON.stringify(request)}`);
    expected.heatmaps.push({ request: JSON.parse(normalize(request)), ...fingerprint(result) });
  }
  writeResult(config, join(directory, 'expected.json'), expected);
  const saves = { 1: [], 2: [] }, sizes = {};
  for (let trial = 0; trial < config.samples; trial++) for (const version of [1, 2]) {
    const target = join(directory, trial === 0 ? `v${version}` : `save-v${version}-${trial}`); await mkdir(target);
    memory.phase(`save-v${version}-${trial}`); const at = performance.now();
    const receipt = await api.archive.writeLibraryArchive(target, { report, chunks: replay.chunks, ...parsed,
      versions: versions(replay.metadata, version, config.sourceRevision), createdAt: config.createdAt });
    const saveMs = performance.now() - at;
    memory.phase(`verify-save-v${version}-${trial}`); const verifyAt = performance.now();
    const verified = await api.archive.verifyLibraryArchive(target);
    assert.equal(verified.manifestHash, receipt.manifestHash);
    saves[version].push({ saveMs, verifyMs: performance.now() - verifyAt, totalBytes: receipt.storedBytes });
    if (trial === 0) sizes[version] = await inventory(target, receipt, api.archive);
    else assert.equal(receipt.storedBytes, sizes[version].totalBytes, 'Repeated saves must retain the exact format size');
  }
  memory.phase('release-capture'); replay.clear(); heatmap.session.clear();
  return { source, rounds: parsed.match.rounds.length, players: parsed.match.players.length, parseAndReportMs,
    heatmapCases: expected.heatmaps.length, chunks: Object.keys(expected.chunks).length, sizes, saves,
    saveMs: Object.fromEntries([1, 2].map(version => [version, quantiles(saves[version].map(x => x.saveMs))])),
    note: 'One DEM parse shared by both formats; three serial saves per format. No explicit GC. Parse/report time is shared and is not three independent DEM import samples.' };
}
function shuffled(values, seed = 0x2c52a) {
  const copy = [...values];
  for (let i = copy.length - 1; i > 0; i--) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; const j = seed % (i + 1); [copy[i], copy[j]] = [copy[j], copy[i]]; }
  return copy;
}
function sameFingerprint(actual, expected, label) {
  assert.deepEqual(fingerprint(actual), { bytes: expected.bytes, sha256: expected.sha256 }, label);
}
async function openOne(config, name, version, directory, memory, allHeatmaps, label) {
  const api = await imports(), expected = json(join(dataDirectory(config, name), 'expected.json'));
  const sessionId = randomUUID(); memory.phase(`${label}-load`); const start = performance.now();
  let loaded = await api.archive.loadLibraryArchive(directory);
  assert.ok(loaded.report && loaded.sources);
  const loadMs = performance.now() - start;
  sameFingerprint(loaded.report, expected.report, 'Full report JSON must match');
  for (const role of ['match', 'replay', 'spatial']) sameFingerprint(loaded.sources[role], expected.sources[role], `Full ${role} JSON must match`);
  sameFingerprint(loaded.report.replay, expected.replayMetadata, 'Replay metadata must match');
  const metadata = { ...loaded.report.replay, sessionId }, manifest = loaded.manifest;
  let loads = 0;
  let replay = version === 2 ? new api.derived.DerivedReplaySession(loaded.sources.replay, metadata, async round => {
    loads++; return api.archive.readArchiveProjection(directory, manifest, round);
  }) : { bytes: 0, get: request => api.archive.readArchiveChunk(directory, manifest, request), clear() {} };
  memory.phase(`${label}-heatmap-admission`); const atHeatmap = performance.now();
  let heatmap = api.heatmap.createHeatmapSession(loaded.sources.match, loaded.sources.replay, loaded.sources.spatial, sessionId);
  assert.ok(heatmap.session && heatmap.metadata.available, `Restored Heatmap admission failed: ${JSON.stringify(heatmap.metadata)}`);
  sameFingerprint(heatmap.metadata, expected.heatmapMetadata, 'Heatmap capabilities must match');
  const openMs = performance.now() - start, heatmapInitMs = performance.now() - atHeatmap;
  memory.phase(`${label}-seek`);
  const miss = [], hit = []; let cachePeakBytes = 0, frames = 0, utilities = 0;
  for (const key of shuffled(Object.keys(expected.chunks))) {
    const [round, block] = key.split(':').map(Number), request = { sessionId, round, block };
    const before = loads, at = performance.now(), chunk = await replay.get(request); miss.push(performance.now() - at);
    assert.ok(chunk); sameFingerprint(chunk, expected.chunks[key], `Whole chunk ${key}`);
    const atHit = performance.now(), repeated = await replay.get(request); hit.push(performance.now() - atHit);
    sameFingerprint(repeated, expected.chunks[key], `Repeated whole chunk ${key}`);
    if (version === 2) { assert.equal(loads, before + 1); assert.ok(replay.bytes <= api.derived.DERIVED_REPLAY_CACHE_BYTES); }
    cachePeakBytes = Math.max(cachePeakBytes, replay.bytes);
    frames += chunk.frames.length; utilities += chunk.utilities?.length ?? 0;
  }
  let verifiedHeatmapCases = 0;
  memory.phase(`${label}-heatmap-filters`);
  for (const item of allHeatmaps ? expected.heatmaps : expected.heatmaps.slice(0, 1)) {
    const result = heatmap.session.get({ ...item.request, sessionId });
    assert.equal(result.kind, 'success'); sameFingerprint(result, item, 'Full filtered Heatmap result'); verifiedHeatmapCases++;
  }
  memory.phase(`${label}-release`); replay.clear(); heatmap.session.clear();
  assert.equal(replay.bytes, 0); replay = null; heatmap = null; loaded = null;
  await delay(200); memory.snapshot(`${label}-released-200ms`);
  return { loadMs, openMs, heatmapInitMs, chunks: miss.length, frames, utilities, verifiedHeatmapCases,
    uniqueBlockRequestsMs: quantiles(miss), immediateRepeatedBlockRequestsMs: quantiles(hit), cachePeakBytes, projectionLoads: loads,
    cacheInterpretation: version === 2 ? 'Unique requests miss the Derived LRU; immediate repeats hit it.' : 'v1 reads and decompresses on every call; immediate repeat is OS-cache-warm, not an application-cache hit.',
    canonicalJsonByteExact: true, reportJsonByteExact: true, chunksJsonByteExact: true, metadataJsonByteExact: true };
}
async function probe(config, name, version, trial, memory) {
  const directory = join(dataDirectory(config, name), `v${version}`);
  const cold = await openOne(config, name, version, directory, memory, trial === 0, 'new-process-first-open');
  const repeated = await openOne(config, name, version, directory, memory, false, 'same-process-reopen');
  return { version, trial, cold, repeated, osFileCacheCleared: false, processStartupExcludedFromOpenMs: true,
    coldDefinition: 'New Electron run-as-node process, production archive and session algorithms. The operating system file cache is not cleared; this is not a cold-disk test.' };
}
async function portable(config, name, version, memory) {
  const api = await imports(), directory = dataDirectory(config, name), archive = join(directory, `v${version}`);
  const path = join(directory, `v${version}.cs2a`), stage = join(directory, `portable-v${version}`);
  memory.phase('portable-export'); let at = performance.now();
  const exported = await api.portable.writePortableArchive(archive, path);
  const exportMs = performance.now() - at;
  await api.portable.verifyPortableArchive(path);
  memory.phase('portable-import'); await mkdir(stage); at = performance.now();
  const extracted = await api.portable.extractPortableArchive(path, stage);
  const verified = await api.archive.verifyLibraryArchive(stage), importMs = performance.now() - at;
  assert.equal(verified.manifestHash, exported.manifest ? hash(JSON.stringify(exported.manifest)) : null);
  assert.equal(extracted.header.archiveSchemaVersion, version);
  for (const member of exported.header.files) assert.equal(await fileHash(join(stage, member.path)), await fileHash(join(archive, member.path)));
  const reopened = await openOne(config, name, version, stage, memory, true, 'portable-offline-reopen');
  return { version, exportMs, importAndVerifyMs: importMs, packageBytes: exported.bytes,
    archiveMembersByteExact: true, reopened, sourceDemNeededDuringReopen: false };
}
async function child(mode, configPath, name, versionText, trialText) {
  assert.ok(process.versions.electron && process.env.ELECTRON_RUN_AS_NODE === '1', 'Use the bundled Electron runtime');
  assert.equal(typeof global.gc, 'undefined', 'Do not use --expose-gc in this benchmark');
  const config = loadConfig(configPath), memory = memoryRecorder();
  const version = Number(versionText), trial = Number(trialText);
  assert.ok(config.fixtures.includes(name));
  const output = join(dataDirectory(config, name), mode === '$capture' ? 'capture.json' : `${mode.slice(1)}-v${version}${mode === '$probe' ? `-${trial}` : ''}.json`);
  try {
    let result;
    if (mode === '$capture') result = await capture(config, name, memory);
    else {
      assert.ok([1, 2].includes(version));
      if (mode === '$probe') { assert.ok(Number.isInteger(trial) && trial >= 0 && trial < config.samples); result = await probe(config, name, version, trial, memory); }
      else if (mode === '$portable') result = await portable(config, name, version, memory);
      else throw new Error('Unknown internal mode');
    }
    writeResult(config, output, { schemaVersion: 1, mode, name, sourceRevision: currentRevision(), runtime: process.versions,
      explicitGc: false, processType: 'Electron run-as-node benchmark tool', ...result, memory: memory.finish() });
    console.log(JSON.stringify({ mode, name, version, trial, success: true, output }));
  } catch (error) {
    const failure = join(config.owner.directory, `failure-${name}-${mode.slice(1)}-${version}-${trial}-${randomUUID()}.json`);
    writeResult(config, failure, { mode, name, version, trial, message: error.message, stack: error.stack, runtime: process.versions, memory: memory.finish() });
    throw error;
  }
}
async function launch(electron, args) {
  await new Promise((resolve, reject) => {
    const process = spawn(electron, [here, ...args], { cwd: repository, windowsHide: true,
      env: { ...globalThis.process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let diagnostics = '';
    process.stdout.on('data', chunk => globalThis.process.stdout.write(chunk));
    process.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-65536); });
    process.on('error', reject);
    process.on('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`Electron child failed (${code ?? signal}): ${diagnostics}`)));
  });
}
async function run(mode, names) {
  assert.ok(mode === 'run' || mode === 'synthetic');
  const fixtures = mode === 'synthetic' ? ['synthetic'] : names.length ? names : allowed;
  assert.equal(new Set(fixtures).size, fixtures.length);
  if (mode !== 'synthetic') fixtures.forEach(fixturePath);
  const owner = createOwnedTempDirectory('storage-optimization');
  const config = { schemaVersion: 1, owner, repository, fixtures, samples: 3, synthetic: mode === 'synthetic',
    createdAt: new Date().toISOString(), sourceRevision: currentRevision() };
  const configPath = join(owner.directory, 'run.json'); writeResult(config, configPath, config);
  console.log(JSON.stringify({ runDirectory: owner.directory, fixtures, samples: config.samples }));
  const require = createRequire(join(repository, 'apps/desktop/package.json')), electron = require('electron');
  for (const name of fixtures) {
    await launch(electron, ['$capture', configPath, name]);
    for (let trial = 0; trial < config.samples; trial++) for (const version of [1, 2]) await launch(electron, ['$probe', configPath, name, String(version), String(trial)]);
    for (const version of [1, 2]) await launch(electron, ['$portable', configPath, name, String(version)]);
  }
  const results = [];
  for (const name of fixtures) {
    const directory = dataDirectory(config, name), capture = json(join(directory, 'capture.json'));
    const byVersion = {};
    for (const version of [1, 2]) {
      const probes = Array.from({ length: config.samples }, (_, trial) => json(join(directory, `probe-v${version}-${trial}.json`)));
      byVersion[version] = { size: capture.sizes[version], saveMs: capture.saveMs[version], probes,
        newProcessFirstOpenMs: quantiles(probes.map(p => p.cold.openMs)), sameProcessReopenMs: quantiles(probes.map(p => p.repeated.openMs)),
        portable: json(join(directory, `portable-v${version}.json`)) };
    }
    results.push({ name, source: capture.source, rounds: capture.rounds, players: capture.players, chunks: capture.chunks,
      heatmapCases: capture.heatmapCases, capture, versions: byVersion,
      savedBytes: capture.sizes[1].totalBytes - capture.sizes[2].totalBytes,
      savedFraction: 1 - capture.sizes[2].totalBytes / capture.sizes[1].totalBytes });
  }
  writeResult(config, join(owner.directory, 'results.json'), { schemaVersion: 1, createdAt: config.createdAt,
    sourceRevision: config.sourceRevision, units: { storage: 'bytes; MB = 1000000 bytes', timings: 'milliseconds', memory: 'bytes' },
    samples: config.samples, serial: true, osFileCacheCleared: false, explicitGc: false, synthetic: config.synthetic,
    measurementScope: 'Bundled Electron run-as-node processes using production parser/storage/replay/Heatmap. This does not measure GUI Main/Utility/Renderer working sets. New-process first open is not cold disk.',
    results });
  console.log(JSON.stringify({ success: true, results: join(owner.directory, 'results.json') }));
}
const [mode, ...args] = process.argv.slice(2);
if (mode?.startsWith('$')) await child(mode, ...args);
else await run(mode, args);
