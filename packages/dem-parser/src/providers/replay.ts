import type {
  Match, MatchEvent, MatchReplay, ReplayBlindWindow, ReplayBurnWindow, ReplayEffectEndSource,
  ReplayPlayerSample, ReplayRound, ReplayTrajectoryPoint, ReplayUtilityEffect, ReplayUtilityFlight,
  ReplayUtilityKind, ReplayUtilityVariant,
} from '@cs2-analyst/match-model';

export const replayFields = ['X', 'Y', 'Z', 'yaw', 'health', 'is_alive', 'team_num'];
export const replaySamplingVersion = 'native-0.42.0-backport363-replay8-v1';
const validTick = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
export function planReplay(match: Match, maxTicks = 60_000) {
  if (!Number.isSafeInteger(maxTicks) || maxTicks < 0 || maxTicks > 60_000) throw new Error('Invalid replay tick budget');
  const playerCount=new Set(match.players.map(p=>p.steamId)).size;
  if(playerCount===0||playerCount>64)throw new Error('Replay player budget exceeded');
  const rate = match.tickRate;
  const step = rate !== undefined && Number.isSafeInteger(rate) && rate >= 8 && rate % 8 === 0 ? rate / 8 : null;
  const ticks = new Set<number>(), excludedRounds: number[] = [];
  const add = (tick: number) => {
    ticks.add(tick);
    if(ticks.size>maxTicks)throw new Error('Replay tick budget exceeded');
    if(ticks.size*playerCount>600_000)throw new Error('Replay player sample budget exceeded');
  };
  const rounds: { round: Match['rounds'][number]; ticks: number[] }[] = [];
  let previousEnd = -1;
  for (const round of match.rounds) {
    const start = round.startTick, end = round.endTick;
    if (!validTick(start) || !validTick(end) || end < start || start <= previousEnd) { excludedRounds.push(round.number); continue; }
    previousEnd = end;
    const wanted = new Set<number>([start, end]);
    if (validTick(round.freezeEndTick) && round.freezeEndTick >= start && round.freezeEndTick <= end) wanted.add(round.freezeEndTick);
    for (const e of [...round.events, ...(round.playerLifecycle ?? [])]) if (validTick(e.tick) && e.tick >= start && e.tick <= end) wanted.add(e.tick);
    if (step !== null) for (let tick = start; tick <= end; tick += step) { wanted.add(tick); add(tick); }
    for (const tick of wanted) add(tick);
    rounds.push({ round, ticks: [...wanted].sort((a, b) => a - b) });
  }
  return { step, ticks: [...ticks].sort((a, b) => a - b), rounds, excludedRounds };
}
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
type Row = Record<string, unknown>;

/**
 * Additive native evidence. Projectiles come from one parseGrenades(bytes, [], false) query;
 * expiries reuse the existing event query. Both stay inside the adapter/parser boundary.
 */
export interface ReplayEffectInput {
  /** Raw demoparser2 projectile rows (`grenade_entity_id`, `grenade_type`, `tick`, `x/y/z`). */
  projectiles?: unknown;
  /** Raw inferno_expire / smokegrenade_expired event rows. */
  expiries?: unknown;
}

const projectileKinds = new Map<string, ReplayUtilityKind>([
  ['CSmokeGrenadeProjectile', 'smoke'],
  ['CFlashbangProjectile', 'flashbang'],
  ['CHEGrenadeProjectile', 'hegrenade'],
  ['CMolotovProjectile', 'fire'],
  ['CDecoyProjectile', 'decoy'],
]);
const utilityWeapons: Record<ReplayUtilityKind, Set<string>> = {
  smoke: new Set(['weapon_smokegrenade']),
  flashbang: new Set(['weapon_flashbang']),
  hegrenade: new Set(['weapon_hegrenade']),
  fire: new Set(['weapon_molotov', 'weapon_incgrenade']),
  decoy: new Set(['weapon_decoy']),
};
const assumedTickRate = 64;
const nominalSeconds: Partial<Record<ReplayUtilityKind, number>> = { smoke: 20, fire: 7 };
const instantSeconds: Partial<Record<ReplayUtilityKind, number>> = { flashbang: 0.5, hegrenade: 1 };

