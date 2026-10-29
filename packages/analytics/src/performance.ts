import type { PlayerMetrics } from './metrics.js';

export const ratingAlgorithm = 'hltv-2.0-community-approx-v1' as const;
export interface PlayerRating {
  value: number | null;
  algorithm: typeof ratingAlgorithm;
  status: 'available' | 'unavailable';
  reason: string | null;
}
/** All values must describe one player, one match and the same formal round set. */
export interface RatingInput {
  kills: number | null;
  deaths: number | null;
  assists: number | null;
  validRounds: number | null;
  adr: number | null;
  /** Percentage points, 0–100, never a fraction. */
  kastPercent: number | null;
  kastEligibleRounds: number | null;
  kastComplete: boolean;
  /** Event totals and participation-scoped ADR cover exactly the same rounds. */
  roundsAligned: boolean;
  /** K/D/A and enemy damage have no unknown attribution needed by this calculation. */
  countsComplete: boolean;
  /** Alternative observations used only when the standard inputs are missing. */
  fallbackAdr?: number | null;
  fallbackRounds?: number | null;
}
export type HighlightType = 'clutch' | 'multi-kill' | 'opening' | 'trade' | 'assists' | 'headshot' | 'flash' | 'utility';
export interface PlayerHighlight {
  type: HighlightType;
  label: string;
  color: 'gold' | 'cyan' | 'blue' | 'pink' | 'green' | 'yellow' | 'purple' | 'orange';
  tooltip: string;
  evidence: Record<string, number>;
}
export interface PlayerPerformance { rating: PlayerRating; highlights: PlayerHighlight[] }
export interface PlayerPerformanceInput extends RatingInput {
  opening?: { kills: number; deaths: number };
  trade?: { kills: number; complete: boolean };
  clutch?: { wins: number; complete: boolean; list: readonly { round: number; opponents: number; won: boolean | null }[] };
  multiKills?: { double: number; triple: number; quad: number; fivePlus: number };
  headshotPercentage?: number | null;
  headshotsComplete?: boolean;
  flashAssists?: number | null;
  heDamage?: number | null;
  fireDamage?: number | null;
}

/** Conservative, explicit v1 rules; ordering is part of the public result. */
export const highlightRules = Object.freeze({
  openingKills: 3,
  tradeKills: 3,
  assists: 6,
  headshotKillsSample: 15,
  headshotPercent: 60,
  flashAssists: 3,
  utilityDamage: 200,
  multiKillMinimum: 3,
  clutchWins: 1,
  priority: Object.freeze(['clutch', 'multi-kill', 'opening', 'trade', 'headshot', 'flash', 'utility', 'assists'] as const),
});

const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const percent = (value: unknown): value is number => nonnegative(value) && value <= 100;
/** Community linear fit with approximate Impact, not HLTV's unpublished official formula. */
export function computeRating(input: RatingInput): PlayerRating {
  const notes: string[] = [];
  // Bound corrupt inputs as well as avoiding overflow; defaults are estimates, never evidence.
  const safeCount = (value: unknown, name: string): number => {
    if (count(value) && value <= 1_000_000) return value;
    notes.push(`${name}缺失或无效，按 0 估算`); return 0;
  };
  const kills = safeCount(input.kills, '击杀');
  const deaths = safeCount(input.deaths, '死亡');
  const assists = safeCount(input.assists, '助攻');
  let validRounds = input.validRounds;
  if (!count(validRounds) || validRounds === 0 || validRounds > 1_000_000) {
    validRounds = count(input.fallbackRounds) && input.fallbackRounds > 0 && input.fallbackRounds <= 1_000_000 ? input.fallbackRounds : 1;
    notes.push(validRounds === 1 ? '有效回合缺失，按 1 回合估算' : `有效回合缺失，按 ${validRounds} 个已知回合估算`);
  }
  let adr = input.adr;
  if (!nonnegative(adr) || adr > 1_000_000) {
    if (nonnegative(input.fallbackAdr) && input.fallbackAdr <= 1_000_000) {
      adr = input.fallbackAdr; notes.push('有效 ADR 缺失，使用记录伤害估算 ADR');
    } else { adr = 80; notes.push('ADR 缺失，按 80 估算'); }
  }
  let kastPercent = input.kastPercent;
  if (!percent(kastPercent)) { kastPercent = 70; notes.push('KAST 缺失，按 70% 估算'); }
  else if (!input.kastComplete || input.kastEligibleRounds !== validRounds) notes.push('KAST 使用部分或降级回合的比例');
  if (!input.roundsAligned) notes.push('统计回合集合未完全对齐');
  if (!input.countsComplete) notes.push('击杀或伤害归属不完整');
  const kpr = kills / validRounds;
  const dpr = deaths / validRounds;
  const apr = assists / validRounds;
  const impactApprox = 2.13 * kpr + 0.42 * apr - 0.41;
  const value = 0.0073 * kastPercent + 0.3591 * kpr - 0.5329 * dpr
    + 0.2372 * impactApprox + 0.0032 * adr + 0.1587;
  return { value, algorithm: ratingAlgorithm, status: 'available', reason: notes.length ? `估算：${notes.join('；')}。` : null };
}

