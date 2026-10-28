import type {
  DemDistanceFailure, DemDistanceKind, DemDistanceResultV1, DemPositionEvidenceV1,
} from "@cs2-analyst/match-model";
import { isCoordinateSpace, isSha256, nonEmptyText } from "./spatial-validation.js";

/** Exact same-tick server endpoints only. No resource, event stream, interpolation or I/O. */
export function calculateDemDistance(
  a: DemPositionEvidenceV1 | null | undefined,
  b: DemPositionEvidenceV1 | null | undefined,
  kind: DemDistanceKind,
): DemDistanceResultV1 {
  const snapshot = (p: DemPositionEvidenceV1 | null | undefined): DemPositionEvidenceV1 | null => p ? {
    schemaVersion: p.schemaVersion, matchId: p.matchId, demoSha256: p.demoSha256, mapName: p.mapName,
    coordinateSpace: p.coordinateSpace ? {
      system: p.coordinateSpace.system, unit: p.coordinateSpace.unit, normalization: p.coordinateSpace.normalization,
    } : p.coordinateSpace,
    parserVersion: p.parserVersion, actualTick: p.actualTick, evidenceRef: p.evidenceRef,
    playerId: p.playerId, position: p.position ? { x: p.position.x, y: p.position.y, z: p.position.z } : null,
  } : null;
  const base = {
    schemaVersion: "dem-distance-v1" as const, methodVersion: "scaled-hypot-xy-xyz-v1" as const,
    kind, unit: "DEM-world-unit" as const, informationScope: "server-global" as const,
    inputs: [snapshot(a), snapshot(b)] as const,
  };
  const fail = (reason: DemDistanceFailure): DemDistanceResultV1 =>
    ({ ...base, valid: false, value: null, actualTick: null, reason });
  if (kind !== "horizontal" && kind !== "three-dimensional") return fail("invalid-kind");
  if (!a || !b) return fail("missing-input");
  if ([a, b].some(p => p.schemaVersion !== "dem-position-v1")) return fail("invalid-schema");
  if ([a, b].some(p => !nonEmptyText(p.matchId) || !isSha256(p.demoSha256)
    || !nonEmptyText(p.parserVersion) || !nonEmptyText(p.playerId) || !nonEmptyText(p.evidenceRef)))
    return fail("invalid-provenance");
  if ([a, b].some(p => !nonEmptyText(p.mapName))) return fail("map-name-missing");
  if (a.mapName !== b.mapName) return fail("map-name-conflict");
  if (a.demoSha256 !== b.demoSha256) return fail("different-demo");
  if (a.matchId !== b.matchId) return fail("different-match");
  if (![a, b].every(p => isCoordinateSpace(p.coordinateSpace))) return fail("coordinate-space-unknown");
  if (a.parserVersion !== b.parserVersion) return fail("different-parser");
  if ([a, b].some(p => !Number.isSafeInteger(p.actualTick) || p.actualTick! < 0)) return fail("invalid-actual-tick");
  if (a.actualTick !== b.actualTick) return fail("different-tick");
  if (!a.position || !b.position) return fail("position-missing");
  // Even horizontal inputs must be complete XYZ evidence. Missing Z is never silently zeroed.
  if (![a, b].every(p => [p.position!.x, p.position!.y, p.position!.z].every(Number.isFinite)))
    return fail("invalid-coordinate");
  const horizontal = Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y);
  // Preserve the existing Deep Review arithmetic definition (nested scaled hypot).
  const value = kind === "horizontal" ? horizontal : Math.hypot(horizontal, Math.abs(a.position.z - b.position.z));
  if (!Number.isFinite(value)) return fail("numeric-overflow");
  return { ...base, valid: true, value, actualTick: a.actualTick!, reason: null };
}
