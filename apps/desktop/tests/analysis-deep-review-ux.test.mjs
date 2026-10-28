import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { registerHooks, createRequire } from 'node:module';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SSRProvider } from '@fluentui/react-components';

// Transform the shipped TSX components in memory. No renderer test seam is added.
const require = createRequire(import.meta.url);
const { transformSync } = createRequire(require.resolve('vite'))('esbuild');
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('./') && context.parentURL?.includes('/renderer/src/')) {
    for (const extension of ['.tsx', '.ts']) {
      const url = new URL(specifier + extension, context.parentURL);
      if (existsSync(url)) return nextResolve(url.href, context);
    }
  }
  return nextResolve(specifier, context);
}, load(url, context, nextLoad) {
  if (url.endsWith('.tsx')) return { format: 'module', shortCircuit: true,
    source: transformSync(readFileSync(new URL(url), 'utf8'), { loader: 'tsx', jsx: 'automatic', format: 'esm' }).code };
  return nextLoad(url, context);
} });
const { AnalysisViews } = await import('../renderer/src/analysis-views.tsx');
const { SpatialFactsView } = await import('../renderer/src/spatial-facts-view.tsx');
const { DeepReview, DEEP_REVIEW_HELP, DEEP_REVIEW_PARTIAL_HELP } = await import('../renderer/src/deep-review.tsx');
const render = element => renderToStaticMarkup(createElement(SSRProvider, null, element));
const tag = (html, marker) => html.match(new RegExp('<[^>]*' + marker + '[^>]*>'))?.[0] ?? '';

const side = { roundsPlayed: 12, kills: 10, deaths: 10, assists: 3, adr: 68.25 };
const comparison = (playerId, playerName, adr) => ({
  playerId, playerName, adr, kdRatio: 1.25, kastPercentage: 75, headshotPercentage: 50,
  openingWinRate: 0.5, tradeRate: 22.2, tradeKills: 2, kastComplete: true, tradeComplete: true,
});
const analysis = (players = [comparison('1', 'Alpha', 91.38), comparison('2', 'Bravo', 68.25)]) => ({
  players,
  perPlayer: players.length ? [{
    playerId: players[0].playerId,
    multiKills: { double: 1, triple: 0, quad: 0, fivePlus: 0 },
    roundTrend: [
      { round: 1, side: 'CT', result: 'win', complete: true, kills: 3, died: false },
      { round: 2, side: 'T', result: 'loss', complete: true, kills: 1, died: true },
    ],
    sideSplit: { CT: side, T: side },
  }] : [],
});
const finding = (kind, extra = {}) => ({
  id: kind, ruleId: 'deep.test.' + kind, category: 'execution', kind,
  title: '可以快速读懂的重点 ' + kind, summary: '这条结论只依据录像中能够明确记录的伤害与击杀。',
  occurrences: 2, eligibleOccurrences: 4, relatedRounds: [3, 7],
  occurrenceLabel: '符合此情况：2 / 4 次', caveats: ['这项结果只表示录像中是否记录到后续伤害或击杀。'], ...extra,
});
const deepPlayer = (status = 'complete', populated = true) => ({
  playerId: '1', coverage: { status },
  reviews: populated ? [finding('review')] : [],
  highlights: populated ? [finding('highlight')] : [],
  contexts: populated ? [finding('context')] : [],
});

