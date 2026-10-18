// P7-S5 Layout A acceptance: real Electron, real local DEMs, no product test hooks.
//
// Verifies the frozen layout: shared match header, all eight KPIs visible at once,
// Findings on the left and utility/clutch on the right, each column scrolling
// independently while the report view itself never scrolls as a page.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { closeApp, connectCdp, waitFor, withCleanup } from './smoke-runtime.mjs';
import { checkReportLayout } from './report-ux-checks.mjs';
import { settleUi } from './window-shell-checks.mjs';
import { ProcessScope } from './installed-smoke-lifecycle.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const desktop = join(root, 'apps/desktop');
const demo1 = join(root, '.demo/demo1.dem');
const demo2 = join(root, '.demo/demo2.dem');
const qaDir = join(root, '.tmp/p7-s5-qa');
const profilePrefix = join(tmpdir(), 'cs2-analyst-p7-s5-profile-');
mkdirSync(qaDir, { recursive: true });

assert.ok(existsSync(demo1), 'BLOCKED: local .demo/demo1.dem missing; no download/substitute');
assert.ok(existsSync(demo2), 'BLOCKED: local .demo/demo2.dem missing; no download/substitute');
const require = createRequire(join(desktop, 'package.json'));
const electron = require('electron');
const results = { layoutA: [], checks: [], screenshots: [] };

async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function capture(evaluate, send, name) {
  await settleUi(evaluate, 'screenshot ' + name);
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const path = join(qaDir, name + '.png');
  writeFileSync(path, Buffer.from(shot.data, 'base64'));
  results.screenshots.push(path);
  return path;
}

/** Launch the built app with the production import seam and wait for the React shell. */
async function scenario({ label, demPath, body }) {
  const port = await freePort();
  const env = { ...process.env, CS2_ANALYST_DEM_PATH: demPath };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  const profile = mkdtempSync(profilePrefix);
  const startedAt = Date.now();
  const child = spawn(electron, ['.', '--remote-debugging-port=' + port, '--user-data-dir=' + profile,
    '--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows'], {
    cwd: desktop, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const scope = new ProcessScope();
  const tracked = scope.track(child, label, startedAt);
  let logs = '';
  child.stdout.on('data', data => { logs += data; });
  child.stderr.on('data', data => { logs += data; });
  let socket;
  let failure;
  try {
    let page;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      await scope.live();
      if (tracked.error) throw new Error('应用启动器异常：' + tracked.error.message, { cause: tracked.error });
      if (child.exitCode !== null) throw new Error('应用提前退出：' + child.exitCode + ' ' + logs);
      try {
        const response = await fetch('http://127.0.0.1:' + port + '/json/list', { signal: AbortSignal.timeout(1000) });
        page = (await response.json()).find(target => target.type === 'page');
        if (page?.webSocketDebuggerUrl) break;
      } catch { /* Electron 尚未开放调试端口。 */ }
      await delay(200);
    }
    assert.ok(page?.webSocketDebuggerUrl, '等待窗口超时：' + logs);
    const connection = await connectCdp(page.webSocketDebuggerUrl);
    socket = connection.socket;
    const { send, evaluate } = connection;
    await send('Runtime.enable');
    await send('Page.enable');
    const exceptions = [];
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params);
    });
    await waitFor(async () => {
      const state = await evaluate('({ ready: document.readyState, text: document.body.textContent })');
      return state?.ready === 'complete' && state.text?.includes('CS2 Analyst') ? state : null;
    }, 30_000, label + ' React 页面');
    assert.equal(await evaluate('typeof window.require'), 'undefined', 'renderer must not expose Node.js');
    await body({ evaluate, send });
    assert.deepEqual(exceptions, [], label + ' 页面存在未捕获异常');
    await closeApp({ child, evaluate, socket });
    socket = null;
    console.log(label + '：PASS');
  } catch (error) {
    failure = new Error(label + ' 失败\n' + logs, { cause: error });
  } finally {
    await withCleanup(() => { if (failure) throw failure; }, [
      () => socket?.close(),
      () => scope.cleanup(),
      () => rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }),
    ]);
  }
}

