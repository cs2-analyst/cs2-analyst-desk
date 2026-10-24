import type { KillEvent } from "@cs2-analyst/match-model";

import type { KnownSide, RoundCoverage } from "./coverage.js";

/**
 * A lifecycle observation that invalidates the freeze-end alive baseline.
 *
 * Everything at or before the baseline tick is the round setup (spawns, the
 * halftime side change). Later changes invalidate survival evidence, except
 * a disconnect strictly after the identified player's single proven death.
 */
export type TimelineAnomalyKind =
  | "disconnect"
  | "respawn"
  | "side-change"
  | "death-without-baseline"
  | "multiple-deaths";

export interface TimelineAnomaly {
  readonly kind: TimelineAnomalyKind;
  readonly tick: number;
  readonly player: string | null;
}

/**
 * One player's formal-round survival state.
 *
 * Survival is only `true` when a recorded end-state observation confirms it.
 * Absence of a death event is never enough on its own.
 */
export interface PlayerTimelineState {
  readonly steamId: string;
  readonly side: KnownSide | null;
  /** alive value in the selected roster snapshot; null when the row is missing or unknown. */
  readonly aliveAtBaseline: boolean | null;
  /** First in-window death tick; null when the player has no recorded death. */
  readonly deathTick: number | null;
  /** Count of in-window deaths recorded for this player (more than one is an anomaly). */
  readonly deaths: number;
  /** Observed end-boundary alive value; null when the end state has no row. */
  readonly endAlive: boolean | null;
  /** Death timeline and end state disagree for this player. */
  readonly endConflict: boolean;
  /** Proven survival to the formal round end; null when the evidence is insufficient. */
  readonly survived: boolean | null;
}

/**
 * Unified timing / survival context for a formal round.
 *
 * Starts from the selected roster snapshot (freeze end preferred), advances
 * through in-window death events, and corroborates the final state with the
 * observed end snapshot. Every KAST / Trade / Clutch decision reads this and
 * never guesses a state from event absence.
 */
export interface RoundTimeline {
  readonly round: number;
  /** Formal window and roster both available. */
  readonly available: boolean;
  /** Roster used the start-boundary fallback or the snapshot has unidentified rows. */
  readonly degraded: boolean;
  /** At least one player's end state contradicts the death timeline. */
  readonly endStateSuspect: boolean;
  readonly baselineTick: number | null;
  readonly anomalies: readonly TimelineAnomaly[];
  readonly states: readonly PlayerTimelineState[];
  readonly deaths: readonly KillEvent[];
  state(steamId: string): PlayerTimelineState;
  /** Players alive after every death with tick <= the given tick. */
  aliveAt(tick: number): ReadonlySet<string>;
}

const unknownState = (steamId: string): PlayerTimelineState => ({
  steamId,
  side: null,
  aliveAtBaseline: null,
  deathTick: null,
  deaths: 0,
  endAlive: null,
  endConflict: false,
  survived: null,
});

function buildAnomalies(
  round: RoundCoverage,
  baselineTick: number | null,
  deathTicks: ReadonlyMap<string, number>,
  deathCounts: ReadonlyMap<string, number>,
  stateBySteamId: ReadonlyMap<string, { aliveAtBaseline: boolean | null }>,
): TimelineAnomaly[] {
  const anomalies: TimelineAnomaly[] = [];
  for (const event of round.lifecycleEvents) {
    if (baselineTick === null || event.tick <= baselineTick) continue;
    if (event.type === "disconnect") {
      const deathTick = event.player === null ? undefined : deathTicks.get(event.player);
      // Leaving after death cannot change the alive set. Require a living baseline
      // and strict tick ordering; same-tick exits and inconsistent deaths stay suspect.
      if (event.player !== null && stateBySteamId.get(event.player)?.aliveAtBaseline === true
        && deathCounts.get(event.player) === 1 && deathTick !== undefined
        && deathTick > baselineTick && deathTick < event.tick) continue;
      anomalies.push({ kind: "disconnect", tick: event.tick, player: event.player });
    } else if (event.type === "spawn") {
      anomalies.push({ kind: "respawn", tick: event.tick, player: event.player });
    } else {
      anomalies.push({ kind: "side-change", tick: event.tick, player: event.player });
    }
  }
  for (const [victim, count] of deathCounts) {
    const tick = deathTicks.get(victim) ?? 0;
    if (count > 1) anomalies.push({ kind: "multiple-deaths", tick, player: victim });
    const state = stateBySteamId.get(victim);
    if (!state || state.aliveAtBaseline !== true) {
      anomalies.push({ kind: "death-without-baseline", tick, player: victim });
    }
  }
  return anomalies.sort((a, b) => a.tick - b.tick || a.kind.localeCompare(b.kind));
}

/** Build the shared survival / death timeline for one covered round. */
export function buildRoundTimeline(round: RoundCoverage): RoundTimeline {
  const available = round.window.eventEligible && round.roster.available;
  const baselineTick = round.roster.tick;
  const deaths = available
    ? round.eventsInWindow()
        .filter((event): event is KillEvent => event.type === "kill")
        .slice()
        .sort((a, b) => a.tick - b.tick)
    : [];
  const deathTicks = new Map<string, number>();
  const deathCounts = new Map<string, number>();
  for (const kill of deaths) {
    deathCounts.set(kill.victim, (deathCounts.get(kill.victim) ?? 0) + 1);
    if (!deathTicks.has(kill.victim)) deathTicks.set(kill.victim, kill.tick);
  }

  const states: PlayerTimelineState[] = round.roster.entries.map(entry => {
    const deathTick = deathTicks.get(entry.steamId) ?? null;
    const deathsForPlayer = deathCounts.get(entry.steamId) ?? 0;
    const endAlive = round.endState.alive(entry.steamId);
    const aliveAtBaseline = entry.alive;
    let survived: boolean | null;
    if (aliveAtBaseline === false) survived = false;
    else if (aliveAtBaseline === null) survived = null;
    else if (deathTick !== null) survived = false;
    else survived = endAlive === true ? true : null;
    const endConflict = (deathTick !== null && endAlive === true)
      || (deathTick === null && endAlive === false);
    return {
      steamId: entry.steamId,
      side: entry.side,
      aliveAtBaseline,
      deathTick,
      deaths: deathsForPlayer,
      endAlive,
      endConflict,
      survived,
    };
  });

  const stateBySteamId = new Map(states.map(state => [state.steamId, state]));
  const anomalies = available
    ? buildAnomalies(round, baselineTick, deathTicks, deathCounts, stateBySteamId)
    : [];
  const degraded = available
    && (round.roster.degraded || round.roster.unidentifiedPlayerCount > 0);
  const endStateSuspect = states.some(state => state.endConflict);

  return {
    round: round.number,
    available,
    degraded,
    endStateSuspect,
    baselineTick,
    anomalies,
    states,
    deaths,
    state: (steamId: string) => stateBySteamId.get(steamId) ?? unknownState(steamId),
    aliveAt: (tick: number) => {
      const alive = new Set<string>();
      for (const state of states) {
        if (state.aliveAtBaseline !== true) continue;
        if (state.deathTick === null || state.deathTick > tick) alive.add(state.steamId);
      }
      return alive;
    },
  };
}
