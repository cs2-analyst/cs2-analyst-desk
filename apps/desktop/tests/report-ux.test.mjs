import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { registerHooks, createRequire } from 'node:module';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Listbox, SSRProvider } from '@fluentui/react-components';

// Transform the actual TSX components in memory, without adding a test build or UI seam.
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
  if (url.endsWith('/replay-map-assets.ts')) return { format: 'module', shortCircuit: true, source: 'export const replayMapAssets={};' };
  if (/\.(svg|png)$/.test(url)) return { format: 'module', shortCircuit: true, source: 'export default ' + JSON.stringify(new URL(url).pathname) + ';' };
  if (url.endsWith('.tsx')) return { format: 'module', shortCircuit: true,
    source: transformSync(readFileSync(new URL(url), 'utf8'), { loader: 'tsx', jsx: 'automatic', format: 'esm' }).code };
  return nextLoad(url, context);
} });
const { KillFeedEvent } = await import('../renderer/src/killfeed-event.tsx');
const { WeaponIcon, weaponLabels } = await import('../renderer/src/killfeed-icons.tsx');
const { weaponAsset, killfeedWeaponAssets, killfeedDeathNoticeAssets } = await import('../renderer/src/killfeed-assets.ts');
const { DeepReview } = await import('../renderer/src/deep-review.tsx');
const { AnalysisViews } = await import('../renderer/src/analysis-views.tsx');
const { HeatmapView, HeatmapLayerDetails } = await import('../renderer/src/heatmap-view.tsx');
const { ReplayPlayer } = await import('../renderer/src/replay-player.tsx');
const { WinOption } = await import('../renderer/src/winui-option.tsx');
const { fixture: heatmapFixture, map: heatmapMap } = await import('./heatmap-fixture.mjs');
const { projectMapHeatmap } = await import('../shared/heatmap.ts');
const { utilityDamageRows, utilityThrowRows } = await import('../renderer/src/utility-display.ts');
const render = element => renderToStaticMarkup(createElement(SSRProvider, null, element));


test('WinUI options retain Fluent selection semantics without the default leading checkmark', () => {
  const html = render(createElement(Listbox, { selectedOptions: ['R7'] },
    createElement(WinOption, { value: 'R1' }, 'R1'),
    createElement(WinOption, { value: 'R7' }, 'R7')));
  assert.equal([...html.matchAll(/role="option"/g)].length, 2);
  assert.equal([...html.matchAll(/aria-selected="true"/g)].length, 1);
  assert.equal([...html.matchAll(/aria-selected="false"/g)].length, 1);
  assert.equal(html.includes('fui-Option__checkIcon'), false, 'native check icon slot is intentionally suppressed');
});

test('heatmap missing metadata renders independent disabled layers, all filters, and honest map/source limits', () => {
  const html = render(createElement(HeatmapView, { players: [], active: true, sessionActive: true }));
  for (const text of ['玩家位置密度', '击杀位置', '死亡位置', '热力图玩家', '热力图阵营', '热力图回合', '热力图楼层', '热力图分辨率', '热力图采样集', '包含冻结时间', '热力图元数据不可用', '地图映射或资源不可用', '不代表连续停留时间']) assert.ok(html.includes(text), text);
  assert.equal([...html.matchAll(/aria-pressed="false"/g)].length, 3);
});

test('heatmap defaults to the available position layer only and keeps unavailable sources off', () => {
  const metadata = {
    schemaVersion: 1, sessionId: 'session', matchId: 'match', available: true, unavailableReason: null,
    layers: { positions: { available: true, unavailableReason: null }, kills: { available: true, unavailableReason: null }, deaths: { available: true, unavailableReason: null } },
    map: { id: 'synthetic', resourceId: 'test', alignment: 'unconfirmed', precision: 'schematic-position-distribution' },
    samplingVersion: 'test', resolutions: [16, 32, 64], playerIds: ['1'], rounds: [1, 2], floors: ['default'],
  };
  const html = render(createElement(HeatmapView, { metadata, players: [{ id: '1', nickname: 'A' }], active: true, sessionActive: true }));
  assert.ok(html.includes('data-heatmap-enabled="positions"'));
  assert.equal([...html.matchAll(/aria-pressed="true"/g)].length, 1);
  assert.equal([...html.matchAll(/aria-pressed="false"/g)].length, 2);
  const unavailable = { ...metadata, layers: { ...metadata.layers, positions: { available: false, unavailableReason: 'replay-unavailable' } } };
  const off = render(createElement(HeatmapView, { metadata: unavailable, players: [{ id: '1', nickname: 'A' }], active: true, sessionActive: true }));
  assert.ok(off.includes('data-heatmap-enabled=""'));
  assert.equal([...off.matchAll(/aria-pressed="false"/g)].length, 3);
  assert.ok(off.includes('位置回放源不可用'));
});

