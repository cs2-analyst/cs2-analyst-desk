import { checkDeepReviewUx } from './deep-review-ux-checks.mjs';
import { checkReportUx } from './report-ux-checks.mjs';
import { assertNoPageScroll, settleUi } from './window-shell-checks.mjs';
import { closeApp, connectCdp, waitFor, withCleanup } from './smoke-runtime.mjs';
import { ProcessScope } from './installed-smoke-lifecycle.mjs';
import { checkWindowShell } from './window-shell-checks.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const desktop = fileURLToPath(new URL('../apps/desktop/', import.meta.url));
const demo = fileURLToPath(new URL('../.demo/demo1.dem', import.meta.url));
const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const electron = require('electron');

assert.ok(existsSync(demo), `缺少测试 DEM：${demo}`);
assert.ok(existsSync(join(desktop, 'dist/electron/main.js')), '请先构建桌面应用（electron-vite build）');

/** P5.2.1 product polish: these tokens must never reach the rendered UI. */
const STIFF_ENGLISH = [/\bUtility\b/, /\bFlash\b/, /\bSmoke\b/, /\bHE\b/, /\bIncendiary\b/, /\bMolotov\b/, /\bDecoy\b/, /\bduration\b/i, /\btraded\b/i, /\btradeable\b/i, /可交易/, /被交易/, /\bwin\b/, /\bloss\b/];
function assertNoStiffEnglish(text) {
  for (const pattern of STIFF_ENGLISH) assert.ok(!pattern.test(text), 'UI 出现生硬英文或旧术语：' + pattern);
}

async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

/** Launches the built app with CS2_ANALYST_DEM_PATH so the import skips the native dialog. */
async function scenario({ label, demPath, ready, assertReport, assertDom, importMode = 'keyboard' }) {
  const port = await freePort();
  const env = { ...process.env, CS2_ANALYST_DEM_PATH: demPath };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  const profile = mkdtempSync(join(tmpdir(), 'cs2-analyst-report-profile-'));
  // The match library lives under LOCALAPPDATA, not --user-data-dir. Isolate it so the
  // pre-import empty state is deterministic and the real user library is untouched.
  const localAppData = mkdtempSync(join(tmpdir(), 'cs2-analyst-report-localappdata-'));
  env.LOCALAPPDATA = localAppData;
  const startedAt = Date.now();
  const child = spawn(electron, ['.', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows'], {
    cwd: desktop, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const scope = new ProcessScope();
  const tracked = scope.track(child, label, startedAt);
  let runFailure;
  let logs = '';
  child.stdout.on('data', data => { logs += data; });
  child.stderr.on('data', data => { logs += data; });
  let socket;
  try {
    let page;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      await scope.live();
      if (tracked.error) throw new Error(`应用启动器异常：${tracked.error.message}`, { cause: tracked.error });
      if (child.exitCode !== null) throw new Error(`应用提前退出：${child.exitCode} ${logs}`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) });
        page = (await response.json()).find(target => target.type === 'page');
        if (page?.webSocketDebuggerUrl) break;
      } catch { /* Electron 尚未开放调试端口。 */ }
      await delay(200);
    }
    assert.ok(page?.webSocketDebuggerUrl, `等待窗口超时：${logs}`);
    const connection = await connectCdp(page.webSocketDebuggerUrl);
    socket = connection.socket;
    const { send, evaluate } = connection;
    const errors = [];
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.method === 'Runtime.exceptionThrown') errors.push(message.params);
    });
    await send('Runtime.enable');
    await send('Page.enable');

    const shell = await waitFor(async () => {
      const state = await evaluate('({ ready: document.readyState, text: document.body.textContent, node: typeof window.require, version: window.cs2Analyst?.version })');
      return state?.ready === 'complete' && state.text?.includes('CS2 Analyst') ? state : null;
    }, 30_000, 'React 页面');
    assert.equal(shell.node, 'undefined', '渲染进程不应暴露 Node.js');
    assert.equal(shell.version, '0.1.0', 'preload 桥接未加载');
    await checkWindowShell(evaluate, send);

    if (importMode === 'file-drop') {
      // Chromium-backed File from the repository fixture, through the real contextBridge.
      // This exercises the File -> preload -> IPC -> Utility chain, not Windows Explorer drag.
      await evaluate(`(() => { const input = document.createElement('input'); input.type = 'file'; input.id = 'qa-file'; input.hidden = true; document.body.append(input); })()`);
      const { root } = await send('DOM.getDocument');
      const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: '#qa-file' });
      await send('DOM.setFileInputFiles', { nodeId, files: [demPath] });
      await evaluate(`(() => { const transfer = new DataTransfer(); transfer.items.add(document.getElementById('qa-file').files[0]);
        document.querySelector('[data-import-card]').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer })); document.getElementById('qa-file').remove(); })()`);
    } else {
      await evaluate(`document.querySelector('[data-sidebar-import]').focus()`);
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', windowsVirtualKeyCode: 13 });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    }
    const body = await waitFor(async () => {
      const text = await evaluate('document.body.textContent');
      return ready(text) ? text : null;
    }, 120_000, label, { diagnostics: () => evaluate('({text:document.body.innerText,status:document.querySelector("main")?.dataset.status})') });
    assertReport(body);
    assertNoStiffEnglish(body);
    await assertDom?.(evaluate, send);
    assert.deepEqual(errors, [], '页面存在未捕获异常');
    console.log(`${label}：通过`);

    await closeApp({ child, evaluate, socket });
  } catch (error) {
    runFailure = new Error(`${label} 失败\n${logs}`, { cause: error });
  } finally {
    await withCleanup(() => { if (runFailure) throw runFailure; }, [
      () => socket?.close(),
      () => scope.cleanup(),
      // Windows helpers may briefly hold profile handles after the parent exits.
      () => rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }),
      () => rm(localAppData, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }),
    ]);
  }
}

