import type { MatchReplay } from '@cs2-analyst/match-model';
import type { SpatialParseResult } from './spatial.js';
export interface ReplayParseResult extends SpatialParseResult {
  replay: MatchReplay | null;
  replayUnavailableReason: string | null;
  replayMs: number;
}

/** Ephemeral local access while the original DEM bytes are already in the parser worker. */
export interface LocalDemEvidenceAccess {
  rawInput: unknown;
  parserVersion: string;
  playerIds: readonly string[];
  /** Exact native rows only. At most 64 unique ticks and 10 identified players per query. */
  queryExactTicks(ticks: readonly number[], playerIds: readonly string[]): unknown;
}
export type LocalDemEvidenceConsumer = (access: LocalDemEvidenceAccess) => void | Promise<void>;
