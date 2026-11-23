import assert from "node:assert/strict";
import test from "node:test";
import { planPrefixSpatialTicks } from "../src/providers/prefix-ticks.ts";
import { joinPrefixNativeRows } from "../src/providers/prefix-rows.ts";

const A = "76561198000000001", B = "76561198000000002";
const provenance = { matchId: "fixture", demoSha256: "a".repeat(64), mapName: "de_test", parserVersion: "pinned-native" };
const match = { id: "fixture", map: "de_test", rounds: [{ number: 1, startTick: 10, freezeEndTick: 20,
  endTick: 90, events: [{ type: "weapon_fire", tick: 40, shooter: A, weapon: "ak47" }] }] };
const plan = planPrefixSpatialTicks(match, 50);
const row = (tick, steamid, extra = {}) => ({ tick, steamid, X: 1, Y: 2, Z: 3,
  yaw: 10, pitch: 0, health: 80, is_alive: true, team_num: 2, active_weapon_name: "AK-47", ...extra });
const at = (result, tick, id) => result.observations.find(x => x.requestedTick === tick && x.playerId === id);

test("exact requested rows keep actual tick, fields, provenance and local refs", () => {
  const result = joinPrefixNativeRows(plan, [B, A], [row(40, A), row(40, B)], provenance);
  assert.equal(result.schemaVersion, "dem-prefix-rows-v1");
  assert.equal(result.informationScope, "server-global");
  assert.equal(result.privacy, "local-only");
  assert.deepEqual(result.playerIds, [A, B]);
  assert.deepEqual(result.returnedTicks, [40]);
  assert.equal(result.selectedRowCount, 2);
  assert.match(at(result, 40, A).evidenceRef, /^native-exact:[a-f0-9]{64}$/);
  assert.notEqual(at(result, 40, A).evidenceRef, at(result, 40, B).evidenceRef);
  assert.equal(at(result, 40, B).evidenceRef,
    at(joinPrefixNativeRows(plan, [B], [row(40, B)], provenance), 40, B).evidenceRef);
  assert.deepEqual({ ...at(result, 40, A), evidenceRef: "local-row-ref" }, {
    requestedTick: 40, actualTick: 40, playerId: A, evidenceRef: "local-row-ref",
    position: { x: 1, y: 2, z: 3 }, view: { yaw: 10, pitch: 0 }, health: 80,
    alive: true, side: "T", activeWeapon: "AK-47", coverage: { status: "complete", reasons: [] },
  });
  assert.equal(at(result, 20, A).actualTick, null);
  assert.deepEqual(at(result, 20, A).coverage.reasons, ["requested-tick-missing"]);
});

test("future rows, unselected players and unknown metadata cannot alter a fixed prefix output", () => {
  const rows = [row(40, A), row(40, B)];
  const baseline = joinPrefixNativeRows(plan, [A, B], rows, provenance);
  const variant = joinPrefixNativeRows(plan, [A, B], [
    { ...rows[0], futureSecret: "never-export" }, { ...rows[1], futureSecret: "never-export" },
    row(40, "76561198000000003", { futureSecret: "never-export" }),
    ...Array.from({ length: 50 }, (_, i) => row(50 + i, A, { X: 9999, futureSecret: "never-export" })),
  ], provenance);
  assert.deepEqual(variant, baseline);
  assert.ok(!JSON.stringify(variant).includes("never-export"));
  const historical = joinPrefixNativeRows(plan, [A, B], [row(40, A, { X: 4 }), row(40, B)], provenance);
  assert.notDeepEqual(at(historical, 40, A).position, at(baseline, 40, A).position);
  assert.notEqual(at(historical, 40, A).evidenceRef, at(baseline, 40, A).evidenceRef);
});

test("missing player, invalid fields and conflicting exact rows stay unknown", () => {
  const missing = joinPrefixNativeRows(plan, [A, B], [row(40, A)], provenance);
  assert.deepEqual(at(missing, 40, B).coverage.reasons, ["player-row-missing"]);
  const invalid = joinPrefixNativeRows(plan, [A], [row(40, A, { X: NaN, yaw: 181, health: -1,
    is_alive: null, team_num: 0, active_weapon_name: null })], provenance);
  const observation = at(invalid, 40, A);
  assert.equal(observation.actualTick, 40);
  assert.equal(observation.position, null);
  assert.equal(observation.view, null);
  assert.equal(observation.health, null);
  assert.equal(observation.coverage.status, "unavailable");
  assert.deepEqual(observation.coverage.reasons, ["position-missing", "view-missing", "state-missing", "weapon-unavailable"]);
  const duplicate = joinPrefixNativeRows(plan, [A], [row(40, A), row(40, A)], provenance);
  assert.equal(at(duplicate, 40, A).coverage.status, "complete");
  assert.equal(duplicate.selectedRowCount, 1);
  assert.equal(at(duplicate, 40, A).evidenceRef,
    at(joinPrefixNativeRows(plan, [A], [row(40, A)], provenance), 40, A).evidenceRef);
  const weaponMissing = joinPrefixNativeRows(plan, [A], [row(40, A, { active_weapon_name: null })], provenance);
  assert.equal(at(weaponMissing, 40, A).coverage.status, "complete");
  assert.deepEqual(at(weaponMissing, 40, A).coverage.reasons, ["weapon-unavailable"]);
  const conflict = joinPrefixNativeRows(plan, [A], [row(40, A), row(40, A, { X: 4 })], provenance);
  assert.equal(at(conflict, 40, A).actualTick, null);
  assert.equal(at(conflict, 40, A).position, null);
  assert.deepEqual(at(conflict, 40, A).coverage.reasons, ["conflicting-player-row"]);
});

test("unidentifiable requested-tick rows invalidate that tick without being called unselected", () => {
  const result = joinPrefixNativeRows(plan, [A], [row(40, A), row(40, undefined)], provenance);
  assert.equal(result.unidentifiedRequestedTickRows, 1);
  assert.equal(result.selectedRowCount, 1);
  assert.equal(at(result, 40, A).actualTick, null);
  assert.equal(at(result, 40, A).evidenceRef, null);
  assert.deepEqual(at(result, 40, A).coverage.reasons, ["unidentified-row-at-requested-tick"]);
});

test("malformed plan, identity, provenance and unlocatable row fail closed", () => {
  assert.throws(() => joinPrefixNativeRows({ ...plan, requestedTicks: [40, 20, 10] }, [A], [], provenance), /invalid-prefix-plan/);
  assert.throws(() => joinPrefixNativeRows(plan, [A, A], [], provenance), /invalid-selected-players/);
  assert.throws(() => joinPrefixNativeRows(plan, ["0"], [], provenance), /invalid-selected-players/);
  assert.throws(() => joinPrefixNativeRows(plan, [A], [], { ...provenance, demoSha256: "unknown" }), /invalid-row-provenance/);
  assert.throws(() => joinPrefixNativeRows(plan, [A], [row(NaN, A)], provenance), /unlocatable-native-row-tick/);
});
