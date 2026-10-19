/** JSON-only presentation protocol. Tuple fields are versioned; never a native object. */
export type DesktopReplayPlayer = [playerIndex: number, actualTick: number | null,
  x: number | null, y: number | null, z: number | null, yaw: number | null, health: number | null,
  alive: boolean | null, side: 'CT' | 'T' | 'Unknown', segment: number | null, ambiguous: boolean];
export interface DesktopReplayBomb {
  action: string; carrierId: string | null; position: [number, number, number] | null;
  positionSource: 'actor-at-event' | 'carrier-sample' | null; ambiguous: boolean;
}
export type DesktopReplayUtilityKind = 'smoke' | 'flashbang' | 'hegrenade' | 'fire' | 'decoy';
export type DesktopReplayFireVariant = 'molotov' | 'incendiary';
export type DesktopReplayEffectEndSource = 'observed' | 'round-end' | 'nominal';
/** Additive vertical-projection samples; `[tick, x, y, z]`. */
export interface DesktopReplayTrajectory {
  startTick: number; endTick: number; points: [tick: number, x: number, y: number, z: number][];
}
/** One utility detonation and its real flight/effect window. */
export interface DesktopReplayUtility {
  id: string; eventIndex: number; kind: DesktopReplayUtilityKind;
  variant: DesktopReplayFireVariant | null; throwerId: string | null; entityId: number | null;
  tick: number; endTick: number; endSource: DesktopReplayEffectEndSource;
  position: [number, number, number] | null; trajectory: DesktopReplayTrajectory | null;
}
export interface DesktopReplayBlind { victimId: string; attackerId: string | null; startTick: number; endTick: number }
export interface DesktopReplayBurn { victimId: string; startTick: number; endTick: number }
export interface DesktopReplayFrame { tick: number; players: DesktopReplayPlayer[]; bomb: DesktopReplayBomb }
export interface DesktopReplayEvent {
  id: string; tick: number; type: string; description: string;
  actorId: string | null; targetId: string | null;
  position: [number, number, number] | null;
}
export interface DesktopReplayBlockInfo { index: number; startTick: number; endTick: number }
export interface DesktopReplayRoundInfo {
  round: number; startTick: number; endTick: number; freezeEndTick: number | null;
  coverage: 'complete' | 'partial'; blocks: DesktopReplayBlockInfo[];
}
/** Exact source deaths, independent of the currently loaded 20-second block. */
export interface DesktopReplayFollowDeath {
  id: string; tick: number; victimId: string;
  /** Null is unknown/world or conflicting attribution. Suicide requires equality to victimId. */
  killerId: string | null;
  /** Confirmed living players after the entire same-tick death/lifecycle group. */
  alivePlayerIds: string[];
}
/** A change in observed round life state. Absence from both sets means unknown. */
export interface DesktopReplayFollowState { tick: number; alivePlayerIds: string[]; deadPlayerIds: string[] }
/** Reliable observed floor changes only; contains no saved or fabricated XYZ. */
export interface DesktopReplayFollowBackground { tick: number; playerId: string; layerId: string }
export interface DesktopReplayFollow {
  deaths: DesktopReplayFollowDeath[];
  states: DesktopReplayFollowState[];
  backgrounds: DesktopReplayFollowBackground[];
}
export interface DesktopReplayMetadata {
  schemaVersion: 1; available: boolean; unavailableReason: string | null;
  sessionId: string | null; matchId: string; map: string; resourceId: string; samplingVersion: string;
  tickRate: number | null; maxInterpolationTicks: number | null;
  perspective: 'global'; players: { id: string; nickname: string }[];
  rounds: DesktopReplayRoundInfo[]; excludedRounds: number[];
}
export interface DesktopReplayChunk {
  schemaVersion: 1; sessionId: string; matchId: string; round: number; block: number;
  startTick: number; endTick: number;
  /** Includes adjacent guard frames; every frame is an independent discrete-state baseline. */
  frames: DesktopReplayFrame[]; events: DesktopReplayEvent[];
  /** Additive: utility effects overlapping this block; absent on legacy/effect-free chunks. */
  utilities?: DesktopReplayUtility[]; blinds?: DesktopReplayBlind[]; burns?: DesktopReplayBurn[];
  /** Additive whole-round facts for reproducible follow choices during arbitrary Seek. */
  follow?: DesktopReplayFollow;
}
export interface DesktopReplayRequest { sessionId: string; round: number; block: number }
export type DesktopReplayResult = { kind: 'success'; chunk: DesktopReplayChunk } | { kind: 'error'; message: string };
