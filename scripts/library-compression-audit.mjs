// Read-only archive audit and disposable captures. No production writer/reader changes.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, statSync, realpathSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, basename, dirname, sep } from 'node:path';
import { platform, release, cpus } from 'node:os';
import { performance } from 'node:perf_hooks';
import * as zlib from 'node:zlib';
import { assertFixture } from './library-spike-core.mjs';

const [mode, input, destination] = process.argv.slice(2);
const sha = value => createHash('sha256').update(value).digest('hex');
const bytes = value => Buffer.from(JSON.stringify(value));
function save(value) {
  assert.ok(destination && !existsSync(destination), 'Use a new result path; never overwrite evidence');
  writeFileSync(destination, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
}
function readOnlyOutput(directory) {
  assert.ok(destination, 'A new result path is required');
  assert.ok(!existsSync(destination), 'Use a new result path; never overwrite evidence');
  const target = join(realpathSync.native(dirname(resolve(destination))), basename(destination));
  const rel = relative(realpathSync.native(resolve(directory)), target);
  assert.ok(rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel), 'Results must be outside the read-only input archive');
}
const codecs = {
  'gzip-6': [b => zlib.gzipSync(b, { level: 6 }), zlib.gunzipSync],
  'gzip-9': [b => zlib.gzipSync(b, { level: 9 }), zlib.gunzipSync],
  'brotli-4': [b => zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } }), zlib.brotliDecompressSync],
  'brotli-6': [b => zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 6 } }), zlib.brotliDecompressSync],
  'brotli-9': [b => zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9 } }), zlib.brotliDecompressSync],
};
if (typeof zlib.zstdCompressSync === 'function') codecs['zstd-3'] = [
  b => zlib.zstdCompressSync(b, { params: { [zlib.constants.ZSTD_c_compressionLevel]: 3 } }), zlib.zstdDecompressSync,
];
function encoded(raw, codec) {
  const [encode, decode] = codecs[codec], start = performance.now(), packed = encode(raw), at = performance.now();
  const restored = decode(packed), end = performance.now();
  assert.ok(restored.equals(raw), codec + ' must reproduce every original byte');
  return { rawBytes: raw.length, bytes: packed.length, sha256: sha(packed), encodeMs: at - start, decodeMs: end - at };
}
function emptyTotals() { return { rawBytes: 0, bytes: 0, encodeMs: 0, decodeMs: 0 }; }
function accumulate(total, value) { for (const key of Object.keys(total)) total[key] += value[key]; }

// Keys include every field, relation and coverage value. No player/tick approximation.
function spatialDictionary(source) {
  const table = [], ids = new Map(); let references = 0;
  const events = source.events.map(event => ({ ...event, samples: event.samples.map(entry => {
    references++; const key = JSON.stringify(entry.sample);
    if (!ids.has(key)) { ids.set(key, table.length); table.push(entry.sample); }
    return { ...entry, sample: ids.get(key) };
  }) }));
  const packed = { source: { ...source, events }, sampleTable: table };
  const unpack = value => ({ ...value.source, events: value.source.events.map(event => ({ ...event,
    samples: event.samples.map(entry => ({ ...entry, sample: value.sampleTable[entry.sample] })),
  })) });
  return { packed, unpack, details: { references, uniqueSamples: table.length } };
}
function replayTuples(source) {
  const schemas = [], schemaIds = new Map(); let samples = 0;
  const rounds = source.rounds.map(round => ({ ...round, frames: round.frames.map(frame => ({ ...frame,
    players: frame.players.map(sample => {
      samples++; const keys = Object.keys(sample), key = JSON.stringify(keys);
      if (!schemaIds.has(key)) { schemaIds.set(key, schemas.length); schemas.push(keys); }
      // Preserve SteamID strings and all Number/null/boolean values without rounding.
      return [schemaIds.get(key), ...keys.map(k => sample[k])];
    }),
  })) }));
  const packed = { source: { ...source, rounds }, schemas };
  const unpack = value => ({ ...value.source, rounds: value.source.rounds.map(round => ({ ...round,
    frames: round.frames.map(frame => ({ ...frame, players: frame.players.map(row =>
      Object.fromEntries(value.schemas[row[0]].map((key, i) => [key, row[i + 1]]))),
    })),
  })) });
  return { packed, unpack, details: { samples, schemas: schemas.length } };
}
async function regenerate(sourceValues, manifest) {
  const { ReplaySession } = await import('../apps/desktop/electron/replay-session.ts');
  const session = new ReplaySession(sourceValues['heatmap-match'], sourceValues['heatmap-replay'], randomUUID());
  const normalize = value => Buffer.from(JSON.stringify(value, (key, item) => key === 'sessionId' ? undefined : item));
  let same = 0, different = 0;
  for (const file of manifest.files.filter(f => f.role === 'replay-chunk')) {
    const json = session.chunks.get(`${file.round}:${file.block}`), raw = json ? normalize(JSON.parse(json)) : null;
    if (raw && raw.length === file.rawBytes && sha(raw) === file.sha256) same++; else different++;
  }
  const result = { generatedChunks: session.chunks.size, same, different,
    metadataByteExact: normalize(session.metadata).equals(normalize(sourceValues.report.replay)),
    byteExact: different === 0 && same === session.chunks.size };
  session.clear(); return result;
}

