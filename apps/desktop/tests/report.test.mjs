import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyzeMatch } from '@cs2-analyst/analytics';
import { Demoparser2Provider } from '@cs2-analyst/dem-parser';
import { comparisonMetrics, comparisonValue, comparisonIncomplete, sortedComparison } from '../renderer/src/analysis-metrics.ts';
import { useReport } from '../renderer/src/store.ts';
import { displayPlayerName } from '../electron/player-name.ts';
import { analyzeDemoFile, buildDesktopReport } from '../electron/report.ts';
import { localDemFixture, allowedDemFile } from './local-dem-fixture.mjs';

const demo = process.env.DEM_TEST_FILE ? allowedDemFile(process.env.DEM_TEST_FILE) : localDemFixture('demo1.dem');
const hasDemo = existsSync(demo);

test('real demo flows through parser -> analytics -> findings into a serializable DTO', { skip: hasDemo ? false : 'demo1.dem not present' }, async () => {
  let timings;
  let parseCalls = 0;
  const spatialParse = Demoparser2Provider.prototype.parseWithSpatial;
  const oldParse = Demoparser2Provider.prototype.parse;
  Demoparser2Provider.prototype.parse = () => { throw new Error('Desktop must use only parseWithSpatial'); };
  Demoparser2Provider.prototype.parseWithSpatial = function(...args) { parseCalls++; return spatialParse.apply(this, args); };
  let result;
  try { result = await analyzeDemoFile(demo, undefined, t => { timings = t; }); }
  finally { Demoparser2Provider.prototype.parseWithSpatial = spatialParse; Demoparser2Provider.prototype.parse = oldParse; }
  assert.equal(parseCalls, 1);
  console.log('demo1 Desktop performance', JSON.stringify(timings));
  assert.equal(result.kind, 'success');
  const report = result.report;

  assert.equal(report.schemaVersion, 2);
  assert.deepEqual(report.deepReview.players.map(p => p.playerId), report.players.map(p => p.id));
  assertDeepDto(report);
  // Renderer-facing shape: JSON only, no domain events or native objects.
  assert.deepEqual(Object.keys(report), ['schemaVersion', 'match', 'selectedPlayer', 'players', 'analytics', 'findings', 'timeline', 'analysis', 'deepReview']);
  assert.deepEqual(JSON.parse(JSON.stringify(report)), report);

  assert.equal(report.match.map, 'de_dust2');
  assert.equal(report.match.fileName, 'demo1.dem');
  assert.equal(report.match.rounds, 24);
  assert.deepEqual(report.match.score, { initialCT: 13, initialT: 11 });
  assert.equal(report.players.length, 10);

  const twinkle = report.players.find(p => p.nickname === 'twinkle');
  assert.ok(twinkle, 'twinkle should be in the roster');
  assert.equal(report.selectedPlayer, twinkle.id, 'twinkle is the default selected player');

  const p = report.analytics.find(a => a.playerId === twinkle.id);
  assert.equal(p.kills, 25);
  assert.equal(p.deaths, 20);
  assert.equal(p.assists, 4);
  assert.equal(p.roundsPlayed, 24);
  assert.equal(p.adr, 91.375);
  assert.equal(p.kast.percentage, 75);
  assert.equal(p.kast.complete, true);
  assert.ok(Math.abs(p.trade.rate - (4 / 18) * 100) < 1e-9);
  assert.equal(p.trade.complete, true);
  assert.deepEqual(p.opening, { kills: 4, deaths: 0, winRate: 1 });
  assert.deepEqual(p.clutch.list.find(c => c.round === 24), { round: 24, opponents: 3, won: true });

  // Findings for the selected player: three capped issues, then two highlights.
  const mine = report.findings.filter(f => f.playerId === twinkle.id).map(f => f.ruleId);
  assert.deepEqual(mine, [
    'side-impact.ct-gap', 'trade.low-rate', 'team-flash.frequent-effects',
    'clutch.win.r24', 'opening.positive',
  ]);
  for (const finding of report.findings.filter(f => f.playerId === twinkle.id)) {
    assert.ok(finding.title && finding.summary, 'findings carry a title and summary');
    assert.ok(finding.evidence.length > 0, 'findings carry evidence');
  }

  // Presentation-only round clock: real seconds inside the round, derived from
  // (eventTick - roundStartTick) / tickRate, never the absolute tick.
  const timed = report.findings.filter(f => f.playerId === twinkle.id)
    .flatMap(f => f.evidence).filter(e => e.round !== undefined && e.tick !== undefined);
  assert.ok(timed.length > 0, 'demo1 evidence carries round and tick');
  for (const e of timed) {
    assert.equal(typeof e.roundTimeSeconds, 'number', `missing round time for ${e.metric}`);
    assert.ok(Number.isFinite(e.roundTimeSeconds) && e.roundTimeSeconds >= 0, 'round time is a non-negative number');
    assert.ok(e.roundTimeSeconds < e.tick / 64, 'round time is relative to the round start, not the absolute tick');
  }
  const r4 = timed.find(e => e.metric === 'utility.flash.teammate.evidence.victim' && e.round === 4 && e.tick === 17120);
  assert.ok(r4, 'R4 teammate-flash evidence is present');
  assert.ok(Math.abs(r4.roundTimeSeconds - (17120 - 15416) / 64) < 1e-9,
    'R4 flash round time equals (eventTick - roundStartTick) / tickRate');

  // Round Timeline is a read-only projection of the same Match facts, one entry per player.
  assert.equal(report.timeline.length, report.players.length);
  const timeline = report.timeline.find(t => t.playerId === twinkle.id);
  assert.equal(timeline.rounds.length, 24);
  const nicknameOf = id => report.players.find(p => p.id === id)?.nickname ?? '未知玩家';
  const allowedTypes = new Set([
    'kill', 'death', 'bomb-plant-start', 'bomb-planted',
    'bomb-defuse-start', 'bomb-defused', 'bomb-exploded', 'clutch-start',
  ]);
  for (const entry of report.timeline) {
    assert.deepEqual(entry.rounds.map(r => r.round), Array.from({ length: 24 }, (_, i) => i + 1));
    for (const r of entry.rounds) {
      for (const e of r.events) {
        assert.ok(allowedTypes.has(e.type), `unexpected timeline event type ${e.type}`);
        assert.equal(typeof e.roundTimeSeconds, 'number', `timeline event ${e.id} lost its round time`);
        assert.ok(e.roundTimeSeconds >= 0 && e.roundTimeSeconds < e.tick / 64, 'time is relative to the round start');
        assert.ok(!/tick \d+/.test(e.description) && !e.description.includes(String(e.tick)), 'raw tick never leaks into the description');
        if (e.actorId) assert.equal(e.actorName, nicknameOf(e.actorId), 'actor is presented by nickname');
        if (e.targetId) assert.equal(e.targetName, nicknameOf(e.targetId), 'target is presented by nickname');
      }
    }
  }

  // R24 golden: T side, win, 13 : 11, clutch start, bomb lifecycle and twinkle kills.
  const r24 = timeline.rounds.find(r => r.round === 24);
  assert.equal(r24.side, 'T');
  assert.equal(r24.result, 'win');
  assert.deepEqual(r24.scoreAfter, { initialCT: 13, initialT: 11 });
  assert.equal(r24.startTick, 131657);
  const clutch = r24.events.find(e => e.type === 'clutch-start');
  assert.ok(clutch, 'R24 shows the proven 1v3 clutch start');
  assert.equal(clutch.opponents, 3);
  assert.equal(clutch.description, '进入 1v3 残局');
  assert.ok(Math.abs(clutch.roundTimeSeconds - (135415 - 131657) / 64) < 1e-9);
  assert.ok(r24.events.some(e => e.type === 'bomb-plant-start'));
  assert.ok(r24.events.some(e => e.type === 'bomb-planted'));
  const r24Kills = r24.events.filter(e => e.type === 'kill');
  assert.ok(r24Kills.length >= 4, 'R24 keeps every twinkle kill');
  assert.ok(r24Kills.every(e => e.actorName === 'twinkle'));
  const r24Time = r24.events.find(e => e.type === 'kill' && e.tick === 138685);
  assert.ok(Math.abs(r24Time.roundTimeSeconds - (138685 - 131657) / 64) < 1e-9,
    'timeline time comes from the real tick and round start, never a hardcoded value');
  const r24Weapons = r24Kills.map(e => e.weapon).filter(Boolean);
  assert.ok(r24Weapons.includes('ak47'), 'kill weapons come from the event');

  // R7: twinkle 3K plus a proven defuse.
  const r7 = timeline.rounds.find(r => r.round === 7);
  assert.equal(r7.side, 'CT');
  assert.equal(r7.result, 'win');
  const r7Kills = r7.events.filter(e => e.type === 'kill');
  assert.equal(r7Kills.length, 3, 'R7 is a twinkle 3K');
  assert.ok(r7Kills.every(e => e.actorName === 'twinkle' && e.targetName));
  assert.ok(r7.events.some(e => e.type === 'bomb-defuse-start'));
  assert.ok(r7.events.some(e => e.type === 'bomb-defused'));

  // R22: the posthumous kill is a legal death of the target and must not be dropped.
  const r22 = timeline.rounds.find(r => r.round === 22);
  assert.equal(r22.side, 'T');
  assert.equal(r22.result, 'loss');
  const posthumous = r22.events.find(e => e.type === 'death' && e.tick === 121153);
  assert.ok(posthumous, 'posthumous kill by an already-dead killer is preserved');
  assert.equal(posthumous.actorName, 'tarkz');
  assert.equal(posthumous.targetName, 'twinkle');
  assert.ok(r22.events.some(e => e.type === 'kill' && e.tick === 121075), 'the victim-side kill is still shown');
  assert.equal(report.analysis.players.length, 10);
  const comparison = report.analysis.players.find(p => p.playerId === twinkle.id);
  assert.equal(comparison.playerName, 'twinkle');
  assert.equal(comparison.kdRatio, 1.25);
  assert.equal(comparison.adr, 91.375);
  assert.equal(comparison.kastPercentage, 75);
  assert.equal(comparison.openingWinRate, 1);
  assert.equal(comparison.tradeRate, p.trade.rate);
  const analysis = report.analysis.perPlayer.find(p => p.playerId === twinkle.id);
  assert.deepEqual(analysis.multiKills, { double: 6, triple: 1, quad: 1, fivePlus: 0 });
  const frozen = analyzeMatch(await new Demoparser2Provider().parse(demo)).players.find(p => p.steamId === twinkle.id);
  assert.deepEqual(analysis.multiKills, { double: frozen.multiKills.counts[2], triple: frozen.multiKills.counts[3],
    quad: frozen.multiKills.counts[4], fivePlus: frozen.multiKills.counts[5] });
  assert.equal(analysis.roundTrend.length, 24);
  for (const [round, side, result, kills, died] of [
    [7, 'CT', 'win', 3, false], [24, 'T', 'win', 4, false], [22, 'T', 'loss', 1, true],
  ]) {
    const point = analysis.roundTrend.find(r => r.round === round);
    assert.deepEqual(point, { round, side, result, kills, died, complete: true });
  }
  assert.deepEqual(analysis.sideSplit, {
    CT: { roundsPlayed: 12, kills: 10, deaths: 10, assists: 3, adr: 68.25 },
    T: { roundsPlayed: 12, kills: 15, deaths: 10, assists: 1, adr: 114.5 },
  });

});

