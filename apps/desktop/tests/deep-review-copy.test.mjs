import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adaptDeepReviewFinding } from '../electron/deep-review-copy.ts';
import { analyzeDeepReviewFindings } from '@cs2-analyst/deep-review';
import { match as syntheticMatch, inputs as findingsInputs, damage, kill } from '../../../packages/deep-review/tests/findings-fixture.mjs';

/** Internal domain vocabulary that must never reach user-visible Deep Review text. */
const INTERNAL_TERMS = ['Engagement', 'direct contact', 'evidence', 'partial', 'coverage', 'linkage',
  'received', 'return contact', 'same-tick', 'eventIndex', 'fireEvidence', 'denominator',
  'confirmed return', 'confirmed contact'];

const finding = (ruleId, facts, extra = {}) => ({
  id: 'deep-finding:' + ruleId, ruleId, playerId: '1',
  category: ruleId.includes('.execution.') ? 'execution' : ruleId.includes('.teamplay.') ? 'teamplay'
    : ruleId.includes('.utility.') ? 'utility' : 'impact',
  kind: 'context', title: 'domain raw title', summary: 'domain raw summary',
  occurrences: 5, eligibleOccurrences: 10, relatedRounds: [24], evidenceRefs: [],
  facts, evidenceQuality: 'partial', caveats: [], ...extra,
});

const audit = copy => {
  const text = [copy.title, copy.summary, copy.occurrenceLabel ?? '', ...copy.caveats].join('\n');
  for (const token of INTERNAL_TERMS) assert.ok(!text.includes(token), `${token} leaked: ${text}`);
  return text;
};

test('every Deep Review rule has plain-language product copy without internal vocabulary', () => {
  const cases = [
    ['deep.impact.multikill-swing', { sequenceRound: 24, killCount: 4, roundResult: 'win', equalizer: true, advantageGain: true, enemyEliminated: true, soleSurvivor: false, unconverted: false }],
    ['deep.impact.sole-survivor-sequence', { sequenceRound: 24, killCount: 4, roundResult: 'win', equalizer: true, advantageGain: true, enemyEliminated: true, soleSurvivor: true, unconverted: false }],
    ['deep.impact.sole-survivor-sequence', { sequenceRound: 7, killCount: 2, roundResult: 'loss', equalizer: false, advantageGain: false, enemyEliminated: false, soleSurvivor: true, unconverted: false }],
    ['deep.impact.multikill-unconverted', { sequenceRound: 9, killCount: 3, roundResult: 'loss', equalizer: true, advantageGain: false, enemyEliminated: false, soleSurvivor: false }],
    ['deep.execution.no-confirmed-return-pattern', { noneObserved: 5, confirmedReturns: 5, receivedOnly: 3, denominator: 'exact-received-first-opponent-exchanges' }],
    ['deep.execution.return-contact-consistent', { noneObserved: 0, confirmedReturns: 5, receivedOnly: 3, denominator: 'exact-received-first-opponent-exchanges' }],
    ['deep.teamplay.lone-contact-death-pattern', { loneContactDeaths: 5, followUpWindowSeconds: 5 }],
    ['deep.teamplay.no-followup-pattern', { noneObserved: 4, followUpWindowSeconds: 5, denominator: 'same-engagement-confirmed-participants' }],
    ['deep.utility.teamflash-repeated', { exactFlashEffects: 6, teamFlashEffects: 3, teammateEffects: 6 }],
  ];
  for (const [ruleId, facts] of cases) {
    const copy = adaptDeepReviewFinding(finding(ruleId, facts));
    audit(copy);
    assert.ok(copy.title.length > 4, ruleId);
    assert.ok(copy.summary.endsWith('。'), ruleId);
    if (ruleId.startsWith('deep.impact.')) assert.equal(copy.occurrenceLabel, null, `${ruleId} must not expose the candidate count`);
    else assert.match(copy.occurrenceLabel, /^符合此情况：\d+ \/ \d+ 次$/, ruleId);
    assert.ok(copy.caveats.length > 0, `${ruleId} must keep its limitation note`);
  }
});