test('utility tabs merge the two fire grenades and never confuse missing metrics with zero', () => {
  const utility = {
    throws: { flash: 0, smoke: 0, he: 0, incendiary: 2, molotov: 3, decoy: 0 },
    heDamage: 0, fireDamage: 0, enemyFlashEffects: 30, teamFlashEffects: 13, flashAssists: 2,
    flashEffectsComplete: true,
  };
  const throws = utilityThrowRows(utility);
  assert.deepEqual(throws.map(row => row.label), ['闪光弹', '烟雾弹', '高爆手雷', '燃烧弹', '诱饵弹']);
  assert.equal(throws.find(row => row.label === '燃烧弹').value, '5', 'incendiary + molotov throws are summed');
  assert.equal(throws.some(row => row.label === '燃烧瓶'), false);
  assert.ok(throws.every(row => row.value === '0' || row.value === '5'), 'legitimate zero stays 0');
  const damage = utilityDamageRows(utility);
  assert.deepEqual(damage.map(row => row.label), throws.map(row => row.label), 'same names in both tabs');
  assert.equal(damage.find(row => row.label === '闪光弹').value, '30/13/2');
  assert.equal(damage.find(row => row.label === '闪光弹').order, '致盲敌人 / 队友受闪 / 闪光助攻');
  assert.equal(damage.find(row => row.label === '烟雾弹').value, '-');
  assert.equal(damage.find(row => row.label === '诱饵弹').value, '-');
  assert.equal(damage.find(row => row.label === '高爆手雷').value, '0 点');
  assert.equal(damage.find(row => row.label === '燃烧弹').value, '0 点');
  const unavailable = { ...utility, throws: { ...utility.throws, incendiary: null, molotov: null },
    heDamage: null, fireDamage: null, flashAssists: null };
  assert.equal(utilityThrowRows(unavailable).find(row => row.label === '燃烧弹').value, '—');
  assert.equal(utilityDamageRows(unavailable).find(row => row.label === '高爆手雷').value, '—');
  assert.equal(utilityDamageRows(unavailable).find(row => row.label === '燃烧弹').value, '—');
  assert.equal(utilityDamageRows(unavailable).find(row => row.label === '闪光弹').value, '30/13/—');
});

test('replay surface is named 比赛回放 in its title, aria label and unavailable fallback', () => {
  const metadata = { schemaVersion: 1, available: false, unavailableReason: '本场缺少可靠回放窗口', sessionId: null, matchId: 'm', map: 'de_dust2',
    resourceId: 'de_dust2', samplingVersion: 'test', tickRate: 64, maxInterpolationTicks: 8, perspective: 'global', players: [], rounds: [], excludedRounds: [] };
  const html = render(createElement(ReplayPlayer, { metadata, fileName: 'dust2.dem', initialPlayerId: '1', active: false, jump: null }));
  assert.ok(html.includes('比赛回放'));
  assert.ok(html.includes('aria-label="比赛回放"'));
  assert.equal(html.includes('地图回放'), false);
  assert.equal(html.includes('2D 地图回放'), false);
});