async function importReport(evaluate, send) {
  await evaluate('document.querySelector("[data-sidebar-import]").focus()');
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', windowsVirtualKeyCode: 13 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', text: '\r', windowsVirtualKeyCode: 13 });
  await waitFor(() => evaluate('document.querySelector("main").dataset.status === "success"'), 180_000, 'real DEM import',
    { diagnostics: () => evaluate('({ text: document.body.innerText.slice(-1500), status: document.querySelector("main")?.dataset.status })') });
  await evaluate('document.getElementById("report-tab").click()');
  await settleUi(evaluate, 'report tab');
}

async function viewport(evaluate, send, width, height) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await waitFor(() => evaluate('innerWidth===' + width + ' && innerHeight===' + height), 5000, 'viewport ' + width + 'x' + height);
  await settleUi(evaluate, 'viewport ' + width + 'x' + height);
}

async function assertNoReportPageScroll(evaluate, label) {
  const state = await evaluate(`(() => {
    const panel = document.getElementById('report-panel');
    const content = document.querySelector('[data-app-content]');
    return { document: document.documentElement.scrollHeight - innerHeight,
      body: document.body.scrollHeight - innerHeight,
      content: content.scrollHeight - content.clientHeight,
      horizontal: document.documentElement.scrollWidth - innerWidth,
      panel: panel ? panel.scrollHeight - panel.clientHeight : null,
      panelStyle: panel ? getComputedStyle(panel).overflowY : null,
      panelHeight: panel?.clientHeight ?? 0 };
  })()`);
  for (const key of ['document', 'body', 'content']) assert.ok(state[key] <= 1, label + ': page overflow ' + key + ' ' + state[key] + 'px');
  assert.equal(state.panelStyle, 'hidden', label + ': report panel must not own page scroll');
  assert.ok(state.panel !== null && state.panel <= 1, label + ': report panel overflow ' + state.panel);
  assert.ok(state.panelHeight > 100, label + ': report panel lost its height');
  assert.ok(state.horizontal <= 1, label + ': horizontal page overflow ' + state.horizontal);
  return state;
}

async function assertKpiValues(evaluate, label) {
  const values = await evaluate(`[...document.querySelectorAll('[data-report-kpi]')].map(el => [el.dataset.reportKpi, el.innerText])`);
  const expected = {
    'K / D / A': ['25 / 20 / 4'],
    'ADR': ['91.38', '每回合平均有效伤害'],
    'HS%（爆头率）': ['36.0%'],
    'KAST（回合贡献率）': ['75%', '18 / 24 回合'],
    'Trade rate（死亡后队友补枪率）': ['22.2%', '4 / 18 次死亡后队友完成补枪'],
    'Trade kills（补枪击杀）': ['6'],
    'Opening（首杀对决）': ['4 首杀 / 0 首死', '首杀对决胜率 100.0%'],
    'Clutch（残局）': ['1 胜 / 3 次', '已证明的 1vN 机会'],
  };
  assert.deepEqual(values.map(([name]) => name), Object.keys(expected), label + ': KPI order');
  for (const [name, fragments] of Object.entries(expected)) {
    const text = values.find(([candidate]) => candidate === name)[1];
    for (const fragment of fragments) assert.ok(text.includes(fragment), label + ': ' + name + ' missing ' + fragment + ': ' + JSON.stringify(text));
  }
  // Four columns by two rows, every card visible and unclipped.
  const geometry = await evaluate(`(() => {
    const cards = [...document.querySelectorAll('[data-report-kpi]')].map(el => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, visible: el.checkVisibility(), clip: el.scrollHeight - el.clientHeight }; });
    return { cards, rows: [...new Set(cards.map(card => Math.round(card.top)))].sort((a, b) => a - b), viewport: innerHeight };
  })()`);
  assert.equal(geometry.cards.length, 8);
  assert.equal(geometry.rows.length, 2, label + ': KPI cards must form two rows');
  assert.deepEqual(geometry.rows.map(row => geometry.cards.filter(card => Math.round(card.top) === row).length), [4, 4], label + ': KPI cards must form four columns');
  for (const card of geometry.cards) {
    assert.equal(card.visible, true, label + ': hidden KPI card');
    assert.ok(card.bottom <= geometry.viewport + 1, label + ': KPI below the viewport');
    assert.ok(card.clip <= 1, label + ': clipped KPI card');
  }
  return values;
}