test('an unreadable DEM returns an error result instead of throwing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cs2-analyst-'));
  try {
    const bad = join(dir, 'broken.dem');
    writeFileSync(bad, 'not a demo');
    const result = await analyzeDemoFile(bad);
    assert.equal(result.kind, 'error');
    assert.match(result.message, /无法分析此 DEM/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing DEM path returns an error result instead of throwing', async () => {
  const result = await analyzeDemoFile(join(tmpdir(), 'cs2-analyst-missing', 'gone.dem'));
  assert.equal(result.kind, 'error');
  assert.match(result.message, /无法分析此 DEM/);
});

/**
 * Minimal one-round match with enough evidence for a valid report. The event list
 * deliberately mixes low-value events (weapon fire, damage, utility, flash, bomb
 * pickup) that the Round Timeline must never surface.
 */
function syntheticMatch() {
  const state = (boundary, tick, ctAlive, tAlive) => ({
    boundary, tick, availability: 'observed', unidentifiedPlayerCount: 0,
    players: [
      { steamId: '1', side: 'CT', alive: ctAlive, participant: true },
      { steamId: '2', side: 'T', alive: tAlive, participant: true },
    ],
  });
  return {
    id: 'synthetic', map: 'de_test', tickRate: 64,
    players: [
      { steamId: '1', nickname: 'Alice', team: 'CT' },
      { steamId: '2', nickname: 'Bob', team: 'T' },
    ],
    rounds: [{
      number: 1, winner: 'CT', startTick: 1000, freezeEndTick: 1064, endTick: 2000,
      stateSnapshots: [state('start', 1000, true, true), state('freeze_end', 1064, true, true), state('end', 2000, true, false)],
      events: [
        { type: 'weapon_fire', tick: 1090, shooter: '1', shooterSide: 'CT', weapon: 'ak47' },
        { type: 'damage', tick: 1095, attacker: '1', victim: '2', attackerSide: 'CT', victimSide: 'T', healthDamage: 100, armorDamage: 0, healthRemaining: 0, armorRemaining: 0 },
        { type: 'kill', tick: 1100, killer: '1', victim: '2', weapon: 'ak47', headshot: false, killerSide: 'CT', victimSide: 'T', teamkill: false },
        { type: 'utility', tick: 1200, utility: 'smoke', action: 'detonate', thrower: '1', throwerSide: 'CT' },
        { type: 'flash', tick: 1250, attacker: '1', victim: '2', attackerSide: 'CT', victimSide: 'T', blindDurationSeconds: 1 },
        { type: 'bomb', tick: 1400, action: 'pickup', player: '2', playerSide: 'T' },
        { type: 'bomb', tick: 1500, action: 'plant_start', player: '2', playerSide: 'T' },
        { type: 'bomb', tick: 1700, action: 'planted', player: '2', playerSide: 'T' },
      ],
    }],
  };
}

