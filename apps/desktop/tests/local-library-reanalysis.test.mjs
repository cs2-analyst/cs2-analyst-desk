import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { assertOwnedDirectory, createOwnedTempDirectory } from '../../../scripts/owned-qa-run.mjs';
import { LocalMatchLibrary } from '../electron/local-library.ts';
import { readArchiveManifest, readArchiveReport, readArchiveSources, verifyLibraryArchive, writeLibraryArchive } from '../electron/library-archive.ts';
import { writePortableArchive, verifyPortableArchive } from '../electron/library-portable.ts';
import { fixture, map } from './heatmap-fixture.mjs';
import { ReplaySession } from '../electron/replay-session.ts';
import { createHeatmapSession } from '../electron/heatmap-session.ts';

const MATCH = 'a'.repeat(64);
const DATE = '2026-10-21T00:00:00.000Z';
const versions = { application: '0.2.0', archive: 1, report: 2, replay: 1, analysis: 'analysis-old', parser: 'parser', native: 'native',
  sampling: 'test', mapResource: 'test', sourceRevision: '1'.repeat(40) };
function input({ id = MATCH, generation = 'old', playerId = '1', createdAt = DATE } = {}) {
  return { match: { id, map: 'de_dust2', players: [{ steamId: playerId }], rounds: [] }, replay: null, spatial: null, chunks: new Map(),
    versions: { ...versions, analysis: 'analysis-' + generation }, createdAt,
    report: { schemaVersion: 2, match: { id, fileName: 'demo2.dem', map: 'de_dust2', rounds: 0, score: null }, selectedPlayer: playerId,
      players: [{ id: playerId, nickname: 'Player ' + generation }], analytics: [], findings: [], timeline: [],
      analysis: { players: [], perPlayer: [] }, deepReview: { available: false, players: [] } } };
}
async function stage(library, data = input()) {
  const staged = await library.createStaging();
  return { ...staged, receipt: await writeLibraryArchive(staged.directory, data) };
}
async function scope(t) {
  const owned = createOwnedTempDirectory('library-reanalysis-test'), root = join(owned.directory, 'library');
  let library = await LocalMatchLibrary.open(root);
  t.after(() => { library.close(); assertOwnedDirectory(owned); rmSync(owned.directory, { recursive: true, force: true }); });
  return { owned, root, get library() { return library; }, async reopen(options) { library.close(); library = await LocalMatchLibrary.open(root, options); return library; },
    async seed(data = input(), self = '1') { const s = await stage(library, data); return (await library.commitStaging(s.id, undefined, s.receipt, undefined, self)).entry; } };
}
async function report(library) {
  const directory = await library.archiveDirectory(MATCH), manifest = await readArchiveManifest(directory);
  return readArchiveReport(directory, manifest, randomUUID());
}
function checkpoint(child, expected) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('Replacement child checkpoint timeout')); }, 15000);
    const message = m => { if (m?.kind === 'checkpoint') { cleanup(); assert.equal(m.phase, expected); resolve(); }
      else if (m?.kind === 'error') { cleanup(); reject(new Error(m.message)); } };
    const exit = code => { cleanup(); reject(new Error('Replacement child exited early: ' + code)); };
    function cleanup() { clearTimeout(timer); child.off('message', message); child.off('exit', exit); }
    child.on('message', message); child.on('exit', exit);
  });
}

