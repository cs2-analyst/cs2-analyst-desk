import assert from 'node:assert/strict';
import test from 'node:test';
import { isDesktopSpatialFacts } from '../../../packages/report-contract/dist/index.js';

const ids = ['76561198000000001', '76561198000000002'];
const ref = digit => `native-exact:${digit.repeat(64)}`;
function facts() {
  return { schemaVersion: 1, methodVersion: 'dem-native-spatial-facts-v1', matchId: 'match',
    informationScope: 'server-global', status: 'available', reason: null,
    coverage: { deathTicks: 1, inspectedTicks: 1, eventProbes: 1, eventCards: 1,
      formationProbes: 0, formationCards: 0, withheld: 0, truncated: false },
    cards: [{ kind: 'event-prestate', round: 1, eventTick: 40, sampleTick: 39, eventIndex: 7,
      retrospectiveSelection: true,
      participants: [{ role: 'killer', playerId: ids[0], side: 'CT',
        position: { x: 0, y: 0, z: 0 }, rowRef: ref('a') },
      { role: 'victim', playerId: ids[1], side: 'T',
        position: { x: 3, y: 4, z: 12 }, rowRef: ref('b') }],
      horizontal: 5, threeDimensional: 13, unit: 'DEM-world-unit' }] };
}

test('bounded server facts accept only exact, internally consistent archive data', () => {
  assert.equal(isDesktopSpatialFacts(facts(), 'match', ids), true);
  for (const mutate of [
    value => { value.rawPath = 'private'; },
    value => { value.matchId = 'different'; },
    value => { value.cards[0].sampleTick = 38; },
    value => { value.cards[0].participants[0].playerId = 'unknown'; },
    value => { value.cards[0].participants[1].side = 'CT'; },
    value => { value.cards[0].participants[0].rowRef = 'bad'; },
    value => { value.cards[0].participants[0].position.x = NaN; },
    value => { value.cards[0].horizontal = 6; },
    value => { value.cards[0].threeDimensional = 12; },
    value => { value.coverage.eventCards = 0; },
    value => { value.status = 'available';value.coverage.withheld = 1; },
    value => { value.cards = Array.from({ length: 33 }, () => value.cards[0]); },
  ]) {
    const invalid = facts();mutate(invalid);
    assert.equal(isDesktopSpatialFacts(invalid, 'match', ids), false);
  }
});

test('unavailable facts are explicit and do not invent zero-distance cards', () => {
  const unavailable = { schemaVersion: 1, methodVersion: 'dem-native-spatial-facts-v1',
    matchId: 'match', informationScope: 'server-global', status: 'unavailable', reason: 'extraction-failed',
    coverage: { deathTicks: 0, inspectedTicks: 0, eventProbes: 0, eventCards: 0,
      formationProbes: 0, formationCards: 0, withheld: 0, truncated: false }, cards: [] };
  assert.equal(isDesktopSpatialFacts(unavailable, 'match', ids), true);
  unavailable.reason = null;
  assert.equal(isDesktopSpatialFacts(unavailable, 'match', ids), false);
});
