import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createOwnedTempDirectory, assertOwnedDirectory } from '../../../scripts/owned-qa-run.mjs';
import { LocalMatchLibrary, isDefinitiveArchiveFailure, localMatchLibraryRoot } from '../electron/local-library.ts';
import { writeLibraryArchive, readArchiveManifest } from '../electron/library-archive.ts';

const versions = { application: '0.1.0', archive: 1, report: 2, replay: 1, analysis: 'test-analysis', parser: 'test-parser', native: 'test-native',
  sampling: 'test-sampling', mapResource: 'test-map', sourceRevision: '1'.repeat(40) };
function input(id = 'a'.repeat(64), fileName = 'same.dem', map = 'de_dust2') {
  return { match: { id, map, players: [{ steamId: '1' }], rounds: [] }, replay: null, spatial: null, chunks: new Map(), versions,
    report: { schemaVersion: 2, match: { id, fileName, map, rounds: 0, score: null }, selectedPlayer: '1', players: [{ id: '1', nickname: 'Test player' }],
      analytics: [], findings: [], timeline: [], analysis: { players: [], perPlayer: [] }, deepReview: { available: false, players: [] } } };
}
async function scope(runTest) {
  const owned = createOwnedTempDirectory('library-catalogue-test'), root = join(owned.directory, 'library');
  let library;
  try {
    library = await LocalMatchLibrary.open(root);
    await runTest({ owned, root, library, setLibrary(value) { library = value; } });
  } finally {
    library?.close();
    assertOwnedDirectory(owned);
    rmSync(owned.directory, { recursive: true, force: true });
  }
}
async function stage(library, data = input()) {
  const staged = await library.createStaging();
  const receipt = await writeLibraryArchive(staged.directory, data);
  return { ...staged, receipt };
}
async function add(library, data = input()) {
  const staged = await stage(library, data);
  return library.commitStaging(staged.id, undefined, staged.receipt);
}
function waitCheckpoint(child, phase) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`Child did not reach ${phase}`)); }, 10_000);
    const message = value => {
      if (value?.kind === 'error') { cleanup(); reject(new Error(value.message)); }
      else if (value?.kind === 'checkpoint') {
        cleanup();
        try { assert.equal(value.phase, phase); assert.equal(value.pid, child.pid); resolve(value); } catch (error) { reject(error); }
      }
    };
    const exit = (code, signal) => { cleanup(); reject(new Error(`Child exited early ${code}/${signal}`)); };
    function cleanup() { clearTimeout(timer); child.off('message', message); child.off('exit', exit); }
    child.on('message', message); child.on('exit', exit);
  });
}

test('production path is LocalAppData only and rejects relative, network and device roots', () => {
  assert.equal(localMatchLibraryRoot('E:\\owned-local-app-data'), join('E:\\owned-local-app-data', 'CS2 Analyst', 'MatchLibrary'));
  for (const value of [undefined, '', '.', '..', '\\\\server\\share', '\\\\?\\C:\\device', 'C:\\null\0']) {
    if (value === undefined) continue;
    assert.throws(() => localMatchLibraryRoot(value));
  }
});

