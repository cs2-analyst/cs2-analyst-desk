import type { Finding, FindingEvidence } from '@cs2-analyst/findings';
import type { DesktopReplayMetadata, DesktopReplayRequest, DesktopReplayResult } from './replay.js';
import type { DesktopHeatmapMetadata, DesktopHeatmapRequest, DesktopHeatmapResult } from './heatmap.js';
import type { ImportPlayerSelectionResult, LibraryDeleteResult, LibraryExportResult, LibraryImportResult, LibraryListQuery, LibraryListResult, LibrarySelfPlayerResult, LibraryStorageResult } from './library.js';
import type { DesktopPlayerPerformance } from './performance.js';
export type * from './performance.js';
export type * from './replay.js';
export type * from './heatmap.js';
export type * from './library.js';

/**
 * Presentation-only addition to a frozen evidence row. Seconds from the round
 * start tick, derived from the existing round/tick evidence so the Renderer can
 * show a human time without recomputing anything. Absent when the round clock
 * cannot be established.
 */
export interface DesktopFindingEvidence extends FindingEvidence {
  roundTimeSeconds?: number;
}
/** Findings are passed through unchanged except for the evidence presentation field. */
export type DesktopFinding = Omit<Finding, 'evidence'> & { evidence: DesktopFindingEvidence[] };

/** High-value Round Timeline event kinds. Low-value log events are intentionally absent. */
export type DesktopTimelineEventType =
  | 'kill'
  | 'death'
  | 'bomb-plant-start'
  | 'bomb-planted'
  | 'bomb-defuse-start'
  | 'bomb-defused'
  | 'bomb-exploded'
  | 'clutch-start';

/**
 * One presentation event on the Round Timeline, projected from existing Match facts.
 * The raw `tick` is kept for traceability; the Renderer shows `roundTimeSeconds`
 * (seconds from the round start) and never the absolute tick.
 */
export interface DesktopTimelineEvent {
  id: string;
  type: DesktopTimelineEventType;
  tick: number;
  /** (tick - round.startTick) / tickRate; absent when the round clock cannot be established. */
  roundTimeSeconds?: number;
  actorId?: string;
  actorName?: string;
  targetId?: string;
  targetName?: string;
  weapon?: string;
  /** Copied from KillEvent; absent means the DEM did not provide this evidence. */
  headshot?: boolean;
  assistedFlash?: boolean;
  opponents?: number;
  description: string;
}

/**
 * One round for one target player. `side` / `result` follow the target player's team,
 * so the same round differs per player; `scoreAfter` belongs to the stable teams and is
 * null whenever the winner cannot be uniquely mapped back to them.
 */
export interface DesktopRoundTimeline {
  round: number;
  side: 'CT' | 'T' | 'Unknown';
  result: 'win' | 'loss' | 'unknown';
  scoreAfter: { initialCT: number; initialT: number } | null;
  startTick: number | null;
  events: DesktopTimelineEvent[];
}

/** One target player's full round timeline; switching players swaps this array entry. */
export interface DesktopPlayerTimeline {
  playerId: string;
  rounds: DesktopRoundTimeline[];
}

/** JSON-only presentation contract. No domain events, native objects or file paths. */
export interface DesktopPlayerAnalytics {
  playerId: string;
  /** Additive schema-v2 field; older archives are upgraded outside Renderer. */
  performance?: DesktopPlayerPerformance;
  /** Exact Analytics coverage proofs, absent from historical schema-v2 archives. */
  performanceCoverage?: { countsComplete: boolean; roundsAligned: boolean; headshotsComplete: boolean };
  kills: number;
  deaths: number;
  assists: number;
  roundsPlayed: number;
  adr: number | null;
  headshotPercentage: number | null;
  kast: { percentage: number | null; complete: boolean; rounds: number; eligibleRounds: number };
  trade: { rate: number | null; complete: boolean; kills: number; tradedDeaths: number; tradeableDeaths: number };
  opening: { kills: number; deaths: number; winRate: number | null };
  utility: {
    throws: { flash: number | null; smoke: number | null; he: number | null; incendiary: number | null; molotov: number | null; decoy: number | null };
    heDamage: number | null;
    fireDamage: number | null;
    enemyFlashEffects: number;
    teamFlashEffects: number;
    flashEffectsComplete: boolean;
    flashAssists: number | null;
  };
  clutch: { opportunities: number; wins: number; complete: boolean; list: { round: number; opponents: number; won: boolean | null }[] };
  coverage: { complete: boolean; notes: string[] };
}
/** Direct projection of frozen PlayerMetrics; ratios keep their original units. */
export interface DesktopPlayerComparison {
  playerId: string;
  playerName: string;
  kills: number;
  deaths: number;
  assists: number;
  kdRatio: number | null;
  adr: number | null;
  headshotPercentage: number | null;
  kastPercentage: number | null;
  kastComplete: boolean;
  /** Fraction (0–1), matching Analytics OpeningMetrics.winRate. */
  openingWinRate: number | null;
  tradeRate: number | null;
  tradeComplete: boolean;
  tradeKills: number;
}

