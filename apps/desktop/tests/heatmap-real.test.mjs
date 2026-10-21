import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import { Demoparser2Provider } from '@cs2-analyst/dem-parser';
import { projectMapHeatmap } from '../shared/heatmap.ts';
import { localDemFixture } from './local-dem-fixture.mjs';

const file = localDemFixture('dust2.dem');
const sha = 'db90fe85aab023a1d2c8a5996182e6120d98ef494f02a070b17982b235e4958c';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
test('P7.1 exact whitelisted Dust2: source classification, independent events, repeatable 32x32', {
  skip: !existsSync(file) ? 'BLOCKED: local .demo/dust2.dem unavailable; no download/substitute' : false,
}, async () => {
  assert.equal(statSync(file).size, 557650967);
  const digest = createHash('sha256'); for await (const chunk of createReadStream(file)) digest.update(chunk);
  assert.equal(digest.digest('hex'), sha, 'Wrong local Dust2 bytes; do not substitute');
  const parsed = await new Demoparser2Provider().parseWithReplay(file);
  assert.ok(parsed.replay, parsed.replayUnavailableReason ?? 'Replay unavailable');
  const inputHash = hash([parsed.match, parsed.replay, parsed.spatial]);
  const started = performance.now();
  const first = projectMapHeatmap(parsed.match, parsed.replay, parsed.spatial);
  const projectionMs = performance.now() - started;
  const second = projectMapHeatmap(parsed.match, parsed.replay, parsed.spatial);
  assert.equal(hash(first), hash(second));
  assert.equal(hash([parsed.match, parsed.replay, parsed.spatial]), inputHash);
  assert.deepEqual(JSON.parse(JSON.stringify(first)), first);
  const o = first.positions.observations;
  assert.equal(o.expectedOpportunities, 217570);
  assert.equal(o.validPositionSamples, 178514);
  assert.equal(o.confirmedDeadObservations, 39056);
  assert.equal(o.observedButUnusable, 0);
  assert.equal(o.missingPositionObservations, 0);
  assert.equal(o.positionObserved, 217570);
  assert.equal(o.positionCoverage, 178514 / 217570);
  assert.equal(o.positionCompleteness, 1);
  assert.equal(first.kills.scopeEvents, 162); assert.equal(first.kills.locatableEvents, 161);
  assert.equal(first.deaths.scopeEvents, 162); assert.equal(first.deaths.locatableEvents, 162);
  assert.equal(first.kills.unlocatableReasons.worldActor, 1);
  assert.equal(first.kills.outsideWindowEvents, 4); assert.equal(first.deaths.outsideWindowEvents, 4);
  assert.deepEqual(first.rosterApproximateRounds, []); assert.deepEqual(first.freezeBoundaryUnknownRounds, []);
  const rawValid = parsed.replay.rounds.flatMap(r => r.frames).flatMap(f => f.players).filter(p => p.actualTick !== null && p.position?.every(Number.isFinite)
    && p.alive === true && !p.stateAmbiguous && p.side !== 'Unknown' && p.segment !== null).length;
  assert.equal(rawValid, 235604);
  const compactGrid = g => ({ validPositionSamples: g.validPositionSamples, aggregatedSamples: g.aggregatedSamples, outOfBounds: g.outOfBounds,
    invalidMapping: g.invalidMapping, unknownLayer: g.unknownLayer, nonemptyCells: g.cells.filter(c => c.cellSampleCount > 0).length,
    maxCellSampleCount: g.maxCellSampleCount, maxCellSampleShare: g.maxCellSampleShare });
  const report = { stage: 'P7.1', fixture: '.demo/dust2.dem', sha256: sha, bytes: statSync(file).size,
    projectionHash: hash(first), repeatedProjectionHash: hash(second), projectionMs, dtoBytes: Buffer.byteLength(JSON.stringify(first)), rawReplayValidPositionRows: rawValid,
    observations: o, requestedLiveFrames: first.windows.reduce((s, r) => s + r.requestedFrames, 0),
    rosterApproximateRounds: first.rosterApproximateRounds, freezeBoundaryUnknownRounds: first.freezeBoundaryUnknownRounds,
    positions: compactGrid(first.positions.grid),
    kills: { ...first.kills, grid: compactGrid(first.kills.grid) }, deaths: { ...first.deaths, grid: compactGrid(first.deaths.grid) },
    alignment: first.map.alignment, scope: first.scope, resolution: first.grid.resolution,
    uniform8hz: null, inputUnchanged: true };
  const uniform = projectMapHeatmap(parsed.match, parsed.replay, parsed.spatial, { samplingSet: 'uniform-8hz', layers: ['positions'] });
  assert.ok(uniform.positions.available); assert.ok(uniform.positions.observations.expectedOpportunities < o.expectedOpportunities);
  report.uniform8hz = uniform.positions.observations;
  console.log(JSON.stringify(report));
  if (process.env.HEATMAP_REPORT_FILE) writeFileSync(process.env.HEATMAP_REPORT_FILE, JSON.stringify(report, null, 2) + '\n');
});