test('durable catalogue is WAL/FULL, survives close/reopen, lists and sorts small index only', async () => scope(async ({ library, root, setLibrary }) => {
  const first = await add(library);
  const second = await add(library, input('b'.repeat(64), 'same.dem', 'de_nuke'));
  assert.equal(first.duplicate, false); assert.equal(second.duplicate, false);
  assert.equal(library.list().total, 2);
  assert.equal(library.list({ map: 'de_nuke' }).entries[0].matchId, 'b'.repeat(64));
  assert.equal(library.list({ search: 'SAME' }).total, 2);
  assert.equal(library.list({ search: "' OR 1=1 --" }).total, 0);
  assert.equal(library.list({ sort: 'map', direction: 'asc', limit: 1, offset: 1 }).entries[0].map, 'de_nuke');
  const path = await library.archiveDirectory(first.entry.matchId);
  // Listing still works when a payload is inaccessible: it never reads or decompresses it.
  const before = readFileSync(join(path, 'report.json.gz'));
  writeFileSync(join(path, 'report.json.gz'), Buffer.from('unreadable payload test'));
  assert.equal(library.list().total, 2);
  writeFileSync(join(path, 'report.json.gz'), before);
  const storage = await library.storage();
  assert.equal(storage.kind, 'success'); assert.equal(storage.matchCount, 2);
  assert.equal(storage.archiveBytes, first.entry.storedBytes + second.entry.storedBytes);
  assert.ok(storage.indexBytes > 0); assert.equal(storage.totalBytes, storage.archiveBytes + storage.indexBytes);
  library.close();
  const raw = new DatabaseSync(join(root, 'library.db'));
  assert.equal(raw.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  // synchronous is per connection; the product opening path always sets FULL (2).
  assert.equal(raw.prepare('PRAGMA user_version').get().user_version, 1); raw.close();
  library = await LocalMatchLibrary.open(root); setLibrary(library);
  assert.deepEqual(library.get(first.entry.matchId), first.entry);
  assert.equal(library.list().total, 2);
}));

test('longest accepted version metadata stays listable across restart and longer input is rejected', async () => scope(async ({ library, root, setLibrary }) => {
  const longest = input(); longest.versions = { ...versions, application: 'v'.repeat(1024) };
  const added = await add(library, longest);
  assert.equal(library.list().total, 1);
  assert.equal(library.list().entries[0].versions.application.length, 1024);
  assert.deepEqual(library.get(added.entry.matchId), added.entry);
  library.close();
  library = await LocalMatchLibrary.open(root); setLibrary(library);
  assert.equal(library.list().entries[0].versions.application.length, 1024, 'catalogue validation must match the archive limit');
  const oversized = input('b'.repeat(64)); oversized.versions = { ...versions, application: 'v'.repeat(1025) };
  const staged = await library.createStaging();
  await assert.rejects(writeLibraryArchive(staged.directory, oversized), /writer identity or versions/);
  assert.equal(library.list().total, 1, 'a rejected write cannot leave an unlistable record');
  await library.discardStaging(staged.id);
}));

test('bounded maximum roster still fits the catalogue row across restart', async () => scope(async ({ library, root, setLibrary }) => {
  const roster = Array.from({ length: 64 }, (_, index) => ({ id: `player-${index}`.padEnd(256, 'x'), nickname: 'n'.repeat(512) }));
  const largest = input();
  largest.report.players = roster; largest.report.selectedPlayer = roster[0].id;
  largest.report.match.fileName = 'f'.repeat(252) + '.dem';
  largest.versions = { ...versions, application: 'v'.repeat(1024), analysis: 'v'.repeat(1024), parser: 'v'.repeat(1024) };
  const added = await add(library, largest);
  assert.equal(added.entry.players.length, 64);
  assert.equal(added.entry.players[0].nickname.length, 512);
  assert.ok(Buffer.byteLength(JSON.stringify(added.entry)) <= 65536, 'entry JSON must fit the SQLite row bound');
  assert.equal(library.list().total, 1);
  library.close();
  library = await LocalMatchLibrary.open(root); setLibrary(library);
  assert.equal(library.list().entries[0].players.length, 64);
}));

test('multibyte roster beyond the catalogue byte budget fails before rename', async () => scope(async ({ library, root }) => {
  const roster = Array.from({ length: 64 }, (_, index) => ({ id: `p-${index}`, nickname: '你'.repeat(512) }));
  const oversized = input(); oversized.report.players = roster; oversized.report.selectedPlayer = roster[0].id;
  const staged = await stage(library, oversized);
  await assert.rejects(library.commitStaging(staged.id, undefined, staged.receipt), /索引记录超过安全大小限制/);
  assert.equal(library.list().total, 0);
  assert.equal(existsSync(join(root, 'matches', 'a'.repeat(64))), false, 'rejection must happen before rename');
  assert.ok(existsSync(staged.directory), 'caller owns staging cleanup after a pre-rename rejection');
  await library.discardStaging(staged.id);
}));

test('SHA duplicate preserves the existing snapshot and same filename never merges distinct bytes', async () => scope(async ({ library }) => {
  const first = await add(library);
  const duplicateInput = input(); duplicateInput.report.players[0].nickname = 'A changed analysis must not overwrite';
  const duplicate = await add(library, duplicateInput);
  assert.equal(duplicate.duplicate, true); assert.deepEqual(duplicate.entry, first.entry);
  assert.equal(library.list().total, 1); assert.equal(readdirSync(join(library.root, 'staging')).length, 0);
  await add(library, input('b'.repeat(64)));
  assert.equal(library.list().total, 2);
}));

test('duplicate refuses a validly changed old manifest before discarding new staging', async () => scope(async ({ library, root, setLibrary }) => {
  const first = await add(library), archive = await library.archiveDirectory(first.entry.matchId);
  const reportBefore = readFileSync(join(archive, 'report.json.gz'));
  const manifestPath = join(archive, 'manifest.json'), changed = await readArchiveManifest(archive);
  changed.createdAt = new Date(Date.parse(changed.createdAt) + 1).toISOString();
  const changedBytes = JSON.stringify(changed); writeFileSync(manifestPath, changedBytes);
  const staged = await stage(library); let committed = false;
  await assert.rejects(library.commitStaging(staged.id, undefined, staged.receipt, () => { committed = true; }), /不一致/);
  assert.equal(committed, false); assert.ok(existsSync(staged.directory), 'failed duplicate retains stage until caller cleanup');
  assert.equal(library.get(first.entry.matchId).state, 'invalid');
  assert.equal(readFileSync(manifestPath, 'utf8'), changedBytes, 'old archive must not be replaced by duplicate');
  assert.deepEqual(readFileSync(join(archive, 'report.json.gz')), reportBefore);
  await library.discardStaging(staged.id); library.close();
  library = await LocalMatchLibrary.open(root); setLibrary(library);
  assert.equal(library.get(first.entry.matchId).state, 'invalid');
}));

test('duplicate verifies the old indexed snapshot as well as archive payload hashes', async () => scope(async ({ library }) => {
  const first = await add(library), changed = structuredClone(first.entry);
  changed.players[0].nickname = 'Controlled index corruption';
  // Fault injection writes the real SQLite connection, not a mock catalogue.
  library.db.prepare('UPDATE matches SET entry_json=? WHERE match_id=?').run(JSON.stringify(changed), first.entry.matchId);
  const staged = await stage(library);
  await assert.rejects(library.commitStaging(staged.id), /不一致/);
  assert.ok(existsSync(staged.directory)); assert.equal(library.get(first.entry.matchId).state, 'invalid');
  await library.discardStaging(staged.id);
}));

test('damaged JSON is recovered from a trusted manifest as invalid without blocking good records', async () => scope(async ({ library, root, setLibrary }) => {
  const first = await add(library), second = await add(library, input('b'.repeat(64)));
  library.close();
  const db = new DatabaseSync(join(root, 'library.db'));
  db.prepare('UPDATE matches SET entry_json=? WHERE match_id=?').run('{broken', first.entry.matchId); db.close();
  library = await LocalMatchLibrary.open(root); setLibrary(library);
  const listed = library.list({ limit: 100 });
  assert.equal(listed.kind, 'success'); assert.equal(listed.total, 2); assert.equal(listed.unreadableCount, 0);
  assert.deepEqual(library.get(first.entry.matchId), { ...first.entry, state: 'invalid' });
  assert.deepEqual(library.get(second.entry.matchId), second.entry);
  library.close(); library = await LocalMatchLibrary.open(root); setLibrary(library);
  assert.equal(library.get(first.entry.matchId).state, 'invalid', 'reconstructed index is never silently promoted to ready');
}));

test('unrecoverable bad rows are omitted per page with a visible count and controlled get error', async () => scope(async ({ library, root, setLibrary }) => {
  const first = await add(library), second = await add(library, input('b'.repeat(64)));
  const damagedArchive = await library.archiveDirectory(first.entry.matchId); library.close();
  writeFileSync(join(damagedArchive, 'manifest.json'), '{}');
  const db = new DatabaseSync(join(root, 'library.db'));
  db.prepare('UPDATE matches SET entry_json=? WHERE match_id=?').run('{broken', first.entry.matchId); db.close();
  library = await LocalMatchLibrary.open(root); setLibrary(library);
  const listed = library.list({ sort: 'map', direction: 'asc', limit: 100 });
  assert.equal(listed.kind, 'success'); assert.equal(listed.total, 2); assert.equal(listed.unreadableCount, 1);
  assert.deepEqual(listed.entries, [second.entry]);
  assert.throws(() => library.get(first.entry.matchId), /比赛库索引记录损坏/);
  const firstPage = library.list({ limit: 1, offset: 0, sort: 'map', direction: 'asc' });
  const secondPage = library.list({ limit: 1, offset: 1, sort: 'map', direction: 'asc' });
  assert.equal(firstPage.unreadableCount, 1); assert.equal(firstPage.entries.length, 0); assert.equal(firstPage.total, 2);
  assert.equal(secondPage.unreadableCount, 0); assert.deepEqual(secondPage.entries, [second.entry]);
  assert.ok(existsSync(join(damagedArchive, 'report.json.gz')), 'irrecoverable index never deletes archive bytes');
}));

test('invalid IDs, malformed queries and forged writer receipts cannot reach another directory', async () => scope(async ({ library }) => {
  for (const query of [{ limit: 101 }, { offset: -1 }, { search: 'a'.repeat(129) }, { sort: 'match_id;DROP TABLE matches' }, { arbitrary: 'path' }])
    assert.equal(library.list(query).kind, 'error');
  assert.throws(() => library.get('../outside'));
  await assert.rejects(library.discardStaging('../outside'));
  await assert.rejects(library.commitStaging('../outside'));
  const staged = await stage(library);
  await assert.rejects(library.commitStaging(staged.id, undefined, { manifestHash: '0'.repeat(64), storedBytes: 0 }), /不一致/);
  assert.equal(library.list().total, 0); await library.discardStaging(staged.id);
}));

test('cancellation and ENOSPC/EACCES injections before commit leave old records and no ready half-write', async () => scope(async ({ library, root, setLibrary }) => {
  const first = await add(library); library.close();
  for (const phase of ['validated', 'before-rename', 'after-rename', 'before-index-commit']) {
    for (const mode of ['abort', 'ENOSPC', 'EACCES']) {
      const controller = new AbortController();
      library = await LocalMatchLibrary.open(root, { phase: name => {
        if (name !== phase) return;
        if (mode === 'abort') controller.abort();
        else throw Object.assign(new Error(`controlled ${mode}`), { code: mode });
      } }); setLibrary(library);
      const staged = await stage(library, input('b'.repeat(64)));
      await assert.rejects(library.commitStaging(staged.id, controller.signal));
      assert.equal(library.list().total, 1); assert.deepEqual(library.get(first.entry.matchId), first.entry);
      await library.discardStaging(staged.id); library.close();
      library = await LocalMatchLibrary.open(root); setLibrary(library);
      assert.equal(library.list().total, 1); assert.equal(readdirSync(join(root, 'matches')).length, 1);
      assert.equal(readdirSync(join(root, 'staging')).length, 0); library.close();
    }
  }
}));

test('commit notification precedes any async observer; cancellation after durable commit returns success', async () => scope(async ({ library, root, setLibrary }) => {
  library.close();
  const controller = new AbortController(), order = [];
  library = await LocalMatchLibrary.open(root, { phase: async phase => {
    if (phase === 'after-index-commit') { order.push('observer'); controller.abort(); await Promise.resolve(); throw new Error('observer failed'); }
  } }); setLibrary(library);
  const staged = await stage(library);
  const result = await library.commitStaging(staged.id, controller.signal, staged.receipt, () => order.push('committed'));
  assert.deepEqual(order, ['committed', 'observer']); assert.equal(result.duplicate, false); assert.equal(library.list().total, 1);
  const duplicate = await stage(library);
  const duplicated = await library.commitStaging(duplicate.id, undefined, duplicate.receipt, () => order.push('duplicate-committed'));
  assert.equal(duplicated.duplicate, true); assert.equal(order.at(-1), 'duplicate-committed');
}));

test('concurrent commit callers serialize and cannot create duplicate ready records', async () => scope(async ({ library }) => {
  const a = await stage(library), b = await stage(library);
  const results = await Promise.all([library.commitStaging(a.id), library.commitStaging(b.id)]);
  assert.deepEqual(results.map(result => result.duplicate), [false, true]);
  assert.equal(library.list().total, 1); assert.equal(readdirSync(join(library.root, 'staging')).length, 0);
}));

test('restart removes only owned interrupted stages/orphans and marks damaged indexed manifests invalid', async () => scope(async ({ library, root, setLibrary }) => {
  const old = await add(library);
  const staged = await stage(library, input('b'.repeat(64)));
  const orphan = join(root, 'matches', 'c'.repeat(64)); mkdirSync(orphan); writeFileSync(join(orphan, 'partial'), 'interrupted write');
  library.close();
  library = await LocalMatchLibrary.open(root); setLibrary(library);
  assert.equal(existsSync(staged.directory), false); assert.equal(existsSync(orphan), false);
  assert.deepEqual(library.get(old.entry.matchId), old.entry);
  const archive = await library.archiveDirectory(old.entry.matchId); library.close();
  writeFileSync(join(archive, 'manifest.json'), '{}');
  library = await LocalMatchLibrary.open(root); setLibrary(library);
  assert.equal(library.get(old.entry.matchId).state, 'invalid');
  assert.ok(existsSync(join(archive, 'report.json.gz')), 'old data is preserved rather than silently deleted');
  await assert.rejects(library.archiveDirectory(old.entry.matchId));
}));

test('real junction roots and redirected stage children are rejected without touching outside files', async () => scope(async ({ library, owned, root, setLibrary }) => {
  const outside = join(owned.directory, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'keep'), 'unchanged');
  const redirectedRoot = join(owned.directory, 'redirected'); symlinkSync(outside, redirectedRoot, 'junction');
  await assert.rejects(LocalMatchLibrary.open(redirectedRoot), /重定向/);
  const stageInfo = await library.createStaging();
  symlinkSync(outside, join(stageInfo.directory, 'escape'), 'junction');
  await assert.rejects(library.discardStaging(stageInfo.id), /重定向/);
  assert.equal(readFileSync(join(outside, 'keep'), 'utf8'), 'unchanged');
  rmSync(join(stageInfo.directory, 'escape')); await library.discardStaging(stageInfo.id);
  library.close();
  const matches = join(root, 'matches'); rmdirSync(matches); symlinkSync(outside, matches, 'junction');
  await assert.rejects(LocalMatchLibrary.open(root), /重定向/);
  rmSync(matches); mkdirSync(matches);
  library = await LocalMatchLibrary.open(root); setLibrary(library);
  assert.equal(readFileSync(join(outside, 'keep'), 'utf8'), 'unchanged');
  rmSync(redirectedRoot);
}));

