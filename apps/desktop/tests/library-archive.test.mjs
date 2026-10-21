import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { fixture, map } from './heatmap-fixture.mjs';
import { ReplaySession } from '../electron/replay-session.ts';
import { createHeatmapSession } from '../electron/heatmap-session.ts';
import { assertArchiveDirectory, archiveManifestHash, LIBRARY_ARCHIVE_LIMITS, readArchiveChunk, readArchiveManifest,
  readArchiveReport, readArchiveSources, validateArchiveManifest, verifyLibraryArchive, writeLibraryArchive } from '../electron/library-archive.ts';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const versions = { application: '0.1.0', archive: 1, report: 2, replay: 1, parser: 'demoparser2-v0.42', native: '0.42.0-backport.363.1',
  analysis: 'analytics-v1/findings-v2/deep-review-v1/heatmap-p7.1-v1', sampling: 'test', mapResource: 'test', sourceRevision: 'a'.repeat(40) };
function input() {
  const f = fixture(), matchId = digest('synthetic fixture, not a real DEM');
  f.match.id = matchId; f.replay.matchId = matchId; f.spatial.matchId = matchId;
  f.match.players.forEach((player, index) => { player.nickname = `玩家${index}`; player.team = index ? 'T' : 'CT'; });
  const sessionId = randomUUID(), replay = new ReplaySession(f.match, f.replay, sessionId);
  const heatmap = createHeatmapSession(f.match, f.replay, f.spatial, sessionId, { map });
  assert.ok(heatmap.session);
  const report = { schemaVersion: 2, match: { id: matchId, fileName: 'dust2.dem', map: f.match.map, rounds: f.match.rounds.length, score: null },
    selectedPlayer: f.match.players[0].steamId, players: f.match.players.map(p => ({ id: p.steamId, nickname: p.nickname })),
    analytics: [], findings: [], timeline: [], analysis: { players: [], perPlayer: [] }, deepReview: { available: true, players: [] },
    replay: replay.metadata, heatmap: heatmap.metadata };
  return { ...f, report, chunks: replay.chunks, versions: { ...versions } };
}
async function ownedDirectory(t) {
  const root = await mkdtemp(join(tmpdir(), 'cs2-library-archive-'));
  t.after(async () => {
    const target = resolve(root), rel = relative(resolve(tmpdir()), target);
    assert.ok(rel && !rel.startsWith(`..${sep}`) && basename(target).startsWith('cs2-library-archive-'));
    await rm(target, { recursive: true, force: true });
  });
  const directory = join(root, 'archive'); await mkdir(directory);
  return { root, directory };
}
async function saved(t) {
  const paths = await ownedDirectory(t), data = input();
  const receipt = await writeLibraryArchive(paths.directory, data);
  return { ...paths, data, ...receipt };
}
async function replacePayload(directory, manifest, role, value) {
  const file = manifest.files.find(file => file.role === role), raw = Buffer.from(JSON.stringify(value)), encoded = gzipSync(raw, { level: 6 });
  Object.assign(file, { rawBytes: raw.length, gzipBytes: encoded.length, sha256: digest(raw), gzipSha256: digest(encoded) });
  await writeFile(join(directory, file.path), encoded);
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
}

test('archive v1 persists complete canonical sources and all chunks without temporary session handles', async t => {
  const { directory, data, manifest, manifestHash, storedBytes } = await saved(t);
  assert.equal(validateArchiveManifest(manifest), true);
  assert.deepEqual(await readArchiveManifest(directory), manifest);
  assert.equal(archiveManifestHash(manifest), manifestHash);
  assert.equal(manifest.files.length, 4 + data.chunks.size);
  assert.equal(manifest.capabilities.heatmap.status, 'available');
  for (const file of manifest.files) {
    const raw = gunzipSync(await readFile(join(directory, file.path)));
    assert.equal(raw.includes('"sessionId"'), false);
    assert.equal(raw.includes('filePath'), false);
    assert.equal(digest(raw), file.sha256);
  }
  assert.equal(storedBytes, (await stat(join(directory, 'manifest.json'))).size + manifest.files.reduce((n, file) => n + file.gzipBytes, 0));
  assert.deepEqual(await verifyLibraryArchive(directory), { manifest, manifestHash, storedBytes });
  assert.deepEqual(await verifyLibraryArchive(directory, { mode: 'compressed' }), { manifest, manifestHash, storedBytes });
  assert.deepEqual(await readArchiveSources(directory, manifest), { match: data.match, replay: data.replay, spatial: data.spatial });
});

