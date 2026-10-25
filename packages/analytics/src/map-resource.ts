import type {
  MapCapabilityGateFailure, MapCapabilityGateV1, MapCapabilityV1, MapResourceIdentityV1, MapResourceRecordV1,
} from "@cs2-analyst/match-model";
import { evidenceRefsValid, isCoordinateSpace, isSha256, nonEmptyText } from "./spatial-validation.js";

/** Canonical field order; object insertion order cannot change authorization. */
export function mapResourceIdentitySnapshot(i: MapResourceIdentityV1): string {
  return JSON.stringify([
    i.schemaVersion, i.resourceId, i.mapName, i.source?.kind, i.source?.reference, i.source?.version,
    i.digest?.kind, i.digest?.sha256, i.coordinateSpace?.system, i.coordinateSpace?.unit,
    i.coordinateSpace?.normalization, i.match?.status, i.match?.targetDemoSha256,
    i.match?.evidenceRefs, i.scope, i.limitations, i.producerVersion,
  ]);
}

/** Pure audit gate over trusted local records, not an authenticity/signature verifier.
 * Advanced capabilities remain closed even if a caller fabricates a validated entry.
 * Re-evaluate for every query; never cache allowed=true across identity changes.
 */
export function gateMapResourceCapability(
  record: MapResourceRecordV1 | null | undefined,
  target: { mapName: string; demoSha256: string },
  capability: MapCapabilityV1,
): MapCapabilityGateV1 {
  const base = { schemaVersion: "map-capability-gate-v1" as const, capability };
  const deny = (reason: MapCapabilityGateFailure): MapCapabilityGateV1 => ({ ...base, allowed: false, reason });
  const i = record?.identity;
  if (record?.schemaVersion !== "map-resource-record-v1" || i?.schemaVersion !== "map-resource-identity-v1"
    || !nonEmptyText(i.resourceId) || !nonEmptyText(i.mapName) || !nonEmptyText(i.source?.reference)
    || !["steam-distribution", "local-derived"].includes(i.source?.kind)
    || !(i.source.version === null || nonEmptyText(i.source.version))
    || !nonEmptyText(i.scope) || !evidenceRefsValid(i.limitations) || !nonEmptyText(i.producerVersion)
    || !["unconfirmed", "matched", "mismatched"].includes(i.match?.status)
    || !Array.isArray(i.match.evidenceRefs) || !i.match.evidenceRefs.every(nonEmptyText)) return deny("invalid-record");
  if (!target || !nonEmptyText(target.mapName) || !isSha256(target.demoSha256)) return deny("invalid-target");
  if (target.mapName !== i.mapName) return deny("map-name-conflict");
  if (!["content", "controlled-manifest"].includes(i.digest?.kind) || !isSha256(i.digest?.sha256)) return deny("invalid-digest");
  if (!isCoordinateSpace(i.coordinateSpace)) return deny("coordinate-space-unknown");
  if (i.match.status === "mismatched") return deny("resource-mismatched");
  if (i.match.targetDemoSha256 !== null) {
    if (!isSha256(i.match.targetDemoSha256)) return deny("invalid-match-evidence");
    if (i.match.targetDemoSha256 !== target.demoSha256) return deny("different-demo");
  }
  if (i.match.status === "matched" && (!i.match.targetDemoSha256 || !evidenceRefsValid(i.match.evidenceRefs)))
    return deny("invalid-match-evidence");
  // Distance authorization belongs to calculateDemDistance, never to resource identity.
  if (capability === "horizontal-distance" || capability === "three-dimensional-distance")
    return deny("coordinate-distance-separate");
  // No v1 implementation or verification threshold for these capabilities yet.
  if (capability !== "overview-projection-arithmetic") return deny("not-implemented");
  const proof = record.capabilities?.[capability];
  if (proof?.status !== "validated" || !nonEmptyText(proof.methodVersion) || !evidenceRefsValid(proof.evidenceRefs))
    return deny("capability-unverified");
  if (typeof proof.boundIdentity !== "string" || mapResourceIdentitySnapshot(i) !== proof.boundIdentity)
    return deny("stale-capability-evidence");
  return { ...base, allowed: true, reason: null };
}