test('newer SQLite schema is rejected without rewriting its existing catalogue', async () => scope(async ({ library, root, setLibrary }) => {
  await add(library); library.close();
  const raw = new DatabaseSync(join(root, 'library.db')); raw.exec('PRAGMA user_version=999'); raw.close();
  await assert.rejects(LocalMatchLibrary.open(root), /版本/);
  const inspection = new DatabaseSync(join(root, 'library.db'));
  assert.equal(inspection.prepare('PRAGMA user_version').get().user_version, 999);
  assert.equal(inspection.prepare('SELECT count(*) AS n FROM matches').get().n, 1);
  inspection.exec('PRAGMA user_version=1'); inspection.close();
  library = await LocalMatchLibrary.open(root); setLibrary(library);
}));

test('remove deletes each row then its archive and reports invalid or missing ids per id', async () => scope(async ({ library }) => {
  const first = await add(library), second = await add(library, input('b'.repeat(64)));
  const firstDirectory = await library.archiveDirectory(first.entry.matchId);
  const before = await library.storage();
  for (const value of [[], ['../' + 'a'.repeat(64)], ['A'.repeat(64)], [first.entry.matchId, first.entry.matchId],
    Array.from({ length: 101 }, (_, index) => index.toString(16).padStart(64, '0'))]) {
    assert.equal((await library.remove(value)).kind, 'error', JSON.stringify(value).slice(0, 80));
  }
  assert.equal(library.list().total, 2);
  assert.deepEqual(await library.remove([first.entry.matchId]), { kind: 'success', removed: [first.entry.matchId], failed: [] });
  assert.equal(library.get(first.entry.matchId), null);
  assert.equal(existsSync(firstDirectory), false);
  assert.equal(library.list().total, 1);
  assert.equal(library.get(second.entry.matchId).state, 'ready');
  const after = await library.storage();
  assert.equal(after.kind, 'success'); assert.equal(after.matchCount, 1);
  assert.equal(after.archiveBytes, before.archiveBytes - first.entry.storedBytes, 'capacity follows actual files');
  const missing = await library.remove([first.entry.matchId]);
  assert.equal(missing.kind, 'success'); assert.deepEqual(missing.removed, []);
  assert.deepEqual(missing.failed.map(item => item.matchId), [first.entry.matchId]);
}));

