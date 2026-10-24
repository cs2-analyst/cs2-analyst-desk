import { createHash } from 'node:crypto';
import type { MatchReplay, ReplayRound } from '@cs2-analyst/match-model';
import type { DesktopReplayBomb, DesktopReplayChunk, DesktopReplayFrame, DesktopReplayMetadata, DesktopReplayPlayer, DesktopReplayRequest } from '@cs2-analyst/report-contract';

// This is a storage decoder. Its semantics are frozen; changes require a new encoding.
// Text, names, floors, effects, follow context and subdivision decisions are saved data.
export const DERIVED_REPLAY_ENCODING = 'replay-projection-v1' as const;
const MiB = 1024 * 1024;
export const DERIVED_REPLAY_CACHE_BYTES = 3 * MiB;
const sessionPlaceholder = '00000000-0000-0000-0000-000000000000';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const storedJson = (value: unknown) => JSON.stringify(value, (key, value) => key === 'sessionId' ? undefined : value);
type Template = Omit<DesktopReplayChunk, 'frames' | 'follow' | 'sessionId'> & { frames: null; follow?: null };
export interface ReplayProjection {
  encoding: typeof DERIVED_REPLAY_ENCODING; round: number;
  follow: DesktopReplayChunk['follow'] | null;
  blocks: { template: Template; rawBytes: number; sha256: string }[];
}

export function createReplayProjections(chunks: ReadonlyMap<string, string>): Map<number, ReplayProjection> {
  const result = new Map<number, ReplayProjection>();
  for (const [key, json] of chunks) {
    const chunk = JSON.parse(json) as DesktopReplayChunk;
    if (key !== `${chunk.round}:${chunk.block}`) throw new Error('Replay projection key mismatch');
    let projection = result.get(chunk.round);
    if (!projection) {
      projection = { encoding: DERIVED_REPLAY_ENCODING, round: chunk.round, follow: chunk.follow ?? null, blocks: [] };
      result.set(chunk.round, projection);
    }
    if (JSON.stringify(projection.follow) !== JSON.stringify(chunk.follow ?? null)) throw new Error('Replay follow differs within round');
    const { sessionId: _sessionId, ...template } = chunk;
    const raw = storedJson(chunk);
    projection.blocks.push({ template: { ...template, frames: null, ...(chunk.follow !== undefined ? { follow: null } : {}) } as Template,
      rawBytes: Buffer.byteLength(raw), sha256: hash(raw) });
  }
  return result;
}

/** Exact v1 guard selection and bomb state, evaluated only for the requested block. */
function blockFrames(round: ReplayRound, replay: MatchReplay, start: number, end: number): DesktopReplayFrame[] {
  let first = round.frames.findIndex(frame => frame.requestedTick >= start);
  if (first < 0) first = round.frames.length - 1;
  if (first > 0 && round.frames[first].requestedTick > start) first--;
  let last = first;
  while (last + 1 < round.frames.length && round.frames[last + 1].requestedTick <= end) last++;
  if (last + 1 < round.frames.length) last++;
  const empty = (): DesktopReplayBomb => ({ action: 'unknown', carrierId: null, position: null, positionSource: null, ambiguous: false });
  let bomb = empty(), cursor = 0;
  const events = round.events.map(e => e.event).filter(e => e.type === 'bomb').sort((a, b) => a.tick - b.tick);
  return round.frames.slice(first, last + 1).map(frame => {
    while (cursor < events.length && events[cursor].tick <= frame.requestedTick) {
      const tick = events[cursor].tick, group = [];
      while (cursor < events.length && events[cursor].tick === tick) group.push(events[cursor++]);
      if (group.length !== 1) { bomb = { ...empty(), ambiguous: true }; continue; }
      const event = group[0], associated = round.frames.find(f => f.requestedTick === event.tick)?.players.find(p => p.playerId === event.player);
      const position = associated?.actualTick === event.tick ? associated.position : null;
      if (event.action === 'pickup' || event.action === 'plant_start') bomb = { action: event.action, carrierId: event.player, position: null, positionSource: null, ambiguous: false };
      else if (event.action === 'planted' || event.action === 'drop') bomb = { action: event.action, carrierId: null, position, positionSource: position ? 'actor-at-event' : null, ambiguous: false };
      else bomb = { ...bomb, action: event.action, carrierId: null };
    }
    let current = { ...bomb };
    if (current.carrierId) {
      const carrier = frame.players.find(p => p.playerId === current.carrierId);
      current = { ...current, position: carrier?.actualTick === frame.requestedTick && carrier.alive === true ? carrier.position : null, positionSource: 'carrier-sample' };
    }
    const players: DesktopReplayPlayer[] = frame.players.map(p => [replay.players.indexOf(p.playerId), p.actualTick,
      p.position?.[0] ?? null, p.position?.[1] ?? null, p.position?.[2] ?? null, p.yaw, p.health, p.alive, p.side, p.segment, p.stateAmbiguous]);
    return { tick: frame.requestedTick, players, bomb: current };
  });
}

