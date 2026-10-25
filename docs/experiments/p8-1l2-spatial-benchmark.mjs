// L2.2C research only. Existing native parser and display resources; no game-resource reader.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { replayMapDefinitions, worldToRadar } from '../../apps/desktop/shared/replay-map-geometry.ts';
import { parseOverview, pngDimensions } from '../../scripts/replay-resource-audit.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = path => readFileSync(resolve(root, path));
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const dust = replayMapDefinitions.find(map => map.id === 'de_dust2');
export const protocol = {
  id: 'l22c-spatial-benchmark-v1',
  frozenBeforeCurrentRun: true,
  priorExposure: 'Historical four-region outcomes were read before this protocol; all region reruns are exploratory, never held-out validation.',
  arithmetic: { tolerancePx: 1e-9, scope: 'finite practical inputs; |XYZ|<=1e6, dimensions 1..8192, scale 1..100; not an exhaustive numeric proof' },
  independentAccuracy: {
    maxReferenceUncertaintyPx: 2, regionalMinDistinctHeldOutLandmarks: 6,
    maxConservativeErrorPx: 8, medianConservativeErrorPx: 4,
    regionalMinHullFraction: 0.5, globalMinDistinctHeldOutLandmarks: 24,
    globalMinRegions: 6, globalMinLandmarksPerRegion: 4, p95MinDistinctLandmarks: 20,
    method: 'No fitting on validation points. Conservative error = Euclidean point residual + bounded radial reference uncertainty. Non-collinear references; region center, perimeter, both axes and declared height bands must be covered. Outside supported hull/height is unconfirmed.',
    rationale: 'Prospective research budgets at native 1024 px, not game-accuracy standards. Thresholds alone cannot certify source independence or geometry.',
  },
  sample: {
    fixture: '.demo/dust2.dem', sha256: 'db90fe85aab023a1d2c8a5996182e6120d98ef494f02a070b17982b235e4958c',
    freezeTick: 2712,
    plantTicks: [21621, 43991, 61675, 70450, 91257, 101668, 114041, 124988, 144817, 161643, 183400, 199980],
    fields: ['X', 'Y', 'Z', 'is_alive', 'team_num'],
    selection: 'Historical ticks frozen before rerun. All live team 2/3 rows at first freeze tick; unique bomb_planted actor joined at each plant tick. No nearest-tick substitution; no trajectory query.',
  },
  regions: [
    { id: 't-spawn', bounds: [295, 875, 490, 960] },
    { id: 'ct-spawn', bounds: [570, 150, 685, 265] },
    { id: 'east-bomb-area', bounds: [775, 135, 855, 215] },
    { id: 'west-bomb-area', bounds: [165, 78, 260, 180] },
  ],
  regionInterpretation: 'Historical image rectangles, not point correspondences. East/west plant grouping uses X sign as in old script; it is transform-sensitive and not an independent site assignment. Bounds have no calibrated uncertainty.',
};

// Visual annotations from the unmodified PNG, never from overview inverse transforms.
// These are agent visual estimates, not human survey measurements or DEM correspondences.
export const imageReferences = [
  ['IMG01', 'west-bomb-area', 'northwest corner of orange marker', 171, 82, 4],
  ['IMG02', 'east-bomb-area', 'northwest corner of orange marker', 780, 139, 4],
  ['IMG03', 't-spawn', 'southwest corner of green marker', 295, 957, 4],
  ['IMG04', 'ct-spawn', 'northwest corner of solid green marker', 574, 155, 4],
  ['IMG05', 'mid', 'center of diagonal double-door gap', 458, 371, 8],
  ['IMG06', 'a-long-east', 'southeast corner of long blue rectangle', 921, 698, 6],
  ['IMG07', 'west-tunnel-stairs', 'center of curved stair depiction', 282, 475, 10],
  ['IMG08', 'ct-overlap', 'center of hatched overlapping-level depiction', 648, 212, 12],
].map(([referenceId, region, feature, x, y, uncertainty]) => ({
  referenceId, region, referenceType: 'image-only-fixed-feature-candidate', feature,
  worldPosition: null, imagePosition: { x, y }, imageSource: 'apps/desktop/renderer/src/assets/replay-maps/de_dust2.png',
  sourceEvidence: 'Natural-size 1024x1024 PNG visual inspection; same-image annotation independent of worldToRadar arithmetic, but no world/DEM correspondence.',
  annotationMethod: 'Agent visual estimate on original image; top-left origin, x right/y down, continuous pixel coordinates; no resampling, inverse transform, or projection overlay.',
  referenceUncertainty: { estimatedRadiusPx: uncertainty, calibrated: false, worldUnits: null, note: 'Heuristic visual ambiguity range, not a measured confidence interval.' },
  suitability: 'exploration-only', trainingEligible: false, validationEligible: false,
  missingEvidence: 'Independent identification and measurement of this exact fixed feature in target DEM world coordinates, including Z/height and bounded uncertainty.',
}));

