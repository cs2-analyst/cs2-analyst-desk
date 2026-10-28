/** Standalone v1 contracts. Never implicitly added to Match, archives or reports. */
export interface DemCoordinateSpaceV1 {
  system: "dem-server-xyz";
  unit: "DEM-world-unit";
  normalization: "native-unmodified-v1";
}

export interface DemPositionEvidenceV1 {
  schemaVersion: "dem-position-v1";
  matchId: string;
  demoSha256: string;
  mapName: string;
  coordinateSpace: DemCoordinateSpaceV1;
  parserVersion: string;
  /** Exact native row only; never a requested tick, nearest sample or interpolation. */
  actualTick: number | null;
  evidenceRef: string;
  playerId: string;
  position: { x: number; y: number; z: number } | null;
}

export type DemDistanceKind = "horizontal" | "three-dimensional";
export type DemDistanceFailure =
  | "invalid-kind" | "missing-input" | "invalid-schema" | "invalid-provenance"
  | "map-name-missing" | "map-name-conflict" | "different-demo" | "different-match"
  | "coordinate-space-unknown" | "different-parser" | "invalid-actual-tick"
  | "different-tick" | "position-missing" | "invalid-coordinate" | "numeric-overflow";

interface DemDistanceResultBaseV1 {
  schemaVersion: "dem-distance-v1";
  methodVersion: "scaled-hypot-xy-xyz-v1";
  kind: DemDistanceKind;
  unit: "DEM-world-unit";
  /** Global server facts do not certify any player's knowledge or perception. */
  informationScope: "server-global";
  /** Detached input snapshots preserve DEM, parser, player and actual-tick references. */
  inputs: readonly [DemPositionEvidenceV1 | null, DemPositionEvidenceV1 | null];
}

export type DemDistanceResultV1 = DemDistanceResultBaseV1 & (
  | { valid: true; value: number; actualTick: number; reason: null }
  | { valid: false; value: null; actualTick: null; reason: DemDistanceFailure }
);
