import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { connectCdp, waitFor, closeApp } from './smoke-runtime.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const desktop = join(repo, 'apps', 'desktop');
const require = createRequire(join(desktop, 'package.json'));
const cli = fileURLToPath(new URL('./cli.js', pathToFileURL(require.resolve('electron-vite'))));
const dem = process.env.CS2_ANALYST_DUST2_DEM || join(repo, '.demo', 'dust2.dem');
assert.ok(existsSync(dem), 'Dust2 DEM fixture not found; pass CS2_ANALYST_DUST2_DEM to a local whitelist .dem (never copy it into the repo)');
const evidencePath = process.env.CS2_ANALYST_L4_EVIDENCE || join(repo, '.tmp', 'l4-library-navigation-evidence.json');
const shotDir = join(repo, '.tmp', 'l4-navigation-shots');

function git(args) {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true });
  return result.status === 0 ? result.stdout.trim() : '';
}
function freePort() {
  return new Promise(resolve => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function launch() {
  const port = await freePort();
  const profile = mkdtempSync(join(tmpdir(), 'cs2-analyst-l4-profile-'));
  const localAppData = mkdtempSync(join(tmpdir(), 'cs2-analyst-l4-localappdata-'));
  const env = { ...process.env, LOCALAPPDATA: localAppData, CS2_ANALYST_DEM_PATH: dem };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  const child = spawn(process.execPath, [cli, 'preview', '--skipBuild', '--', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`], {
    cwd: desktop, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', data => { logs += data; });
  child.stderr.on('data', data => { logs += data; });
  let page;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`应用提前退出：${logs}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) });
      page = (await response.json()).find(target => target.type === 'page');
      if (page?.webSocketDebuggerUrl) break;
    } catch { /* Electron 尚未启动调试端口。 */ }
    await delay(200);
  }
  assert.ok(page?.webSocketDebuggerUrl, `等待窗口超时：${logs}`);
  const session = await connectCdp(page.webSocketDebuggerUrl);
  session.child = child;
  session.page = page;
  session.logs = () => logs;
  session.profile = profile;
  session.localAppData = localAppData;
  return session;
}