test('timeline filters to high-value events, maps nicknames and computes round time', () => {
  const match = syntheticMatch();
  const report = buildDesktopReport(match, 'synthetic.dem');
  assert.deepEqual(Object.keys(report), ['schemaVersion', 'match', 'selectedPlayer', 'players', 'analytics', 'findings', 'timeline', 'analysis', 'deepReview']);
  assert.deepEqual(report.match.score, { initialCT: 1, initialT: 0 });

  const alice = report.timeline.find(t => t.playerId === '1').rounds[0];
  assert.equal(alice.side, 'CT');
  assert.equal(alice.result, 'win');
  assert.deepEqual(alice.scoreAfter, { initialCT: 1, initialT: 0 });
  assert.equal(alice.startTick, 1000);
  // The proven 1v1 clutch, the kill and the plant lifecycle survive; weapon fire,
  // damage, utility, flash and the bomb pickup never become timeline events.
  assert.deepEqual(alice.events.map(e => e.type), ['clutch-start', 'kill', 'bomb-plant-start', 'bomb-planted']);
  assert.deepEqual(alice.events[0], {
    id: '1:clutch-start:1064:1:-', type: 'clutch-start', tick: 1064, roundTimeSeconds: 1,
    actorId: '1', actorName: 'Alice', opponents: 1, description: '进入 1v1 残局',
  });
  const kill = alice.events[1];
  assert.equal(kill.actorName, 'Alice');
  assert.equal(kill.targetName, 'Bob');
  assert.equal(kill.description, 'Alice → Bob');
  assert.equal(kill.weapon, 'ak47');
  assert.ok(Math.abs(kill.roundTimeSeconds - (1100 - 1000) / 64) < 1e-9);
  assert.equal(alice.events[2].description, '开始安放炸弹');
  assert.equal(alice.events[2].actorName, 'Bob');
  assert.equal(alice.events[3].description, '炸弹安放完成');

  // The victim sees the death and the same bomb events, but no kill of their own.
  const bob = report.timeline.find(t => t.playerId === '2').rounds[0];
  assert.equal(bob.side, 'T');
  assert.equal(bob.result, 'loss');
  assert.deepEqual(bob.events.map(e => e.type), ['clutch-start', 'death', 'bomb-plant-start', 'bomb-planted']);
  assert.equal(bob.events[1].description, 'Alice → Bob');

  assert.deepEqual(JSON.parse(JSON.stringify(report)), report, 'timeline DTO is JSON-only');
  assert.deepEqual(buildDesktopReport(match, 'synthetic.dem'), report, 'same input yields the same timeline');
});

