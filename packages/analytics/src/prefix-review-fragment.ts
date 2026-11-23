import type { DemPositionEvidenceV1 } from "@cs2-analyst/match-model";
import { calculateDemDistance } from "./distance.js";
import { buildPrefixEndpointChange } from "./prefix-endpoint-change.js";
import { buildPrefixSpatialContext, type PrefixRowsForContext } from "./prefix-spatial-context.js";
import type { PrefixMatchForRoster, PrefixRosterResult } from "./prefix-roster.js";

export type PrefixReviewFragmentFailure =
  | "anchor-context-unknown" | "prior-core-tick-unavailable" | "endpoint-change-unknown"
  | "start-distance-invalid" | "numeric-overflow";

export type PrefixReviewFragment =
  | { schemaVersion: "dem-prefix-review-fragment-v1"; status: "unknown";
      reason: PrefixReviewFragmentFailure; round: number; cutTick: number; anchorTick: number }
  | { schemaVersion: "dem-prefix-review-fragment-v1"; status: "eligible-for-fact-review";
      reason: null; methodVersion: "prior-core-to-formation-v1";
      informationScope: "server-global"; privacy: "local-only";
      provenance: { demoSha256: string; matchId: string; mapName: string; parserVersion: string };
      round: number; cutTick: number; startTick: number; anchorTick: number; tickGap: number;
      methodVersions: { distance: "scaled-hypot-xy-xyz-v1"; endpoint: "endpoint-delta-v1" };
      selection: { basis: "last-current-round-core-event-or-freeze-boundary";
        retrospectiveAtStart: true; sourceEventIndices: number[];
        formationEventIndices: number[]; consideredCoreTicks: number;
        excludedEarlierCoreTicks: number; exclusionReason: "not-most-recent" };
      participants: { playerId: string; side: "CT" | "T";
        startEvidenceRef: string; endEvidenceRef: string;
        startCoverageReasons: string[]; formationCoverageReasons: string[];
        horizontalDisplacement: number; threeDimensionalDisplacement: number;
        signedYawDeltaDegrees: number }[];
      separation: { startHorizontal: number; startThreeDimensional: number;
        formationHorizontal: number; formationThreeDimensional: number;
        horizontalChange: number; threeDimensionalChange: number;
        unit: "DEM-world-unit" };
      coverage: { requiredEndpointRows: 4; verifiedEndpointRows: 4;
        interiorEvaluatedTicks: 0; interiorNotEvaluatedTicks: number;
        contraryEvidence: "not-assessed";
        unknownFields: readonly ["interior-path", "map-geometry", "player-knowledge",
          "action-opportunity"] };
      reviewQuestion: "How did the exact server-side endpoints and separation change before 1v1 formation?";
      coachingOpportunity: "unassessed"; coachingJudgment: "not-made";
      unsupportedClaims: readonly ["continuous-path", "route", "LOS", "support",
        "player-knowledge", "intent", "causal-benefit"] };

/**
 * Local evidence bundle for a reviewer, not a coach finding or model input.
 * It selects a prior core tick from the admitted prefix and never reads a
 * future result. Event-index references do not impose order within a tick.
 */
