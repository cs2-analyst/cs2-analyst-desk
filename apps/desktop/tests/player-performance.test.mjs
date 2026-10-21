import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createOwnedTempDirectory, assertOwnedDirectory } from '../../../scripts/owned-qa-run.mjs';
import { LocalMatchLibrary } from '../electron/local-library.ts';
import { readArchiveManifest, readArchiveReport, writeLibraryArchive } from '../electron/library-archive.ts';
import { reportPlayerSummaries, upgradeReportPerformance, validCachedPlayerSummaries } from '../electron/player-performance.ts';

const versions = { application: '0.2.0', archive: 1, report: 2, replay: 1, analysis: 'test-analysis', parser: 'test-parser', native: 'test-native',
  sampling: 'test', mapResource: 'test-map', sourceRevision: '1'.repeat(40) };
function player(playerId, changes = {}) {
  return { playerId, kills: 25, deaths: 20, assists: 4, roundsPlayed: 24, adr: 91.375, headshotPercentage: 68,
    performanceCoverage: { countsComplete: true, roundsAligned: true, headshotsComplete: false },
    kast: { percentage: 75, complete: true, rounds: 18, eligibleRounds: 24 },
    trade: { rate: 20, complete: true, kills: 4, tradedDeaths: 4, tradeableDeaths: 20 },
    opening: { kills: 4, deaths: 0, winRate: 1 }, utility: { heDamage: 50, fireDamage: 0, flashAssists: 0 },
    clutch: { complete: true, wins: 1, opportunities: 2, list: [{ round: 24, opponents: 3, won: true }, { round: 3, opponents: 2, won: false }] },
    coverage: { complete: true, notes: [] }, ...changes };
}
function report(id = 'a'.repeat(64)) {
  return { schemaVersion: 2, match: { id, fileName: 'demo1.dem', map: 'de_dust2', rounds: 24, score: { initialCT: 13, initialT: 11 } },
    selectedPlayer: 'one', players: [{ id: 'one', nickname: 'One' }, { id: 'two', nickname: 'Two' }],
    analytics: [player('one'), player('two', { kills: 5, deaths: 24, assists: 0, adr: 20, kast: { percentage: 25, complete: true, rounds: 6, eligibleRounds: 24 } })],
    findings: [], timeline: ['one', 'two'].map(playerId => ({ playerId, rounds: Array.from({ length: 24 }, (_, index) => ({ round: index + 1,
      side: 'CT', result: (index < 13) === (playerId === 'one') ? 'win' : 'loss',
      scoreAfter: { initialCT: Math.min(13, index + 1), initialT: Math.max(0, index - 12) }, startTick: index * 1000, events: [] })) })),
    analysis: { players: [], perPlayer: ['one', 'two'].map(playerId => ({ playerId, multiKills: { double: 2, triple: 1, quad: 0, fivePlus: 0 } })) },
    deepReview: { available: false, players: [] } };
}
function input(id) {
  const r = report(id);
  return { match: { id: r.match.id, map: r.match.map, players: r.players.map(p => ({ steamId: p.id })),
    rounds: Array.from({ length: 24 }, (_, index) => ({ number: index + 1, events: [] })) },
    replay: null, spatial: null, chunks: new Map(), versions, report: r };
}
async function scope(t) {
  const owned = createOwnedTempDirectory('player-performance-tests');
  const root = join(owned.directory, 'library');
  let library = await LocalMatchLibrary.open(root);
  t.after(async () => { library.close(); assertOwnedDirectory(owned); await rm(owned.directory, { recursive: true, force: true }); });
  return { root, get library() { return library; }, async reopen() { library.close(); library = await LocalMatchLibrary.open(root); },
    async seed(id = 'a'.repeat(64), data = input(id)) { const staged = await library.createStaging(); const receipt = await writeLibraryArchive(staged.directory, data);
      return (await library.commitStaging(staged.id, undefined, receipt)).entry; } };
}

