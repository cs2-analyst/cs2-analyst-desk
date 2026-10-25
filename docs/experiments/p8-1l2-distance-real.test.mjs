// Explicit local integration check; no resource extraction, downloads or raw row output.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import native from '../../packages/demoparser-native/index.cjs';
import { calculateDemDistance } from '../../packages/analytics/dist/index.js';

const fixture = new URL('../../.demo/dust2.dem', import.meta.url);
test('pinned local Dust2: new distance API preserves four historical exact native endpoint pairs', {
  skip: existsSync(fixture) ? false : 'Local .demo/dust2.dem absent; no replacement/download',
}, () => {
  const bytes = readFileSync(fixture);
  const demoSha256 = createHash('sha256').update(bytes).digest('hex');
  assert.equal(demoSha256, 'db90fe85aab023a1d2c8a5996182e6120d98ef494f02a070b17982b235e4958c');
  const mapName = native.parseHeader(bytes).map_name;
  assert.equal(mapName, 'de_dust2');
  const provenance = native.getBindingProvenance();
  const nativeVersion = JSON.parse(readFileSync(new URL('../../packages/demoparser-native/package.json', import.meta.url))).version;
  const parserVersion = `${nativeVersion}:${provenance.verifiedSha256}`;
  const anchors = [92395, 185100, 194101, 201348];
  const rows = native.parseTicks(bytes, ['X', 'Y', 'Z', 'is_alive', 'team_num'], anchors);
  for (const actualTick of anchors) {
    const selected = rows.filter(r => r.tick === actualTick && r.is_alive === true && [2, 3].includes(r.team_num))
      .sort((a, b) => a.team_num - b.team_num);
    assert.equal(selected.length, 2); assert.deepEqual(selected.map(r => r.team_num), [2, 3]);
    const inputs = selected.map((r, index) => ({
      schemaVersion: 'dem-position-v1', matchId: demoSha256, demoSha256, mapName,
      coordinateSpace: { system: 'dem-server-xyz', unit: 'DEM-world-unit', normalization: 'native-unmodified-v1' },
      parserVersion, actualTick: r.tick, playerId: r.steamid,
      evidenceRef: `native-exact:${actualTick}:${index}`, position: { x: r.X, y: r.Y, z: r.Z },
    }));
    const [a, b] = selected;
    const horizontal = Math.hypot(a.X - b.X, a.Y - b.Y);
    const legacyDirect = Math.hypot(horizontal, Math.abs(a.Z - b.Z));
    for (const [kind, expected] of [['horizontal', horizontal], ['three-dimensional', legacyDirect]]) {
      const result = calculateDemDistance(...inputs, kind);
      assert.equal(result.valid, true); assert.equal(result.actualTick, actualTick);
      assert.equal(result.value, expected); assert.equal(result.informationScope, 'server-global');
      assert.deepEqual(result.inputs, inputs);
    }
  }
});
