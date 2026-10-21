import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { registerHooks, createRequire } from 'node:module';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SSRProvider } from '@fluentui/react-components';

// Transform the real TSX components in memory, exactly like report-ux.test.mjs does.
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
  if (/\.(svg|png)$/.test(url)) return { format: 'module', shortCircuit: true, source: 'export default ' + JSON.stringify(new URL(url).pathname) + ';' };
  if (url.endsWith('.tsx')) return { format: 'module', shortCircuit: true,
    source: transformSync(readFileSync(new URL(url), 'utf8'), { loader: 'tsx', jsx: 'automatic', format: 'esm' }).code };
  if (url.endsWith('.ts')) return { format: 'module', shortCircuit: true,
    source: transformSync(readFileSync(new URL(url), 'utf8'), { loader: 'ts', format: 'esm' }).code };
  return nextLoad(url, context);
} });
const { GlobalSidebar, MatchSidebar } = await import('../renderer/src/sidebar.tsx');
const { LibraryList, LibraryPage, PersonalSection } = await import('../renderer/src/library-page.tsx');
const { TitlebarView } = await import('../renderer/src/app-titlebar.tsx');
const { brandCenterOffset, isBrandCentered } = await import('../renderer/src/titlebar-geometry.ts');
const { toLibraryListQuery, formatBytes } = await import('../renderer/src/library-query.ts');
const { RatingValue, ReportSecondaryLine, formatRating, formatKast } = await import('../renderer/src/performance-display.tsx');
const { useReport } = await import('../renderer/src/store.ts');
const render = element => renderToStaticMarkup(createElement(SSRProvider, null, element));
const noop = () => {};

const entries = [
  { matchId: 'a'.repeat(64), fileName: 'dust2.dem', map: 'de_dust2', rounds: 24, score: { initialCT: 13, initialT: 11 },
    players: [{ id: '1', nickname: 'A' }], importedAt: '2026-10-20T10:00:00.000Z', versions: {}, capabilities: {},
    storedBytes: 12 * 1024 * 1024, state: 'ready' },
  { matchId: 'b'.repeat(64), fileName: 'broken.cs2a', map: 'de_mirage', rounds: 0, score: null,
    players: [], importedAt: '2026-10-19T10:00:00.000Z', versions: {}, capabilities: {},
    storedBytes: 1024, state: 'invalid' },
];

test('global sidebar exposes exactly the two first-level entries and never the six match views', () => {
  const html = render(createElement(GlobalSidebar, { section: 'library', collapsed: false, importBusy: false, onSelectSection: noop, onToggleCollapsed: noop, onImport: noop }));
  assert.ok(html.includes('data-app-sidebar'));
  assert.ok(html.includes('data-sidebar-mode="global"'));
  assert.deepEqual([...html.matchAll(/id="(global-[a-z]+-tab)"/g)].map(match => match[1]), ['global-personal-tab', 'global-library-tab']);
  for (const label of ['个人数据', '比赛数据']) assert.ok(html.includes(label), label);
  assert.equal(html.includes('比赛报告'), false, 'global mode must not embed match views');
  assert.equal([...html.matchAll(/role="tab"/g)].length, 2);
  assert.ok(html.includes('data-sidebar-import'), 'global mode keeps the keyboard-reachable DEM import');
  assert.ok(html.includes('aria-label="选择 DEM"'));
  assert.ok(html.includes('data-sidebar-toggle'));
});

