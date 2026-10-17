import type { DesktopReplayChunk, DesktopReplayTrajectory, DesktopReplayUtility } from '@cs2-analyst/report-contract';

/**
 * Fixed paint order for the replay Canvas. The base radar is a separate Canvas; every
 * mark below is painted on the overlay in this order so smoke/fire never hides players
 * and transient bursts stay under player points and status icons.
 */
export const REPLAY_EFFECT_LAYER_ORDER = ['map', 'areas', 'trajectories', 'projectiles', 'players', 'status', 'selection'] as const;

export interface ReplayFlightSample { tick: number; x: number; y: number; z: number; speed: number }
export interface ReplayTrailSample { tick: number; x: number; y: number; z: number; breakBefore?: boolean }
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

/** Bounded speed response in seconds; unknown clock keeps the historical fallback. */
export function replayTrailSeconds(speed: number, tickRate: number | null): number {
  if (!(tickRate && tickRate > 0) || !Number.isFinite(speed)) return 0.34;
  const amount = Math.min(1, Math.max(0, (speed - 100) / 900));
  return 0.30 + 0.80 * amount * amount * (3 - 2 * amount);
}

/** Recent observed path, including EVERY vertex (bounces must not be shortcut by resampling).
 * The optional fixed window is retained for comparison. No point precedes the real start.
 */
export function replayTrajectoryTrail(trajectory: DesktopReplayTrajectory, tick: number, tickRate: number | null,
  seconds = replayTrailSeconds(replayTrajectorySample(trajectory, tick, tickRate)?.speed ?? 0, tickRate)): ReplayTrailSample[] {
  if (!Number.isFinite(tick) || tick < trajectory.startTick || tick > trajectory.endTick) return [];
  const rate = tickRate && tickRate > 0 ? tickRate : 8;
  const windowTicks = Math.max(1, Math.round(rate * Math.max(0.05, seconds)));
  const from = Math.max(trajectory.startTick, tick - windowTicks);
  const out: ReplayTrailSample[] = [];
  const maxGap = Math.max(2, Math.ceil(rate / 8));
  const append = (at: number, breakBefore = false) => {
    const sample = replayTrajectorySample(trajectory, at, tickRate);
    if (sample) out.push({ tick: at, x: sample.x, y: sample.y, z: sample.z, ...(breakBefore ? { breakBefore: true } : {}) });
  };
  append(from);
  for (let index = 0; index < trajectory.points.length; index++) {
    const point = trajectory.points[index];
    if (point[0] <= from || point[0] >= tick) continue;
    append(point[0], index > 0 && point[0] - trajectory.points[index - 1][0] > maxGap);
  }
  if (tick > from) {
    const right = trajectory.points.findIndex(point => point[0] >= tick);
    append(tick, right > 0 && trajectory.points[right][0] - trajectory.points[right - 1][0] > maxGap);
  }
  return out;
}

const burstProgress = (utility: DesktopReplayUtility, tick: number) =>
  Math.min(1, Math.max(0, (tick - utility.tick) / Math.max(1, utility.endTick - utility.tick)));

// Shared immutable lobe placement. Per-effect rotation/phase is derived from evidence,
// not a random frame state or a growing particle/cache collection.
const smokeLobes = [
  [0.02, -0.02, 0.78, 0.41], [-0.43, 0.05, 0.67, 0.37], [0.36, 0.29, 0.63, 0.38],
  [-0.19, -0.43, 0.65, 0.36], [0.42, -0.30, 0.59, 0.34], [-0.36, 0.40, 0.56, 0.32],
  [0.03, 0.54, 0.51, 0.31], [0.05, -0.10, 0.50, 0.29], [-0.15, 0.16, 0.42, 0.26],
] as const;
const fireInstances = [[-.38, .08, .90], [.35, .14, .82], [0, .36, 1.02]] as const;
// Ping-pong avoids an abrupt final-to-first silhouette jump. Three independent phases.
const fireSequence = [0, 1, 2, 3, 4, 5, 6, 5, 4, 3, 2, 1] as const;
const effectSeed = (utility: DesktopReplayUtility) =>
  ((utility.eventIndex * 2654435761 + utility.tick * 97 + (utility.entityId ?? 0) * 17) >>> 0) / 4294967296;
