import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createOwnedTempDirectory, removeOwnedDirectory } from '../../../scripts/owned-qa-run.mjs';
import { optimizationInput } from './library-optimization-fixture.mjs';
import { LocalMatchLibrary } from '../electron/local-library.ts';
import { archiveCompressedBytes, loadLibraryArchive, readArchiveChunk, readArchiveManifest,
  readArchiveProjection, verifyLibraryArchive, writeLibraryArchive } from '../electron/library-archive.ts';
import { DerivedReplaySession } from '../electron/library-derived-replay.ts';
import { extractPortableArchive, writePortableArchive } from '../electron/library-portable.ts';

// Every payload is synthetic. These tests never parse a DEM or open the user's library.
const DATE = '2026-10-21T00:00:00.000Z';
const normalize = value => JSON.stringify(value, (key, item) => key === 'sessionId' ? undefined : item);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function input(version, identity, generation = 'original', createdAt = DATE) {
  const data = optimizationInput(version), id = digest(identity);
  data.match.id = id; data.replay.matchId = id; data.spatial.matchId = id;
  data.report.match.id = id; data.report.replay.matchId = id; data.report.heatmap.matchId = id;
  data.createdAt = createdAt; data.versions.analysis = `catalogue-${generation}`;
  data.chunks = new Map([...data.chunks].map(([key, json]) => {
    const chunk = JSON.parse(json); chunk.matchId = id;
    return [key, JSON.stringify(chunk)];
  }));
  return data;
}

async function scope(t) {
  const owned = createOwnedTempDirectory('optimization-catalogue-test');
  const root = join(owned.directory, 'library');
  let library = await LocalMatchLibrary.open(root);
  t.after(() => { library.close(); removeOwnedDirectory(owned); });
  return { owned, root, get library() { return library; }, async restart() {
    library.close(); library = await LocalMatchLibrary.open(root); return library;
  } };
}

async function stage(library, data) {
  const staged = await library.createStaging();
  const written = await writeLibraryArchive(staged.directory, data);
  const verified = await verifyLibraryArchive(staged.directory);
  assert.deepEqual(verified, written, 'Utility verification and writer receipt must agree');
  return { ...staged, receipt: verified };
}
async function add(library, data, self = null) {
  const staged = await stage(library, data);
  return library.commitStaging(staged.id, undefined, staged.receipt, undefined, self);
}
async function replace(library, data) {
  const staged = await stage(library, data);
  return library.replaceStaging(staged.id, data.match.id, undefined, staged.receipt);
}

async function snapshot(library, id) {
  const directory = await library.archiveDirectory(id), manifest = await readArchiveManifest(directory);
  const files = ['manifest.json', ...manifest.files.map(file => file.path)];
  return { directory, manifest, hashes: Object.fromEntries(await Promise.all(files.map(async path =>
    [path, digest(await readFile(join(directory, path)))]))) };
}

async function assertStorage(library, entries) {
  const listed = library.list({ sort: 'storedBytes', direction: 'asc' });
  assert.equal(listed.kind, 'success'); assert.equal(listed.total, entries.length); assert.equal(listed.unreadableCount, 0);
  assert.deepEqual(new Set(listed.entries.map(entry => entry.matchId)), new Set(entries.map(entry => entry.matchId)));
  assert.deepEqual(listed.entries.map(entry => entry.storedBytes), entries.map(entry => entry.storedBytes).sort((a, b) => a - b));
  for (const entry of entries) {
    assert.deepEqual(library.get(entry.matchId), entry);
    const directory = await library.archiveDirectory(entry.matchId), manifest = await readArchiveManifest(directory);
    const actualBytes = (await stat(join(directory, 'manifest.json'))).size + manifest.files.reduce((sum, file) => sum + archiveCompressedBytes(file), 0);
    assert.equal(entry.storedBytes, actualBytes);
  }
  const storage = await library.storage();
  assert.equal(storage.kind, 'success'); assert.equal(storage.matchCount, entries.length);
  assert.equal(storage.archiveBytes, entries.reduce((sum, entry) => sum + entry.storedBytes, 0));
  assert.ok(storage.indexBytes > 0); assert.equal(storage.totalBytes, storage.archiveBytes + storage.indexBytes);
  assert.deepEqual(await readdir(join(library.root, 'staging')), [], 'successful operations leave no staging payload');
}

async function assertOfflineData(library, data) {
  const directory = await library.archiveDirectory(data.match.id), loaded = await loadLibraryArchive(directory);
  assert.equal(loaded.manifest.schemaVersion, data.versions.archive);
  assert.equal(normalize(loaded.report), normalize(data.report));
  assert.equal(JSON.stringify(loaded.sources), JSON.stringify({ match: data.match, replay: data.replay, spatial: data.spatial }));
  const sessionId = randomUUID(), metadata = { ...loaded.report.replay, sessionId };
  const session = data.versions.archive === 2
    ? new DerivedReplaySession(loaded.sources.replay, metadata, round => readArchiveProjection(directory, loaded.manifest, round))
    : { get: request => readArchiveChunk(directory, loaded.manifest, request), clear() {} };
  try {
    for (const [key, json] of [...data.chunks].reverse()) {
      const [round, block] = key.split(':').map(Number);
      assert.equal(normalize(await session.get({ sessionId, round, block })), normalize(JSON.parse(json)));
    }
  } finally { session.clear(); }
}