async function assertTooltips(evaluate, send, label) {
  const helps = await evaluate('document.querySelectorAll(\'button[aria-label$="说明"]\').length');
  assert.ok(helps >= 9, label + ': expected eight KPI help entries and the utility help entry');
  for (const [ariaLabel, expected] of [
    ['ADR说明', '每回合平均有效伤害'],
    ['Trade rate（死亡后队友补枪率）说明', '死亡时仍有队友存活'],
  ]) {
    await evaluate(`document.activeElement?.blur(); document.querySelector(${JSON.stringify('[aria-label="' + ariaLabel + '"]')}).focus()`);
    await waitFor(() => evaluate(`[...document.querySelectorAll('[role="tooltip"]')].some(tooltip => tooltip.checkVisibility() && tooltip.textContent.includes(${JSON.stringify(expected)}))`),
      10_000, label + ': tooltip ' + ariaLabel);
    await evaluate('document.activeElement?.blur()');
    await delay(80);
  }
  return helps;
}

async function assertAccessibility(evaluate, send, label) {
  const tree = await send('Accessibility.getFullAXTree');
  const nodes = tree.nodes.filter(node => !node.ignored).map(node => ({ role: node.role?.value, name: node.name?.value ?? '' }));
  assert.equal(nodes.filter(node => node.role === 'region' && node.name === '简要分析').length, 1, label + ': Findings must expose exactly one named region');
  assert.equal(nodes.filter(node => node.role === 'region' && node.name === '道具与残局').length, 1, label + ': utility/clutch must expose exactly one named region');
  const kpiNames = ['K / D / A', 'ADR', 'HS%（爆头率）', 'KAST（回合贡献率）', 'Trade rate（死亡后队友补枪率）', 'Trade kills（补枪击杀）', 'Opening（首杀对决）', 'Clutch（残局）'];
  for (const name of kpiNames) {
    assert.ok(nodes.some(node => node.role === 'button' && node.name === name + '说明'), label + ': KPI help button missing from AX tree: ' + name);
  }
  const focus = await evaluate(`(() => {
    const left = document.querySelector('[data-report-column="findings"]');
    left.focus();
    const style = getComputedStyle(left);
    return { active: document.activeElement === left, tabIndex: left.tabIndex,
      focusVisible: left.matches(':focus-visible'), outlineWidth: parseFloat(style.outlineWidth) || 0,
      labelledby: left.getAttribute('aria-labelledby'), role: left.getAttribute('role') };
  })()`);
  assert.equal(focus.active, true, label + ': left column cannot receive focus');
  assert.equal(focus.tabIndex, 0);
  assert.equal(focus.role, 'region');
  assert.ok(focus.labelledby, label + ': left region has no accessible label');
  assert.ok(focus.focusVisible, label + ': keyboard focus feedback missing');
  assert.ok(focus.outlineWidth >= 2, label + ': focus outline is not visible');
  await evaluate('document.activeElement?.blur()');
}

