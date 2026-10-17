import type { MatchEvent } from './event.js';
import type { TeamSide } from './player.js';
import type { RoundPlayerLifecycleEvent } from './round.js';

/** Native observations, never display interpolation and never an Analytics input. */
export interface ReplayPlayerSample {
  playerId: string;
  actualTick: number | null;
  position: [number, number, number] | null;
  yaw: number | null;
  health: number | null;
  alive: boolean | null;
  side: TeamSide;
  /** Per-player match-wide run identity; always changes at round boundaries. Null means not interpolable. */
  segment: number | null;
  stateAmbiguous: boolean;
}

/** One real projectile observation. `[tick, x, y, z]`; x/y are the vertical map projection. */
export type ReplayTrajectoryPoint = [tick: number, x: number, y: number, z: number];

/** Additive flight evidence: native projectile samples from the throw to detonation/landing. */
export interface ReplayUtilityFlight {
  startTick: number;
  endTick: number;
  /** Source samples, never a synthetic start-to-end straight line. */
  points: ReplayTrajectoryPoint[];
}

export type ReplayUtilityKind = 'smoke' | 'flashbang' | 'hegrenade' | 'fire' | 'decoy';
/** The detonation event does not name the fire grenade; only a same-throw weapon_fire can. */
export type ReplayUtilityVariant = 'molotov' | 'incendiary';
/** observed = real expiry event; round-end = clipped formal window; nominal = documented fallback. */
export type ReplayEffectEndSource = 'observed' | 'round-end' | 'nominal';

/** Additive effect origin and real window; never Analytics input. */
export interface ReplayUtilityEffect {
  /** Ordinal in `ReplayRound.events`, allowing exact event/text association. */
  eventIndex: number;
  kind: ReplayUtilityKind;
  variant: ReplayUtilityVariant | null;
  throwerId: string | null;
  entityId: number | null;
  /** Detonation / start_burn / decoy_started tick. */
  tick: number;
  /** Real expiry, formal round end, or a documented instantaneous visual window. */
  endTick: number;
  endSource: ReplayEffectEndSource;
  position: [number, number, number] | null;
  /** Null when no reliable native projectile run could be associated; never fabricated. */
  flight: ReplayUtilityFlight | null;
}

/** One victim's real `player_blind` window, converted from the reported duration. */
export interface ReplayBlindWindow {
  victimId: string;
  attackerId: string | null;
  startTick: number;
  endTick: number;
}

/** One victim's real inferno-damage window. Derived only from observed damage ticks. */
export interface ReplayBurnWindow {
  victimId: string;
  startTick: number;
  endTick: number;
}

export interface ReplayFrame { requestedTick: number; players: ReplayPlayerSample[] }
export interface ReplayRound {
  round: number; startTick: number; endTick: number; freezeEndTick: number | null;
  frames: ReplayFrame[];
  /** Original ordinals identify same-tick events; they never establish subtick order. */
  events: { eventIndex: number; event: MatchEvent }[];
  lifecycle: RoundPlayerLifecycleEvent[];
  coverage: { requestedFrames: number; missingPlayerSamples: number; status: 'complete' | 'partial' };
  /** Additive utility evidence; absent when this round has none. */
  utilities?: ReplayUtilityEffect[];
  blinds?: ReplayBlindWindow[];
  burns?: ReplayBurnWindow[];
}
export interface MatchReplay {
  schemaVersion: 1; matchId: string; samplingVersion: string;
  source: 'native-final-tick-observation'; tickRate: number | null; hz: 8;
  maxInterpolationTicks: number | null;
  players: string[]; rounds: ReplayRound[];
  excludedRounds: number[];
}