if (mode === 'capture') {
  assertFixture(input); assert.ok(existsSync(input));
  assert.equal(typeof global.gc, 'function', 'Capacity capture runs in an isolated Node process with explicitly documented GC');
  assert.ok(destination && !existsSync(destination), 'Capture result must not exist');
  const { createOwnedTempDirectory } = await import('./owned-qa-run.mjs');
  const { Demoparser2Provider } = await import('../packages/dem-parser/dist/index.js');
  const { buildDesktopReport } = await import('../apps/desktop/electron/report.ts');
  const { ReplaySession } = await import('../apps/desktop/electron/replay-session.ts');
  const { createHeatmapSession } = await import('../apps/desktop/electron/heatmap-session.ts');
  const { writeLibraryArchive, verifyLibraryArchive } = await import('../apps/desktop/electron/library-archive.ts');
  const owned = createOwnedTempDirectory('compression-capture'), directory = owned.directory;
  const archive = join(directory, 'archive');
  const { mkdirSync } = await import('node:fs'); mkdirSync(archive);
  const sourceHash = sha(readFileSync(input)), start = performance.now();
  const parsed = await new Demoparser2Provider().parseWithReplay(resolve(input));
  assert.equal(parsed.match.id, sourceHash); assert.ok(parsed.replay && parsed.spatial);
  const sessionId = randomUUID(), report = buildDesktopReport(parsed.match, input, parsed.spatial);
  const replay = new ReplaySession(parsed.match, parsed.replay, sessionId);
  global.gc(); // Measurement-only admission timing, not a production import latency claim.
  const heatmap = createHeatmapSession(parsed.match, parsed.replay, parsed.spatial, sessionId);
  assert.ok(heatmap.session && heatmap.metadata.available, 'Do not omit heatmap capabilities in a size comparison');
  report.replay = replay.metadata; report.heatmap = heatmap.metadata;
  const { execFileSync } = await import('node:child_process');
  const native = JSON.parse(readFileSync(new URL('../packages/demoparser-native/package.json', import.meta.url))).version;
  const receipt = await writeLibraryArchive(archive, { report, chunks: replay.chunks, match: parsed.match,
    replay: parsed.replay, spatial: parsed.spatial, versions: { application: '0.2.0', archive: 1, report: 2, replay: 1,
      analysis: 'current-production-capacity-audit', parser: 'current-dem-parser', native,
      sampling: replay.metadata.samplingVersion, mapResource: replay.metadata.resourceId,
      sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() } });
  const verified = await verifyLibraryArchive(archive);
  assert.equal(verified.manifestHash, receipt.manifestHash);
  save({ archive, fileName: basename(input), sha256: sourceHash, sourceBytes: statSync(input).size,
    rounds: parsed.match.rounds.length, storedBytes: receipt.storedBytes, elapsedMs: performance.now() - start,
    runtime: process.versions, explicitGcBeforeHeatmapAdmission: true });
  replay.clear(); heatmap.session.clear();
  console.log(JSON.stringify({ mode, fileName: basename(input), archive, storedBytes: receipt.storedBytes }));
} else if (mode === 'measure') {
  const directory = resolve(input); readOnlyOutput(directory);
  const manifestBytes = readFileSync(join(directory, 'manifest.json')), manifest = JSON.parse(manifestBytes);
  assert.equal(manifest.format, 'cs2-analyst-match'); assert.equal(manifest.schemaVersion, 1);
  assertFixture(manifest.summary.fileName);
  const stats = {}, trials = Object.fromEntries(Object.keys(codecs).map(k => [k, { total: emptyTotals(), roles: {} }]));
  const structure = {}, sourceValues = {}, follows = new Map();
  const followTrial = { originalBytes: 0, strippedBytes: 0, dictionariesBytes: 0, chunks: 0, uniqueFollows: 0 };
  const allStart = performance.now();
  for (const file of manifest.files) {
    assert.ok(/^((?:heatmap|replay)\/)?[a-zA-Z0-9._-]+\.json\.gz$/.test(file.path), 'Only manifest component paths are read');
    const compressed = readFileSync(join(directory, file.path));
    assert.equal(compressed.length, file.gzipBytes); assert.equal(sha(compressed), file.gzipSha256);
    const raw = zlib.gunzipSync(compressed, { maxOutputLength: 256 * 1024 * 1024 });
    assert.equal(raw.length, file.rawBytes); assert.equal(sha(raw), file.sha256);
    stats[file.role] ??= { files: 0, rawBytes: 0, gzipBytes: 0 };
    stats[file.role].files++; stats[file.role].rawBytes += raw.length; stats[file.role].gzipBytes += compressed.length;
    for (const codec of Object.keys(codecs)) {
      const result = encoded(raw, codec), trial = trials[codec];
      trial.roles[file.role] ??= emptyTotals(); accumulate(trial.total, result); accumulate(trial.roles[file.role], result);
      if (codec === 'gzip-6') assert.equal(result.bytes, compressed.length, 'Baseline must reproduce production size');
    }
    if (['report', 'heatmap-replay', 'heatmap-spatial', 'heatmap-match'].includes(file.role)) sourceValues[file.role] = JSON.parse(raw);
    if (file.role === 'heatmap-replay' || file.role === 'heatmap-spatial') {
      const value = JSON.parse(raw), transform = file.role === 'heatmap-replay' ? replayTuples(value) : spatialDictionary(value);
      const packed = bytes(transform.packed), decoded = transform.unpack(JSON.parse(packed));
      assert.ok(bytes(decoded).equals(raw), 'Structural prototype must restore every original JSON byte');
      structure[file.role] = { originalRawBytes: raw.length, originalGzipBytes: compressed.length,
        packedRawBytes: packed.length, byteExactRestore: true, ...transform.details,
        codecs: Object.fromEntries(['gzip-6', 'brotli-6'].map(codec => [codec, encoded(packed, codec)])) };
    }
    if (file.role === 'replay-chunk') {
      const chunk = JSON.parse(raw); followTrial.originalBytes += compressed.length; followTrial.chunks++;
      if (chunk.follow !== undefined) {
        const key = JSON.stringify(chunk.follow), id = sha(key);
        follows.set(id, key);
        const packed = { ...chunk, follow: { auditOnlyRef: id } };
        const restored = { ...packed, follow: JSON.parse(follows.get(id)) };
        assert.ok(bytes(restored).equals(raw), 'Shared follow must reconstruct every byte of each chunk');
        followTrial.strippedBytes += zlib.gzipSync(bytes(packed), { level: 6 }).length;
      } else followTrial.strippedBytes += compressed.length;
    }
  }
  for (const [id, value] of follows) followTrial.dictionariesBytes += zlib.gzipSync(bytes({ id, follow: JSON.parse(value) }), { level: 6 }).length;
  followTrial.uniqueFollows = follows.size;
  followTrial.packedPayloadBytes = followTrial.strippedBytes + followTrial.dictionariesBytes;
  followTrial.savedPayloadBytes = followTrial.originalBytes - followTrial.packedPayloadBytes;
  followTrial.extraManifestBytesEstimate = follows.size * 256; // Explicit planning estimate, not a frozen schema.
  // Regeneration is an experiment only; historical chunks are still retained by the app.
  const regeneration = process.env.CS2_AUDIT_REGENERATE === '1' ? await regenerate(sourceValues, manifest) : null;
  assert.ok(readFileSync(join(directory, 'manifest.json')).equals(manifestBytes), 'Input archive manifest changed during measurement');
  const payloadBytes = Object.values(stats).reduce((n, r) => n + r.gzipBytes, 0);
  const result = { schemaVersion: 1, purpose: 'Read-only capacity investigation; codec/structural results are not a deployable archive format',
    source: { fileName: manifest.summary.fileName, matchId: manifest.matchId, map: manifest.summary.map, rounds: manifest.summary.rounds,
      archiveSourceRevision: manifest.versions.sourceRevision, manifestSha256: sha(manifestBytes) },
    runtime: { versions: process.versions, platform: platform(), os: release(), cpu: cpus()[0]?.model },
    baseline: { manifestBytes: manifestBytes.length, payloadBytes, totalBytes: manifestBytes.length + payloadBytes, roles: stats },
    codecTrials: trials, structuralTrials: structure, followTrial, regeneration,
    elapsedMs: performance.now() - allStart, processResourceUsage: process.resourceUsage(),
    limits: ['One serial warm-cache run; timings are observations, not latency p95 or production SLAs',
      'Codec bytes are compressed member payloads; current manifest overhead is reported separately',
      'Structural candidates include their dictionary/schema headers but need a versioned archive manifest',
      'No codec installed-app/cold-restore or prototype peak-memory acceptance is implied',
      'No sampling reduction, numeric quantization, evidence pruning, DEM copying or live archive mutation'] };
  save(result);
  console.log(JSON.stringify({ mode, fileName: result.source.fileName, totalBytes: result.baseline.totalBytes,
    codecPayloadBytes: Object.fromEntries(Object.entries(trials).map(([k, v]) => [k, v.total.bytes])),
    structuralSavedBytes: Object.fromEntries(Object.entries(structure).map(([k, v]) => [k, v.originalGzipBytes - v.codecs['gzip-6'].bytes])),
    followSavedPayloadBytes: followTrial.savedPayloadBytes, regeneration }));
} else if (mode === 'regenerate') {
  readOnlyOutput(input);
  const manifest = JSON.parse(readFileSync(join(input, 'manifest.json'))); assertFixture(manifest.summary.fileName);
  assert.equal(manifest.format, 'cs2-analyst-match'); assert.equal(manifest.schemaVersion, 1);
  const sourceValues = {};
  for (const file of manifest.files.filter(f => ['report', 'heatmap-match', 'heatmap-replay'].includes(f.role))) {
    assert.ok(/^((?:heatmap|replay)\/)?[a-zA-Z0-9._-]+\.json\.gz$/.test(file.path));
    const compressed = readFileSync(join(input, file.path)); assert.equal(sha(compressed), file.gzipSha256);
    const raw = zlib.gunzipSync(compressed, { maxOutputLength: 256 * 1024 * 1024 }); assert.equal(sha(raw), file.sha256);
    sourceValues[file.role] = JSON.parse(raw);
  }
  const result = { fileName: manifest.summary.fileName, regeneration: await regenerate(sourceValues, manifest) };
  save(result); console.log(JSON.stringify(result));
} else throw new Error('Usage: node [--expose-gc] scripts/library-compression-audit.mjs capture <approved DEM> <new result.json> | measure|regenerate <archive directory> <new result.json>');
