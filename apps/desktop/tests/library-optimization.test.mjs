import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib';
import test from 'node:test';
import { createOwnedTempDirectory, assertOwnedDirectory } from '../../../scripts/owned-qa-run.mjs';
import { optimizationInput } from './library-optimization-fixture.mjs';
import { archiveCompressedBytes, loadLibraryArchive, readArchiveProjection, readArchiveChunk, readArchiveReport, readArchiveSources,
  readArchiveManifest, verifyLibraryArchive, validateArchiveManifest, writeLibraryArchive } from '../electron/library-archive.ts';
import { createReplayProjections, DerivedReplaySession, restoreProjectedChunk, DERIVED_REPLAY_CACHE_BYTES } from '../electron/library-derived-replay.ts';
const normalized = value => JSON.stringify(value, (key, item) => key === 'sessionId' ? undefined : item);
const hash = value => createHash('sha256').update(value).digest('hex');
async function owned(t) {
  const run = createOwnedTempDirectory('library-optimization-test');
  t.after(async () => { assertOwnedDirectory(run); await rm(run.directory, { recursive: true, force: true }); });
  return run.directory;
}
async function saved(t) {
  const root = await owned(t), directory = join(root, 'v2'); await mkdir(directory);
  const data = optimizationInput(); const receipt = await writeLibraryArchive(directory, data);
  return { root, directory, data, ...receipt };
}
test('v2 Brotli, tuples and round projections restore every source, metadata and block byte exactly', async t => {
  const { root, directory, data, manifest, storedBytes } = await saved(t);
  assert.equal(manifest.schemaVersion, 2); assert.equal(validateArchiveManifest(manifest), true);
  const old = join(root, 'v1'); await mkdir(old);
  const baseline = await writeLibraryArchive(old, { ...data, versions: { ...data.versions, archive: 1 } });
  assert.ok(storedBytes < baseline.storedBytes);
  assert.ok(manifest.files.every(f => f.codec === 'brotli' && !('gzipBytes' in f) && f.path.endsWith('.br')));
  assert.equal(manifest.files.filter(f => f.role === 'replay-chunk').length, 0);
  assert.deepEqual(await readArchiveSources(directory, manifest), { match: data.match, replay: data.replay, spatial: data.spatial });
  const loaded = await loadLibraryArchive(directory), sessionId = randomUUID();
  const report = await readArchiveReport(directory, manifest, sessionId);
  assert.equal(normalized(report), normalized(data.report));
  const session = new DerivedReplaySession(loaded.sources.replay, report.replay, round => readArchiveProjection(directory, manifest, round));
  for (const [key, json] of [...data.chunks].reverse()) {
    const [round, block] = key.split(':').map(Number), request = { sessionId, round, block };
    const chunk = await session.get(request);
    assert.equal(normalized(chunk), normalized(JSON.parse(json)));
    assert.equal(normalized(chunk), normalized(await readArchiveChunk(old, baseline.manifest, request)));
    assert.deepEqual(await session.get(request), chunk);
    assert.ok(session.bytes <= DERIVED_REPLAY_CACHE_BYTES);
  }
  session.clear(); assert.equal(session.bytes, 0); assert.equal(await session.get({ sessionId, round: 1, block: 0 }), null);
  assert.equal(storedBytes, Buffer.byteLength(JSON.stringify(manifest)) + manifest.files.reduce((n, f) => n + archiveCompressedBytes(f), 0));
  assert.deepEqual((await readdir(join(directory, 'replay'))), ['r1.json.br']);
});
test('projection decoder freezes text, names, effects, follow and block decisions independently of future UI code', () => {
  const data = optimizationInput(), projections = createReplayProjections(data.chunks), p = projections.get(1);
  assert.ok(p.blocks.length > 3);
  assert.equal(p.blocks[0].template.frames, null);
  assert.ok(p.blocks.some(b => b.template.utilities?.length));
  const first = p.blocks[0]; first.template.events[0].description = 'archived historical wording';
  assert.throws(() => restoreProjectedChunk(data.replay, p, first.template.block, randomUUID()), /digest/);
  const raw = normalized({ ...first.template, frames: JSON.parse(data.chunks.get('1:0')).frames, follow: p.follow });
  first.rawBytes = Buffer.byteLength(raw); first.sha256 = hash(raw);
  assert.equal(restoreProjectedChunk(data.replay, p, 0, randomUUID()).events[0].description, 'archived historical wording');
  let serialized;
  const restored = restoreProjectedChunk(data.replay, p, 0, randomUUID(), json => { serialized = json; });
  assert.equal(serialized, JSON.stringify(restored), 'cached JSON is the exact returned IPC object');
});
test('rapid seek supersedes pending work, release never caches or publishes stale work, loader failures recover', async () => {
  const data = optimizationInput(), projections = createReplayProjections(data.chunks);
  let unblock, reads = 0, fail = false;
  const session = new DerivedReplaySession(data.replay, data.report.replay, async round => {
    reads++; if (fail) throw new Error('I/O'); await new Promise(resolve => { unblock = resolve; }); return projections.get(round);
  });
  const request = block => ({ sessionId: data.report.replay.sessionId, round: 1, block });
  const first = session.get(request(0)); await new Promise(setImmediate);
  const next = session.get(request(1)); const latest = session.get(request(2));
  unblock(); assert.equal(await first, null); assert.equal(await next, null);
  await new Promise(setImmediate); unblock(); assert.ok(await latest); assert.equal(reads, 2);
  assert.equal(await session.pending, undefined, 'serialization tail never retains a decoded payload outside the LRU');
  const releasing = session.get(request(0)); await new Promise(setImmediate); session.clear(); unblock();
  assert.equal(await releasing, null); assert.equal(session.bytes, 0);
  assert.equal(await session.pending, undefined);
  const recovery = new DerivedReplaySession(data.replay, data.report.replay, async r => { if (fail) throw new Error('I/O'); return projections.get(r); });
  fail = true; await assert.rejects(recovery.get(request(0)), /I\/O/); fail = false; assert.ok(await recovery.get(request(0))); recovery.clear();
});
test('LRU uses exact serialized bytes and evicts; invalid sessions and unadvertised blocks never load', async () => {
  const data = optimizationInput(), projections = createReplayProjections(data.chunks);
  let reads = 0;
  // Large saved presentation context exercises byte pressure without relaxing the 1MiB chunk limit.
  const p = projections.get(1);
  for (const b of p.blocks) {
    const original = JSON.parse(data.chunks.get(`1:${b.template.block}`)); original.events.push({ id: 'padding', description: 'x'.repeat(800000) });
    data.chunks.set(`1:${b.template.block}`, JSON.stringify(original));
  }
  const big = createReplayProjections(data.chunks);
  const session = new DerivedReplaySession(data.replay, data.report.replay, async r => { reads++; return big.get(r); });
  const request = block => ({ sessionId: data.report.replay.sessionId, round: 1, block });
  assert.equal(await session.get({ ...request(0), sessionId: randomUUID() }), null);
  assert.equal(await session.get(request(999)), null); assert.equal(reads, 0);
  for (let i = 0; i < p.blocks.length; i++) { assert.ok(await session.get(request(i))); assert.ok(session.bytes <= DERIVED_REPLAY_CACHE_BYTES); }
  const before = reads; await session.get(request(0)); assert.equal(reads, before + 1); session.clear();
});
test('v2 rejects corruption, truncation, bombs, mixed encodings and projection/source mismatch', async t => {
  const { directory, manifest } = await saved(t);
  for (const change of [m => { m.files[0].codec = 'gzip'; }, m => { m.files[0].encoding = 'replay-tuples-v1'; },
    m => { m.files[0].gzipBytes = 1; }, m => { m.files[0].path = 'report.json.gz'; }, m => { m.versions.archive = 1; }]) {
    const copy = structuredClone(manifest); change(copy); assert.equal(validateArchiveManifest(copy), false);
  }
  const f = manifest.files.find(f => f.role === 'replay-projection'), path = join(directory, f.path), original = await readFile(path);
  await writeFile(path, original.subarray(0, original.length - 1)); await assert.rejects(verifyLibraryArchive(directory), /size/);
  const projection = JSON.parse(brotliDecompressSync(original)); projection.blocks[0].template.startTick++;
  const raw = Buffer.from(JSON.stringify(projection)), encoded = brotliCompressSync(raw);
  Object.assign(f, { rawBytes: raw.length, sha256: hash(raw), compressedBytes: encoded.length, compressedSha256: hash(encoded) });
  await writeFile(path, encoded); await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
  await assert.rejects(verifyLibraryArchive(directory), /projection/);
  const bomb = brotliCompressSync(Buffer.from('x'.repeat(1024 * 1024)));
  Object.assign(f, { rawBytes: 1, sha256: hash('x'), compressedBytes: bomb.length, compressedSha256: hash(bomb) });
  await writeFile(path, bomb); await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
  await assert.rejects(verifyLibraryArchive(directory), e => e.code === 'ERR_BUFFER_TOO_LARGE');
  const future = structuredClone(manifest); future.schemaVersion = 3;
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(future));
  await assert.rejects(readArchiveManifest(directory), { code: 'ARCHIVE_UNSUPPORTED' });
});

test('retained import context and Chunk LRU share the original 64MiB serialized session ceiling', async () => {
  const data = optimizationInput(), projections = createReplayProjections(data.chunks);
  let reads = 0;
  const session = new DerivedReplaySession(data.replay, data.report.replay, async round => { reads++; return projections.get(round); },
    { retainedContextBytes: 64 * 1024 * 1024 - 100 });
  const request = { sessionId: data.report.replay.sessionId, round: 1, block: 0 };
  assert.ok(await session.get(request)); assert.ok(await session.get(request));
  assert.equal(reads, 2); assert.equal(session.bytes, 0, 'An oversized cache entry is skipped without losing the response');
  assert.ok(session.contextBytes + session.bytes <= 64 * 1024 * 1024);
  session.clear(); assert.equal(session.contextBytes, 0); assert.equal(session.bytes, 0);
  for (const retainedContextBytes of [-1, NaN, 64 * 1024 * 1024 + 1]) assert.throws(() => new DerivedReplaySession(data.replay, data.report.replay,
    async round => projections.get(round), { retainedContextBytes }), /context budget/);
});
