import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDesktopSpatialFacts } from '../electron/spatial-facts.ts';
import { isDesktopSpatialFacts } from '../../../packages/report-contract/dist/index.js';
import { convertNativePrefix } from '../../../packages/dem-parser/dist/local-evidence.js';
import { resolvePrefixRoster } from '../../../packages/analytics/dist/index.js';

const ids = Array.from({ length: 10 }, (_, i) => String(76561198000000001n + BigInt(i)));
const A = ids[0], B = ids[5], sha = 'a'.repeat(64);
const victims = [ids[1], ids[6], ids[2], ids[7], ids[3], ids[8], ids[4], ids[9]];
const sideNumber = player => ids.indexOf(player) < 5 ? 3 : 2;
function raw() {
  return { id: sha, header: { map_name: 'de_test' }, events: [
    { event_name: 'round_start', tick: 10, total_rounds_played: 0 },
    { event_name: 'round_freeze_end', tick: 20, total_rounds_played: 0 },
    ...victims.map((victim, index) => ({ event_name: 'player_death', tick: index === 7 ? 40 : 30 + index,
      total_rounds_played: 0, user_steamid: victim, user_team_num: sideNumber(victim),
      attacker_steamid: index % 2 === 0 ? B : A, attacker_team_num: index % 2 === 0 ? 2 : 3 })),
  ], stateRows: ids.map(player => ({ tick: 20, steamid: player, team_num: sideNumber(player), is_alive: true })) };
}
function access(input = raw(), transform = rows => rows) {
  return { rawInput: input, parserVersion: 'pinned-test', playerIds: ids,
    queryExactTicks(ticks, players) {
      assert.ok(ticks.length <= 64 && players.length <= 10);
      const rows = ticks.flatMap(tick => players.map(player => ({ tick, steamid: player,
        team_num: sideNumber(player), is_alive: true, health: 100, yaw: 0, pitch: 0,
        X: ids.indexOf(player) * 100 + tick, Y: ids.indexOf(player) * 10, Z: 0,
        active_weapon_name: 'test-weapon' })));
      return transform(rows);
    } };
}

test('exact rows create event facts and a 1v1 formation without tactical claims', async () => {
  const result = await buildDesktopSpatialFacts(access());
  assert.equal(isDesktopSpatialFacts(result, sha, ids), true);
  assert.equal(result.coverage.deathTicks, 8);
  assert.equal(result.coverage.eventCards, 8);
  assert.equal(result.coverage.formationCards, 1);
  const event = result.cards.find(card => card.kind === 'event-prestate' && card.eventTick === 30);
  assert.equal(event.sampleTick, 29);
  assert.equal(event.participants[0].role, 'killer');
  assert.equal(event.participants[1].role, 'victim');
  assert.equal(event.retrospectiveSelection, true);
  assert.equal(event.horizontal, Math.hypot(event.participants[0].position.x - event.participants[1].position.x,
    event.participants[0].position.y - event.participants[1].position.y));
  const formation = result.cards.find(card => card.kind === 'one-vs-one-formation');
  assert.equal(formation.eventTick, 40);
  assert.equal(formation.startTick, 36);
  assert.equal(formation.interiorNotEvaluatedTicks, 3);
  const forged = structuredClone(result);
  forged.cards.find(card => card.kind === 'one-vs-one-formation').participants[0].startPosition.x += 1;
  assert.equal(isDesktopSpatialFacts(forged, sha, ids), false);
  assert.ok(!JSON.stringify(result).includes('visibility') && !JSON.stringify(result).includes('intention'));
});

test('future events do not alter earlier cards, while missing or conflicting exact rows withhold them', async () => {
  const baseline = await buildDesktopSpatialFacts(access());
  const future = raw();future.events.push({ event_name: 'player_death', tick: 100,
    total_rounds_played: 1, user_steamid: '987654321', user_team_num: 2 });
  const changed = await buildDesktopSpatialFacts(access(future));
  assert.deepEqual(changed.cards.filter(card => card.eventTick <= 40), baseline.cards);
  const missing = await buildDesktopSpatialFacts(access(raw(), rows => rows.filter(row =>
    !(row.tick === 29 && row.steamid === B))));
  assert.equal(missing.cards.some(card => card.kind === 'event-prestate' && card.eventTick === 30), false);
  assert.ok(missing.coverage.withheld > baseline.coverage.withheld);
  const conflict = await buildDesktopSpatialFacts(access(raw(), rows => {
    const target = rows.find(row => row.tick === 29 && row.steamid === B);
    return target ? [...rows, { ...target, X: target.X + 1 }] : rows;
  }));
  assert.equal(conflict.cards.some(card => card.kind === 'event-prestate' && card.eventTick === 30), false);
});