export function summarize(values, p95Minimum = 20) {
  assert.ok(values.every(Number.isFinite));
  if (!values.length) return { count: 0, mean: null, median: null, max: null, p95: null, p95Status: 'insufficient-sample' };
  const sorted = [...values].sort((a, b) => a - b), n = sorted.length;
  return { count: n, mean: sorted.reduce((a, b) => a + b, 0) / n,
    median: n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2,
    max: sorted[n - 1], p95: n >= p95Minimum ? sorted[Math.ceil(0.95 * n) - 1] : null,
    p95Status: n >= p95Minimum ? 'nearest-rank-descriptive-only' : 'insufficient-sample' };
}

export function pointResidual(projected, reference, width, height) {
  assert.ok([projected.x, projected.y, reference.x, reference.y, width, height].every(Number.isFinite));
  assert.ok(width > 0 && height > 0);
  const dx = projected.x - reference.x, dy = projected.y - reference.y;
  return { dxPx: dx, dyPx: dy, errorPx: Math.hypot(dx, dy), normalizedError: Math.hypot(dx / width, dy / height) };
}

export function rectangleDiagnostic(point, [left, top, right, bottom]) {
  assert.ok([point.x, point.y, left, top, right, bottom].every(Number.isFinite));
  assert.ok(left < right && top < bottom);
  const lowerBoundPx = Math.hypot(Math.max(left - point.x, 0, point.x - right), Math.max(top - point.y, 0, point.y - bottom));
  const upperBoundPx = Math.hypot(Math.max(Math.abs(point.x - left), Math.abs(point.x - right)), Math.max(Math.abs(point.y - top), Math.abs(point.y - bottom)));
  return { inside: lowerBoundPx === 0, lowerBoundPx, upperBoundPx,
    normalizedLowerBound: lowerBoundPx / 1024, normalizedUpperBound: upperBoundPx / 1024,
    interpretation: 'Conditional distance range IF the unknown reference is somewhere in this rectangle; not a measured landmark residual. Inside does not mean zero error.' };
}

export function arithmeticChecks() {
  const cases = [
    ['origin', { x: -2476, y: 3239 }, { x: 0, y: 0 }],
    ['x-right', { x: -2036, y: 3239 }, { x: 100, y: 0 }],
    ['y-up', { x: -2476, y: 3679 }, { x: 0, y: -100 }],
    ['center', { x: -223.2, y: 986.2 }, { x: 512, y: 512 }],
    ['bottom-right-edge', { x: 2029.6, y: -1266.6 }, { x: 1024, y: 1024 }],
    ['outside-left', { x: -2916, y: 3239 }, { x: -100, y: 0 }],
    ['outside-bottom', { x: -2476, y: -1706.6 }, { x: 0, y: 1124 }],
  ];
  return cases.map(([id, input, expected]) => {
    const actual = worldToRadar(dust, input), residual = pointResidual(actual, expected, 1024, 1024);
    assert.ok(residual.errorPx <= protocol.arithmetic.tolerancePx);
    return { id, input, expected, actual, residual, evidenceClass: 'synthetic-formula-only', status: 'PASS' };
  });
}

