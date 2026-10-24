// Explicit Buffer.equals evidence for an owned four-fixture storage benchmark run.
// node scripts/library-storage-byte-equivalence.mjs <owned-benchmark-run.json>
// Does not parse/read a DEM, open a catalogue, or write into the input run.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gunzip as gunzipCallback } from 'node:zlib';
import { assertOwnedDirectory, assertOwnedPath, createOwnedTempDirectory } from './owned-qa-run.mjs';

const here = fileURLToPath(import.meta.url), repository = resolve(dirname(here), '..');
const fixtures = ['demo1.dem', 'demo2.dem', 'dust2.dem', 'nuke.dem'];
const gunzip = promisify(gunzipCallback);
const hash = value => createHash('sha256').update(value).digest('hex');
const normalizedBytes = value => Buffer.from(JSON.stringify(value,
  (key, item) => key === 'sessionId' ? undefined : item), 'utf8');
const samePath = (a, b) => process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);

function smallJson(path) {
  const info = statSync(path);
  assert.ok(info.isFile() && info.size > 0 && info.size <= 1024 * 1024, 'Bounded JSON input required');
  return JSON.parse(readFileSync(path, 'utf8'));
}
function sourceConfig(path) {
  const absolute = resolve(path);
  assert.equal(basename(absolute), 'run.json', 'Use the benchmark run.json');
  const config = smallJson(absolute);
  assertOwnedDirectory(config.owner);
  assert.ok(samePath(absolute, join(config.owner.directory, 'run.json')), 'Run must belong to its marked directory');
  assert.ok(samePath(config.repository, repository), 'Run must belong to this repository');
  assert.notEqual(config.synthetic, true, 'Real four-fixture archives required');
  assert.ok(Array.isArray(config.fixtures) && config.fixtures.length === fixtures.length
    && new Set(config.fixtures).size === fixtures.length && fixtures.every(name => config.fixtures.includes(name)),
  'Expected exactly the four permitted fixture identities');
  return config;
}
function save(owner, path, value) {
  assertOwnedPath(owner, path);
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
}
function memoryRecorder() {
  const initial = process.memoryUsage(), peakObserved = { ...initial };
  const snapshot = () => {
    const value = process.memoryUsage();
    for (const key of Object.keys(peakObserved)) peakObserved[key] = Math.max(peakObserved[key], value[key]);
    return value;
  };
  return { snapshot, finish() {
    const final = snapshot();
    return { unit: 'bytes', initial, final, peakObserved,
      processLifetimeMaxRssBytes: process.resourceUsage().maxRSS * 1024,
      scope: 'Independent bundled Electron run-as-node equality checker; not production GUI performance',
      explicitGc: false, note: 'Snapshots are checkpoints; external includes ArrayBuffers and is not additive to arrayBuffers.' };
  } };
}

/** Read only a validated old member, with fixed allocations and the original path/link protections. */
async function oldRaw(directory, member, archive) {
  assert.ok('gzipBytes' in member && 'gzipSha256' in member, 'Expected an old gzip member');
  const target = join(directory, ...member.path.split('/'));
  await archive.assertArchiveDirectory(directory, dirname(target));
  const before = await lstat(target);
  assert.ok(before.isFile() && !before.isSymbolicLink() && before.nlink === 1
    && before.size === member.gzipBytes && before.size <= archive.LIBRARY_ARCHIVE_LIMITS.componentBytes, 'Unsafe or changed gzip member');
  assert.ok(samePath(await realpath(target), join(await realpath(dirname(target)), basename(target))), 'Redirected gzip member');
  const handle = await open(target, 'r');
  let compressed;
  try {
    const opened = await handle.stat();
    assert.ok(opened.isFile() && opened.ino === before.ino && opened.dev === before.dev && opened.size === before.size, 'Gzip member changed before read');
    const buffer = Buffer.alloc(member.gzipBytes + 1);
    let count = 0;
    while (count < buffer.length) {
      const { bytesRead } = await handle.read(buffer, count, buffer.length - count, count);
      count += bytesRead; if (!bytesRead) break;
    }
    assert.equal(count, member.gzipBytes, 'Gzip member changed during read');
    compressed = buffer.subarray(0, count);
  } finally { await handle.close(); }
  assert.ok(hash(compressed) === member.gzipSha256, 'Old compressed digest mismatch');
  const raw = await gunzip(compressed, { maxOutputLength: member.rawBytes });
  assert.ok(raw.length === member.rawBytes && hash(raw) === member.sha256, 'Old raw digest or size mismatch');
  return raw;
}