test('analysis keeps four mounted panels and defaults to player comparison', () => {
  const html = render(createElement(AnalysisViews, { analysis: analysis(), playerId: '1' }));
  assert.equal([...html.matchAll(/data-analysis-tab="/g)].length, 4);
  assert.equal([...html.matchAll(/data-analysis-panel="/g)].length, 4);
  assert.ok(tag(html, 'data-analysis-tab="comparison"').includes('aria-selected="true"'));
  assert.ok(!tag(html, 'data-analysis-panel="comparison"').includes('hidden'));
  assert.ok(tag(html, 'data-analysis-panel="trend"').includes('hidden'));
  assert.ok(tag(html, 'data-analysis-panel="sides"').includes('hidden'));
  assert.ok(tag(html, 'data-analysis-panel="spatial"').includes('hidden'));
  assert.equal([...html.matchAll(/data-comparison-player=/g)].length, 2);
  assert.equal([...html.matchAll(/data-trend-round=/g)].length, 2);
  assert.equal([...html.matchAll(/data-analysis-side=/g)].length, 2);
  for (const text of ['全场玩家对比', '回合表现趋势', 'CT / T 表现对比', '空间事实', '按所选指标降序']) assert.ok(html.includes(text), text);
});

test('analysis tabs survive missing comparison and per-player data with honest empty states', () => {
  const noPlayers = render(createElement(AnalysisViews, { analysis: analysis([]), playerId: '1' }));
  assert.equal([...noPlayers.matchAll(/data-analysis-tab="/g)].length, 4);
  assert.ok(noPlayers.includes('这场没有可用的玩家对比数据。'));
  assert.ok(noPlayers.includes('当前玩家没有可用的回合趋势数据。'));
  assert.ok(noPlayers.includes('当前玩家没有可用的 CT / T 对比数据。'));
  const noCurrent = render(createElement(AnalysisViews, { analysis: { ...analysis(), perPlayer: [] }, playerId: '1' }));
  assert.equal([...noCurrent.matchAll(/data-analysis-tab="/g)].length, 4);
  assert.ok(noCurrent.includes('当前玩家没有可用的回合趋势数据。'));
  assert.ok(noCurrent.includes('当前玩家没有可用的 CT / T 对比数据。'));
});

test('spatial facts show exact server values, limits and honest legacy/unavailable states', () => {
  const legacy = render(createElement(SpatialFactsView, { players: analysis().players }));
  assert.ok(legacy.includes('此归档尚未计算空间事实'));
  const unavailable = render(createElement(SpatialFactsView, { players: analysis().players,
    facts: { status: 'unavailable', reason: 'extraction-failed' } }));
  assert.ok(unavailable.includes('空间事实暂时无法计算'));
  const limited = render(createElement(SpatialFactsView, { players: analysis().players,
    facts: { status: 'unavailable', reason: 'no-valid-facts', coverage: { truncated: true, withheld: 2 } } }));
  assert.ok(limited.includes('已检查的范围内'));
  assert.ok(limited.includes('后续内容未评估'));
  assert.ok(limited.includes('证据不足或冲突'));
  const facts = { status: 'partial', coverage: { inspectedTicks: 8, deathTicks: 9, withheld: 1, truncated: true },
    cards: [{ kind: 'event-prestate', round: 3, eventTick: 40, sampleTick: 39,
      participants: [{ role: 'killer', playerId: '1', side: 'CT', position: { x: 0, y: 0, z: 0 } },
        { role: 'victim', playerId: '2', side: 'T', position: { x: 3, y: 4, z: 12 } }],
      horizontal: 5, threeDimensional: 13 }] };
  const html = render(createElement(SpatialFactsView, { facts, players: analysis().players, onReplay: () => {} }));
  for (const text of ['服务器空间事实', '击杀事件前状态', 'tick 39', '水平距离 5.0', '三维距离 13.0',
    '不证明视野', '查看回放']) assert.ok(html.includes(text), text);
  assert.ok(tag(html, 'data-spatial-card="event-prestate"').length > 0);
  const formation = { ...facts, cards: [{ kind: 'one-vs-one-formation', round: 3, eventTick: 40, startTick: 30,
    interiorNotEvaluatedTicks: 9, separation: { startHorizontal: 5, formationHorizontal: 10,
      startThreeDimensional: 5, formationThreeDimensional: 10 },
    participants: [{ playerId: '1', side: 'CT', startPosition: { x: 1, y: 2, z: 3 },
      endPosition: { x: 4, y: 5, z: 6 }, horizontalDisplacement: 3, threeDimensionalDisplacement: 4 },
    { playerId: '2', side: 'T', startPosition: { x: 7, y: 8, z: 9 },
      endPosition: { x: 10, y: 11, z: 12 }, horizontalDisplacement: 3, threeDimensionalDisplacement: 4 }] }] };
  const formationHtml = render(createElement(SpatialFactsView, { facts: formation, players: analysis().players }));
  for (const text of ['起点 XYZ：1.0, 2.0, 3.0', '形成时 XYZ：4.0, 5.0, 6.0']) assert.ok(formationHtml.includes(text), text);
});

test('deep review keeps all three tabs mounted and defaults to priority reviews', () => {
  const html = render(createElement(DeepReview, { player: deepPlayer(), onShowRounds: () => {} }));
  assert.equal([...html.matchAll(/data-deep-tab="/g)].length, 3);
  assert.equal([...html.matchAll(/data-deep-panel="/g)].length, 3);
  assert.ok(tag(html, 'data-deep-tab="reviews"').includes('aria-selected="true"'));
  assert.ok(!tag(html, 'data-deep-panel="reviews"').includes('hidden'));
  assert.ok(tag(html, 'data-deep-panel="highlights"').includes('hidden'));
  assert.ok(tag(html, 'data-deep-panel="contexts"').includes('hidden'));
  assert.equal([...html.matchAll(/data-deep-kind=/g)].length, 3, 'all cards stay mounted for state preservation');
  for (const text of ['优先复盘', '亮点', '补充观察', '查看 2 个相关回合', '说明与限制']) assert.ok(html.includes(text), text);
  assert.ok(tag(html, 'data-deep-help').includes('aria-label="深度复盘说明"'));
  assert.equal(html.includes('data-deep-partial-help'), false, 'complete coverage has no warning icon');
});

test('deep review tooltips preserve the full help copy and warn only on partial coverage', () => {
  assert.equal(DEEP_REVIEW_HELP, '根据 DEM 中能够明确记录的交火、人数变化、队友跟进和道具效果生成。');
  assert.equal(DEEP_REVIEW_PARTIAL_HELP, '这场录像中有部分记录无法完整判断，具体限制可在每张卡片的「说明与限制」中查看。');
  const partial = render(createElement(DeepReview, { player: deepPlayer('partial'), onShowRounds: () => {} }));
  assert.ok(tag(partial, 'data-deep-partial-help').includes('aria-label="部分记录限制说明"'));
  const complete = render(createElement(DeepReview, { player: deepPlayer('complete'), onShowRounds: () => {} }));
  assert.equal(complete.includes('data-deep-partial-help'), false);
});

test('each deep review tab owns its required empty copy without implying a perfect match', () => {
  const html = render(createElement(DeepReview, { player: deepPlayer('complete', false), onShowRounds: () => {} }));
  for (const [kind, copy] of [
    ['reviews', '这场暂时没有需要重点复盘的地方，先把好状态保持住。'],
    ['highlights', '高光可能在路上，这场还没有足够证据点亮它。'],
    ['contexts', '观察哨今天很安静，没有额外值得补充的记录。'],
  ]) {
    assert.ok(tag(html, 'data-deep-empty="' + kind + '"').length > 0, kind);
    assert.ok(html.includes(copy), copy);
  }
  assert.equal([...html.matchAll(/data-deep-kind=/g)].length, 0);
  assert.ok(!html.includes('本场没有生成深度复盘结论。'));
});

test('unavailable deep review keeps a visible error and never masks it with playful empty states', () => {
  const html = render(createElement(DeepReview, { player: deepPlayer('unavailable', false), onShowRounds: () => {} }));
  assert.equal([...html.matchAll(/data-deep-tab="/g)].length, 3, 'tabs remain present when the source is unavailable');
  assert.ok(html.includes('本场录像无法用于深度复盘，基础比赛报告仍可查看。'));
  assert.equal([...html.matchAll(/data-deep-unavailable-panel=/g)].length, 3);
  for (const copy of ['先把好状态保持住', '高光可能在路上', '观察哨今天很安静']) assert.equal(html.includes(copy), false, copy);
});
