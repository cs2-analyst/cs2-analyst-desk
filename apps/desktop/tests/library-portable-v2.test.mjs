import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { assertOwnedDirectory, createOwnedTempDirectory } from '../../../scripts/owned-qa-run.mjs';
import { ReplaySession } from '../electron/replay-session.ts';
import { writeLibraryArchive, verifyLibraryArchive } from '../electron/library-archive.ts';
import { extractPortableArchive, isPortablePath, PORTABLE_MAGIC, validatePortableHeader,
  verifyPortableArchive, writePortableArchive } from '../electron/library-portable.ts';
import { fixture } from './heatmap-fixture.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const versions = { application: '0.2.0', archive: 2, report: 2, replay: 1, analysis: 'test', parser: 'test',
  native: 'test', sampling: 'test', mapResource: 'test', sourceRevision: 'a'.repeat(40) };
async function saved(t) {
  const run = createOwnedTempDirectory('portable-v2');
  t.after(async () => { assertOwnedDirectory(run); await rm(run.directory, { recursive: true, force: true }); });
  const archive = join(run.directory, 'archive'); await mkdir(archive);
  const f = fixture();
  const matchId = digest('portable-v2-synthetic');
  f.match.id = matchId; f.replay.matchId = matchId; f.spatial.matchId = matchId;
  f.match.players.forEach(p => { p.nickname = 'Test'; });
  const replay = new ReplaySession(f.match, f.replay, randomUUID());
  const report = { schemaVersion: 2, match: { id: matchId, fileName: 'dust2.dem', map: f.match.map, rounds: 1, score: null },
    selectedPlayer: '1', players: f.match.players.map(p => ({ id: p.steamId, nickname: p.nickname })),
    analytics: [], findings: [], timeline: [], analysis: { players: [], perPlayer: [] }, deepReview: { available: false, players: [] },
    replay: replay.metadata };
  await writeLibraryArchive(archive, { ...f, report, chunks: replay.chunks, versions });
  return { root: run.directory, archive, path: join(run.directory, 'match.cs2a') };
}
function split(bytes) {
  const n = bytes.readUInt32BE(8);
  return { header: JSON.parse(bytes.subarray(12, 12 + n)), payload: bytes.subarray(12 + n) };
}
function assemble(header, payload) {
  const json = Buffer.from(JSON.stringify(header)), prefix = Buffer.alloc(12);
  PORTABLE_MAGIC.copy(prefix); prefix.writeUInt32BE(json.length, 8);
  return Buffer.concat([prefix, json, payload]);
}

test('portable v2 preserves Brotli members and projection inventory byte for byte', async t => {
  const { root, archive, path } = await saved(t);
  const exported = await writePortableArchive(archive, path);
  assert.equal(exported.header.schemaVersion, 1);
  assert.equal(exported.header.archiveSchemaVersion, 2);
  assert.deepEqual(exported.header.files.map(f => f.path), ['manifest.json', 'report.json.br',
    'heatmap/match.json.br', 'heatmap/replay.json.br', 'heatmap/spatial.json.br', 'replay/r1.json.br']);
  assert.equal(validatePortableHeader(exported.header), true);
  const stage = join(root, 'stage'); await mkdir(stage);
  await extractPortableArchive(path, stage);
  assert.equal((await verifyLibraryArchive(stage)).manifestHash, (await verifyLibraryArchive(archive)).manifestHash);
  for (const file of exported.header.files) assert.deepEqual(await readFile(join(stage, file.path)), await readFile(join(archive, file.path)));
});

