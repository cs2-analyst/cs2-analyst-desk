import assert from "node:assert/strict";
import test from "node:test";
import { planPrefixSpatialTicks } from "../../dem-parser/dist/providers/prefix-ticks.js";
import { joinPrefixNativeRows } from "../../dem-parser/dist/providers/prefix-rows.js";
import { resolvePrefixRoster } from "../dist/prefix-roster.js";
import { buildPrefixSpatialContext } from "../dist/prefix-spatial-context.js";

const ids = Array.from({ length: 10 }, (_, i) => String(76561198000000001n + BigInt(i)));
const A = ids[0], B = ids[5], demoSha = "a".repeat(64);
const victims = [ids[1], ids[6], ids[2], ids[7], ids[3], ids[8], ids[4], ids[9]];
const prefix = { schemaVersion: "dem-native-prefix-match-v1", cutTick: 41, unidentifiedDeathTicks: [],
  match: { id: demoSha, map: "de_test", players: [], rounds: [{ number: 1, winner: null,
    startTick: 10, freezeEndTick: 20, events: victims.map((victim, index) => ({
      type: "kill", tick: index === 7 ? 40 : 30 + index, victim,
      victimSide: index % 2 === 0 ? "CT" : "T", killer: index % 2 === 0 ? B : A,
    })),
    stateSnapshots: [{ boundary: "freeze_end", tick: 20, availability: "observed",
      unidentifiedPlayerCount: 0, players: ids.map((steamId, index) => ({ steamId,
        side: index < 5 ? "CT" : "T", alive: true, participant: true })) }],
    playerLifecycle: [],
  }] } };
const roster = resolvePrefixRoster(prefix, 1);
assert.equal(roster.status, "known");
assert.equal(roster.oneVsOneFormedAtTick, 40);
const plan = planPrefixSpatialTicks(prefix.match, 41, { tickBudget: 0 });
const provenance = { matchId: demoSha, demoSha256: demoSha, mapName: "de_test", parserVersion: "pinned" };
const nativeRow = (steamid, side, position) => ({ tick: 40, steamid, team_num: side === "CT" ? 3 : 2,
  X: position.x, Y: position.y, Z: position.z, yaw: 0, pitch: 0, health: 80,
  is_alive: true, active_weapon_name: "AK-47" });
const sourceRows = [nativeRow(A, "CT", { x: 0, y: 0, z: 0 }),
  nativeRow(B, "T", { x: 3, y: 4, z: 12 })];
const joined = input => joinPrefixNativeRows(plan, [A, B], input, provenance);
const rows = joined(sourceRows);
const anchorOf = (bundle, id) => bundle.observations.find(row => row.requestedTick === 40 && row.playerId === id);

test("one verified 1v1 formation binds two exact local endpoints to XY and 3D arithmetic", async () => {
  const result = await buildPrefixSpatialContext(prefix, roster, rows, 40);
  assert.equal(result.status, "known");
  assert.equal(result.informationScope, "server-global");
  assert.equal(result.anchorCoverage, "complete");
  assert.deepEqual(result.eventIndices, [7]);
  assert.equal(result.horizontal.value, 5);
  assert.equal(result.threeDimensional.value, 13);
  assert.deepEqual(result.players.map(player => player.playerId), [A, B]);
  assert.ok(!JSON.stringify(result).includes("winner"));
});

test("future rows stay out; historical changes require a matching new row digest", async () => {
  const baseline = await buildPrefixSpatialContext(prefix, roster, rows, 40);
  const future = structuredClone(rows);
  future.observations.push({ ...anchorOf(future, A), requestedTick: 50, actualTick: 50,
    position: { x: 999, y: 999, z: 999 } });
  future.returnedTicks.push(50);
  future.provenance.futureOutcome = "future-secret";
  assert.deepEqual(await buildPrefixSpatialContext(prefix, roster, future, 40), baseline);
  const changed = joined([sourceRows[0], { ...sourceRows[1], X: 6 }]);
  const changedContext = await buildPrefixSpatialContext(prefix, roster, changed, 40);
  assert.equal(changedContext.status, "known");
  assert.notEqual(changedContext.horizontal.value, baseline.horizontal.value);
  assert.notEqual(anchorOf(changed, B).evidenceRef, anchorOf(rows, B).evidenceRef);
  const staleRef = structuredClone(rows);
  anchorOf(staleRef, B).position.x = 6;
  assert.equal((await buildPrefixSpatialContext(prefix, roster, staleRef, 40)).reason, "evidence-ref-mismatch");
});

test("forged roster, source, event, row, state and provenance fail closed", async () => {
  const noOneVsOne = structuredClone(prefix);
  noOneVsOne.match.rounds[0].events.pop();
  const knownWithoutFormation = resolvePrefixRoster(noOneVsOne, 1);
  assert.equal(knownWithoutFormation.status, "known");
  const forgedGroup = structuredClone(roster);
  forgedGroup.groups.at(-1).eventIndices = [999];
  const overflowRows = joined([
    nativeRow(A, "CT", { x: -Number.MAX_VALUE, y: 0, z: 0 }),
    nativeRow(B, "T", { x: Number.MAX_VALUE, y: 0, z: 0 }),
  ]);
  const cases = [
    ["roster-unknown", prefix, { ...roster, status: "unknown", reason: "baseline-roster" }, rows, 40],
    ["prefix-contract-mismatch", { ...prefix, cutTick: 42 }, roster, rows, 40],
    ["roster-source-mismatch", prefix, forgedGroup, rows, 40],
    ["not-one-vs-one", noOneVsOne, knownWithoutFormation, rows, 40],
    ["formation-tick-mismatch", prefix, roster, rows, 39],
    ["rows-contract-mismatch", prefix, roster, { ...rows, cutTick: 42 }, 40],
    ["rows-contract-mismatch", prefix, roster, { ...rows, provenance: null }, 40],
    ["rows-contract-mismatch", prefix, roster, { ...rows, provenance: { ...rows.provenance, demoSha256: "b".repeat(64) } }, 40],
    ["selected-players-mismatch", prefix, roster, { ...rows, playerIds: [A] }, 40],
    ["anchor-row-missing-or-duplicate", prefix, roster, { ...rows, observations: [...rows.observations, anchorOf(rows, A)] }, 40],
    ["anchor-state-incomplete", prefix, roster, { ...rows, observations: rows.observations.map(row => row === anchorOf(rows, A) ? { ...row, alive: false } : row) }, 40],
    ["anchor-state-incomplete", prefix, roster, { ...rows, observations: rows.observations.map(row => row === anchorOf(rows, A) ? { ...row, evidenceRef: "ref-a" } : row) }, 40],
    ["distance-invalid", prefix, roster, overflowRows, 40],
  ];
  for (const [reason, inputPrefix, inputRoster, inputRows, anchorTick] of cases) {
    const result = await buildPrefixSpatialContext(inputPrefix, inputRoster, inputRows, anchorTick);
    assert.equal(result.status, "unknown", reason);
    assert.equal(result.reason, reason);
  }
});