export function replayFireFrame(utility: DesktopReplayUtility, seconds: number, instance: number): number {
  const step = Math.floor(Math.max(0, seconds) * 12) + Math.floor(effectSeed(utility) * 12) + instance * 4;
  return fireSequence[step % fireSequence.length];
}

/** Purely illustrative fragments, not observed damage directions or simulated ballistics. */
export function replayHEFragments(utility: DesktopReplayUtility, progress: number) {
  if (utility.kind !== 'hegrenade' || !Number.isFinite(progress) || progress < 0 || progress >= 1) return [];
  const seed = effectSeed(utility), travel = 1 - Math.pow(1 - progress, 2);
  return Array.from({ length: 9 }, (_, i) => {
    const phase = (seed * 17 + i * .61803398875) % 1;
    const angle = (i + seed) * Math.PI * 2 / 9 + Math.sin(i * 7 + seed) * .18;
    const distance = (.45 + phase * .55) * travel;
    return { x: Math.cos(angle) * distance, y: Math.sin(angle) * distance + .16 * progress * progress,
      angle: angle + progress * (i % 2 ? 2 : -2), length: 4 + phase * 5,
      alpha: Math.pow(1 - progress, 1.5) };
  });
}
export function paintReplayHEFragments(ctx: CanvasRenderingContext2D, utility: DesktopReplayUtility,
  progress: number, x: number, y: number, radius: number): void {
  for (const shard of replayHEFragments(utility, progress)) {
    ctx.save(); ctx.translate(x + shard.x * radius, y + shard.y * radius); ctx.rotate(shard.angle);
    ctx.globalAlpha = shard.alpha; ctx.lineCap = 'round';
    ctx.strokeStyle = '#17202a'; ctx.lineWidth = 5;
    ctx.beginPath(); ctx.moveTo(-shard.length / 2, 0); ctx.lineTo(shard.length / 2, 0); ctx.stroke();
    ctx.strokeStyle = '#ffdf9a'; ctx.lineWidth = 2.3; ctx.stroke(); ctx.restore();
  }
}

/** HE's visual burst lasts at most half a Replay second. Domain endTick is untouched. */
export function replayHEProgress(utility: DesktopReplayUtility, tick: number, tickRate: number | null): number | null {
  const duration = Math.min(utility.endTick - utility.tick, (tickRate && tickRate > 0 ? tickRate : 64) * .5);
  if (!(duration > 0) || tick < utility.tick || tick >= utility.tick + duration) return null;
  return (tick - utility.tick) / duration;
}

/** Bright impact core, irregular flare and a fast shock ring. All geometry is illustrative. */
export function paintReplayHEBurst(ctx: CanvasRenderingContext2D, utility: DesktopReplayUtility,
  progress: number, x: number, y: number, unit: number): void {
  if (progress < 0 || progress >= 1 || !(unit > 0)) return;
  const seed = effectSeed(utility), ease = 1 - Math.pow(1 - progress, 3), fade = 1 - progress;
  ctx.save(); ctx.translate(x, y);
  const radius = (95 + 210 * ease) * unit;
  // The very short white/yellow core gives the onset a visible punch, then yields to orange.
  const core = ctx.createRadialGradient(0, 0, 0, 0, 0, radius * .83);
  core.addColorStop(0, `rgba(255,255,231,${Math.pow(fade,2)*.98})`);
  core.addColorStop(.23, `rgba(255,224,133,${Math.pow(fade,2)*.92})`);
  core.addColorStop(.54, `rgba(255,121,30,${Math.pow(fade,1.6)*.76})`);
  core.addColorStop(1, 'rgba(198,51,12,0)');
  ctx.fillStyle=core;ctx.beginPath();ctx.arc(0,0,radius*.83,0,Math.PI*2);ctx.fill();
  ctx.globalAlpha=Math.pow(fade,2.4)*.85;ctx.fillStyle='#ffdf97';ctx.beginPath();
  for(let i=0;i<24;i++){
    const angle=i*Math.PI/12+seed*6.28;
    const spike=(i%2===0? .80+.22*Math.sin(i*7+seed*13):.24)*radius;
    const px=Math.cos(angle)*spike,py=Math.sin(angle)*spike;
    if(i===0)ctx.moveTo(px,py);else ctx.lineTo(px,py);
  }
  ctx.closePath();ctx.fill();
  ctx.globalAlpha=Math.pow(fade,1.3)*.9;ctx.strokeStyle='#ffc26b';ctx.lineWidth=(5-3*progress);
  ctx.beginPath();ctx.arc(0,0,radius,0,Math.PI*2);ctx.stroke();
  ctx.globalAlpha=Math.pow(fade,2)*.85;ctx.strokeStyle='#fff4c6';ctx.lineWidth=2.2;
  ctx.beginPath();ctx.arc(0,0,radius*.72,0,Math.PI*2);ctx.stroke();
  ctx.restore();
  paintReplayHEFragments(ctx,utility,progress,x,y,330*unit);
}

