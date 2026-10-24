import { createHash, randomUUID } from 'node:crypto';
import { fixture, map, sample } from './heatmap-fixture.mjs';
import { ReplaySession } from '../electron/replay-session.ts';
import { createHeatmapSession } from '../electron/heatmap-session.ts';

export function optimizationInput(version = 2) {
  const f = fixture(), id = createHash('sha256').update('storage optimization fixture').digest('hex');
  f.match.id = id; f.replay.matchId = id; f.spatial.matchId = id;
  const rr = f.replay.rounds[0]; rr.endTick = 5500;
  f.match.rounds[0].endTick = rr.endTick;
  rr.frames = Array.from({ length: 688 }, (_, i) => ({ requestedTick: i * 8,
    players: [sample('1', { actualTick: i * 8, position: [10.1234567890123 + i, 20, 0] }), sample('2', { actualTick: i * 8, side: 'T', alive: i < 150 })] }));
  rr.events.push(...[{ type: 'bomb', action: 'pickup', tick: 0, player: '1' },
    { type: 'bomb', action: 'drop', tick: 1248, player: '1' }, { type: 'bomb', action: 'planted', tick: 2600, player: '1' }]
    .map((event, i) => ({ eventIndex: 10 + i, event })));
  rr.utilities = [{ eventIndex: 33, kind: 'smoke', variant: null, throwerId: '1', entityId: 1,
    tick: 1272, endTick: 4000, endSource: 'observed', position: [20, 30, 0],
    flight: { startTick: 1200, endTick: 1272, points: [[1200, 1, 2, 3], [1272, 20, 30, 0]] } }];
  rr.blinds = [{ eventIndex: 34, playerId: '2', attackerId: '1', startTick: 1272, endTick: 1320, duration: .75 }];
  rr.burns = [{ playerId: '2', startTick: 2500, endTick: 2800 }];
  f.match.players.forEach((p, i) => { p.nickname = `玩家 ${i}`; });
  const sessionId = randomUUID(), replaySession = new ReplaySession(f.match, f.replay, sessionId);
  const heatmap = createHeatmapSession(f.match, f.replay, f.spatial, sessionId, { map });
  const report = { schemaVersion: 2, match: { id, fileName: 'dust2.dem', map: f.match.map, rounds: f.match.rounds.length, score: null },
    selectedPlayer: '1', players: f.match.players.map(p => ({ id: p.steamId, nickname: p.nickname })), analytics: [], findings: [], timeline: [],
    analysis: { players: [], perPlayer: [] }, deepReview: { available: true, players: [] }, replay: replaySession.metadata, heatmap: heatmap.metadata };
  heatmap.session?.clear();
  return { ...f, report, chunks: replaySession.chunks, versions: { application: '0.2.0', archive: version, report: 2, replay: 1,
    analysis: 'test', parser: 'test', native: 'test', sampling: 'test', mapResource: 'test', sourceRevision: 'a'.repeat(40) } };
}