export function validateReplayProjection(value: unknown, metadata: DesktopReplayMetadata, roundNumber: number): asserts value is ReplayProjection {
  const p = value as ReplayProjection;
  const round = metadata.rounds.find(r => r.round === roundNumber);
  if (!p || p.encoding !== DERIVED_REPLAY_ENCODING || p.round !== roundNumber || !round || !Array.isArray(p.blocks)
    || p.blocks.length !== round.blocks.length || Object.keys(p).sort().join() !== 'blocks,encoding,follow,round') throw new Error('Invalid replay projection');
  for (let i = 0; i < p.blocks.length; i++) {
    const b = p.blocks[i], t = b?.template, info = round.blocks[i];
    if (!b || Object.keys(b).sort().join() !== 'rawBytes,sha256,template' || !t || t.schemaVersion !== 1 || t.matchId !== metadata.matchId
      || t.round !== p.round || t.block !== info.index || t.startTick !== info.startTick || t.endTick !== info.endTick
      || t.frames !== null || Object.hasOwn(t, 'sessionId') || (Object.hasOwn(t, 'follow') && (t.follow !== null || !p.follow))
      || !Array.isArray(t.events) || !Number.isSafeInteger(b.rawBytes) || b.rawBytes < 1 || b.rawBytes + 51 > MiB
      || typeof b.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(b.sha256)) throw new Error('Invalid replay projection block');
  }
}

export function restoreProjectedChunk(replay: MatchReplay, projection: ReplayProjection, block: number, sessionId: string,
  onSerialized?: (json: string) => void): DesktopReplayChunk {
  const entry = projection.blocks.find(b => b.template.block === block), round = replay.rounds.find(r => r.round === projection.round);
  if (!entry || !round) throw new Error('Missing replay projection source');
  const template = entry.template;
  const chunk = { ...template, frames: blockFrames(round, replay, template.startTick, template.endTick),
    ...(Object.hasOwn(template, 'follow') ? { follow: projection.follow! } : {}) };
  // Stored templates contain no session handles. A generic JSON replacer visits every
  // player tuple element and needlessly repeats that work on every cache miss.
  const raw = JSON.stringify(chunk);
  if (Buffer.byteLength(raw) !== entry.rawBytes || hash(raw) !== entry.sha256) throw new Error('Regenerated replay digest mismatch');
  const json = raw.slice(0, -1) + ',"sessionId":' + JSON.stringify(sessionId) + '}';
  if (Buffer.byteLength(json) > MiB) throw new Error('Regenerated replay IPC budget');
  onSerialized?.(json);
  return { ...chunk, sessionId } as DesktopReplayChunk;
}

/** Session-owned byte-counted LRU. At most one miss runs; stale queued seeks are discarded. */
export class DerivedReplaySession {
  readonly metadata: DesktopReplayMetadata;
  private replay: MatchReplay | null;
  private loader: ((round: number) => Promise<ReplayProjection>) | null;
  private cache = new Map<string, string>();
  private sequence = 0;
  private pending: Promise<unknown> = Promise.resolve();
  bytes = 0;
  constructor(replay: MatchReplay, metadata: DesktopReplayMetadata, loader: (round: number) => Promise<ReplayProjection>) {
    this.replay = replay; this.metadata = metadata; this.loader = loader;
  }
  async get(request: DesktopReplayRequest): Promise<DesktopReplayChunk | null> {
    if (!this.replay || request.sessionId !== this.metadata.sessionId
      || !this.metadata.rounds.some(r => r.round === request.round && r.blocks.some(b => b.index === request.block))) return null;
    const sequence = ++this.sequence, key = `${request.round}:${request.block}`;
    const cached = this.cache.get(key);
    if (cached) { this.cache.delete(key); this.cache.set(key, cached); return JSON.parse(cached); }
    const run = this.pending.then(async () => {
      if (sequence !== this.sequence || !this.loader || !this.replay) return null;
      const projection = await this.loader(request.round);
      if (sequence !== this.sequence || !this.replay) return null;
      validateReplayProjection(projection, this.metadata, request.round);
      let json = '';
      const chunk = restoreProjectedChunk(this.replay, projection, request.block, this.metadata.sessionId ?? sessionPlaceholder, value => { json = value; });
      const size = Buffer.byteLength(json);
      while (this.bytes + size > DERIVED_REPLAY_CACHE_BYTES && this.cache.size) {
        const oldest = this.cache.keys().next().value!;
        this.bytes -= Buffer.byteLength(this.cache.get(oldest)!); this.cache.delete(oldest);
      }
      this.cache.set(key, json); this.bytes += size;
      return chunk;
    });
    // The serialisation tail must not retain the last parsed chunk outside the LRU.
    this.pending = run.then(() => undefined, () => undefined);
    return run;
  }
  clear() { ++this.sequence; this.cache.clear(); this.bytes = 0; this.replay = null; this.loader = null; }
}