async function testIndependentScrolling(evaluate, send, label) {
  // Expand every Finding so the left column has a genuinely long evidence list.
  await evaluate(`document.querySelectorAll('#report-panel details').forEach(details => { details.open = true; })`);
  await settleUi(evaluate, label + ': expanded findings');
  await evaluate('document.querySelector("[data-report-column=utility]").scrollTop = 0');
  const left = await evaluate(`(() => {
    const el = document.querySelector('[data-report-column="findings"]');
    el.scrollTop = el.scrollHeight;
    const last = [...document.querySelectorAll('#report-panel [data-rule]')].at(-1);
    const box = el.getBoundingClientRect();
    const lastBox = last?.getBoundingClientRect();
    return { top: el.scrollTop, max: el.scrollHeight - el.clientHeight,
      lastVisible: Boolean(lastBox && lastBox.bottom <= box.bottom + 1 && lastBox.top < box.bottom),
      leftBox: [box.top, box.bottom], right: document.querySelector('[data-report-column="utility"]').scrollTop };
  })()`);
  assert.ok(left.top > 0 && left.top >= left.max - 1, label + ': left column cannot reach its last Finding');
  assert.equal(left.lastVisible, true, label + ': last Finding is not reachable');
  assert.equal(left.right, 0, label + ': left scroll leaked into the right column');
  await capture(evaluate, send, 'findings-expanded-bottom-' + label);

  // At 1920 the real right column fits; add bounded synthetic clutch rows so the
  // independent scroll and wheel/keyboard behaviour can be exercised without
  // changing product data or shipping any test hook.
  await evaluate(`(() => {
    const right = document.querySelector('[data-report-column="utility"]');
    const clutch = [...right.querySelectorAll('.fui-Card')].find(card => card.textContent.includes('残局') && card.textContent.includes('回合'));
    const row = [...clutch.querySelectorAll('div')]
      .filter(node => node.children.length === 3 && /^R[0-9]+1v[0-9]+/.test(node.textContent.replace(/[^0-9Rv]/g, '')))
      .sort((a, b) => a.textContent.length - b.textContent.length)[0];
    if (!row) return;
    for (let index = 0; index < 32; index += 1) {
      const clone = row.cloneNode(true);
      clone.dataset.s5Synthetic = 'true';
      row.parentElement.append(clone);
    }
  })()`);
  await settleUi(evaluate, label + ': synthetic clutch rows');
  const rightOverflow = await evaluate(`(() => { const right = document.querySelector('[data-report-column="utility"]'); return right.scrollHeight - right.clientHeight; })()`);
  assert.ok(rightOverflow > 0, label + ': right column could not be made scrollable');

  const offsets = await evaluate(`(() => {
    const left = document.querySelector('[data-report-column="findings"]');
    const right = document.querySelector('[data-report-column="utility"]');
    left.scrollTop = 0; right.scrollTop = 0;
    const leftBox = left.getBoundingClientRect(), rightBox = right.getBoundingClientRect();
    return { left: [leftBox.left + leftBox.width / 2, leftBox.top + leftBox.height / 2],
      right: [rightBox.left + rightBox.width / 2, rightBox.top + rightBox.height / 2] };
  })()`);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: offsets.left[0], y: offsets.left[1] });
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: offsets.left[0], y: offsets.left[1], deltaX: 0, deltaY: 220 });
  await delay(350);
  const wheelLeft = await evaluate(`(() => { const left = document.querySelector('[data-report-column="findings"]'), right = document.querySelector('[data-report-column="utility"]'); return { left: left.scrollTop, right: right.scrollTop }; })()`);
  assert.ok(wheelLeft.left > 0, label + ': wheel did not scroll the left column');
  assert.equal(wheelLeft.right, 0, label + ': wheel over the left column moved the right column');
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: offsets.right[0], y: offsets.right[1], deltaX: 0, deltaY: 220 });
  await delay(350);
  const wheelRight = await evaluate(`(() => { const left = document.querySelector('[data-report-column="findings"]'), right = document.querySelector('[data-report-column="utility"]'); return { left: left.scrollTop, right: right.scrollTop }; })()`);
  assert.ok(wheelRight.right > 0, label + ': wheel did not scroll the right column');
  assert.equal(wheelRight.left, wheelLeft.left, label + ': wheel over the right column moved the left column');
  await capture(evaluate, send, 'right-column-scrolled-' + label);

  await evaluate('document.querySelector("[data-report-column=findings]").scrollTop = 0; document.querySelector("[data-report-column=utility]").scrollTop = 0');
  await evaluate('document.querySelector("[data-report-column=findings]").focus()');
  const beforeKeys = await evaluate(`(() => ({ left: document.querySelector('[data-report-column="findings"]').scrollTop, right: document.querySelector('[data-report-column="utility"]').scrollTop }))()`);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 });
  await delay(250);
  const afterKeys = await evaluate(`(() => ({ left: document.querySelector('[data-report-column="findings"]').scrollTop, right: document.querySelector('[data-report-column="utility"]').scrollTop }))()`);
  assert.ok(afterKeys.left > beforeKeys.left, label + ': PageDown did not scroll the focused left column');
  assert.equal(afterKeys.right, beforeKeys.right, label + ': keyboard scroll leaked into the right column');
  await evaluate('document.activeElement?.blur()');

  // Restore the QA-only rows and collapsed evidence state.
  await evaluate('document.querySelectorAll("[data-s5-synthetic]").forEach(node => node.remove())');
  await evaluate(`document.querySelectorAll('#report-panel details').forEach(details => { details.open = false; })`);
  await settleUi(evaluate, label + ': restored findings');
}

