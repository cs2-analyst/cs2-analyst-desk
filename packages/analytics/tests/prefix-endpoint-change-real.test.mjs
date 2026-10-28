import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import native from "../../demoparser-native/index.cjs";
import { Demoparser2Adapter } from "../../dem-parser/dist/providers/demoparser2-adapter.js";
import { convertNativePrefix } from "../../dem-parser/dist/providers/prefix-match.js";
import { planPrefixSpatialTicks } from "../../dem-parser/dist/providers/prefix-ticks.js";
import { joinPrefixNativeRows } from "../../dem-parser/dist/providers/prefix-rows.js";
import { resolvePrefixRoster } from "../dist/prefix-roster.js";
import { buildPrefixEndpointChange } from "../dist/prefix-endpoint-change.js";

const fixture = fileURLToPath(new URL("../../../.demo/dust2.dem", import.meta.url));
const expectedSha = "db90fe85aab023a1d2c8a5996182e6120d98ef494f02a070b17982b235e4958c";
const fields = ["X", "Y", "Z", "yaw", "pitch", "health", "is_alive", "team_num", "active_weapon_name"];
const anchors = [
  { round: 11, cutTick: 92396 }, { round: 22, cutTick: 185101 },
  { round: 23, cutTick: 194102 }, { round: 24, cutTick: 201349 },
];

test("synthetic endpoint gate preserves yaw wrap and rejects missing, stale and overflowing evidence", async () => {
  const ids = Array.from({ length: 10 }, (_, index) => String(76561198000000001n + BigInt(index)));
  const survivor = ids[0], opponent = ids[5], sha = "a".repeat(64);
  const victims = [ids[1], ids[6], ids[2], ids[7], ids[3], ids[8], ids[4], ids[9]];
  const prefix = { schemaVersion: "dem-native-prefix-match-v1", cutTick: 41, unidentifiedDeathTicks: [],
    match: { id: sha, map: "de_test", players: [], rounds: [{ number: 1, winner: null,
      startTick: 10, freezeEndTick: 20, events: victims.map((victim, index) => ({
        type: "kill", tick: index === 7 ? 40 : 30 + index, victim,
        victimSide: index % 2 === 0 ? "CT" : "T", killer: index % 2 === 0 ? opponent : survivor,
      })), stateSnapshots: [{ boundary: "freeze_end", tick: 20, availability: "observed",
        unidentifiedPlayerCount: 0, players: ids.map((steamId, index) => ({ steamId,
          side: index < 5 ? "CT" : "T", alive: true, participant: true })) }],
      playerLifecycle: [] }] } };
  const roster = resolvePrefixRoster(prefix, 1);
  assert.equal(roster.status, "known");
  const plan = planPrefixSpatialTicks(prefix.match, 41, { tickBudget: 0 });
  const provenance = { matchId: sha, demoSha256: sha, mapName: "de_test", parserVersion: "pinned" };
  const row = (tick, steamid, side, x, yaw) => ({ tick, steamid,
    team_num: side === "CT" ? 3 : 2, X: x, Y: 0, Z: 0, yaw, pitch: 0,
    health: 80, is_alive: true, active_weapon_name: "test-weapon" });
  const input = [row(35, survivor, "CT", 0, 179), row(40, survivor, "CT", 3, -179),
    row(40, opponent, "T", 10, 0)];
  const joined = raw => joinPrefixNativeRows(plan, [survivor, opponent], raw, provenance);
  const baseline = await buildPrefixEndpointChange(prefix, roster, joined(input), survivor, 35, 40);
  assert.equal(baseline.status, "known");
  assert.equal(baseline.horizontalDisplacement, 3);
  assert.equal(baseline.signedYawDeltaDegrees, 2);
  assert.equal(baseline.tickGap, 5);
  assert.deepEqual(baseline.provenance, provenance);
  assert.deepEqual(baseline.endpointCoverage, { start: "complete", end: "complete" });
  assert.deepEqual(baseline.interiorCoverage,
    { exclusiveTicks: [35, 40], evaluatedTicks: [], notEvaluatedCount: 4 });
  assert.equal(baseline.startSelection, "prefix-core-event");
  assert.equal((await buildPrefixEndpointChange(prefix, roster, joined(input), survivor, 19, 40)).reason,
    "invalid-interval");
  assert.equal((await buildPrefixEndpointChange(prefix, roster, joined(input), ids[1], 35, 40)).reason,
    "player-not-survivor");
  assert.equal((await buildPrefixEndpointChange(prefix, roster, joined(input.slice(1)), survivor, 35, 40)).reason,
    "start-tick-not-returned");
  const returnedContradiction = structuredClone(joined(input));
  returnedContradiction.returnedTicks = returnedContradiction.returnedTicks.filter(tick => tick !== 35);
  assert.equal((await buildPrefixEndpointChange(prefix, roster, returnedContradiction, survivor, 35, 40)).reason,
    "start-tick-not-returned");
  const duplicate = joined([...input, row(35, survivor, "CT", 9, 179)]);
  assert.equal((await buildPrefixEndpointChange(prefix, roster, duplicate, survivor, 35, 40)).reason,
    "start-state-incomplete");
  const stale = structuredClone(joined(input));
  stale.observations.find(value => value.requestedTick === 35 && value.playerId === survivor).position.x = 1;
  assert.equal((await buildPrefixEndpointChange(prefix, roster, stale, survivor, 35, 40)).reason,
    "start-evidence-ref-mismatch");
  const overflow = joined([row(35, survivor, "CT", -Number.MAX_VALUE, 179),
    row(40, survivor, "CT", Number.MAX_VALUE, -179), row(40, opponent, "T", 10, 0)]);
  assert.equal((await buildPrefixEndpointChange(prefix, roster, overflow, survivor, 35, 40)).reason,
    "displacement-invalid");
  const extraTickPlan = { ...plan, tickBudget: plan.coreTicks.length + 1,
    optionalTicks: [38], requestedTicks: [...plan.requestedTicks, 38].sort((a, b) => a - b) };
  const extraTickRows = joinPrefixNativeRows(extraTickPlan, [survivor, opponent],
    [...input, row(38, survivor, "CT", 2, 0)], provenance);
  assert.equal((await buildPrefixEndpointChange(prefix, roster, extraTickRows, survivor, 38, 40)).reason,
    "invalid-interval");
});

