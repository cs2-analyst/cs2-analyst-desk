import { createHash } from "node:crypto";
import type { TeamSide } from "@cs2-analyst/match-model";
import type { PrefixTickPlan } from "./prefix-ticks.js";

export interface PrefixRowProvenance {
  matchId: string;
  demoSha256: string;
  mapName: string;
  parserVersion: string;
}

export type PrefixRowCoverageReason =
  | "requested-tick-missing" | "player-row-missing" | "conflicting-player-row"
  | "unidentified-row-at-requested-tick"
  | "position-missing" | "view-missing" | "state-missing" | "state-conflict" | "weapon-unavailable";

export interface PrefixPlayerObservation {
  requestedTick: number;
  actualTick: number | null;
  /** Local stable ID only. Model-facing projections must replace it with an alias. */
  playerId: string;
  /** Digest of the local DEM/tick/player/canonical row locator; never a public alias. */
  evidenceRef: string | null;
  position: { x: number; y: number; z: number } | null;
  view: { yaw: number; pitch: number } | null;
  health: number | null;
  alive: boolean | null;
  side: TeamSide;
  activeWeapon: string | null;
  /** Complete covers XYZ, view, HP, alive and side; optional weapon can be unavailable. */
  coverage: { status: "complete" | "partial" | "unavailable"; reasons: PrefixRowCoverageReason[] };
}

export interface PrefixNativeRows {
  schemaVersion: "dem-prefix-rows-v1";
  informationScope: "server-global";
  privacy: "local-only";
  cutTick: number;
  provenance: PrefixRowProvenance;
  requestedTicks: number[];
  playerIds: string[];
  returnedTicks: number[];
  /** Unique requested-tick/selected-player keys; identical rows are idempotent. */
  selectedRowCount: number;
  /** Unattributable rows at requested ticks conservatively invalidate that tick. */
  unidentifiedRequestedTickRows: number;
  observations: PrefixPlayerObservation[];
}

const validTick = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const identity = (value: unknown): value is string => typeof value === "string" && /^[1-9]\d*$/.test(value);
const finite = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

type NativeRow = Record<string, unknown>;
type Values = Pick<PrefixPlayerObservation, "position" | "view" | "health" | "alive" | "side" | "activeWeapon">;

function values(row: NativeRow): Values {
  const x = finite(row.X), y = finite(row.Y), z = finite(row.Z);
  const yaw = finite(row.yaw), pitch = finite(row.pitch);
  const hp = finite(row.health);
  return {
    position: x !== null && y !== null && z !== null ? { x, y, z } : null,
    view: yaw !== null && yaw >= -180 && yaw <= 180 && pitch !== null && pitch >= -90 && pitch <= 90
      ? { yaw, pitch } : null,
    health: hp !== null && Number.isSafeInteger(hp) && hp >= 0 ? hp : null,
    alive: typeof row.is_alive === "boolean" ? row.is_alive : null,
    side: row.team_num === 2 ? "T" : row.team_num === 3 ? "CT" : "Unknown",
    activeWeapon: nonEmpty(row.active_weapon_name) ? row.active_weapon_name : null,
  };
}

function validPlan(plan: PrefixTickPlan): boolean {
  if (plan?.schemaVersion !== "dem-prefix-ticks-v1" || !validTick(plan.cutTick) || plan.cutTick === 0
    || !Array.isArray(plan.coreTicks) || !Array.isArray(plan.optionalTicks)
    || !Array.isArray(plan.omittedOptionalTicks) || !Array.isArray(plan.requestedTicks)) return false;
  const all = [...plan.coreTicks, ...plan.optionalTicks];
  if (all.some(tick => !validTick(tick) || tick >= plan.cutTick) || new Set(all).size !== all.length) return false;
  const sorted = [...all].sort((a, b) => a - b);
  if (JSON.stringify(sorted) !== JSON.stringify(plan.requestedTicks)) return false;
  if (plan.omittedOptionalTicks.some(tick => !validTick(tick) || tick >= plan.cutTick || all.includes(tick))) return false;
  return true;
}

/**
 * Join native parseTicks rows to an already frozen prefix plan and an explicitly
 * selected local player set. It never derives players from a full-match roster,
 * fills missing rows from nearby ticks, or counts unrequested future rows.
 */
