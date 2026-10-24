import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeMatch, buildCoverage, buildRoundTimeline, coverageIssueSeverity,
  resolveRoundClutch, resolveRoundTrades, summarizePlayerPerformance,
} from "../dist/index.js";

const CT1 = "76561198000000001";
const CT2 = "76561198000000002";
const T1 = "76561198000000011";
const T2 = "76561198000000012";
const T3 = "76561198000000013";

function player(steamId, nickname) {
  return { steamId, nickname, team: "CT" };
}

function kill(tick, killer, victim, extra = {}) {
  return { type: "kill", tick, killer, victim, ...extra };
}

function state(steamId, side, alive = true) {
  return { steamId, side, alive, participant: true };
}

function snapshot(boundary, tick, states, extra = {}) {
  return { boundary, tick, availability: "observed", players: states, unidentifiedPlayerCount: 0, ...extra };
}

/** A round with start / freeze_end / end snapshots and a consistent alive baseline. */
function makeRound(number, sides, aliveAtEnd, events, options = {}) {
  const ids = Object.keys(sides);
  const start = options.start ?? number * 1000;
  const freeze = options.freeze ?? start + 10;
  const end = options.end ?? start + 500;
  const aliveSnapshots = () => ids.map(id => state(id, sides[id], true));
  const round = {
    number,
    winner: options.winner === undefined ? "CT" : options.winner,
    events,
    startTick: start,
    freezeEndTick: freeze,
    endTick: end,
    stateSnapshots: [
      snapshot("start", start, aliveSnapshots()),
      snapshot("freeze_end", freeze, aliveSnapshots(),
        options.unidentified ? { unidentifiedPlayerCount: options.unidentified } : {}),
      snapshot("end", end, ids.map(id => state(id, sides[id], aliveAtEnd[id] ?? true))),
    ],
  };
  if (options.lifecycle !== undefined) round.playerLifecycle = options.lifecycle;
  return round;
}

function mkMatch(players, rounds, tickRate = 64) {
  const match = { id: "synthetic-combat", map: "de_dust2", players, rounds };
  if (tickRate !== undefined) match.tickRate = tickRate;
  return match;
}

function byId(result, steamId) {
  return result.players.find(candidate => candidate.steamId === steamId);
}

const sides4 = { [CT1]: "CT", [CT2]: "CT", [T1]: "T", [T2]: "T" };

test("computes K, A, S and T components from the shared survival timeline", () => {
  const players = [player(CT1, "ct1"), player(CT2, "ct2"), player(T1, "t1"), player(T2, "t2")];
  const rounds = [
    // K: CT1 kills T1.
    makeRound(1, sides4, { [T1]: false },
      [kill(1050, CT1, T1, { killerSide: "CT", victimSide: "T", teamkill: false })]),
    // A: CT1 assists the enemy kill on T2.
    makeRound(2, sides4, { [T2]: false },
      [kill(2050, CT2, T2, {
        killerSide: "CT", victimSide: "T", teamkill: false, assister: CT1, assisterSide: "CT",
      })]),
    // S: no death and the end snapshot proves survival.
    makeRound(3, sides4, {}, []),
    // T: CT1 dies to T1 and CT2 trades the killer well inside the window.
    makeRound(4, sides4, { [CT1]: false, [T1]: false }, [
      kill(4050, T1, CT1, { killerSide: "T", victimSide: "CT", teamkill: false }),
      kill(4090, CT2, T1, { killerSide: "CT", victimSide: "T", teamkill: false }),
    ]),
  ];
  const result = analyzeMatch(mkMatch(players, rounds));
  const ct1 = byId(result, CT1);
  assert.deepEqual(ct1.kast, {
    rounds: 4,
    eligibleRounds: 4,
    playedRounds: 4,
    percentage: 100,
    killRounds: 1,
    assistRounds: 1,
    // Components overlap: CT1 also survived rounds 1-3, not only round 3.
    survivalRounds: 3,
    tradedRounds: 1,
    unavailableRounds: 0,
    ambiguousRounds: 0,
    degradedRounds: 0,
    complete: true,
  });
  assert.deepEqual(
    [ct1.trade.tradeKills, ct1.trade.tradedDeaths, ct1.trade.tradeableDeaths, ct1.trade.tradeRate],
    [0, 1, 1, 100]);
  assert.equal(ct1.trade.complete, true);
  assert.equal(byId(result, CT2).trade.tradeKills, 1);
  assert.deepEqual(result.tradeWindow, { seconds: 5, ticks: 320 });
  assert.equal(result.coverage.issues["survival-end-state-unavailable"], 0);
  assert.equal(result.coverage.issues["survival-timeline-anomaly"], 0);
});

