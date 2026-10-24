import assert from 'node:assert/strict';
import test from 'node:test';
import { playerSelectGroups } from '../renderer/src/player-select-groups.ts';

const player = id => ({ id, nickname: `Player ${id}` });
const values = group => group.items.map(item => item.value);

test('opening groups stay distinct after equal CT/T halves and ignore timeline ordering', () => {
  const players = [player('t'), player('ct'), player('ct2')];
  const timeline = players.map(p => ({ playerId: p.id, rounds: Array.from({ length: 24 }, (_, index) => ({
    round: index + 1, side: (index < 12) === p.id.startsWith('ct') ? 'CT' : 'T',
  })).reverse() }));
  const groups = playerSelectGroups({ players, timeline });
  assert.deepEqual(groups.map(group => group.label), ['开局CT', '开局T']);
  assert.deepEqual(groups.map(values), [['ct', 'ct2'], ['t']]);
  assert.deepEqual(groups[0].items[0], { value: 'ct', text: 'Player ct' });
});

test('later majority never overrides the opening side', () => {
  const groups = playerSelectGroups({ players: [player('a')], timeline: [{ playerId: 'a', rounds: [
    { round: 1, side: 'T' }, ...Array.from({ length: 20 }, (_, i) => ({ round: i + 2, side: 'CT' })),
  ] }] });
  assert.equal(groups[0].label, '开局T');
  assert.deepEqual(groups.map(values), [['a']]);
});

test('unknown or missing opening evidence keeps every player selectable without guessing from later rounds', () => {
  const players = ['unknown', 'missing-r1', 'empty', 'missing-timeline'].map(player);
  const timeline = [
    { playerId: 'unknown', rounds: [{ round: 1, side: 'Unknown' }, { round: 2, side: 'CT' }] },
    { playerId: 'missing-r1', rounds: [{ round: 13, side: 'T' }] },
    { playerId: 'empty', rounds: [] },
  ];
  const groups = playerSelectGroups({ players, timeline });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].label, undefined);
  assert.deepEqual(values(groups[0]), players.map(p => p.id));
  assert.deepEqual(playerSelectGroups({ players: [], timeline: [] }), []);
});