test('impact copy states the round, kills and real transitions as natural sentences', () => {
  const swing = adaptDeepReviewFinding(finding('deep.impact.multikill-swing',
    { sequenceRound: 24, killCount: 4, roundResult: 'win', equalizer: true, advantageGain: true, enemyEliminated: true }));
  assert.equal(swing.title, 'R24 的 4K 改变了人数局面');
  assert.equal(swing.summary, '你在 R24 完成 4K，期间你曾扳平人数、帮助队伍取得人数优势，并最终清空对手；这个回合最终获胜。');

  const lost = adaptDeepReviewFinding(finding('deep.impact.multikill-unconverted',
    { sequenceRound: 9, killCount: 3, roundResult: 'loss' }));
  assert.equal(lost.title, 'R9 完成 3K，但回合最终失利');
  assert.equal(lost.summary, '你在 R9 完成 3 次击杀，但这个回合最终没有拿下。');

  const sole = adaptDeepReviewFinding(finding('deep.impact.sole-survivor-sequence',
    { sequenceRound: 7, killCount: 2, roundResult: 'loss' }));
  assert.equal(sole.title, 'R7：队伍只剩你一人时继续拿到击杀');
  assert.equal(sole.summary, '你在 R7 共完成 2 次击杀，并在队伍只剩你一人存活后继续拿到击杀；该回合最终失利。');
  for (const copy of [swing, lost, sole]) assert.equal(copy.occurrenceLabel, null);
});

test('impact findings never show the qualified-candidate occurrence label', () => {
  const rules = ['deep.impact.multikill-swing', 'deep.impact.sole-survivor-sequence', 'deep.impact.multikill-unconverted'];
  for (const ruleId of rules) {
    const copy = adaptDeepReviewFinding(finding(ruleId,
      { sequenceRound: 24, killCount: 4, roundResult: 'win', equalizer: true }, { occurrences: 1, eligibleOccurrences: 2 }));
    assert.equal(copy.occurrenceLabel, null, ruleId);
    assert.ok(!JSON.stringify(copy).includes('符合此情况'), ruleId);
  }
});

test('a merged sole-survivor sentence stays natural without a stiff connective', () => {
  const merged = adaptDeepReviewFinding(finding('deep.impact.sole-survivor-sequence',
    { sequenceRound: 24, killCount: 4, roundResult: 'win', equalizer: true, advantageGain: true, enemyEliminated: true, soleSurvivor: true }));
  assert.equal(merged.summary, '你在 R24 共完成 4 次击杀，期间你曾扳平人数、帮助队伍取得人数优势，并最终清空对手；随后在队伍只剩你一人存活时继续拿到击杀，该回合最终获胜。');
  assert.ok(!merged.summary.includes('；并且'));
});

test('pattern copy keeps the required negative/positive framing and the follow-up window', () => {
  const negative = adaptDeepReviewFinding(finding('deep.execution.no-confirmed-return-pattern',
    { noneObserved: 10, confirmedReturns: 8, denominator: 'exact-received-first-opponent-exchanges' },
    { occurrences: 10, eligibleOccurrences: 18 }));
  assert.equal(negative.title, '先被对手打到后的反击情况');
  assert.equal(negative.summary, '在 18 次你先被对手打到、且可以完整判断的交火中，有 10 次之后没有记录到你对同一对手造成伤害或击杀。');

  const positive = adaptDeepReviewFinding(finding('deep.execution.return-contact-consistent',
    {}, { occurrences: 12, eligibleOccurrences: 18 }));
  assert.equal(positive.title, '先被对手打到后，多次打回伤害');
  assert.equal(positive.summary, '在 18 次你先被对手打到、且可以完整判断的交火中，有 12 次你随后对同一对手造成了伤害或完成击杀。');

  const follow = adaptDeepReviewFinding(finding('deep.teamplay.no-followup-pattern',
    { followUpWindowSeconds: 5 }, { occurrences: 4, eligibleOccurrences: 9 }));
  assert.equal(follow.title, '队友阵亡后，同一交火中的后续跟进');
  assert.ok(follow.summary.includes('在队友阵亡后的 5 秒内，没有记录到你对同一名击杀者造成伤害或击杀。'));

  const flash = adaptDeepReviewFinding(finding('deep.utility.teamflash-repeated',
    { teamFlashEffects: 3, teammateEffects: 6 }, { occurrences: 3, eligibleOccurrences: 6 }));
  assert.equal(flash.title, '多次闪光弹影响到队友');
  assert.equal(flash.summary, '有 3 颗可以明确归属到你的闪光弹影响了队友，共记录到 6 次队友受闪。');
});

