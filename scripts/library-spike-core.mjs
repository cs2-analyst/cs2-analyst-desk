// L0 experiment helpers. These are not the production library/archive contract.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { basename, extname } from 'node:path';
import { brotliCompressSync, brotliDecompressSync, constants, gzipSync, gunzipSync } from 'node:zlib';
import { performance } from 'node:perf_hooks';

export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const hashJson = value => digest(JSON.stringify(value));
export function withoutSession(value) {
  return JSON.parse(JSON.stringify(value, (key, item) => key === 'sessionId' ? undefined : item));
}
export function assertFixture(path) {
  const name = basename(path);
  assert.equal(extname(name), '.dem');
  assert.ok(/^(?:dust2|nuke|inferno|mirage|ancient|anubis|overpass|vertigo|cache|demo|demo1|demo2)\.dem$/.test(name), 'Only an approved map-name / generic local DEM fixture is permitted; Train is excluded by the fixture matrix');
}
export function compareCodecs(raw) {
  const result = { rawBytes: raw.length, sha256: digest(raw), codecs: {} };
  let gzip;
  for (const [name, encode, decode] of [
    ['gzip-6', value => gzipSync(value, { level: 6 }), gunzipSync],
    ['brotli-4', value => brotliCompressSync(value, { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } }), brotliDecompressSync],
  ]) {
    const cpu = process.cpuUsage(), start = performance.now(), encoded = encode(raw), encodedAt = performance.now();
    const decoded = decode(encoded), end = performance.now();
    assert.ok(decoded.equals(raw), `${name} exact byte round-trip`);
    result.codecs[name] = { bytes: encoded.length, encodeMs: encodedAt - start, decodeMs: end - encodedAt,
      cpuMicroseconds: process.cpuUsage(cpu) };
    if (name === 'gzip-6') gzip = encoded;
  }
  return { result, gzip };
}
export function decodeVerified(encoded, expected) {
  assert.equal(encoded.length, expected.gzipBytes, 'Compressed size mismatch');
  assert.equal(digest(encoded), expected.gzipSha256, 'Compressed digest mismatch');
  const raw = gunzipSync(encoded, { maxOutputLength: expected.rawBytes });
  assert.equal(raw.length, expected.rawBytes, 'Uncompressed size mismatch');
  assert.equal(digest(raw), expected.sha256, 'Uncompressed digest mismatch');
  return JSON.parse(raw.toString('utf8'));
}
export function quantiles(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return { count: sorted.length, min: sorted[0], p50: sorted[Math.floor(sorted.length * .5)], p95: sorted[Math.floor(sorted.length * .95)], max: sorted.at(-1) };
}
export function heatmapCases(metadata) {
  const base = { rounds: null, playerIds: null, side: 'all', floor: null, includeFreezeTime: false, samplingSet: 'all-valid' };
  const cases = [];
  const add = (layer, resolution, scope) => cases.push({ schemaVersion: 1, sessionId: metadata.sessionId, layer, resolution, scope: { ...base, ...scope } });
  for (const layer of ['positions', 'kills', 'deaths']) {
    if (!metadata.layers[layer].available) continue;
    for (const resolution of [16, 32, 64]) for (const includeFreezeTime of [false, true])
      for (const samplingSet of ['all-valid', 'uniform-8hz']) for (const side of ['all', 'CT', 'T'])
        for (const floor of [null, ...metadata.floors]) add(layer, resolution, { includeFreezeTime, samplingSet, side, floor });
    for (const id of metadata.playerIds) add(layer, 32, { playerIds: [id] });
    for (const round of metadata.rounds) add(layer, 32, { rounds: [round] });
    // Empty selections and simultaneous player/round/side/floor selection exercise the remaining selection semantics.
    add(layer, 32, { playerIds: [] }); add(layer, 32, { rounds: [] });
    add(layer, 64, { playerIds: metadata.playerIds.slice(0, 2), rounds: metadata.rounds.slice(0, 2), side: 'CT',
      floor: metadata.floors.at(-1) ?? null, includeFreezeTime: true, samplingSet: 'uniform-8hz' });
  }
  return cases;
}
