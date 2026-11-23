import assert from "node:assert/strict";
import test from "node:test";
import { resolvePrefixRoster } from "../dist/prefix-roster.js";

const ids = Array.from({ length: 10 }, (_, i) => String(76561198000000001n + BigInt(i)));
const side = id => ids.indexOf(id) < 5 ? "CT" : "T";
function fixture() {
  const deaths = [ids[1], ids[6], ids[2], ids[7], ids[3], ids[8], ids[4], ids[9]]
    .map((victim, i) => ({ type: "kill", tick: 30 + i, victim, victimSide: side(victim),
      killer: side(victim) === "CT" ? ids[5] : ids[0] }));
  return { schemaVersion: "dem-native-prefix-match-v1", cutTick: 38, unidentifiedDeathTicks: [],
    match: { id: "private-full-demo-id", map: "de_test", players: [], rounds: [{
      number: 1, winner: null, startTick: 10, freezeEndTick: 20, events: deaths,
      stateSnapshots: [{ boundary: "freeze_end", tick: 20, availability: "observed",
        unidentifiedPlayerCount: 0, players: ids.map((steamId, i) => ({ steamId,
          side: i < 5 ? "CT" : "T", alive: true, participant: true })) }],
      playerLifecycle: [],
    }] } };
}

test("a verified 5v5 baseline and atomic deaths reconstruct one server-side 1v1", () => {
  const result = resolvePrefixRoster(fixture(), 1);
  assert.equal(result.status, "known");
  assert.deepEqual(result.counts, { CT: 1, T: 1 });
  assert.equal(result.oneVsOneFormedAtTick, 37);
  assert.equal(result.eligibleOneVsOne, true);
  assert.deepEqual(result.survivors, [{ playerId: ids[0], side: "CT" }, { playerId: ids[5], side: "T" }]);
  assert.ok(!JSON.stringify(result).includes("private-full-demo-id"));
});

test("same-tick deaths are one group and cannot manufacture an intermediate 1v1", () => {
  const simultaneous = fixture();
  simultaneous.match.rounds[0].events[6].tick = 37;
  const formed = resolvePrefixRoster(simultaneous, 1);
  assert.equal(formed.status, "known");
  assert.equal(formed.groups.at(-1).eventIndices.length, 2);
  assert.deepEqual(formed.groups.at(-1).before, { CT: 2, T: 2 });
  assert.deepEqual(formed.groups.at(-1).after, { CT: 1, T: 1 });
  simultaneous.match.rounds[0].events.push({ type: "kill", tick: 37, victim: ids[0],
    victimSide: "CT", killer: ids[5] }, { type: "kill", tick: 37, victim: ids[5],
    victimSide: "T", killer: ids[0] });
  const eliminated = resolvePrefixRoster(simultaneous, 1);
  assert.equal(eliminated.status, "known");
  assert.deepEqual(eliminated.counts, { CT: 0, T: 0 });
  assert.equal(eliminated.oneVsOneFormedAtTick, null);
  assert.equal(eliminated.eligibleOneVsOne, false);
});

test("missing baseline, lifecycle, unidentified death and conflicting death fail closed", () => {
  const cases = [
    ["freeze-baseline-missing", x => { x.match.rounds[0].stateSnapshots = []; }],
    ["baseline-roster", x => { x.match.rounds[0].stateSnapshots[0].players[0].side = "Unknown"; }],
    ["lifecycle-ambiguous", x => { x.match.rounds[0].playerLifecycle.push({ type: "spawn", tick: 25, player: ids[1], side: "CT" }); }],
    ["unidentified-death", x => { x.unidentifiedDeathTicks.push(35); }],
    ["invalid-death", x => { x.match.rounds[0].events.push({ ...x.match.rounds[0].events[0] }); }],
    ["death-side-conflict", x => { x.match.rounds[0].events[0].victimSide = "T"; }],
    ["round-ended", x => { x.match.rounds[0].endTick = 37; }],
    ["later-round-started", x => { x.match.rounds.push({ number: 2, startTick: 37,
      events: [] }); }],
    ["non-prefix-match", x => { x.match.rounds[0].events.push({ type: "kill", tick: 40, victim: ids[0] }); }],
  ];
  for (const [reason, change] of cases) {
    const input = fixture();change(input);
    const result = resolvePrefixRoster(input, 1);
    assert.equal(result.status, "unknown", reason);
    assert.equal(result.reason, reason);
  }
});