test('explicit replacement keeps match identity, self selection and import time while invalidating derived cache', async t => {
  const s = await scope(t), before = await s.seed(), oldDirectory = await s.library.archiveDirectory(MATCH);
  await s.library.listWithPerformance();
  assert.equal(s.library.db.prepare('SELECT count(*) AS n FROM player_summary_cache').get().n, 1);
  const candidate = await stage(s.library, input({ generation: 'new' }));
  let committed = false;
  const result = await s.library.replaceStaging(candidate.id, MATCH, undefined, candidate.receipt, () => { committed = true; });
  assert.equal(committed, true); assert.equal(result.duplicate, false);
  assert.equal(result.entry.matchId, before.matchId); assert.equal(result.entry.selfPlayerId, '1');
  assert.equal(result.entry.importedAt, DATE); assert.equal(result.entry.versions.analysis, 'analysis-new');
  assert.equal(s.library.list().total, 1);
  const nextDirectory = await s.library.archiveDirectory(MATCH);
  assert.notEqual(nextDirectory, oldDirectory); assert.equal(existsSync(oldDirectory), false);
  assert.equal(s.library.db.prepare('SELECT count(*) AS n FROM player_summary_cache').get().n, 0);
  assert.equal((await report(s.library)).players[0].nickname, 'Player new');
  await s.reopen();
  assert.deepEqual(s.library.get(MATCH), result.entry); assert.equal(await s.library.archiveDirectory(MATCH), nextDirectory);
  const packagePath = join(s.owned.directory, 'updated.cs2a');
  await writePortableArchive(nextDirectory, packagePath);
  const exported = await verifyPortableArchive(packagePath);
  assert.equal(exported.manifest.versions.analysis, 'analysis-new');
  const ordinaryDuplicate = await stage(s.library, input());
  assert.equal((await s.library.commitStaging(ordinaryDuplicate.id)).duplicate, true);
  assert.equal(s.library.get(MATCH).versions.analysis, 'analysis-new', 'ordinary import never opts into replacement');
  assert.equal((await s.library.remove([MATCH])).removed[0], MATCH);
  assert.equal(existsSync(nextDirectory), false); assert.equal((await s.library.storage()).matchCount, 0);
});

test('replacement includes new full canonical sources, chunks and capabilities', async t => {
  const s = await scope(t); await s.seed();
  const f = fixture(); f.match.id = MATCH; f.replay.matchId = MATCH; f.spatial.matchId = MATCH;
  const sessionId = randomUUID(), replay = new ReplaySession(f.match, f.replay, sessionId);
  const heatmap = createHeatmapSession(f.match, f.replay, f.spatial, sessionId, { map });
  const playerId = f.match.players[0].steamId;
  assert.equal((await s.library.setSelfPlayer(MATCH, null)).kind, 'success');
  const data = { ...f, createdAt: DATE, versions, chunks: replay.chunks,
    report: { schemaVersion: 2, match: { id: MATCH, fileName: 'demo2.dem', map: f.match.map, rounds: f.match.rounds.length, score: null },
      selectedPlayer: playerId, players: f.match.players.map(p => ({ id: p.steamId, nickname: p.nickname ?? p.steamId })),
      analytics: [], findings: [], timeline: [], analysis: { players: [], perPlayer: [] }, deepReview: { available: true, players: [] },
      replay: replay.metadata, heatmap: heatmap.metadata } };
  const candidate = await stage(s.library, data);
  const result = await s.library.replaceStaging(candidate.id, MATCH, undefined, candidate.receipt);
  assert.equal(result.entry.selfPlayerId, null, 'an unselected identity stays unselected');
  const directory = await s.library.archiveDirectory(MATCH), verified = await verifyLibraryArchive(directory);
  assert.equal(verified.manifest.files.filter(f => f.role === 'replay-chunk').length, replay.chunks.size);
  assert.equal(verified.manifest.capabilities.heatmap.status, 'available');
  assert.equal(verified.manifest.capabilities.replay.status, 'available');
  assert.deepEqual((await readArchiveSources(directory, verified.manifest)).match, f.match);
});

for (const [label, data, expected] of [
  ['wrong source SHA', input({ id: 'b'.repeat(64), generation: 'new' }), /DEM.*不一致/],
  ['lost selected identity', input({ playerId: '2', generation: 'new' }), /玩家身份/],
  ['changed import time', input({ generation: 'new', createdAt: '2026-10-25T00:00:00.000Z' }), /原导入时间/],
]) {
  test(`replacement rejects ${label} without changing the original archive`, async t => {
    const s = await scope(t), before = await s.seed(), directory = await s.library.archiveDirectory(MATCH);
    const bytes = readFileSync(join(directory, 'report.json.gz')), candidate = await stage(s.library, data);
    await assert.rejects(s.library.replaceStaging(candidate.id, MATCH, undefined, candidate.receipt), expected);
    assert.deepEqual(s.library.get(MATCH), before); assert.equal(await s.library.archiveDirectory(MATCH), directory);
    assert.deepEqual(readFileSync(join(directory, 'report.json.gz')), bytes);
    await s.library.discardStaging(candidate.id);
  });
}

test('writer rejects noncanonical preserved creation times before writing payloads', async t => {
  const s = await scope(t);
  for (const date of ['invalid', '2026-02-30T00:00:00.000Z', '2026-10-21', 123]) {
    const candidate = await s.library.createStaging();
    await assert.rejects(writeLibraryArchive(candidate.directory, input({ createdAt: date })), /creation date/);
    assert.deepEqual(readdirSync(candidate.directory), []);
    await s.library.discardStaging(candidate.id);
  }
});

