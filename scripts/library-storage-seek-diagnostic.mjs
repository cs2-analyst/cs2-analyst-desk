// Read-only CPU/I/O decomposition; run after the serial benchmark, never concurrently.
// node scripts/library-storage-seek-diagnostic.mjs <owned-run.json> <demo1.dem|demo2.dem|dust2.dem|nuke.dem>
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { brotliDecompressSync } from 'node:zlib';
import { performance } from 'node:perf_hooks';
import { assertOwnedDirectory, assertOwnedPath } from './owned-qa-run.mjs';
import { quantiles } from './library-spike-core.mjs';

const here = fileURLToPath(import.meta.url), repository = resolve(dirname(here), '..');
const [configPath, name, child] = process.argv.slice(2);
const config = JSON.parse(readFileSync(resolve(configPath), 'utf8'));
assertOwnedDirectory(config.owner);
assert.equal(resolve(configPath), join(config.owner.directory, 'run.json'));
assert.equal(config.repository, repository);
assert.ok(['demo1.dem', 'demo2.dem', 'dust2.dem', 'nuke.dem', ...(config.synthetic ? ['synthetic'] : [])].includes(name));
assert.ok(config.fixtures.includes(name));
const directory = assertOwnedPath(config.owner, join(config.owner.directory, name.replace(/\.dem$/, ''), 'v2'));
if (child !== '$child') {
  const require = createRequire(join(repository, 'apps/desktop/package.json'));
  await new Promise((accept, reject) => {
    const process = spawn(require('electron'), [here, resolve(configPath), name, '$child'], { cwd: repository,
      windowsHide: true, env: { ...globalThis.process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'inherit', 'inherit'] });
    process.on('error', reject);
    process.on('exit', code => code === 0 ? accept() : reject(new Error(`Seek diagnostic failed (${code})`)));
  });
} else {
  assert.ok(process.versions.electron && process.env.ELECTRON_RUN_AS_NODE === '1');
  assert.equal(typeof global.gc, 'undefined');
  const archive = await import('../apps/desktop/electron/library-archive.ts');
  const { restoreProjectedChunk, DerivedReplaySession } = await import('../apps/desktop/electron/library-derived-replay.ts');
  const oldRevision = 'a691553';
  const oldPath = assertOwnedPath(config.owner, join(config.owner.directory, `old-derived-${randomUUID()}.mts`));
  writeFileSync(oldPath, execFileSync('git', ['show', `${oldRevision}:apps/desktop/electron/library-derived-replay.ts`], {
    cwd: repository, encoding: 'utf8', windowsHide: true }), { flag: 'wx' });
  const old = await import(pathToFileURL(oldPath).href);
  const loaded = await archive.loadLibraryArchive(directory);
  assert.equal(loaded.manifest.schemaVersion, 2);
  const metadata = { ...loaded.report.replay, sessionId: randomUUID() };
  const arrays = Object.fromEntries(['productionProjectionRead', 'directRead', 'compressedSha', 'brotliDecode', 'jsonParse',
    'restoreIncludingHash', 'oldRestoreIncludingHash', 'finalStringify', 'cachedProjectionSessionMiss', 'oldCachedProjectionSessionMiss', 'chunkCacheHit'].map(name => [name, []]));
  const sizes = loaded.manifest.files.filter(file => file.role === 'replay-projection')
    .map(file => ({ round: file.round, rawBytes: file.rawBytes, compressedBytes: archive.archiveCompressedBytes(file) }));
  const samples = [];
  const requests = metadata.rounds.flatMap(round => round.blocks.map(block => ({ sessionId: metadata.sessionId, round: round.round, block: block.index })));
  let seed = 0x2c52a;
  for (let i = requests.length - 1; i > 0; i--) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; const j = seed % (i + 1); [requests[i], requests[j]] = [requests[j], requests[i]]; }
  const measured = async (name, action) => { const start = performance.now(), value = await action(); const ms = performance.now() - start; arrays[name].push(ms); return { value, ms }; };
  for (let trial = 0; trial < 3; trial++) for (const request of requests) {
    const file = loaded.manifest.files.find(file => file.role === 'replay-projection' && file.round === request.round);
    const production = await measured('productionProjectionRead', () => archive.readArchiveProjection(directory, loaded.manifest, request.round));
    const target = assertOwnedPath(config.owner, join(directory, file.path));
    assert.equal((await stat(target)).size, archive.archiveCompressedBytes(file));
    const direct = await measured('directRead', () => readFile(target));
    const digest = await measured('compressedSha', () => createHash('sha256').update(direct.value).digest('hex'));
    assert.equal(digest.value, archive.archiveCompressedHash(file));
    const decompressed = await measured('brotliDecode', () => brotliDecompressSync(direct.value, { maxOutputLength: file.rawBytes }));
    assert.equal(decompressed.value.length, file.rawBytes);
    const parsed = await measured('jsonParse', () => JSON.parse(decompressed.value.toString('utf8')));
    const restored = await measured('restoreIncludingHash', () => restoreProjectedChunk(loaded.sources.replay, production.value, request.block, request.sessionId));
    const oldRestored = await measured('oldRestoreIncludingHash', () => old.restoreProjectedChunk(loaded.sources.replay, production.value, request.block, request.sessionId));
    const serialized = await measured('finalStringify', () => JSON.stringify(restored.value));
    assert.equal(serialized.value, JSON.stringify(oldRestored.value), 'Optimization must preserve the complete chunk JSON');
    const session = new DerivedReplaySession(loaded.sources.replay, metadata, async () => parsed.value);
    await measured('cachedProjectionSessionMiss', () => session.get(request));
    await measured('chunkCacheHit', () => session.get(request));
    session.clear();
    const oldSession = new old.DerivedReplaySession(loaded.sources.replay, metadata, async () => parsed.value);
    await measured('oldCachedProjectionSessionMiss', () => oldSession.get(request));
    oldSession.clear();
    samples.push({ trial, round: request.round, block: request.block, rawBytes: file.rawBytes,
      compressedBytes: archive.archiveCompressedBytes(file), productionReadMs: production.ms, restoreMs: restored.ms });
  }
  const output = assertOwnedPath(config.owner, join(config.owner.directory, `seek-diagnostic-${name}-${randomUUID()}.json`));
  writeFileSync(output, JSON.stringify({ schemaVersion: 1, name, runtime: process.versions, oldRevision, samples, sizes,
    quantilesMs: Object.fromEntries(Object.entries(arrays).map(([name, values]) => [name, quantiles(values)])),
    interpretation: 'Diagnostic only, after full archive validation. Production projection read includes all directory/file/digest/output protections; direct read/decode timings are separate warmer reads and cannot be subtracted as exact safety-check cost. cachedProjectionSessionMiss isolates DerivedReplaySession CPU with a supplied in-memory projection, without proposing an unbounded production cache. No GC, no disk writes inside archive, no GUI latency claim.' }, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ output }));
}