test('a failed archive removal is reported alone, keeps the other deletion and is recovered as an orphan on restart', async () => scope(async ({ library, root, owned, setLibrary }) => {
  const first = await add(library), second = await add(library, input('b'.repeat(64)));
  const firstDirectory = await library.archiveDirectory(first.entry.matchId);
  const outside = join(owned.directory, 'outside'); mkdirSync(outside);
  // A junction inside the owned archive makes the guarded removal refuse this match only.
  const redirect = join(firstDirectory, 'junction'); symlinkSync(outside, redirect, 'junction');
  const result = await library.remove([first.entry.matchId, second.entry.matchId]);
  assert.equal(result.kind, 'success');
  assert.deepEqual(result.removed, [second.entry.matchId]);
  assert.deepEqual(result.failed.map(item => item.matchId), [first.entry.matchId]);
  assert.equal(library.get(first.entry.matchId), null, 'the row is already deleted');
  assert.ok(existsSync(firstDirectory), 'the leftover directory is an orphan, not an indexed match');
  assert.equal(library.list().total, 0);
  library.close();
  const diagnostics = [];
  // The unremovable orphan must not make every other match unavailable. Keep the
  // junction in place across this reopen; the old test removed it too early.
  library = await LocalMatchLibrary.open(root, { diagnostic: message => diagnostics.push(message) });
  setLibrary(library);
  assert.equal(library.list().total, 0);
  assert.ok(existsSync(firstDirectory), 'the orphan is retained while cleanup is impossible');
  assert.ok(diagnostics.some(message => message.includes('Orphan archive')), diagnostics.join('\n'));
  rmSync(redirect);
  library.close();
  library = await LocalMatchLibrary.open(root); setLibrary(library);
  assert.equal(existsSync(firstDirectory), false, 'startup orphan cleanup removes the leftover after the obstruction');
  const clean = await library.storage();
  assert.equal(clean.archiveBytes, 0); assert.equal(clean.matchCount, 0);
}));

