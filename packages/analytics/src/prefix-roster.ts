import type { Match, TeamSide } from "@cs2-analyst/match-model";

/** Structural input from the native prefix converter; no parser dependency. */
export interface PrefixMatchForRoster {
  schemaVersion: "dem-native-prefix-match-v1";
  cutTick: number;
  match: Match;
  unidentifiedDeathTicks: number[];
}

export type PrefixRosterFailure =
  | "invalid-prefix" | "non-prefix-match" | "round-missing-or-duplicate"
  | "round-boundary" | "round-ended" | "freeze-baseline-missing"
  | "later-round-started"
  | "freeze-baseline-ambiguous" | "baseline-roster" | "lifecycle-unavailable"
  | "lifecycle-ambiguous" | "unidentified-death" | "death-baseline-conflict"
  | "invalid-death" | "death-side-conflict" | "killer-roster-gap";

type Counts = { CT: number; T: number };
export interface PrefixDeathGroup {
  tick: number;
  /** Indices locate events in this prefix Match; they do not order events within one tick. */
  eventIndices: number[];
  before: Counts;
  after: Counts;
  victimIds: string[];
}

export type PrefixRosterResult =
  | { schemaVersion: "dem-prefix-roster-v1"; status: "unknown"; reason: PrefixRosterFailure;
      round: number; cutTick: number }
  | { schemaVersion: "dem-prefix-roster-v1"; status: "known"; reason: null;
      round: number; cutTick: number; baselineTick: number;
      groups: PrefixDeathGroup[]; counts: Counts;
      /** Local identifiers. A public projection must use request-scoped aliases. */
      survivors: { playerId: string; side: "CT" | "T" }[];
      oneVsOneFormedAtTick: number | null; eligibleOneVsOne: boolean };

const validTick = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const validId = (value: unknown): value is string => typeof value === "string" && /^[1-9]\d*$/.test(value);
const validSide = (value: TeamSide): value is "CT" | "T" => value === "CT" || value === "T";

/**
 * Reconstruct a standard 5v5 round from a verified freeze snapshot and atomic
 * death groups in an already cropped native prefix. This is a server roster,
 * never a reconstruction of what any player knew or saw.
 */