test("never infers survival from a missing death when the end state is unobserved", () => {
  const players = [player(CT1, "ct1"), player(CT2, "ct2")];
  const round = {
    number: 1, winner: "CT", events: [],
    startTick: 1000, freezeEndTick: 1010, endTick: 1100,
    stateSnapshots: [
      snapshot("start", 1000, [state(CT1, "CT"), state(CT2, "CT")]),
      snapshot("freeze_end", 1010, [state(CT1, "CT"), state(CT2, "CT")]),
    ],
  };
  const result = analyzeMatch(mkMatch(players, [round]));
  assert.equal(result.coverage.issues["survival-end-state-unavailable"], 2);
  const ct1 = byId(result, CT1);
  assert.equal(ct1.kast.survivalRounds, 0);
  assert.equal(ct1.kast.eligibleRounds, 0);
  assert.equal(ct1.kast.unavailableRounds, 1);
  assert.equal(ct1.kast.percentage, null);
  assert.equal(ct1.kast.complete, false);
  assert.equal(result.coverage.severity.unavailable >= 2, true);
});

test("flags an end state that contradicts the death timeline and degrades KAST", () => {
  const players = [player(CT1, "ct1"), player(CT2, "ct2"), player(T1, "t1")];
  const sides = { [CT1]: "CT", [CT2]: "CT", [T1]: "T" };
  // The end snapshot claims CT1 is alive even though T1 killed them.
  const rounds = [makeRound(1, sides, { [CT1]: true },
    [kill(1050, T1, CT1, { killerSide: "T", victimSide: "CT", teamkill: false })])];
  const result = analyzeMatch(mkMatch(players, rounds));
  assert.equal(result.coverage.issues["survival-end-state-conflict"], 1);
  const ct1 = byId(result, CT1);
  // The death is still proven, so the round is a decidable KAST miss...
  assert.equal(ct1.kast.eligibleRounds, 1);
  assert.equal(ct1.kast.rounds, 0);
  // ...but the round is degraded, so completeness cannot be claimed.
  assert.equal(ct1.kast.degradedRounds, 1);
  assert.equal(ct1.kast.complete, false);
  // CT2 relied on the same suspect end snapshot for S.
  assert.equal(byId(result, CT2).kast.degradedRounds, 1);
});

for (const [name, conflictingPlayer, endAlive] of [
  ["recorded death but end snapshot alive", CT1, true],
  ["no recorded death but end snapshot dead", T2, false],
]) {
  test(`rejects trade and clutch evidence for ${name}`, () => {
    const players = Object.keys(sides4).map(id => player(id, id));
    const events = [
      kill(1050, T1, CT1, { killerSide: "T", victimSide: "CT", teamkill: false }),
      kill(1090, CT2, T1, { killerSide: "CT", victimSide: "T", teamkill: false }),
    ];
    const endStates = { [CT1]: false, [T1]: false };
    // The consistent control proves this round would produce both conclusions.
    const control = analyzeMatch(mkMatch(players, [makeRound(1, sides4, endStates, events)]));
    assert.equal(byId(control, CT2).trade.tradeKills, 1);
    assert.equal(byId(control, CT1).trade.tradedDeaths, 1);
    assert.ok(control.players.some(candidate => candidate.clutch.opportunities > 0));

    const match = mkMatch(players, [makeRound(1, sides4,
      { ...endStates, [conflictingPlayer]: endAlive }, events)]);
    const round = buildCoverage(match).rounds[0];
    const timeline = buildRoundTimeline(round);
    assert.equal(timeline.endStateSuspect, true);
    assert.equal(timeline.state(conflictingPlayer).endConflict, true);
    assert.equal(timeline.anomalies.length, 0);
    // The end-state gate applies even when the trade clock is unavailable.
    for (const windowTicks of [320, null]) {
      const trade = resolveRoundTrades(round, timeline, windowTicks);
      assert.equal(trade.resolved, false);
      assert.deepEqual(trade.trades, []);
      assert.equal(trade.tradeableDeaths.size, 0);
      assert.deepEqual(trade.ambiguities, []);
    }
    assert.deepEqual(resolveRoundClutch(round, timeline), {
      round: 1, opportunities: [], ineligible: true,
    });

    const result = analyzeMatch(match);
    assert.equal(result.coverage.issues["survival-end-state-conflict"], 1);
    assert.equal(result.coverage.issues["clutch-round-ineligible"], 1);
    assert.equal(result.coverage.severity.ambiguous, 1);
    assert.equal(result.coverage.severity.unavailable, 1);
    for (const candidate of result.players) {
      assert.equal(candidate.trade.tradeKills, 0);
      assert.equal(candidate.trade.tradedDeaths, 0);
      assert.equal(candidate.trade.tradeableDeaths, 0);
      assert.equal(candidate.trade.unavailableRounds, 1);
      assert.equal(candidate.trade.complete, false);
      assert.equal(candidate.trade.tradeRate, null);
      assert.equal(candidate.clutch.opportunities, 0);
      assert.deepEqual(candidate.clutch.list, []);
      assert.equal(candidate.kast.complete, false);
      assert.ok(candidate.kast.degradedRounds + candidate.kast.unavailableRounds > 0);
    }
  });
}