test('replay transport has five icon controls, round-relative time and filename without paths; unreliable rate disables timed controls', () => {
  const metadata = { available: true, sessionId: 's', matchId: 'm', map: 'de_dust2', tickRate: 128, players: [], excludedRounds: [],
    rounds: [{ round: 1, startTick: 12000, endTick: 23680, freezeEndTick: null, blocks: [{ index: 0, startTick: 12000, endTick: 23680 }] }] };
  const props={metadata,fileName:'C:\\private\\'+ 'long-demo-name-'.repeat(20)+'.dem',initialPlayerId:'',active:true,jump:null};
  const html=render(createElement(ReplayPlayer,props));
  assert.ok(html.includes('00:00')&&html.includes('01:31'));
  assert.ok(html.includes('data-replay-filename'));
  assert.equal(html.includes('private'),false);
  const controls=html.slice(html.indexOf('aria-label="回放播放控制"'),html.indexOf('</div>',html.indexOf('aria-label="回放播放控制"')));
  assert.equal([...controls.matchAll(/<button\b/g)].length,5);
  for(const label of ['回到最初','倒退 10 秒','播放回放','前进 30 秒','直达最后'])assert.ok(controls.includes(`aria-label="${label}"`));
  assert.equal(controls.includes('>播放<'),false);
  const unknown=render(createElement(ReplayPlayer,{...props,metadata:{...metadata,tickRate:null}}));
  assert.ok(unknown.includes('原始 tick 12000')&&unknown.includes('原始 tick 23680'));
  for(const label of ['倒退 10 秒','播放回放','前进 30 秒'])assert.match(unknown,new RegExp(`<button[^>]*aria-label="${label}"[^>]*disabled`));
  for(const label of ['回到最初','直达最后'])assert.doesNotMatch(unknown,new RegExp(`<button[^>]*aria-label="${label}"[^>]*disabled`));
  for(const tickRate of [0,-1,NaN,Infinity]){
    const invalid=render(createElement(ReplayPlayer,{...props,metadata:{...metadata,tickRate}}));
    assert.match(invalid,/aria-valuetext="原始 tick 12000"/);
    assert.equal(invalid.includes('NaN 秒')||invalid.includes('Infinity 秒'),false);
  }
});

test('heatmap details distinguish zero events, undefined ratios, source loss and filtered population', () => {
  const f = heatmapFixture();
  const empty = projectMapHeatmap(f.match, f.replay, f.spatial, { rounds: [] }, heatmapMap);
  const html = render(createElement(HeatmapLayerDetails, { layer: 'kills', projection: empty, cellIndex: 0 }));
  assert.ok(html.includes('当前筛选范围内没有可统计事件'));
  assert.ok(html.includes('事件位置覆盖率：—')); assert.ok(html.includes('相对强度：—')); assert.ok(html.includes('无可聚合数据'));
  const positions = projectMapHeatmap(f.match, f.replay, f.spatial, { side: 'CT' }, heatmapMap);
  const selected = render(createElement(HeatmapLayerDetails, { layer: 'positions', projection: positions, cellIndex: 0 }));
  for (const text of ['当前所选有效位置采样：1', '阵营与楼层筛选前有效采样：2', '位置覆盖率：100.0%', '位置完整度：100.0%', '筛选后位置覆盖率：50.0%', '采样机会分母：2', '不代表玩家在场上的时间比例']) assert.ok(selected.includes(text), text);
  const noReplay = projectMapHeatmap(f.match, null, f.spatial, {}, heatmapMap);
  assert.ok(render(createElement(HeatmapLayerDetails, { layer: 'positions', projection: noReplay, cellIndex: null })).includes('位置回放源不可用'));
  f.replay.hz = 16;
  const noUniform = projectMapHeatmap(f.match, f.replay, f.spatial, { samplingSet: 'uniform-8hz' }, heatmapMap);
  assert.ok(render(createElement(HeatmapLayerDetails, { layer: 'positions', projection: noUniform, cellIndex: null })).includes('采样集不适用于此回放'));
});

