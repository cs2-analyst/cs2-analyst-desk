import type { DesktopReplayChunk } from '@cs2-analyst/report-contract';

export interface ReplayFollowDecision {
  playerId: string;
  allDead: boolean;
  deathId: string | null;
  cause: 'kill' | 'suicide' | 'unknown' | null;
  backgroundLayer: string | null;
  deadPlayerIds: readonly string[];
}

/** Seeded choice is independent of playback cadence, cache order and seek direction. */
function choose(ids: readonly string[], seed: string): string | null {
  const candidates = [...new Set(ids)].sort();
  if (!candidates.length) return null;
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++) hash = Math.imul(hash ^ seed.charCodeAt(i), 16777619) >>> 0;
  return candidates[hash % candidates.length];
}

/**
 * Resolve from the last explicit user choice, never from a previous automatic result.
 * Whole-round discrete evidence makes a cold chunk identical to continuous playback.
 * This function does not infer death/attribution from missing positions or health.
 */
export function resolveReplayFollow(chunk: DesktopReplayChunk, anchorId: string, tick: number,
  playerIds: readonly string[]): ReplayFollowDecision {
  const result: ReplayFollowDecision = { playerId: anchorId, allDead: false, deathId: null, cause: null, backgroundLayer: null, deadPlayerIds: [] };
  const follow = chunk.follow;
  if (!follow || !Number.isFinite(tick)) return result;
  const roster = new Set(playerIds);
  let lastBackground: string | null = null;
  const backgroundAt = (playerId: string, at: number) => {
    let layer: string | null = null;
    for (const background of follow.backgrounds) {
      if (background.tick > at) break;
      if (background.playerId === playerId) layer = background.layerId;
    }
    return layer;
  };
  let state: NonNullable<DesktopReplayChunk['follow']>['states'][number] | undefined;
  let pending: NonNullable<DesktopReplayChunk['follow']>['deaths'][number] | null = null;
  let deathIndex = 0, stateIndex = 0;
  const handoff = (aliveIds: readonly string[]) => {
    if (!pending) return;
    const alive = aliveIds.filter(id => roster.has(id) && id !== pending!.victimId);
    const killer = pending.killerId;
    const next = killer !== pending.victimId && killer !== null && alive.includes(killer) ? killer
      : choose(alive, JSON.stringify([chunk.matchId, chunk.round, pending.id]));
    // If native rows are missing at death, wait for the first confirmed living set.
    // Reconstructing that first choice also keeps later seeks stable as the set changes.
    if (next) { result.playerId = next; pending = null; }
  };
  while (deathIndex < follow.deaths.length || stateIndex < follow.states.length) {
    const at = Math.min(follow.deaths[deathIndex]?.tick ?? Infinity, follow.states[stateIndex]?.tick ?? Infinity);
    if (at > tick) break;
    let hadDeath = false;
    while (follow.deaths[deathIndex]?.tick === at) {
      const death = follow.deaths[deathIndex++];
      if (death.victimId !== result.playerId) continue;
      lastBackground = backgroundAt(result.playerId, at) ?? lastBackground;
      result.deathId = death.id;
      result.cause = death.killerId === death.victimId ? 'suicide' : death.killerId === null ? 'unknown' : 'kill';
      pending = death; hadDeath = true; handoff(death.alivePlayerIds);
    }
    if (follow.states[stateIndex]?.tick === at) {
      state = follow.states[stateIndex++];
      if (pending && state.alivePlayerIds.includes(result.playerId)) pending = null;
      if (!pending && !hadDeath && state.deadPlayerIds.includes(result.playerId)) {
        // An observed dead lifecycle without an attributable kill is still not suicide.
        lastBackground = backgroundAt(result.playerId, at) ?? lastBackground;
        pending = { id: `r${chunk.round}-state-${at}-${result.playerId}`, tick: at,
          victimId: result.playerId, killerId: null, alivePlayerIds: [] };
        result.deathId = pending.id; result.cause = 'unknown';
      }
      handoff(state.alivePlayerIds);
    }
  }
  result.allDead = playerIds.length > 0 && playerIds.every(id => state?.deadPlayerIds.includes(id));
  result.deadPlayerIds = state?.deadPlayerIds ?? [];
  if (result.allDead) {
    result.backgroundLayer = backgroundAt(result.playerId, tick) ?? lastBackground;
  }
  return result;
}