test("credits a trade exactly at the window edge and rejects one tick later", () => {
  const players = [player(CT1, "ct1"), player(CT2, "ct2"), player(T1, "t1")];
  const sides = { [CT1]: "CT", [CT2]: "CT", [T1]: "T" };
  const rounds = [
    makeRound(1, sides, { [CT1]: false, [T1]: false }, [
      kill(1050, T1, CT1, { killerSide: "T", victimSide: "CT", teamkill: false }),
      kill(1370, CT2, T1, { killerSide: "CT", victimSide: "T", teamkill: false }),
    ], { start: 1000, end: 1500 }),
    makeRound(2, sides, { [CT1]: false, [T1]: false }, [
      kill(2050, T1, CT1, { killerSide: "T", victimSide: "CT", teamkill: false }),
      kill(2371, CT2, T1, { killerSide: "CT", victimSide: "T", teamkill: false }),
    ], { start: 2000, end: 2600 }),
  ];
  const result = analyzeMatch(mkMatch(players, rounds));
  const ct1 = byId(result, CT1);
  assert.deepEqual([ct1.trade.tradedDeaths, ct1.trade.tradeableDeaths, ct1.trade.tradeRate], [1, 2, 50]);
  assert.equal(ct1.trade.windowTicks, 320);
  assert.equal(byId(result, CT2).trade.tradeKills, 1);
  assert.equal(result.coverage.issues["trade-same-tick-ambiguous"], 0);
  assert.equal(result.coverage.issues["trade-candidate-ambiguous"], 0);
});

test("refuses to order a same-tick trade and reports it as ambiguous", () => {
  const players = [player(CT1, "ct1"), player(CT2, "ct2"), player(T1, "t1")];
  const sides = { [CT1]: "CT", [CT2]: "CT", [T1]: "T" };
  const rounds = [makeRound(1, sides, { [CT1]: false, [T1]: false }, [
    kill(1050, T1, CT1, { killerSide: "T", victimSide: "CT", teamkill: false }),
    kill(1050, CT2, T1, { killerSide: "CT", victimSide: "T", teamkill: false }),
  ])];
  const result = analyzeMatch(mkMatch(players, rounds));
  assert.equal(result.coverage.issues["trade-same-tick-ambiguous"], 1);
  const ct1 = byId(result, CT1);
  assert.equal(ct1.trade.tradedDeaths, 0);
  assert.equal(ct1.trade.ambiguousDeaths, 1);
  assert.equal(ct1.trade.tradeRate, null);
  assert.equal(ct1.trade.complete, false);
  // The KAST round cannot be decided as a miss, so it leaves the denominator.
  assert.equal(ct1.kast.eligibleRounds, 0);
  assert.equal(ct1.kast.ambiguousRounds, 1);
  assert.equal(ct1.kast.percentage, null);
});

test("suppresses every time-based trade conclusion when the tick rate is unreliable", () => {
  const players = [player(CT1, "ct1"), player(CT2, "ct2"), player(T1, "t1")];
  const sides = { [CT1]: "CT", [CT2]: "CT", [T1]: "T" };
  const rounds = [makeRound(1, sides, { [CT1]: false, [T1]: false }, [
    kill(1050, T1, CT1, { killerSide: "T", victimSide: "CT", teamkill: false }),
    kill(1090, CT2, T1, { killerSide: "CT", victimSide: "T", teamkill: false }),
  ])];
  const result = analyzeMatch(mkMatch(players, rounds, null));
  assert.equal(result.coverage.issues["trade-tick-rate-unknown"], 1);
  assert.deepEqual(result.tradeWindow, { seconds: 5, ticks: null });
  const ct1 = byId(result, CT1);
  assert.equal(ct1.trade.available, false);
  assert.equal(ct1.trade.windowTicks, null);
  assert.equal(ct1.trade.tradeRate, null);
  assert.equal(ct1.trade.tradedDeaths, 0);
  // The death is still identified as tradeable: that part needs no clock.
  assert.equal(ct1.trade.tradeableDeaths, 1);
  assert.equal(ct1.kast.unavailableRounds, 1);
  assert.equal(ct1.kast.eligibleRounds, 0);
});

