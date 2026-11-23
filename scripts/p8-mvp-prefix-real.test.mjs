import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Demoparser2Provider } from '../packages/dem-parser/dist/index.js';
import { buildDesktopSpatialFacts } from '../apps/desktop/electron/spatial-facts.ts';

const file = fileURLToPath(new URL('../.demo/dust2.dem', import.meta.url));
const sha = 'db90fe85aab023a1d2c8a5996182e6120d98ef494f02a070b17982b235e4958c';

test('real Dust2 historical cards resist future perturbation and react to changed exact rows', async () => {
  let innerError, compared = false, queryAfter, first;
  const parsed = await new Demoparser2Provider().parseWithReplay(file, undefined, async access => {
    try {
      assert.deepEqual(Object.keys(access.rawInput.header), ['map_name']);
      assert.equal(Object.hasOwn(access.rawInput, 'players'), false);
      const base = await buildDesktopSpatialFacts(access);
      first = base.cards.find(card => card.kind === 'event-prestate');
      assert.ok(first);
      const cut = first.eventTick + 1;
      const future = { ...access.rawInput,
        events: [...access.rawInput.events, ...Array.from({ length: 50 }, (_, index) => ({
          event_name: 'player_death', tick: cut + index, total_rounds_played: 99,
          user_steamid: '987654321', user_team_num: 2 })),
          ...Array.from({ length: 20001 }, (_, index) => ({ event_name: 'weapon_fire', tick: cut + 10000000 + index }))],
        stateRows: [...access.rawInput.stateRows, { tick: cut + 1, steamid: '987654321',
          team_num: 2, is_alive: true }] };
      const changedFuture = await buildDesktopSpatialFacts({ ...access, rawInput: future });
      assert.deepEqual(changedFuture.cards.filter(card => card.eventTick < cut),
        base.cards.filter(card => card.eventTick < cut));
      const changedHistory = await buildDesktopSpatialFacts({ ...access,
        queryExactTicks(ticks, players) {
          return access.queryExactTicks(ticks, players).map(row =>
            row.tick === first.sampleTick && row.steamid === first.participants[0].playerId
              ? { ...row, X: row.X + 100 } : row);
        } });
      assert.notDeepEqual(changedHistory.cards.find(card => card.kind === 'event-prestate'
        && card.eventTick === first.eventTick), first);
      assert.throws(() => access.queryExactTicks([], []), /invalid-local-evidence-query/);
      assert.throws(() => access.queryExactTicks(Array.from({ length: 65 }, (_, i) => i),
        [first.participants[0].playerId]), /invalid-local-evidence-query/);
      queryAfter = access.queryExactTicks;compared = true;
    } catch (error) { innerError = error; }
  });
  assert.ifError(innerError);
  assert.equal(parsed.match.id, sha);
  assert.equal(compared, true);
  assert.throws(() => queryAfter([first.sampleTick], [first.participants[0].playerId]),
    /invalid-local-evidence-query/);
});

test('a failed local evidence consumer cannot mutate the existing match, spatial or replay output', () => {
  const child = fileURLToPath(new URL('./p8-mvp-callback-child.mjs', import.meta.url));
  const run = mode => spawnSync(process.execPath, [child, mode],
    { encoding: 'utf8', timeout: 120000, maxBuffer: 1024 * 1024 });
  const baseline = run('baseline'), changed = run('mutate');
  assert.equal(baseline.error, undefined);assert.equal(changed.error, undefined);
  assert.equal(baseline.status, 0, baseline.stderr);assert.equal(changed.status, 0, changed.stderr);
  assert.match(baseline.stdout.trim(), /^[a-f0-9]{64}$/);
  assert.equal(changed.stdout, baseline.stdout);
});