async function checkOne(configPath, outputOwner, name) {
  assert.ok(process.versions.electron && process.env.ELECTRON_RUN_AS_NODE === '1', 'Use the bundled Electron runtime');
  assert.equal(typeof global.gc, 'undefined', 'Explicit GC is not permitted');
  assert.ok(fixtures.includes(name), 'Unknown fixture identity');
  assertOwnedDirectory(outputOwner);
  const config = sourceConfig(configPath), memory = memoryRecorder();
  const base = assertOwnedPath(config.owner, join(config.owner.directory, name.replace(/\.dem$/, '')));
  const v1 = assertOwnedPath(config.owner, join(base, 'v1')), v2 = assertOwnedPath(config.owner, join(base, 'v2'));
  const archive = await import('../apps/desktop/electron/library-archive.ts');
  const derived = await import('../apps/desktop/electron/library-derived-replay.ts');
  let phase = 'load';
  try {
    // Verify old compressed inventory without constructing any old canonical source tree.
    const original = await archive.verifyLibraryArchive(v1, { mode: 'compressed' });
    assert.equal(original.manifest.schemaVersion, 1);
    let loaded = await archive.loadLibraryArchive(v2);
    assert.equal(loaded.manifest.schemaVersion, 2);
    assert.ok(loaded.report && loaded.sources && loaded.sources.replay, 'Complete restored sources required');
    assert.equal(original.manifest.matchId, loaded.manifest.matchId, 'Paired archives must have the same DEM SHA');
    assert.equal(original.manifest.summary.fileName, name);
    assert.equal(loaded.manifest.summary.fileName, name);
    const sourceSha256 = loaded.manifest.matchId, manifest = loaded.manifest;
    let sources = loaded.sources;
    const metadata = { ...loaded.report.replay, sessionId: randomUUID() };
    assert.ok(metadata.available, 'Replay must remain available');
    const members = original.manifest.files;
    const required = role => {
      const found = members.filter(member => member.role === role);
      assert.equal(found.length, 1, `Expected one old ${role} member`); return found[0];
    };
    const roles = {};
    let metadataResult;
    memory.snapshot();

    phase = 'report';
    {
      const raw = await oldRaw(v1, required('report'), archive);
      const bytes = normalizedBytes(loaded.report);
      assert.ok(bytes.equals(raw), 'Full report Buffer.equals failed');
      roles.report = { bytes: raw.length, bufferEquals: true };
      // Report is small. Parse it only to make the metadata claims explicit.
      const oldReport = JSON.parse(raw.toString('utf8'));
      const replayBytes = normalizedBytes(loaded.report.replay), heatmapBytes = normalizedBytes(loaded.report.heatmap);
      assert.ok(replayBytes.equals(normalizedBytes(oldReport.replay)), 'Replay metadata Buffer.equals failed');
      assert.ok(heatmapBytes.equals(normalizedBytes(oldReport.heatmap)), 'Heatmap metadata Buffer.equals failed');
      metadataResult = { replay: { bytes: replayBytes.length, bufferEquals: true },
        heatmap: { bytes: heatmapBytes.length, bufferEquals: true } };
    }
    loaded.report = null;
    memory.snapshot();
    // Each helper returns only byte counts. Old raw/new JSON buffers are not retained
    // between sources; Spatial is released before the Replay comparison and seeks.
    for (const [role, property] of [['heatmap-match', 'match'], ['heatmap-spatial', 'spatial'], ['heatmap-replay', 'replay']]) {
      phase = role;
      roles[role] = await (async () => {
        const raw = await oldRaw(v1, required(role), archive), bytes = normalizedBytes(sources[property]);
        assert.ok(bytes.equals(raw), `Full ${role} Buffer.equals failed`);
        memory.snapshot(); return { bytes: raw.length, bufferEquals: true };
      })();
      if (property !== 'replay') sources[property] = null;
      memory.snapshot();
    }
    let replaySource = sources.replay;
    loaded.sources = null; sources = null; loaded = null;
    const session = new derived.DerivedReplaySession(replaySource, metadata,
      round => archive.readArchiveProjection(v2, manifest, round));
    replaySource = null;
    let chunks = 0, chunkRawBytes = 0, cachePeakBytes = 0;
    phase = 'chunks-reverse-order';
    try {
      const blocks = members.filter(member => member.role === 'replay-chunk')
        .sort((a, b) => b.round - a.round || b.block - a.block);
      assert.equal(blocks.length, metadata.rounds.reduce((sum, round) => sum + round.blocks.length, 0), 'Block inventory mismatch');
      for (const member of blocks) {
        const chunk = await session.get({ sessionId: metadata.sessionId, round: member.round, block: member.block });
        assert.ok(chunk, 'Missing regenerated block');
        assert.ok(Buffer.byteLength(JSON.stringify(chunk)) <= archive.LIBRARY_ARCHIVE_LIMITS.chunkBytes, 'UI Chunk budget exceeded');
        const raw = await oldRaw(v1, member, archive), bytes = normalizedBytes(chunk);
        assert.ok(bytes.equals(raw), 'Whole regenerated Chunk Buffer.equals failed');
        assert.ok(session.bytes <= derived.DERIVED_REPLAY_CACHE_BYTES, 'Derived LRU budget exceeded');
        cachePeakBytes = Math.max(cachePeakBytes, session.bytes); chunks++; chunkRawBytes += raw.length;
        if (chunks % 16 === 0) memory.snapshot();
      }
    } finally { session.clear(); }
    assert.equal(session.bytes, 0, 'Release must empty the LRU');
    const result = { schemaVersion: 1, fixture: name, sourceSha256, roles, metadata: metadataResult,
      chunks: { count: chunks, rawBytes: chunkRawBytes, order: 'reverse round/block', bufferEquals: true },
      budgets: { chunkBytes: archive.LIBRARY_ARCHIVE_LIMITS.chunkBytes,
        cacheLimitBytes: derived.DERIVED_REPLAY_CACHE_BYTES, cachePeakBytes, cacheAfterReleaseBytes: session.bytes, passed: true },
      explicitBufferEquals: true, readDem: false, runtime: process.versions, memory: memory.finish() };
    save(outputOwner, join(outputOwner.directory, name.replace(/\.dem$/, '') + '.json'), result);
    console.log(JSON.stringify({ fixture: name, bufferEquals: true, roles: Object.keys(roles).length, chunks }));
  } catch (error) {
    // Never print JSON parser snippets, Buffer diffs, report contents or player data.
    save(outputOwner, join(outputOwner.directory, name.replace(/\.dem$/, '') + '-failure.json'), {
      schemaVersion: 1, fixture: name, phase, passed: false,
      errorName: error?.name ?? 'Error', errorCode: typeof error?.code === 'string' ? error.code : null,
      runtime: process.versions, memory: memory.finish() });
    process.exitCode = 1;
    console.error(JSON.stringify({ fixture: name, phase, passed: false }));
  }
}