export async function buildPrefixReviewFragment(
  prefix: PrefixMatchForRoster,
  roster: PrefixRosterResult,
  rows: PrefixRowsForContext,
  anchorTick: number,
): Promise<PrefixReviewFragment> {
  const base = { schemaVersion: "dem-prefix-review-fragment-v1" as const,
    round: roster.round, cutTick: roster.cutTick, anchorTick };
  const fail = (reason: PrefixReviewFragmentFailure): PrefixReviewFragment =>
    ({ ...base, status: "unknown", reason });
  const context = await buildPrefixSpatialContext(prefix, roster, rows, anchorTick);
  if (context.status !== "known" || roster.status !== "known") return fail("anchor-context-unknown");
  if (!context.horizontal.valid || !context.threeDimensional.valid)
    return fail("anchor-context-unknown");
  const round = prefix.match.rounds.find(item => item.number === roster.round);
  const priorEvents = (round?.events ?? []).map((event, eventIndex) => ({ tick: event.tick, eventIndex }))
    .filter(item => item.tick >= roster.baselineTick && item.tick < anchorTick);
  const consideredCoreTicks = [...new Set([roster.baselineTick, ...priorEvents.map(item => item.tick)])];
  let startTick = roster.baselineTick;
  for (const tick of consideredCoreTicks) startTick = Math.max(startTick, tick);
  if (!Number.isSafeInteger(startTick) || startTick >= anchorTick
    || !rows.requestedTicks.includes(startTick) || !rows.returnedTicks.includes(startTick))
    return fail("prior-core-tick-unavailable");
  const changes = await Promise.all(context.players.map(player => buildPrefixEndpointChange(
    prefix, roster, rows, player.playerId, startTick, anchorTick)));
  if (changes.some(change => change.status !== "known")) return fail("endpoint-change-unknown");
  const known = changes.filter((change): change is Extract<typeof change, { status: "known" }> =>
    change.status === "known");
  const starts: DemPositionEvidenceV1[] = known.map(change => {
    const observation = rows.observations.find(row => row.requestedTick === startTick
      && row.playerId === change.playerId)!;
    return { schemaVersion: "dem-position-v1", matchId: rows.provenance.matchId,
      demoSha256: rows.provenance.demoSha256, mapName: rows.provenance.mapName,
      parserVersion: rows.provenance.parserVersion,
      coordinateSpace: { system: "dem-server-xyz", unit: "DEM-world-unit",
        normalization: "native-unmodified-v1" }, actualTick: startTick,
      evidenceRef: change.startEvidenceRef, playerId: change.playerId,
      position: observation.position };
  });
  const startHorizontal = calculateDemDistance(starts[0], starts[1], "horizontal");
  const startThreeDimensional = calculateDemDistance(starts[0], starts[1], "three-dimensional");
  if (!startHorizontal.valid || !startThreeDimensional.valid) return fail("start-distance-invalid");
  const horizontalChange = context.horizontal.value - startHorizontal.value;
  const threeDimensionalChange = context.threeDimensional.value - startThreeDimensional.value;
  if (![horizontalChange, threeDimensionalChange].every(Number.isFinite))
    return fail("numeric-overflow");
  return { ...base, status: "eligible-for-fact-review", reason: null,
    methodVersion: "prior-core-to-formation-v1", informationScope: "server-global",
    privacy: "local-only", provenance: { ...rows.provenance }, startTick,
    tickGap: anchorTick - startTick,
    methodVersions: { distance: startHorizontal.methodVersion, endpoint: known[0].methodVersion },
    selection: { basis: "last-current-round-core-event-or-freeze-boundary",
      retrospectiveAtStart: true,
      sourceEventIndices: priorEvents.filter(item => item.tick === startTick)
        .map(item => item.eventIndex), formationEventIndices: [...context.eventIndices],
      consideredCoreTicks: consideredCoreTicks.length,
      excludedEarlierCoreTicks: consideredCoreTicks.length - 1,
      exclusionReason: "not-most-recent" },
    participants: known.map(change => ({ playerId: change.playerId, side: change.side,
      startEvidenceRef: change.startEvidenceRef, endEvidenceRef: change.endEvidenceRef,
      startCoverageReasons: [...rows.observations.find(row => row.requestedTick === startTick
        && row.playerId === change.playerId)!.coverage.reasons],
      formationCoverageReasons: [...rows.observations.find(row => row.requestedTick === anchorTick
        && row.playerId === change.playerId)!.coverage.reasons],
      horizontalDisplacement: change.horizontalDisplacement,
      threeDimensionalDisplacement: change.threeDimensionalDisplacement,
      signedYawDeltaDegrees: change.signedYawDeltaDegrees })),
    separation: { startHorizontal: startHorizontal.value,
      startThreeDimensional: startThreeDimensional.value,
      formationHorizontal: context.horizontal.value,
      formationThreeDimensional: context.threeDimensional.value,
      horizontalChange, threeDimensionalChange, unit: "DEM-world-unit" },
    coverage: { requiredEndpointRows: 4, verifiedEndpointRows: 4,
      interiorEvaluatedTicks: 0, interiorNotEvaluatedTicks: anchorTick - startTick - 1,
      contraryEvidence: "not-assessed",
      unknownFields: ["interior-path", "map-geometry", "player-knowledge", "action-opportunity"] },
    reviewQuestion: "How did the exact server-side endpoints and separation change before 1v1 formation?",
    coachingOpportunity: "unassessed", coachingJudgment: "not-made",
    unsupportedClaims: ["continuous-path", "route", "LOS", "support",
      "player-knowledge", "intent", "causal-benefit"] };
}