test('native query failure degrades spatial facts without inventing numbers', async () => {
  const source = access();source.queryExactTicks = () => { throw new Error('native failure'); };
  const result = await buildDesktopSpatialFacts(source);
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'extraction-failed');
  assert.deepEqual(result.cards, []);
  assert.equal(isDesktopSpatialFacts(result, sha, ids), true);
});

test('contradictory health and alive fields withhold the affected fact', async () => {
  const result = await buildDesktopSpatialFacts(access(raw(), rows => rows.map(row =>
    row.tick === 29 && row.steamid === B ? { ...row, health: 0, is_alive: true } : row)));
  assert.equal(result.cards.some(card => card.kind === 'event-prestate' && card.eventTick === 30), false);
  assert.ok(result.coverage.withheld > 0);
});

test('future-only input overflow preserves earlier cards and marks bounded coverage', async () => {
  const baseline = await buildDesktopSpatialFacts(access());
  const input = raw();
  input.events.push(...Array.from({ length: 20001 }, (_, i) => ({ event_name: 'weapon_fire', tick: 100 + i })));
  input.stateRows.push(...Array.from({ length: 4097 }, (_, i) => ({ tick: 100 + i })));
  const result = await buildDesktopSpatialFacts(access(input));
  assert.deepEqual(result.cards, baseline.cards);
  assert.equal(result.coverage.truncated, true);
});

test('post-round deaths never become round event cards', async () => {
  const input = raw();input.events.push({ event_name: 'round_end', tick: 25,
    total_rounds_played: 0, winner: 'CT' });
  const result = await buildDesktopSpatialFacts(access(input));
  assert.equal(result.status, 'unavailable');
  assert.equal(result.coverage.eventCards, 0);
  assert.equal(result.coverage.formationCards, 0);
});

test('an incomplete freeze roster records 1v1 evidence as withheld', async () => {
  const input = raw();input.stateRows.pop();
  const result = await buildDesktopSpatialFacts(access(input));
  assert.equal(result.coverage.formationCards, 0);
  assert.ok(result.coverage.formationProbes > 0);
  assert.ok(result.coverage.withheld > 0);
});

test('a combined query failure retries fact classes independently', async () => {
  const baseline = await buildDesktopSpatialFacts(access());
  const source = access(), original = source.queryExactTicks;
  source.queryExactTicks = (ticks, players) => {
    if (ticks.length > 8) throw new Error('combined query rejected');
    return original(ticks, players);
  };
  const result = await buildDesktopSpatialFacts(source);
  assert.deepEqual(result.cards, baseline.cards);
  assert.equal(result.coverage.eventCards, 8);
  assert.equal(result.coverage.formationCards, 1);
});

test('the eight-death prefilter matches exhaustive prefix roster checks, including atomic deaths and restarts', async () => {
  const exhaustive = input => {
    const ticks = [...new Set(input.events.filter(event => event.event_name === 'player_death')
      .map(event => event.tick))].sort((a, b) => a - b);
    return ticks.filter(eventTick => {
      const prefix = convertNativePrefix(input, eventTick + 1);
      const rounds = prefix.match.rounds.filter(round => round.events.some(event =>
        event.type === 'kill' && event.tick === eventTick));
      if (rounds.length !== 1) return false;
      const roster = resolvePrefixRoster(prefix, rounds[0].number);
      return roster.status === 'known' && roster.eligibleOneVsOne
        && roster.oneVsOneFormedAtTick === eventTick;
    });
  };
  const normal = raw();
  const atomic = raw();atomic.events.find(event => event.event_name === 'player_death' && event.tick === 36).tick = 40;
  const duplicateStart = raw();duplicateStart.events.push({ event_name: 'round_start', tick: 10, total_rounds_played: 0 });
  const restart = raw();restart.events.push({ event_name: 'round_start', tick: 34, total_rounds_played: 0 });
  for (const input of [normal, atomic, duplicateStart, restart]) {
    const expected = exhaustive(input);
    const actual = (await buildDesktopSpatialFacts(access(input))).cards
      .filter(card => card.kind === 'one-vs-one-formation').map(card => card.eventTick);
    assert.deepEqual(actual, expected);
  }
});
