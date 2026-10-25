import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { calculateDemDistance, gateMapResourceCapability, mapResourceIdentitySnapshot } from '../dist/index.js';

const space = { system: 'dem-server-xyz', unit: 'DEM-world-unit', normalization: 'native-unmodified-v1' };
const demoSha256 = 'd'.repeat(64);
const endpoint = (position = { x: 0, y: 0, z: 0 }, changes = {}) => ({
  schemaVersion: 'dem-position-v1', matchId: 'match', demoSha256, mapName: 'de_dust2',
  coordinateSpace: { ...space }, parserVersion: 'pinned-native-v1', actualTick: 100,
  playerId: 'player-a', evidenceRef: 'exact-row-a', position, ...changes,
});
const pair = (a, b, kind = 'three-dimensional') => calculateDemDistance(endpoint(a), endpoint(b, {
  playerId: 'player-b', evidenceRef: 'exact-row-b',
}), kind);
const origin = { x: 0, y: 0, z: 0 };
const values = [
  ['identical endpoints', { x: -4, y: 3, z: 0 }, { x: -4, y: 3, z: 0 }, 0, 0],
  ['X only', origin, { x: 3, y: 0, z: 0 }, 3, 3],
  ['Y only', origin, { x: 0, y: -4, z: 0 }, 4, 4],
  ['Z only', origin, { x: 0, y: 0, z: 12 }, 0, 12],
  ['horizontal differs from XYZ', origin, { x: 3, y: 4, z: 12 }, 5, 13],
  ['negative coordinates', { x: -3, y: -4, z: -12 }, origin, 5, 13],
  ['legal zero', origin, origin, 0, 0],
];
for (const [label, a, b, xy, xyz] of values) test(`numeric: ${label}`, () => {
  for (const [kind, expected] of [['horizontal', xy], ['three-dimensional', xyz]]) {
    const result = pair(a, b, kind);
    assert.equal(result.valid, true); assert.equal(result.value, expected);
    assert.equal(result.unit, 'DEM-world-unit'); assert.equal(result.actualTick, 100);
  }
});
test('numeric: input order changes references but not distance', () => {
  const a = endpoint({ x: -6, y: 8, z: -24 }); const b = endpoint(origin, { evidenceRef: 'row-b' });
  const ab = calculateDemDistance(a, b, 'three-dimensional');
  const ba = calculateDemDistance(b, a, 'three-dimensional');
  assert.equal(ab.value, 26); assert.equal(ab.value, ba.value);
  assert.deepEqual(ab.inputs, ba.inputs.toReversed());
});
test('numeric: large representable distance avoids intermediate-square overflow', () => {
  const result = pair(origin, { x: 1e200, y: 1e200, z: 1e200 });
  assert.equal(result.valid, true); assert.ok(Math.abs(result.value / 1e200 - Math.sqrt(3)) < 1e-14);
});
test('numeric: maximum representable axial distance', () => {
  assert.equal(pair(origin, { x: Number.MAX_VALUE, y: 0, z: 0 }).value, Number.MAX_VALUE);
});
test('numeric: subnormal values do not underflow through squaring', () => {
  assert.equal(pair(origin, { x: Number.MIN_VALUE, y: 0, z: 0 }).value, Number.MIN_VALUE);
});
test('numeric: subtraction overflow fails explicitly', () => {
  const result = pair({ x: -Number.MAX_VALUE, y: 0, z: 0 }, { x: Number.MAX_VALUE, y: 0, z: 0 });
  assert.equal(result.valid, false); assert.equal(result.reason, 'numeric-overflow'); assert.equal(result.value, null);
});
test('numeric: norm overflow fails explicitly', () => {
  assert.equal(pair(origin, { x: Number.MAX_VALUE, y: Number.MAX_VALUE, z: 0 }).reason, 'numeric-overflow');
});
test('numeric: horizontal ignores Z magnitude but requires valid Z', () => {
  const a = { x: 0, y: 0, z: -Number.MAX_VALUE }, b = { x: 3, y: 4, z: Number.MAX_VALUE };
  assert.equal(pair(a, b, 'horizontal').value, 5);
  assert.equal(pair(a, b).reason, 'numeric-overflow');
});
for (const bad of [NaN, Infinity, -Infinity, undefined, null, '0']) {
  test(`numeric: invalid XYZ ${String(bad)}`, () => {
    for (const axis of ['x', 'y', 'z']) for (const kind of ['horizontal', 'three-dimensional']) {
      assert.equal(pair(origin, { ...origin, [axis]: bad }, kind).reason, 'invalid-coordinate');
    }
  });
}
test('numeric: missing position is not a zero or nearest sample', () => {
  for (const position of [null, undefined])
    assert.equal(calculateDemDistance(endpoint(), endpoint(origin, { position }), 'horizontal').reason, 'position-missing');
});
const invalidEndpoints = [
  ['missing endpoint', null, 'missing-input'],
  ['missing schema', endpoint(origin, { schemaVersion: undefined }), 'invalid-schema'],
  ['missing map', endpoint(origin, { mapName: '' }), 'map-name-missing'],
  ['conflicting map', endpoint(origin, { mapName: 'de_nuke' }), 'map-name-conflict'],
  ['different DEM', endpoint(origin, { demoSha256: 'a'.repeat(64) }), 'different-demo'],
  ['different match', endpoint(origin, { matchId: 'other' }), 'different-match'],
  ['invalid DEM digest', endpoint(origin, { demoSha256: 'wrong' }), 'invalid-provenance'],
  ['missing evidence reference', endpoint(origin, { evidenceRef: '' }), 'invalid-provenance'],
  ['missing player', endpoint(origin, { playerId: '' }), 'invalid-provenance'],
  ['missing parser', endpoint(origin, { parserVersion: '' }), 'invalid-provenance'],
  ['different parser', endpoint(origin, { parserVersion: 'different' }), 'different-parser'],
  ['missing space', endpoint(origin, { coordinateSpace: undefined }), 'coordinate-space-unknown'],
  ['different system', endpoint(origin, { coordinateSpace: { ...space, system: 'radar' } }), 'coordinate-space-unknown'],
  ['unknown units', endpoint(origin, { coordinateSpace: { ...space, unit: 'meters' } }), 'coordinate-space-unknown'],
  ['different normalization', endpoint(origin, { coordinateSpace: { ...space, normalization: 'interpolated' } }), 'coordinate-space-unknown'],
  ['missing actual tick', endpoint(origin, { actualTick: null }), 'invalid-actual-tick'],
  ['fractional actual tick', endpoint(origin, { actualTick: 1.5 }), 'invalid-actual-tick'],
  ['negative actual tick', endpoint(origin, { actualTick: -1 }), 'invalid-actual-tick'],
  ['unsafe actual tick', endpoint(origin, { actualTick: 2 ** 53 }), 'invalid-actual-tick'],
  ['non-finite actual tick', endpoint(origin, { actualTick: Infinity }), 'invalid-actual-tick'],
  ['different tick', endpoint(origin, { actualTick: 101 }), 'different-tick'],
];
for (const [label, b, reason] of invalidEndpoints) test(`provenance: ${label}`, () => {
  const result = calculateDemDistance(endpoint(), b, 'horizontal');
  assert.equal(result.valid, false); assert.equal(result.value, null);
  assert.equal(result.actualTick, null); assert.equal(result.reason, reason);
});
test('provenance: actual tick zero is valid', () => {
  assert.equal(calculateDemDistance(endpoint(origin, { actualTick: 0 }), endpoint(origin, { actualTick: 0 }), 'horizontal').valid, true);
});
test('provenance: unknown calculation kind fails', () => {
  assert.equal(calculateDemDistance(endpoint(), endpoint(), 'route').reason, 'invalid-kind');
});
test('evidence: result detaches input references and coordinates', () => {
  const a = endpoint(), b = endpoint({ x: 3, y: 4, z: 12 }, { evidenceRef: 'row-b' });
  const result = calculateDemDistance(a, b, 'three-dimensional');
  assert.equal(result.value, 13); assert.deepEqual(result.inputs, [a, b]);
  a.position.x = 999; a.evidenceRef = 'changed'; b.coordinateSpace.unit = 'meters';
  assert.equal(result.inputs[0].position.x, 0); assert.equal(result.inputs[0].evidenceRef, 'exact-row-a');
  assert.equal(result.inputs[1].coordinateSpace.unit, 'DEM-world-unit');
});
test('information: future events cannot change frozen endpoints or repair a missing coordinate', () => {
  const a = Object.freeze(endpoint()), b = Object.freeze(endpoint({ x: 3, y: 4, z: 0 }));
  const before = calculateDemDistance(a, b, 'horizontal');
  const history = { futureEvents: [{ tick: 101, position: { x: 999, y: 999, z: 999 } }] };
  history.futureEvents.push({ tick: 102, position: origin });
  assert.deepEqual(calculateDemDistance(a, b, 'horizontal'), before);
  assert.equal(calculateDemDistance(a, endpoint(null), 'horizontal').reason, 'position-missing');
  assert.equal(before.informationScope, 'server-global'); assert.equal('playerKnown' in before, false);
});
test('information: unknown future and player-knowledge metadata never propagates through input snapshots', () => {
  const a = endpoint(), b = endpoint({ x: 3, y: 4, z: 12 });
  const before = calculateDemDistance(a, b, 'three-dimensional');
  a.futureEvents = [{ tick: 101, winner: 'CT' }];
  a.playerKnown = true;
  a.position.futureKillTick = 1234; a.position.playerKnown = true;
  a.coordinateSpace.futureWinner = 'CT';
  b.position.futureKillTick = 9999; b.coordinateSpace.futureWinner = 'T';
  assert.deepEqual(calculateDemDistance(a, b, 'three-dimensional'), before);
  a.futureEvents.length = 0; a.position.futureKillTick++;
  assert.deepEqual(calculateDemDistance(a, b, 'three-dimensional'), before);
  a.position = null;
  a.futurePosition = { ...origin };
  assert.equal(calculateDemDistance(a, b, 'horizontal').reason, 'position-missing');
});

