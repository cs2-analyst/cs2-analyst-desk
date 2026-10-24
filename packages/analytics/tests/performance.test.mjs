import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Demoparser2Provider } from '@cs2-analyst/dem-parser';
import { analyzeMatch, computePlayerPerformance, computeRating, highlightRules, playerPerformanceInput, ratingAlgorithm,
  summarizePlayerPerformance } from '../dist/index.js';

const base = (extra = {}) => ({ kills: 20, deaths: 16, assists: 4, validRounds: 24, adr: 80,
  kastPercent: 75, kastEligibleRounds: 24, kastComplete: true, roundsAligned: true, countsComplete: true,
  ...extra });
const badges = extra => computePlayerPerformance(base(extra)).highlights;

test('community Rating standard sample agrees with independently expanded formula', () => {
  const rating = computeRating(base());
  assert.ok(Math.abs(rating.value - 1.2465653333333333) < 1e-12);
  assert.equal(rating.status, 'available');
  assert.equal(rating.reason, null);
  assert.equal(rating.algorithm, 'hltv-2.0-community-approx-v1');
  assert.equal(rating.algorithm, ratingAlgorithm);
  assert.notEqual(rating.value, Number(rating.value.toFixed(2)), 'storage keeps calculation precision');
});
test('KAST input uses percentage points; a 74.25 point difference adds exactly its coefficient', () => {
  const points = computeRating(base({ kastPercent: 75 }));
  const fraction = computeRating(base({ kastPercent: 0.75 }));
  assert.ok(Math.abs(points.value - fraction.value - 0.0073 * 74.25) < 1e-12);
});
test('zero valid rounds are unavailable, never Rating zero', () => {
  const result = computeRating(base({ validRounds: 0, kastEligibleRounds: 0 }));
  assert.equal(result.value, null);
  assert.equal(result.status, 'unavailable');
  assert.match(result.reason, /有效回合/);
});
for (const field of ['kills', 'deaths', 'assists', 'validRounds', 'adr', 'kastPercent', 'kastEligibleRounds']) {
  test(`Rating missing ${field} is unavailable`, () => {
    for (const value of [null, undefined]) {
      const result = computeRating(base({ [field]: value }));
      assert.equal(result.value, null);
      assert.match(result.reason, /缺少/);
      assert.equal(result.algorithm, ratingAlgorithm);
    }
  });
  test(`Rating rejects illegal ${field}`, () => {
    for (const value of [NaN, Infinity, -Infinity, -1, '20']) {
      const result = computeRating(base({ [field]: value }));
      assert.equal(result.status, 'unavailable', `${field}=${value}`);
      assert.match(result.reason, /非法/);
    }
  });
}
test('Rating rejects fractional counts and percentages over 100', () => {
  for (const field of ['kills', 'deaths', 'assists', 'validRounds', 'kastEligibleRounds']) {
    assert.equal(computeRating(base({ [field]: 0.5 })).value, null);
    assert.equal(computeRating(base({ [field]: Number.MAX_SAFE_INTEGER + 1 })).value, null);
  }
  assert.equal(computeRating(base({ kastPercent: 100.1 })).value, null);
});
for (const field of ['kastComplete', 'roundsAligned', 'countsComplete']) {
  test(`Rating requires ${field}`, () => {
    assert.equal(computeRating(base({ [field]: false })).status, 'unavailable');
    assert.match(computeRating(base({ [field]: false })).reason, /覆盖/);
  });
}
test('Rating refuses mismatched KAST and ADR denominators', () => {
  assert.equal(computeRating(base({ kastEligibleRounds: 23 })).value, null);
});
test('low, normal and high performance preserve order and negative values are not clamped', () => {
  const low = computeRating(base({ kills: 0, deaths: 24, assists: 0, adr: 0, kastPercent: 0 }));
  const normal = computeRating(base());
  const high = computeRating(base({ kills: 40, deaths: 8, assists: 12, adr: 150, kastPercent: 100 }));
  assert.ok(low.value < 0);
  assert.ok(low.value < normal.value && normal.value < high.value);
  for (const result of [low, normal, high]) assert.equal(result.algorithm, ratingAlgorithm);
});
test('pure calculation isolates players and matches and never mutates inputs', () => {
  const a = base();
  const b = base({ kills: 31 });
  const original = structuredClone(a);
  const a1 = computePlayerPerformance(a);
  const b1 = computePlayerPerformance(b);
  assert.notEqual(a1.rating.value, b1.rating.value);
  assert.deepEqual(computePlayerPerformance(a), a1);
  b1.highlights.push({ type: 'assists' });
  assert.deepEqual(computePlayerPerformance(a), a1);
  assert.deepEqual(a, original);
});