interface ProjectileRow { tick: number; x: number; y: number; z: number }
interface ProjectileRun { entityId: number; kind: ReplayUtilityKind; steamId: string | null; first: number; last: number; rows: ProjectileRow[] }
interface ExpiryRow { entityId: number; tick: number; kind: 'smoke' | 'fire' }
interface ThrowSample { tick: number; playerId: string; weapon: string }

/**
 * Native projectile rows use demo-local entity indices that are reused. Split one entity id
 * into contiguous, same-class runs so a later grenade can never lend its flight to an earlier
 * detonation (or vice versa).
 */
function buildProjectileRuns(raw: unknown): ProjectileRun[] {
  if (!Array.isArray(raw)) return [];
  const runs: ProjectileRun[] = [], current = new Map<number, ProjectileRun>();
  for (const value of raw) {
    if (!value || typeof value !== 'object') continue;
    const row = value as Row;
    const kind = projectileKinds.get(String(row.grenade_type));
    const entityId = row.grenade_entity_id, tick = row.tick;
    if (!kind || !Number.isSafeInteger(entityId) || (entityId as number) < 0
      || !Number.isSafeInteger(tick) || (tick as number) < 0
      || !finite(row.x) || !finite(row.y) || !finite(row.z)) continue;
    const id = entityId as number, at = tick as number;
    let run = current.get(id);
    // Native rows arrive in tick order; a class change or a >2 tick gap is a new projectile.
    if (!run || run.kind !== kind || at <= run.last || at > run.last + 2) {
      run = { entityId: id, kind, steamId: typeof row.steamid === 'string' ? row.steamid : null, first: at, last: at, rows: [] };
      runs.push(run); current.set(id, run);
    }
    run.last = at;
    run.rows.push({ tick: at, x: row.x, y: row.y, z: row.z });
  }
  return runs;
}
function groupRunsByThrower(runs: ProjectileRun[]): Map<string, ProjectileRun[]> {
  const grouped = new Map<string, ProjectileRun[]>();
  for (const run of runs) {
    if (!run.steamId) continue;
    const list = grouped.get(run.steamId) ?? [];
    list.push(run); grouped.set(run.steamId, list);
  }
  return grouped;
}
function groupRuns(runs: ProjectileRun[]): Map<number, ProjectileRun[]> {
  const grouped = new Map<number, ProjectileRun[]>();
  for (const run of runs) {
    const list = grouped.get(run.entityId) ?? [];
    list.push(run); grouped.set(run.entityId, list);
  }
  return grouped;
}
function buildExpiries(raw: unknown): ExpiryRow[] {
  if (!Array.isArray(raw)) return [];
  const out: ExpiryRow[] = [];
  for (const value of raw) {
    if (!value || typeof value !== 'object') continue;
    const row = value as Row;
    const kind = row.event_name === 'smokegrenade_expired' ? 'smoke'
      : row.event_name === 'inferno_expire' ? 'fire' : null;
    if (!kind || !Number.isSafeInteger(row.entityid) || (row.entityid as number) < 0
      || !Number.isSafeInteger(row.tick) || (row.tick as number) < 0) continue;
    out.push({ entityId: row.entityid as number, tick: row.tick as number, kind });
  }
  return out.sort((a, b) => a.tick - b.tick);
}
function groupExpiries(rows: ExpiryRow[]): Map<number, ExpiryRow[]> {
  const grouped = new Map<number, ExpiryRow[]>();
  for (const row of rows) {
    const list = grouped.get(row.entityId) ?? [];
    list.push(row); grouped.set(row.entityId, list);
  }
  return grouped;
}
function findRun(grouped: Map<number, ProjectileRun[]>, entityId: number, kind: ReplayUtilityKind,
  detonateTick: number, maxFlight: number): ProjectileRun | null {
  const candidates = grouped.get(entityId);
  if (!candidates) return null;
  let best: ProjectileRun | null = null;
  for (const run of candidates) {
    if (run.kind !== kind || run.first > detonateTick || detonateTick > run.last + 2
      || detonateTick - run.first > maxFlight) continue;
    if (!best || run.first > best.first) best = run;
  }
  return best;
}
function findRunByThrower(grouped: Map<string, ProjectileRun[]>, playerId: string, kind: ReplayUtilityKind,
  detonateTick: number, maxFlight: number): ProjectileRun | null {
  const candidates = grouped.get(playerId);
  if (!candidates) return null;
  let best: ProjectileRun | null = null, bestDistance = Infinity;
  for (const run of candidates) {
    if (run.kind !== kind || run.first > detonateTick || detonateTick - run.first > maxFlight) continue;
    const distance = detonateTick - run.last;
    const contains = run.first <= detonateTick && detonateTick <= run.last;
    if (!contains && Math.abs(distance) > 2) continue;
    const score = Math.abs(distance);
    if (score < bestDistance || (score === bestDistance && (!best || run.first > best.first))) {
      best = run; bestDistance = score;
    }
  }
  return best;
}
function findThrow(events: { eventIndex: number; event: MatchEvent }[],
  playerId: string, kind: ReplayUtilityKind, referenceTick: number, lookback: number): ThrowSample | null {
  const weapons = utilityWeapons[kind];
  let best: ThrowSample | null = null;
  for (const { event } of events) {
    if (event.type !== 'weapon_fire' || event.shooter !== playerId) continue;
    if (event.tick > referenceTick || referenceTick - event.tick > lookback || !weapons.has(event.weapon)) continue;
    if (!best || event.tick > best.tick) best = { tick: event.tick, playerId, weapon: event.weapon };
  }
  return best;
}
function flightPoints(run: ProjectileRun, detonateTick: number, throwSample: ThrowSample | null,
  frameAt: (tick: number) => ReplayRound['frames'][number] | null,
  detonatePosition: [number, number, number] | null, step: number): ReplayUtilityFlight | null {
  const end = Math.min(detonateTick, run.last);
  const rows = run.rows.filter(row => row.tick >= run.first && row.tick <= end);
  if (!rows.length) return null;
  const points: ReplayTrajectoryPoint[] = [];
  // The weapon_fire tick is the real throw instant; its player sample is a real observation.
  // It only anchors the start when the first projectile sample is later, never replaces samples.
  if (throwSample && throwSample.tick < rows[0].tick) {
    const sample = frameAt(throwSample.tick)?.players.find(player => player.playerId === throwSample.playerId);
    if (sample?.actualTick === throwSample.tick && sample.position) {
      points.push([throwSample.tick, sample.position[0], sample.position[1], sample.position[2]]);
    }
  }
  let lastAdded = -Infinity;
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    if (index === 0 || index === rows.length - 1 || row.tick - lastAdded >= step) {
      points.push([row.tick, row.x, row.y, row.z]); lastAdded = row.tick;
    }
  }
  if (detonatePosition && points.at(-1)?.[0] !== detonateTick) {
    points.push([detonateTick, detonatePosition[0], detonatePosition[1], detonatePosition[2]]);
  }
  points.sort((a, b) => a[0] - b[0]);
  const deduped: ReplayTrajectoryPoint[] = [];
  for (const point of points) {
    if (deduped.length && deduped.at(-1)![0] === point[0]) deduped[deduped.length - 1] = point;
    else deduped.push(point);
  }
  if (deduped.length < 2 || deduped.at(-1)![0] <= deduped[0][0]) return null;
  return { startTick: deduped[0][0], endTick: deduped.at(-1)![0], points: deduped };
}
function effectWindow(kind: ReplayUtilityKind, tick: number, roundEnd: number, entityId: number | null,
  expiries: Map<number, ExpiryRow[]>, tickRate: number | null): { endTick: number; endSource: ReplayEffectEndSource } {
  const instant = instantSeconds[kind];
  if (instant !== undefined) {
    const wanted = tick + Math.max(1, Math.round((tickRate ?? assumedTickRate) * instant));
    const endTick = Math.min(roundEnd, wanted);
    return { endTick, endSource: endTick === wanted ? 'nominal' : 'round-end' };
  }
  if (kind === 'decoy') return { endTick: tick, endSource: 'observed' };
  const maxObserved = kind === 'smoke' ? 30 : 12;
  const observed = entityId === null ? undefined
    : expiries.get(entityId)?.find(row => row.kind === kind && row.tick > tick
      && row.tick - tick <= Math.round((tickRate ?? assumedTickRate) * maxObserved));
  if (observed) {
    return observed.tick <= roundEnd
      ? { endTick: observed.tick, endSource: 'observed' }
      : { endTick: roundEnd, endSource: 'round-end' };
  }
  const seconds = nominalSeconds[kind];
  if (seconds === undefined) return { endTick: tick, endSource: 'nominal' };
  const wanted = tick + Math.max(1, Math.round((tickRate ?? assumedTickRate) * seconds));
  const endTick = Math.min(roundEnd, wanted);
  return { endTick, endSource: endTick === wanted ? 'nominal' : 'round-end' };
}
function buildUtilityEffects(events: { eventIndex: number; event: MatchEvent }[],
  frames: ReplayRound['frames'], startTick: number, endTick: number, groupedRuns: Map<number, ProjectileRun[]>,
  groupedByThrower: Map<string, ProjectileRun[]>, groupedExpiries: Map<number, ExpiryRow[]>,
  tickRate: number | null): ReplayUtilityEffect[] {
  const out: ReplayUtilityEffect[] = [];
  const frameByTick = new Map(frames.map(frame => [frame.requestedTick, frame]));
  const rate = tickRate ?? assumedTickRate;
  const step = Math.max(1, Math.round(rate / 16));
  const maxFlight = Math.max(64, Math.round(rate * 16));
  const lookback = Math.max(8, Math.round(rate));
  for (const { eventIndex, event } of events) {
    if (event.type !== 'utility' || event.tick < startTick || event.tick > endTick) continue;
    const kind = event.utility;
    const entityId = typeof event.entityId === 'number' && Number.isSafeInteger(event.entityId) ? event.entityId : null;
    // inferno_startburn reports the fire-effect entity, not the molotov projectile entity, so
    // fire flights are associated by their real thrower + throw window instead.
    const run = kind === 'fire'
      ? event.thrower === null ? null : findRunByThrower(groupedByThrower, event.thrower, kind, event.tick, maxFlight)
      : entityId === null ? null : findRun(groupedRuns, entityId, kind, event.tick, maxFlight);
    const throwerId = event.thrower ?? run?.steamId ?? null;
    const throwSample = throwerId === null ? null : findThrow(events, throwerId, kind, run?.first ?? event.tick, lookback);
    const position: [number, number, number] | null = event.position
      ? [event.position.x, event.position.y, event.position.z] : null;
    const flight = run ? flightPoints(run, event.tick, throwSample, tick => frameByTick.get(tick) ?? null, position, step) : null;
    const window = effectWindow(kind, event.tick, endTick, entityId, groupedExpiries, tickRate);
    const variant: ReplayUtilityVariant | null = kind === 'fire' && throwSample
      ? throwSample.weapon === 'weapon_incgrenade' ? 'incendiary'
        : throwSample.weapon === 'weapon_molotov' ? 'molotov' : null
      : null;
    out.push({ eventIndex, kind, variant, throwerId, entityId, tick: event.tick,
      endTick: window.endTick, endSource: window.endSource, position, flight });
  }
  return out;
}
function buildBlindWindows(events: { eventIndex: number; event: MatchEvent }[],
  roundEnd: number, tickRate: number | null): ReplayBlindWindow[] {
  if (tickRate === null) return [];
  const out: ReplayBlindWindow[] = [];
  for (const { event } of events) {
    if (event.type !== 'flash' || event.blindDurationSeconds <= 0) continue;
    const endTick = Math.min(roundEnd, event.tick + Math.max(1, Math.round(event.blindDurationSeconds * tickRate)));
    if (endTick > event.tick) out.push({ victimId: event.victim, attackerId: event.attacker, startTick: event.tick, endTick });
  }
  return out;
}
const burnWeapons = new Set(['inferno', 'molotov', 'incgrenade']);
function buildBurnWindows(events: { eventIndex: number; event: MatchEvent }[],
  roundEnd: number, tickRate: number | null): ReplayBurnWindow[] {
  const rate = tickRate ?? assumedTickRate;
  const tail = Math.max(1, Math.round(rate * 0.2));
  const mergeGap = Math.max(1, Math.round(rate * 0.5));
  const byVictim = new Map<string, number[]>();
  for (const { event } of events) {
    if (event.type !== 'damage' || !event.weapon || !burnWeapons.has(event.weapon)) continue;
    const ticks = byVictim.get(event.victim) ?? [];
    ticks.push(event.tick); byVictim.set(event.victim, ticks);
  }
  const out: ReplayBurnWindow[] = [];
  for (const [victimId, ticks] of byVictim) {
    ticks.sort((a, b) => a - b);
    let start = ticks[0], last = ticks[0];
    const flush = () => {
      const endTick = Math.min(roundEnd, last + tail);
      if (endTick > start) out.push({ victimId, startTick: start, endTick });
    };
    for (let index = 1; index < ticks.length; index++) {
      const tick = ticks[index];
      if (tick - last <= mergeGap) last = tick;
      else { flush(); start = tick; last = tick; }
    }
    flush();
  }
  return out.sort((a, b) => a.startTick - b.startTick || a.victimId.localeCompare(b.victimId));
}