async function testLinkage(evaluate, send, label) {
  await evaluate('document.getElementById("report-tab").click()');
  await settleUi(evaluate, label + ': report');
  // Native details/summary expansion and evidence actions stay reachable.
  const expanded = await evaluate(`(() => {
    const details = [...document.querySelectorAll('#report-panel details')].find(node => node.querySelector('[data-finding-replay-round]'));
    if (!details) return { open: false, focused: false, evidenceRows: 0, replayButtons: 0 };
    details.open = true;
    const summary = details.querySelector('summary');
    summary.focus();
    return { open: details.open, focused: document.activeElement === summary,
      evidenceRows: details.querySelectorAll('[class]').length,
      replayButtons: details.querySelectorAll('[data-finding-replay-round]').length };
  })()`);
  assert.equal(expanded.open, true);
  assert.equal(expanded.focused, true);
  assert.ok(expanded.evidenceRows > 2, label + ': Finding evidence did not expand');
  assert.ok(expanded.replayButtons > 0, label + ': Finding replay action missing');
  await capture(evaluate, send, 'finding-evidence-' + label);

  // Findings -> Timeline: switch views, expand and highlight the related round.
  await evaluate(` [...document.querySelectorAll('#report-panel button')].find(button => button.textContent.trim() === '查看 R24').click()`);
  await waitFor(() => evaluate(`document.getElementById("timeline-panel").checkVisibility() && document.querySelector('[data-timeline-round="24"]')?.dataset.highlighted === "true"`),
    10_000, label + ': Findings -> Timeline R24');
  await evaluate('document.getElementById("report-tab").click()');
  await settleUi(evaluate, label + ': report after timeline');

  // Findings evidence -> Replay view; the actual map session is covered by Replay acceptance.
  await evaluate(`document.querySelectorAll('#report-panel details').forEach(details => { details.open = true; })`);
  await evaluate(`document.querySelector('[data-finding-replay-round]').click()`);
  await waitFor(() => evaluate('document.getElementById("replay-panel").checkVisibility()'), 10_000, label + ': Findings -> Replay');
  await evaluate('document.getElementById("report-tab").click()');
  await settleUi(evaluate, label + ': report after replay');

  // Utility tabs keep their business meaning and rows in both views.
  await evaluate('document.querySelector("[data-utility-tab=damage]").click()');
  await settleUi(evaluate, label + ': damage tab');
  assert.equal(await evaluate('document.querySelector("[data-utility-tab=damage]").getAttribute("aria-selected")'), 'true');
  const damage = await evaluate(`(() => ({
    labels: [...document.querySelectorAll('[data-utility-row-label]')].map(node => node.textContent),
    values: [...document.querySelectorAll('[data-utility-row]')].map(node => [node.dataset.utilityRow, node.querySelector('[data-utility-row-value]').textContent]),
    text: document.querySelector('[data-utility-panel]').innerText,
  }))()`);
  assert.deepEqual(damage.labels, ['闪光弹', '烟雾弹', '高爆手雷', '燃烧弹', '诱饵弹']);
  assert.match(damage.values.find(([name]) => name === '闪光弹')[1], /^\d+\/\d+\/\d+$/);
  assert.equal(damage.values.find(([name]) => name === '烟雾弹')[1], '-');
  await evaluate('document.querySelector("[data-utility-tab=throws]").click()');
  await settleUi(evaluate, label + ': throws tab');
  assert.equal(await evaluate('document.querySelector("[data-utility-tab=throws]").getAttribute("aria-selected")'), 'true');
  assert.equal(await evaluate('document.querySelectorAll("[data-utility-row]").length'), 5);
}