test('production no-followup rule copy preserves received-only participation after teammate death', () => {
  // Synthetic event evidence: the teammate dies at tick 100; the player first
  // participates by receiving damage at tick 140 and never deals damage or kills.
  const match = syntheticMatch(Array.from({ length: 5 }, () => [kill(100, '6', '2'), damage(140, '6', '1')]));
  const inputs = findingsInputs(match);
  const contexts = inputs.teamplay.playerEngagementContexts.filter(c => c.playerId === '1');
  assert.equal(contexts.length, 5);
  for (const context of contexts) {
    const death = inputs.teamplay.teammateDeathResponses.find(r => r.playerId === '1' && r.deathRef.round === context.round);
    assert.ok(context.firstContactTick > death.deathRef.tick);
    assert.equal(context.damageContactsReceived, 1);
    assert.equal(context.damageContactsDealt, 0);
    assert.equal(context.kills, 0);
    assert.equal(death.outcome, 'none-observed');
  }
  const finding = analyzeDeepReviewFindings(match, '1', inputs).contexts
    .find(f => f.ruleId === 'deep.teamplay.no-followup-pattern');
  assert.ok(finding, 'late received-only contact remains eligible under the existing domain rule');
  assert.equal(finding.occurrences, 5);
  assert.equal(finding.eligibleOccurrences, 5);
  const copy = adaptDeepReviewFinding(finding);
  const limitations = copy.caveats.join('\n');
  assert.match(limitations, /受到伤害或被击杀/);
  assert.match(limitations, /可能发生在队友阵亡之后/);
  assert.match(limitations, /不能证明你在阵亡前已经参与/);
  assert.match(limitations, /不等同于补枪失败/);
  audit(copy);
});

test('coverage caveat closing text matches the finding family and never leaks codes', () => {
  const partial = '未用于此规则的 fireEvidence 证据为 partial（same-tick-fire-contact-ambiguous）；不影响本规则使用的确认事实。';
  const execution = adaptDeepReviewFinding(finding('deep.execution.return-contact-consistent', {}, { caveats: [partial] }));
  assert.ok(execution.caveats.includes('部分开枪与伤害事件发生在同一游戏刻，无法判断严格先后；这不会影响本条结论所依据的伤害与击杀记录。'), JSON.stringify(execution.caveats));
  audit(execution);

  const impact = adaptDeepReviewFinding(finding('deep.impact.multikill-swing',
    { sequenceRound: 24, killCount: 4, roundResult: 'win' }, { caveats: [partial] }));
  assert.ok(impact.caveats.some(c => c.endsWith('这不会影响本条结论所依据的击杀和人数变化记录。')), JSON.stringify(impact.caveats));

  const teamplay = adaptDeepReviewFinding(finding('deep.teamplay.lone-contact-death-pattern', {}, {
    caveats: ['未用于此规则的 spatialContext 证据为 incomplete（position-missing）；不影响本规则使用的确认事实。'] }));
  assert.ok(teamplay.caveats.some(c => c.endsWith('这不会影响本条结论所依据的交火与阵亡记录。')), JSON.stringify(teamplay.caveats));
  audit(teamplay);

  const utility = adaptDeepReviewFinding(finding('deep.utility.teamflash-repeated',
    { teamFlashEffects: 3, teammateEffects: 6 }, { caveats: [partial] }));
  assert.ok(utility.caveats.some(c => c.endsWith('这不会影响本条结论所依据的闪光弹与受闪记录。')), JSON.stringify(utility.caveats));

  const noReason = adaptDeepReviewFinding(finding('deep.execution.no-confirmed-return-pattern', {}, {
    caveats: ['未用于此规则的 spatialContext 证据为 partial；不影响本规则使用的确认事实。'] }));
  assert.ok(noReason.caveats.some(c => c.includes('部分距离与位置信息无法完整判断')), JSON.stringify(noReason.caveats));
  audit(noReason);
});

test('an unknown rule id keeps a generic caveat closing without naming a data type', () => {
  const copy = adaptDeepReviewFinding(finding('deep.future.unknown-rule', { anything: 1 }, {
    caveats: ['未用于此规则的 fireEvidence 证据为 partial（same-tick-fire-contact-ambiguous）；不影响本规则使用的确认事实。'] }));
  audit(copy);
  assert.equal(copy.title, '深度复盘结论');
  assert.ok(!copy.summary.includes('domain raw'));
  assert.ok(copy.caveats.some(c => c.endsWith('这不会影响本条结论所使用的其他明确记录。')), JSON.stringify(copy.caveats));
});
