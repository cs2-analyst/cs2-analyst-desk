import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createOwnedTempDirectory, assertOwnedDirectory } from '../../../scripts/owned-qa-run.mjs';
import { LocalMatchLibrary, localMatchLibraryRoot } from '../electron/local-library.ts';
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

test('SHA duplicate preserves the existing snapshot and same filename never merges distinct bytes', async () => scope(async ({ library }) => {
  const first = await add(library);
  const duplicateInput = input(); duplicateInput.report.players[0].nickname = 'A changed analysis must not overwrite';
  const duplicate = await add(library, duplicateInput);
  assert.equal(duplicate.duplicate, true); assert.deepEqual(duplicate.entry, first.entry);
  assert.equal(library.list().total, 1); assert.equal(readdirSync(join(library.root, 'staging')).length, 0);
  await add(library, input('b'.repeat(64)));
  assert.equal(library.list().total, 2);
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
