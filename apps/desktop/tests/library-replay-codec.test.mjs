import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeStoredReplay, decodeStoredReplay, STORED_REPLAY_ENCODING } from '../electron/library-replay-codec.ts';

const json = value => JSON.stringify(value);
const canonicalRoundTrip = source => {
  const original = json(source), encoded = encodeStoredReplay(source);
  const restored = decodeStoredReplay(JSON.parse(json(encoded)));
  assert.equal(json(restored), original, 'every canonical JSON byte must match, including key and sample order');
  assert.deepEqual(restored, source);
  assert.equal(json(source), original, 'encoding must not mutate the source');
  return encoded;
};
function replay() {
  return { schemaVersion: 1, matchId: 'a'.repeat(64), samplingVersion: '8hz-v1', source: 'native-final-tick-observation',
    tickRate: 64, hz: 8, maxInterpolationTicks: 16, players: ['76561198000000001', '76561198000000002'], excludedRounds: [3],
    rounds: [{ round: 1, startTick: 0, endTick: 40, freezeEndTick: 8, frames: [
      { requestedTick: 8, players: [
        { playerId: '76561198000000001', actualTick: 7, position: [1.23456789012345, -495.00000000000006, 9007199254740991],
          yaw: -0.0000000000000001, health: 0, alive: false, side: 'CT', segment: null, stateAmbiguous: false,
          additional: { fields: ['position', 'yaw'], missing: null, flags: [false, true, 0] } },
        { actualTick: null, playerId: '76561198000000002', position: null, yaw: null, alive: null,
          side: 'Unknown', segment: 5, stateAmbiguous: true },
      ], futureFrameField: false },
      { requestedTick: 16, players: [
        { playerId: '76561198000000001', actualTick: 16, position: [1.23456789012345, -495.00000000000006, 9007199254740991],
          yaw: 360, health: 100, alive: true, side: 'T', segment: 6, stateAmbiguous: false,
          additional: { fields: ['position', 'yaw'], missing: null, flags: [false, true, 0] } },
      ] },
    ], events: [{ eventIndex: 9, event: { type: 'bomb', tick: 9, action: 'planted', player: '76561198000000001' } }],
      lifecycle: [{ type: 'spawn', tick: 8, player: '76561198000000001' }],
      coverage: { requestedFrames: 10, missingPlayerSamples: 2, status: 'partial' },
      utilities: [{ eventIndex: 12, tick: 1, endTick: 32, variant: null, flight: { startTick: 1, endTick: 12,
        points: [[1, 0.12345678901234568, -2, 3], [12, 4, 5, 6]] } }],
      blinds: [{ victimId: '76561198000000002', attackerId: null, startTick: 7, endTick: 16 }],
      burns: [{ victimId: '76561198000000001', startTick: 9, endTick: 33 }], futureRoundField: { order: ['a', 'b'] } }],
    futureSourceField: { precise: 1.0000000000000002 } };
}

test('tuple codec strictly preserves full canonical Replay, exact Number values, optional keys and order', () => {
  const encoded = canonicalRoundTrip(replay());
  assert.equal(encoded.encoding, STORED_REPLAY_ENCODING);
  assert.equal(encoded.schemas.length, 2);
  assert.equal(encoded.source.rounds[0].frames[0].players[0][1], '76561198000000001');
  const restored = decodeStoredReplay(encoded);
  assert.equal(Object.hasOwn(restored.rounds[0].frames[0].players[1], 'health'), false);
  assert.equal(restored.rounds[0].frames[0].players[0].alive, false);
  assert.equal(restored.rounds[0].frames[0].players[1].alive, null);
});

test('null and empty Replay have explicit envelopes and lossless round trips', () => {
  assert.deepEqual(canonicalRoundTrip(null), { encoding: STORED_REPLAY_ENCODING, schemas: [], source: null });
  const source = replay(); source.rounds = [];
  canonicalRoundTrip(source);
  source.rounds = [{ frames: [], events: [], lifecycle: [] }];
  canonicalRoundTrip(source);
});

test('schema identity includes original property order and every optional key', () => {
  const source = replay(), rows = source.rounds[0].frames[0].players;
  rows[0] = { playerId: '76561198000000001', nullable: null, falsy: false };
  rows[1] = { nullable: null, playerId: '76561198000000002', falsy: false };
  source.rounds[0].frames[1].players = [{ playerId: '76561198000000001', falsy: false }];
  const packed = canonicalRoundTrip(source);
  assert.equal(packed.schemas.length, 3);
});

test('malformed envelope, duplicate/unsafe schemas, references, arity and unused schemas fail closed', () => {
  const valid = encodeStoredReplay(replay());
  for (const mutate of [
    value => { value.encoding = 'replay-tuples-v2'; },
    value => { value.unknown = true; },
    value => { delete value.source; },
    value => { value.schemas[0][0] = '__proto__'; },
    value => { value.schemas[0][0] = 'constructor'; },
    value => { value.schemas[0][0] = 'prototype'; },
    value => { value.schemas[0][0] = ''; },
    value => { value.schemas[0][1] = value.schemas[0][0]; },
    value => { value.schemas.push(value.schemas[0]); },
    value => { value.schemas.push(['unused']); },
    value => { value.source.rounds[0].frames[0].players[0][0] = -1; },
    value => { value.source.rounds[0].frames[0].players[0][0] = 1.5; },
    value => { value.source.rounds[0].frames[0].players[0][0] = '0'; },
    value => { value.source.rounds[0].frames[0].players[0][0] = 100; },
    value => { value.source.rounds[0].frames[0].players[0].pop(); },
    value => { value.source.rounds[0].frames[0].players[0].push(null); },
    value => { value.source.rounds[0].frames[0].players[0] = {}; },
  ]) {
    const copy = structuredClone(valid); mutate(copy);
    assert.throws(() => decodeStoredReplay(copy), /Invalid stored Replay/);
  }
  assert.equal({}.polluted, undefined);
});

test('unsafe keys, non-JSON values, cycles and custom instances cannot silently lose data', () => {
  for (const value of [undefined, NaN, Infinity, 1n, () => 1, Symbol('x'), new Date(), new Map(),
    JSON.parse('{"__proto__":{"polluted":true}}')]) {
    const source = replay(); source.rounds[0].frames[0].players[0].extension = value;
    assert.throws(() => encodeStoredReplay(source), /Invalid stored Replay/);
  }
  const source = replay(), cycle = {}; cycle.self = cycle;
  source.rounds[0].frames[0].players[0].extension = cycle;
  assert.throws(() => encodeStoredReplay(source), /nesting budget or cycle/);
  const sparse = replay(); sparse.rounds[0].frames[0].players[0].extension = Array(2);
  assert.throws(() => encodeStoredReplay(sparse), /Invalid stored Replay/);
});

test('structural budgets reject excessive rounds, frames, players, fields and schemas', () => {
  for (const mutate of [
    value => { value.source.rounds = Array(1025).fill({ frames: [] }); },
    value => { value.source.rounds[0].frames = Array(60001).fill({ players: [] }); },
    value => { value.source.players = Array(65).fill('player'); },
    value => { value.source.rounds[0].frames[0].players = Array(65).fill([0]); },
    value => { value.schemas = Array(4097).fill(['playerId']); },
    value => { value.schemas[0] = Array.from({ length: 129 }, (_, index) => `key${index}`); },
  ]) {
    const copy = encodeStoredReplay(replay()); mutate(copy);
    assert.throws(() => decodeStoredReplay(copy), /Invalid stored Replay/);
  }
});