async function testForcedColorsAndReducedMotion(evaluate, send, label) {
  await send('Emulation.setEmulatedMedia', { features: [
    { name: 'forced-colors', value: 'active' },
    { name: 'prefers-reduced-motion', value: 'reduce' },
  ] });
  await settleUi(evaluate, label + ': forced colors / reduced motion');
  assert.equal(await evaluate('matchMedia("(forced-colors: active)").matches'), true);
  assert.equal(await evaluate('matchMedia("(prefers-reduced-motion: reduce)").matches'), true);
  const state = await evaluate(`(() => {
    const panel = document.getElementById('report-panel');
    const kpis = [...document.querySelectorAll('[data-report-kpi]')];
    const columns = [...document.querySelectorAll('[data-report-column]')];
    return { text: kpis.map(node => node.innerText).join(' '), visible: kpis.every(node => node.checkVisibility() && node.getBoundingClientRect().height > 0),
      columns: columns.every(node => node.checkVisibility() && node.getBoundingClientRect().height > 0),
      columnsScrollable: columns.every(node => getComputedStyle(node).overflowY === 'auto'),
      panelOverflow: panel.scrollHeight - panel.clientHeight, pageOverflow: document.documentElement.scrollHeight - innerHeight };
  })()`);
  assert.equal(state.visible, true, label + ': KPI hidden in forced colors');
  assert.equal(state.columns, true, label + ': column hidden in forced colors');
  assert.equal(state.columnsScrollable, true);
  assert.ok(state.panelOverflow <= 1 && state.pageOverflow <= 1, label + ': forced colors introduced page scroll');
  for (const fragment of ['25 / 20 / 4', '91.38', '36.0%', '75%', '22.2%', '6', '4 首杀', '1 胜 / 3 次']) {
    assert.ok(state.text.includes(fragment), label + ': forced colors lost KPI value ' + fragment);
  }
  await capture(evaluate, send, 'forced-colors-reduced-motion-' + label);
  await send('Emulation.setEmulatedMedia', { features: [] });
  await settleUi(evaluate, label + ': media reset');
}

function longDemoPath() {
  const name = 'p7-s5-' + 'very-long-dem-file-name-'.repeat(5) + 'demo2.dem';
  const path = join(qaDir, name);
  try { unlinkSync(path); } catch { /* first run */ }
  linkSync(demo2, path);
  assert.ok(basename(path).length > 100, 'long filename fixture must exceed 100 characters');
  return path;
}