test('kill feed renders flags only when true, fallback weapon and complete accessible text', () => {
  const event = { id: 'synthetic', type: 'kill', tick: 100, roundTimeSeconds: 122.2,
    actorId: '1', actorName: ' twinkle ', targetId: '2', targetName: '8'.repeat(40), weapon: 'unrecognized_weapon' };
  for (const headshot of [undefined, false, true]) {
    const html = render(createElement(KillFeedEvent, { event: { ...event, headshot, assistedFlash: headshot }, round: 24 }));
    assert.ok(html.includes('data-killfeed-icon="generic"'));
    assert.ok(html.includes('使用 unrecognized_weapon 击杀'));
    assert.ok(html.includes('R24 回合开始后 122.20 秒'));
    assert.ok(html.includes(' twinkle ') && html.includes(event.targetName));
    assert.equal(html.includes('data-killfeed-icon="headshot"'), headshot === true);
    assert.equal(html.includes('/death-notice/icon_headshot.svg'), headshot === true);
    assert.equal(html.includes('/death-notice/flashbang_assist.svg'), headshot === true);
    assert.equal(html.includes('data-killfeed-icon="flash"'), headshot === true);
    assert.ok(!html.includes('→'));
  }
  const world = render(createElement(KillFeedEvent, { event: { ...event, actorId: undefined, actorName: undefined }, round: 1 }));
  assert.ok(world.includes('世界伤害 / 无已知攻击者'));
  assert.ok(world.includes('data-killfeed-icon="world"'));
  assert.ok(world.includes('阵亡'));
});

test('all mapped weapons use bundled official images, with distinct knife variants', () => {
  for (const weapon of Object.keys(killfeedWeaponAssets)) {
    const html = renderToStaticMarkup(createElement(WeaponIcon, { weapon }));
    assert.ok(html.includes('<img') && html.includes('alt=""') && html.includes('aria-hidden="true"'), weapon);
    assert.ok(!html.includes('<path') && !html.includes('data-killfeed-icon="generic"'), weapon);
    assert.ok(existsSync(new URL('file://' + weaponAsset(weapon))), weapon);
  }
  for (const weapon of ['ak47', 'awp', 'm4a1_silencer', 'hegrenade', 'inferno', 'knife_butterfly']) {
    assert.ok(weaponAsset(weapon).endsWith('/' + weapon + '.svg'), weapon);
  }
  assert.notEqual(weaponAsset('knife_butterfly'), weaponAsset('knife'));
  assert.equal(weaponAsset('knife_bayonet'), weaponAsset('bayonet'));
  assert.equal(weaponAsset('kukri'), weaponAsset('knife_kukri'));
  for (const weapon of [undefined, 'unknown_weapon', 'knife_unknown', '__proto__', 'constructor', 'toString', 'world']) {
    assert.equal(weaponAsset(weapon), undefined);
    assert.ok(renderToStaticMarkup(createElement(WeaponIcon, { weapon })).includes('<svg'));
  }
  for (const weapon of Object.keys(weaponLabels).filter(w => w !== 'world')) assert.ok(weaponAsset(weapon), weapon);
  assert.ok(killfeedDeathNoticeAssets.headshot.endsWith('/icon_headshot.svg'));
  assert.ok(killfeedDeathNoticeAssets.flashAssist.endsWith('/flashbang_assist.svg'));
});

test('official assets retain extraction bytes and independently gated death notices', () => {
  const base = new URL('../renderer/src/assets/killfeed/', import.meta.url);
  const provenance = JSON.parse(readFileSync(new URL('provenance.json', base), 'utf8'));
  for (const asset of provenance.assets) {
    const bytes = readFileSync(new URL(asset.asset, base));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.sha256, asset.asset);
  }
  const html = render(createElement(KillFeedEvent, { round: 1, event: {
    id: 'flash', type: 'kill', tick: 100, actorId: 'a', actorName: 'A', targetName: 'B',
    weapon: 'ak47', assistedFlash: true, headshot: false,
  } }));
  assert.ok(html.includes('/death-notice/flashbang_assist.svg'));
  assert.ok(html.includes('data-killfeed-icon="flash"'));
  assert.ok(!html.includes('data-killfeed-icon="headshot"'));
  const headshotHtml = render(createElement(KillFeedEvent, { round: 1, event: {
    id: 'headshot', type: 'kill', tick: 100, actorId: 'a', actorName: 'A', targetName: 'B',
    weapon: 'awp', headshot: true, assistedFlash: false,
  } }));
  assert.ok(headshotHtml.includes('/death-notice/icon_headshot.svg'));
  assert.ok(headshotHtml.includes('data-killfeed-icon="headshot"'));
  assert.ok(!headshotHtml.includes('data-killfeed-icon="flash"'));
});