function fileIdentity(path) {
  const before = statSync(resolve(root, path)), bytes = read(path), after = statSync(resolve(root, path));
  assert.equal(before.size, after.size); assert.equal(before.mtimeMs, after.mtimeMs);
  return { path, bytes: bytes.length, sha256: digest(bytes) };
}

export async function runBenchmark() {
  const startedAt = new Date().toISOString();
  const resources = JSON.parse(read('docs/replay-resources.json'));
  const record = resources.maps.find(map => map.map === 'de_dust2');
  const overviewPath = 'apps/desktop/renderer/src/assets/replay-overviews/de_dust2.txt';
  const imagePath = 'apps/desktop/renderer/src/assets/replay-maps/de_dust2.png';
  const files = [overviewPath, imagePath, 'docs/replay-resources.json', 'docs/replay-calibration.json',
    'apps/desktop/shared/replay-map-geometry.ts'].map(fileIdentity);
  assert.equal(files[0].sha256, record.overview.sha256); assert.equal(files[1].sha256, record.images[0].sha256);
  const overview = parseOverview(read(overviewPath).toString('utf8'), 'de_dust2');
  assert.deepEqual(overview.transform, { posX: dust.posX, posY: dust.posY, scale: dust.scale });
  assert.deepEqual(pngDimensions(read(imagePath)), { width: dust.width, height: dust.height });
  assert.equal(dust.versionMatch, 'unconfirmed'); assert.equal(record.demVersionMatch, 'unconfirmed');
  const arithmetic = arithmeticChecks();
  // Exact fixture path is intentional: no arbitrary fixture, replacement, directory scan or external reader.
  const before = statSync(resolve(root, protocol.sample.fixture)), bytes = read(protocol.sample.fixture);
  assert.equal(digest(bytes), protocol.sample.sha256, 'Pinned DEM digest differs');
  const { default: native } = await import('../../packages/demoparser-native/index.cjs');
  assert.equal(native.parseHeader(bytes).map_name, 'de_dust2');
  const binding = native.getBindingProvenance();
  const events = native.parseEvents(bytes, ['round_freeze_end', 'bomb_planted'], ['team_num', 'is_alive'], ['is_warmup_period']);
  assert.ok(Array.isArray(events));
  const ticks = [protocol.sample.freezeTick, ...protocol.sample.plantTicks].sort((a, b) => a - b);
  assert.equal(events.filter(e => e.event_name === 'round_freeze_end' && e.tick === protocol.sample.freezeTick && e.is_warmup_period !== true).length, 1);
  const rows = native.parseTicks(bytes, protocol.sample.fields, ticks);
  assert.ok(Array.isArray(rows) && rows.every(row => ticks.includes(row.tick)), 'Only requested actual ticks are permitted');
  const selected = rows.filter(row => row.tick === protocol.sample.freezeTick && row.is_alive === true && [2, 3].includes(row.team_num));
  assert.equal(selected.length, 10);
  assert.equal(selected.filter(row => row.team_num === 2).length, 5);
  assert.equal(selected.filter(row => row.team_num === 3).length, 5);
  assert.equal(new Set(selected.map(row => row.steamid)).size, 10);
  for (const tick of protocol.sample.plantTicks) {
    const plants = events.filter(e => e.event_name === 'bomb_planted' && e.tick === tick && e.is_warmup_period !== true);
    assert.equal(plants.length, 1, 'Missing or ambiguous plant event');
    assert.ok(typeof plants[0].user_steamid === 'string' && /^[1-9]\d*$/.test(plants[0].user_steamid), 'Missing plant actor');
    const actors = rows.filter(row => row.tick === tick && row.steamid === plants[0].user_steamid);
    assert.equal(actors.length, 1, 'Missing or ambiguous exact actor row');
    assert.equal(actors[0].is_alive, true); selected.push(actors[0]);
  }
  // Remove identities before producing any persisted output. No stable cross-tick aliases or raw event dumps.
  const probes = selected.map(row => {
    assert.ok([row.X, row.Y, row.Z].every(Number.isFinite));
    const input = { x: row.X, y: row.Y, z: row.Z }, output = worldToRadar(dust, input);
    assert.ok(output && [output.x, output.y].every(Number.isFinite));
    const regionId = row.tick === protocol.sample.freezeTick ? (row.team_num === 2 ? 't-spawn' : 'ct-spawn')
      : row.X > 0 ? 'east-bomb-area' : row.X < 0 ? 'west-bomb-area' : null;
    const region = protocol.regions.find(region => region.id === regionId);
    assert.ok(region, 'Ambiguous historical sign group');
    return { actualTick: row.tick, input, output, regionId, diagnostic: rectangleDiagnostic(output, region.bounds),
      referenceId: null, pointResidual: null, evidenceClass: 'unpaired-real-server-snapshot',
      locator: row.tick === protocol.sample.freezeTick ? 'exact tick + side + unique XYZ (local only)' : 'unique bomb_planted event actor at actual tick (identity used only in memory)' };
  }).sort((a, b) => a.actualTick - b.actualTick || a.input.x - b.input.x || a.input.y - b.input.y);
  const regions = protocol.regions.map(region => {
    const group = probes.filter(probe => probe.regionId === region.id);
    return { ...region, sampleCount: group.length, actualTicks: [...new Set(group.map(p => p.actualTick))],
      insideCount: group.filter(p => p.diagnostic.inside).length, independentCorrespondences: 0,
      pointResiduals: summarize([]), lowerBoundPx: summarize(group.map(p => p.diagnostic.lowerBoundPx)),
      upperBoundPx: summarize(group.map(p => p.diagnostic.upperBoundPx)),
      status: 'exploratory-only', compatibility: 'unconfirmed' };
  });
  const after = statSync(resolve(root, protocol.sample.fixture));
  assert.equal(before.size, after.size); assert.equal(before.mtimeMs, after.mtimeMs);
  return { startedAt, completedAt: new Date().toISOString(), protocolSha256: digest(JSON.stringify(protocol)),
    protocol, imageReferences, files, resourceId: resources.resourceId,
    identity: { versionMatch: dust.versionMatch, demVersionMatch: record.demVersionMatch },
    fixture: { filename: protocol.sample.fixture, sha256: protocol.sample.sha256, bytes: bytes.length, stableSizeMtime: true },
    parser: { version: JSON.parse(read('packages/demoparser-native/package.json')).version, binarySha256: binding.verifiedSha256 },
    arithmetic, realQuery: { fields: protocol.sample.fields, requestedTicks: ticks,
      actualTicks: [...new Set(rows.map(row => row.tick))].sort((a, b) => a - b), returnedRows: rows.length,
      selectedRows: probes.length, missingSelectedRows: 0, selectionUsesHistoricalOutcomes: true },
    regions, independentResiduals: summarize([]), probes,
    result: { coordinateProjectionArithmetic: 'PASS', independentSpatialAccuracy: 'BLOCKED', globalCoordinateConsistency: 'BLOCKED',
      regionalCompatibility: 'unconfirmed', staticCollision: 'NOT RUN', nav: 'NOT RUN', staticLOS: 'NOT RUN', dynamicOcclusion: 'NOT RUN' } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const output = process.argv[2];
  assert.ok(output && isAbsolute(output), 'Supply an absolute local scratch JSON path outside the repository');
  const parent = realpathSync(dirname(output)), fromRoot = relative(realpathSync(root), parent);
  assert.ok(fromRoot === '..' || fromRoot.startsWith('..\\') || fromRoot.startsWith('../') || isAbsolute(fromRoot), 'Raw probes must stay outside the repository');
  const result = await runBenchmark();
  writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ result: result.result, realQuery: result.realQuery, regions: result.regions, output }));
}