try {
  await scenario({
    label: 'S5 demo1 1024x640 / 1920x1032',
    demPath: demo1,
    body: async ({ evaluate, send }) => {
      await importReport(evaluate, send);
      for (const [width, height] of [[1024, 640], [1920, 1032]]) {
        await viewport(evaluate, send, width, height);
        const label = width + 'x' + height;
        await assertNoReportPageScroll(evaluate, label);
        const layout = await checkReportLayout(evaluate, 'S5 ' + label);
        results.layoutA.push({ viewport: label, left: layout.left, right: layout.right, panel: layout.panel });
        await assertKpiValues(evaluate, label);
        await assertTooltips(evaluate, send, label);
        await assertAccessibility(evaluate, send, label);
        await capture(evaluate, send, 'report-default-' + label);
        await testLinkage(evaluate, send, label);
        await testIndependentScrolling(evaluate, send, label);
        await testForcedColorsAndReducedMotion(evaluate, send, label);
        await assertNoReportPageScroll(evaluate, label + ' after interactions');
        results.checks.push(label + ': no page scroll, 8 KPIs, independent columns, linkage, tooltips, AX, forced colors');
      }
    },
  });

  const longDemo = longDemoPath();
  await withCleanup(async () => {
    await scenario({
      label: 'S5 demo2 coverage warning / long filename / empty findings',
      demPath: longDemo,
      body: async ({ evaluate, send }) => {
        await importReport(evaluate, send);
        await viewport(evaluate, send, 1024, 640);
        await assertNoReportPageScroll(evaluate, 'demo2 1024x640');
        await checkReportLayout(evaluate, 'S5 demo2 1024x640');
        const warning = await evaluate(`(() => {
          const panel = document.getElementById('report-panel');
          const bar = [...panel.querySelectorAll('.fui-MessageBar, [class*="MessageBar"]')].find(node => node.textContent.includes('部分回合贡献率、补枪或残局证据不完整。'));
          const grid = panel.querySelector('[aria-label="玩家指标"]');
          if (!bar || !grid) return null;
          const r = bar.getBoundingClientRect(), g = grid.getBoundingClientRect();
          return { text: bar.textContent, visible: bar.checkVisibility(), top: r.top, bottom: r.bottom, gridTop: g.top, height: r.height };
        })()`);
        assert.ok(warning, 'coverage warning is missing from the report DOM');
        assert.equal(warning.visible, true, 'coverage warning is not visible');
        assert.ok(warning.bottom <= warning.gridTop + 1, 'coverage warning and KPI grid overlap');
        assert.ok(warning.height > 0);
        await capture(evaluate, send, 'coverage-warning-1024x640');

        const fileName = await evaluate(`(() => {
          const content = document.querySelector('[data-app-content]');
          const span = [...content.querySelectorAll('span')].find(node => node.checkVisibility() && node.textContent === ${JSON.stringify(basename(longDemo))});
          if (!span) return null;
          const r = span.getBoundingClientRect();
          return { text: span.textContent, width: r.width, height: r.height, right: r.right,
            scrollWidth: span.scrollWidth, clientWidth: span.clientWidth, wrap: getComputedStyle(span).overflowWrap };
        })()`);
        assert.ok(fileName, 'long DEM filename is not rendered');
        assert.equal(fileName.text, basename(longDemo));
        assert.ok(fileName.height >= 16, 'long DEM filename collapsed');
        assert.ok(fileName.scrollWidth <= fileName.clientWidth + 1, 'long DEM filename is horizontally clipped');
        assert.equal(fileName.wrap, 'anywhere');

        // Choose a player whose report has no Findings; the empty state must stay visible.
        await evaluate('document.querySelector("[aria-label=目标玩家]").click()');
        await waitFor(() => evaluate('[...document.querySelectorAll("[role=option]")].some(option => option.textContent.includes("老彩笔123"))'), 10_000, 'empty-findings player option');
        await evaluate('[...document.querySelectorAll("[role=option]")].find(option => option.textContent.includes("老彩笔123")).click()');
        await waitFor(() => evaluate('document.getElementById("report-panel").textContent.includes("本场没有达到规则阈值且证据充分的复盘结论。")'), 10_000, 'empty Findings state');
        const empty = await evaluate(`(() => {
          const left = document.querySelector('[data-report-column="findings"]');
          return { text: left.innerText, focusable: left.tabIndex === 0, role: left.getAttribute('role'),
            visible: left.checkVisibility(), height: left.clientHeight, pageOverflow: document.documentElement.scrollHeight - innerHeight };
        })()`);
        assert.ok(empty.text.includes('本场没有达到规则阈值且证据充分的复盘结论。'));
        assert.equal(empty.focusable, true);
        assert.equal(empty.role, 'region');
        assert.equal(empty.visible, true);
        assert.ok(empty.height > 40);
        assert.ok(empty.pageOverflow <= 1);
        await assertNoReportPageScroll(evaluate, 'demo2 empty findings');
        await capture(evaluate, send, 'empty-findings-1024x640');
        results.checks.push('coverage warning visible, long filename wraps, empty Findings remains reachable');
      },
    });
  }, [() => rm(longDemo, { force: true })]);

  const broken = join(qaDir, 'broken.dem');
  writeFileSync(broken, 'this is not a cs2 demo');
  await scenario({
    label: 'S5 broken DEM error state',
    demPath: broken,
    body: async ({ evaluate, send }) => {
      await evaluate('document.querySelector("[data-sidebar-import]").focus()');
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', windowsVirtualKeyCode: 13 });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', text: '\r', windowsVirtualKeyCode: 13 });
      await waitFor(() => evaluate('document.body.textContent.includes("无法分析此 DEM")'), 60_000, 'broken DEM error');
      await viewport(evaluate, send, 1024, 640);
      const error = await evaluate(`(() => ({
        report: Boolean(document.getElementById('report-panel')),
        message: [...document.querySelectorAll('.fui-MessageBar, [class*="MessageBar"]')].some(node => node.textContent.includes('无法分析此 DEM')),
        retry: document.body.textContent.includes('重新选择 DEM'),
        pageOverflow: document.documentElement.scrollHeight - innerHeight,
      }))()`);
      assert.equal(error.report, false, 'broken DEM must not render a report panel');
      assert.equal(error.message, true, 'broken DEM error message missing');
      assert.equal(error.retry, true, 'broken DEM must keep the import entry');
      assert.ok(error.pageOverflow <= 1);
      await capture(evaluate, send, 'error-1024x640');
      results.checks.push('broken DEM error state stays visible without page scroll');
    },
  });

  console.log('S5 REPORT LAYOUT ACCEPTANCE: PASS');
  console.log(JSON.stringify(results, null, 2));
} catch (error) {
  console.error('S5 REPORT LAYOUT ACCEPTANCE: FAIL');
  console.error(error);
  process.exitCode = 1;
}
