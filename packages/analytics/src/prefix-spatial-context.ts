import type { DemDistanceResultV1, DemPositionEvidenceV1 } from "@cs2-analyst/match-model";
import { calculateDemDistance } from "./distance.js";
import { resolvePrefixRoster, type PrefixMatchForRoster, type PrefixRosterResult } from "./prefix-roster.js";

interface RowObservation {
  requestedTick: number;
  actualTick: number | null;
  playerId: string;
  evidenceRef: string | null;
  position: { x: number; y: number; z: number } | null;
  view: { yaw: number; pitch: number } | null;
  health: number | null;
  alive: boolean | null;
  side: "CT" | "T" | "Unknown";
  activeWeapon: string | null;
  coverage: { status: "complete" | "partial" | "unavailable"; reasons: string[] };
}

/** Structural input from the parser's local prefix row join; no runtime parser dependency. */
export interface PrefixRowsForContext {
  schemaVersion: "dem-prefix-rows-v1";
  cutTick: number;
  provenance: { matchId: string; demoSha256: string; mapName: string; parserVersion: string };
  requestedTicks: number[];
  playerIds: string[];
  returnedTicks: number[];
  observations: RowObservation[];
}

export type PrefixSpatialContextFailure =
  | "roster-unknown" | "prefix-contract-mismatch" | "roster-source-mismatch"
  | "not-one-vs-one" | "formation-tick-mismatch"
  | "rows-contract-mismatch" | "selected-players-mismatch" | "anchor-row-missing-or-duplicate"
  | "anchor-state-incomplete" | "evidence-ref-mismatch" | "evidence-verifier-unavailable"
  | "distance-invalid" | "formation-evidence-missing";

export type PrefixSpatialContext =
  | { schemaVersion: "dem-prefix-spatial-context-v1"; status: "unknown";
      reason: PrefixSpatialContextFailure; round: number; cutTick: number; anchorTick: number }
  | { schemaVersion: "dem-prefix-spatial-context-v1"; status: "known"; reason: null;
      /** Local server facts. A separate projection must alias player and DEM identities. */
      round: number; cutTick: number; anchorTick: number; informationScope: "server-global";
      anchorCoverage: "complete"; eventIndices: number[];
      players: { playerId: string; side: "CT" | "T"; actualTick: number; evidenceRef: string }[];
      horizontal: DemDistanceResultV1; threeDimensional: DemDistanceResultV1 };

/**
 * Bind a verified 1v1 formation to two exact native endpoints and existing
 * numeric distance arithmetic. This local bundle does not prove visibility,
 * path reachability, player knowledge, or a coaching opportunity.
 */