test("pinned Dust2 survivors yield exact preformation-to-formation endpoint changes", {
  skip: existsSync(fixture) ? false : "Local .demo/dust2.dem absent; no replacement or download",
}, async () => {
  const bytes = readFileSync(fixture);
  const raw = await new Demoparser2Adapter().parse(fixture);
  assert.equal(raw.id, expectedSha);
  const parser = native.getBindingProvenance();
  let known = 0;
  for (const item of anchors) {
    const endTick = item.cutTick - 1;
    const prefix = convertNativePrefix(raw, item.cutTick);
    const roster = resolvePrefixRoster(prefix, item.round);
    assert.equal(roster.status, "known");
    assert.equal(roster.eligibleOneVsOne, true);
    const plan = planPrefixSpatialTicks(prefix.match, item.cutTick, { tickBudget: 0 });
    const startTick = plan.requestedTicks.filter(tick => tick >= roster.baselineTick && tick < endTick).at(-1);
    assert.ok(Number.isSafeInteger(startTick));
    const playerIds = roster.survivors.map(player => player.playerId);
    const nativeRows = native.parseTicks(bytes, fields, plan.requestedTicks, playerIds);
    const provenance = { matchId: prefix.match.id, demoSha256: expectedSha, mapName: prefix.match.map,
      parserVersion: `demoparser2:${parser.verifiedSha256}` };
    const joined = input => joinPrefixNativeRows(plan, playerIds, input, provenance);
    const rows = joined(nativeRows);
    for (const playerId of playerIds) {
      const result = await buildPrefixEndpointChange(prefix, roster, rows, playerId, startTick, endTick);
      assert.equal(result.status, "known", `${item.round}: ${result.reason}`);
      assert.equal(result.tickGap, endTick - startTick);
      assert.equal(result.interiorPath, "not-observed-by-this-method");
      assert.equal(result.coordinateUnit, "DEM-world-unit");
      assert.deepEqual(result.provenance, provenance);
      assert.deepEqual(result.endpointCoverage, { start: "complete", end: "complete" });
      assert.deepEqual(result.interiorCoverage, { exclusiveTicks: [startTick, endTick],
        evaluatedTicks: [], notEvaluatedCount: endTick - startTick - 1 });
      assert.equal(result.formationEventIndices.length > 0, true);
      const endpoints = native.parseTicks(bytes, fields, [startTick, endTick], [playerId]);
      const start = endpoints.find(row => row.tick === startTick);
      const end = endpoints.find(row => row.tick === endTick);
      assert.ok(start && end);
      assert.deepEqual(result.delta, { x: end.X - start.X, y: end.Y - start.Y, z: end.Z - start.Z });
      assert.equal(result.horizontalDisplacement, Math.hypot(result.delta.x, result.delta.y));
      assert.equal(result.threeDimensionalDisplacement,
        Math.hypot(result.delta.x, result.delta.y, result.delta.z));

      const future = joined([...nativeRows, { ...end, tick: item.cutTick + 1, X: 9999 }]);
      assert.deepEqual(await buildPrefixEndpointChange(prefix, roster, future, playerId, startTick, endTick), result);
      const changed = joined(nativeRows.map(row => row.tick === startTick && row.steamid === playerId
        ? { ...row, X: row.X + 10 } : row));
      const changedResult = await buildPrefixEndpointChange(prefix, roster, changed, playerId, startTick, endTick);
      assert.equal(changedResult.status, "known");
      assert.notEqual(changedResult.delta.x, result.delta.x);
      const missing = joined(nativeRows.filter(row => !(row.tick === startTick && row.steamid === playerId)));
      assert.equal((await buildPrefixEndpointChange(prefix, roster, missing, playerId, startTick, endTick)).status,
        "unknown");
      known++;
    }
  }
  assert.equal(known, 8);
});