export function resolvePrefixRoster(input: PrefixMatchForRoster, roundNumber: number): PrefixRosterResult {
  const cutTick = input?.cutTick;
  const result = (reason: PrefixRosterFailure): PrefixRosterResult => ({
    schemaVersion: "dem-prefix-roster-v1", status: "unknown", reason,
    round: roundNumber, cutTick,
  });
  if (input?.schemaVersion !== "dem-native-prefix-match-v1" || !validTick(cutTick) || cutTick === 0
    || !Number.isSafeInteger(roundNumber) || roundNumber <= 0 || !Array.isArray(input.match?.rounds)
    || !Array.isArray(input.unidentifiedDeathTicks)) return result("invalid-prefix");
  if (input.unidentifiedDeathTicks.some(tick => !validTick(tick) || tick >= cutTick)) return result("non-prefix-match");
  for (const round of input.match.rounds) {
    if (!Array.isArray(round.events) || round.events.some(event => !validTick(event.tick) || event.tick >= cutTick)
      || [round.startTick, round.freezeEndTick, round.endTick].some(tick => tick !== undefined
        && (!validTick(tick) || tick >= cutTick))
      || round.stateSnapshots?.some(snapshot => !validTick(snapshot.tick) || snapshot.tick >= cutTick)
      || round.playerLifecycle?.some(event => !validTick(event.tick) || event.tick >= cutTick))
      return result("non-prefix-match");
  }
  const rounds = input.match.rounds.filter(round => round.number === roundNumber);
  if (rounds.length !== 1) return result("round-missing-or-duplicate");
  const round = rounds[0];
  if (!validTick(round.startTick) || !validTick(round.freezeEndTick)
    || round.startTick > round.freezeEndTick || round.freezeEndTick >= cutTick)
    return result("round-boundary");
  const roundStart = round.startTick;
  const freezeTick = round.freezeEndTick;
  if (input.match.rounds.some(other => other !== round && validTick(other.startTick)
    && other.startTick >= roundStart && other.startTick < cutTick))
    return result("later-round-started");
  if (round.endTick !== undefined) return result("round-ended");

  const baselines = (round.stateSnapshots ?? []).filter(snapshot => snapshot.boundary === "freeze_end"
    && snapshot.tick === freezeTick);
  if (baselines.length !== 1 || baselines[0].availability !== "observed")
    return result("freeze-baseline-missing");
  const baseline = baselines[0];
  if (baseline.unidentifiedPlayerCount !== 0 || !Array.isArray(baseline.players))
    return result("freeze-baseline-ambiguous");
  const states = new Map<string, { side: "CT" | "T"; alive: boolean }>();
  for (const player of baseline.players) {
    if (!validId(player.steamId) || states.has(player.steamId) || player.participant !== true
      || !validSide(player.side) || player.alive !== true) return result("baseline-roster");
    states.set(player.steamId, { side: player.side, alive: true });
  }
  const count = (): Counts => ({
    CT: [...states.values()].filter(player => player.side === "CT" && player.alive).length,
    T: [...states.values()].filter(player => player.side === "T" && player.alive).length,
  });
  if (states.size !== 10 || count().CT !== 5 || count().T !== 5) return result("baseline-roster");
  if (!Array.isArray(round.playerLifecycle)) return result("lifecycle-unavailable");
  if (round.playerLifecycle.some(event => event.tick >= freezeTick && event.tick < cutTick))
    return result("lifecycle-ambiguous");
  if (input.unidentifiedDeathTicks.some(tick => tick >= freezeTick && tick < cutTick))
    return result("unidentified-death");

  const deaths = round.events.map((event, eventIndex) => ({ event, eventIndex }))
    .filter((entry): entry is { event: Extract<typeof entry.event, { type: "kill" }>; eventIndex: number } =>
      entry.event.type === "kill");
  if (deaths.some(({ event }) => event.tick <= freezeTick)) return result("death-baseline-conflict");
  deaths.sort((a, b) => a.event.tick - b.event.tick || a.eventIndex - b.eventIndex);
  const groups: PrefixDeathGroup[] = [];
  let oneVsOneFormedAtTick: number | null = null;
  for (let i = 0; i < deaths.length;) {
    const tick = deaths[i].event.tick;
    const group = [];
    while (i < deaths.length && deaths[i].event.tick === tick) group.push(deaths[i++]);
    const before = count();
    const victims = new Set<string>();
    for (const { event } of group) {
      const victim = states.get(event.victim);
      if (!validId(event.victim) || !victim || !victim.alive || victims.has(event.victim))
        return result("invalid-death");
      if (event.victimSide !== victim.side) return result("death-side-conflict");
      if (validId(event.killer) && !states.has(event.killer)) return result("killer-roster-gap");
      victims.add(event.victim);
    }
    for (const id of victims) states.get(id)!.alive = false;
    const after = count();
    if (oneVsOneFormedAtTick === null && after.CT === 1 && after.T === 1)
      oneVsOneFormedAtTick = tick;
    groups.push({ tick, eventIndices: group.map(entry => entry.eventIndex).sort((a, b) => a - b),
      before, after, victimIds: [...victims].sort() });
  }
  const counts = count();
  const survivors = [...states].filter(([, player]) => player.alive)
    .map(([playerId, player]) => ({ playerId, side: player.side }))
    .sort((a, b) => a.playerId.localeCompare(b.playerId));
  return { schemaVersion: "dem-prefix-roster-v1", status: "known", reason: null,
    round: roundNumber, cutTick, baselineTick: freezeTick, groups, counts,
    survivors, oneVsOneFormedAtTick,
    eligibleOneVsOne: oneVsOneFormedAtTick !== null && counts.CT === 1 && counts.T === 1 };
}
