import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { worldToRadar, resolveMapLayer } from '../../apps/desktop/shared/replay-map-geometry.ts';
import { arithmeticChecks, dust, protocol, imageReferences, summarize, pointResidual, rectangleDiagnostic } from './p8-1l2-spatial-benchmark.mjs';

test('synthetic arithmetic: known origin, axes, scale and unclamped boundaries', () => {
  assert.equal(arithmeticChecks().length, 7);
});
test('non-square display scaling uses independent width/height factors', () => {
  const value = worldToRadar({ ...dust, width: 2048, height: 512 }, { x: -2036, y: 2799 });
  assert.ok(Math.abs(value.x - 200) < 1e-9 && Math.abs(value.y - 50) < 1e-9);
});
test('invalid numeric inputs are rejected without coercion', () => {
  for (const value of [NaN, Infinity, -Infinity, null, undefined, '1']) {
    for (const field of ['x', 'y']) assert.equal(worldToRadar(dust, { x: 0, y: 0, [field]: value }), null);
    for (const field of ['posX', 'posY', 'scale', 'width', 'height']) assert.equal(worldToRadar({ ...dust, [field]: value }, { x: 0, y: 0 }), null);
  }
  for (const field of ['scale', 'width', 'height']) for (const value of [0, -1]) assert.equal(worldToRadar({ ...dust, [field]: value }, { x: 0, y: 0 }), null);
});
test('HUD flags and Z do not change the unrotated XY projection', () => {
  const input = { x: -2036, y: 2799 };
  assert.deepEqual(worldToRadar({ ...dust, rotate: 1, zoom: 1.1, inset_left: 0.2 }, { ...input, z: 500 }), worldToRadar(dust, { ...input, z: -500 }));
  assert.equal(resolveMapLayer(dust, null), 'default');
});
test('characterize existing extreme-number overflow outside claimed arithmetic envelope', () => {
  const actual = worldToRadar({ ...dust, posX: -Number.MAX_VALUE }, { x: Number.MAX_VALUE, y: 0 });
  assert.equal(actual.x, Infinity); // No production fix or full finite-number safety claim in this task.
});
test('synthetic residual uses Euclidean pixels and axis-normalized coordinates', () => {
  assert.deepEqual(pointResidual({ x: 3, y: 4 }, { x: 0, y: 0 }, 1024, 1024), { dxPx: 3, dyPx: 4, errorPx: 5, normalizedError: 5 / 1024 });
  assert.equal(pointResidual({ x: 3, y: 4 }, { x: 0, y: 0 }, 3, 4).normalizedError, Math.SQRT2);
  assert.throws(() => pointResidual({ x: NaN, y: 0 }, { x: 0, y: 0 }, 1024, 1024));
});
test('rectangle containment retains a nonzero upper error bound', () => {
  const inside = rectangleDiagnostic({ x: 5, y: 5 }, [0, 0, 10, 10]);
  assert.equal(inside.lowerBoundPx, 0); assert.equal(inside.upperBoundPx, Math.hypot(5, 5));
  const outside = rectangleDiagnostic({ x: 13, y: 14 }, [0, 0, 10, 10]);
  assert.equal(outside.lowerBoundPx, 5); assert.equal(outside.upperBoundPx, Math.hypot(13, 14));
});
test('empty/missing references cannot become zero accuracy or P95', () => {
  assert.deepEqual(summarize([]), { count: 0, mean: null, median: null, max: null, p95: null, p95Status: 'insufficient-sample' });
  assert.equal(summarize([0, 1, 2, 3]).median, 1.5);
  assert.equal(summarize([0, 1, 2, 3]).p95, null);
  assert.equal(summarize(Array.from({ length: 20 }, (_, i) => i + 1)).p95, 19);
});
test('reference registry remains image-only, uncertain and ineligible for training/validation', () => {
  assert.equal(imageReferences.length, 8);
  assert.equal(new Set(imageReferences.map(r => r.referenceId)).size, 8);
  for (const ref of imageReferences) {
    assert.equal(ref.worldPosition, null); assert.equal(ref.validationEligible, false); assert.equal(ref.trainingEligible, false);
    assert.ok(ref.referenceUncertainty.estimatedRadiusPx > 0); assert.equal(ref.referenceUncertainty.calibrated, false);
  }
});
test('frozen sampling is bounded, exact-only and explicitly exploratory', () => {
  assert.equal(new Set([protocol.sample.freezeTick, ...protocol.sample.plantTicks]).size, 13);
  assert.equal(protocol.regions.length, 4);
  assert.match(protocol.priorExposure, /exploratory/);
});
test('existing production resource statuses remain unconfirmed', () => {
  const resource = JSON.parse(readFileSync(new URL('../replay-resources.json', import.meta.url)));
  assert.equal(dust.versionMatch, 'unconfirmed');
  assert.equal(resource.maps.find(m => m.map === 'de_dust2').demVersionMatch, 'unconfirmed');
});