async function main() {
  const session = await launch();
  const { send, evaluate, socket } = session;
  const errors = [];
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params);
  });
  await send('Runtime.enable');
  await send('Page.enable');
  mkdirSync(shotDir, { recursive: true });
  mkdirSync(join(repo, '.tmp'), { recursive: true });
  const evidence = {
    generatedAt: new Date().toISOString(), branch: git(['branch', '--show-current']), head: git(['rev-parse', 'HEAD']),
    dem: { name: basename(dem), bytes: statSync(dem).size }, ownedProfile: true, ownedLocalAppData: true,
    geometry: [], history: [], sixTabs: null, importDurationMs: null, errors,
  };

  const getState = () => evaluate(`(() => {
    const sidebar = document.querySelector('[data-app-sidebar]');
    const content = document.querySelector('[data-app-content]');
    return {
      ready: document.readyState,
      route: content?.dataset.routeKind ?? null,
      status: content?.dataset.status ?? null,
      sessionActive: content?.dataset.sessionActive ?? null,
      mode: sidebar?.dataset.sidebarMode ?? null,
      collapsed: sidebar?.dataset.collapsed ?? null,
      matchId: content?.dataset.matchId ?? '',
      libraryEntries: document.querySelectorAll('[data-library-entry]').length,
      selectedTab: document.querySelector('[data-app-sidebar] [role="tab"][aria-selected="true"]')?.id ?? null,
      tabs: [...document.querySelectorAll('[data-app-sidebar] [role="tab"]')].map(tab => ({ id: tab.id, label: tab.textContent, disabled: tab.disabled })),
    };
  })()`);

  const measure = async stage => {
    const result = await evaluate(`(async () => {
      const bar = document.querySelector('[data-app-titlebar]').getBoundingClientRect();
      const brand = document.querySelector('[data-app-brand]').getBoundingClientRect();
      const sidebar = document.querySelector('[data-app-sidebar]');
      return {
        innerWidth, innerHeight, devicePixelRatio,
        titlebar: { left: bar.left, width: bar.width },
        brand: { left: brand.left, width: brand.width, center: brand.left + brand.width / 2 },
        titlebarCenter: bar.left + bar.width / 2,
        delta: Math.abs(brand.left + brand.width / 2 - (bar.left + bar.width / 2)),
        mode: sidebar.dataset.sidebarMode, collapsed: sidebar.dataset.collapsed,
        nativeMaximized: await window.cs2Analyst.window.isMaximized(),
      };
    })()`);
    assert.ok(result.delta <= 1, `${stage}: brand centre delta ${result.delta} CSS px > 1; ${JSON.stringify(result)}`);
    evidence.geometry.push({ stage, ...result });
    console.log(`geometry ${stage}: delta=${result.delta}px viewport=${result.innerWidth}x${result.innerHeight} mode=${result.mode} collapsed=${result.collapsed}`);
    return result;
  };

  const settle = async label => {
    // Infinite Spinner animations are expected while the catalogue loads; only page/font readiness matters here.
    await waitFor(() => evaluate("document.readyState === 'complete' && document.fonts.status === 'loaded'"), 10_000, label, { intervalMs: 50 });
    await delay(150);
  };

  const toggleSidebar = async (collapsed, label) => {
    const state = await getState();
    if (state.collapsed === (collapsed ? 'true' : 'false')) return;
    await evaluate("document.querySelector('[data-sidebar-toggle]').click()");
    await waitFor(() => evaluate(`document.querySelector('[data-app-sidebar]').dataset.collapsed === ${JSON.stringify(collapsed ? 'true' : 'false')}`), 5_000, label, { intervalMs: 50 });
    await delay(250);
    await settle(label);
  };

  // Electron 44's CDP has no Browser.getWindowForTarget; Emulation pins the exact CSS viewport.
  // Native maximize/restore is exercised separately and through the real preload API.
  const boundsMode = 'Emulation.setDeviceMetricsOverride';
  const setWindowSize = async (width, height) => {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await waitFor(async () => {
      const current = await evaluate('({ w: innerWidth, h: innerHeight })');
      return Math.abs(current.w - width) <= 1 && Math.abs(current.h - height) <= 1 ? current : null;
    }, 10_000, `emulated viewport ${width}x${height}`, { intervalMs: 100 });
    await settle(`resize ${width}x${height}`);
    return evaluate('({ w: innerWidth, h: innerHeight })');
  };

  // Drive the real BrowserWindow state and poll the preload's native isMaximized().
  // The aria-label is a second, independent UI contract check, not the state source.
  const maximize = async () => {
    const before = await evaluate('window.cs2Analyst.window.isMaximized()');
    await evaluate('window.cs2Analyst.window.toggleMaximize()');
    await waitFor(async () => (await evaluate('window.cs2Analyst.window.isMaximized()')) === !before, 15_000, 'native maximize state', {
      intervalMs: 150,
      diagnostics: () => evaluate("({ label: document.querySelector('[data-window-control=\"maximize\"]')?.getAttribute('aria-label'), text: document.body.innerText.slice(-400) })"),
    });
    const expected = before ? '最大化' : '还原';
    await waitFor(() => evaluate(`document.querySelector('[data-window-control="maximize"]').getAttribute('aria-label') === ${JSON.stringify(expected)}`), 15_000, 'native maximize label ' + expected, {
      intervalMs: 150,
      diagnostics: () => evaluate("({ label: document.querySelector('[data-window-control=\"maximize\"]')?.getAttribute('aria-label'), isMaximized: window.cs2Analyst.window.isMaximized() })"),
    });
    await delay(700);
    await settle('maximize transition');
    return !before;
  };

  const screenshot = async name => {
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(join(shotDir, name + '.png'), Buffer.from(shot.data, 'base64'));
  };

  const matrixFor = async label => {
    for (const [width, height] of [[1024, 640], [1920, 1032]]) {
      await setWindowSize(width, height);
      await toggleSidebar(false, `${label} expand ${width}`);
      await measure(`${label} ${width}x${height} normal expanded`);
      await toggleSidebar(true, `${label} collapse ${width}`);
      await measure(`${label} ${width}x${height} normal collapsed`);
      await toggleSidebar(false, `${label} re-expand ${width}`);
      assert.equal(await maximize(), true, 'first native toggle must maximize');
      await measure(`${label} ${width}x${height} maximized expanded`);
      await toggleSidebar(true, `${label} maximized collapse ${width}`);
      await measure(`${label} ${width}x${height} maximized collapsed`);
      await toggleSidebar(false, `${label} maximized re-expand ${width}`);
      assert.equal(await maximize(), false, 'second native toggle must restore');
      await setWindowSize(width, height);
      await measure(`${label} ${width}x${height} restored expanded`);
      await screenshot(`${label}-${width}x${height}`);
    }
  };

  try {
    await waitFor(() => evaluate("document.querySelector('[data-library-page]') && document.readyState === 'complete'"), 60_000, 'global library first paint', { intervalMs: 200 });
    await settle('first paint');
    let state = await getState();
    assert.equal(state.mode, 'global', 'app must boot in global sidebar mode');
    assert.deepEqual(state.tabs.map(tab => tab.id), ['global-personal-tab', 'global-library-tab'], 'global rail must expose 个人数据/比赛数据 only');
    assert.equal(state.route, 'global');
    assert.equal(state.libraryEntries, 0, 'owned profile must start empty');
    assert.equal(await evaluate("document.querySelectorAll('[data-app-sidebar] [role=\"tab\"]').length"), 2);
    assert.equal(await evaluate("document.querySelector('[data-nav-action=\"back\"]').getAttribute('aria-disabled') === 'true' && document.querySelector('[data-nav-action=\"forward\"]').getAttribute('aria-disabled') === 'true'"), true, 'fresh history has both buttons disabled');
    // Real native window states, no Emulation override, at this machine's actual work area.
    if (await evaluate('window.cs2Analyst.window.isMaximized()')) await maximize();
    await settle('native normal');
    await measure('global native normal');
    assert.equal(await maximize(), true, 'native maximize');
    const nativeMax = await measure('global native maximized');
    assert.ok(nativeMax.innerWidth >= 1200 && nativeMax.innerHeight >= 700, 'native maximize must actually enlarge the viewport: ' + JSON.stringify(nativeMax));
    assert.equal(await maximize(), false, 'native restore');
    await measure('global native restored');

    await matrixFor('global');

    await setWindowSize(1024, 640);
    const importStarted = Date.now();
    await evaluate("document.querySelector('[data-library-import-dem]').click()");
    await waitFor(() => evaluate("document.querySelector('[data-app-sidebar]')?.dataset.sidebarMode === 'match' && document.querySelector('[data-app-content]')?.dataset.status === 'success'"), 10 * 60_000, 'Dust2 import into owned library', {
      intervalMs: 300,
      diagnostics: () => evaluate("({ status: document.querySelector('[data-app-content]')?.dataset.status, text: document.body.innerText.slice(-1200) })"),
    });
    evidence.importDurationMs = Date.now() - importStarted;
    console.log(`import completed in ${evidence.importDurationMs} ms`);

    state = await getState();
    assert.equal(state.mode, 'match', 'import success must open the match workspace');
    assert.equal(state.tabs.length, 6, 'match rail must contain the six existing views');
    assert.deepEqual(state.tabs.map(tab => tab.id), ['report-tab', 'deep-review-tab', 'timeline-tab', 'analysis-tab', 'replay-tab', 'heatmap-tab']);
    assert.equal(state.tabs.every(tab => !tab.disabled), true, 'all six views must be usable after import');
    assert.equal(await evaluate("document.querySelector('[data-nav-action=\"back\"]').getAttribute('aria-disabled') !== 'true'"), true, 'one back must be available from the match');
    assert.equal(await evaluate("document.querySelector('[data-nav-action=\"forward\"]').getAttribute('aria-disabled') === 'true'"), true, 'fresh import has no forward branch');

    await matrixFor('match');

    // Tab changes are local: after six different tabs one back must still exit the match.
    for (const id of ['deep-review-tab', 'timeline-tab', 'analysis-tab', 'replay-tab', 'heatmap-tab', 'report-tab', 'heatmap-tab']) {
      await evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
      await settle(id);
    }
    await setWindowSize(1024, 640);
    await evaluate("document.querySelector('[data-nav-action=\"back\"]').click()");
    await waitFor(() => evaluate("document.querySelector('[data-app-sidebar]')?.dataset.sidebarMode === 'global' && !!document.querySelector('[data-library-page]')"), 30_000, 'one back exits to library', { intervalMs: 100 });
    await waitFor(() => evaluate("document.querySelectorAll('[data-library-entry]').length >= 1"), 30_000, 'saved-match list shows the imported match', { intervalMs: 100 });
    state = await getState();
    assert.equal(state.route, 'global');
    assert.equal(state.mode, 'global');
    assert.ok(state.libraryEntries >= 1, 'the imported match must be in the saved-match list');
    assert.equal(await evaluate("document.querySelector('[data-nav-action=\"forward\"]').getAttribute('aria-disabled') !== 'true'"), true, 'forward must re-enter the exited match');
    evidence.history.push({ step: 'back-from-any-tab', route: state.route, libraryEntries: state.libraryEntries, pass: true });

    await evaluate("document.querySelector('[data-nav-action=\"forward\"]').click()");
    await waitFor(() => evaluate("document.querySelector('[data-app-sidebar]')?.dataset.sidebarMode === 'match' && document.querySelector('[data-app-content]')?.dataset.status === 'success'"), 60_000, 'forward re-enters the match', { intervalMs: 100 });
    state = await getState();
    assert.equal(state.route, 'match');
    assert.equal(state.selectedTab, 'heatmap-tab', 'forward must restore the last selected match tab');
    assert.equal(state.tabs.every(tab => !tab.disabled), true);
    evidence.history.push({ step: 'forward-reentry', route: state.route, selectedTab: state.selectedTab, pass: true });
    console.log('history: one back exited the match; forward re-entered and restored heatmap');

    // Every one of the six views must still be selectable and visible at 1024x640.
    const views = {};
    for (const id of ['report', 'deep-review', 'timeline', 'analysis', 'replay', 'heatmap']) {
      await evaluate(`document.getElementById(${JSON.stringify(id + '-tab')}).click()`);
      await waitFor(() => evaluate(`document.getElementById(${JSON.stringify(id + '-panel')}) && !document.getElementById(${JSON.stringify(id + '-panel')}).hidden`), 10_000, id + ' panel visible', { intervalMs: 50 });
      views[id] = await evaluate(`(() => { const panel = document.getElementById(${JSON.stringify(id + '-panel')}); const tab = document.getElementById(${JSON.stringify(id + '-tab')}); return { visible: !panel.hidden && panel.checkVisibility(), selected: tab.getAttribute('aria-selected'), disabled: tab.disabled }; })()`);
      assert.deepEqual(views[id], { visible: true, selected: 'true', disabled: false }, id + ' must stay usable');
    }
    evidence.sixTabs = views;
    await evaluate("document.getElementById('heatmap-tab').click()");
    await settle('heatmap');

    // One back exits and forward re-enters again at 1920x1032 with a re-created session.
    await setWindowSize(1920, 1032);
    await evaluate("document.querySelector('[data-nav-action=\"back\"]').click()");
    await waitFor(() => evaluate("document.querySelector('[data-app-sidebar]')?.dataset.sidebarMode === 'global'"), 30_000, 'back at 1920x1032', { intervalMs: 100 });
    await evaluate("document.querySelector('[data-nav-action=\"forward\"]').click()");
    await waitFor(() => evaluate("document.querySelector('[data-app-sidebar]')?.dataset.sidebarMode === 'match' && document.querySelector('[data-app-content]')?.dataset.status === 'success'"), 60_000, 'forward at 1920x1032', { intervalMs: 100 });
    assert.equal((await getState()).selectedTab, 'heatmap-tab');
    evidence.history.push({ step: 'back-forward-1920x1032', selectedTab: 'heatmap-tab', pass: true });
    await measure('match 1920x1032 native expanded after history');

    // Home sits between the arrows and returns to the library without discarding Back history.
    assert.deepEqual(await evaluate("Array.from(document.querySelectorAll('[data-app-history-nav] [data-nav-action]')).map(el => el.dataset.navAction)"),
      ['back', 'home', 'forward'], 'titlebar order must be Back / Home / Forward');
    assert.equal(await evaluate("document.querySelector('[data-nav-action=home]').getAttribute('aria-disabled')"), 'false');
    await evaluate("document.querySelector('[data-nav-action=home]').click()");
    await waitFor(() => evaluate("document.querySelector('[data-app-sidebar]')?.dataset.sidebarMode === 'global' && !!document.querySelector('[data-library-page]')"),
      30_000, 'Home navigates to library', { intervalMs: 100 });
    assert.equal(await evaluate("document.querySelector('[data-nav-action=home]').getAttribute('aria-disabled')"), 'true');
    await evaluate("document.querySelector('[data-nav-action=back]').click()");
    await waitFor(() => evaluate("document.querySelector('[data-app-sidebar]')?.dataset.sidebarMode === 'match' && document.querySelector('[data-app-content]')?.dataset.status === 'success'"),
      60_000, 'Back after Home restores match', { intervalMs: 100 });
    assert.equal((await getState()).selectedTab, 'heatmap-tab', 'Back after Home restores the last tab');
    evidence.history.push({ step: 'home-then-back', selectedTab: 'heatmap-tab', pass: true });

    assert.deepEqual(errors, [], 'no renderer exceptions during the L4 smoke');
    mkdirSync(join(repo, '.tmp'), { recursive: true });
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
    console.log(`L4 navigation smoke PASS. Evidence: ${evidencePath}`);
    console.log(JSON.stringify({ geometry: evidence.geometry, history: evidence.history, importDurationMs: evidence.importDurationMs, boundsMode }, null, 2));
    await closeApp(session);
  } finally {
    socket.close?.();
    if (session.child.exitCode === null && session.child.pid) {
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(session.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      else session.child.kill();
    }
    rmSync(session.profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    rmSync(session.localAppData, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
}

main().catch(error => {
  console.error('L4 navigation smoke FAILED');
  console.error(error);
  process.exitCode = 1;
});