const examples = [
  { type: 'clutch', positive: { clutch: { wins: 1, complete: true, list: [{ round: 7, opponents: 2, won: true }] } },
    negative: { clutch: { wins: 0, complete: true, list: [{ round: 7, opponents: 2, won: false }] } },
    tooltip: '残局获胜：本场赢得 1 次残局，最高 1 对 2', evidence: { wins: 1, maxOpponents: 2 } },
  { type: 'multi-kill', positive: { multiKills: { double: 0, triple: 1, quad: 0, fivePlus: 0 } },
    negative: { multiKills: { double: 3, triple: 0, quad: 0, fivePlus: 0 } },
    tooltip: '多杀表现：本场 1 个三杀及以上回合（3 杀 1 次，4 杀 0 次，5 杀及以上 0 次）',
    evidence: { rounds: 1, triple: 1, quad: 0, fivePlus: 0, maxKills: 3 } },
  { type: 'opening', positive: { opening: { kills: 3, deaths: 2 } }, negative: { opening: { kills: 2, deaths: 0 } },
    tooltip: '突破表现：本场首杀 3 次，首死 2 次', evidence: { kills: 3, deaths: 2 } },
  { type: 'trade', positive: { trade: { kills: 3, complete: true } }, negative: { trade: { kills: 2, complete: true } },
    tooltip: '补枪贡献：本场成功补枪 3 次', evidence: { kills: 3 } },
  { type: 'assists', positive: { assists: 6 }, negative: { assists: 5 },
    tooltip: '助攻表现：本场有效助攻 6 次', evidence: { assists: 6 } },
  { type: 'headshot', positive: { kills: 15, headshotPercentage: 60, headshotsComplete: true },
    negative: { kills: 15, headshotPercentage: 59.9, headshotsComplete: true },
    tooltip: '精准击杀：爆头率 60.0%，有效击杀 15 次', evidence: { percentage: 60, kills: 15 } },
  { type: 'flash', positive: { flashAssists: 3 }, negative: { flashAssists: 2 },
    tooltip: '闪光支援：本场成功闪光助攻 3 次', evidence: { assists: 3 } },
  { type: 'utility', positive: { heDamage: 120, fireDamage: 80 }, negative: { heDamage: 120, fireDamage: 79 },
    tooltip: '道具输出：有效敌方伤害 200（HE 120，燃烧 80）', evidence: { damage: 200, heDamage: 120, fireDamage: 80 } },
];
for (const example of examples) {
  test(`${example.type} triggers at threshold with exact evidence and Tooltip`, () => {
    const [badge] = badges(example.positive);
    assert.equal(badge.type, example.type);
    assert.equal(badge.tooltip, example.tooltip);
    assert.deepEqual(badge.evidence, example.evidence);
    assert.equal(badge.label.length, 1);
  });
  test(`${example.type} does not trigger below threshold`, () => {
    assert.equal(badges(example.negative).length, 0);
  });
}
test('opening requires a positive opening balance', () => {
  assert.equal(badges({ opening: { kills: 3, deaths: 3 } }).length, 0);
  assert.equal(badges({ opening: { kills: 3, deaths: 4 } }).length, 0);
});
test('headshot requires minimum sample and complete known flags', () => {
  for (const kills of [1, 14]) {
    assert.equal(badges({ kills, headshotPercentage: 100, headshotsComplete: true }).length, 0);
  }
  assert.equal(badges({ kills: 20, headshotPercentage: 100, headshotsComplete: false }).length, 0);
});
test('ordinary kills cannot stand in for real trade kills; incomplete trade is suppressed', () => {
  assert.equal(badges({ kills: 40 }).length, 0);
  assert.equal(badges({ trade: { kills: 0, complete: true } }).length, 0);
  assert.equal(badges({ trade: { kills: 10, complete: false } }).length, 0);
});
test('clutch participation, unknown winner and inconsistent win totals cannot award a win badge', () => {
  for (const won of [false, null]) {
    assert.equal(badges({ clutch: { wins: 0, complete: true, list: [{ round: 1, opponents: 3, won }] } }).length, 0);
  }
  assert.equal(badges({ clutch: { wins: 1, complete: false, list: [{ round: 1, opponents: 3, won: true }] } }).length, 0);
  assert.equal(badges({ clutch: { wins: 1, complete: true, list: [] } }).length, 0);
  assert.equal(badges({ clutch: { wins: 2, complete: true, list: [
    { round: 1, opponents: 3, won: true }, { round: 1, opponents: 3, won: true },
  ] } }).length, 0);
});
test('missing or nonfinite optional metrics cannot invent highlights', () => {
  assert.equal(badges({}).length, 0);
  assert.equal(badges({ flashAssists: null, heDamage: null, fireDamage: null, headshotPercentage: null }).length, 0);
  assert.equal(badges({ flashAssists: NaN, heDamage: Infinity, fireDamage: 100,
    headshotPercentage: Infinity, headshotsComplete: true, opening: { kills: NaN, deaths: 0 },
    multiKills: { double: 0, triple: Infinity, quad: 0, fivePlus: 0 }, trade: { kills: NaN, complete: true } }).length, 0);
});
test('unknown damage type and flash duration are never substituted for HE/fire effective damage', () => {
  assert.equal(badges({ heDamage: 500, fireDamage: null, reportedDurationSeconds: 1000 }).length, 0);
  assert.equal(badges({ heDamage: 0, fireDamage: 0, reportedDurationSeconds: 1000 }).length, 0);
});
test('incomplete event attribution or participation suppresses event count badges', () => {
  for (const field of ['countsComplete', 'roundsAligned']) {
    assert.equal(badges({ [field]: false, assists: 10, opening: { kills: 4, deaths: 0 },
      multiKills: { double: 0, triple: 2, quad: 0, fivePlus: 0 },
      headshotPercentage: 80, headshotsComplete: true }).length, 0);
  }
});
test('every qualifying highlight is returned in stable priority without top-three truncation', () => {
  const all = Object.assign({}, ...examples.map(example => example.positive));
  const first = badges(all);
  assert.equal(first.length, 8);
  assert.deepEqual(first.map(b => b.type), ['clutch', 'multi-kill', 'opening', 'trade', 'headshot', 'flash', 'utility', 'assists']);
  assert.deepEqual(first.map(b => b.type), highlightRules.priority);
  assert.deepEqual(badges(Object.fromEntries(Object.entries(all).reverse())), first);
  assert.deepEqual(badges(all), first);
});
test('highlights remain independently available when ADR/KAST cannot support Rating', () => {
  const result = computePlayerPerformance(base({ adr: null, kastComplete: false, flashAssists: 3 }));
  assert.equal(result.rating.status, 'unavailable');
  assert.deepEqual(result.highlights.map(b => b.type), ['flash']);
});