test('multi-kill summary omits zeros and the whole empty group, retaining five-or-more wording', () => {
  const side = { roundsPlayed: 1, kills: 0, deaths: 0, assists: 0, adr: null };
  const renderSummary = multiKills => render(createElement(AnalysisViews, { playerId: '1', analysis: {
    players: [], perPlayer: [{ playerId: '1', multiKills, roundTrend: [], sideSplit: { CT: side, T: side } }],
  } }));
  const empty = renderSummary({ double: 0, triple: 0, quad: 0, fivePlus: 0 });
  assert.ok(!empty.includes('多杀回合统计'));
  const mixed = renderSummary({ double: 3, triple: 0, quad: 1, fivePlus: 2 });
  assert.ok(mixed.includes('双杀 3') && mixed.includes('四杀 1') && mixed.includes('五杀+ 2'));
  assert.ok(!mixed.includes('data-multi-kill="triple"'));
  assert.ok(!mixed.includes('最大柱'));
});

const deepFinding = (kind, extra = {}) => ({
  id: kind, ruleId: 'deep.test.' + kind, category: kind === 'review' ? 'execution' : kind === 'highlight' ? 'impact' : 'teamplay',
  kind, title: '可以用一句话读懂的重点 ' + kind, summary: '这条结论只依据录像中能够明确记录的伤害与击杀。',
  occurrences: 6, eligibleOccurrences: 10, relatedRounds: [3, 7], occurrenceLabel: '符合此情况：6 / 10 次', caveats: [], ...extra,
});
test('Deep Review renders adapted copy, plain-language limits and no internal evidence labels', () => {
  const player = { playerId: '76561198000000000', coverage: { status: 'partial' },
    reviews: [deepFinding('review', { caveats: ['这项结果只表示录像中是否记录到后续伤害或击杀，不能据此判断你的反应速度或枪法。'],
      evidenceRefs: [{ engagementId: 'raw-engagement', eventIndex: 123, tick: 99999 }] })],
    highlights: [deepFinding('highlight')], contexts: [deepFinding('context')] };
  const html = render(createElement(DeepReview, { player, onShowRounds: () => {} }));
  for (const text of ['优先复盘', '复盘重点', '亮点', '补充观察', '符合此情况：6 / 10 次', '说明与限制',
    '这项结果只表示录像中是否记录到后续伤害或击杀', '查看 2 个相关回合']) assert.ok(html.includes(text), text);
  assert.ok(html.includes('<details>') && !html.includes('<details open'));
  const text = html.replace(/<[^>]*>/g, '');
  for (const token of ['76561198000000000', 'raw-engagement', 'eventIndex', '99999', 'tick', '部分证据', '证据边界', '上下文',
    'Engagement', 'direct contact', 'evidence', 'partial', 'coverage', 'linkage', 'received', 'return contact', 'same-tick', 'fireEvidence',
    '严重', '高危', '需要改进']) assert.ok(!text.includes(token), token);
  const labels = [...html.matchAll(/data-deep-label="(.*?)"[^>]*class="([^"]+)"/g)];
  assert.equal(labels.length, 3);
  assert.equal(new Set(labels.map(m => m[2])).size, 3, 'three distinct Fluent badge styles');
});
test('Deep Review permits empty and unavailable evidence without fallback cards', () => {
  for (const status of ['complete', 'partial', 'unavailable']) {
    const html = render(createElement(DeepReview, { player: { playerId: '1', coverage: { status }, reviews: [], highlights: [], contexts: [] }, onShowRounds: () => {} }));
    assert.ok(html.includes('本场没有生成深度复盘结论。'));
    assert.ok(html.includes('本场没有生成优先复盘结论。'));
    assert.ok(!html.includes('本场没有需要优先复盘的问题。'));
    assert.ok(!html.includes('data-deep-kind='));
    assert.equal(html.includes('基础比赛报告仍可查看'), status === 'unavailable');
  }
});