/** No inference from Rating: every badge is backed by its own existing metric. */
export function computePlayerPerformance(input: PlayerPerformanceInput): PlayerPerformance {
  const highlights: PlayerHighlight[] = [];
  const add = (type: HighlightType, label: string, color: PlayerHighlight['color'], tooltip: string,
    evidence: Record<string, number>): void => { highlights.push({ type, label, color, tooltip, evidence }); };
  const clutch = input.clutch;
  if (clutch?.complete && count(clutch.wins) && clutch.wins >= highlightRules.clutchWins) {
    const wins = clutch.list.filter(entry => entry.won === true && count(entry.round) && entry.round > 0
      && count(entry.opponents) && entry.opponents > 0);
    if (wins.length === clutch.wins && new Set(wins.map(entry => entry.round)).size === wins.length) {
      const maxOpponents = Math.max(...wins.map(entry => entry.opponents));
      add('clutch', '残', 'gold', `残局获胜：本场赢得 ${clutch.wins} 次残局，最高 1 对 ${maxOpponents}`,
        { wins: clutch.wins, maxOpponents });
    }
  }
  // These counts use the same event windows as K/D/A, not participation guesses.
  const eventsReliable = input.countsComplete && input.roundsAligned && count(input.validRounds) && input.validRounds > 0;
  const multi = input.multiKills;
  if (eventsReliable && multi && Object.values(multi).every(count)) {
    const rounds = multi.triple + multi.quad + multi.fivePlus;
    if (rounds > 0 && rounds <= input.validRounds!) {
      const maxKills = multi.fivePlus > 0 ? 5 : multi.quad > 0 ? 4 : 3;
      add('multi-kill', '神', 'cyan', `多杀表现：本场 ${rounds} 个三杀及以上回合（3 杀 ${multi.triple} 次，4 杀 ${multi.quad} 次，5 杀及以上 ${multi.fivePlus} 次）`,
        { rounds, triple: multi.triple, quad: multi.quad, fivePlus: multi.fivePlus, maxKills });
    }
  }
  const opening = input.opening;
  if (eventsReliable && opening && count(opening.kills) && count(opening.deaths)
    && opening.kills >= highlightRules.openingKills && opening.kills > opening.deaths) {
    add('opening', '突', 'blue', `突破表现：本场首杀 ${opening.kills} 次，首死 ${opening.deaths} 次`,
      { kills: opening.kills, deaths: opening.deaths });
  }
  const trade = input.trade;
  if (trade?.complete && count(trade.kills) && trade.kills >= highlightRules.tradeKills) {
    add('trade', '补', 'pink', `补枪贡献：本场成功补枪 ${trade.kills} 次`, { kills: trade.kills });
  }
  if (eventsReliable && input.headshotsComplete && percent(input.headshotPercentage)
    && input.headshotPercentage >= highlightRules.headshotPercent
    && count(input.kills) && input.kills >= highlightRules.headshotKillsSample) {
    add('headshot', '准', 'yellow', `精准击杀：爆头率 ${input.headshotPercentage.toFixed(1)}%，有效击杀 ${input.kills} 次`,
      { percentage: input.headshotPercentage, kills: input.kills });
  }
  if (count(input.flashAssists) && input.flashAssists >= highlightRules.flashAssists) {
    add('flash', '闪', 'purple', `闪光支援：本场成功闪光助攻 ${input.flashAssists} 次`, { assists: input.flashAssists });
  }
  if (nonnegative(input.heDamage) && nonnegative(input.fireDamage)
    && input.heDamage + input.fireDamage >= highlightRules.utilityDamage
    && Number.isFinite(input.heDamage + input.fireDamage)) {
    add('utility', '辅', 'orange', `道具输出：有效敌方伤害 ${input.heDamage + input.fireDamage}（HE ${input.heDamage}，燃烧 ${input.fireDamage}）`,
      { damage: input.heDamage + input.fireDamage, heDamage: input.heDamage, fireDamage: input.fireDamage });
  }
  if (eventsReliable && count(input.assists) && input.assists >= highlightRules.assists) {
    add('assists', '助', 'green', `助攻表现：本场有效助攻 ${input.assists} 次`, { assists: input.assists });
  }
  const priority = new Map<HighlightType, number>(highlightRules.priority.map((type, index) => [type, index]));
  highlights.sort((a, b) => priority.get(a.type)! - priority.get(b.type)!);
  return { rating: computeRating(input), highlights };
}

/** Portable inputs retain the small coverage proofs needed for later algorithm replacement. */
export function playerPerformanceInput(player: PlayerMetrics): PlayerPerformanceInput {
  const c = player.coverage;
  return {
    kills: player.kills, deaths: player.deaths, assists: player.assists, validRounds: player.roundsPlayed,
    adr: player.adr, kastPercent: player.kast.percentage, kastEligibleRounds: player.kast.eligibleRounds,
    kastComplete: player.kast.complete,
    roundsAligned: c.eligibleRounds === c.countedRounds && c.countedRounds === player.roundsPlayed
      && c.skippedUnconfirmedParticipation === 0,
    countsComplete: c.killsWithoutTeamkillStatus === 0 && c.damageWithoutKnownSides === 0,
    fallbackAdr: player.reportedAdr, fallbackRounds: c.eligibleRounds,
    opening: player.opening,
    trade: { kills: player.trade.tradeKills, complete: player.trade.complete },
    // Each list item was already generated only from a reliable clutch round.
    clutch: { wins: player.clutch.wins, complete: true, list: player.clutch.list },
    multiKills: { double: player.multiKills.counts[2], triple: player.multiKills.counts[3],
      quad: player.multiKills.counts[4], fivePlus: player.multiKills.counts[5] },
    headshotPercentage: player.headshotPercentage, headshotsComplete: c.killsWithoutHeadshotStatus === 0,
    flashAssists: player.utility.flash.assists,
    heDamage: player.utility.he.enemyDamage, fireDamage: player.utility.fire.enemyDamage,
  };
}

/** Adapter from frozen Analytics metrics. Utility availability never gates Rating. */
export function summarizePlayerPerformance(player: PlayerMetrics): PlayerPerformance {
  return computePlayerPerformance(playerPerformanceInput(player));
}