for (const phase of ['validated', 'before-rename', 'after-rename', 'before-index-commit']) {
  for (const failure of ['cancel', 'I/O']) {
    test(`replacement ${failure} at ${phase} leaves the old snapshot available`, async t => {
      const s = await scope(t), before = await s.seed(), original = await s.library.archiveDirectory(MATCH);
      const bytes = readFileSync(join(original, 'report.json.gz')), controller = new AbortController();
      await s.reopen({ phase: name => { if (name === phase) { if (failure === 'cancel') controller.abort(); else throw Object.assign(new Error('Controlled I/O failure'), { code: 'ENOSPC' }); } } });
      const candidate = await stage(s.library, input({ generation: 'new' }));
      let committed = false;
      await assert.rejects(s.library.replaceStaging(candidate.id, MATCH, controller.signal, candidate.receipt, () => { committed = true; }));
      assert.equal(committed, false); assert.deepEqual(s.library.get(MATCH), before);
      assert.equal(await s.library.archiveDirectory(MATCH), original); assert.deepEqual(readFileSync(join(original, 'report.json.gz')), bytes);
      await s.library.discardStaging(candidate.id);
      await s.reopen(); assert.deepEqual(s.library.get(MATCH), before);
      assert.deepEqual(readdirSync(join(s.root, 'matches')), [MATCH]);
    });
  }
}

test('a failed SQLite pointer transaction rolls back the new report and derived-cache invalidation', async t => {
  const s = await scope(t), before = await s.seed(); await s.library.listWithPerformance();
  s.library.db.exec("CREATE TRIGGER reject_reanalysis BEFORE UPDATE OF archive_key ON matches BEGIN SELECT RAISE(ABORT, 'Controlled commit failure'); END");
  const candidate = await stage(s.library, input({ generation: 'new' }));
  await assert.rejects(s.library.replaceStaging(candidate.id, MATCH), /Controlled commit failure/);
  assert.deepEqual(s.library.get(MATCH), before);
  assert.equal(s.library.db.prepare('SELECT count(*) AS n FROM player_summary_cache').get().n, 1);
  assert.equal((await report(s.library)).players[0].nickname, 'Player old');
  await s.library.discardStaging(candidate.id);
});

test('durable replacement notifies before asynchronous observers and ignores cancellation after commit', async t => {
  const s = await scope(t); await s.seed(); const controller = new AbortController(), order = [];
  await s.reopen({ phase: async phase => { if (phase === 'after-index-commit') { order.push('observer'); controller.abort(); throw new Error('Observer failure'); } } });
  const candidate = await stage(s.library, input({ generation: 'new' }));
  const result = await s.library.replaceStaging(candidate.id, MATCH, controller.signal, candidate.receipt, () => order.push('committed'));
  assert.deepEqual(order, ['committed', 'observer']); assert.equal(result.entry.versions.analysis, 'analysis-new');
  await s.reopen(); assert.equal(s.library.get(MATCH).versions.analysis, 'analysis-new');
});

test('a superseded generation that cannot be cleaned never rolls back the committed new report', async t => {
  const s = await scope(t); await s.seed(); const oldDirectory = await s.library.archiveDirectory(MATCH);
  const outside = join(s.owned.directory, 'outside'); mkdirSync(outside);
  const redirect = join(oldDirectory, 'locked-reader-placeholder'), diagnostics = [];
  // A junction deliberately makes the guarded deletion refuse the old directory.
  // Introduce it only after the old archive has passed verification and the new row committed.
  await s.reopen({ phase: phase => { if (phase === 'after-index-commit') symlinkSync(outside, redirect, 'junction'); },
    diagnostic: message => diagnostics.push(message) });
  const candidate = await stage(s.library, input({ generation: 'new' }));
  const result = await s.library.replaceStaging(candidate.id, MATCH, undefined, candidate.receipt);
  assert.equal(result.entry.versions.analysis, 'analysis-new'); assert.ok(existsSync(oldDirectory));
  assert.ok(diagnostics.some(message => message.includes('cleanup deferred')));
  await s.reopen({ diagnostic: message => diagnostics.push(message) });
  assert.equal(s.library.get(MATCH).state, 'ready'); assert.equal((await report(s.library)).players[0].nickname, 'Player new');
  assert.ok(existsSync(oldDirectory), 'a still-obstructed orphan is retained without blocking the new report');
  rmSync(redirect); await s.reopen();
  assert.equal(existsSync(oldDirectory), false); assert.equal(s.library.get(MATCH).state, 'ready');
});