test('legacy report is upgraded from saved metrics with formula precision and player isolation', () => {
  const r = report();
  const one = upgradeReportPerformance(r).analytics[0].performance;
  const expected = 0.0073 * 75 + 0.3591 * (25 / 24) - 0.5329 * (20 / 24)
    + 0.2372 * (2.13 * (25 / 24) + 0.42 * (4 / 24) - 0.41) + 0.0032 * 91.375 + 0.1587;
  assert.equal(one.rating.value, expected);
  assert.equal(one.rating.algorithm, 'hltv-2.0-community-approx-v1');
  assert.deepEqual(one.highlights.map(h => h.type), ['clutch', 'multi-kill', 'opening']);
  assert.ok(one.rating.value > r.analytics[1].performance.rating.value);
  assert.deepEqual(upgradeReportPerformance(r), r, 'upgrade is idempotent');
});
test('100 matches with 10 players stay within IPC budget through exact SQL-page limits without skipping records', async t => {
  const s = await scope(t);
  for (let index = 0; index < 100; index++) {
    const id = index.toString(16).padStart(64, '0'), data = input(id), r = data.report;
    const base = upgradeReportPerformance(r).analytics[0];
    r.players = Array.from({ length: 10 }, (_, playerIndex) => ({ id: `player-${playerIndex}`, nickname: `Player ${playerIndex}` }));
    r.selectedPlayer = r.players[0].id;
    r.analytics = r.players.map(p => ({ ...base, playerId: p.id, performance: { ...base.performance,
      highlights: base.performance.highlights.map(h => ({ ...h, tooltip: h.tooltip + '真实证据'.repeat(90) })) } }));
    data.match.players = r.players.map(p => ({ steamId: p.id }));
    await s.seed(id, data);
  }
  const seen = new Set(); let offset = 0, reduced = false;
  while (offset < 100) {
    const page = await s.library.listWithPerformance({ limit: 100, offset, direction: 'asc' });
    assert.equal(page.kind, 'success'); assert.equal(page.total, 100);
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 512 * 1024);
    assert.equal(page.entries.length, Math.min(page.limit, 100 - offset));
    if (page.limit < 100) reduced = true;
    for (const entry of page.entries) {
      assert.equal(seen.has(entry.matchId), false); seen.add(entry.matchId);
      assert.equal(entry.playerSummaries.length, 10);
    }
    offset += page.limit;
  }
  assert.equal(seen.size, 100); assert.equal(reduced, true);
});
test('missing, incomplete or mismatched legacy inputs stay unavailable instead of zero', () => {
  for (const patch of [{ adr: null }, { performanceCoverage: { countsComplete: false, roundsAligned: true } }, { kills: undefined },
    { kast: { percentage: 75, complete: true, eligibleRounds: 23 } }, { roundsPlayed: 0 }]) {
    const r = report(); r.analytics = [player('one', patch)];
    const rating = upgradeReportPerformance(r).analytics[0].performance.rating;
    assert.equal(rating.status, 'unavailable'); assert.equal(rating.value, null); assert.ok(rating.reason);
  }
});
test('old coverage.complete cannot prove unknown-teamkill attribution; legacy rating stays unavailable', () => {
  const r = report(); delete r.analytics[0].performanceCoverage;
  const performance = upgradeReportPerformance(r).analytics[0].performance;
  assert.equal(r.analytics[0].coverage.complete, true);
  assert.equal(performance.rating.status, 'unavailable'); assert.equal(performance.rating.value, null);
  assert.match(performance.rating.reason, /旧报告.*覆盖证明/);
  assert.equal(performance.highlights.some(h => ['opening', 'assists', 'multi-kill', 'headshot'].includes(h.type)), false);
  assert.equal(performance.highlights.some(h => h.type === 'clutch'), true, 'independently proven clutch wins survive');
});
test('legacy headshot data lacks complete sample evidence, so precision is never guessed', () => {
  const r = report(); r.analytics = [player('one', { clutch: undefined, opening: undefined, trade: undefined })];
  r.analysis.perPlayer = [];
  assert.equal(upgradeReportPerformance(r).analytics[0].performance.highlights.some(h => h.type === 'headshot'), false);
});
test('summary result requires every player-relative round; ties are distinguished from unknown', () => {
  const r = report(); const summaries = reportPlayerSummaries(r);
  assert.deepEqual(summaries.playerSummaries.map(p => p.outcome), ['win', 'loss']);
  assert.equal(validCachedPlayerSummaries(summaries, ['one', 'two']), true);
  r.match.score = { initialCT: 12, initialT: 12 };
  for (const timeline of r.timeline) timeline.rounds.forEach((round, index) => {
    round.result = index < 12 ? 'win' : 'loss';
    round.scoreAfter = { initialCT: Math.min(12, index + 1), initialT: Math.max(0, index - 11) };
  });
  assert.deepEqual(reportPlayerSummaries(r).playerSummaries.map(p => p.outcome), ['draw', 'draw']);
  r.timeline[0].rounds[0].result = 'unknown';
  assert.equal(reportPlayerSummaries(r).playerSummaries[0].outcome, 'unknown');
  r.timeline = []; assert.ok(reportPlayerSummaries(r).playerSummaries.every(p => p.outcome === 'unknown'));
});
test('a player crossing stable teams is unknown even if their mixed record looks like a draw', () => {
  const r = report();
  r.timeline[0].rounds[0].result = 'loss'; // 12 wins / 12 losses, while actual stable teams scored 13:11.
  assert.equal(reportPlayerSummaries(r).playerSummaries[0].outcome, 'unknown');
});
test('missing player analytics yields null summary values and unavailable rating', () => {
  const r = report(); r.analytics = [];
  const p = reportPlayerSummaries(r).playerSummaries[0];
  assert.deepEqual([p.kills, p.deaths, p.assists, p.adr, p.kastPercentage], [null, null, null, null, null]);
  assert.equal(p.performance.rating.status, 'unavailable');
});
test('malformed optional performance is safely recalculated, and cache cannot mix roster identities', () => {
  const r = report(); r.analytics[0].performance = { rating: { value: Infinity }, highlights: null };
  const summary = reportPlayerSummaries(r);
  assert.equal(summary.playerSummaries[0].performance.rating.status, 'available');
  assert.equal(validCachedPlayerSummaries(summary, ['another']), false);
  summary.playerSummaries[1].playerId = 'one';
  assert.equal(validCachedPlayerSummaries(summary, ['one', 'two']), false);
});
test('paged lazy upgrade persists a separate cache while archive and catalogue snapshots remain immutable', async t => {
  const s = await scope(t); const first = await s.seed(); await s.seed('b'.repeat(64));
  const directory = await s.library.archiveDirectory(first.matchId);
  const manifestBefore = await readFile(join(directory, 'manifest.json'));
  const reportBefore = await readFile(join(directory, 'report.json.gz'));
  const listed = await s.library.listWithPerformance({ limit: 1, direction: 'asc' });
  assert.equal(listed.kind, 'success'); assert.equal(listed.entries.length, 1);
  assert.equal(listed.entries[0].selectedPlayer, 'one'); assert.equal(listed.entries[0].playerSummaries.length, 2);
  assert.deepEqual(s.library.get(first.matchId), first);
  assert.deepEqual(await readFile(join(directory, 'manifest.json')), manifestBefore);
  assert.deepEqual(await readFile(join(directory, 'report.json.gz')), reportBefore);
  const manifest = await readArchiveManifest(directory);
  const restored = await readArchiveReport(directory, manifest, randomUUID());
  assert.deepEqual(listed.entries[0].playerSummaries[0].performance, restored.analytics[0].performance);
  await s.reopen();
  s.library.close();
  const raw = new DatabaseSync(join(s.root, 'library.db'), { readOnly: true });
  assert.equal(raw.prepare('SELECT count(*) AS count FROM player_summary_cache').get().count, 1); raw.close();
  await s.reopen();
  // The warm cache never reads/decompresses the report again; explicit open retains full integrity verification.
  await writeFile(join(directory, 'report.json.gz'), 'temporarily unreadable');
  assert.deepEqual((await s.library.listWithPerformance({ limit: 1, direction: 'asc' })).entries[0].playerSummaries, listed.entries[0].playerSummaries);
  assert.equal(s.library.get(first.matchId).state, 'ready');
  await writeFile(join(directory, 'report.json.gz'), reportBefore);
});
test('unreadable legacy report only suppresses derived summary; no archive bytes or healthy state are changed', async t => {
  const s = await scope(t); const entry = await s.seed();
  const directory = await s.library.archiveDirectory(entry.matchId);
  const reportBytes = await readFile(join(directory, 'report.json.gz'));
  await writeFile(join(directory, 'report.json.gz'), 'bad temporary bytes');
  const result = await s.library.listWithPerformance();
  assert.equal(result.kind, 'success'); assert.equal(result.entries[0].playerSummaries, undefined);
  assert.equal(s.library.get(entry.matchId).state, 'ready');
  await writeFile(join(directory, 'report.json.gz'), reportBytes);
  assert.equal((await s.library.listWithPerformance()).entries[0].playerSummaries.length, 2);
});
test('corrupt derived cache is rebuilt from the same immutable report without changing archive state', async t => {
  const s = await scope(t); const entry = await s.seed();
  const expected = (await s.library.listWithPerformance()).entries[0].playerSummaries;
  s.library.close();
  const raw = new DatabaseSync(join(s.root, 'library.db'));
  raw.prepare('UPDATE player_summary_cache SET summary_json=? WHERE match_id=?')
    .run(JSON.stringify({ selectedPlayer: 'another-match-player', playerSummaries: [] }), entry.matchId);
  raw.close();
  await s.reopen();
  assert.deepEqual((await s.library.listWithPerformance()).entries[0].playerSummaries, expected);
  assert.equal(s.library.get(entry.matchId).state, 'ready');
});
test('different matches keep distinct summaries and removing one removes only its derived cache', async t => {
  const s = await scope(t); const first = await s.seed(); const second = await s.seed('b'.repeat(64));
  const result = await s.library.listWithPerformance(); assert.equal(result.entries.length, 2);
  assert.notEqual(result.entries[0].playerSummaries, result.entries[1].playerSummaries);
  assert.equal((await s.library.remove([first.matchId])).removed.length, 1);
  assert.equal((await s.library.listWithPerformance()).entries[0].matchId, second.matchId);
  s.library.close();
  const raw = new DatabaseSync(join(s.root, 'library.db'));
  assert.equal(raw.prepare('SELECT count(*) AS count FROM player_summary_cache').get().count, 1); raw.close();
});