test('an explicit self player overrides the default target only when it belongs to the report', () => {
  const match = syntheticMatch();
  assert.equal(buildDesktopReport(match, 'synthetic.dem', undefined, undefined, '2').selectedPlayer, '2');
  assert.equal(buildDesktopReport(match, 'synthetic.dem', undefined, undefined, 'absent').selectedPlayer, '1');
  assert.equal(buildDesktopReport(match, 'synthetic.dem').selectedPlayer, '1');
});

test('timeline omits round time instead of guessing when the tick rate is unknown', () => {
  const match = syntheticMatch();
  delete match.tickRate;
  const report = buildDesktopReport(match, 'synthetic.dem');
  for (const entry of report.timeline) {
    for (const round of entry.rounds) {
      assert.ok(round.events.length > 0, 'events are still listed');
      for (const event of round.events) {
        assert.equal('roundTimeSeconds' in event, false, 'no time is invented without a tick rate');
      }
    }
  }
});

test('timeline yields no events when the formal round window is incomplete', () => {
  const match = syntheticMatch();
  const incomplete = { ...match.rounds[0], number: 2 };
  delete incomplete.startTick;
  match.rounds = [match.rounds[0], incomplete];
  const report = buildDesktopReport(match, 'synthetic.dem');
  const [completeRound, incompleteRound] = report.timeline[0].rounds;
  assert.ok(completeRound.events.length > 0);
  assert.equal(incompleteRound.startTick, null);
  assert.deepEqual(incompleteRound.events, []);
});