test("excludes teamkills, world deaths and unknown sides from trade evidence", () => {
  const players = [player(CT1, "ct1"), player(CT2, "ct2"), player(T1, "t1")];
  const sides = { [CT1]: "CT", [CT2]: "CT", [T1]: "T" };
  const rounds = [
    makeRound(1, sides, { [CT1]: false },
      [kill(1050, CT2, CT1, { killerSide: "CT", victimSide: "CT", teamkill: true })]),
    makeRound(2, sides, { [CT1]: false },
      [kill(2050, "world", CT1, { killerSide: "Unknown", victimSide: "CT" })]),
    makeRound(3, sides, { [CT1]: false },
      [kill(3050, T1, CT1, { killerSide: "Unknown", victimSide: "CT" })]),
  ];
  const result = analyzeMatch(mkMatch(players, rounds));
  const ct1 = byId(result, CT1);
  assert.deepEqual(
    [ct1.trade.tradeKills, ct1.trade.tradedDeaths, ct1.trade.tradeableDeaths], [0, 0, 0]);
  assert.equal(ct1.trade.tradeRate, null);
  assert.equal(byId(result, CT2).trade.tradeKills, 0);
});

test("marks a death tradeable only while a teammate is still alive", () => {
  const players = [player(CT1, "ct1"), player(T1, "t1")];
  const sides = { [CT1]: "CT", [T1]: "T" };
  const rounds = [makeRound(1, sides, { [CT1]: false },
    [kill(1050, T1, CT1, { killerSide: "T", victimSide: "CT", teamkill: false })])];
  const result = analyzeMatch(mkMatch(players, rounds));
  const ct1 = byId(result, CT1);
  assert.equal(ct1.trade.tradeableDeaths, 0);
  assert.equal(ct1.trade.tradedDeaths, 0);
  assert.equal(ct1.trade.tradeRate, null);
});

test("records clutch opportunities by opponent count and only wins the round for the winner", () => {
  const players = [
    player(CT1, "ct1"), player(CT2, "ct2"),
    player(T1, "t1"), player(T2, "t2"), player(T3, "t3"),
  ];
  const sidesTwo = { [CT1]: "CT", [CT2]: "CT", [T1]: "T" };
  const sidesFive = { [CT1]: "CT", [CT2]: "CT", [T1]: "T", [T2]: "T", [T3]: "T" };
  const rounds = [
    // CT2 dies, CT1 stands alone against one and wins the round.
    makeRound(1, sidesTwo, { [CT2]: false, [T1]: false }, [
      kill(1050, T1, CT2, { killerSide: "T", victimSide: "CT", teamkill: false }),
      kill(1100, CT1, T1, { killerSide: "CT", victimSide: "T", teamkill: false }),
    ], { winner: "CT" }),
    // CT2 dies, CT1 stands alone against three and loses the round.
    makeRound(2, sidesFive, { [CT2]: false }, [
      kill(2050, T1, CT2, { killerSide: "T", victimSide: "CT", teamkill: false }),
    ], { winner: "T" }),
  ];
  const result = analyzeMatch(mkMatch(players, rounds));
  const ct1 = byId(result, CT1);
  assert.deepEqual(ct1.clutch.byOpponents, { 1: 1, 2: 0, 3: 1, 4: 0, 5: 0 });
  assert.deepEqual(ct1.clutch.winsByOpponents, { 1: 1, 2: 0, 3: 0, 4: 0, 5: 0 });
  assert.equal(ct1.clutch.opportunities, 2);
  assert.equal(ct1.clutch.wins, 1);
  assert.deepEqual(
    ct1.clutch.list.map(entry => [entry.round, entry.opponents, entry.won]),
    [[1, 1, true], [2, 3, false]]);
  assert.equal(result.coverage.issues["clutch-round-ineligible"], 0);
});

