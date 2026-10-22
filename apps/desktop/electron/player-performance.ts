import { computePlayerPerformance } from '@cs2-analyst/analytics';
import type { PlayerPerformanceInput } from '@cs2-analyst/analytics';
import type { DesktopMatchReport, DesktopPlayerPerformance, LibraryPlayerSummary } from '@cs2-analyst/report-contract';

/** Independent from report/archive schema: derived data may be discarded and rebuilt. */
export const PERFORMANCE_CACHE_VERSION = 'hltv-2.0-community-approx-v1/highlights-v1/adapter-v3';
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const count = (value: unknown): number | null => Number.isSafeInteger(value) ? number(value) : null;
const ratingTypes = ['clutch', 'multi-kill', 'opening', 'trade', 'assists', 'headshot', 'flash', 'utility'];
const colors = ['gold', 'cyan', 'blue', 'pink', 'green', 'yellow', 'purple', 'orange'];

export function isPlayerPerformance(value: unknown): value is DesktopPlayerPerformance {
  if (!object(value) || !object(value.rating) || !Array.isArray(value.highlights) || value.highlights.length > 3) return false;
  const rating = value.rating;
  if (typeof rating.algorithm !== 'string' || !rating.algorithm.length || rating.algorithm.length > 128
    || !['available', 'unavailable'].includes(rating.status as string)
    || (rating.status === 'available' ? typeof rating.value !== 'number' || !Number.isFinite(rating.value) : rating.value !== null)
    || (rating.reason !== null && (typeof rating.reason !== 'string' || rating.reason.length > 512))) return false;
  return value.highlights.every(item => object(item) && ratingTypes.includes(item.type as string) && colors.includes(item.color as string)
    && typeof item.label === 'string' && item.label.length > 0 && item.label.length <= 3
    && typeof item.tooltip === 'string' && item.tooltip.length <= 512 && object(item.evidence)
    && Object.keys(item.evidence).length <= 16 && Object.values(item.evidence).every(value => typeof value === 'number' && Number.isFinite(value)));
}

/** Conservative upgrade from frozen report metrics; never invokes Parser or redefines ADR/KAST. */
export function upgradeReportPerformance(report: DesktopMatchReport): DesktopMatchReport {
  const analyses = new Map((report.analysis?.perPlayer ?? []).filter(object).map(p => [p.playerId, p]));
  report.analytics = report.analytics.filter(p => object(p) && typeof p.playerId === 'string').map(p => {
    if (isPlayerPerformance(p.performance)) return p;
    const proof = p.performanceCoverage;
    const multi = analyses.get(p.playerId)?.multiKills;
    const validMulti = multi && [multi.double, multi.triple, multi.quad, multi.fivePlus].every(value => count(value) !== null);
    const opening = p.opening && count(p.opening.kills) !== null && count(p.opening.deaths) !== null ? p.opening : undefined;
    const trade = p.trade && count(p.trade.kills) !== null ? { kills: p.trade.kills, complete: p.trade.complete === true } : undefined;
    const clutch = p.clutch && count(p.clutch.wins) !== null && Array.isArray(p.clutch.list)
      && p.clutch.list.every(c => c && count(c.round) !== null && count(c.opponents) !== null && (c.won === null || typeof c.won === 'boolean'))
      ? { wins: p.clutch.wins, complete: p.clutch.complete === true, list: p.clutch.list } : undefined;
    const input: PlayerPerformanceInput = {
      kills: count(p.kills), deaths: count(p.deaths), assists: count(p.assists), validRounds: count(p.roundsPlayed),
      adr: number(p.adr), kastPercent: number(p.kast?.percentage), kastEligibleRounds: count(p.kast?.eligibleRounds),
      kastComplete: p.kast?.complete === true, roundsAligned: proof?.roundsAligned === true, countsComplete: proof?.countsComplete === true,
      ...(opening ? { opening } : {}), ...(trade ? { trade } : {}), ...(clutch ? { clutch } : {}),
      ...(validMulti ? { multiKills: multi } : {}),
      // Historical HS% does not preserve the unknown-headshot count: no precision badge guessed.
      headshotPercentage: number(p.headshotPercentage), headshotsComplete: proof?.headshotsComplete === true,
      flashAssists: count(p.utility?.flashAssists), heDamage: number(p.utility?.heDamage), fireDamage: number(p.utility?.fireDamage),
    };
    const performance = computePlayerPerformance(input);
    if (!proof) performance.rating = { ...performance.rating, value: null, status: 'unavailable',
      reason: '旧报告缺少评分所需的统计覆盖证明；当前归档无法计算可靠评分。' };
    return { ...p, performance };
  });
  return report;
}