test('fresh report/chunk session handles preserve report metrics, guards, effects and follow evidence', async t => {
  const { directory, data, manifest } = await saved(t), next = randomUUID();
  const report = await readArchiveReport(directory, manifest, next);
  assert.equal(report.replay.sessionId, next); assert.equal(report.heatmap.sessionId, next);
  assert.deepEqual(report.analytics, data.report.analytics); assert.deepEqual(report.timeline, data.report.timeline);
  const original = JSON.parse(data.chunks.get('1:0')), restored = await readArchiveChunk(directory, manifest, { sessionId: next, round: 1, block: 0 });
  assert.deepEqual(restored, { ...original, sessionId: next });
  assert.ok(Buffer.byteLength(JSON.stringify(restored)) <= 1024 * 1024);
  await assert.rejects(readArchiveReport(directory, manifest, 'old-session'), /request/);
  await assert.rejects(readArchiveChunk(directory, manifest, { sessionId: next, round: 1, block: 99 }), /unknown replay chunk/);
});

test('source absence is honestly retained; event-only Heatmap can remain partial and report stays usable', async t => {
  const { directory } = await ownedDirectory(t), data = input();
  data.replay = null; data.chunks.clear();
  data.report.replay.available = false; data.report.replay.rounds = []; data.report.replay.unavailableReason = 'replay-unavailable';
  data.report.heatmap.layers.positions = { available: false, unavailableReason: 'replay-unavailable' };
  const { manifest } = await writeLibraryArchive(directory, data);
  assert.equal(manifest.capabilities.replay.status, 'unavailable'); assert.equal(manifest.capabilities.heatmap.status, 'partial');
  assert.equal((await readArchiveSources(directory, manifest)).replay, null);
  await verifyLibraryArchive(directory);
  const report = await readArchiveReport(directory, manifest, randomUUID());
  assert.equal(report.replay.sessionId, null); assert.equal(report.heatmap.layers.kills.available, true);
});

test('writer refuses capability claims lacking canonical sources and does not publish manifest', async t => {
  const { directory } = await ownedDirectory(t), data = input(); data.replay = null;
  await assert.rejects(writeLibraryArchive(directory, data), /source/);
  await assert.rejects(stat(join(directory, 'manifest.json')), { code: 'ENOENT' });
});

test('compressed corruption, truncation and missing components fail both verification modes', async t => {
  const { directory, manifest } = await saved(t), file = manifest.files[0], target = join(directory, file.path), encoded = await readFile(target);
  const changed = Buffer.from(encoded); changed[changed.length - 1] ^= 1; await writeFile(target, changed);
  await assert.rejects(verifyLibraryArchive(directory), /digest/);
  await assert.rejects(verifyLibraryArchive(directory, { mode: 'compressed' }), /digest/);
  await writeFile(target, encoded.subarray(0, encoded.length - 1));
  await assert.rejects(verifyLibraryArchive(directory), /size/);
  await rm(target);
  await assert.rejects(verifyLibraryArchive(directory), /missing archive member/);
});

test('recomputed digests cannot disguise another match report, chunk or canonical source', async t => {
  const { directory, manifest, data } = await saved(t);
  const report = JSON.parse(gunzipSync(await readFile(join(directory, 'report.json.gz'))));
  report.match.id = 'f'.repeat(64); await replacePayload(directory, manifest, 'report', report);
  await assert.rejects(verifyLibraryArchive(directory), /identity/);
  delete report.replay.sessionId; report.match.id = manifest.matchId; await replacePayload(directory, manifest, 'report', report);
  const chunk = JSON.parse(data.chunks.get('1:0')); delete chunk.sessionId; chunk.block = 2;
  await replacePayload(directory, manifest, 'replay-chunk', chunk);
  await assert.rejects(verifyLibraryArchive(directory), /identity/);
  chunk.block = 0; await replacePayload(directory, manifest, 'replay-chunk', chunk);
  const source = structuredClone(data.match); source.id = 'c'.repeat(64);
  await replacePayload(directory, manifest, 'heatmap-match', source);
  await assert.rejects(verifyLibraryArchive(directory), /Match source/);
});

test('metadata must advertise exactly the saved Replay chunks and capability flags must agree', async t => {
  const { directory, manifest } = await saved(t);
  const report = JSON.parse(gunzipSync(await readFile(join(directory, 'report.json.gz'))));
  report.replay.rounds[0].blocks[0].index = 8; await replacePayload(directory, manifest, 'report', report);
  await assert.rejects(verifyLibraryArchive(directory), /catalogue mismatch/);
  report.replay.rounds[0].blocks[0].index = 0; await replacePayload(directory, manifest, 'report', report);
  manifest.capabilities.replay = { status: 'unavailable', reason: 'fake' };
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
  await assert.rejects(verifyLibraryArchive(directory), /capability/);
});