test('timeline keeps side, result and score unknown instead of guessing', () => {
  const match = syntheticMatch();
  match.rounds[0].winner = null;
  for (const snapshot of match.rounds[0].stateSnapshots) {
    for (const player of snapshot.players) player.side = 'Unknown';
  }
  const report = buildDesktopReport(match, 'synthetic.dem');
  const round = report.timeline[0].rounds[0];
  assert.equal(round.side, 'Unknown');
  assert.equal(round.result, 'unknown');
  assert.equal(round.scoreAfter, null);
  assert.equal(report.match.score, null);
  // Events themselves are not gated on the side; only the labels stay unknown.
  assert.ok(round.events.some(e => e.type === 'kill'));
});


test('player names preserve supplied nicknames and raw IDs, falling back only for blank names', () => {
  for (const name of [undefined, null, '', '  ', '\t\n']) {
    assert.equal(displayPlayerName('id', name), '未知玩家');
  }
  for (const name of ['id', '12345', ' twinkle ', '8888888888888888888888', '76561198000000000', '8'.repeat(30)]) {
    assert.equal(displayPlayerName('id', name), name);
    assert.equal(displayPlayerName(name, name), name);
  }
  for (const name of [undefined, null, '', '  ', '2', ' twinkle ', '8888888888888888888888']) {
    const match = syntheticMatch();
    match.players[1].nickname = name;
    const report = buildDesktopReport(match, 'synthetic.dem');
    const expected = name?.trim() ? name : '未知玩家';
    assert.equal(report.players[1].id, '2');
    assert.equal(report.players[1].nickname, expected);
    assert.equal(report.analysis.players.find(p => p.playerId === '2').playerName, expected);
    const kill = report.timeline[0].rounds[0].events.find(e => e.type === 'kill');
    assert.equal(kill.targetId, '2');
    assert.equal(kill.targetName, expected);
    assert.equal(kill.description, `Alice → ${expected}`);
    const death = report.timeline[1].rounds[0].events.find(e => e.type === 'death');
    assert.equal(death.actorId, '1');
    assert.equal(death.targetId, '2');
    assert.equal(death.targetName, expected);
    const actor = report.timeline[1].rounds[0].events.find(e => e.actorId === '2');
    assert.ok(actor);
    assert.equal(actor.actorName, expected);
  }
  const match = syntheticMatch();
  match.rounds[0].events.find(e => e.type === 'kill').victim = '8888888888888888888888';
  const unknown = buildDesktopReport(match, 'synthetic.dem').timeline[0].rounds[0].events.find(e => e.type === 'kill');
  assert.equal(unknown.targetId, '8888888888888888888888');
  assert.equal(unknown.targetName, '未知玩家');
});