test("omits clutch for a round with an unexplained lifecycle change", () => {
  const players = [player(CT1, "ct1"), player(CT2, "ct2"), player(T1, "t1")];
  const sides = { [CT1]: "CT", [CT2]: "CT", [T1]: "T" };
  const rounds = [makeRound(1, sides, { [CT2]: false }, [
    kill(1050, T1, CT2, { killerSide: "T", victimSide: "CT", teamkill: false }),
  ], { lifecycle: [{ type: "disconnect", tick: 1060, player: T1 }] })];
  const result = analyzeMatch(mkMatch(players, rounds));
  assert.equal(result.coverage.issues["survival-timeline-anomaly"], 1);
  assert.equal(result.coverage.issues["clutch-round-ineligible"], 1);
  assert.equal(byId(result, CT1).clutch.opportunities, 0);
  // KAST and trade also refuse the round instead of guessing state.
  assert.equal(byId(result, CT1).kast.unavailableRounds, 1);
  assert.equal(byId(result, CT1).trade.unavailableRounds, 1);
});

test("post-death disconnects preserve the proven KAST, trade, clutch and Rating results", () => {
  const players = Object.keys(sides4).map(id => player(id, id));
  const events = [
    kill(1050, T1, CT1, { killerSide: "T", victimSide: "CT", teamkill: false }),
    kill(1090, CT2, T1, { killerSide: "CT", victimSide: "T", teamkill: false }),
  ];
  const end = { [CT1]: false, [T1]: false };
  const control = analyzeMatch(mkMatch(players, [makeRound(1, sides4, end, events)]));
  const match = mkMatch(players, [makeRound(1, sides4, end, events, { lifecycle: [
    { type: "disconnect", tick: 1051, player: CT1 },
    { type: "disconnect", tick: 1100, player: T1 },
    { type: "disconnect", tick: 1110, player: CT1 },
  ] })]);
  const before = structuredClone(match);
  assert.deepEqual(buildRoundTimeline(buildCoverage(match).rounds[0]).anomalies, []);
  const result = analyzeMatch(match);
  assert.deepEqual(result, control, "spectator exits must not change any proven combat metrics");
  for (const candidate of result.players) {
    assert.equal(candidate.kast.complete, true);
    assert.equal(summarizePlayerPerformance(candidate).rating.status, "available");
  }
  assert.equal(byId(result, CT1).kast.tradedRounds, 1);
  assert.equal(byId(result, CT2).trade.tradeKills, 1);
  assert.ok(result.players.some(candidate => candidate.clutch.opportunities > 0));
  assert.deepEqual(match, before, "classification must not remove lifecycle evidence from the model");
});

for (const [name, disconnect] of [
  ["before death", { type: "disconnect", tick: 1049, player: CT1 }],
  ["at the same tick as death", { type: "disconnect", tick: 1050, player: CT1 }],
  ["while alive", { type: "disconnect", tick: 1060, player: CT2 }],
  ["without a known identity", { type: "disconnect", tick: 1060, player: null }],
  ["for an absent roster player", { type: "disconnect", tick: 1060, player: T3 }],
]) {
  test(`a disconnect ${name} retains the whole-round anomaly protection`, () => {
    const match = mkMatch(Object.keys(sides4).map(id => player(id, id)), [
      makeRound(1, sides4, { [CT1]: false }, [
        kill(1050, T1, CT1, { killerSide: "T", victimSide: "CT", teamkill: false }),
      ], { lifecycle: [disconnect] }),
    ]);
    assert.ok(buildRoundTimeline(buildCoverage(match).rounds[0]).anomalies.some(a => a.kind === "disconnect"));
    for (const candidate of analyzeMatch(match).players) {
      assert.equal(candidate.kast.unavailableRounds, 1);
      assert.equal(candidate.trade.complete, false);
      assert.equal(summarizePlayerPerformance(candidate).rating.status, "unavailable");
    }
  });
}

for (const [name, change, kind] of [
  ["respawn", { type: "spawn", tick: 1055, player: CT1, side: "CT" }, "respawn"],
  ["side change", { type: "side_change", tick: 1055, player: CT1, previousSide: "CT", side: "T" }, "side-change"],
]) {
  test(`post-death disconnects do not hide a ${name}`, () => {
    const match = mkMatch(Object.keys(sides4).map(id => player(id, id)), [
      makeRound(1, sides4, { [CT1]: false }, [
        kill(1050, T1, CT1, { killerSide: "T", victimSide: "CT", teamkill: false }),
      ], { lifecycle: [change, { type: "disconnect", tick: 1060, player: CT1 }] }),
    ]);
    assert.ok(buildRoundTimeline(buildCoverage(match).rounds[0]).anomalies.some(a => a.kind === kind));
    for (const candidate of analyzeMatch(match).players) assert.equal(candidate.kast.unavailableRounds, 1);
  });
}