const demoPath = fileURLToPath(new URL('../../../.demo/demo1.dem', import.meta.url));
test('real demo1 performance is deterministic, player-isolated and uses unchanged standard metrics',
  { skip: existsSync(demoPath) ? false : 'Local .demo/demo1.dem absent' }, async () => {
    const match = await new Demoparser2Provider().parse(demoPath);
    const analytics = analyzeMatch(match);
    const snapshot = structuredClone(analytics);
    const ratings = new Set();
    for (const player of analytics.players) {
      const performance = summarizePlayerPerformance(player);
      assert.deepEqual(computePlayerPerformance(playerPerformanceInput(player)), performance,
        'portable inputs preserve replaceable Rating and highlight evidence');
      assert.equal(performance.rating.status, 'available', player.nickname);
      const kpr = player.kills / player.roundsPlayed;
      const dpr = player.deaths / player.roundsPlayed;
      const apr = player.assists / player.roundsPlayed;
      const expected = 0.0073 * player.kast.percentage + 0.3591 * kpr - 0.5329 * dpr
        + 0.2372 * (2.13 * kpr + 0.42 * apr - 0.41) + 0.0032 * player.adr + 0.1587;
      assert.equal(performance.rating.value, expected);
      ratings.add(performance.rating.value);
      assert.equal(new Set(performance.highlights.map(b => b.type)).size, performance.highlights.length);
      assert.deepEqual(performance.highlights.map(b => b.type),
        highlightRules.priority.filter(type => performance.highlights.some(b => b.type === type)));
      for (const badge of performance.highlights) {
        if (badge.type === 'trade') assert.equal(badge.evidence.kills, player.trade.tradeKills);
        if (badge.type === 'clutch') assert.equal(badge.evidence.wins, player.clutch.list.filter(c => c.won === true).length);
        if (badge.type === 'utility') assert.equal(badge.evidence.damage, player.utility.he.enemyDamage + player.utility.fire.enemyDamage);
      }
      assert.deepEqual(summarizePlayerPerformance(player), performance);
      // Deliberate coverage faults prove the native adapter's independent gates.
      assert.equal(summarizePlayerPerformance({ ...player, utility: { ...player.utility,
        flash: { ...player.utility.flash, assists: null }, he: { ...player.utility.he, enemyDamage: null } } }).rating.value,
      performance.rating.value, 'utility gaps must not suppress Rating');
      assert.equal(summarizePlayerPerformance({ ...player, coverage: { ...player.coverage,
        skippedUnconfirmedParticipation: 1 } }).rating.status, 'unavailable');
      assert.equal(summarizePlayerPerformance({ ...player, coverage: { ...player.coverage,
        killsWithoutTeamkillStatus: 1 } }).rating.status, 'unavailable');
    }
    assert.ok(ratings.size > 1);
    assert.deepEqual(analytics, snapshot, 'performance must not alter existing analytics definitions');
  });
