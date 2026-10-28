import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import native from "../../demoparser-native/index.cjs";
import { Demoparser2Adapter } from "../../dem-parser/dist/providers/demoparser2-adapter.js";
import { convertNativePrefix } from "../../dem-parser/dist/providers/prefix-match.js";
import { planPrefixSpatialTicks } from "../../dem-parser/dist/providers/prefix-ticks.js";
import { joinPrefixNativeRows } from "../../dem-parser/dist/providers/prefix-rows.js";
import { resolvePrefixRoster } from "../dist/prefix-roster.js";
import { buildPrefixReviewFragment } from "../dist/prefix-review-fragment.js";

const fixture = fileURLToPath(new URL("../../../.demo/dust2.dem", import.meta.url));
const sha = "db90fe85aab023a1d2c8a5996182e6120d98ef494f02a070b17982b235e4958c";
const fields = ["X", "Y", "Z", "yaw", "pitch", "health", "is_alive", "team_num", "active_weapon_name"];
const anchors = [
  { round: 11, cut: 92396 }, { round: 22, cut: 185101 },
  { round: 23, cut: 194102 }, { round: 24, cut: 201349 },
];

test("four real Dust2 formation facts yield local review fragments without coaching judgments", {
  skip: existsSync(fixture) ? false : "Local .demo/dust2.dem absent; no replacement or download",
}, async () => {
  const bytes = readFileSync(fixture);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), sha);
  const raw = await new Demoparser2Adapter().parse(fixture);
  assert.equal(raw.id, sha);
  const parserVersion = `demoparser2:${native.getBindingProvenance().verifiedSha256}`;
  for (const { round, cut } of anchors) {
    const anchor = cut - 1;
    const prefix = convertNativePrefix(raw, cut);
    const roster = resolvePrefixRoster(prefix, round);
    assert.equal(roster.status, "known");
    const plan = planPrefixSpatialTicks(prefix.match, cut, { tickBudget: 0 });
    const ids = roster.survivors.map(player => player.playerId);
    const provenance = { matchId: sha, demoSha256: sha, mapName: prefix.match.map,
      parserVersion };
    const nativeRows = native.parseTicks(bytes, fields, plan.requestedTicks, ids);
    const joined = values => joinPrefixNativeRows(plan, ids, values, provenance);
    const rows = joined(nativeRows);
    const fragment = await buildPrefixReviewFragment(prefix, roster, rows, anchor);
    assert.equal(fragment.status, "eligible-for-fact-review", `${round}: ${fragment.reason}`);
    assert.equal(fragment.privacy, "local-only");
    assert.equal(fragment.informationScope, "server-global");
    assert.equal(fragment.selection.retrospectiveAtStart, true);
    assert.equal(fragment.coachingOpportunity, "unassessed");
    assert.equal(fragment.coachingJudgment, "not-made");
    assert.deepEqual(fragment.methodVersions,
      { distance: "scaled-hypot-xy-xyz-v1", endpoint: "endpoint-delta-v1" });
    const sourceRound = prefix.match.rounds.find(item => item.number === round);
    const historicalCoreTicks = [...new Set([roster.baselineTick,
      ...sourceRound.events.filter(event => event.tick >= roster.baselineTick && event.tick < anchor)
        .map(event => event.tick)])];
    assert.equal(fragment.startTick, Math.max(...historicalCoreTicks));
    assert.deepEqual(fragment.selection.sourceEventIndices,
      sourceRound.events.flatMap((event, index) => event.tick === fragment.startTick ? [index] : []));
    assert.deepEqual(fragment.selection.formationEventIndices,
      roster.groups.find(group => group.tick === anchor).eventIndices);
    assert.equal(fragment.selection.consideredCoreTicks, historicalCoreTicks.length);
    assert.equal(fragment.selection.excludedEarlierCoreTicks, historicalCoreTicks.length - 1);
    assert.deepEqual(fragment.coverage, { requiredEndpointRows: 4, verifiedEndpointRows: 4,
      interiorEvaluatedTicks: 0, interiorNotEvaluatedTicks: fragment.tickGap - 1,
      contraryEvidence: "not-assessed", unknownFields: ["interior-path", "map-geometry",
        "player-knowledge", "action-opportunity"] });
    assert.equal(fragment.participants.length, 2);
    assert.deepEqual(fragment.participants.map(player => player.playerId), ids.slice().sort());
    const start = native.parseTicks(bytes, fields, [fragment.startTick], ids)
      .sort((a, b) => a.steamid.localeCompare(b.steamid));
    const end = native.parseTicks(bytes, fields, [anchor], ids)
      .sort((a, b) => a.steamid.localeCompare(b.steamid));
    assert.equal(start.length, 2);
    assert.equal(end.length, 2);
    const distance = points => {
      const xy = Math.hypot(points[0].X - points[1].X, points[0].Y - points[1].Y);
      return { xy, xyz: Math.hypot(xy, Math.abs(points[0].Z - points[1].Z)) };
    };
    assert.equal(fragment.separation.startHorizontal, distance(start).xy);
    assert.equal(fragment.separation.startThreeDimensional, distance(start).xyz);
    assert.equal(fragment.separation.formationHorizontal, distance(end).xy);
    assert.equal(fragment.separation.formationThreeDimensional, distance(end).xyz);
    assert.equal(fragment.separation.horizontalChange, distance(end).xy - distance(start).xy);
    assert.equal(fragment.separation.threeDimensionalChange, distance(end).xyz - distance(start).xyz);
    for (const player of fragment.participants) {
      const before = start.find(row => row.steamid === player.playerId);
      const after = end.find(row => row.steamid === player.playerId);
      assert.ok(before && after);
      const xy = Math.hypot(after.X - before.X, after.Y - before.Y);
      assert.equal(player.horizontalDisplacement, xy);
      const independent3d = Math.hypot(xy, after.Z - before.Z);
      assert.ok(Math.abs(player.threeDimensionalDisplacement - independent3d)
        <= Number.EPSILON * Math.max(1, independent3d) * 4);
      assert.equal(player.signedYawDeltaDegrees,
        ((after.yaw - before.yaw + 540) % 360) - 180);
      assert.deepEqual(player.startCoverageReasons, rows.observations.find(row =>
        row.requestedTick === fragment.startTick && row.playerId === player.playerId).coverage.reasons);
      assert.deepEqual(player.formationCoverageReasons, rows.observations.find(row =>
        row.requestedTick === anchor && row.playerId === player.playerId).coverage.reasons);
    }

    const futureRaw = { ...raw, finalScore: [99, 0],
      players: [{ steamid: "987654321", name: "FUTURE_SECRET" }],
      events: [...raw.events, ...Array.from({ length: 50 }, (_, index) => ({
        event_name: "player_death", tick: cut + index,
        total_rounds_played: 99, user_steamid: "987654321", user_team_num: 2,
      }))],
      stateRows: [...raw.stateRows, { tick: cut + 1, steamid: "987654321",
        team_num: 2, is_alive: true, X: 9999 }],
    };
    const futurePrefix = convertNativePrefix(futureRaw, cut);
    const futureRoster = resolvePrefixRoster(futurePrefix, round);
    const futurePlan = planPrefixSpatialTicks(futurePrefix.match, cut, { tickBudget: 0 });
    assert.deepEqual(futurePlan, plan);
    const futureRows = joinPrefixNativeRows(futurePlan, ids,
      [...nativeRows, { ...end[0], tick: cut + 1, X: 9999 }], provenance);
    assert.deepEqual(await buildPrefixReviewFragment(futurePrefix, futureRoster, futureRows, anchor), fragment);

    const changed = joined(nativeRows.map(row => row.tick === fragment.startTick && row.steamid === ids[0]
      ? { ...row, X: row.X + 10 } : row));
    const changedFragment = await buildPrefixReviewFragment(prefix, roster, changed, anchor);
    assert.equal(changedFragment.status, "eligible-for-fact-review");
    assert.notEqual(changedFragment.participants.find(player => player.playerId === ids[0]).startEvidenceRef,
      fragment.participants.find(player => player.playerId === ids[0]).startEvidenceRef);
    const missingStart = joined(nativeRows.filter(row => !(row.tick === fragment.startTick
      && row.steamid === ids[0])));
    assert.equal((await buildPrefixReviewFragment(prefix, roster, missingStart, anchor)).status, "unknown");
    const stale = structuredClone(rows);
    stale.observations.find(row => row.requestedTick === fragment.startTick
      && row.playerId === ids[0]).position.x += 10;
    assert.equal((await buildPrefixReviewFragment(prefix, roster, stale, anchor)).status, "unknown");
    const conflict = joined([...nativeRows, { ...start[0], X: start[0].X + 1 }]);
    assert.equal((await buildPrefixReviewFragment(prefix, roster, conflict, anchor)).status, "unknown");
    const wrongSource = structuredClone(rows);
    wrongSource.provenance.demoSha256 = "b".repeat(64);
    assert.equal((await buildPrefixReviewFragment(prefix, roster, wrongSource, anchor)).status,
      "unknown");
    const malformedSource = structuredClone(rows);
    malformedSource.provenance = null;
    assert.equal((await buildPrefixReviewFragment(prefix, roster, malformedSource, anchor)).status,
      "unknown");
    const missingAnchor = joined(nativeRows.filter(row => !(row.tick === anchor
      && row.steamid === ids[0])));
    assert.equal((await buildPrefixReviewFragment(prefix, roster, missingAnchor, anchor)).status, "unknown");
    const changedHp = joined(nativeRows.map(row => row.tick === fragment.startTick && row.steamid === ids[0]
      ? { ...row, health: row.health - 1 } : row));
    const changedHpFragment = await buildPrefixReviewFragment(prefix, roster, changedHp, anchor);
    assert.equal(changedHpFragment.status, "eligible-for-fact-review");
    assert.notEqual(changedHpFragment.participants.find(player => player.playerId === ids[0]).startEvidenceRef,
      fragment.participants.find(player => player.playerId === ids[0]).startEvidenceRef);
    if (round === anchors[0].round) {
      const removed = { ...raw, events: [...raw.events] };
      const deathIndex = removed.events.findIndex(event => event.event_name === "player_death"
        && event.tick === anchor && event.total_rounds_played === round - 1);
      assert.ok(deathIndex >= 0);
      removed.events.splice(deathIndex, 1);
      const removedPrefix = convertNativePrefix(removed, cut);
      const removedRoster = resolvePrefixRoster(removedPrefix, round);
      assert.equal((await buildPrefixReviewFragment(removedPrefix, removedRoster, rows, anchor)).status,
        "unknown");
    }
  }
});