test('SQLite lists a mixed v1/v2 library, accounts actual bytes and deduplicates across formats without rewriting either archive', async t => {
  const s = await scope(t), old = input(1, 'mixed-old'), current = input(2, 'mixed-current');
  const first = await add(s.library, old, '1'), second = await add(s.library, current);
  assert.equal(first.duplicate, false); assert.equal(second.duplicate, false);
  const originals = await Promise.all([old, current].map(data => snapshot(s.library, data.match.id)));
  await assertStorage(s.library, [first.entry, second.entry]);
  for (const [data, previous] of [[input(2, 'mixed-old', 'duplicate-new', '2026-10-25T00:00:00.000Z'), first],
    [input(1, 'mixed-current', 'duplicate-old', '2026-10-25T00:00:00.000Z'), second]]) {
    const result = await add(s.library, data);
    assert.equal(result.duplicate, true); assert.deepEqual(result.entry, previous.entry);
  }
  assert.deepEqual(await snapshot(s.library, old.match.id), originals[0]);
  assert.deepEqual(await snapshot(s.library, current.match.id), originals[1]);
  await s.restart();
  await assertStorage(s.library, [first.entry, second.entry]);
  assert.equal(s.library.get(old.match.id).state, 'ready'); assert.equal(s.library.get(current.match.id).state, 'ready');
  await assertOfflineData(s.library, old); await assertOfflineData(s.library, current);
});

for (const self of [null, '1']) {
  test(`explicit v1-to-v2 and v2-to-v2 replacement preserve ${self === null ? 'null' : 'selected'} self and original creation time across restart`, async t => {
    const s = await scope(t), identity = `replacement-${self ?? 'null'}`;
    const original = input(1, identity), untouched = input(1, identity + '-untouched');
    const seeded = await add(s.library, original, self), keeper = await add(s.library, untouched, '2');
    let directory = await s.library.archiveDirectory(original.match.id), latest = original, entry = seeded.entry;
    for (const generation of ['v2-first', 'v2-second']) {
      latest = input(2, identity, generation);
      const result = await replace(s.library, latest);
      assert.equal(result.duplicate, false); entry = result.entry;
      assert.equal(entry.matchId, seeded.entry.matchId); assert.equal(entry.selfPlayerId, self);
      assert.equal(entry.importedAt, DATE); assert.equal(entry.versions.archive, 2);
      assert.equal(entry.versions.analysis, latest.versions.analysis);
      const next = await s.library.archiveDirectory(entry.matchId);
      assert.notEqual(next, directory); await assert.rejects(stat(directory), { code: 'ENOENT' }); directory = next;
      const manifest = await readArchiveManifest(next);
      assert.equal(manifest.createdAt, DATE); assert.equal(manifest.schemaVersion, 2);
      await assertOfflineData(s.library, latest);
      await s.restart();
      await assertStorage(s.library, [entry, keeper.entry]);
      assert.equal(await s.library.archiveDirectory(entry.matchId), directory);
      assert.equal(s.library.get(entry.matchId).selfPlayerId, self);
      assert.equal(s.library.get(untouched.match.id).state, 'ready');
    }
    await assertOfflineData(s.library, latest); await assertOfflineData(s.library, untouched);
  });
}

test('v1 and v2 portable archives survive export, deletion, import and mixed-library restart with exact saved sources and chunks', async t => {
  const s = await scope(t), datasets = [input(1, 'portable-old'), input(2, 'portable-current')];
  const exports = [];
  for (const data of datasets) {
    const added = await add(s.library, data), before = await snapshot(s.library, data.match.id);
    const path = join(s.owned.directory, `v${data.versions.archive}.cs2a`);
    const receipt = await writePortableArchive(before.directory, path);
    assert.equal(receipt.header.archiveSchemaVersion, data.versions.archive);
    exports.push({ data, path, before, entry: added.entry });
  }
  const removed = await s.library.remove(datasets.map(data => data.match.id));
  assert.equal(removed.kind, 'success'); assert.deepEqual(removed.failed, []);
  assert.deepEqual(new Set(removed.removed), new Set(datasets.map(data => data.match.id)));
  for (const item of exports) {
    assert.equal(s.library.get(item.data.match.id), null);
    await assert.rejects(stat(item.before.directory), { code: 'ENOENT' });
  }
  await assertStorage(s.library, []); await s.restart();
  const importedEntries = [];
  for (const item of exports) {
    const staged = await s.library.createStaging();
    const extracted = await extractPortableArchive(item.path, staged.directory);
    const verified = await verifyLibraryArchive(staged.directory);
    assert.equal(extracted.header.archiveSchemaVersion, item.data.versions.archive);
    const saved = await s.library.commitStaging(staged.id, undefined, verified);
    assert.equal(saved.duplicate, false); assert.deepEqual(saved.entry, item.entry); importedEntries.push(saved.entry);
    assert.deepEqual((await snapshot(s.library, item.data.match.id)).hashes, item.before.hashes);
  }
  await s.restart(); await assertStorage(s.library, importedEntries);
  for (const data of datasets) {
    assert.equal(s.library.get(data.match.id).state, 'ready'); await assertOfflineData(s.library, data);
  }
});