await scenario({
  label: '真实 DEM 报告',
  importMode: 'file-drop',
  demPath: demo,
  ready: text => text.includes('twinkle') && text.includes('25 / 20 / 4'),
  assertReport: text => {
    for (const expected of ['de_dust2', '13 : 11', 'twinkle', '25 / 20 / 4', '91.38', '75%', '22.2%',
      'CT 方 ADR 明显低于 T 方', '死亡后队友补枪偏少', '本场多次闪到队友',
      'R24 1v3 残局获胜', '本场首杀对决贡献突出', '重新选择 DEM',
      '4 / 18 次死亡后队友完成补枪', '简要分析', '投掷统计', '伤害统计',
      '闪光弹', '烟雾弹', '燃烧弹', '诱饵弹',
      '回合开始后', '26.63 秒', '局面', '结果', '回合时间线', '查看详情']) {
      assert.ok(text.includes(expected), `报告缺少内容：${expected}`);
    }
    assert.ok(!/tick \d+/.test(text), '证据行不应默认显示原始 tick');
  },
  assertDom: async (evaluate, send) => {
    assert.equal(await evaluate(`document.getElementById('report-panel').hidden`), false);
    assert.equal(await evaluate(`document.getElementById('report-tab').getAttribute('aria-selected')`), 'true');
    assert.deepEqual(await evaluate(`[...document.querySelectorAll('[data-app-sidebar] [role="tab"]')].map(t => t.querySelector('.fui-Tab__content').textContent)`), ['比赛报告', '深度复盘', '回合时间线', '分析', '比赛回放', '热力图']);
    assert.equal(await evaluate(`[...document.querySelectorAll('[role="tabpanel"]')].filter(p => !p.parentElement.closest('[role="tabpanel"]')).length`), 6);
    await checkDeepReviewUx(evaluate, send, process.env.CS2_ANALYST_QA_DIR);
    await evaluate(`document.getElementById('report-tab').click()`);
    await settleUi(evaluate, 'report Tab render');
    const helps = await evaluate('document.querySelectorAll(\'button[aria-label$="说明"]\').length');
    assert.ok(helps >= 9, `核心指标与道具面板的 Tooltip 入口不足：${helps}`);

    // Utility card: one card, two tabs, merged fire throws and a flash-only composite value.
    assert.equal(await evaluate(`document.querySelector('[data-utility-tab="throws"]').getAttribute('aria-selected')`), 'true');
    const utilityTabs = await evaluate(`[...document.querySelectorAll('[data-utility-tab]')].map(t => t.querySelector('.fui-Tab__content')?.textContent ?? t.textContent)`);
    assert.deepEqual(utilityTabs, ['投掷统计', '伤害统计']);
    const throwLabels = await evaluate(`[...document.querySelectorAll('[data-utility-row-label]')].map(e => e.textContent)`);
    assert.deepEqual(throwLabels, ['闪光弹', '烟雾弹', '高爆手雷', '燃烧弹', '诱饵弹']);
    assert.equal(await evaluate(`document.querySelector('[data-utility-panel]').textContent.includes('投掷数量')`), false);
    assert.equal(await evaluate(`document.querySelector('[data-utility-panel]').textContent.includes('燃烧瓶')`), false);
    await evaluate(`document.querySelector('[data-utility-tab="damage"]').click()`);
    await settleUi(evaluate, '伤害统计 Tab');
    assert.equal(await evaluate(`document.querySelector('[data-utility-tab="damage"]').getAttribute('aria-selected')`), 'true');
    const damageLabels = await evaluate(`[...document.querySelectorAll('[data-utility-row-label]')].map(e => e.textContent)`);
    assert.deepEqual(damageLabels, throwLabels);
    const damageValues = await evaluate(`[...document.querySelectorAll('[data-utility-row]')].map(r => [r.dataset.utilityRow, r.querySelector('[data-utility-row-value]').textContent])`);
    assert.match(damageValues.find(([label]) => label === '闪光弹')[1], /^\d+\/\d+\/\d+$/);
    assert.equal(damageValues.find(([label]) => label === '烟雾弹')[1], '-');
    assert.equal(damageValues.find(([label]) => label === '诱饵弹')[1], '-');
    assert.ok(damageValues.find(([label]) => label === '高爆手雷')[1].includes('点'));
    assert.ok(damageValues.find(([label]) => label === '燃烧弹')[1].includes('点'));
    await evaluate(`document.querySelector('[data-utility-flash]').focus()`);
    await waitFor(async () => evaluate(`[...document.querySelectorAll('[role="tooltip"]')].some(t => t.textContent.includes('致盲敌人') && t.textContent.includes('闪光助攻'))`), 10_000, '闪光数值 Tooltip');
    assert.equal(await evaluate(`document.querySelector('[data-utility-panel]').textContent.includes('受闪次数按游戏记录到的受闪事件统计')`), false, '底部说明已迁移到标题旁 Tooltip');
    await evaluate(`document.querySelector('[aria-label="道具面板说明"]').focus()`);
    await waitFor(async () => evaluate(`[...document.querySelectorAll('[role="tooltip"]')].some(t => t.textContent.includes('受闪次数') && t.textContent.includes('有效闪光次数'))`), 10_000, '道具面板说明 Tooltip');
    await evaluate(`document.querySelector('[data-utility-tab="throws"]').click()`);
    await settleUi(evaluate, '投掷统计 Tab return');
    assert.equal(await evaluate(`document.querySelector('[data-utility-tab="throws"]').getAttribute('aria-selected')`), 'true');

    // Round Timeline: 24 collapsed summaries; R24 reads T / 成功 / 13 : 11.
    const summaries = await evaluate(`(() => {
      const rows = [...document.querySelectorAll('[data-round-summary]')];
      const r24 = rows.find(row => row.getAttribute('data-round-summary') === '24');
      return {
        count: rows.length,
        r24: r24?.textContent ?? '',
        expanded: r24?.getAttribute('aria-expanded'),
        detail: Boolean(document.querySelector('[data-round-detail="24"]')),
      };
    })()`);
    assert.equal(summaries.count, 24, `回合时间线应列出 24 个回合，实际 ${summaries.count}`);
    for (const expected of ['R24', 'T', '成功', '13 : 11']) {
      assert.ok(summaries.r24.includes(expected), `R24 摘要缺少“${expected}”：${summaries.r24}`);
    }
    assert.equal(summaries.expanded, 'false', '回合默认收起');
    assert.equal(summaries.detail, false, '默认不展开回合事件');

    // Findings linkage: 查看 R24 expands the round, scrolls to it and highlights it.
    const clickedFinding = await evaluate(`(() => {
      const button = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === '查看 R24');
      button?.click();
      return Boolean(button);
    })()`);
    assert.equal(clickedFinding, true, 'Findings 缺少“查看 R24”入口');
    const r24Detail = await waitFor(async () => {
      const text = await evaluate(`document.querySelector('[data-round-detail="24"]')?.textContent ?? ''`);
      return text.includes('进入 1v3 残局') ? text : null;
    }, 10_000, 'R24 展开');
    assert.ok(r24Detail.includes('开始安放炸弹'), 'R24 应包含炸弹安放事件');
    assert.ok(r24Detail.includes('炸弹安放完成'), 'R24 应包含炸弹安放完成事件');
    assert.equal(await evaluate(`document.querySelectorAll('[data-round-detail="24"] [data-killfeed-event="kill"]').length`), 4);
    assert.ok(!r24Detail.includes('twinkle →'), '击杀正文不再使用箭头');
    assert.ok(/\+\d+\.\d{2} 秒/.test(r24Detail), '时间应显示为回合开始后的秒数');
    assert.ok(!/tick\s*\d+/.test(r24Detail), '时间线不应显示原始 tick');
    assert.ok(r24Detail.includes('8888888888888888888888'), '长数字昵称应原样显示');
    assert.equal(await evaluate(`document.getElementById('timeline-panel').hidden`), false);
    const highlighted = await evaluate(`document.querySelector('[data-timeline-round="24"]')?.getAttribute('data-highlighted')`);
    assert.equal(highlighted, 'true', '联动后应强调对应回合');

    // R7 3K + defuse, expanded manually from the summary row.
    await evaluate(`document.querySelector('[data-round-summary="7"]')?.click()`);
    const r7Detail = await waitFor(async () => {
      const text = await evaluate(`document.querySelector('[data-round-detail="7"]')?.textContent ?? ''`);
      return text.includes('炸弹拆除成功') ? text : null;
    }, 10_000, 'R7 展开');
    assert.ok(r7Detail.includes('开始拆弹'), 'R7 应包含开始拆弹');
    assert.equal(await evaluate(`document.querySelectorAll('[data-round-detail="7"] [data-killfeed-event="kill"]').length`), 3);

    // Analysis uses the same parsed report and retains Timeline/Findings state across tabs.
    assert.equal(await evaluate(`document.getElementById('timeline-panel').hidden`), false);
    await evaluate(`document.getElementById('analysis-tab').click()`);
    await waitFor(async () => evaluate(`!document.getElementById('analysis-panel').hidden`), 10_000, '分析 Tab');
    assert.equal(await evaluate(`document.getElementById('report-panel').hidden`), true);
    const showAnalysisTab = async active => {
      await evaluate(`document.querySelector('[data-analysis-tab="${active}"]').click()`);
      await settleUi(evaluate, 'analysis tab ' + active);
      const tabs = await evaluate(`[...document.querySelectorAll('#analysis-panel [data-analysis-tab]')].map(t => ({
        key: t.dataset.analysisTab, label: t.querySelector('.fui-Tab__content')?.textContent ?? t.textContent, selected: t.getAttribute('aria-selected'),
        panelHidden: document.querySelector('[data-analysis-panel="' + t.dataset.analysisTab + '"]').hidden,
      }))`);
      assert.deepEqual(tabs.map(t => t.key), ['comparison', 'trend', 'sides']);
      assert.deepEqual(tabs.map(t => t.label), ['全场玩家对比', '回合表现趋势', 'CT / T 表现对比']);
      for (const t of tabs) {
        assert.equal(t.selected, String(t.key === active), 'analysis selected: ' + t.key);
        assert.equal(t.panelHidden, t.key !== active, 'analysis panel: ' + t.key);
      }
    };
    await showAnalysisTab('comparison');
    await assertNoPageScroll(evaluate, '分析初始视图');
    assert.equal(await evaluate(`document.querySelectorAll('#analysis-panel [data-analysis-tab]').length`), 3, '分析应始终显示三个选项卡');
    const analysis = await evaluate(`(() => {
      const rows = [...document.querySelectorAll('[data-comparison-player]')];
      return { count: rows.length, values: rows.map(r => Number(r.dataset.metricValue)),
        current: rows.filter(r => r.textContent.includes('· 当前')).map(r => r.textContent),
        ct: document.querySelector('[data-analysis-side="CT"]').textContent,
        t: document.querySelector('[data-analysis-side="T"]').textContent,
        rounds: document.querySelectorAll('[data-trend-round]').length,
        r7: document.querySelector('[data-trend-round="7"]').getAttribute('aria-label'),
        r22: document.querySelector('[data-trend-round="22"]').getAttribute('aria-label'),
        r24: document.querySelector('[data-trend-round="24"]').getAttribute('aria-label'),
        player: document.querySelector('[aria-label="目标玩家"]').textContent,
        shell: document.body.textContent,
      };
    })()`);
    assert.equal(analysis.count, 10);
    assert.ok(await evaluate(`([...document.querySelectorAll('[data-comparison-player]')].some(r => r.textContent.includes('8888888888888888888888')))`), '分析页保留长数字昵称');
    assert.deepEqual(analysis.values, [...analysis.values].sort((a, b) => b - a));
    assert.equal(analysis.current.length, 1);
    const barColors = await evaluate(`(() => { const rows = [...document.querySelectorAll('[data-comparison-player]')]; return rows.map(r => ({ current: r.textContent.includes('· 当前'), color: getComputedStyle(r.children[1].firstElementChild).backgroundColor })); })()`);
    assert.equal(barColors.find(r => r.current).color, 'rgb(98, 171, 245)');
    assert.notEqual(barColors.find(r => r.current).color, barColors.find(r => !r.current).color);
    assert.ok(analysis.current[0].includes('twinkle') && analysis.current[0].includes('91.38'));
    for (const text of ['de_dust2', '13 : 11', '重新选择 DEM']) assert.ok(analysis.shell.includes(text));
    assert.ok(analysis.player.includes('twinkle'));
    assert.equal(analysis.rounds, 24);
    for (const text of ['R7', 'CT', '成功', '3 击杀']) assert.ok(analysis.r7.includes(text));
    for (const text of ['R22', 'T', '失败', '1 击杀', '阵亡']) assert.ok(analysis.r22.includes(text));
    for (const text of ['R24', 'T', '成功', '4 击杀', '未阵亡']) assert.ok(analysis.r24.includes(text));
    for (const text of ['12', '10 / 10 / 3', '68.25']) assert.ok(analysis.ct.includes(text));
    for (const text of ['12', '15 / 10 / 1', '114.50']) assert.ok(analysis.t.includes(text));

    // Tooltip opens on keyboard focus; labels give an accessible non-colour description.
    await showAnalysisTab('trend');
    await assertNoPageScroll(evaluate, '回合表现趋势');
    await evaluate(`document.querySelector('[data-trend-round="24"]').focus()`);
    await waitFor(async () => evaluate(`[...document.querySelectorAll('[role="tooltip"]')].some(t => t.textContent.includes('4 击杀') && t.textContent.includes('未阵亡'))`), 10_000, '回合 Tooltip');
    await showAnalysisTab('sides');
    await assertNoPageScroll(evaluate, 'CT / T 对比');
    await showAnalysisTab('comparison');
    await evaluate(`document.querySelector('[data-comparison-player][aria-label^="twinkle"]').focus()`);
    await waitFor(async () => evaluate(`[...document.querySelectorAll('[role="tooltip"]')].some(t => t.textContent.includes('twinkle') && t.textContent.includes('91.38'))`), 10_000, '玩家对比 Tooltip');

    // All seven choices format the frozen metric values and keep all players visible.
    for (const [label, expected] of [['K/D', '1.25'], ['KAST', '75.0%'], ['HS%', null],
      ['首杀对决胜率', '100.0%'], ['死亡后队友补枪率', '22.2%'], ['补枪击杀', '6'], ['ADR', '91.38']]) {
      await evaluate(`document.querySelector('[aria-label="对比指标"]').click()`);
      await waitFor(async () => evaluate(`(() => {
        const option = [...document.querySelectorAll('[role="option"]')].find(o => o.textContent.trim() === ${JSON.stringify(label)});
        option?.click(); return Boolean(option);
      })()`), 10_000, `指标 ${label}`);
      await waitFor(async () => evaluate(`document.querySelector('[aria-label="对比指标"]').textContent === ${JSON.stringify(label)}`), 10_000, '指标切换');
      const rows = await evaluate(`([...document.querySelectorAll('[data-comparison-player]')].map(r => ({ text: r.textContent, value: r.dataset.metricValue })))`);
      assert.equal(rows.length, 10);
      const current = rows.find(r => r.text.includes('· 当前'));
      if (expected) assert.ok(current.text.includes(expected), `${label} 格式不正确：${current.text}`);
      const values = rows.filter(r => r.value !== 'null').map(r => Number(r.value));
      assert.deepEqual(values, [...values].sort((a, b) => b - a));
      let foundNull = false;
      for (const row of rows) {
        if (row.value === 'null') { foundNull = true; assert.ok(row.text.includes('—')); }
        else assert.equal(foundNull, false, 'null 排在最后');
      }
    }

    // Screenshot artifacts outside the checkout; each tab owns its own scroll surface.
    if (process.env.CS2_ANALYST_QA_DIR) {
      await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
      await evaluate(`document.querySelector('[data-app-content]').scrollTo(0, 0)`);
      await showAnalysisTab('comparison');
      await settleUi(evaluate, 'desktop screenshot');
      const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      writeFileSync(join(process.env.CS2_ANALYST_QA_DIR, 'analysis-desktop.png'), Buffer.from(shot.data, 'base64'));
      await send('Emulation.setDeviceMetricsOverride', { width: 900, height: 760, deviceScaleFactor: 1, mobile: false });
      await settleUi(evaluate, 'narrow screenshot');
      assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true, '窄窗口不应整页横向溢出');
      const narrow = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      writeFileSync(join(process.env.CS2_ANALYST_QA_DIR, 'analysis-narrow.png'), Buffer.from(narrow.data, 'base64'));
      await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
      await showAnalysisTab('trend');
      await evaluate(`document.querySelector('[data-analysis-panel="trend"]').scrollTo(0, 0)`);
      await settleUi(evaluate, 'trend screenshot');
      const trendShot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      writeFileSync(join(process.env.CS2_ANALYST_QA_DIR, 'analysis-trend.png'), Buffer.from(trendShot.data, 'base64'));
      await showAnalysisTab('sides');
      await settleUi(evaluate, 'sides screenshot');
      const sidesShot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      writeFileSync(join(process.env.CS2_ANALYST_QA_DIR, 'analysis-sides.png'), Buffer.from(sidesShot.data, 'base64'));
      await send('Emulation.clearDeviceMetricsOverride');
    }
    await evaluate(`document.getElementById('report-tab').click()`);
    await waitFor(async () => evaluate(`!document.getElementById('report-panel').hidden`), 10_000, '返回比赛报告');
    assert.equal(await evaluate(`document.querySelector('[data-round-summary="24"]').getAttribute('aria-expanded')`), 'true');
    assert.equal(await evaluate(`document.querySelector('[data-round-summary="7"]').getAttribute('aria-expanded')`), 'true');
    assert.ok(await evaluate(`document.body.textContent.includes('R24 1v3 残局获胜')`));

    await checkReportUx(evaluate, send, process.env.CS2_ANALYST_QA_DIR);

    // Player switch updates side / result / events without re-importing the DEM.
    const opened = await evaluate(`(() => {
      const trigger = document.querySelector('[aria-label="目标玩家"]');
      trigger?.click();
      return Boolean(trigger);
    })()`);
    assert.equal(opened, true, '未找到目标玩家下拉框');
    assert.ok(await evaluate(`([...document.querySelectorAll('[role="option"]')].some(o => o.textContent === '8888888888888888888888'))`), 'Dropdown 保留完整长数字昵称');
    await waitFor(async () => evaluate(`(() => {
      const option = [...document.querySelectorAll('[role="option"]')].find(o => o.textContent.trim() === 'tarkz');
      if (!option) return null;
      option.click();
      return true;
    })()`), 10_000, '选择其他玩家');
    const r24AfterSwitch = await waitFor(async () => {
      const text = await evaluate(`document.querySelector('[data-round-summary="24"]')?.textContent ?? ''`);
      return text.includes('CT') && text.includes('失败') ? text : null;
    }, 10_000, '玩家切换后时间线更新');
    assert.ok(r24AfterSwitch.includes('13 : 11'), '比分不随目标玩家变化');
    await evaluate(`document.getElementById('analysis-tab').click()`);
    await waitFor(async () => evaluate(`!document.getElementById('analysis-panel').hidden`), 10_000, '其他玩家分析');
    await showAnalysisTab('comparison');
    const other = await evaluate(`({
      current: [...document.querySelectorAll('[data-comparison-player]')].find(r => r.textContent.includes('· 当前'))?.textContent,
    })`);
    assert.ok(other.current.includes('tarkz'));
    await showAnalysisTab('trend');
    const otherR24 = await evaluate(`document.querySelector('[data-trend-round="24"]').getAttribute('aria-label')`);
    assert.ok(otherR24.includes('CT') && otherR24.includes('失败'));

    // A fresh match import remounts the report and resets every local tab default.
    await evaluate(`document.querySelector('[data-sidebar-import]').click()`);
    await waitFor(async () => {
      const status = await evaluate(`document.querySelector('main')?.dataset.status`);
      return status && status !== 'success' ? status : null;
    }, 15_000, '重新导入开始');
    await waitFor(async () => {
      const state = await evaluate(`({ status: document.querySelector('main')?.dataset.status,
        report: !document.getElementById('report-panel')?.hidden,
        selected: document.getElementById('report-tab')?.getAttribute('aria-selected') })`);
      return state.status === 'success' && state.report && state.selected === 'true' ? state : null;
    }, 120_000, '重新导入完成');
    await evaluate(`document.getElementById('deep-review-tab').click()`);
    await settleUi(evaluate, '重新导入后的深度复盘');
    assert.equal(await evaluate(`document.querySelectorAll('#deep-review-panel [data-deep-tab]').length`), 3);
    assert.equal(await evaluate(`document.querySelector('[data-deep-tab="reviews"]').getAttribute('aria-selected')`), 'true', '新比赛默认优先复盘');
    await evaluate(`document.getElementById('analysis-tab').click()`);
    await settleUi(evaluate, '重新导入后的分析');
    assert.equal(await evaluate(`document.querySelector('[data-analysis-tab="comparison"]').getAttribute('aria-selected')`), 'true', '新比赛默认全场玩家对比');
    assert.equal(await evaluate(`document.querySelector('[aria-label="对比指标"]').textContent`), 'ADR', '新比赛使用默认指标');
    assert.ok(await evaluate(`[...document.querySelectorAll('[data-comparison-player]')].some(r => r.textContent.includes('· 当前'))`));
    await assertNoPageScroll(evaluate, '重新导入后的分析视图');

  },
});

