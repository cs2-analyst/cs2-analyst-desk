import type { DesktopReplayPlayer } from '@cs2-analyst/report-contract';
import { resolveMapLayer } from '../../shared/replay-map-geometry.ts';
import type { ReplayMapDefinition } from '../../shared/replay-map-geometry.ts';

export type ReplayFloorStatus = 'known' | 'retained' | 'unknown' | 'manual';
export interface ReplayFloorState {
  context: string;
  tick: number;
  confirmedLayer: string | null;
  layerId: string | null;
  status: ReplayFloorStatus;
}
export interface ReplayFloorInput {
  sessionId: string | null;
  matchId: string;
  round: number;
  playerId: string;
  /** Incremented for every explicit seek, including warm and same-tick seeks. */
  seekRevision: number;
  mode: string;
  tick: number;
  map: ReplayMapDefinition;
  selected: DesktopReplayPlayer | undefined;
  /** Only for confirmed all-dead: an earlier reliable observation, never a player position. */
  allDeadBackground?: string | null;
}

/** Only background context is retained. This function never stores or returns XYZ. */
export function replayFloorAt(previous: ReplayFloorState | null, input: ReplayFloorInput): ReplayFloorState {
  const { map, selected, tick, mode } = input;
  const context = JSON.stringify([input.sessionId, input.matchId, map.resourceId, map.id,
    input.round, input.playerId, mode, input.seekRevision]);
  // Clock cadence is independent of sampling gaps. Explicit seeks always change revision,
  // while a slow RAF during forward playback is still the same continuous clock run.
  const continuous = previous?.context === context && Number.isFinite(tick) && tick >= previous.tick;
  if (mode !== 'auto') {
    const layerId = map.layers.some(layer => layer.id === mode) ? mode : null;
    return { context, tick, confirmedLayer: null, layerId, status: layerId ? 'manual' : 'unknown' };
  }
  // Single-floor maps have no target-dependent choice, preserving their existing behavior.
  const single = map.layers.length === 1 && map.layers[0].minZ === null;
  const reliable = selected?.[7] === true && selected[9] !== null && !selected[10]
    && [selected[2], selected[3], selected[4]].every(value => value !== null && Number.isFinite(value));
  const confirmed = single ? map.layers[0].id : reliable ? resolveMapLayer(map, selected![4]) : null;
  const history = continuous ? previous.confirmedLayer : null;
  const background = map.layers.some(layer => layer.id === input.allDeadBackground) ? input.allDeadBackground! : null;
  const layerId = confirmed ?? history ?? background;
  return { context, tick, confirmedLayer: layerId, layerId,
    status: confirmed ? 'known' : layerId ? 'retained' : 'unknown' };
}