test('only definitive archive corruption may demote a ready row', () => {
  assert.equal(isDefinitiveArchiveFailure(new Error('Invalid match archive: compressed digest mismatch')), true);
  assert.equal(isDefinitiveArchiveFailure(Object.assign(new Error('unsupported'), { code: 'ARCHIVE_UNSUPPORTED' })), true);
  for (const code of ['EBUSY', 'EACCES', 'ENOENT', 'EPERM']) assert.equal(isDefinitiveArchiveFailure(Object.assign(new Error(code), { code })), false);
  assert.equal(isDefinitiveArchiveFailure(new Error('ENOENT: missing payload')), false);
});

test('real killed writer recovers after rename and preserves commit completed before process death', async () => scope(async ({ library, root, owned, setLibrary }) => {
  const existing = await add(library); library.close();
  const template = join(owned.directory, 'template'); mkdirSync(template);
  await writeLibraryArchive(template, input('b'.repeat(64)));
  const childPath = fileURLToPath(new URL('./local-library-child.mjs', import.meta.url));
  for (const phase of ['after-rename', 'after-index-commit']) {
    const child = spawn(process.execPath, [childPath, root, template, phase], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    try {
      await waitCheckpoint(child, phase);
      const ended = once(child, 'exit'); assert.equal(child.kill('SIGKILL'), true); await ended;
    } finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); } }
    const retries = [];
    library = await LocalMatchLibrary.open(root, { diagnostic: message => retries.push(message) }); setLibrary(library);
    assert.deepEqual(library.get(existing.entry.matchId), existing.entry);
    assert.equal(library.list().total, phase === 'after-rename' ? 1 : 2);
    assert.equal(existsSync(join(root, 'matches', 'b'.repeat(64))), phase === 'after-index-commit');
    assert.equal(readdirSync(join(root, 'staging')).length, 0);
    library.close();
  }
}));

test('real second process cannot acquire the exclusive writer lock; kill releases the OS lock', async () => scope(async ({ library, root, setLibrary }) => {
  await add(library); library.close();
  const childPath = fileURLToPath(new URL('./local-library-child.mjs', import.meta.url));
  const child = spawn(process.execPath, [childPath, root, '-', 'hold-lock'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  try {
    await waitCheckpoint(child, 'hold-lock');
    const diagnostics = [];
    await assert.rejects(LocalMatchLibrary.open(root, { diagnostic: message => diagnostics.push(message) }), /locked|busy/i);
    assert.equal(diagnostics.length, 4, 'bounded retry does not loop indefinitely');
    const ended = once(child, 'exit'); child.kill('SIGKILL'); await ended;
  } finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); } }
  library = await LocalMatchLibrary.open(root); setLibrary(library); assert.equal(library.list().total, 1);
}));