export async function buildPrefixSpatialContext(
  prefix: PrefixMatchForRoster,
  roster: PrefixRosterResult,
  rows: PrefixRowsForContext,
  anchorTick: number,
): Promise<PrefixSpatialContext> {
  const base = { schemaVersion: "dem-prefix-spatial-context-v1" as const,
    round: roster.round, cutTick: roster.cutTick, anchorTick };
  const fail = (reason: PrefixSpatialContextFailure): PrefixSpatialContext =>
    ({ ...base, status: "unknown", reason });
  if (roster.status !== "known") return fail("roster-unknown");
  if (prefix?.schemaVersion !== "dem-native-prefix-match-v1" || prefix.cutTick !== roster.cutTick
    || !prefix.match) return fail("prefix-contract-mismatch");
  if (JSON.stringify(resolvePrefixRoster(prefix, roster.round)) !== JSON.stringify(roster))
    return fail("roster-source-mismatch");
  if (!roster.eligibleOneVsOne || roster.survivors.length !== 2) return fail("not-one-vs-one");
  if (!Number.isSafeInteger(anchorTick) || anchorTick < 0 || anchorTick >= roster.cutTick
    || roster.oneVsOneFormedAtTick !== anchorTick) return fail("formation-tick-mismatch");
  if (rows?.schemaVersion !== "dem-prefix-rows-v1" || rows.cutTick !== roster.cutTick
    || !rows.provenance || rows.provenance.matchId !== prefix.match.id
    || rows.provenance.demoSha256 !== prefix.match.id
    || rows.provenance.mapName !== prefix.match.map
    || typeof rows.provenance.parserVersion !== "string" || !rows.provenance.parserVersion
    || !Array.isArray(rows.requestedTicks) || !rows.requestedTicks.includes(anchorTick)
    || !Array.isArray(rows.returnedTicks) || !rows.returnedTicks.includes(anchorTick)
    || !Array.isArray(rows.observations) || !Array.isArray(rows.playerIds))
    return fail("rows-contract-mismatch");
  const survivors = [...roster.survivors].sort((a, b) => a.playerId.localeCompare(b.playerId));
  if (JSON.stringify([...rows.playerIds].sort()) !== JSON.stringify(survivors.map(player => player.playerId)))
    return fail("selected-players-mismatch");
  const formation = roster.groups.filter(group => group.tick === anchorTick);
  if (formation.length !== 1 || formation[0].eventIndices.length === 0)
    return fail("formation-evidence-missing");

  const observations: RowObservation[] = [];
  for (const player of survivors) {
    const matches = rows.observations.filter(row => row.requestedTick === anchorTick && row.playerId === player.playerId);
    if (matches.length !== 1) return fail("anchor-row-missing-or-duplicate");
    const row = matches[0];
    if (row.actualTick !== anchorTick || row.alive !== true || row.side !== player.side
      || row.coverage?.status !== "complete"
      || !/^native-exact:[a-f0-9]{64}$/.test(row.evidenceRef ?? "") || !row.position || !row.view
      || ![row.position.x, row.position.y, row.position.z, row.view.yaw, row.view.pitch].every(Number.isFinite)
      || row.view.yaw < -180 || row.view.yaw > 180 || row.view.pitch < -90 || row.view.pitch > 90
      || !Number.isSafeInteger(row.health) || row.health! < 0)
      return fail("anchor-state-incomplete");
    if (!globalThis.crypto?.subtle) return fail("evidence-verifier-unavailable");
    const normalized = { position: row.position, view: row.view, health: row.health,
      alive: row.alive, side: row.side, activeWeapon: row.activeWeapon };
    const bytes = new TextEncoder().encode(JSON.stringify([
      rows.provenance.demoSha256, rows.provenance.matchId, rows.provenance.mapName,
      rows.provenance.parserVersion, anchorTick, player.playerId, normalized,
    ]));
    const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    const expectedRef = `native-exact:${[...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("")}`;
    if (row.evidenceRef !== expectedRef) return fail("evidence-ref-mismatch");
    observations.push(row);
  }
  const inputs = observations.map(row => ({ schemaVersion: "dem-position-v1" as const,
    matchId: rows.provenance.matchId, demoSha256: rows.provenance.demoSha256,
    mapName: rows.provenance.mapName, parserVersion: rows.provenance.parserVersion,
    coordinateSpace: { system: "dem-server-xyz" as const, unit: "DEM-world-unit" as const,
      normalization: "native-unmodified-v1" as const }, actualTick: row.actualTick,
    evidenceRef: row.evidenceRef!, playerId: row.playerId, position: row.position,
  })) as [DemPositionEvidenceV1, DemPositionEvidenceV1];
  const horizontal = calculateDemDistance(inputs[0], inputs[1], "horizontal");
  const threeDimensional = calculateDemDistance(inputs[0], inputs[1], "three-dimensional");
  if (!horizontal.valid || !threeDimensional.valid) return fail("distance-invalid");
  return { ...base, status: "known", reason: null, informationScope: "server-global",
    anchorCoverage: "complete", eventIndices: [...formation[0].eventIndices],
    players: survivors.map((player, index) => ({ playerId: player.playerId, side: player.side,
      actualTick: anchorTick, evidenceRef: observations[index].evidenceRef! })),
    horizontal, threeDimensional };
}