test('portable paths and header are strict per archive version', async t => {
  const { archive, path } = await saved(t);
  const { header } = await writePortableArchive(archive, path);
  for (const candidate of ['report.json.gz', 'replay/r1-b0.json.gz', 'replay/r0.json.br', 'replay/r1025.json.br',
    'replay/r01.json.br', 'replay/r1-b0.json.br', '../report.json.br', 'heatmap\\match.json.br']) {
    assert.equal(isPortablePath(candidate, 2), false, candidate);
    const altered = structuredClone(header); altered.files.push({ path: candidate, bytes: 1, sha256: 'a'.repeat(64) });
    assert.equal(validatePortableHeader(altered), false, candidate);
  }
  for (const path of ['report.json.br', 'heatmap/match.json.br', 'replay/r1.json.br', 'replay/r1024.json.br']) {
    assert.equal(isPortablePath(path, 2), true); assert.equal(isPortablePath(path, 1), false);
  }
  const mixed = structuredClone(header); mixed.archiveSchemaVersion = 1;
  assert.equal(validatePortableHeader(mixed), false);
  const absent = structuredClone(header); absent.files = absent.files.filter(f => f.path !== 'heatmap/replay.json.br');
  assert.equal(validatePortableHeader(absent), false);
});

test('v2 portable refuses corruption, truncation, future schemas and cancellation', async t => {
  const { root, archive, path } = await saved(t);
  await writePortableArchive(archive, path);
  const original = await readFile(path), { header, payload } = split(original);
  for (const [name, bytes, expected] of [
    ['truncated', original.subarray(0, original.length - 1), /truncated payload/],
    ['trailing', Buffer.concat([original, Buffer.from([0])]), /trailing bytes/],
    ['digest', (() => { const b = Buffer.from(original); b[b.length - 1] ^= 1; return b; })(), /digest/],
  ]) {
    const file = join(root, name + '.cs2a'); await writeFile(file, bytes);
    await assert.rejects(verifyPortableArchive(file), expected);
  }
  const future = structuredClone(header); future.archiveSchemaVersion = 3;
  const file = join(root, 'future.cs2a'); await writeFile(file, assemble(future, payload));
  await assert.rejects(verifyPortableArchive(file), { code: 'ARCHIVE_UNSUPPORTED' });
  const controller = new AbortController(); controller.abort();
  const cancelled = join(root, 'cancelled.cs2a');
  await assert.rejects(writePortableArchive(archive, cancelled, { signal: controller.signal }), { name: 'AbortError' });
  await assert.rejects(stat(cancelled), { code: 'ENOENT' });
});

test('v2 transport checks the inner compressed digest and archive version independently', async t => {
  const { root, archive, path } = await saved(t);
  await writePortableArchive(archive, path);
  const original = await readFile(path);
  for (const [name, mutate, expected] of [
    ['inventory', m => { m.files[0].compressedSha256 = 'c'.repeat(64); }, /inner manifest inventory mismatch/],
    ['version', m => { m.versions.archive = 1; }, /inner manifest contract/],
  ]) {
    const { header, payload } = split(original), parts = new Map();
    let offset = 0;
    for (const file of header.files) { parts.set(file.path, payload.subarray(offset, offset + file.bytes)); offset += file.bytes; }
    const manifest = JSON.parse(parts.get('manifest.json')); mutate(manifest);
    const json = Buffer.from(JSON.stringify(manifest)); parts.set('manifest.json', json);
    const file = header.files.find(f => f.path === 'manifest.json'); file.bytes = json.length; file.sha256 = digest(json);
    const target = join(root, name + '.cs2a');
    await writeFile(target, assemble(header, Buffer.concat(header.files.map(f => parts.get(f.path)))));
    await assert.rejects(verifyPortableArchive(target), expected);
  }
});

test('the internal Utility verification seam retains streaming digest checks after verification', async t => {
  const { root, archive } = await saved(t);
  const verified = await verifyLibraryArchive(archive);
  const destination = join(root, 'changed-after-verify.cs2a');
  let calls = 0;
  await assert.rejects(writePortableArchive(archive, destination, { verify: async directory => {
    assert.equal(directory, archive); calls++;
    const payload = join(archive, 'report.json.br'), bytes = await readFile(payload);
    bytes[bytes.length - 1] ^= 1; await writeFile(payload, bytes);
    return verified;
  } }), /source archive changed/);
  assert.equal(calls, 1); await assert.rejects(stat(destination), { code: 'ENOENT' });
});