const projection = 'overview-projection-arithmetic';
const target = { mapName: 'de_dust2', demoSha256 };
function resource() {
  const identity = {
    schemaVersion: 'map-resource-identity-v1', resourceId: 'synthetic-overview', mapName: target.mapName,
    source: { kind: 'local-derived', reference: 'synthetic-test', version: null },
    digest: { kind: 'controlled-manifest', sha256: 'a'.repeat(64) }, coordinateSpace: { ...space },
    match: { status: 'unconfirmed', targetDemoSha256: null, evidenceRefs: [] },
    scope: 'overview arithmetic only', limitations: ['No geometry match'], producerVersion: 'synthetic-v1',
  };
  return { schemaVersion: 'map-resource-record-v1', identity, capabilities: {
    [projection]: { status: 'validated', methodVersion: 'synthetic-arithmetic-v1', evidenceRefs: ['synthetic-check'],
      boundIdentity: mapResourceIdentitySnapshot(identity) },
  } };
}
test('resource: valid unconfirmed identity grants overview arithmetic only', () => {
  assert.equal(gateMapResourceCapability(resource(), target, projection).allowed, true);
});
test('resource: snapshot is canonical across property insertion order', () => {
  const r = resource(); r.identity = Object.fromEntries(Object.entries(r.identity).reverse());
  assert.equal(gateMapResourceCapability(r, target, projection).allowed, true);
});
test('resource: existing controlled manifest identity can be audited without game resources', () => {
  const bytes = readFileSync(new URL('../../../docs/replay-resources.json', import.meta.url));
  const manifest = JSON.parse(bytes); const r = resource();
  r.identity.resourceId = manifest.resourceId;
  r.identity.source = { kind: 'steam-distribution', reference: `730/2347770/${manifest.source.manifestId}`, version: manifest.source.manifestId };
  r.identity.digest.sha256 = createHash('sha256').update(bytes).digest('hex');
  r.capabilities[projection].boundIdentity = mapResourceIdentitySnapshot(r.identity);
  assert.equal(gateMapResourceCapability(r, target, projection).allowed, true);
  assert.equal(r.identity.match.status, 'unconfirmed');
});
const badResources = [
  ['missing record', () => null, 'invalid-record'],
  ['missing map name', r => { r.identity.mapName = ''; return r; }, 'invalid-record'],
  ['map conflict', r => { r.identity.mapName = 'de_nuke'; return r; }, 'map-name-conflict'],
  ['invalid digest', r => { r.identity.digest.sha256 = 'wrong'; return r; }, 'invalid-digest'],
  ['unknown digest kind', r => { r.identity.digest.kind = 'vpk-name'; return r; }, 'invalid-digest'],
  ['missing coordinate space', r => { delete r.identity.coordinateSpace; return r; }, 'coordinate-space-unknown'],
  ['unknown unit', r => { r.identity.coordinateSpace.unit = 'meters'; return r; }, 'coordinate-space-unknown'],
  ['mismatched', r => { r.identity.match.status = 'mismatched'; return r; }, 'resource-mismatched'],
  ['unverified capability', r => { r.capabilities = {}; return r; }, 'capability-unverified'],
  ['blocked capability', r => { r.capabilities[projection].status = 'blocked'; return r; }, 'capability-unverified'],
  ['not-run capability', r => { r.capabilities[projection].status = 'not-run'; return r; }, 'capability-unverified'],
  ['missing verification evidence', r => { r.capabilities[projection].evidenceRefs = []; return r; }, 'capability-unverified'],
  ['missing method version', r => { r.capabilities[projection].methodVersion = ''; return r; }, 'capability-unverified'],
  ['matched lacks proof', r => { r.identity.match.status = 'matched'; return r; }, 'invalid-match-evidence'],
  ['different target DEM', r => { r.identity.match.targetDemoSha256 = 'f'.repeat(64); return r; }, 'different-demo'],
];
for (const [label, change, reason] of badResources) test(`resource failure: ${label}`, () => {
  const result = gateMapResourceCapability(change(resource()), target, projection);
  assert.equal(result.allowed, false); assert.equal(result.reason, reason);
});
test('resource: invalid target is rejected', () => {
  for (const t of [null, {}, { ...target, mapName: '' }, { ...target, demoSha256: '' }])
    assert.equal(gateMapResourceCapability(resource(), t, projection).reason, 'invalid-target');
});
for (const field of ['status', 'digest', 'source', 'version', 'scope', 'limitations', 'producer'])
  test(`resource: ${field} changes invalidate old capability evidence`, () => {
    const r = resource();
    if (field === 'status') r.identity.match = { status: 'matched', targetDemoSha256: demoSha256, evidenceRefs: ['synthetic-match-proof'] };
    if (field === 'digest') r.identity.digest.sha256 = 'b'.repeat(64);
    if (field === 'source') r.identity.source.reference = 'another-source';
    if (field === 'version') r.identity.source.version = 'another-version';
    if (field === 'scope') r.identity.scope = 'broader-scope';
    if (field === 'limitations') r.identity.limitations.push('new-limit');
    if (field === 'producer') r.identity.producerVersion = 'v2';
    assert.equal(gateMapResourceCapability(r, target, projection).reason, 'stale-capability-evidence');
  });
for (const capability of ['version-matched-world-mapping', 'navigation-reachability', 'static-los', 'dynamic-occlusion'])
  test(`resource: ${capability} remains closed even with claimed validation and matching`, () => {
    const r = resource();
    r.identity.match = { status: 'matched', targetDemoSha256: demoSha256, evidenceRefs: ['synthetic-proof'] };
    r.capabilities[capability] = { ...r.capabilities[projection], boundIdentity: mapResourceIdentitySnapshot(r.identity) };
    assert.equal(gateMapResourceCapability(r, target, capability).reason, 'not-implemented');
  });
test('separation: resource mismatch never blocks legal XYZ distances', () => {
  const r = resource(); r.identity.match.status = 'mismatched';
  assert.equal(gateMapResourceCapability(r, target, projection).allowed, false);
  assert.equal(pair(origin, { x: 3, y: 4, z: 12 }).value, 13);
  for (const kind of ['horizontal-distance', 'three-dimensional-distance'])
    assert.equal(gateMapResourceCapability(resource(), target, kind).reason, 'coordinate-distance-separate');
});
