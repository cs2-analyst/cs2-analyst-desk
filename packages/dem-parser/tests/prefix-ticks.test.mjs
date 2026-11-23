import assert from "node:assert/strict";
import test from "node:test";
import { planPrefixSpatialTicks } from "../src/providers/prefix-ticks.ts";

const match = {
  id: "synthetic", map: "de_test", tickRate: 64,
  players: [{ steamId: "1" }],
  rounds: [{ number: 1, winner: "CT", startTick: 10, freezeEndTick: 20, endTick: 200,
    events: [
      { type: "weapon_fire", tick: 40, shooter: "1", weapon: "ak47" },
      { type: "damage", tick: 50, attacker: "1", victim: "2" },
      { type: "kill", tick: 99, killer: "1", victim: "2" },
    ] }],
};

test("suffix events, density, result, roster and clock cannot change a historical query plan", () => {
  const options = { tickBudget: 5, contextOffsetTicks: 8 };
  const baseline = planPrefixSpatialTicks(match, 100, options);
  const changed = structuredClone(match);
  changed.tickRate = 128;
  changed.players.push({ steamId: "future" });
  changed.rounds[0].winner = "T";
  changed.rounds[0].endTick = 300;
  changed.rounds[0].events.unshift({ type: "kill", tick: 1000, killer: "future", victim: "1" });
  for (let tick = 101; tick < 301; tick++)
    changed.rounds[0].events.push({ type: "weapon_fire", tick, shooter: "future", weapon: "ak47" });
  changed.rounds.push({ number: 2, winner: "T", startTick: 400, freezeEndTick: 410,
    endTick: 500, events: [{ type: "kill", tick: 450, killer: "future", victim: "1" }] });
  assert.deepEqual(planPrefixSpatialTicks(changed, 100, options), baseline);
  assert.ok(baseline.requestedTicks.every(tick => tick < 100));
  assert.ok(baseline.omittedOptionalTicks.length > 0);
  assert.ok(baseline.contextOmissions.some(item => item.reason === "context-outside-prefix"));
});

test("a historical event change alters the query plan", () => {
  const options = { tickBudget: 20, contextOffsetTicks: 8 };
  const baseline = planPrefixSpatialTicks(match, 100, options);
  const changed = structuredClone(match);
  changed.rounds[0].events[1].tick = 51;
  assert.notDeepEqual(planPrefixSpatialTicks(changed, 100, options), baseline);
});

test("core history survives an undersized budget and context omissions remain explicit", () => {
  const plan = planPrefixSpatialTicks(match, 100, { tickBudget: 0, contextOffsetTicks: 8 });
  assert.deepEqual(plan.coreTicks, [10, 20, 40, 50, 99]);
  assert.deepEqual(plan.optionalTicks, []);
  assert.deepEqual(plan.requestedTicks, plan.coreTicks);
  assert.ok(plan.omittedOptionalTicks.length > 0);
  assert.ok(plan.contextOmissions.some(item => item.eventTick === 99
    && item.relation === "after-event" && item.reason === "context-outside-prefix"));
  assert.ok(!plan.coreTicks.includes(200));
});

test("invalid cut, budget, offsets, and unlocatable historical ticks fail closed", () => {
  for (const cut of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => planPrefixSpatialTicks(match, cut), /invalid-cut-tick/);
  for (const tickBudget of [-1, 0.5, NaN, Infinity])
    assert.throws(() => planPrefixSpatialTicks(match, 100, { tickBudget }), /invalid-tick-budget/);
  for (const contextOffsetTicks of [-1, 0.5, NaN, Infinity])
    assert.throws(() => planPrefixSpatialTicks(match, 100, { contextOffsetTicks }), /invalid-context-offset/);
  const changed = structuredClone(match);
  changed.rounds[0].events[0].tick = NaN;
  assert.throws(() => planPrefixSpatialTicks(changed, 100), /unlocatable-event-tick/);
});

test("inconsistent historical round boundaries and misplaced events cannot form a plan", () => {
  const beforeFreeze = structuredClone(match);
  beforeFreeze.rounds[0].freezeEndTick = 9;
  assert.throws(() => planPrefixSpatialTicks(beforeFreeze, 100), /invalid-round-boundary-order/);
  const endBeforeFreeze = structuredClone(match);
  endBeforeFreeze.rounds[0].endTick = 15;
  assert.throws(() => planPrefixSpatialTicks(endBeforeFreeze, 100), /invalid-round-boundary-order/);
  const eventBeforeStart = structuredClone(match);
  eventBeforeStart.rounds[0].events[0].tick = 5;
  assert.throws(() => planPrefixSpatialTicks(eventBeforeStart, 100), /event-before-round/);
  const contradictoryFutureRound = structuredClone(match);
  contradictoryFutureRound.rounds.push({ number: 2, startTick: 150, events: [{ type: "kill", tick: 50 }] });
  assert.throws(() => planPrefixSpatialTicks(contradictoryFutureRound, 100), /future-round-has-unlocatable-history/);
});

test("post-round events are excluded explicitly instead of becoming official-round input", () => {
  const ended = structuredClone(match);
  ended.rounds[0].endTick = 90;
  const plan = planPrefixSpatialTicks(ended, 100, { contextOffsetTicks: 8 });
  assert.deepEqual(plan.excludedEvents, [{ tick: 99, reason: "event-after-round" }]);
  assert.ok(!plan.requestedTicks.includes(99));
});