test('decompression uses declared bounded output before JSON parsing', async t => {
  const { directory, manifest } = await saved(t), file = manifest.files.find(f => f.role === 'heatmap-replay');
  const encoded = gzipSync(Buffer.from('x'.repeat(2 * 1024 * 1024)));
  Object.assign(file, { rawBytes: 1, gzipBytes: encoded.length, gzipSha256: digest(encoded), sha256: digest('x') });
  await writeFile(join(directory, file.path), encoded); await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
  await assert.rejects(verifyLibraryArchive(directory), error => error.code === 'ERR_BUFFER_TOO_LARGE');
});

test('strict manifest rejects traversal, absolute paths, duplicates, unsupported schema and unknown keys', async t => {
  const { manifest } = await saved(t);
  for (const mutate of [
    m => { m.files[0].path = '../report.json.gz'; }, m => { m.files[0].path = 'C:/report.json.gz'; },
    m => { m.files.push(structuredClone(m.files[0])); }, m => { m.schemaVersion = 2; }, m => { m.versions.report = 3; },
    m => { m.files[0].url = 'https://example.invalid'; }, m => { m.extra = true; }, m => { m.summary.fileName = 'C:\\private\\dust2.dem'; },
    m => { m.createdAt = '2026-02-31T00:00:00.000Z'; }, m => { m.summary.players.push(m.summary.players[0]); },
    m => { m.versions.sourceRevision = 'main'; }, m => { m.capabilities.report = { status: 'partial', reason: null }; },
  ]) { const copy = structuredClone(manifest); mutate(copy); assert.equal(validateArchiveManifest(copy), false); }
});

test('file count, per-file size, total raw/compressed and Replay total budgets are enforced before reads', async t => {
  const { manifest } = await saved(t), checks = [
    m => { m.files[0].rawBytes = LIBRARY_ARCHIVE_LIMITS.reportBytes + 1; },
    m => { m.files[0].rawBytes = Number.NaN; }, m => { m.files[0].gzipBytes = -1; },
    m => { m.files[1].rawBytes = LIBRARY_ARCHIVE_LIMITS.componentBytes + 1; },
    m => { m.files[1].rawBytes = LIBRARY_ARCHIVE_LIMITS.componentBytes; m.files[2].rawBytes = LIBRARY_ARCHIVE_LIMITS.componentBytes; },
    m => { m.files[1].gzipBytes = LIBRARY_ARCHIVE_LIMITS.totalGzipBytes; },
    m => { const file = m.files.find(f => f.role === 'replay-chunk'); m.files = m.files.filter(f => f.role !== 'replay-chunk');
      for (let i = 0; i < 65; i++) m.files.push({ ...file, path: `replay/r1-b${i}.json.gz`, block: i, rawBytes: 1024 * 1024 }); },
    // The permanent bytes fit 64MiB, but temporary session handles must fit too.
    m => { const file = m.files.find(f => f.role === 'replay-chunk'); m.files = m.files.filter(f => f.role !== 'replay-chunk');
      for (let i = 0; i < 64; i++) m.files.push({ ...file, path: `replay/r1-b${i}.json.gz`, block: i, rawBytes: 1024 * 1024 }); },
    m => { const file = m.files.find(f => f.role === 'replay-chunk'); m.files = m.files.filter(f => f.role !== 'replay-chunk');
      for (let i = 0; i < 4093; i++) m.files.push({ ...file, path: `replay/r1-b${i}.json.gz`, block: i, rawBytes: 1, gzipBytes: 1 }); },
  ];
  for (const mutate of checks) { const copy = structuredClone(manifest); mutate(copy); assert.equal(validateArchiveManifest(copy), false); }
});

test('root and component junctions cannot escape the archive directory', async t => {
  const { root, directory, manifest } = await saved(t), outside = join(root, 'outside'); await mkdir(outside);
  const redirected = join(root, 'redirected'); await symlink(directory, redirected, 'junction');
  await assert.rejects(assertArchiveDirectory(root, redirected), /unsafe archive directory|redirected/);
  await assert.rejects(readArchiveManifest(redirected), /unsafe archive directory|redirected/);
  const heatmap = join(directory, 'heatmap'), held = join(root, 'held');
  await mkdir(held); const file = manifest.files.find(f => f.role === 'heatmap-match');
  await writeFile(join(outside, 'match.json.gz'), await readFile(join(directory, file.path)));
  await rm(heatmap, { recursive: true }); await symlink(outside, heatmap, 'junction');
  await assert.rejects(verifyLibraryArchive(directory), /unsafe|symlink/);
});