/** A complete player-relative timeline proves the result and stable team without guessing. */
function playerResult(report: DesktopMatchReport, playerId: string): Pick<LibraryPlayerSummary, 'outcome' | 'team'> {
  const rounds = report.timeline.find(t => t?.playerId === playerId)?.rounds;
  if (!Array.isArray(rounds) || !report.match.score || rounds.length === 0 || rounds.length !== report.match.rounds
    || report.match.score.initialCT + report.match.score.initialT !== rounds.length
    || new Set(rounds.map(r => r?.round)).size !== rounds.length
    || rounds.some(r => !r || (r.result !== 'win' && r.result !== 'loss'))) return { outcome: 'unknown', team: null };
  let previous = { initialCT: 0, initialT: 0 };
  let team: 'initialCT' | 'initialT' | null = null;
  for (const round of [...rounds].sort((a, b) => a.round - b.round)) {
    const score = round.scoreAfter;
    if (!score) return { outcome: 'unknown', team: null };
    const ct = score.initialCT - previous.initialCT, t = score.initialT - previous.initialT;
    if (!((ct === 1 && t === 0) || (ct === 0 && t === 1))) return { outcome: 'unknown', team: null };
    const winner = ct === 1 ? 'initialCT' : 'initialT';
    const currentTeam = round.result === 'win' ? winner : winner === 'initialCT' ? 'initialT' : 'initialCT';
    if (team !== null && team !== currentTeam) return { outcome: 'unknown', team: null };
    team = currentTeam;
    previous = score;
  }
  if (previous.initialCT !== report.match.score.initialCT || previous.initialT !== report.match.score.initialT || !team) {
    return { outcome: 'unknown', team: null };
  }
  const own = report.match.score[team], opponent = report.match.score[team === 'initialCT' ? 'initialT' : 'initialCT'];
  return { team, outcome: own > opponent ? 'win' : own < opponent ? 'loss' : 'draw' };
}

export interface CachedPlayerSummaries { selectedPlayer: string; playerSummaries: LibraryPlayerSummary[] }
export function reportPlayerSummaries(report: DesktopMatchReport): CachedPlayerSummaries {
  upgradeReportPerformance(report);
  const analytics = new Map(report.analytics.map(p => [p.playerId, p]));
  return { selectedPlayer: report.selectedPlayer, playerSummaries: report.players.map(player => {
    const p = analytics.get(player.id);
    const fallback = computePlayerPerformance({ kills: null, deaths: null, assists: null, validRounds: null, adr: null,
      kastPercent: null, kastEligibleRounds: null, kastComplete: false, roundsAligned: false, countsComplete: false });
    const result = playerResult(report, player.id);
    return { playerId: player.id, kills: count(p?.kills), deaths: count(p?.deaths), assists: count(p?.assists), adr: number(p?.adr),
      kastPercentage: number(p?.kast?.percentage), outcome: result.outcome, team: result.team, performance: p?.performance ?? fallback };
  }) };
}

/** Cache corruption is discarded; it must not turn a healthy archive into a broken match. */
export function validCachedPlayerSummaries(value: unknown, playerIds: readonly string[]): value is CachedPlayerSummaries {
  if (!object(value) || typeof value.selectedPlayer !== 'string' || !playerIds.includes(value.selectedPlayer)
    || !Array.isArray(value.playerSummaries) || value.playerSummaries.length !== playerIds.length) return false;
  const seen = new Set<string>();
  return value.playerSummaries.every(p => {
    if (!object(p) || typeof p.playerId !== 'string' || !playerIds.includes(p.playerId) || seen.has(p.playerId)) return false;
    seen.add(p.playerId);
    return ['kills', 'deaths', 'assists'].every(key => p[key] === null || count(p[key]) !== null)
      && ['adr', 'kastPercentage'].every(key => p[key] === null || number(p[key]) !== null)
      && ['win', 'loss', 'draw', 'unknown'].includes(p.outcome as string)
      && (p.team === null || p.team === 'initialCT' || p.team === 'initialT') && isPlayerPerformance(p.performance);
  });
}
