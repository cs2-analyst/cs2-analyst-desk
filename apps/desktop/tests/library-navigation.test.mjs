import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { registerHooks, createRequire } from 'node:module';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SSRProvider } from '@fluentui/react-components';

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
  if (url.endsWith('.ts')) return { format: 'module', shortCircuit: true,
    source: transformSync(readFileSync(new URL(url), 'utf8'), { loader: 'ts', format: 'esm' }).code };
  return nextLoad(url, context);
} });

const { useReport, activeMatchView, navigationCanBack, navigationCanForward } = await import('../renderer/src/store.ts');
const { HeatmapView } = await import('../renderer/src/heatmap-view.tsx');
const { ReplayPlayer } = await import('../renderer/src/replay-player.tsx');
const render = element => renderToStaticMarkup(createElement(SSRProvider, null, element));

const matchId = seed => seed.repeat(64);
const libraryRoute = { kind: 'global', section: 'library' };
const matchRoute = id => ({ kind: 'match', matchId: id });

const report = (id, session = 'session-' + id) => ({
  match: { id, fileName: id + '.dem', map: 'de_dust2', rounds: 24, score: { initialCT: 13, initialT: 11 } },
  selectedPlayer: '1', players: [{ id: '1', nickname: 'p' }], analytics: [], findings: [], timeline: [], analysis: { players: [], perPlayer: [] },
  deepReview: { available: true, players: [] },
  replay: { schemaVersion: 1, available: true, unavailableReason: null, sessionId: session, matchId: id, map: 'de_dust2',
    resourceId: 'de_dust2', samplingVersion: 'test', tickRate: 128, maxInterpolationTicks: 8, perspective: 'global', players: [{ id: '1', nickname: 'p' }],
    rounds: [{ round: 1, startTick: 12000, endTick: 23680, freezeEndTick: null, coverage: 'complete', blocks: [{ index: 0, startTick: 12000, endTick: 23680 }] }], excludedRounds: [] },
  heatmap: { schemaVersion: 1, sessionId: session, matchId: id, available: true, unavailableReason: null,
    layers: { positions: { available: true, unavailableReason: null }, kills: { available: true, unavailableReason: null }, deaths: { available: true, unavailableReason: null } },
    map: { id: 'de_dust2', resourceId: 'de_dust2', alignment: 'unconfirmed', precision: 'schematic-position-distribution' },
    samplingVersion: 'test', resolutions: [16, 32, 64], playerIds: ['1'], rounds: [1], floors: ['default'] },
});

const reset = (overrides = {}) => useReport.setState({
  status: 'idle', report: null, reportRevision: 0, playerId: '', error: null, sessionActive: false,
  navigation: { history: [libraryRoute], index: 0 }, matchViews: {},
  libraryRevision: 0, libraryBusy: null, libraryError: null, libraryNotice: null,
  ...overrides,
});

function bridge(overrides = {}) {
  const calls = { release: [], open: [], remove: [], export: [], importArchive: [] };
  const api = {
    library: {
      list: async () => ({ kind: 'success', entries: [], total: 0, offset: 0, limit: 100, unreadableCount: 0 }),
      storage: async () => ({ kind: 'success', matchCount: 0, archiveBytes: 0, indexBytes: 0, totalBytes: 0 }),
      open: async id => { calls.open.push(id); return { kind: 'success', report: report(id) }; },
      remove: async ids => { calls.remove.push(ids); return { kind: 'success', removed: ids, failed: [] }; },
      exportMatch: async id => { calls.export.push(id); return { kind: 'success', fileName: 'x.cs2a', bytes: 10 }; },
      importArchive: async () => ({ kind: 'cancelled' }),
    },
    importDemo: async () => ({ kind: 'cancelled' }),
    importDroppedFile: async () => ({ kind: 'cancelled' }),
    cancelImport: async () => {},
    session: { release: async id => { calls.release.push(id); } },
  };
  globalThis.window = { cs2Analyst: Object.assign(api, overrides) };
  return { api, calls };
}

test('one back exits a match after any number of tab changes; forward re-enters and restores the tab', async () => {
  const { calls } = bridge();
  reset();
  const id = matchId('a');
  await useReport.getState().openMatch(id);
  assert.equal(useReport.getState().navigation.history.length, 2);
  assert.equal(activeMatchView(useReport.getState()), 'report');
  for (const view of ['heatmap', 'replay', 'timeline', 'analysis', 'report', 'heatmap']) useReport.getState().setMatchView(view);
  assert.equal(useReport.getState().navigation.history.length, 2, 'tab changes must not push history');
  assert.equal(activeMatchView(useReport.getState()), 'heatmap');

  await useReport.getState().back();
  let state = useReport.getState();
  assert.deepEqual(state.navigation.history[state.navigation.index], libraryRoute);
  assert.equal(state.report, null, 'leaving a match drops the report and its session');
  assert.equal(state.sessionActive, false);
  assert.deepEqual(calls.release, ['session-' + id], 'leaving releases the exact IPC session');
  assert.equal(navigationCanForward(state), true);

  await useReport.getState().forward();
  state = useReport.getState();
  assert.deepEqual(state.navigation.history[state.navigation.index], matchRoute(id));
  assert.equal(activeMatchView(state), 'heatmap', 'forward restores the last selected match view');
  assert.equal(state.sessionActive, true, 'forward creates a fresh usable session');
  assert.deepEqual(calls.open, [id, id]);
});

