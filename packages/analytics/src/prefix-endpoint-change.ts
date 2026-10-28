import { buildPrefixSpatialContext, type PrefixRowsForContext } from "./prefix-spatial-context.js";
import type { PrefixMatchForRoster, PrefixRosterResult } from "./prefix-roster.js";

export type PrefixEndpointChangeFailure =
  | "anchor-context-unknown" | "player-not-survivor" | "invalid-interval"
  | "start-tick-not-returned"
  | "start-row-missing-or-duplicate" | "start-state-incomplete"
  | "start-evidence-ref-mismatch" | "evidence-verifier-unavailable" | "displacement-invalid";

export type PrefixEndpointChange =
  | { schemaVersion: "dem-prefix-endpoint-change-v1"; status: "unknown";
      reason: PrefixEndpointChangeFailure; round: number; cutTick: number;
      startTick: number; endTick: number }
  | { schemaVersion: "dem-prefix-endpoint-change-v1"; status: "known"; reason: null;
      informationScope: "server-global"; privacy: "local-only"; methodVersion: "endpoint-delta-v1";
      round: number; cutTick: number; startTick: number; endTick: number; tickGap: number;
      provenance: { demoSha256: string; matchId: string; mapName: string; parserVersion: string };
      startSelection: "freeze-boundary" | "prefix-core-event";
      playerId: string; side: "CT" | "T"; startEvidenceRef: string; endEvidenceRef: string;
      formationEventIndices: number[]; coordinateUnit: "DEM-world-unit";
      endpointCoverage: { start: "complete"; end: "complete" };
      interiorCoverage: { exclusiveTicks: [number, number]; evaluatedTicks: []; notEvaluatedCount: number };
      delta: { x: number; y: number; z: number }; horizontalDisplacement: number;
      threeDimensionalDisplacement: number; signedYawDeltaDegrees: number;
      interiorPath: "not-observed-by-this-method" };

/**
 * Exact endpoint comparison for a survivor from a verified 5v5 prefix roster.
 * The second endpoint is the 1v1 formation tick. Intermediate travel, speed,
 * route, visibility, knowledge and tactical quality are outside this method.
 */
export async function buildPrefixEndpointChange(
  prefix: PrefixMatchForRoster,
  roster: PrefixRosterResult,
  rows: PrefixRowsForContext,
  playerId: string,
  startTick: number,
  endTick: number,
): Promise<PrefixEndpointChange> {
  const base = { schemaVersion: "dem-prefix-endpoint-change-v1" as const,
    round: roster.round, cutTick: roster.cutTick, startTick, endTick };
  const fail = (reason: PrefixEndpointChangeFailure): PrefixEndpointChange =>
    ({ ...base, status: "unknown", reason });
  const anchor = await buildPrefixSpatialContext(prefix, roster, rows, endTick);
  if (anchor.status !== "known") return fail("anchor-context-unknown");
  if (roster.status !== "known") return fail("anchor-context-unknown");
  const survivor = roster.survivors.find(player => player.playerId === playerId);
  if (!survivor) return fail("player-not-survivor");
  const round = prefix.match.rounds.find(item => item.number === roster.round);
  const startSelection = startTick === roster.baselineTick ? "freeze-boundary"
    : round?.events.some(event => event.tick === startTick) ? "prefix-core-event" : null;
  if (!Number.isSafeInteger(startTick) || startTick < roster.baselineTick
    || startTick >= endTick || !startSelection || !rows.requestedTicks.includes(startTick))
    return fail("invalid-interval");
  if (!rows.returnedTicks.includes(startTick)) return fail("start-tick-not-returned");
  const candidates = rows.observations.filter(row => row.requestedTick === startTick
    && row.playerId === playerId);
  if (candidates.length !== 1) return fail("start-row-missing-or-duplicate");
  const start = candidates[0];
  if (start.actualTick !== startTick || start.alive !== true || start.side !== survivor.side
    || start.coverage?.status !== "complete" || !start.position || !start.view
    || ![start.position.x, start.position.y, start.position.z,
      start.view.yaw, start.view.pitch].every(Number.isFinite)
    || start.view.yaw < -180 || start.view.yaw > 180
    || start.view.pitch < -90 || start.view.pitch > 90
    || !Number.isSafeInteger(start.health) || start.health! < 0
    || !/^native-exact:[a-f0-9]{64}$/.test(start.evidenceRef ?? ""))
    return fail("start-state-incomplete");
  if (!globalThis.crypto?.subtle) return fail("evidence-verifier-unavailable");
  const normalized = { position: start.position, view: start.view, health: start.health,
    alive: start.alive, side: start.side, activeWeapon: start.activeWeapon };
  const bytes = new TextEncoder().encode(JSON.stringify([
    rows.provenance.demoSha256, rows.provenance.matchId, rows.provenance.mapName,
    rows.provenance.parserVersion, startTick, playerId, normalized,
  ]));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  const expectedRef = `native-exact:${[...new Uint8Array(digest)]
    .map(byte => byte.toString(16).padStart(2, "0")).join("")}`;
  if (start.evidenceRef !== expectedRef) return fail("start-evidence-ref-mismatch");
  const end = rows.observations.find(row => row.requestedTick === endTick && row.playerId === playerId)!;
  const delta = { x: end.position!.x - start.position.x,
    y: end.position!.y - start.position.y, z: end.position!.z - start.position.z };
  const horizontalDisplacement = Math.hypot(delta.x, delta.y);
  const threeDimensionalDisplacement = Math.hypot(delta.x, delta.y, delta.z);
  const signedYawDeltaDegrees = ((end.view!.yaw - start.view.yaw + 540) % 360) - 180;
  if (![delta.x, delta.y, delta.z, horizontalDisplacement,
    threeDimensionalDisplacement, signedYawDeltaDegrees].every(Number.isFinite))
    return fail("displacement-invalid");
  const endEvidence = anchor.players.find(player => player.playerId === playerId)!;
  return { ...base, status: "known", reason: null, informationScope: "server-global",
    privacy: "local-only", methodVersion: "endpoint-delta-v1", tickGap: endTick - startTick,
    provenance: { demoSha256: rows.provenance.demoSha256, matchId: rows.provenance.matchId,
      mapName: rows.provenance.mapName, parserVersion: rows.provenance.parserVersion },
    startSelection,
    playerId, side: survivor.side, startEvidenceRef: start.evidenceRef!,
    endEvidenceRef: endEvidence.evidenceRef, formationEventIndices: anchor.eventIndices,
    coordinateUnit: "DEM-world-unit", endpointCoverage: { start: "complete", end: "complete" },
    interiorCoverage: { exclusiveTicks: [startTick, endTick], evaluatedTicks: [],
      notEvaluatedCount: endTick - startTick - 1 }, delta, horizontalDisplacement,
    threeDimensionalDisplacement, signedYawDeltaDegrees,
    interiorPath: "not-observed-by-this-method" };
}
