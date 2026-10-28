import type { Match } from "@cs2-analyst/match-model";
import { convertToMatch } from "./converters.js";

export interface NativePrefixMatch {
  schemaVersion: "dem-native-prefix-match-v1";
  cutTick: number;
  /** Match.id remains the source DEM identity and may change with suffix bytes. */
  match: Match;
  /** Native deaths omitted by ordinary conversion cannot silently vanish from roster checks. */
  unidentifiedDeathTicks: number[];
}

type RawRow = Record<string, unknown>;
const validTick = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const object = (value: unknown): value is RawRow => !!value && typeof value === "object" && !Array.isArray(value);

/**
 * Cut native events and boundary-state rows before domain conversion. Future
 * player metadata, outcome, clock and effect arrays cannot influence the
 * historical facts. Match.id remains the source DEM identity, so only the
 * historical facts are prefix-invariant if a DEM's future bytes change.
 * The caller must authenticate native provenance, enforce local privacy, and
 * validate round/lifecycle gates before using these facts.
 */
export function convertNativePrefix(rawInput: unknown, cutTick: number): NativePrefixMatch {
  if (!validTick(cutTick) || cutTick === 0) throw new Error("invalid-prefix-cut");
  if (!object(rawInput) || !object(rawInput.header) || !Array.isArray(rawInput.events)
    || !Array.isArray(rawInput.stateRows)) throw new Error("invalid-native-prefix-input");
  if (typeof rawInput.id !== "string" || !rawInput.id
    || typeof rawInput.header.map_name !== "string" || !rawInput.header.map_name.trim())
    throw new Error("invalid-native-prefix-provenance");
  const before = (value: unknown, name: string): RawRow[] => {
    const result: RawRow[] = [];
    for (const item of value as unknown[]) {
      if (!object(item) || !validTick(item.tick)) throw new Error(`unlocatable-${name}-tick`);
      if (item.tick < cutTick) result.push(structuredClone(item));
    }
    return result;
  };
  const events = before(rawInput.events, "event");
  const stateRows = before(rawInput.stateRows, "state-row");
  const unidentifiedDeathTicks = events.filter(event => event.event_name === "player_death"
    && event.is_warmup_period !== true
    && !(typeof event.user_steamid === "string" && /^[1-9]\d*$/.test(event.user_steamid)))
    .map(event => event.tick as number).sort((a, b) => a - b);
  const match = convertToMatch({
    id: rawInput.id,
    header: { map_name: rawInput.header.map_name },
    players: [],
    events,
    stateRows,
  });
  return { schemaVersion: "dem-native-prefix-match-v1", cutTick, match, unidentifiedDeathTicks };
}
