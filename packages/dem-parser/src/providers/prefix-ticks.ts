import type { Match } from "@cs2-analyst/match-model";

export interface PrefixTickSamplingOptions {
  /** Total unique-tick budget. Core historical ticks are never discarded. */
  tickBudget?: number;
  /** Frozen integer tick offset; no full-match clock or tick-rate lookup. */
  contextOffsetTicks?: number;
}

export type PrefixContextOmissionReason =
  | "context-before-round" | "context-after-round" | "context-outside-prefix"
  | "round-start-unknown" | "tick-overflow";

export interface PrefixTickPlan {
  schemaVersion: "dem-prefix-ticks-v1";
  /** Only observations at ticks strictly below this value are admitted. */
  cutTick: number;
  tickBudget: number;
  contextOffsetTicks: number;
  coreTicks: number[];
  optionalTicks: number[];
  omittedOptionalTicks: number[];
  requestedTicks: number[];
  /** Converter-associated events after a known round end are not round input. */
  excludedEvents: { tick: number; reason: "event-after-round" }[];
  contextOmissions: {
    eventTick: number;
    relation: "before-event" | "after-event";
    reason: PrefixContextOmissionReason;
  }[];
}

const validTick = (tick: number): boolean => Number.isSafeInteger(tick) && tick >= 0;

/**
 * Select native ticks for a historical cutoff without reading full-match roster,
 * result, event count, or the future part of a round. This is only a query plan:
 * it neither proves that native rows exist nor reconstructs player state.
 * Existing full-match spatial/replay plans remain separate.
 */
export function planPrefixSpatialTicks(
  match: Match,
  cutTick: number,
  options: PrefixTickSamplingOptions = {},
): PrefixTickPlan {
  if (!validTick(cutTick) || cutTick === 0) throw new Error("invalid-cut-tick");
  const tickBudget = options.tickBudget ?? 24000;
  const contextOffsetTicks = options.contextOffsetTicks ?? 0;
  if (!validTick(tickBudget)) throw new Error("invalid-tick-budget");
  if (!validTick(contextOffsetTicks)) throw new Error("invalid-context-offset");

  const core = new Set<number>();
  const optional = new Set<number>();
  const excludedEvents: PrefixTickPlan["excludedEvents"] = [];
  const contextOmissions: PrefixTickPlan["contextOmissions"] = [];
  for (const round of match.rounds) {
    if (!Array.isArray(round.events)) throw new Error("invalid-round-events");
    if (round.startTick !== undefined && !validTick(round.startTick)) throw new Error("invalid-round-boundary-tick");
    if (round.startTick !== undefined && round.startTick >= cutTick) {
      if (round.events.some(event => !validTick(event.tick) || event.tick < cutTick))
        throw new Error("future-round-has-unlocatable-history");
      continue;
    }
    const start = round.startTick;
    const knownEnd = round.endTick !== undefined && round.endTick < cutTick ? round.endTick : null;
    if (round.freezeEndTick !== undefined && round.freezeEndTick < cutTick && start !== undefined
      && round.freezeEndTick < start) throw new Error("invalid-round-boundary-order");
    if (knownEnd !== null && ((start !== undefined && knownEnd < start)
      || (round.freezeEndTick !== undefined && round.freezeEndTick < cutTick
        && knownEnd < round.freezeEndTick))) throw new Error("invalid-round-boundary-order");
    for (const boundary of [round.startTick, round.freezeEndTick, round.endTick]) {
      if (boundary === undefined) continue;
      if (!validTick(boundary)) throw new Error("invalid-round-boundary-tick");
      if (boundary < cutTick) core.add(boundary);
    }
    for (const event of round.events) {
      if (!validTick(event.tick)) throw new Error("unlocatable-event-tick");
      if (event.tick >= cutTick) continue;
      if (start !== undefined && event.tick < start) throw new Error("event-before-round");
      if (knownEnd !== null && event.tick > knownEnd) {
        excludedEvents.push({ tick: event.tick, reason: "event-after-round" });
        continue;
      }
      core.add(event.tick);
      if (contextOffsetTicks === 0 || !["kill", "damage", "weapon_fire"].includes(event.type)) continue;
      for (const [direction, relation] of [[-1, "before-event"], [1, "after-event"]] as const) {
        const tick = event.tick + direction * contextOffsetTicks;
        const reason: PrefixContextOmissionReason | null = !validTick(tick) ? "tick-overflow"
          : start === undefined ? "round-start-unknown"
          : tick < start ? "context-before-round"
          : tick >= cutTick ? "context-outside-prefix"
          : knownEnd !== null && tick > knownEnd ? "context-after-round" : null;
        if (reason) contextOmissions.push({ eventTick: event.tick, relation, reason });
        else optional.add(tick);
      }
    }
  }
  const coreTicks = [...core].sort((a, b) => a - b);
  const candidates = [...optional].filter(tick => !core.has(tick)).sort((a, b) => a - b);
  const optionalTicks = candidates.slice(0, Math.max(0, tickBudget - coreTicks.length));
  const omittedOptionalTicks = candidates.slice(optionalTicks.length);
  const requestedTicks = [...coreTicks, ...optionalTicks].sort((a, b) => a - b);
  excludedEvents.sort((a, b) => a.tick - b.tick);
  contextOmissions.sort((a, b) => a.eventTick - b.eventTick
    || a.relation.localeCompare(b.relation) || a.reason.localeCompare(b.reason));
  return { schemaVersion: "dem-prefix-ticks-v1", cutTick, tickBudget, contextOffsetTicks,
    coreTicks, optionalTicks, omittedOptionalTicks, requestedTicks, excludedEvents, contextOmissions };
}