export interface DesktopRoundTrendPoint {
  round: number;
  side: DesktopRoundTimeline['side'];
  result: DesktopRoundTimeline['result'];
  kills: number;
  died: boolean;
  /** False when Timeline's formal round window is missing: empty events are not zero evidence. */
  complete: boolean;
}

export interface DesktopSideAnalysis {
  roundsPlayed: number;
  kills: number;
  deaths: number;
  assists: number;
  adr: number | null;
}

export interface DesktopPlayerAnalysis {
  playerId: string;
  /** Frozen Analytics counts; fivePlus means five or more kills in one round. */
  multiKills: { double: number; triple: number; quad: number; fivePlus: number };
  roundTrend: DesktopRoundTrendPoint[];
  sideSplit: { CT: DesktopSideAnalysis; T: DesktopSideAnalysis };
}

export interface DesktopAnalysisViews {
  players: DesktopPlayerComparison[];
  perPlayer: DesktopPlayerAnalysis[];
}

export interface DesktopMatchReport {
  schemaVersion: 2;
  match: { id: string; fileName: string; map: string; rounds: number; score: { initialCT: number; initialT: number } | null };
  selectedPlayer: string;
  players: { id: string; nickname: string }[];
  analytics: DesktopPlayerAnalytics[];
  findings: DesktopFinding[];
  /** Full per-player round timelines; the Renderer picks the entry matching the selected player. */
  timeline: DesktopPlayerTimeline[];
  analysis: DesktopAnalysisViews;
  deepReview: { available: boolean; players: DesktopDeepReviewPlayer[] };
  replay?: DesktopReplayMetadata;
  heatmap?: DesktopHeatmapMetadata;
}
/** Presentation contract owned here; Renderer has no dependency on analysis packages. */
export interface DesktopDeepReviewFinding {
  id: string;
  ruleId: string;
  category: 'impact' | 'execution' | 'teamplay' | 'utility';
  kind: 'review' | 'highlight' | 'context';
  title: string;
  summary: string;
  occurrences: number;
  eligibleOccurrences: number | null;
  relatedRounds: number[];
  /** Plain-language occurrence line assembled by the desktop copy adapter; null when not applicable. */
  occurrenceLabel: string | null;
  /** User-facing limitations, already translated out of domain reason codes. */
  caveats: string[];
}
export interface DesktopDeepReviewPlayer {
  playerId: string;
  reviews: DesktopDeepReviewFinding[];
  highlights: DesktopDeepReviewFinding[];
  contexts: DesktopDeepReviewFinding[];
  coverage: { status: 'complete' | 'partial' | 'unavailable' };
}
export type ImportPhase = 'selecting' | 'parsing' | 'awaiting-player' | 'analyzing';
export type ImportResult = { kind: 'success'; report: DesktopMatchReport; selfPlayerId?: string | null }
  | { kind: 'cancelled' }
  | { kind: 'error'; message: string };
/** One participant offered by the import-time "who am I" prompt. */
export interface ImportPlayerChoice { id: string; nickname: string }
export interface DesktopApi {
  version: string;
  library: {
    list(query?: LibraryListQuery): Promise<LibraryListResult>;
    storage(): Promise<LibraryStorageResult>;
    /** Reopen a saved match without its source DEM and with a fresh IPC session. */
    open(matchId: string): Promise<ImportResult>;
    remove(matchIds: string[]): Promise<LibraryDeleteResult>;
    /** Main owns the save dialog; Renderer receives only the basename and size. */
    exportMatch(matchId: string): Promise<LibraryExportResult>;
    /** Main owns the open dialog and validates the portable package before commit. */
    importArchive(): Promise<LibraryImportResult>;
    /** Persist the local user's player identity for one saved match. */
    setSelfPlayer(matchId: string, playerId: string | null): Promise<LibrarySelfPlayerResult>;
  };
  window: {
    minimize(): Promise<void>;
    toggleMaximize(): Promise<void>;
    close(): Promise<void>;
    isMaximized(): Promise<boolean>;
    onMaximizedChange(listener: (maximized: boolean) => void): () => void;
  };
  importDemo(): Promise<ImportResult>;
  /** Resolve a disk-backed File and submit it inside preload, without exposing its path. */
  importDroppedFile(file: File): Promise<ImportResult>;
  /** Answer the import-time "who am I" prompt; null continues without a selection. */
  selectImportPlayer(playerId: string | null): Promise<ImportPlayerSelectionResult>;
  onImportPlayers(listener: (players: ImportPlayerChoice[]) => void): () => void;
  cancelImport(): Promise<void>;
  replay: {
    getChunk(request: DesktopReplayRequest): Promise<DesktopReplayResult>;
    release(sessionId: string): Promise<void>;
  };
  heatmap: {
    getGrid(request: DesktopHeatmapRequest): Promise<DesktopHeatmapResult>;
  };
  session: {
    release(sessionId: string): Promise<void>;
  };
  onProgress(listener: (phase: ImportPhase) => void): () => void;
}
