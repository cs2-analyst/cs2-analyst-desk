import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import native from '../packages/demoparser-native/index.cjs';
import { Demoparser2Provider } from '../packages/dem-parser/dist/index.js';
import { isDesktopSpatialFacts } from '../packages/report-contract/dist/index.js';
import { buildDesktopSpatialFacts } from '../apps/desktop/electron/spatial-facts.ts';

const manifest = JSON.parse(readFileSync(new URL('../docs/p8-mvp-eight-map-fixtures.json', import.meta.url), 'utf8'));
const record = manifest.records.find(item => item.file === process.argv[2]);
if (!record || !/^[a-z0-9]+\.dem$/.test(record.file)) throw new Error('fixture-not-allowed');
const file = fileURLToPath(new URL(`../.demo/${record.file}`, import.meta.url));
let facts;
const started = performance.now();
const parsed = await new Demoparser2Provider().parseWithReplay(file, undefined, async access => {
  facts = await buildDesktopSpatialFacts(access);
});
assert.equal(parsed.match.id, record.sha256);
assert.equal(parsed.match.map, record.map);
assert.ok(facts && isDesktopSpatialFacts(facts, parsed.match.id, parsed.match.players.map(player => player.steamId)));
assert.ok(facts.coverage.eventCards >= 1, 'no valid event fact');
const event = facts.cards.find(card => card.kind === 'event-prestate');
const rows = native.parseTicks(readFileSync(file), ['X', 'Y', 'Z', 'is_alive', 'team_num'],
  [event.sampleTick], event.participants.map(player => player.playerId));
for (const participant of event.participants) {
  const exact = rows.filter(row => row.tick === event.sampleTick && row.steamid === participant.playerId);
  assert.equal(exact.length, 1);
  assert.equal(exact[0].is_alive, true);
  assert.deepEqual(participant.position, { x: exact[0].X, y: exact[0].Y, z: exact[0].Z });
}
process.stdout.write(`${JSON.stringify({ file: record.file, map: record.map, status: facts.status,
  coverage: facts.coverage, durationMs: Math.round(performance.now() - started) })}\n`);
