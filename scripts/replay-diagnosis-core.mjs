// Read-only explanation of existing renderer decisions, used only by S0 QA.
import { replayDisplayFrame } from '../apps/desktop/renderer/src/replay-state.ts';
import { resolveMapLayer, worldToRadar } from '../apps/desktop/shared/replay-map-geometry.ts';

export function explainPlayer(left, right, a, b, maxGap, floorAt) {
  if (!b) return 'no-right-sample';
  if (maxGap === null || right.tick - left.tick <= 0 || right.tick - left.tick > maxGap) return 'gap';
  if (a[1] !== left.tick || b[1] !== right.tick) return 'native-row-missing';
  if (a[10] || b[10]) return 'ambiguous';
  if (a[8] !== b[8]) return 'side-change';
  if (a[7] !== true || b[7] !== true) return 'not-alive';
  if ([a[2], a[3], a[4], b[2], b[3], b[4]].some(v => v === null)) return 'position-missing';
  if (floorAt(a[4]) === null || floorAt(a[4]) !== floorAt(b[4])) return 'floor-transition-or-unknown';
  if (a[9] === null || a[9] !== b[9]) return 'segment';
  return 'interpolated';
}

export function explainFrame(chunk, tick, metadata, map, selectedIndex, mode = 'auto') {
  const floorAt = z => resolveMapLayer(map, z);
  const frame = replayDisplayFrame(chunk, tick, metadata.maxInterpolationTicks, metadata.players.map(p => p.id), floorAt);
  const left = chunk.frames.findLast(f => f.tick <= tick), right = chunk.frames.find(f => f.tick > tick);
  const selected = frame?.players.find(p => p[0] === selectedIndex);
  const layerId = mode === 'auto' ? floorAt(selected?.[4] ?? null) : mode;
  const reasons = {};
  const players = (frame?.players ?? []).map(p => {
    const a = left?.players.find(q => q[0] === p[0]), b = right?.players.find(q => q[0] === p[0]);
    const interpolation = left?.tick === tick ? 'exact' : explainPlayer(left, right, a, b, metadata.maxInterpolationTicks, floorAt);
    const point = p[2] === null || p[3] === null ? null : worldToRadar(map, { x: p[2], y: p[3] });
    const floor = floorAt(p[4]);
    const reason = !layerId ? 'auto-floor-unknown' : p[7] !== true ? 'not-alive' : !point ? 'position-unavailable'
      : floor === null ? 'floor-unknown' : floor !== layerId ? 'other-floor'
        : point.x < 0 || point.y < 0 || point.x > map.width || point.y > map.height ? 'outside-map' : 'eligible';
    reasons[reason] = (reasons[reason] ?? 0) + 1;
    return { id: metadata.players[p[0]].id, sample: p, floor, interpolation, reason };
  });
  return { tick, leftTick: left?.tick ?? null, rightTick: right?.tick ?? null,
    gap: right && left ? right.tick - left.tick : null, selected: selected ?? null, layerId,
    frameAvailable: !!frame, eligible: reasons.eligible ?? 0, reasons, players };
}

export function summarizeObservedFrames(frames) {
  let blankStart = null, longestBlankMs = 0, unknownFloor = 0, mismatch = 0, waitingFrames = 0;
  let drawableFrames=0,drawablePlayerOpportunities=0;
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    if (f.layerId === null) unknownFloor++;
    if (f.eligible !== null && f.imageReady && f.layerId && f.chunkLoaded) {
      if(f.eligible>0){drawableFrames++;drawablePlayerOpportunities+=f.eligible;}
      if(f.drawn !== f.eligible)mismatch++;
    }
    if (!f.chunkLoaded) waitingFrames++;
    if (f.drawn === 0) blankStart ??= f.ms;
    if (blankStart !== null) longestBlankMs = Math.max(longestBlankMs, f.ms - blankStart);
    if (f.drawn !== 0) blankStart = null;
  }
  return { frames: frames.length, unknownFloor, unknownFloorRatio: frames.length ? unknownFloor / frames.length : null,
    eligibleDrawMismatchFrames: mismatch, drawableFrames, drawablePlayerOpportunities, waitingFrames, longestBlankMs,
    scope: 'One observation after each actual renderer animation paint; blank duration uses wall time, including endpoint censoring' };
}