test('analysis projects frozen metrics exactly, preserving null and incomplete evidence', () => {
  const match = syntheticMatch();
  delete match.tickRate;
  match.players[1].nickname = '8888888888888888888888';
  const source = analyzeMatch(match);
  const report = buildDesktopReport(match, 'synthetic.dem');
  for (const p of source.players) {
    const projected = report.analysis.players.find(x => x.playerId === p.steamId);
    assert.deepEqual(projected, {
      playerId: p.steamId, playerName: displayPlayerName(p.steamId, p.nickname),
      kills: p.kills, deaths: p.deaths, assists: p.assists, kdRatio: p.kdRatio,
      adr: p.adr, headshotPercentage: p.headshotPercentage,
      kastPercentage: p.kast.percentage, kastComplete: p.kast.complete,
      openingWinRate: p.opening.winRate, tradeRate: p.trade.tradeRate,
      tradeComplete: p.trade.complete, tradeKills: p.trade.tradeKills,
    });
    const projectedSides = report.analysis.perPlayer.find(x => x.playerId === p.steamId).sideSplit;
    assert.deepEqual(report.analysis.perPlayer.find(x => x.playerId === p.steamId).multiKills, {
      double: p.multiKills.counts[2], triple: p.multiKills.counts[3],
      quad: p.multiKills.counts[4], fivePlus: p.multiKills.counts[5],
    });
    for (const side of ['CT', 'T']) {
      const original = p.side[side];
      assert.deepEqual(projectedSides[side], {
        roundsPlayed: original.roundsPlayed, kills: original.kills, deaths: original.deaths,
        assists: original.assists, adr: original.adr,
      });
    }
  }
  const alice = report.analysis.players[0];
  assert.equal(alice.kdRatio, null, 'zero deaths keeps K/D null');
  assert.equal(alice.tradeRate, null, 'no applicable deaths keeps trade null');
  const incomplete = { ...alice, kastComplete: false, tradeComplete: false };
  assert.equal(comparisonIncomplete(incomplete, 'kastPercentage'), true);
  assert.equal(comparisonIncomplete(incomplete, 'tradeRate'), true);
  assert.equal(comparisonIncomplete(incomplete, 'tradeKills'), true);
  for (const metric of comparisonMetrics) {
    assert.equal(comparisonValue({ ...alice, [metric.key]: null }, metric), '—');
    const entries = [{ ...alice, playerId: 'null', [metric.key]: null },
      { ...alice, playerId: 'zero', [metric.key]: 0 }, { ...alice, playerId: 'high', [metric.key]: 2 }];
    assert.deepEqual(sortedComparison(entries, metric.key).map(p => p.playerId), ['high', 'zero', 'null']);
    assert.equal(entries[0].playerId, 'null', 'sorting never mutates DTO');
  }
  const formats = { adr: '91.38', kdRatio: '1.25', kastPercentage: '75.0%', headshotPercentage: '40.0%',
    openingWinRate: '100.0%', tradeRate: '22.2%', tradeKills: '4' };
  const values = { ...alice, adr: 91.375, kdRatio: 1.25, kastPercentage: 75, headshotPercentage: 40,
    openingWinRate: 1, tradeRate: 4 / 18 * 100, tradeKills: 4 };
  for (const metric of comparisonMetrics) assert.equal(comparisonValue(values, metric), formats[metric.key]);
});

test('round trend distinguishes a missing window from confirmed zero kills', () => {
  const match = syntheticMatch();
  const incomplete = { ...match.rounds[0], number: 2 };
  delete incomplete.endTick;
  match.rounds.push(incomplete);
  const report = buildDesktopReport(match, 'synthetic.dem');
  assert.equal(report.analysis.perPlayer[0].roundTrend[1].complete, false);
  assert.equal(report.analysis.perPlayer[0].roundTrend[0].complete, true);
});

test('kill/death DTO copies optional kill flags without inventing absent evidence', () => {
  for (const flags of [{}, { headshot: false, assistedFlash: false }, { headshot: true, assistedFlash: true }]) {
    const match = syntheticMatch();
    const event = match.rounds[0].events.find(e => e.type === 'kill');
    delete event.headshot;
    Object.assign(event, flags);
    const report = buildDesktopReport(match, 'synthetic.dem');
    for (const player of report.timeline) {
      const projected = player.rounds[0].events.find(e => e.type === 'kill' || e.type === 'death');
      for (const key of ['headshot', 'assistedFlash']) {
        assert.equal(projected[key], flags[key]);
        assert.equal(key in projected, key in flags);
      }
    }
  }
});

/** Internal domain vocabulary that must never reach user-visible Deep Review text. */
const INTERNAL_COPY_TERMS = ['Engagement', 'direct contact', 'evidence', 'partial', 'coverage', 'linkage',
  'received', 'return contact', 'same-tick', 'eventIndex', 'fireEvidence', 'denominator'];

