import type { DemCoordinateSpaceV1 } from "@cs2-analyst/match-model";

export const nonEmptyText = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 && value === value.trim();
export const isSha256 = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export const isCoordinateSpace = (value: DemCoordinateSpaceV1 | null | undefined): boolean =>
  value?.system === "dem-server-xyz" && value.unit === "DEM-world-unit"
  && value.normalization === "native-unmodified-v1";
export const evidenceRefsValid = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length > 0 && value.every(nonEmptyText);