for (const defect of ["multiple deaths", "dead baseline", "unknown baseline", "death before baseline", "end-state conflict"]) {
  test(`post-death disconnects cannot make a ${defect} reliable`, () => {
    const events = [kill(1050, T1, CT1, { killerSide: "T", victimSide: "CT", teamkill: false })];
    if (defect === "multiple deaths") events.push(kill(1055, T2, CT1, { killerSide: "T", victimSide: "CT", teamkill: false }));
    if (defect === "death before baseline") events[0].tick = 1005;
    const round = makeRound(1, sides4, { [CT1]: defect === "end-state conflict" }, events,
      { lifecycle: [{ type: "disconnect", tick: 1060, player: CT1 }] });
    if (defect === "dead baseline" || defect === "unknown baseline") {
      round.stateSnapshots[1].players.find(p => p.steamId === CT1).alive = defect === "dead baseline" ? false : null;
    }
    const match = mkMatch(Object.keys(sides4).map(id => player(id, id)), [round]);
    const timeline = buildRoundTimeline(buildCoverage(match).rounds[0]);
    assert.ok(timeline.anomalies.length > 0 || timeline.endStateSuspect);
    for (const candidate of analyzeMatch(match).players) {
      assert.equal(candidate.kast.complete, false);
      assert.equal(candidate.trade.complete, false);
      assert.equal(summarizePlayerPerformance(candidate).rating.status, "unavailable");
    }
  });
}

test("degrades every combat metric when the roster has unidentified players", () => {
  const players = [player(CT1, "ct1"), player(CT2, "ct2"), player(T1, "t1")];
  const sides = { [CT1]: "CT", [CT2]: "CT", [T1]: "T" };
  const rounds = [makeRound(1, sides, { [CT2]: false }, [
    kill(1050, T1, CT2, { killerSide: "T", victimSide: "CT", teamkill: false }),
  ], { unidentified: 1 })];
  const result = analyzeMatch(mkMatch(players, rounds));
  assert.equal(result.coverage.issues["roster-unidentified-players"], 1);
  assert.equal(result.coverage.issues["survival-context-degraded"], 1);
  assert.equal(result.coverage.issues["clutch-round-ineligible"], 1);
  assert.equal(byId(result, CT1).clutch.opportunities, 0);
  assert.equal(byId(result, CT1).kast.degradedRounds, 1);
  assert.equal(byId(result, CT1).kast.complete, false);
  assert.equal(byId(result, CT1).trade.unavailableRounds, 1);
});

test("classifies KAST / Trade / Clutch issues as unavailable, ambiguous or degraded", () => {
  assert.equal(coverageIssueSeverity["survival-context-unavailable"], "unavailable");
  assert.equal(coverageIssueSeverity["survival-end-state-unavailable"], "unavailable");
  assert.equal(coverageIssueSeverity["trade-tick-rate-unknown"], "unavailable");
  assert.equal(coverageIssueSeverity["clutch-round-ineligible"], "unavailable");
  assert.equal(coverageIssueSeverity["trade-same-tick-ambiguous"], "ambiguous");
  assert.equal(coverageIssueSeverity["trade-candidate-ambiguous"], "ambiguous");
  assert.equal(coverageIssueSeverity["survival-end-state-conflict"], "ambiguous");
  assert.equal(coverageIssueSeverity["survival-context-degraded"], "degraded");
  assert.equal(coverageIssueSeverity["clutch-winner-unknown"], "degraded");
});

test("is deterministic for identical combat input", () => {
  const players = [player(CT1, "ct1"), player(CT2, "ct2"), player(T1, "t1")];
  const sides = { [CT1]: "CT", [CT2]: "CT", [T1]: "T" };
  const rounds = [makeRound(1, sides, { [CT1]: false, [T1]: false }, [
    kill(1050, T1, CT1, { killerSide: "T", victimSide: "CT", teamkill: false }),
    kill(1090, CT2, T1, { killerSide: "CT", victimSide: "T", teamkill: false }),
  ])];
  const match = mkMatch(players, rounds);
  assert.deepEqual(analyzeMatch(match), analyzeMatch(match));
});