async function run(configPath) {
  sourceConfig(configPath);
  const owner = createOwnedTempDirectory('storage-byte-equivalence');
  console.log(JSON.stringify({ outputDirectory: owner.directory }));
  const require = createRequire(join(repository, 'apps/desktop/package.json')), electron = require('electron');
  for (const name of fixtures) {
    await new Promise((resolveChild, reject) => {
      const child = spawn(electron, [here, '--child', resolve(configPath), JSON.stringify(owner), name], {
        cwd: repository, windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', chunk => process.stdout.write(chunk));
      // Child writes a safe failure record; unexpected runtime diagnostics may contain
      // paths or parser snippets and are deliberately not forwarded as evidence.
      child.stderr.resume();
      child.on('error', () => reject(new Error('Could not start bundled Electron equality checker')));
      child.on('exit', code => code === 0 ? resolveChild() : reject(new Error(`Equality check failed for ${name}; inspect owned failure record`)));
    });
  }
  const results = fixtures.map(name => smallJson(assertOwnedPath(owner,
    join(owner.directory, name.replace(/\.dem$/, '') + '.json'))));
  save(owner, join(owner.directory, 'results.json'), { schemaVersion: 1, explicitBufferEquals: true, results });
  console.log(JSON.stringify({ success: true, output: join(owner.directory, 'results.json') }));
}

try {
  const [modeOrConfig, ...args] = process.argv.slice(2);
  if (modeOrConfig === '--child') {
    assert.equal(args.length, 3, 'Internal child arguments required');
    await checkOne(args[0], JSON.parse(args[1]), args[2]);
  } else {
    assert.ok(modeOrConfig && args.length === 0, 'Usage: node scripts/library-storage-byte-equivalence.mjs <owned-benchmark-run.json>');
    await run(modeOrConfig);
  }
} catch {
  console.error('Byte equivalence checker failed; no payload data was printed.');
  process.exitCode = 1;
}
