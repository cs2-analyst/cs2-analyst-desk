// L0 only: disposable, process-isolated snapshots using the current production parser and presenters.
// Never registered by Desktop, never shipped in the installer, never a production archive reader.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync, statSync, cpSync, renameSync, rmdirSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { platform, release, arch, cpus, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { compareCodecs, decodeVerified, digest, hashJson, withoutSession, assertFixture, quantiles, heatmapCases } from './library-spike-core.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const [mode = 'run', pathArg = 'E:/cs2-analyst/.demo', outputArg] = process.argv.slice(2);
const out = resolve(outputArg ?? `.tmp/l0/storage-${Date.now()}`);
if (mode === 'run') assert.ok(!existsSync(out) || readdirSync(out).length === 0, 'Use a new empty experiment output directory; previous evidence must never be overwritten');
mkdirSync(out, { recursive: true });
const script = fileURLToPath(import.meta.url);
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const runtime = () => ({ node: process.versions, os: `${platform()} ${release()} ${arch()}`, cpu: cpus()[0]?.model, logicalCpus: cpus().length, totalMemoryBytes: totalmem() });
const rss = () => ({ resourceUsage: process.resourceUsage(), memoryUsage: process.memoryUsage(), maxRssUnit: 'KiB (Node process.resourceUsage maxRSS; lifecycle peak, not a simultaneous whole-app aggregate)' });
async function fileHash(path) { const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest('hex'); }

async function production() {
  const { Demoparser2Provider } = await import('../packages/dem-parser/dist/index.js');
  const { buildDesktopReport } = await import('../apps/desktop/electron/report.ts');
  const { ReplaySession } = await import('../apps/desktop/electron/replay-session.ts');
  const { createHeatmapSession } = await import('../apps/desktop/electron/heatmap-session.ts');
  return { Demoparser2Provider, buildDesktopReport, ReplaySession, createHeatmapSession };
}

