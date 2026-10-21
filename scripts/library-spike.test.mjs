import test from 'node:test';
import assert from 'node:assert/strict';
import { compareCodecs, decodeVerified, digest, withoutSession, assertFixture, heatmapCases } from './library-spike-core.mjs';

test('L0 codec benchmark round-trips and rejects corrupted / over-budget payloads', () => {
  const source = Buffer.from(JSON.stringify({ x: Array.from({ length: 2000 }, (_, i) => ({ tick: i, player: 'p' })) }));
  const { result, gzip } = compareCodecs(source);
  const descriptor = { ...result, gzipBytes: gzip.length, gzipSha256: digest(gzip) };
  assert.deepEqual(decodeVerified(gzip, descriptor), JSON.parse(source));
  const bad = Buffer.from(gzip); bad[10] ^= 255;
  assert.throws(() => decodeVerified(bad, descriptor));
  assert.throws(() => decodeVerified(gzip, { ...descriptor, rawBytes: 10 }));
});
test('L0 snapshots omit temporary session handles without altering evidence', () => {
  assert.deepEqual(withoutSession({ replay: { sessionId: 'old', matchId: 'a', frames: [{ tick: 12 }] }, sessionId: 'old' }),
    { replay: { matchId: 'a', frames: [{ tick: 12 }] } });
});
test('L0 refuses legacy fixtures and covers every current heatmap filter dimension', () => {
  for (const name of ['dust2.dem', 'nuke.dem', 'demo1.dem', 'demo2.dem']) assertFixture(name);
  for (const name of ['demo3.dem', 'train.dem', 'match-final.dem', 'dust2.zip']) assert.throws(() => assertFixture(name));
  const cases = heatmapCases({ sessionId: 'fresh', layers: { positions: { available: true }, kills: { available: true }, deaths: { available: true } }, floors: ['main', 'lower'], playerIds: ['a', 'b'], rounds: [1, 2] });
  for (const layer of ['positions', 'kills', 'deaths']) for (const resolution of [16, 32, 64])
    for (const samplingSet of ['all-valid', 'uniform-8hz']) for (const includeFreezeTime of [false, true])
      for (const side of ['all', 'CT', 'T']) for (const floor of [null, 'main', 'lower'])
        assert.ok(cases.some(c => c.layer === layer && c.resolution === resolution && c.scope.samplingSet === samplingSet
          && c.scope.includeFreezeTime === includeFreezeTime && c.scope.side === side && c.scope.floor === floor));
  assert.ok(cases.some(c => c.scope.playerIds?.length === 0));
  assert.ok(cases.some(c => c.scope.rounds?.length === 0));
});
