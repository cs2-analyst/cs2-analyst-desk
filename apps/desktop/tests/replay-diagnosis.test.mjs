import assert from 'node:assert/strict';
import test from 'node:test';
import { replayMapDefinitions } from '../shared/replay-map-geometry.ts';
import { explainFrame, summarizeObservedFrames } from '../../../scripts/replay-diagnosis-core.mjs';

const map = replayMapDefinitions.find(m => m.id === 'de_nuke');
const player = (id, tick, z, alive = true) => [id, tick, 0, 0, z, 0, alive ? 100 : 0, alive, 'T', alive ? 1 : null, false];
const metadata = { maxInterpolationTicks: 8, players: [{ id: 'target' }, { id: 'survivor' }] };
const chunk = (left, right) => ({ startTick: 0, endTick: 8, frames: [
  { tick: 0, players: [left, player(1, 0, -400)], bomb: {} },
  { tick: 8, players: [right, player(1, 8, -400)], bomb: {} },
] });

test('S0 reproducer: dead auto target hides a living same-floor player despite complete source positions', () => {
  const c = chunk(player(0, 0, -400, false), player(0, 8, -400, false));
  assert.equal(explainFrame(c, 0, metadata, map, 0).eligible, 1, 'Exact dead native Z can still resolve auto floor');
  const between = explainFrame(c, 4, metadata, map, 0);
  assert.equal(between.selected[4], null); assert.equal(between.layerId, null); assert.equal(between.eligible, 0);
  assert.equal(between.players[1].interpolation, 'interpolated');
  assert.equal(explainFrame(c, 4, metadata, map, 0, 'default').eligible, 1);
  assert.equal(explainFrame(c, 4, metadata, map, 0, 'lower').eligible, 0, 'Other-floor filtering is normal');
});

test('S0 explanation separates correct cross-floor rejection from native row and segment gaps', () => {
  const c = chunk(player(0, 0, -490), player(0, 8, -510));
  assert.equal(explainFrame(c, 4, metadata, map, 0).players[0].interpolation, 'floor-transition-or-unknown');
  c.frames[1].players[0] = [0, null, null, null, null, null, null, null, 'Unknown', null, false];
  assert.equal(explainFrame(c, 4, metadata, map, 0).players[0].interpolation, 'native-row-missing');
  c.frames[1].players[0] = player(0, 8, -490); c.frames[1].players[0][9] = 2;
  assert.equal(explainFrame(c, 4, metadata, map, 0).players[0].interpolation, 'segment');
});

test('S0 frame denominators distinguish layer unknown, loaded-image draw omissions, and waits', () => {
  const observations = [
    { ms: 0, drawn: 0, eligible: 0, layerId: null, chunkLoaded: true, imageReady: false },
    { ms: 16, drawn: 0, eligible: 2, layerId: 'default', chunkLoaded: true, imageReady: true },
    { ms: 32, drawn: 2, eligible: 2, layerId: 'default', chunkLoaded: true, imageReady: true },
    { ms: 48, drawn: 0, eligible: 0, layerId: 'default', chunkLoaded: false, imageReady: true },
  ];
  const result = summarizeObservedFrames(observations);
  assert.equal(result.frames, 4); assert.equal(result.unknownFloorRatio, .25);
  assert.equal(result.eligibleDrawMismatchFrames, 1); assert.equal(result.waitingFrames, 1);
  assert.equal(result.drawableFrames,2);assert.equal(result.drawablePlayerOpportunities,4);
  assert.equal(result.longestBlankMs, 32);
});