test('v2 migration adds the internal archive pointer without rewriting historical bytes or preference', async t => {
  const s = await scope(t), before = await s.seed(), directory = await s.library.archiveDirectory(MATCH);
  const bytes = readFileSync(join(directory, 'manifest.json')); s.library.close();
  const db = new DatabaseSync(join(s.root, 'library.db'));
  db.exec('ALTER TABLE matches DROP COLUMN archive_key; PRAGMA user_version=2'); db.close();
  await s.reopen(); assert.deepEqual(s.library.get(MATCH), before);
  assert.equal(await s.library.archiveDirectory(MATCH), directory); assert.deepEqual(readFileSync(join(directory, 'manifest.json')), bytes);
  assert.equal(s.library.db.prepare('PRAGMA user_version').get().user_version, 3);
});

test('crash recovery keeps the exact old or new generation according to the committed pointer', async t => {
  const s = await scope(t), original = await s.seed();
  const template = join(s.owned.directory, 'candidate-template'); mkdirSync(template);
  await writeLibraryArchive(template, input({ generation: 'new' }));
  const childPath = fileURLToPath(new URL('./local-library-reanalysis-child.mjs', import.meta.url));
  for (const phase of ['after-rename', 'before-index-commit', 'after-index-commit']) {
    s.library.close();
    const child = spawn(process.execPath, [childPath, s.root, template, MATCH, phase], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    try { await checkpoint(child, phase); const ended = once(child, 'exit'); child.kill('SIGKILL'); await ended; }
    finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); } }
    await s.reopen();
    const current = s.library.get(MATCH);
    assert.equal(current.selfPlayerId, original.selfPlayerId); assert.equal(current.importedAt, original.importedAt);
    assert.equal(current.versions.analysis, phase === 'after-index-commit' ? 'analysis-new' : 'analysis-old');
    assert.equal((await report(s.library)).players[0].nickname, phase === 'after-index-commit' ? 'Player new' : 'Player old');
    assert.equal(readdirSync(join(s.root, 'matches')).length, 1); assert.deepEqual(readdirSync(join(s.root, 'staging')), []);
  }
});

test('a corrupt internal pointer is rejected without following or deleting another match generation', async t => {
  const s = await scope(t), original = await s.seed();
  s.library.db.prepare('UPDATE matches SET archive_key=? WHERE match_id=?').run('../outside', MATCH);
  await assert.rejects(s.library.archiveDirectory(MATCH), /归档位置/);
  assert.equal((await s.library.remove([MATCH])).failed.length, 1);
  await s.reopen();
  assert.ok(existsSync(join(s.root, 'matches', MATCH)), 'uncertain match bytes must be retained for explicit recovery');
  assert.equal(s.library.list().total, 1);
  s.library.db.prepare('UPDATE matches SET archive_key=? WHERE match_id=?').run(MATCH, MATCH);
  assert.equal(s.library.get(MATCH).state, 'invalid');
  assert.equal(s.library.get(MATCH).selfPlayerId, original.selfPlayerId);
});

test('a well-formed but nonexistent generation pointer cannot delete the only complete archive during recovery', async t => {
  const s = await scope(t); await s.seed();
  const candidate = await stage(s.library, input({ generation: 'new' }));
  await s.library.replaceStaging(candidate.id, MATCH, undefined, candidate.receipt);
  const goodDirectory = await s.library.archiveDirectory(MATCH), before = readFileSync(join(goodDirectory, 'manifest.json'));
  s.library.db.prepare('UPDATE matches SET archive_key=? WHERE match_id=?').run(MATCH + '.' + randomUUID(), MATCH);
  await s.reopen();
  assert.ok(existsSync(goodDirectory), 'a valid pointer format is not proof that the referenced archive exists');
  assert.deepEqual(readFileSync(join(goodDirectory, 'manifest.json')), before);
  assert.equal(s.library.get(MATCH).state, 'invalid');
  s.library.db.prepare('UPDATE matches SET archive_key=? WHERE match_id=?').run(goodDirectory.split(/[\\/]/).at(-1), MATCH);
  assert.equal((await readArchiveManifest(goodDirectory)).versions.analysis, 'analysis-new');
});
