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
  return 0.30 + 0.48 * amount * amount * (3 - 2 * amount);
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
// Back-to-front groups on the ground, each containing three separate pointed flames.
const fireGroups = [
  [-.27, -.43, .78], [.25, -.37, .89], [-.52, -.06, .86], [.01, -.02, 1],
  [.51, .06, .83], [-.28, .34, .93], [.24, .40, .85],
] as const;

/** A narrow flame silhouette with a side notch and a curved pointed tip, rooted at (0,0). */
function flameTongue(ctx: CanvasRenderingContext2D, width: number, height: number, lean: number): void {
  ctx.beginPath(); ctx.moveTo(0, 0);
  ctx.bezierCurveTo(-width * .70, -height * .01, -width * .82, -height * .20, -width * .55, -height * .43);
  ctx.bezierCurveTo(-width * .48, -height * .27, -width * .20, -height * .32, -width * .26, -height * .65);
  ctx.bezierCurveTo(-width * .04, -height * .48, width * .11, -height * .78, width * lean, -height);
  ctx.bezierCurveTo(width * .38, -height * .82, width * .84, -height * .39, width * .58, -height * .18);
  ctx.bezierCurveTo(width * .50, -height * .04, width * .26, height * .02, 0, 0);
  ctx.closePath(); ctx.fill();
}

/** Canvas 2D ground area; pure tick/evidence input, unchanged 0.35s/1.4s lifecycle envelope.
 * radius is a DISPLAY radius, not observed smoke/fire geometry or visibility evidence.
 */
export function paintReplayArea(ctx: CanvasRenderingContext2D, utility: DesktopReplayUtility,
  tick: number, tickRate: number | null, x: number, y: number, radius: number): void {
  if (tick < utility.tick || tick > utility.endTick || !(radius > 0)) return;
  const rate = tickRate && tickRate > 0 ? tickRate : 64;
  const life = Math.min(1, Math.max(0, (tick - utility.tick + 1) / (rate * .35)),
    Math.max(0, (utility.endTick - tick + 1) / (rate * 1.4)));
  if (!(life > 0)) return;
  const seconds = (tick - utility.tick) / rate;
  const seed = ((utility.eventIndex * 2654435761 + utility.tick * 97 + (utility.entityId ?? 0) * 17) >>> 0) / 4294967296;
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
  } else if (utility.kind === 'fire') {
    // A subdued, connected ground bed anchors the flames without bright circular hotspots.
    ctx.fillStyle = 'rgba(168,43,8,.22)'; ctx.beginPath();
    ctx.moveTo(-radius * .86, -radius * .04);
    ctx.bezierCurveTo(-radius * .72, -radius * .52, -radius * .17, -radius * .63, radius * .14, -radius * .51);
    ctx.bezierCurveTo(radius * .55, -radius * .57, radius * .92, -radius * .20, radius * .84, radius * .18);
    ctx.bezierCurveTo(radius * .74, radius * .56, radius * .22, radius * .65, -radius * .10, radius * .57);
    ctx.bezierCurveTo(-radius * .52, radius * .66, -radius * .92, radius * .35, -radius * .86, -radius * .04);
    ctx.closePath(); ctx.fill();
    const mirror = seed < .5 ? -1 : 1;
    for (let i = 0; i < fireGroups.length; i++) {
      const [gx, gy, size] = fireGroups[i], r = radius * size;
      ctx.save(); ctx.translate(gx * radius * mirror, gy * radius);
      ctx.fillStyle = 'rgba(230,75,10,.20)'; ctx.beginPath();
      ctx.ellipse(0, 0, r * .38, r * .11, 0, 0, Math.PI * 2); ctx.fill();
      for (let flame = 0; flame < 3; flame++) {
        const phase = seed * 17 + i * 2.399 + flame * 1.71;
        const sway = Math.sin(seconds * (3.1 + i * .19 + flame * .37) + phase);
        const stretch = 1 + .09 * Math.sin(seconds * (4.3 + i * .17 + flame * .29) + phase * 1.7)
          + .035 * Math.sin(seconds * 6.1 + phase * 2.3);
        const height = r * (flame === 1 ? .69 : flame === 0 ? .43 : .51) * stretch;
        const width = r * (flame === 1 ? .16 : .135);
        ctx.save(); ctx.translate((flame - 1) * r * .19, flame === 1 ? 0 : r * .025);
        ctx.rotate((flame - 1) * .10 + sway * .055);
        const body = ctx.createLinearGradient(0, 0, 0, -height);
        body.addColorStop(0, 'rgba(210,49,7,.78)');
        body.addColorStop(.28, 'rgba(255,103,9,.94)');
        body.addColorStop(.68, 'rgba(255,163,28,.96)');
        body.addColorStop(1, 'rgba(255,205,75,.88)');
        ctx.fillStyle = body; flameTongue(ctx, width, height, sway * .45);
        ctx.fillStyle = 'rgba(255,234,139,.94)';
        flameTongue(ctx, width * .48, height * .65, sway * .30);
        ctx.restore();
      }
      ctx.restore();
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
      frame.explosions.push({ utility, progress: burstProgress(utility, tick) });
    }
  }
  for (const window of chunk.blinds ?? []) if (tick >= window.startTick && tick <= window.endTick) frame.blinds.add(window.victimId);
  for (const window of chunk.burns ?? []) if (tick >= window.startTick && tick <= window.endTick) frame.burns.add(window.victimId);
  return frame;
}
