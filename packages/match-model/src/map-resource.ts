import type { DemCoordinateSpaceV1 } from "./distance.js";

export type MapCapabilityV1 = "overview-projection-arithmetic" | "horizontal-distance"
  | "three-dimensional-distance" | "version-matched-world-mapping"
  | "navigation-reachability" | "static-los" | "dynamic-occlusion";
export type MapResourceMatchStatus = "unconfirmed" | "matched" | "mismatched";

export interface MapResourceIdentityV1 {
  schemaVersion: "map-resource-identity-v1";
  resourceId: string;
  mapName: string;
  source: {
    kind: "steam-distribution" | "local-derived";
    reference: string;
    /** Resource's own version; never assumed equal to DEM/game build. */
    version: string | null;
  };
  digest: { kind: "content" | "controlled-manifest"; sha256: string };
  coordinateSpace: DemCoordinateSpaceV1;
  match: {
    status: MapResourceMatchStatus;
    targetDemoSha256: string | null;
    evidenceRefs: readonly string[];
  };
  scope: string;
  limitations: readonly string[];
  producerVersion: string;
}

export interface MapCapabilityEvidenceV1 {
  status: "validated" | "blocked" | "not-run";
  methodVersion: string;
  evidenceRefs: readonly string[];
  /** Canonical immutable identity string, produced by mapResourceIdentitySnapshot(). */
  boundIdentity: string;
}

export interface MapResourceRecordV1 {
  schemaVersion: "map-resource-record-v1";
  identity: MapResourceIdentityV1;
  capabilities: Partial<Record<MapCapabilityV1, MapCapabilityEvidenceV1>>;
}

export type MapCapabilityGateFailure = "invalid-record" | "invalid-target" | "map-name-conflict"
  | "invalid-digest" | "coordinate-space-unknown" | "resource-mismatched" | "different-demo"
  | "invalid-match-evidence" | "coordinate-distance-separate" | "not-implemented"
  | "capability-unverified" | "stale-capability-evidence";
export type MapCapabilityGateV1 = {
  schemaVersion: "map-capability-gate-v1";
  capability: MapCapabilityV1;
} & ({ allowed: true; reason: null } | { allowed: false; reason: MapCapabilityGateFailure });