export function joinPrefixNativeRows(
  plan: PrefixTickPlan,
  selectedPlayerIds: readonly string[],
  rawRows: unknown,
  provenance: PrefixRowProvenance,
): PrefixNativeRows {
  if (!validPlan(plan)) throw new Error("invalid-prefix-plan");
  if (!Array.isArray(selectedPlayerIds) || selectedPlayerIds.length === 0
    || selectedPlayerIds.some(id => !identity(id)) || new Set(selectedPlayerIds).size !== selectedPlayerIds.length)
    throw new Error("invalid-selected-players");
  if (!Array.isArray(rawRows)) throw new Error("invalid-native-rows");
  if (!nonEmpty(provenance?.matchId) || !/^[a-f0-9]{64}$/.test(provenance.demoSha256)
    || !nonEmpty(provenance.mapName) || !nonEmpty(provenance.parserVersion))
    throw new Error("invalid-row-provenance");

  const playerIds = [...selectedPlayerIds].sort();
  const requested = new Set(plan.requestedTicks);
  const players = new Set(playerIds);
  const returned = new Set<number>();
  const rows = new Map<string, Values[]>();
  const unidentifiedByTick = new Map<number, number>();
  for (const raw of rawRows) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid-native-row");
    const row = raw as NativeRow;
    if (!validTick(row.tick)) throw new Error("unlocatable-native-row-tick");
    if (!requested.has(row.tick)) continue;
    returned.add(row.tick);
    if (!identity(row.steamid)) {
      unidentifiedByTick.set(row.tick, (unidentifiedByTick.get(row.tick) ?? 0) + 1);
      continue;
    }
    if (!players.has(row.steamid)) continue;
    const key = `${row.tick}:${row.steamid}`;
    const list = rows.get(key) ?? [];
    list.push(values(row));
    rows.set(key, list);
  }

  const observations: PrefixPlayerObservation[] = [];
  for (const requestedTick of plan.requestedTicks) for (const playerId of playerIds) {
    const candidates = rows.get(`${requestedTick}:${playerId}`) ?? [];
    const conflict = candidates.length > 1 && candidates.some(value => JSON.stringify(value) !== JSON.stringify(candidates[0]));
    const identityUnknown = unidentifiedByTick.has(requestedTick);
    const value = candidates.length > 0 && !conflict && !identityUnknown ? candidates[0] : null;
    const reasons: PrefixRowCoverageReason[] = [];
    if (identityUnknown) reasons.push("unidentified-row-at-requested-tick");
    else if (conflict) reasons.push("conflicting-player-row");
    else if (!value) reasons.push(returned.has(requestedTick) ? "player-row-missing" : "requested-tick-missing");
    const stateConflict = value !== null && value.health !== null && value.alive !== null
      && ((value.alive && value.health === 0) || (!value.alive && value.health > 0));
    if (value) {
      if (!value.position) reasons.push("position-missing");
      if (!value.view) reasons.push("view-missing");
      if (value.health === null || value.alive === null || value.side === "Unknown") reasons.push("state-missing");
      if (stateConflict) reasons.push("state-conflict");
      if (!value.activeWeapon) reasons.push("weapon-unavailable");
    }
    const requiredCount = value ? Number(value.position !== null) + Number(value.view !== null)
      + Number(value.health !== null) + Number(value.alive !== null) + Number(value.side !== "Unknown") : 0;
    const status = requiredCount === 5 && !stateConflict ? "complete" : requiredCount > 0 ? "partial" : "unavailable";
    const evidenceRef = value ? `native-exact:${createHash("sha256").update(JSON.stringify([
      provenance.demoSha256, provenance.matchId, provenance.mapName, provenance.parserVersion,
      requestedTick, playerId, value,
    ])).digest("hex")}` : null;
    observations.push({ requestedTick, actualTick: value ? requestedTick : null, playerId,
      evidenceRef,
      position: value?.position ?? null, view: value?.view ?? null, health: value?.health ?? null,
      alive: value?.alive ?? null, side: value?.side ?? "Unknown", activeWeapon: value?.activeWeapon ?? null,
      coverage: { status, reasons } });
  }
  return { schemaVersion: "dem-prefix-rows-v1", informationScope: "server-global", privacy: "local-only",
    cutTick: plan.cutTick, provenance: { matchId: provenance.matchId, demoSha256: provenance.demoSha256,
      mapName: provenance.mapName, parserVersion: provenance.parserVersion },
    requestedTicks: [...plan.requestedTicks], playerIds, returnedTicks: [...returned].sort((a, b) => a - b),
    selectedRowCount: rows.size,
    unidentifiedRequestedTickRows: [...unidentifiedByTick.values()].reduce((sum, count) => sum + count, 0),
    observations };
}