/** Canvas 2D ground area; pure tick/evidence input, unchanged 0.35s/1.4s lifecycle envelope.
 * radius is a DISPLAY radius, not observed smoke/fire geometry or visibility evidence.
 */
export function paintReplayArea(ctx: CanvasRenderingContext2D, utility: DesktopReplayUtility,
  tick: number, tickRate: number | null, x: number, y: number, radius: number, fireAtlas?: CanvasImageSource): void {
  if (tick < utility.tick || tick > utility.endTick || !(radius > 0)) return;
  const rate = tickRate && tickRate > 0 ? tickRate : 64;
  const life = Math.min(1, Math.max(0, (tick - utility.tick + 1) / (rate * .35)),
    Math.max(0, (utility.endTick - tick + 1) / (rate * 1.4)));
  if (!(life > 0)) return;
  const seconds = (tick - utility.tick) / rate;
  const seed = effectSeed(utility);
  const rotation = seed * Math.PI * 2;
  ctx.save(); ctx.translate(x, y); ctx.rotate(utility.kind === 'smoke' ? rotation : 0); ctx.globalAlpha = life;
  if (utility.kind === 'smoke') {
    for (let i = 0; i < smokeLobes.length; i++) {
      const [lx, ly, size, alpha] = smokeLobes[i];
      const phase = seed * 13 + i * 2.399;
      const dx = .045 * Math.sin(seconds * (.28 + i * .017) + phase);
      const dy = .04 * Math.sin(seconds * (.23 + i * .021) + phase * 1.7);
      const stretch = 1 + .055 * Math.sin(seconds * (.31 + i * .013) + phase);
      ctx.save(); ctx.translate((lx + dx) * radius, (ly + dy) * radius);
      ctx.rotate(phase + .06 * Math.sin(seconds * .19 + phase)); ctx.scale(stretch, .83 / stretch);
      const r = radius * size, gradient = ctx.createRadialGradient(-r * .14, -r * .18, r * .08, 0, 0, r);
      // Lit dense core, shaded volume, feathered edge; nine overlapping ellipses, no ring.
      gradient.addColorStop(0, `rgba(211,216,218,${alpha})`);
      gradient.addColorStop(.40, `rgba(175,184,190,${alpha * .91})`);
      gradient.addColorStop(.72, `rgba(117,132,147,${alpha * .57})`);
      gradient.addColorStop(1, 'rgba(104,119,135,0)');
      ctx.fillStyle = gradient; ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill(); ctx.restore();
    }
  } else if (utility.kind === 'fire' && fireAtlas) {
    // Exactly three local sprites, sharing the observed life window but not their phase.
    // Images are decoded once by the view; paint never allocates a bitmap or clock.
    for (let i = 0; i < fireInstances.length; i++) {
      const [dx, dy, scale] = fireInstances[i];
      const width = radius * 1.10 * scale, height = radius * 1.54 * scale;
      const frame = replayFireFrame(utility, seconds, i);
      ctx.drawImage(fireAtlas, frame * 80, 0, 80, 112,
        dx * radius - width / 2, dy * radius - height, width, height);
    }
  }
  ctx.restore();
}

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
      const progress = replayHEProgress(utility, tick, tickRate);
      if (progress !== null) frame.explosions.push({ utility, progress });
    }
  }
  for (const window of chunk.blinds ?? []) if (tick >= window.startTick && tick <= window.endTick) frame.blinds.add(window.victimId);
  for (const window of chunk.burns ?? []) if (tick >= window.startTick && tick <= window.endTick) frame.burns.add(window.victimId);
  return frame;
}