function assertDeepDto(report) {
  assert.deepEqual(JSON.parse(JSON.stringify(report)), report);
  const inspect = value => {
    if (value === null || typeof value !== 'object') return;
    assert.ok(Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype);
    for (const [key, child] of Object.entries(value)) {
      assert.ok(!['suppressedRules', 'diagnostics', 'eventIndex', 'engagementId', 'tick', 'spatial', 'events'].includes(key), key);
      inspect(child);
    }
  };
  inspect(report.deepReview);
  for (const p of report.deepReview.players) {
    for (const f of [...p.reviews, ...p.highlights, ...p.contexts]) {
      assert.ok(f.relatedRounds.every(r => report.timeline.find(t => t.playerId === p.playerId).rounds.some(round => round.round === r)));
      assert.ok(!('evidenceQuality' in f), 'Desktop DTO must not expose the internal evidence quality field');
      if (f.ruleId.startsWith('deep.impact.')) assert.equal(f.occurrenceLabel, null, `impact finding ${f.ruleId} must not expose the candidate count`);
      const copy = [f.title, f.summary, f.occurrenceLabel ?? '', ...f.caveats].join('\n');
      for (const token of INTERNAL_COPY_TERMS) assert.ok(!copy.includes(token), `${token} leaked into user copy of ${f.ruleId}: ${copy}`);
    }
  }
}

test('Nuke Desktop integrates shared spatial pipeline, JSON DTO and deterministic per-player results', async () => {
  const file = localDemFixture('nuke.dem');
  assert.ok(existsSync(file), 'Nuke integration fixture required');
  let timings;
  const result = await analyzeDemoFile(file, undefined, t => { timings = t; });
  assert.equal(result.kind, 'success');
  console.log('Nuke Desktop performance', JSON.stringify(timings));
  const report = result.report;
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.deepReview.available, true);
  assert.equal(report.deepReview.players.length, 10);
  assert.deepEqual(report.deepReview.players.map(p => p.playerId), report.players.map(p => p.id));
  assert.ok(report.deepReview.players.some(p => p.reviews.length + p.highlights.length + p.contexts.length > 0));
  assert.equal(report.analytics.length, 10);
  assert.ok(report.findings.length > 0);
  assertDeepDto(report);
  const again = await analyzeDemoFile(file);
  assert.equal(again.kind, 'success');
  assert.deepEqual(again.report, report);
});

test('unavailable V2 identity coverage preserves the basic report without fallback findings', () => {
  const match = syntheticMatch();
  // P3 can report an identity which Findings V2 explicitly cannot identify.
  const rename = value => {
    if (!value || typeof value !== 'object') return;
    for (const key of Object.keys(value)) {
      if (value[key] === '1') value[key] = 'unidentified';
      else rename(value[key]);
    }
  };
  rename(match);
  const report = buildDesktopReport(match, 'synthetic.dem');
  const player = report.deepReview.players.find(p => p.playerId === 'unidentified');
  assert.equal(player.coverage.status, 'unavailable');
  assert.deepEqual([player.reviews, player.highlights, player.contexts], [[], [], []]);
  assert.ok(report.analytics.find(p => p.playerId === 'unidentified'));
  assertDeepDto(report);
});

test('switching every target player selects existing DTOs without importing or reanalyzing', () => {
  const report = buildDesktopReport(syntheticMatch(), 'synthetic.dem');
  let imports = 0;
  globalThis.window = { cs2Analyst: { importDemo: () => { imports++; throw new Error('Unexpected import'); } } };
  try {
    useReport.setState({ report, playerId: report.selectedPlayer, status: 'success' });
    for (const player of report.players) {
      useReport.getState().selectPlayer(player.id);
      const state = useReport.getState();
      assert.equal(state.playerId, player.id);
      assert.equal(state.report, report);
      assert.equal(state.report.deepReview.players.find(p => p.playerId === state.playerId), report.deepReview.players.find(p => p.playerId === player.id));
    }
    useReport.getState().selectPlayer('not-a-player');
    assert.equal(useReport.getState().playerId, report.players.at(-1).id);
    assert.equal(imports, 0);
  } finally {
    delete globalThis.window;
    useReport.setState({ report: null, playerId: '', status: 'idle' });
  }
});
