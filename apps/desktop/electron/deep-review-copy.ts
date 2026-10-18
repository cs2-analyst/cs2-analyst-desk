import type { DeepReviewFinding, DeepReviewRuleId } from '@cs2-analyst/deep-review';

/**
 * Product copy for Deep Review. This module is the single translation boundary
 * between domain findings and user-visible Desktop text. Domain findings keep
 * raw facts, coverage and reason codes; only plain-language product copy leaves
 * this file. Renderer code must never render domain title/summary/caveats.
 */
export interface DeepReviewCopy {
  title: string;
  summary: string;
  occurrenceLabel: string | null;
  caveats: string[];
}

type Facts = DeepReviewFinding['facts'];

const num = (facts: Facts, key: string): number | null => {
  const value = facts[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
};
const flag = (facts: Facts, key: string): boolean => facts[key] === true;
const roundOf = (f: DeepReviewFinding): number => num(f.facts, 'sequenceRound') ?? f.relatedRounds[0] ?? 0;
const killsOf = (f: DeepReviewFinding): number => num(f.facts, 'killCount') ?? 0;

/** Human names for the internal evidence layers that can limit a finding. */
const LAYER_LABELS: Record<string, string> = {
  engagementLinkage: '交火关联记录',
  fireEvidence: '开枪记录',
  contactEvidence: '伤害与击杀记录',
  returnContact: '反击记录',
  attribution: '击杀归属记录',
  roundState: '回合状态记录',
  engagementParticipation: '交火参与记录',
  aliveState: '存活状态记录',
  followUpTiming: '跟进时间记录',
  spatialContext: '距离与位置信息',
  position: '道具落点位置',
  bombContext: '下包与拆包状态',
  actorAttribution: '道具归属记录',
  directOutcome: '道具效果记录',
  eventSegmentation: '回合切分记录',
};

/** Full product sentences for known internal reasons; unknown codes never reach the UI. */
const REASON_HINTS: { test: RegExp; text: string }[] = [
  { test: /same-tick-fire-contact-ambiguous/, text: '部分开枪与伤害事件发生在同一游戏刻，无法判断严格先后' },
  { test: /same-tick/, text: '部分事件发生在同一游戏刻，无法判断严格先后' },
  { test: /contact-feed-incomplete|engagement-evidence-incomplete/, text: '部分交火记录不完整' },
  { test: /tick-rate-unreliable/, text: '录像的游戏刻速率不稳定' },
  { test: /spatial|position|distance/, text: '距离与位置信息不完整' },
  { test: /link-conflict/, text: '部分记录的对应关系不一致' },
  { test: /unavailable/, text: '部分记录不可用' },
];

/** Closing sentence follows the finding family, so the note matches what the rule used. */
const CAVEAT_TAIL: Record<DeepReviewFinding['category'], string> = {
  execution: '这不会影响本条结论所依据的伤害与击杀记录。',
  impact: '这不会影响本条结论所依据的击杀和人数变化记录。',
  teamplay: '这不会影响本条结论所依据的交火与阵亡记录。',
  utility: '这不会影响本条结论所依据的闪光弹与受闪记录。',
};
const KNOWN_RULES: ReadonlySet<string> = new Set<DeepReviewRuleId>([
  'deep.impact.multikill-swing', 'deep.impact.sole-survivor-sequence', 'deep.impact.multikill-unconverted',
  'deep.execution.no-confirmed-return-pattern', 'deep.execution.return-contact-consistent',
  'deep.teamplay.lone-contact-death-pattern', 'deep.teamplay.no-followup-pattern', 'deep.utility.teamflash-repeated',
]);
const UNKNOWN_CAVEAT_TAIL = '这不会影响本条结论所使用的其他明确记录。';
const caveatTail = (f: DeepReviewFinding): string => KNOWN_RULES.has(f.ruleId) ? CAVEAT_TAIL[f.category] : UNKNOWN_CAVEAT_TAIL;

/**
 * Domain coverage caveats name layers and reason codes. Translate them into a
 * complete user sentence instead of deleting identifiers from the raw string.
 */
function translatePartialCaveat(caveat: string, tail: string): string | null {
  if (!caveat.startsWith('未用于此规则')) return null;
  const layerMatch = caveat.match(/^未用于此规则的\s*(.+?)\s*证据为/);
  const layer = (layerMatch && LAYER_LABELS[layerMatch[1]]) ?? '部分记录';
  const reasonBlock = caveat.match(/（([^）]*)）/);
  const reasons = reasonBlock ? reasonBlock[1].split('、').filter(Boolean) : [];
  const hint = reasons.map(r => REASON_HINTS.find(h => h.test.test(r))?.text).find(Boolean);
  const body = hint ?? `部分${layer}无法完整判断`;
  return `${body}；${tail}`;
}

const RESULT_NOTE: Record<string, string> = {
  'deep.impact.multikill-swing': '这些人数变化和回合结果都是录像里的观察事实，不能说明某一次击杀直接决定了回合胜负。',
  'deep.impact.sole-survivor-sequence': '这些人数变化和回合结果都是录像里的观察事实，不能说明某一次击杀直接决定了回合胜负。',
  'deep.impact.multikill-unconverted': '这些人数变化和回合结果都是录像里的观察事实，不能说明某一次击杀直接决定了回合胜负。',
  'deep.execution.no-confirmed-return-pattern': '这项结果只表示录像中是否记录到后续伤害或击杀，不能据此判断你的反应速度或枪法。',
  'deep.execution.return-contact-consistent': '这项结果只表示录像中是否记录到后续伤害或击杀，不能据此判断你的反应速度或枪法。',
  'deep.teamplay.lone-contact-death-pattern': '这不代表你的站位一定孤立，也不能说明队友当时看得到、来得及或具备支援条件。',
  'deep.teamplay.no-followup-pattern': '交火参与记录也包括受到伤害或被击杀，且可能发生在队友阵亡之后，不能证明你在阵亡前已经参与。这不等同于补枪失败，也不能证明你当时看得到、来得及或具备支援条件。这里不是正式的补枪统计。',
  'deep.utility.teamflash-repeated': '游戏记录的受闪时长是原始事件数据，不等于持续致盲时间，也不能单独用来评价闪光弹质量。',
};

const transitionPhrases = (facts: Facts): string[] => {
  const phrases: string[] = [];
  if (flag(facts, 'equalizer')) phrases.push('扳平人数');
  if (flag(facts, 'deficitReduction')) phrases.push('缩小人数劣势');
  if (flag(facts, 'advantageGain')) phrases.push('帮助队伍取得人数优势');
  if (flag(facts, 'enemyEliminated')) phrases.push('清空对手');
  return phrases;
};
const joinPhrases = (phrases: string[]): string => phrases.length <= 1
  ? phrases[0] ?? ''
  : `${phrases.slice(0, -1).join('、')}，并最终${phrases.at(-1)}`;
const resultSentence = (facts: Facts): string => facts.roundResult === 'win' ? '这个回合最终获胜。'
  : facts.roundResult === 'loss' ? '这个回合最终没有拿下。' : '';

function impactCopy(f: DeepReviewFinding): DeepReviewCopy {
  const round = roundOf(f);
  const kills = killsOf(f);
  const facts = f.facts;
  const phrases = transitionPhrases(facts);
  const swingClause = phrases.length ? `，期间你曾${joinPhrases(phrases)}` : '';
  const result = resultSentence(facts);
  const base = `你在 R${round} 完成 ${kills}K${swingClause}`;
  if (f.ruleId === 'deep.impact.multikill-unconverted') {
    return { title: `R${round} 完成 ${kills}K，但回合最终失利`,
      summary: `你在 R${round} 完成 ${kills} 次击杀，但这个回合最终没有拿下。`, occurrenceLabel: null, caveats: [] };
  }
  if (f.ruleId === 'deep.impact.sole-survivor-sequence') {
    const outcome = facts.roundResult === 'win' ? '获胜' : facts.roundResult === 'loss' ? '失利' : '结束';
    const tail = swingClause
      ? `；随后在队伍只剩你一人存活时继续拿到击杀，该回合最终${outcome}。`
      : `，并在队伍只剩你一人存活后继续拿到击杀；该回合最终${outcome}。`;
    return { title: `R${round}：队伍只剩你一人时继续拿到击杀`,
      summary: `你在 R${round} 共完成 ${kills} 次击杀${swingClause}${tail}`, occurrenceLabel: null, caveats: [] };
  }
  return { title: `R${round} 的 ${kills}K 改变了人数局面`,
    summary: result ? `${base}；${result}` : `${base}。`, occurrenceLabel: null, caveats: [] };
}

/** ruleId + facts + occurrence counts -> plain-language user copy. */
export function adaptDeepReviewFinding(f: DeepReviewFinding): DeepReviewCopy {
  const eligible = f.eligibleOccurrences;
  const occurrenceLabel = eligible === null ? null : `符合此情况：${f.occurrences} / ${eligible} 次`;
  const caveats = [RESULT_NOTE[f.ruleId]];
  const tail = caveatTail(f);
  for (const raw of f.caveats) {
    const translated = translatePartialCaveat(raw, tail);
    if (translated) caveats.push(translated);
  }
  const copy: DeepReviewCopy = { title: '', summary: '', occurrenceLabel, caveats: [...new Set(caveats.filter(Boolean))] };
  switch (f.ruleId) {
    case 'deep.impact.multikill-swing':
    case 'deep.impact.sole-survivor-sequence':
    case 'deep.impact.multikill-unconverted':
      // Impact cards describe one selected round; the qualified-candidate count stays internal.
      return { ...impactCopy(f), caveats: copy.caveats };
    case 'deep.execution.no-confirmed-return-pattern':
      return { ...copy, title: '先被对手打到后的反击情况',
        summary: `在 ${eligible ?? 0} 次你先被对手打到、且可以完整判断的交火中，有 ${f.occurrences} 次之后没有记录到你对同一对手造成伤害或击杀。` };
    case 'deep.execution.return-contact-consistent':
      return { ...copy, title: '先被对手打到后，多次打回伤害',
        summary: `在 ${eligible ?? 0} 次你先被对手打到、且可以完整判断的交火中，有 ${f.occurrences} 次你随后对同一对手造成了伤害或完成击杀。` };
    case 'deep.teamplay.lone-contact-death-pattern':
      return { ...copy, title: '多次阵亡时，只有你留下了交火记录',
        summary: `在 ${eligible ?? 0} 次可以完整判断的阵亡中，有 ${f.occurrences} 次只有你在这次交火里留下了伤害或击杀记录，之后也没有记录到队友对同一名击杀者造成伤害或击杀。` };
    case 'deep.teamplay.no-followup-pattern': {
      const window = num(f.facts, 'followUpWindowSeconds');
      const seconds = window === null ? '' : `${window} 秒内，`;
      return { ...copy, title: '队友阵亡后，同一交火中的后续跟进',
        summary: `在 ${eligible ?? 0} 次“你在这次交火中也有伤害或击杀记录”的队友阵亡场景里，有 ${f.occurrences} 次在队友阵亡后的 ${seconds}没有记录到你对同一名击杀者造成伤害或击杀。` };
    }
    case 'deep.utility.teamflash-repeated':
      return { ...copy, title: '多次闪光弹影响到队友',
        summary: `有 ${num(f.facts, 'teamFlashEffects') ?? 0} 颗可以明确归属到你的闪光弹影响了队友，共记录到 ${num(f.facts, 'teammateEffects') ?? 0} 次队友受闪。` };
    default:
      return { ...copy, title: '深度复盘结论', summary: '这条结论只依据录像里能够明确记录的事实。' };
  }
}
