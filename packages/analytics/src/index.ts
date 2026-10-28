export {
  addIssueCount,
  buildCoverage,
  coverageIssueSeverity,
  coverageIssueTypes,
  isEligibleAssist,
  isEligibleDamage,
  isEligibleKill,
  isIdentifiedEnemyKill,
  rosterBoundaryPreference,
} from "./coverage.js";
export type {
  CoverageIssue,
  CoverageSummary,
  IssueSeverity,
  KnownSide,
  MatchCoverage,
  PlayerRoundState,
  RoundCoverage,
  RoundCoverageSummary,
  RoundEndState,
  RoundRoster,
  RoundRosterEntry,
  RoundWindow,
} from "./coverage.js";
export { buildDamageLedger, damageLossIssueTypes, spawnHealth } from "./damage.js";
export type { DamageLedger, DamageLossIssue } from "./damage.js";
export { buildRoundTimeline } from "./timeline.js";
export type {
  PlayerTimelineState,
  RoundTimeline,
  TimelineAnomaly,
  TimelineAnomalyKind,
} from "./timeline.js";
export {
  defaultTradeWindowSeconds,
  resolveRoundTrades,
  summarizeTrade,
} from "./trade.js";
export type {
  RoundTradeResolution,
  TradeAmbiguity,
  TradeAmbiguityReason,
  TradeKill,
  TradeMetrics,
} from "./trade.js";
export { computeKast } from "./kast.js";
export type { KastMetrics } from "./kast.js";
export { resolveRoundClutch, summarizeClutch } from "./clutch.js";
export type {
  ClutchMetrics,
  ClutchOpportunity,
  OpponentBuckets,
  RoundClutchResolution,
} from "./clutch.js";
export { analyzeMatch } from "./metrics.js";
export { calculateDemDistance } from "./distance.js";
export { resolvePrefixRoster } from "./prefix-roster.js";
export { buildPrefixSpatialContext } from "./prefix-spatial-context.js";
export { buildPrefixEndpointChange } from "./prefix-endpoint-change.js";
export { buildPrefixReviewFragment } from "./prefix-review-fragment.js";
export type { PrefixMatchForRoster, PrefixRosterResult } from "./prefix-roster.js";
export type { PrefixRowsForContext, PrefixSpatialContext } from "./prefix-spatial-context.js";
export type { PrefixEndpointChange } from "./prefix-endpoint-change.js";
export type { PrefixReviewFragment } from "./prefix-review-fragment.js";
export { computeRating, computePlayerPerformance, playerPerformanceInput, summarizePlayerPerformance, ratingAlgorithm, highlightRules } from './performance.js';
export type { PlayerRating, RatingInput, PlayerHighlight, HighlightType, PlayerPerformance, PlayerPerformanceInput } from './performance.js';
export { classifyUtilityWeapon, summarizeUtility } from "./utility.js";
export type {
  FlashMetrics, GrenadeKind, UtilityDamageMetrics, UtilityEvidence, UtilityIssue, UtilityMetrics,
} from "./utility.js";
export type {
  AnalyzeOptions,
  MatchAnalytics,
  MultiKillMetrics,
  OpeningMetrics,
  PlayerCoverage,
  PlayerMetrics,
  SideMetrics,
  TradeWindow,
} from "./metrics.js";
