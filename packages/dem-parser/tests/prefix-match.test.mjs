import assert from "node:assert/strict";
import test from "node:test";
import { convertNativePrefix } from "../dist/providers/prefix-match.js";
import { planPrefixSpatialTicks } from "../dist/providers/prefix-ticks.js";

const A = "76561198000000001", B = "76561198000000002";
const raw = {
  id: "fixture", header: { map_name: "de_test", tick_rate: 64, playback_time: 900 },
  players: [{ steamid: A, name: "FUTURE_NAME" }],
  events: [
    { event_name: "round_start", tick: 10, total_rounds_played: 0 },
    { event_name: "round_freeze_end", tick: 20, total_rounds_played: 0 },
    { event_name: "player_death", tick: 40, total_rounds_played: 0,
      user_steamid: B, user_team_num: 2, attacker_steamid: A, attacker_team_num: 3 },
    { event_name: "round_end", tick: 200, total_rounds_played: 0, winner: "CT" },
  ],
  stateRows: [
    { tick: 20, steamid: A, team_num: 3, is_alive: true },
    { tick: 20, steamid: B, team_num: 2, is_alive: true },
    { tick: 200, steamid: B, team_num: 2, is_alive: false },
  ],
};

test("future metadata, rows, events and restarts do not change converted history or query plan", () => {
  const original = structuredClone(raw);
  const baseline = convertNativePrefix(raw, 100);
  assert.deepEqual(raw, original);
  assert.equal(Object.hasOwn(baseline, "informationScope"), false);
  const changed = structuredClone(raw);
  changed.header.tick_rate = 128;
  changed.header.playback_time = 1;
  changed.players = [{ steamid: "987654321", name: "FUTURE_SECRET" }];
  changed.finalScore = [99, 0];
  changed.effectEvents = [{ tick: 150, event_name: "inferno_expire" }];
  changed.events.unshift({ event_name: "round_start", tick: 150, total_rounds_played: 1 });
  changed.events.push({ event_name: "player_death", tick: 160, total_rounds_played: 1,
    user_steamid: A, user_team_num: 3 });
  changed.events.find(e => e.event_name === "round_end").winner = "T";
  changed.stateRows.push({ tick: 150, steamid: "987654321", team_num: 2, is_alive: true });
  assert.deepEqual(convertNativePrefix(changed, 100), baseline);
  assert.deepEqual(planPrefixSpatialTicks(convertNativePrefix(changed, 100).match, 100),
    planPrefixSpatialTicks(baseline.match, 100));
  assert.ok(!JSON.stringify(baseline).includes("FUTURE_NAME"));
  assert.ok(!JSON.stringify(baseline).includes("FUTURE_SECRET"));
  assert.equal(baseline.match.rounds[0].endTick, undefined);
  const changedSourceIdentity = structuredClone(changed);
  changedSourceIdentity.id = "a-new-full-dem-digest";
  const anotherSource = convertNativePrefix(changedSourceIdentity, 100);
  assert.notEqual(anotherSource.match.id, baseline.match.id);
  assert.deepEqual({ ...anotherSource.match, id: baseline.match.id }, baseline.match);
});

test("historical event or state-row changes alter the appropriate prefix facts", () => {
  const baseline = convertNativePrefix(raw, 100);
  const changedEvent = structuredClone(raw);
  changedEvent.events.find(e => e.event_name === "player_death").tick = 41;
  assert.notDeepEqual(convertNativePrefix(changedEvent, 100).match.rounds[0].events,
    baseline.match.rounds[0].events);
  const changedState = structuredClone(raw);
  changedState.stateRows[0].is_alive = false;
  assert.notDeepEqual(convertNativePrefix(changedState, 100).match.rounds[0].stateSnapshots,
    baseline.match.rounds[0].stateSnapshots);
});

test("unlocatable ticks and missing provenance fail closed", () => {
  for (const cut of [0, -1, NaN, Infinity, 1.5])
    assert.throws(() => convertNativePrefix(raw, cut), /invalid-prefix-cut/);
  const badEvent = structuredClone(raw);
  badEvent.events.push({ event_name: "weapon_fire", tick: NaN });
  assert.throws(() => convertNativePrefix(badEvent, 100), /unlocatable-event-tick/);
  const badRow = structuredClone(raw);
  badRow.stateRows.push({ tick: NaN, steamid: A });
  assert.throws(() => convertNativePrefix(badRow, 100), /unlocatable-state-row-tick/);
  assert.throws(() => convertNativePrefix({ ...raw, header: {} }, 100), /invalid-native-prefix-provenance/);
});

test("an unidentified historical death remains visible to later roster gates", () => {
  const changed = structuredClone(raw);
  changed.events.push({ event_name: "player_death", tick: 39, total_rounds_played: 0,
    user_steamid: null, user_team_num: 2 });
  const prefix = convertNativePrefix(changed, 100);
  assert.deepEqual(prefix.unidentifiedDeathTicks, [39]);
  assert.equal(prefix.match.rounds[0].events.filter(event => event.type === "kill").length, 1);
  changed.events.at(-1).tick = 100;
  assert.deepEqual(convertNativePrefix(changed, 100).unidentifiedDeathTicks, []);
});