test('unlisted files and nested directories cannot ride along with a valid archive', async t => {
  const { directory } = await saved(t); await writeFile(join(directory, 'script.sql'), 'DROP TABLE matches;');
  await assert.rejects(verifyLibraryArchive(directory), /unexpected archive member/);
  await rm(join(directory, 'script.sql')); await mkdir(join(directory, 'heatmap', 'nested'));
  await assert.rejects(verifyLibraryArchive(directory), /unexpected archive member/);
});

test('pre-aborted writers never create a success manifest; existing snapshots are immutable', async t => {
  const { directory } = await ownedDirectory(t), data = input(), aborted = new AbortController(); aborted.abort();
  await assert.rejects(writeLibraryArchive(directory, data, { signal: aborted.signal }), { name: 'AbortError' });
  await assert.rejects(stat(join(directory, 'manifest.json')), { code: 'ENOENT' });
  const { manifestHash } = await writeLibraryArchive(directory, data);
  await assert.rejects(writeLibraryArchive(directory, data), /must be empty/);
  assert.equal((await verifyLibraryArchive(directory)).manifestHash, manifestHash);
  await assert.rejects(verifyLibraryArchive(directory, { signal: aborted.signal }), { name: 'AbortError' });
});

test('cancellation after a payload file is created leaves no committed manifest', async t => {
  const { directory } = await ownedDirectory(t), data = input(), controller = new AbortController();
  let observed = false;
  const writing = writeLibraryArchive(directory, data, { signal: controller.signal }).then(
    () => ({ success: true }), error => ({ error }));
  for (let attempt = 0; attempt < 1000; attempt++) {
    try { await stat(join(directory, 'report.json.gz')); observed = true; controller.abort(); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await delay(1);
  }
  const result = await writing;
  assert.equal(result.error?.name, 'AbortError');
  assert.equal(observed, true);
  await assert.rejects(stat(join(directory, 'manifest.json')), { code: 'ENOENT' });
});

test('writer rejects restored Chunk size overflow, non-finite numbers and unknown permanent path fields', async t => {
  const { directory } = await ownedDirectory(t), data = input(), chunk = JSON.parse(data.chunks.get('1:0'));
  delete chunk.sessionId; chunk.padding = '';
  chunk.padding = 'x'.repeat(LIBRARY_ARCHIVE_LIMITS.chunkBytes - Buffer.byteLength(JSON.stringify(chunk)));
  data.chunks.set('1:0', JSON.stringify(chunk));
  await assert.rejects(writeLibraryArchive(directory, data), /recovered replay chunk budget/);
  await assert.rejects(stat(join(directory, 'manifest.json')), { code: 'ENOENT' });
  const second = join(directory, '..', 'second'); await mkdir(second); const malformed = input(); malformed.match.tickRate = Number.NaN;
  await assert.rejects(writeLibraryArchive(second, malformed), /non-finite/);
  const third = join(directory, '..', 'third'); await mkdir(third); const privatePath = input(); privatePath.report.filePath = 'C:\\private\\dust2.dem';
  await assert.rejects(writeLibraryArchive(third, privatePath), /report contract/);
});

test('manifest JSON is bounded and canonical, rejecting extra whitespace and oversized headers', async t => {
  const { directory, manifest } = await saved(t);
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2));
  await assert.rejects(readArchiveManifest(directory), /canonical/);
  await writeFile(join(directory, 'manifest.json'), ' '.repeat(LIBRARY_ARCHIVE_LIMITS.manifestBytes + 1));
  await assert.rejects(readArchiveManifest(directory), /size/);
});

test('explicit newer numeric schemas are distinguishable from corrupt manifest structures', async t => {
  const { directory, manifest } = await saved(t);
  await writeFile(join(directory, 'manifest.json'), '{}');
  await assert.rejects(readArchiveManifest(directory), error => error.code !== 'ARCHIVE_UNSUPPORTED');
  manifest.versions.report = 3; await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
  await assert.rejects(readArchiveManifest(directory), { code: 'ARCHIVE_UNSUPPORTED' });
  manifest.versions.report = 2; manifest.schemaVersion = '2';
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
  await assert.rejects(readArchiveManifest(directory), error => error.code !== 'ARCHIVE_UNSUPPORTED');
});
