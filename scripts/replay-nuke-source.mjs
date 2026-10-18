import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { collectReplayDiagnosis } from '../packages/dem-parser/dev/replay-diagnosis.mjs';
import { ReplaySession } from '../apps/desktop/electron/replay-session.ts';
import { replayMapDefinitions } from '../apps/desktop/shared/replay-map-geometry.ts';
import { explainFrame } from './replay-diagnosis-core.mjs';

const out = resolve('.tmp/p7-nuke-s0'); mkdirSync(out, { recursive: true });
const source = await collectReplayDiagnosis(resolve('.demo/nuke.dem'));
assert.equal(source.summary.map, 'de_nuke');
const session = new ReplaySession(source.parsed.match, source.parsed.replay, 's0-source');
const metadata = session.metadata, map = replayMapDefinitions.find(m => m.id === metadata.map);
const counts = {}, candidates = [], rounds = [], chunks = [];
let intervals = 0, playerIntervals = 0, unknownAuto = 0, autoOpportunities = 0, parityFrames = 0;
for (const info of metadata.rounds) {
  const round = source.parsed.replay.rounds.find(r => r.round === info.round);
  const unique = new Map();
  for (const block of info.blocks) {
    const chunk = session.get({ sessionId: metadata.sessionId, round: info.round, block: block.index });
    chunks.push(chunk);
    for (const frame of chunk.frames) {
      const original = round.frames.find(f => f.requestedTick === frame.tick);
      assert.deepEqual(frame.players.map(p => p.slice(1, 5)), original.players.map(p => [p.actualTick, ...(p.position ?? [null, null, null])]));
      parityFrames++;
      unique.set(frame.tick, frame);
    }
  }
  const frames = [...unique.values()].sort((a, b) => a.tick - b.tick), roundCounts = {};
  for (let i = 0; i + 1 < frames.length; i++) {
    const left = frames[i], right = frames[i + 1], tick = (left.tick + right.tick) / 2;
    const chunk = chunks.find(c => c.round === info.round && tick >= c.startTick && Math.floor(tick) <= c.endTick);
    const explanation = explainFrame(chunk, tick, metadata, map, 0);
    intervals++;
    for (const p of explanation.players) {
      counts[p.interpolation] = (counts[p.interpolation] ?? 0) + 1;
      roundCounts[p.interpolation] = (roundCounts[p.interpolation] ?? 0) + 1;
      playerIntervals++;
      autoOpportunities++; if (p.sample[4] === null) unknownAuto++;
      const a = left.players.find(q => q[0] === p.sample[0]), b = right.players.find(q => q[0] === p.sample[0]);
      const kind = p.interpolation === 'floor-transition-or-unknown' ? 'cross-floor'
        : p.interpolation === 'native-row-missing' ? 'native-missing'
          : p.interpolation === 'not-alive' && a[7] === true && b[7] === false ? 'death' : null;
      if (kind && !candidates.some(c => c.kind === kind && c.round === info.round)) candidates.push({ kind, round: info.round,
        startTick: left.tick, endTick: right.tick, tick, playerId: p.id, playerIndex: p.sample[0],
        relativeSeconds: [(left.tick - info.startTick) / metadata.tickRate, (right.tick - info.startTick) / metadata.tickRate],
        left: a, right: b, explanation });
    }
  }
  rounds.push({ round: info.round, startTick: info.startTick, endTick: info.endTick, freezeEndTick: info.freezeEndTick, counts: roundCounts });
}
const chosen = [];
for (const kind of ['death', 'cross-floor', 'native-missing']) {
  const group = candidates.filter(c => c.kind === kind).sort((a, b) => kind === 'native-missing' ? (b.endTick - b.startTick) - (a.endTick - a.startTick) : a.round - b.round);
  chosen.push(...group.slice(0, kind === 'death' ? 2 : kind === 'cross-floor' ? 2 : 1));
}
const references = [];
for (const c of chosen) {
  const info = metadata.rounds.find(r => r.round === c.round);
  const from = Math.max(info.startTick, c.startTick - 16), to = Math.min(info.endTick, c.endTick + 64);
  const ticks = Array.from({ length: to - from + 1 }, (_, i) => from + i);
  const raw = await source.reference(ticks);
  c.reference = { from, to, requestedTicks: ticks.length, expectedRows: ticks.length * metadata.players.length, returnedRows: raw.length,
    selectedRows: raw.filter(r => r.steamid === c.playerId) };
  references.push(...raw);
}
const result = { schema: 'p7-s0-source-v1', ...source.summary, session: { bytes: session.bytes, chunks: session.chunks.size, parityFrames },
  midpointAudit: { intervals, playerIntervals, counts, autoFloorUnknown: unknownAuto, autoFloorOpportunities: autoOpportunities,
    scope: 'One midpoint per adjacent Replay sample interval, each roster player as hypothetical auto target; equal interval count, not time-weighted/all ticks' },
  rounds, windows: chosen };
writeFileSync(resolve(out, 'source.json'), JSON.stringify(result, null, 2) + '\n');
writeFileSync(resolve(out, 'chunks.json'), JSON.stringify({ metadata, chunks }));
writeFileSync(resolve(out, 'reference-raw.json'), JSON.stringify(references));
console.log(JSON.stringify({ ...source.summary, players: metadata.players, midpointAudit: result.midpointAudit,
  windows: chosen.map(({ reference, explanation, ...c }) => c) }, null, 2));