const dir = mkdtempSync(join(tmpdir(), 'cs2-analyst-smoke-'));
await withCleanup(async () => {
  const broken = join(dir, 'broken.dem');
  writeFileSync(broken, 'this is not a cs2 demo');
  await scenario({
    label: '损坏 DEM 错误处理',
    demPath: broken,
    ready: text => text.includes('无法分析此 DEM'),
    assertReport: text => {
      assert.ok(text.includes('CS2 Analyst'), '错误后页面不应白屏');
      assert.ok(text.includes('选择 DEM'), '错误后应保留重新选择入口');
    },
    assertDom: async evaluate => {
      const rows = await evaluate("document.querySelectorAll('[data-round-summary]').length");
      assert.equal(rows, 0, '损坏 DEM 不应渲染回合时间线');
      assert.equal(await evaluate("Boolean(document.getElementById('round-timeline'))"), false, '损坏 DEM 不应残留时间线区块');
    },
  });
  const notDemo = join(dir, 'notes.txt');
  writeFileSync(notDemo, 'plain text');
  await scenario({
    label: '非 .dem 扩展名拒绝',
    demPath: notDemo,
    ready: text => text.includes('请选择 .dem 文件'),
    assertReport: text => {
      assert.ok(text.includes('选择 DEM'), '拒绝后应保留重新选择入口');
    },
  });
}, [() => rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })]);