test('match sidebar keeps the six existing report views in order and preserves their ids', () => {
  const html = render(createElement(MatchSidebar, { reportReady: false, busy: false, collapsed: false, activeView: 'report',
    importLabel: '选择 DEM', onSelectView: noop, onToggleCollapsed: noop, onImport: noop }));
  assert.ok(html.includes('data-sidebar-mode="match"'));
  assert.deepEqual([...html.matchAll(/id="([a-z-]+-tab)"/g)].map(match => match[1]),
    ['report-tab', 'deep-review-tab', 'timeline-tab', 'analysis-tab', 'replay-tab', 'heatmap-tab']);
  for (const label of ['比赛报告', '深度复盘', '回合时间线', '分析', '比赛回放', '热力图']) assert.ok(html.includes(label), label);
  assert.equal(html.includes('个人数据'), false, 'match mode must not keep the global rail');
  assert.equal([...html.matchAll(/role="tab"/g)].length, 6);
  assert.equal([...html.matchAll(/aria-controls="/g)].length, 6);
  assert.equal([...html.matchAll(/disabled/g)].length >= 6, true, 'no report means disabled views');
  assert.ok(html.includes('data-sidebar-import'));
});

test('collapsed global sidebar keeps accessible icon labels and hides text from the visual row', () => {
  const html = render(createElement(GlobalSidebar, { section: 'personal', collapsed: true, importBusy: false, onSelectSection: noop, onToggleCollapsed: noop, onImport: noop }));
  assert.ok(html.includes('data-collapsed="true"'));
  assert.equal([...html.matchAll(/role="tab"/g)].length, 2);
  assert.equal([...html.matchAll(/aria-label="个人数据"/g)].length, 1);
  assert.equal([...html.matchAll(/aria-label="比赛数据"/g)].length, 1);
  assert.ok(html.includes('aria-label="展开导航"'));
  assert.equal(html.includes('>收起导航<'), false);
});

test('personal data is an honest placeholder and contains no invented statistics', () => {
  const html = render(createElement(PersonalSection));
  assert.ok(html.includes('个人数据视图尚未实现'));
  assert.ok(html.includes('不会生成或展示任何个人统计'));
  for (const fake of ['K/D', 'ADR', '胜率', 'Rating', '回合数']) assert.equal(html.includes(fake), false, fake);
});

test('saved-match list renders open/export/delete actions and disables unavailable rows', () => {
  const html = render(createElement(LibraryList, { entries, busy: false, onOpen: noop, onExport: noop, onDelete: noop }));
  assert.ok(html.includes('data-library-list'));
  assert.equal([...html.matchAll(/data-library-entry="/g)].length, 2);
  assert.ok(html.includes('dust2.dem'));
  assert.ok(html.includes('de_dust2'));
  assert.ok(html.includes('13 : 11'));
  assert.ok(html.includes('24 回合'));
  assert.ok(html.includes('当前档案不可读'));
  const readyRow = html.slice(html.indexOf('data-library-entry="' + entries[0].matchId + '"'), html.indexOf('data-library-entry="' + entries[1].matchId + '"'));
  assert.ok(readyRow.includes('data-library-open'));
  assert.ok(readyRow.includes('data-library-export'));
  assert.ok(readyRow.includes('data-library-delete'));
  assert.equal(/data-library-open[^>]*disabled/.test(readyRow), false);
  const brokenRow = html.slice(html.indexOf('data-library-entry="' + entries[1].matchId + '"'));
  assert.match(brokenRow, /data-library-open[^>]*disabled/);
  const busy = render(createElement(LibraryList, { entries, busy: true, onOpen: noop, onExport: noop, onDelete: noop }));
  assert.equal([...busy.matchAll(/data-library-open[^>]*disabled/g)].length, 2, 'busy disables opening');
});

const rating = value => ({ value, algorithm: 'hltv-2.0-community-approx-v1', status: 'available', reason: null });
test('record table columns, formats and precomputed outcomes follow the selected identity', () => {
  const entry = { ...entries[0], selectedPlayer: '1', playerSummaries: [
    { playerId: '1', kills: 25, deaths: 20, assists: 4, adr: 91.38, kastPercentage: 75, outcome: 'win',
      performance: { rating: rating(1.423456), highlights: [{ type: 'opening', label: '突', color: 'blue', tooltip: '突破表现：本场首杀 4 次，首死 0 次', evidence: { kills: 4, deaths: 0 } }] } },
    { playerId: '2', kills: 10, deaths: 22, assists: 3, adr: 40, kastPercentage: 50, outcome: 'loss', performance: { rating: rating(0.654), highlights: [] } },
  ] };
  const htmlFor = playerId => render(createElement(LibraryList, { entries: [entry], playerId, busy: false, onOpen: noop, onExport: noop, onDelete: noop }));
  const html = htmlFor('1');
  const headings = [...html.matchAll(/<th\b[^>]*>(.*?)<\/th>/gs)].map(m => m[1].replace(/<[^>]*>/g, ''));
  assert.deepEqual(headings, ['日期 · 导入', '地图', '胜/负', '比分', 'K/D/A', 'ADR', 'Rating', 'KAST', '高光', '操作']);
  for (const removed of ['RWS', '>WE<', 'Rating Pro', '级别']) assert.equal(html.includes(removed), false);
  for (const expected of ['25/20/4', '91.4', '75.0%', 'data-rating-value="1.42"', 'data-library-outcome="win"', 'data-highlight="opening"', '首杀 4 次，首死 0 次']) assert.ok(html.includes(expected), expected);
  const switched = htmlFor('2');
  for (const expected of ['10/22/3', '50.0%', 'data-rating-value="0.65"', 'data-library-outcome="loss"', 'data-highlight-empty']) assert.ok(switched.includes(expected), expected);
  assert.equal(switched.includes('data-highlight="opening"'), false);
  const absent = htmlFor('not-in-match');
  assert.ok(absent.includes('data-rating-value="—"'));
  assert.ok(absent.includes('data-library-outcome="unknown"'));
  assert.equal(absent.includes('25/20/4'), false);
});

test('shared rating formatter handles missing values, preserves precision and explains unavailable results', () => {
  assert.equal(formatRating(rating(1.42501)), '1.43');
  assert.equal(formatRating(rating(Infinity)), '—');
  assert.equal(formatRating(), '—');
  assert.equal(formatRating({ ...rating(0), status: 'unavailable', reason: '有效回合不可用' }), '—');
  assert.equal(formatKast(75), '75.0%');
  assert.equal(formatKast(null), '—');
  const html = render(createElement(RatingValue, { rating: { ...rating(null), status: 'unavailable', reason: '有效回合不可用' } }));
  assert.ok(html.includes('评分不可用：有效回合不可用'));
});

test('report secondary line keeps full long filename accessible and shares list rating formatting', () => {
  const fileName = 'very-long-demo-name-'.repeat(20) + '.dem';
  const html = render(createElement(ReportSecondaryLine, { fileName, rating: rating(1.423456) }));
  assert.ok(html.includes('data-report-secondary'));
  assert.ok(html.includes('title="' + fileName + '"'));
  assert.ok(html.includes('Rating: 1.42'));
  const missing = render(createElement(ReportSecondaryLine, { fileName }));
  assert.ok(missing.includes('Rating: —'));
});

test('library player preference is reused on activation and never reuses another match player metrics', async () => {
  const original = useReport.getState();
  const oldWindow = globalThis.window;
  try {
    const source = { match: { id: 'c'.repeat(64) }, selectedPlayer: '1', players: [{ id: '1' }, { id: '2' }] };
    globalThis.window = { cs2Analyst: { library: { open: async () => ({ kind: 'success', report: source }) } } };
    useReport.setState({ status: 'idle', report: null, playerId: '', preferredPlayerId: '', libraryBusy: null });
    useReport.getState().selectLibraryPlayer('2');
    await useReport.getState().openMatch(source.match.id);
    assert.equal(useReport.getState().playerId, '2');
    useReport.getState().selectPlayer('1');
    assert.equal(useReport.getState().preferredPlayerId, '1');
    useReport.getState().selectPlayer('absent');
    assert.equal(useReport.getState().preferredPlayerId, '1');
  } finally { useReport.setState(original); globalThis.window = oldWindow; }
});

test('library query maps search/filter/sort into the frozen catalogue contract', () => {
  assert.deepEqual(toLibraryListQuery({ search: ' dust2 ', map: 'de_dust2', sort: 'storedBytes', direction: 'asc' }, 25),
    { search: 'dust2', map: 'de_dust2', sort: 'storedBytes', direction: 'asc', limit: 25 });
  assert.deepEqual(toLibraryListQuery({ search: '   ', map: 'all', sort: 'importedAt', direction: 'desc' }),
    { map: null, sort: 'importedAt', direction: 'desc', limit: 100 });
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1536), '1.50 KiB');
  assert.equal(formatBytes(12 * 1024 * 1024), '12.0 MiB');
});

test('library page first paint is an honest loading state without touching Replay chunks', () => {
  const html = render(createElement(LibraryPage));
  assert.ok(html.includes('data-library-page'));
  assert.ok(html.includes('data-library-loading'));
  assert.ok(html.includes('正在读取本地比赛库'));
  assert.ok(html.includes('data-library-toolbar'));
  assert.ok(html.includes('data-library-import-archive'));
  assert.ok(html.includes('data-library-import-dem'));
  assert.equal(html.includes('data-replay'), false);
});

test('titlebar disabled states, accessible names and brand group', () => {
  const disabled = render(createElement(TitlebarView, { canBack: false, canForward: false, canHome: false, onBack: noop, onForward: noop, onHome: noop,
    maximized: false, onMinimize: noop, onToggleMaximize: noop, onClose: noop }));
  assert.match(disabled, /data-nav-action="back"[^>]*aria-disabled="true"/);
  assert.match(disabled, /data-nav-action="forward"[^>]*aria-disabled="true"/);
  assert.match(disabled, /data-nav-action="home"[^>]*aria-disabled="true"/);
  assert.match(disabled, /data-nav-action="back"[^>]*data-nav-disabled="true"/);
  assert.ok(disabled.includes('aria-label="后退"'));
  assert.ok(disabled.includes('aria-label="前进"'));
  assert.ok(disabled.includes('aria-label="返回首页"'));
  const actions = [...disabled.matchAll(/data-nav-action="([^"]+)"/g)].map(item => item[1]);
  assert.deepEqual(actions, ['back', 'home', 'forward'], 'Home must be exactly between back and forward');
  assert.ok(disabled.includes('data-app-brand'));
  assert.ok(disabled.includes('CS2 Analyst'));
  assert.ok(disabled.includes('data-window-control="minimize"'));
  assert.ok(disabled.includes('data-window-control="maximize"'));
  assert.equal(disabled.includes('>还原<'), false);
  const enabled = render(createElement(TitlebarView, { canBack: true, canForward: true, canHome: true, onBack: noop, onForward: noop, onHome: noop,
    maximized: true, onMinimize: noop, onToggleMaximize: noop, onClose: noop }));
  assert.doesNotMatch(enabled, /data-nav-action="back"[^>]*aria-disabled="true"/);
  assert.doesNotMatch(enabled, /data-nav-action="forward"[^>]*aria-disabled="true"/);
  assert.doesNotMatch(enabled, /data-nav-action="home"[^>]*aria-disabled="true"/);
  assert.doesNotMatch(enabled, /data-nav-action="back"[^>]*data-nav-disabled="true"/);
  assert.ok(enabled.includes('aria-label="还原"'));
});

test('brand centring uses the whole titlebar rect and honours the one-CSS-pixel budget', () => {
  const titlebar = { left: 0, width: 1024 };
  assert.ok(isBrandCentered({ left: 452, width: 120 }, titlebar));
  assert.equal(brandCenterOffset({ left: 452, width: 120 }, titlebar), 0);
  assert.ok(isBrandCentered({ left: 452.5, width: 120 }, titlebar), '0.5px is inside the 1px budget');
  assert.equal(isBrandCentered({ left: 455, width: 120 }, titlebar), false, '3px must fail');
  assert.ok(isBrandCentered({ left: 900, width: 120 }, { left: 0, width: 1920 }));
  assert.equal(isBrandCentered({ left: 902, width: 120 }, { left: 0, width: 1920 }), false);
});
