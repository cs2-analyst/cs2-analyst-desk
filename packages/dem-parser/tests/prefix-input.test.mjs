import assert from 'node:assert/strict';
import test from 'node:test';
import { boundLocalEvidenceInput } from '../dist/local-evidence.js';

const base = () => ({ id: 'a'.repeat(64), header: { map_name: 'de_test' }, events: [], stateRows: [] });

test('bounded input retains chronological prefix and never splits a tick group', () => {
  const input = base();
  input.events = [...Array.from({ length: 19999 }, (_, i) => ({ tick: i })),
    { tick: 19999 }, { tick: 19999 }, { tick: 30000 }].reverse();
  const bounded = boundLocalEvidenceInput(input);
  assert.equal(bounded.truncated, true);
  assert.equal(bounded.events.length, 19999);
  assert.ok(bounded.events.every(event => event.tick < 19999));
  assert.equal(boundLocalEvidenceInput(bounded).truncated, true);
});

test('state budget bounds both arrays at the same tick and malformed rows fail closed', () => {
  const input = base();input.events = [{ tick: 3 }, { tick: 5000 }];
  input.stateRows = Array.from({ length: 4097 }, (_, tick) => ({ tick }));
  const bounded = boundLocalEvidenceInput(input);
  assert.deepEqual(bounded.events, [{ tick: 3 }]);
  assert.equal(bounded.stateRows.length, 4096);
  assert.throws(() => boundLocalEvidenceInput({ ...input, events: [{ tick: null }] }), /unlocatable/);
});