test('library filters live in the store so back-to-list preserves search, map and sort', () => {
  bridge();
  reset();
  useReport.getState().setLibraryFilters({ search: 'dust2', map: 'de_dust2', sort: 'map', direction: 'asc' });
  const state = useReport.getState();
  assert.deepEqual(state.libraryFilters, { search: 'dust2', map: 'de_dust2', sort: 'map', direction: 'asc' });
  assert.deepEqual(state.libraryFilters, useReport.getState().libraryFilters, 'filters survive page unmount because they are store state');
});

test('leaving a match through a global section releases the session and replaces its history node', async () => {
  const { calls } = bridge();
  const id = matchId('a');
  reset({ status: 'success', report: report(id), sessionActive: true,
    navigation: { history: [libraryRoute, matchRoute(id)], index: 1 } });
  useReport.getState().selectSection('library');
  await new Promise(resolve => setImmediate(resolve));
  const state = useReport.getState();
  assert.equal(state.report, null);
  assert.equal(state.sessionActive, false);
  assert.deepEqual(calls.release, ['session-' + id]);
  assert.deepEqual(state.navigation.history, [libraryRoute], 'the abandoned match must not stay one back-step away');
  assert.equal(navigationCanBack(state), false);
});

test('global section changes are real history entries; re-selecting the same section is not stacked', async () => {
  bridge();
  reset();
  useReport.getState().selectSection('personal');
  assert.deepEqual(useReport.getState().navigation.history[useReport.getState().navigation.index], { kind: 'global', section: 'personal' });
  const length = useReport.getState().navigation.history.length;
  useReport.getState().selectSection('personal');
  assert.equal(useReport.getState().navigation.history.length, length, 'same section must not duplicate history');
  useReport.getState().selectSection('library');
  assert.deepEqual(useReport.getState().navigation.history[useReport.getState().navigation.index], libraryRoute);
  await useReport.getState().back();
  assert.deepEqual(useReport.getState().navigation.history[useReport.getState().navigation.index], { kind: 'global', section: 'personal' });
  await useReport.getState().forward();
  assert.deepEqual(useReport.getState().navigation.history[useReport.getState().navigation.index], libraryRoute);
});

test('deleted/invalid forward target degrades to the library list with a message, not a stale match', async () => {
  const { api, calls } = bridge();
  reset();
  const id = matchId('b');
  await useReport.getState().openMatch(id);
  await useReport.getState().back();
  api.library.open = async () => ({ kind: 'error', message: '该比赛当前不可用。' });
  await useReport.getState().forward();
  const state = useReport.getState();
  assert.deepEqual(state.navigation.history[state.navigation.index], libraryRoute);
  assert.equal(navigationCanForward(state), false, 'stale forward branch is cleared');
  assert.match(state.libraryError, /该比赛当前不可用/);
  assert.match(state.libraryError, /已返回比赛数据列表/);
  assert.equal(state.report, null);
  assert.equal(calls.release.length, 1);
});

test('failed open keeps the previous report, its navigation entry and an interactive session', async () => {
  const { api } = bridge();
  const oldId = matchId('c');
  reset({ status: 'success', report: report(oldId), playerId: '1', sessionActive: true,
    navigation: { history: [libraryRoute, matchRoute(oldId)], index: 1 } });
  api.library.open = async () => ({ kind: 'error', message: 'archive broken' });
  await useReport.getState().openMatch(matchId('d'));
  const state = useReport.getState();
  assert.equal(state.status, 'error');
  assert.equal(state.error, 'archive broken');
  assert.equal(state.report.match.id, oldId, 'failed open preserves the previous report');
  assert.deepEqual(state.navigation.history[state.navigation.index], matchRoute(oldId), 'failed open does not navigate');
  assert.equal(state.sessionActive, true, 'the old Main session stays interactive after a failed open');

  // DOM contract: the preserved session must leave Replay and Heatmap controls enabled.
  const heatmap = render(createElement(HeatmapView, { metadata: state.report.heatmap, players: state.report.players, active: true, sessionActive: state.sessionActive }));
  assert.equal([...heatmap.matchAll(/aria-pressed="true"/g)].length, 1);
  assert.equal([...heatmap.matchAll(/aria-label="玩家位置密度"[^>]*disabled/g)].length, 0);
  assert.equal([...heatmap.matchAll(/aria-label="击杀位置"[^>]*disabled/g)].length, 0);
  const replay = render(createElement(ReplayPlayer, { metadata: state.report.replay, fileName: 'c.dem', initialPlayerId: '1', active: state.sessionActive, jump: null }));
  for (const label of ['回到最初', '倒退 10 秒', '播放回放', '前进 30 秒', '直达最后']) {
    assert.doesNotMatch(replay, new RegExp('aria-label="' + label + '"[^>]*disabled'), label);
  }
  await useReport.getState().back();
});