if (mode === 'capture') {
  assert.equal(typeof global.gc, 'function', 'L0 comparison requires --expose-gc; never claim a collection that did not occur');
  assertFixture(pathArg); assert.ok(existsSync(pathArg), 'Local fixture must already exist; no replacement/download');
  const sha256 = await fileHash(pathArg), size = statSync(pathArg).size;
  if (basename(pathArg) === 'dust2.dem') {
    assert.equal(sha256, 'db90fe85aab023a1d2c8a5996182e6120d98ef494f02a070b17982b235e4958c'); assert.equal(size, 557650967);
  }
  const { Demoparser2Provider, buildDesktopReport, ReplaySession, createHeatmapSession } = await production();
  const started = performance.now(), cpu = process.cpuUsage();
  const parsed = await new Demoparser2Provider().parseWithReplay(pathArg), parsedAt = performance.now();
  assert.equal(parsed.match.id, sha256); assert.ok(parsed.replay && parsed.spatial, 'Both canonical heatmap sources required for full restoration');
  const sid = randomUUID(), report = buildDesktopReport(parsed.match, pathArg, parsed.spatial);
  const replay = new ReplaySession(parsed.match, parsed.replay, sid);
  const beforeCollection = process.memoryUsage(), gcStart = performance.now(); global.gc();
  const explicitGcMs = performance.now() - gcStart;
  const afterCollection = process.memoryUsage();
  const heatmap = createHeatmapSession(parsed.match, parsed.replay, parsed.spatial, sid);
  assert.ok(heatmap.session && heatmap.metadata.available, 'Production heatmap admission must remain available');
  report.replay = replay.metadata; report.heatmap = heatmap.metadata;
  const reportAt = performance.now();
  const manifest = { experimentSchema: 1, candidate: 'A: complete canonical Match + MatchReplay + MatchSpatialEvidence',
    source: { fileName: basename(pathArg), sha256, bytes: size }, reportSchema: report.schemaVersion, replaySchema: 1,
    sourceBaseline: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim(), runtime: runtime(),
    files: [], chunkIndex: [], heatmapComparisons: [], reportHash: hashJson(withoutSession(report)),
    experimentalGc: { explicitlyCollectedBeforeHeatmapAdmission: true, explicitGcMs, beforeCollection, afterCollection,
      reason: 'Node26 experiment GC timing differs from Electron24; existing 512MiB budget unchanged. Electron experiment is required separately.' } };
  function save(name, value) {
    const serializeStart = performance.now(), raw = Buffer.from(JSON.stringify(value)), serializeMs = performance.now() - serializeStart;
    const start = performance.now(), { result, gzip } = compareCodecs(raw);
    const path = name + '.json.gz', writeStart = performance.now(); mkdirSync(dirname(join(out, path)), { recursive: true }); writeFileSync(join(out, path), gzip);
    const filesystemWriteMs = performance.now() - writeStart;
    const descriptor = { path, ...result, gzipBytes: gzip.length, gzipSha256: digest(gzip), serializeMs, filesystemWriteMs, compareAndWriteMs: performance.now() - start };
    manifest.files.push(descriptor); return descriptor;
  }
  const writeStart = performance.now();
  save('report', withoutSession(report));
  save('heatmap/match', parsed.match); save('heatmap/replay', parsed.replay); save('heatmap/spatial', parsed.spatial);
  for (const [key, json] of replay.chunks) {
    const chunk = JSON.parse(json), [round, block] = key.split(':').map(Number);
    const descriptor = save(`replay/${round}-${block}`, withoutSession(chunk));
    manifest.chunkIndex.push({ round, block, path: descriptor.path, sha256: descriptor.sha256,
      sample: { tick: chunk.frames[Math.floor(chunk.frames.length / 2)].tick, players: chunk.frames[Math.floor(chunk.frames.length / 2)].players },
      effects: { utilities: chunk.utilities?.length ?? 0, blinds: chunk.blinds?.length ?? 0, burns: chunk.burns?.length ?? 0, followDeaths: chunk.follow?.deaths?.length ?? 0 } });
  }
  const writtenAt = performance.now();
  const cases = heatmapCases(heatmap.metadata), projectionMs = [];
  for (const request of cases) {
    const start = performance.now(), result = heatmap.session.get(request); projectionMs.push(performance.now() - start);
    assert.equal(result.kind, 'success', `Heatmap scope failed: ${JSON.stringify(request)}`);
    manifest.heatmapComparisons.push({ request: withoutSession(request), sha256: hashJson(withoutSession(result)), bytes: Buffer.byteLength(JSON.stringify(result)) });
  }
  manifest.timing = { parseWithReplayMs: parsedAt - started, reportAndSessionMs: reportAt - parsedAt,
    experimentalPipelineMs: reportAt - started, compressionComparisonAndWriteMs: writtenAt - writeStart,
    heatmapProjectionMs: quantiles(projectionMs), totalExperimentMs: performance.now() - started, cpuMicroseconds: process.cpuUsage(cpu) };
  manifest.replay = { count: replay.chunks.size, productionCacheBytes: replay.bytes, maxRawBytes: Math.max(...manifest.files.filter(f => f.path.startsWith('replay/')).map(f => f.rawBytes)) };
  manifest.observed = rss();
  manifest.storage = { rawPayloadBytes: manifest.files.reduce((n, f) => n + f.rawBytes, 0), gzipPayloadBytes: manifest.files.reduce((n, f) => n + f.gzipBytes, 0),
    brotliPayloadBytes: manifest.files.reduce((n, f) => n + f.codecs['brotli-4'].bytes, 0), fileCount: manifest.files.length + 1 };
  writeJson(join(out, 'manifest.json'), manifest);
  console.log(JSON.stringify({ mode, fixture: manifest.source, timing: manifest.timing, storage: manifest.storage, observed: manifest.observed }));
} else if (mode === 'restore') {
  assert.equal(typeof global.gc, 'function', 'L0 comparison requires --expose-gc; never claim a collection that did not occur');
  assert.ok(!existsSync(pathArg), 'Cold-restore precondition: original DEM must be physically absent');
  const start = performance.now(), cpu = process.cpuUsage();
  const { createHeatmapSession } = await production(), manifest = readJson(join(out, 'manifest.json'));
  const load = name => { const file = manifest.files.find(f => f.path === name); assert.ok(file); return decodeVerified(readFileSync(join(out, name)), file); };
  const report = load('report.json.gz'), reportMs = performance.now() - start;
  assert.equal(hashJson(report), manifest.reportHash);
  const chunkMs = []; let seed = 0x51a7b9, sampleFrames = 0;
  for (let i = 0; i < 128; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const info = manifest.chunkIndex[seed % manifest.chunkIndex.length], t = performance.now(), chunk = load(info.path); chunkMs.push(performance.now() - t);
    assert.equal(hashJson(chunk), info.sha256);
    const sample = chunk.frames.find(f => f.tick === info.sample.tick); assert.deepEqual(sample.players, info.sample.players); sampleFrames++;
  }
  const allChunksStart = performance.now();
  for (const info of manifest.chunkIndex) {
    const chunk = load(info.path); assert.equal(hashJson(chunk), info.sha256);
    assert.equal(chunk.matchId, manifest.source.sha256); assert.equal(chunk.round, info.round); assert.equal(chunk.block, info.block);
  }
  const allChunksVerificationMs = performance.now() - allChunksStart;
  const sourceAt = performance.now(), match = load('heatmap/match.json.gz'), replay = load('heatmap/replay.json.gz'), spatial = load('heatmap/spatial.json.gz');
  const sourceMs = performance.now() - sourceAt, sid = randomUUID(); global.gc();
  const heatmap = createHeatmapSession(match, replay, spatial, sid);
  assert.ok(heatmap.session && heatmap.metadata.available, 'Cold restoration must pass existing production heap admission');
  const projectionMs = [];
  for (const comparison of manifest.heatmapComparisons) {
    const request = { ...comparison.request, sessionId: sid }, t = performance.now(), result = heatmap.session.get(request); projectionMs.push(performance.now() - t);
    assert.equal(result.kind, 'success'); assert.equal(hashJson(withoutSession(result)), comparison.sha256, `Heatmap mismatch ${JSON.stringify(request)}`);
  }
  const result = { mode, originalDemAbsent: !existsSync(pathArg), source: manifest.source, freshSession: sid,
    reportHash: manifest.reportHash, reportMs, randomReadMs: quantiles(chunkMs), exactRawTickFrames: sampleFrames,
    allReplayChunksEqual: manifest.chunkIndex.length, allChunksVerificationMs,
    canonicalSourceLoadMs: sourceMs, heatmapCasesEqual: manifest.heatmapComparisons.length, heatmapProjectionMs: quantiles(projectionMs),
    totalMs: performance.now() - start, cpuMicroseconds: process.cpuUsage(cpu), observed: rss(),
    scope: 'Data/production presenters restored in a fresh process, not a Renderer/installed-app acceptance claim' };
  writeJson(join(out, 'restore.json'), result); console.log(JSON.stringify(result));
} else if (mode === 'run') {
  const fixtureDir = resolve(pathArg), samples = ['dust2.dem', 'nuke.dem'];
  const results = [], held = [], holdDir = join(fixtureDir, '.l0-offline-' + randomUUID());
  function child(action, fixture, destination) {
    const started = Date.now(), r = spawnSync(process.execPath, ['--expose-gc', script, action, fixture, destination], { cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    writeFileSync(join(destination, action + '.log'), r.stdout + '\n' + r.stderr);
    assert.equal(r.status, 0, `${action} failed ${r.error ?? r.stderr}`); return { exit: r.status, elapsedMs: Date.now() - started };
  }
  for (const name of samples) {
    const fixture = join(fixtureDir, name), destination = join(out, name.replace('.dem', '')); mkdirSync(destination, { recursive: true });
    results.push({ fixture: name, capture: child('capture', fixture, destination) });
  }
  try {
    mkdirSync(holdDir); for (const name of samples) { renameSync(join(fixtureDir, name), join(holdDir, name)); held.push(name); }
    for (const result of results) result.restore = child('restore', join(fixtureDir, result.fixture), join(out, result.fixture.replace('.dem', '')));
    const simulation = [];
    for (let i = 0; i < 10; i++) {
      const name = samples[i % samples.length], destination = join(out, 'isolated', String(i)); mkdirSync(dirname(destination), { recursive: true });
      assert.ok(!existsSync(destination), 'Each reopen simulation has its own new snapshot directory');
      cpSync(join(out, name.replace('.dem', '')), destination, { recursive: true, filter: p => !p.endsWith('.log') && !p.endsWith('restore.json') });
      const observed = child('restore', join(fixtureDir, name), destination);
      simulation.push({ isolatedCopy: i, realFixture: name, ...observed, ...readJson(join(destination, 'restore.json')) });
    }
    const summary = { experimentSchema: 1, executedAt: new Date().toISOString(), sourceBaseline: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim(),
      runtime: runtime(), samples: results.map(r => ({ ...r, manifest: readJson(join(out, r.fixture.replace('.dem', ''), 'manifest.json')), restore: readJson(join(out, r.fixture.replace('.dem', ''), 'restore.json')) })),
      isolationSimulation: { realMatchCount: 2, independentCopiedArchives: 10, demCopied: false, results: simulation },
      offlinePrecondition: { parsedProcessesExited: true, originalFixturePathsPhysicallyAbsentDuringAllRestores: true, restoreProcessesReceiveNoHeldDemPath: true },
      limitations: ['Electron six-view rendering recorded separately; data hash equality alone is not six-view UI acceptance.', 'Replay <=5s query debt remains independent and unresolved.', 'Brotli quality 4 and gzip level 6 are measured candidates, not a frozen production format.'] };
    writeJson(join(out, 'benchmark.json'), summary);
  } finally {
    for (const name of held) { assert.ok(!existsSync(join(fixtureDir, name)), 'Never replace a newly created fixture'); renameSync(join(holdDir, name), join(fixtureDir, name)); }
    if (existsSync(holdDir)) rmdirSync(holdDir);
  }
  for (const name of samples) assert.equal(await fileHash(join(fixtureDir, name)), readJson(join(out, name.replace('.dem', ''), 'manifest.json')).source.sha256);
  console.log(JSON.stringify({ status: 'PASS', benchmark: join(out, 'benchmark.json'), realMatches: 2, isolatedReopens: 10, originalDemRestoredWithSameSha: true }));
} else throw new Error('Expected run, capture or restore mode');
