import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { localDemFixture } from './local-dem-fixture.mjs';

export const dust2File = localDemFixture('dust2.dem');
export const dust2Sha = 'db90fe85aab023a1d2c8a5996182e6120d98ef494f02a070b17982b235e4958c';
export const jsonHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const defaultScope = () => ({ rounds: null, playerIds: null, side: 'all', floor: null,
  includeFreezeTime: false, samplingSet: 'all-valid' });
export async function verifyDust2() {
  assert.equal(statSync(dust2File).size, 557650967);
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(dust2File)) digest.update(chunk);
  assert.equal(digest.digest('hex'), dust2Sha, 'Wrong local Dust2 bytes; no replacement sample');
}
export function realHeatmapRequests(metadata) {
  const request = (layer, resolution, scope = {}) => ({ schemaVersion: 1, sessionId: metadata.sessionId,
    layer, resolution, scope: { ...defaultScope(), ...scope } });
  const cases = [];
  for (const resolution of [16, 32, 64]) for (const layer of ['positions', 'kills', 'deaths']) {
    cases.push({ label: `${layer}-${resolution}`, request: request(layer, resolution) });
  }
  const filters = [
    ['player', { playerIds: [metadata.playerIds[0]] }],
    ['CT', { side: 'CT' }], ['round', { rounds: [metadata.rounds[0]] }],
    ['floor', { floor: metadata.floors[0] }],
    ['freeze', { includeFreezeTime: true }], ['uniform', { samplingSet: 'uniform-8hz' }],
    ['combined', { playerIds: [metadata.playerIds[0]], side: 'T', rounds: metadata.rounds.slice(0, 3), floor: metadata.floors[0] }],
  ];
  for (const [label, scope] of filters) for (const layer of ['positions', 'kills', 'deaths']) {
    cases.push({ label: `${layer}-${label}`, request: request(layer, 32, scope) });
  }
  return cases;
}