export function buildReplay(match: Match, plan: ReturnType<typeof planReplay>, rawRows: unknown,
  effectInput?: ReplayEffectInput): MatchReplay {
  if (!Array.isArray(rawRows)) throw new Error('Replay rows are not an array');
  const ids = [...new Set(match.players.map(p => p.steamId))].sort();
  if (ids.length > 64) throw new Error('Replay player budget exceeded');
  const wanted = new Set(plan.ticks), rows = new Map<number, Map<string, Record<string, unknown>>>();
  for (const value of rawRows) {
    if (!value || typeof value !== 'object') continue;
    const row = value as Record<string, unknown>;
    if (!validTick(row.tick) || !wanted.has(row.tick) || typeof row.steamid !== 'string' || !ids.includes(row.steamid)) continue;
    let frame = rows.get(row.tick); if (!frame) { frame = new Map(); rows.set(row.tick, frame); }
    if (frame.has(row.steamid)) throw new Error('Duplicate replay player row');
    frame.set(row.steamid, row);
  }
  // One bounded pass over native projectile rows, independent of the player-sample budget.
  let groupedRuns = new Map<number, ProjectileRun[]>(), groupedByThrower = new Map<string, ProjectileRun[]>();
  let groupedExpiries = new Map<number, ExpiryRow[]>();
  try {
    const projectileRuns = buildProjectileRuns(effectInput?.projectiles);
    groupedRuns = groupRuns(projectileRuns);
    groupedByThrower = groupRunsByThrower(projectileRuns);
    groupedExpiries = groupExpiries(buildExpiries(effectInput?.expiries));
  } catch {
    groupedRuns = new Map(); groupedByThrower = new Map(); groupedExpiries = new Map();
  }
  const rounds: ReplayRound[] = [];
  const disconnectedPlayers = new Set<string>(), counters = new Map<string, number>();
  // Connection evidence survives round boundaries, including the unsampled post-round gap.
  const allLife = match.rounds.flatMap(r => r.playerLifecycle ?? []).filter(e => validTick(e.tick)).sort((a,b) => a.tick-b.tick);
  let lifeCursor = 0;
  for (const entry of plan.rounds) {
    const { round, ticks } = entry, start = round.startTick!, end = round.endTick!;
    const events = round.events.map((event, eventIndex) => ({ eventIndex, event })).filter(({ event }) => event.tick >= start && event.tick <= end);
    const lifecycle = (round.playerLifecycle ?? []).filter(e => e.tick >= start && e.tick <= end);
    const killsAt = new Map<number, Set<string>>();
    for (const { event } of events) if (event.type === 'kill') { const group = killsAt.get(event.tick) ?? new Set<string>(); group.add(event.victim); killsAt.set(event.tick, group); }
    const previous = new Map<string, { tick: number; sample: ReplayPlayerSample }>();
    const deadPlayers = new Set<string>(); let missingPlayerSamples = 0;
    const frames = ticks.map(requestedTick => {
      const consumedLife: typeof lifecycle = [];
      while (lifeCursor < allLife.length && allLife[lifeCursor].tick <= requestedTick) consumedLife.push(allLife[lifeCursor++]);
      // Resolve different ticks chronologically, same-tick transitions atomically.
      for (const tick of [...new Set(consumedLife.map(e => e.tick))]) for (const id of ids) {
        const group = consumedLife.filter(e => e.tick === tick && (e.player === id || e.player === null));
        const disconnected = group.some(e => e.type === 'disconnect' || (e.type === 'side_change' && e.disconnect));
        const spawned = group.some(e => e.type === 'spawn' && e.player === id);
        if (disconnected) disconnectedPlayers.add(id);
        else if (spawned) { disconnectedPlayers.delete(id); deadPlayers.delete(id); }
      }
      return { requestedTick, players: ids.map(playerId => {
      const row = rows.get(requestedTick)?.get(playerId);
      let position: [number, number, number] | null = row && finite(row.X) && finite(row.Y) && finite(row.Z) ? [row.X, row.Y, row.Z] : null;
      const yaw = row && finite(row.yaw) && Math.abs(row.yaw) <= 360 ? row.yaw : null;
      const health = row && finite(row.health) && Number.isSafeInteger(row.health) && row.health >= 0 ? row.health : null;
      const side = row?.team_num === 2 ? 'T' : row?.team_num === 3 ? 'CT' : 'Unknown';
      const atLife = consumedLife.filter(e => e.player === playerId || e.player === null);
      const atTickLife = atLife.filter(e => e.tick === requestedTick);
      const killed = killsAt.get(requestedTick)?.has(playerId) ?? false;
      const disconnectEvent = atTickLife.some(e => e.type === 'disconnect' || (e.type === 'side_change' && e.disconnect));
      const spawnEvent = atTickLife.some(e => e.type === 'spawn' && e.player === playerId);
      if (killed) deadPlayers.add(playerId);
      const disconnected = disconnectedPlayers.has(playerId);
      const stateAmbiguous = (killed && spawnEvent) || (deadPlayers.has(playerId) && row?.is_alive === true) || (spawnEvent && disconnectEvent);
      if (disconnected) position = null; // Native stale Pawn rows cannot reconnect a player.
      const alive = !disconnected && !stateAmbiguous && typeof row?.is_alive === 'boolean' ? row.is_alive : null;
      const prior = previous.get(playerId);
      // Every lifecycle/death tick is in the plan, including unavailable frames; never skip a barrier.
      const barrier = atLife.length > 0 || killed;
      const interpolable = !!row && !!position && alive === true && side !== 'Unknown' && !stateAmbiguous;
      let segment: number | null = null;
      if (interpolable) {
        if (!prior || prior.sample.segment === null || prior.sample.side !== side || barrier || plan.step === null || requestedTick - prior.tick > plan.step) counters.set(playerId, (counters.get(playerId) ?? 0) + 1);
        segment = counters.get(playerId) ?? 1;
      }
      const sample: ReplayPlayerSample = { playerId, actualTick: row ? requestedTick : null, position, yaw,
        health: stateAmbiguous || disconnected ? null : health, alive, side, segment, stateAmbiguous };
      if (!row || !position || yaw === null || alive === null || health === null || side === 'Unknown') missingPlayerSamples++;
      previous.set(playerId, { tick: requestedTick, sample }); return sample;
      }) };
    });
    // Additive utility evidence degrades independently: a malformed projectile row or
    // missing expiry must never invalidate the accepted replay frames.
    let utilities: ReplayUtilityEffect[] | undefined, blinds: ReplayBlindWindow[] | undefined, burns: ReplayBurnWindow[] | undefined;
    try {
      const builtUtilities = buildUtilityEffects(events, frames, start, end, groupedRuns, groupedByThrower, groupedExpiries, match.tickRate ?? null);
      if (builtUtilities.length) utilities = builtUtilities;
      const builtBlinds = buildBlindWindows(events, end, match.tickRate ?? null);
      if (builtBlinds.length) blinds = builtBlinds;
      const builtBurns = buildBurnWindows(events, end, match.tickRate ?? null);
      if (builtBurns.length) burns = builtBurns;
    } catch { utilities = undefined; blinds = undefined; burns = undefined; }
    rounds.push({ round: round.number, startTick: start, endTick: end, freezeEndTick: round.freezeEndTick ?? null,
      frames, events, lifecycle, coverage: { requestedFrames: frames.length, missingPlayerSamples, status: missingPlayerSamples ? 'partial' : 'complete' },
      ...(utilities ? { utilities } : {}), ...(blinds ? { blinds } : {}), ...(burns ? { burns } : {}) });
  }
  return { schemaVersion: 1, matchId: match.id, source: 'native-final-tick-observation', samplingVersion: replaySamplingVersion,
    tickRate: plan.step === null ? null : match.tickRate!, hz: 8, maxInterpolationTicks: plan.step, players: ids, rounds, excludedRounds: plan.excludedRounds };
}
