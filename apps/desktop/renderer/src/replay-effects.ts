import type { DesktopReplayChunk, DesktopReplayTrajectory, DesktopReplayUtility } from '@cs2-analyst/report-contract';

/**
 * Fixed paint order for the replay Canvas. The base radar is a separate Canvas; every
 * mark below is painted on the overlay in this order so smoke/fire never hides players
 * and transient bursts stay under player points and status icons.
 */
export const REPLAY_EFFECT_LAYER_ORDER = ['map', 'areas', 'trajectories', 'projectiles', 'players', 'status', 'selection'] as const;

export interface ReplayFlightSample { tick: number; x: number; y: number; z: number; speed: number }
export interface ReplayTrailSample { tick: number; x: number; y: number; z: number }
export interface ReplayFlyingEffect {
  utility: DesktopReplayUtility;
  sample: ReplayFlightSample;
  trail: ReplayTrailSample[];
}
export interface ReplayBurstEffect { utility: DesktopReplayUtility; progress: number }
export interface ReplayEffectFrame {
  flying: ReplayFlyingEffect[];
  smoke: DesktopReplayUtility[];
  fire: DesktopReplayUtility[];
  flashes: ReplayBurstEffect[];
  explosions: ReplayBurstEffect[];
  blinds: Set<string>;
  burns: Set<string>;
}

const emptyFrame = (): ReplayEffectFrame => ({
  flying: [], smoke: [], fire: [], flashes: [], explosions: [], blinds: new Set(), burns: new Set(),
});

function segmentSpeed(a: readonly [number, number, number, number], b: readonly [number, number, number, number], tickRate: number | null): number {
  const dt = b[0] - a[0];
  if (!(dt > 0)) return 0;
  const distance = Math.hypot(b[1] - a[1], b[2] - a[2], b[3] - a[3]);
  return distance / dt * (tickRate && tickRate > 0 ? tickRate : 1);
}

/** Linear interpolation between real native projectile samples; never a start-to-end shortcut. */
export function replayTrajectorySample(trajectory: DesktopReplayTrajectory, tick: number, tickRate: number | null = null): ReplayFlightSample | null {
  const points = trajectory.points;
  if (!points.length || !Number.isFinite(tick) || tick < trajectory.startTick || tick > trajectory.endTick) return null;
  let low = 0, high = points.length;
  while (low < high) { const mid = (low + high) >>> 1; if (points[mid][0] <= tick) low = mid + 1; else high = mid; }
  const right = points[low], left = points[low - 1];
  if (!left) return right[0] === tick ? { tick, x: right[1], y: right[2], z: right[3], speed: 0 } : null;
  if (left[0] === tick) {
    const prior = points[low - 2];
    const speed = prior ? segmentSpeed(prior, left, tickRate)
      : right ? segmentSpeed(left, right, tickRate) : 0;
    return { tick, x: left[1], y: left[2], z: left[3], speed };
  }
  if (!right) return { tick, x: left[1], y: left[2], z: left[3], speed: 0 };
  const span = right[0] - left[0], fraction = (tick - left[0]) / span;
  return {
    tick,
    x: left[1] + (right[1] - left[1]) * fraction,
    y: left[2] + (right[2] - left[2]) * fraction,
    z: left[3] + (right[3] - left[3]) * fraction,
    speed: segmentSpeed(left, right, tickRate),
  };
}

/**
 * Recent-flight trail over a fixed real-time window (default 0.34s). A faster projectile
 * covers more world distance in the same window, so its trail is necessarily longer. The
 * oldest sample is the tail; callers thin/fade it towards the head.
 */
export function replayTrajectoryTrail(trajectory: DesktopReplayTrajectory, tick: number, tickRate: number | null,
  seconds = 0.34): ReplayTrailSample[] {
  if (!Number.isFinite(tick) || tick < trajectory.startTick || tick > trajectory.endTick) return [];
  const rate = tickRate && tickRate > 0 ? tickRate : 8;
  const windowTicks = Math.max(1, Math.round(rate * Math.max(0.05, seconds)));
  const from = Math.max(trajectory.startTick, tick - windowTicks);
  const steps = 14, out: ReplayTrailSample[] = [];
  for (let index = 0; index <= steps; index++) {
    const at = from + (tick - from) * index / steps;
    const sample = replayTrajectorySample(trajectory, at, tickRate);
    if (sample) out.push({ tick: at, x: sample.x, y: sample.y, z: sample.z });
  }
  return out;
}

const burstProgress = (utility: DesktopReplayUtility, tick: number) =>
  Math.min(1, Math.max(0, (tick - utility.tick) / Math.max(1, utility.endTick - utility.tick)));

/**
 * Discrete effect state at one displayed tick. Everything is derived from chunk evidence
 * and the current tick, so seek/play/pause cannot leave a stale area or reveal a future one.
 */
export function replayEffectsAt(chunk: Pick<DesktopReplayChunk, 'utilities' | 'blinds' | 'burns'> | null | undefined,
  tick: number, tickRate: number | null): ReplayEffectFrame {
  const frame = emptyFrame();
  if (!chunk || !Number.isFinite(tick)) return frame;
  for (const utility of chunk.utilities ?? []) {
    const trajectory = utility.trajectory;
    if (trajectory && tick >= trajectory.startTick && tick <= trajectory.endTick && tick < utility.tick) {
      const sample = replayTrajectorySample(trajectory, tick, tickRate);
      if (sample) frame.flying.push({ utility, sample, trail: replayTrajectoryTrail(trajectory, tick, tickRate) });
    }
    if (tick < utility.tick || tick > utility.endTick) continue;
    if (utility.kind === 'smoke') frame.smoke.push(utility);
    else if (utility.kind === 'fire') frame.fire.push(utility);
    else if (utility.kind === 'flashbang' && utility.endTick > utility.tick) {
      frame.flashes.push({ utility, progress: burstProgress(utility, tick) });
    } else if (utility.kind === 'hegrenade' && utility.endTick > utility.tick) {
      frame.explosions.push({ utility, progress: burstProgress(utility, tick) });
    }
  }
  for (const window of chunk.blinds ?? []) if (tick >= window.startTick && tick <= window.endTick) frame.blinds.add(window.victimId);
  for (const window of chunk.burns ?? []) if (tick >= window.startTick && tick <= window.endTick) frame.burns.add(window.victimId);
  return frame;
}