test('failed delete, export and archive import preserve the current report/page and surface an actionable error', async () => {
  const { api } = bridge();
  const id = matchId('e');
  reset({ status: 'success', report: report(id), playerId: '1', sessionActive: true,
    navigation: { history: [libraryRoute, matchRoute(id)], index: 1 } });
  api.library.remove = async () => ({ kind: 'error', message: '无法删除：档案被占用。' });
  await useReport.getState().removeMatches([id]);
  assert.equal(useReport.getState().report.match.id, id);
  assert.match(useReport.getState().libraryError, /档案被占用/);
  assert.equal(useReport.getState().sessionActive, true);
  api.library.exportMatch = async () => ({ kind: 'error', message: '无法写入目标位置。' });
  await useReport.getState().exportMatch(id);
  assert.equal(useReport.getState().report.match.id, id);
  assert.match(useReport.getState().libraryError, /无法写入目标位置/);
  api.library.importArchive = async () => ({ kind: 'error', message: '归档损坏。' });
  await useReport.getState().importArchive();
  assert.equal(useReport.getState().report.match.id, id);
  assert.equal(useReport.getState().status, 'success');
  assert.match(useReport.getState().libraryError, /归档损坏/);
});

test('archive import cancel/failure does not navigate; success opens the imported match', async () => {
  const { api } = bridge();
  reset({ libraryRevision: 2 });
  api.library.importArchive = async () => ({ kind: 'cancelled' });
  await useReport.getState().importArchive();
  assert.deepEqual(useReport.getState().navigation.history[useReport.getState().navigation.index], libraryRoute);
  assert.equal(useReport.getState().libraryRevision, 2);
  api.library.importArchive = async () => ({ kind: 'success', duplicate: false, entry: { matchId: matchId('f') } });
  await useReport.getState().importArchive();
  assert.deepEqual(useReport.getState().navigation.history[useReport.getState().navigation.index], matchRoute(matchId('f')));
  assert.equal(activeMatchView(useReport.getState()), 'report');
  assert.equal(useReport.getState().report.match.id, matchId('f'));
});

test('import success opens a match, while cancel/failure preserve the current match page', async () => {
  const { api } = bridge();
  const current = matchId('g');
  reset({ status: 'success', report: report(current), playerId: '1', reportRevision: 3, sessionActive: true,
    navigation: { history: [libraryRoute, matchRoute(current)], index: 1 } });
  api.importDemo = async () => ({ kind: 'cancelled' });
  await useReport.getState().importDemo();
  assert.equal(useReport.getState().report.match.id, current);
  assert.equal(useReport.getState().reportRevision, 3);
  assert.equal(useReport.getState().sessionActive, true);
  api.importDemo = async () => ({ kind: 'error', message: '解析失败' });
  await useReport.getState().importDemo();
  assert.equal(useReport.getState().report.match.id, current);
  assert.equal(useReport.getState().status, 'error');
  assert.equal(useReport.getState().sessionActive, true);
  api.importDemo = async () => ({ kind: 'success', report: report(matchId('h')) });
  await useReport.getState().importDemo();
  const state = useReport.getState();
  assert.deepEqual(state.navigation.history[state.navigation.index], matchRoute(matchId('h')));
  assert.equal(state.reportRevision, 4);
  assert.equal(state.navigation.history.length, 2, 'importing inside a match replaces the match entry');
});

test('one-open-at-a-time guards prevent duplicate/racing opens and imports', async () => {
  let finish, calls = 0;
  const { api } = bridge();
  api.library.open = () => { calls += 1; return new Promise(resolve => { finish = resolve; }); };
  reset();
  const first = useReport.getState().openMatch(matchId('i'));
  assert.equal(useReport.getState().status, 'opening');
  await useReport.getState().openMatch(matchId('j'));
  await useReport.getState().importDemo();
  await useReport.getState().removeMatches([matchId('j')]);
  finish({ kind: 'success', report: report(matchId('i')) });
  await first;
  assert.equal(useReport.getState().report.match.id, matchId('i'));
  assert.equal(calls, 1);
});