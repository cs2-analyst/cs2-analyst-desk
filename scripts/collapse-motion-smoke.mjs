import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { connectCdp, closeApp, waitFor } from './smoke-runtime.mjs';
import { ProcessScope } from './installed-smoke-lifecycle.mjs';
import { assertNoPageScroll, settleUi, waitForUi } from './window-shell-checks.mjs';

/**
 * P7-S3 real-Electron acceptance.
 *
 * Covers the two native <details> entries (Findings evidence, Deep Review caveats),
 * the round timeline disclosure, the sidebar width transition, both production window
 * sizes, mouse/keyboard/rapid toggling, focus removal, reduced motion and forced colours.
 *
 * Run after building the desktop app:
 *   node scripts/collapse-motion-smoke.mjs
 */

const root = fileURLToPath(new URL('..', import.meta.url));
const desktop = join(root, 'apps/desktop');
const demo = join(root, '.demo/demo1.dem');
const qaDir = join(root, '.tmp/p7-s3-qa');
mkdirSync(qaDir, { recursive: true });
assert.ok(existsSync(demo), '缺少本地 .demo/demo1.dem');
assert.ok(existsSync(join(desktop, 'dist/electron/main.js')), '请先构建桌面应用（electron-vite build）');

const require = createRequire(join(desktop, 'package.json'));
const electron = require('electron');
const nativeWindow = "process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron').BrowserWindow.getAllWindows()[0]";

async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

const port = await freePort();
const profile = mkdtempSync(join(tmpdir(), 'cs2-analyst-s3-profile-'));
const env = { ...process.env, CS2_ANALYST_DEM_PATH: demo };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_RENDERER_URL;
const startedAt = Date.now();
const child = spawn(electron, ['.', '--inspect=0', '--remote-debugging-port=' + port, '--user-data-dir=' + profile,
  '--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows'], {
  cwd: desktop, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
});
const scope = new ProcessScope();
scope.track(child, 'P7-S3 collapse motion', startedAt);
let logs = '';
child.stdout.on('data', data => { logs += data; });
child.stderr.on('data', data => { logs += data; });

let page;
let mainInspector;
let runFailure;

const screenshots = [];
const timelineSamples = [];
const detailsSamples = [];

try {
  const target = await waitFor(async () => {
    try {
      return (await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()).find(item => item.type === 'page');
    } catch { return null; }
  }, 60_000, 'CDP page');
  page = await connectCdp(target.webSocketDebuggerUrl);
  mainInspector = await connectCdp(await waitFor(() => /Debugger listening on (ws:\/\/\S+)/.exec(logs)?.[1], 20_000, 'main inspector'));

  const { evaluate, send } = page;
  const exceptions = [];
  page.socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params);
  });
  await send('Runtime.enable');
  await send('Page.enable');
  await waitFor(() => evaluate('Boolean(window.cs2Analyst && document.querySelector("[data-sidebar-import]"))'), 30_000, 'React ready');

  const screenshot = async name => {
    await settleUi(evaluate, 'screenshot ' + name);
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const path = join(qaDir, name + '.png');
    writeFileSync(path, Buffer.from(shot.data, 'base64'));
    screenshots.push(path);
  };
  const resize = async (width, height) => {
    await mainInspector.evaluate(`(()=>{const w=${nativeWindow};w.unmaximize();w.setBounds({x:0,y:0,width:${width},height:${height}});return w.getBounds();})()`);
    await waitFor(() => evaluate(`innerWidth===${width}&&innerHeight===${height}`), 10_000, `real window ${width}×${height}`);
  };
  const media = async (reduce, forced) => {
    await send('Emulation.setEmulatedMedia', {
      features: [
        { name: 'prefers-reduced-motion', value: reduce ? 'reduce' : 'no-preference' },
        { name: 'forced-colors', value: forced ? 'active' : 'none' },
      ],
    });
    await waitFor(() => evaluate(`matchMedia('(prefers-reduced-motion: reduce)').matches===${reduce}&&matchMedia('(forced-colors: active)').matches===${forced}`), 5_000, 'emulated media');
  };
  const selectPlayer = async nickname => {
    await evaluate('document.querySelector(\'[aria-label="目标玩家"]\').click()');
    await waitForUi(evaluate, 'document.querySelectorAll("[role=option]").length > 0', 'player options');
    const selected = await evaluate(`(()=>{const option=[...document.querySelectorAll('[role="option"]')].find(item=>item.textContent===${JSON.stringify(nickname)});option?.click();return Boolean(option);})()`);
    assert.equal(selected, true, '找不到玩家选项：' + nickname);
    await settleUi(evaluate, 'player switch');
  };

  // One real import; the file-drop path is already covered by the repo's report smoke.
  await evaluate('document.querySelector("[data-sidebar-import]").click()');
  await waitFor(() => evaluate('document.querySelector("main").dataset.status === "success"'), 180_000, '真实报告导入', { intervalMs: 200 });
  await settleUi(evaluate, 'report ready');
  await waitForUi(evaluate, 'document.getElementById("report-panel").checkVisibility()', 'report panel');

  const reportReady = await evaluate(`(()=>{
    const node = document.getElementById('deep-review-panel');
    let fiber = node[Object.keys(node).find(key => key.startsWith('__reactFiber$'))];
    while (fiber && !fiber.memoizedProps?.report?.deepReview) fiber = fiber.return;
    if (!fiber) return false;
    window.__s3Report = fiber.memoizedProps.report;
    return true;
  })()`);
  assert.equal(reportReady, true, '读取真实报告数据失败');

  const support = await evaluate(`({
    detailsContent: CSS.supports('selector(::details-content)'),
    interpolateSize: CSS.supports('interpolate-size: allow-keywords'),
    discrete: CSS.supports('transition-behavior: allow-discrete'),
    chromium: navigator.userAgent,
  })`);
  assert.equal(support.detailsContent, true, 'Chromium 缺少 ::details-content');
  assert.equal(support.interpolateSize, true, 'Chromium 缺少 interpolate-size');
  assert.equal(support.discrete, true, 'Chromium 缺少 allow-discrete');
  console.log('Chromium:', support.chromium.match(/Chrome\/[0-9.]+/)?.[0]);

  const inspectDetails = selector => evaluate(`(()=>{
    const d = document.querySelector(${JSON.stringify(selector)});
    if (!d) return null;
    return { open: d.open, summary: d.querySelector('summary')?.textContent ?? '', children: d.children.length,
      height: d.getBoundingClientRect().height, scroll: [d.scrollHeight, d.clientHeight] };
  })()`);

  const sampleDetails = selector => evaluate(`(async()=>{
    const d = document.querySelector(${JSON.stringify(selector)});
    if (!d) return null;
    const summary = d.querySelector('summary');
    const before = d.getBoundingClientRect().height;
    summary.click();
    const samples = [];
    const started = performance.now();
    while (performance.now() - started < 620) {
      await new Promise(resolve => requestAnimationFrame(resolve));
      samples.push([Math.round(performance.now() - started), Number(d.getBoundingClientRect().height.toFixed(2))]);
    }
    const style = getComputedStyle(d, '::details-content');
    const last = d.lastElementChild;
    return { before, after: d.getBoundingClientRect().height, open: d.open,
      contentVisibility: style.contentVisibility, contentBlockSize: style.blockSize,
      scrollHeight: d.scrollHeight, clientHeight: d.clientHeight, samples,
      lastBottom: last ? last.getBoundingClientRect().bottom : null,
      bottom: d.getBoundingClientRect().bottom };
  })()`);

  const sampleTimeline = round => evaluate(`(async()=>{
    const button = document.querySelector('[data-round-summary="' + ${round} + '"]');
    button.click();
    const samples = [];
    const started = performance.now();
    while (performance.now() - started < 620) {
      await new Promise(resolve => requestAnimationFrame(resolve));
      const wrapper = document.querySelector('[data-timeline-collapse]');
      samples.push([Math.round(performance.now() - started), wrapper ? Number(wrapper.getBoundingClientRect().height.toFixed(2)) : null]);
    }
    const wrapper = document.querySelector('[data-timeline-collapse]');
    const inner = wrapper?.querySelector('.timeline-collapse-inner');
    const detail = document.querySelector('[data-round-detail="' + ${round} + '"]');
    return { expanded: button.getAttribute('aria-expanded'), samples, detail: Boolean(detail),
      wrapper: wrapper ? { height: wrapper.getBoundingClientRect().height, expanded: wrapper.dataset.expanded,
        inert: wrapper.inert, state: wrapper.dataset.timelineCollapse } : null,
      inner: inner ? { height: inner.getBoundingClientRect().height, scrollHeight: inner.scrollHeight,
        clientHeight: inner.clientHeight, lastBottom: inner.lastElementChild?.getBoundingClientRect().bottom ?? null,
        bottom: inner.getBoundingClientRect().bottom } : null };
  })()`);

  const focusInside = (selector, target) => evaluate(`(()=>{
    const root = document.querySelector(${JSON.stringify(selector)});
    const element = root?.querySelector(${JSON.stringify(target)});
    if (!element) return null;
    element.focus();
    return { focused: document.activeElement === element, tag: element.tagName };
  })()`);

  const assertDetailsOpenAnimation = sample => {
    assert.ok(sample, '没有找到 details');
    assert.equal(sample.open, true);
    assert.ok(sample.after > sample.before + 8, 'details 打开后高度没有增长');
    assert.ok(sample.samples.some(([, height]) => height !== null && height > sample.before + 1 && height < sample.after - 1),
      'details 打开没有可见的中间高度');
    assert.equal(sample.contentVisibility, 'visible');
    assert.ok(sample.scrollHeight <= sample.clientHeight + 1, 'details 打开后仍有隐藏内容');
    if (sample.lastBottom !== null) assert.ok(sample.lastBottom <= sample.bottom + 1, 'details 最后一行被裁断');
  };
  const assertDetailsCloseAnimation = sample => {
    assert.ok(sample);
    assert.equal(sample.open, false);
    assert.ok(sample.after < sample.before - 8, 'details 关闭后高度没有收回');
    assert.ok(sample.samples.some(([, height]) => height !== null && height > sample.after + 1 && height < sample.before - 1),
      'details 关闭没有可见的中间高度');
    assert.equal(sample.contentVisibility, 'hidden');
  };

  // ---------------------------------------------------------------- native details
  const detailsMeta = await evaluate(`(()=>{
    const all = [...document.querySelectorAll('#report-panel details')];
    const largest = all.sort((a, b) => b.textContent.length - a.textContent.length)[0];
    if (!largest) return null;
    largest.id = 'qa-s3-details';
    return { count: all.length, children: largest.children.length, summary: largest.querySelector('summary').textContent };
  })()`);
  assert.ok(detailsMeta?.count >= 1, '比赛报告没有原生 details 入口');
  assert.ok(detailsMeta.children > 3, '未找到长证据列表');

  // Mouse: a real CDP click on the summary opens it, like a user click.
  const point = await evaluate(`(()=>{const s=document.querySelector('#qa-s3-details summary');s.scrollIntoView({block:'center'});const r=s.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await waitForUi(evaluate, 'document.querySelector("#qa-s3-details").open', 'details mouse open');
  const mouseOpen = await inspectDetails('#qa-s3-details');
  assert.equal(mouseOpen.open, true);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await waitForUi(evaluate, '!document.querySelector("#qa-s3-details").open', 'details mouse close');
  await settleUi(evaluate, 'details mouse close settled');

  // Keyboard: Enter opens, Space closes, focus stays on the summary.
  await evaluate('document.querySelector("#qa-s3-details summary").focus()');
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', windowsVirtualKeyCode: 13 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await waitForUi(evaluate, 'document.querySelector("#qa-s3-details").open', 'details keyboard Enter');
  assert.equal(await evaluate('document.activeElement === document.querySelector("#qa-s3-details summary")'), true);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', text: ' ', windowsVirtualKeyCode: 32 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
  await waitForUi(evaluate, '!document.querySelector("#qa-s3-details").open', 'details keyboard Space');
  await settleUi(evaluate, 'details keyboard close settled');

  // Animation: open then close, checking intermediate heights and final content bounds.
  const detailsOpen = await sampleDetails('#qa-s3-details');
  detailsSamples.push(detailsOpen);
  assertDetailsOpenAnimation(detailsOpen);
  await settleUi(evaluate, 'details open settled');
  const detailsClose = await sampleDetails('#qa-s3-details');
  detailsSamples.push(detailsClose);
  assertDetailsCloseAnimation(detailsClose);

  // Focus must not remain inside the closed content, and closed content must not be tabbable.
  // Close with a real pointer click: pointer focus moves to the summary, so this also proves
  // focus does not stay on an evidence button hidden by the collapse.
  await evaluate('document.querySelector("#qa-s3-details summary").click()');
  await waitForUi(evaluate, 'document.querySelector("#qa-s3-details").open', 'details reopen for focus');
  const focusedEvidence = await focusInside('#qa-s3-details', 'button');
  if (focusedEvidence) {
    const focusPoint = await evaluate(`(()=>{
      const summary=document.querySelector('#qa-s3-details summary');
      summary.scrollIntoView({block:'center'});
      const rect=summary.getBoundingClientRect();
      return {x:rect.x+rect.width/2,y:rect.y+rect.height/2};
    })()`);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: focusPoint.x, y: focusPoint.y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: focusPoint.x, y: focusPoint.y, button: 'left', clickCount: 1 });
    await settleUi(evaluate, 'details closed from pointer focus');
    await waitForUi(evaluate, `(()=>{
      const d=document.querySelector('#qa-s3-details');
      const active=document.activeElement;
      return !d.open && getComputedStyle(d,'::details-content').visibility==='hidden'
        && (active===d.querySelector('summary') || !d.contains(active));
    })()`, 'details content hidden and focus released after close');
    const residue = await evaluate(`(()=>{
      const d=document.querySelector('#qa-s3-details');
      const summary=d.querySelector('summary');
      const button=d.querySelector('button');
      const active=document.activeElement;
      const insideContent=d.contains(active) && active!==summary;
      button?.focus();
      return { open:d.open, insideContent, activeTag:active?.tagName,
        focusableAfterClose: document.activeElement === button,
        contentVisibility: getComputedStyle(d,'::details-content').contentVisibility };
    })()`);
    assert.equal(residue.open, false);
    assert.equal(residue.insideContent, false, '关闭后焦点仍留在证据内容中');
    assert.equal(residue.focusableAfterClose, false, '关闭的证据内容仍可接受键盘焦点');
    assert.equal(residue.contentVisibility, 'hidden');
  }

  // Programmatic close while focus is on an evidence button must release that focus
  // after the visibility transition, even though no pointer click moved it to summary.
  await evaluate('document.querySelector("#qa-s3-details summary").click()');
  await waitForUi(evaluate, 'document.querySelector("#qa-s3-details").open', 'details reopen for programmatic focus');
  const programmaticFocus = await focusInside('#qa-s3-details', 'button');
  if (programmaticFocus) {
    await evaluate('document.querySelector("#qa-s3-details summary").click()');
    await waitForUi(evaluate, `(()=>{
      const d=document.querySelector('#qa-s3-details');
      const buttons=[...d.querySelectorAll('button')];
      return !d.open && getComputedStyle(d,'::details-content').visibility==='hidden'
        && !buttons.includes(document.activeElement);
    })()`, 'details programmatic close released focus');
    const programmaticResidue = await evaluate(`(()=>{
      const d=document.querySelector('#qa-s3-details');
      const button=d.querySelector('button');
      const before=document.activeElement;
      button?.focus();
      return { open:d.open, focusedBefore:before===button, focusableAfterClose:document.activeElement===button,
        visibility:getComputedStyle(d,'::details-content').visibility };
    })()`);
    assert.equal(programmaticResidue.open, false);
    assert.equal(programmaticResidue.focusedBefore, false, '关闭后焦点仍停在已隐藏的证据按钮');
    assert.equal(programmaticResidue.focusableAfterClose, false, '关闭的证据按钮仍可接受焦点');
    assert.equal(programmaticResidue.visibility, 'hidden');
  }

  // Rapid toggles must settle on the correct native state.
  await evaluate('(()=>{const s=document.querySelector("#qa-s3-details summary");for(let i=0;i<7;i++)s.click();})()');
  await settleUi(evaluate, 'details rapid opens');
  assert.equal((await inspectDetails('#qa-s3-details')).open, true);
  await evaluate('(()=>{const s=document.querySelector("#qa-s3-details summary");for(let i=0;i<7;i++)s.click();})()');
  await settleUi(evaluate, 'details rapid closes');
  assert.equal((await inspectDetails('#qa-s3-details')).open, false);

  // ---------------------------------------------------------------- deep review
  await evaluate('document.getElementById("deep-review-tab").click()');
  await waitForUi(evaluate, 'document.getElementById("deep-review-panel").checkVisibility()', 'deep review panel');
  await settleUi(evaluate, 'deep review settled');
  const deepMeta = await evaluate(`(()=>{
    const all=[...document.querySelectorAll('#deep-review-panel details')];
    const largest=all.sort((a,b)=>b.textContent.length-a.textContent.length)[0];
    if(!largest)return null;
    largest.id='qa-s3-deep-details';
    return { count: all.length, summary: largest.querySelector('summary').textContent,
      caveats: largest.querySelectorAll('p').length, characters: largest.textContent.length };
  })()`);
  assert.ok(deepMeta?.count >= 1, '深度复盘没有原生 details 入口');
  assert.ok(deepMeta.summary.includes('说明与限制'), '深度复盘 details 标题不正确');
  assert.ok(deepMeta.characters > 40, '深度复盘说明内容过短，无法验证长文本');
  const deepOpen = await sampleDetails('#qa-s3-deep-details');
  detailsSamples.push(deepOpen);
  assertDetailsOpenAnimation(deepOpen);
  await settleUi(evaluate, 'deep review details open');
  const deepClose = await sampleDetails('#qa-s3-deep-details');
  assertDetailsCloseAnimation(deepClose);
  await evaluate('document.querySelector("#qa-s3-deep-details summary").focus()');
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', windowsVirtualKeyCode: 13 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await waitForUi(evaluate, 'document.querySelector("#qa-s3-deep-details").open', 'deep review details keyboard');
  await evaluate('document.querySelector("#qa-s3-deep-details summary").click()');
  await settleUi(evaluate, 'deep review details closed');

  // ---------------------------------------------------------------- timeline
  await evaluate('document.getElementById("timeline-tab").click()');
  await waitForUi(evaluate, 'document.getElementById("timeline-panel").checkVisibility()', 'timeline panel');
  await settleUi(evaluate, 'timeline settled');
  assert.equal(await evaluate('document.querySelectorAll("[data-round-summary]").length'), 24);
  assert.equal(await evaluate('document.querySelectorAll("[data-round-detail]").length'), 0, '回合默认收起');

  // Keyboard: the round summary is a real button; Enter opens and Space closes it.
  await evaluate(`document.querySelector('[data-round-summary="24"]').focus()`);
  const enterKey = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...enterKey });
  await send('Input.dispatchKeyEvent', { type: 'char', text: '\r', ...enterKey });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...enterKey });
  await waitForUi(evaluate, `document.querySelector('[data-round-summary="24"]').getAttribute('aria-expanded') === 'true'`, 'timeline keyboard open');
  assert.equal(await evaluate(`document.activeElement === document.querySelector('[data-round-summary="24"]')`), true);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', text: ' ', windowsVirtualKeyCode: 32 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
  await waitForUi(evaluate, `document.querySelector('[data-round-summary="24"]').getAttribute('aria-expanded') === 'false'`, 'timeline keyboard close');
  await waitForUi(evaluate, '!document.querySelector("[data-timeline-collapse]")', 'timeline keyboard close unmounted');

  const firstOpen = await sampleTimeline(24);
  timelineSamples.push(firstOpen);
  assert.equal(firstOpen.expanded, 'true');
  assert.ok(firstOpen.detail);
  assert.ok(firstOpen.wrapper && firstOpen.wrapper.expanded === 'true');
  assert.ok(firstOpen.wrapper.height > 20, '回合详情没有高度');
  assert.ok(firstOpen.samples.some(([, height]) => height !== null && height > 1 && height < firstOpen.wrapper.height - 1),
    '回合展开没有可见的中间高度');
  assert.ok(firstOpen.inner.scrollHeight <= firstOpen.inner.clientHeight + 1, '回合详情打开后有隐藏内容');
  assert.ok(firstOpen.inner.lastBottom <= firstOpen.inner.bottom + 1, '回合详情最后一行被裁断');
  assert.equal(await evaluate(`document.querySelectorAll("[data-round-detail=\\"24\\"] [data-killfeed-event=kill]").length`), 4);
  await settleUi(evaluate, 'timeline R24 open');

  // Close with focus inside: inert must apply immediately, then the node must be removed.
  const insideButton = await evaluate(`(()=>{const b=document.querySelector("[data-round-detail=\\"24\\"] button");b.focus();return document.activeElement===b;})()`);
  assert.equal(insideButton, true);
  await evaluate(`document.querySelector("[data-round-summary=\\"24\\"]").click()`);
  const closing = await evaluate('(()=>{const w=document.querySelector("[data-timeline-collapse]");return w?{inert:w.inert,expanded:w.dataset.expanded}:null;})()');
  assert.ok(closing, '关闭开始时详情已被立即移除');
  assert.equal(closing.inert, true, '关闭中的回合内容没有立即 inert');
  await waitForUi(evaluate, "(()=>{const w=document.querySelector('[data-timeline-collapse]');return !w||!w.contains(document.activeElement);})()", 'timeline focus released while closing');
  await waitForUi(evaluate, `!document.querySelector("[data-round-detail=\\"24\\"]") && !document.querySelector("[data-timeline-collapse]")`, 'timeline closed and unmounted');
  assert.equal(await evaluate(`document.querySelector("[data-round-summary=\\"24\\"]").getAttribute("aria-expanded")`), 'false');

  // Rapid clicks: odd number ends open, even number ends closed, with a single node.
  await evaluate(`(()=>{const b=document.querySelector("[data-round-summary=\\"24\\"]");for(let i=0;i<5;i++)b.click();})()`);
  await settleUi(evaluate, 'timeline rapid opens');
  assert.equal(await evaluate(`document.querySelector("[data-round-summary=\\"24\\"]").getAttribute("aria-expanded")`), 'true');
  assert.equal(await evaluate('document.querySelectorAll("[data-timeline-collapse]").length'), 1);
  assert.equal(await evaluate(`document.querySelectorAll("[data-round-detail=\\"24\\"]").length`), 1);
  await evaluate(`(()=>{const b=document.querySelector("[data-round-summary=\\"24\\"]");for(let i=0;i<5;i++)b.click();})()`);
  await settleUi(evaluate, 'timeline rapid closes');
  assert.equal(await evaluate(`document.querySelector("[data-round-summary=\\"24\\"]").getAttribute("aria-expanded")`), 'false');
  assert.equal(await evaluate('document.querySelectorAll("[data-timeline-collapse]").length'), 0);

  // Two synchronous clicks (open then close before the double-rAF expands) must not leave a node.
  await evaluate(`(()=>{const b=document.querySelector('[data-round-summary="24"]');b.click();b.click();})()`);
  await settleUi(evaluate, 'timeline immediate reversal');
  assert.equal(await evaluate(`document.querySelector('[data-round-summary="24"]').getAttribute('aria-expanded')`), 'false');
  assert.equal(await evaluate('document.querySelectorAll("[data-timeline-collapse]").length'), 0);
  assert.equal(await evaluate('document.querySelectorAll("[data-round-detail]").length'), 0);

  // Reverse mid-animation, then settle on the final expanded state.
  await evaluate(`document.querySelector("[data-round-summary=\\"24\\"]").click()`);
  await delay(80);
  await evaluate(`document.querySelector("[data-round-summary=\\"24\\"]").click()`);
  await delay(60);
  await evaluate(`document.querySelector("[data-round-summary=\\"24\\"]").click()`);
  await settleUi(evaluate, 'timeline reversal');
  const reversal = await evaluate(`(()=>{const w=document.querySelector("[data-timeline-collapse]");return {expanded:document.querySelector("[data-round-summary=\\"24\\"]").getAttribute("aria-expanded"),wrappers:document.querySelectorAll("[data-timeline-collapse]").length,wrapper:w?{expanded:w.dataset.expanded,height:w.getBoundingClientRect().height}:null};})()`);
  assert.equal(reversal.expanded, 'true');
  assert.equal(reversal.wrappers, 1);
  assert.equal(reversal.wrapper.expanded, 'true');
  assert.ok(reversal.wrapper.height > 20);
  // Reopening during a close must clear inert and restore interactivity.
  assert.equal(await evaluate('document.querySelector("[data-timeline-collapse]").inert'), false);
  assert.equal(await evaluate(`(()=>{const b=document.querySelector('[data-round-detail="24"] button');b.focus();return document.activeElement===b;})()`), true);
  await evaluate(`document.querySelector("[data-round-summary=\\"24\\"]").click()`);
  await settleUi(evaluate, 'timeline reversal close');
  assert.equal(await evaluate('document.querySelectorAll("[data-timeline-collapse]").length'), 0);

  // Several rounds can be open together and close independently.
  await evaluate(`(()=>{[7,24].forEach(r=>document.querySelector('[data-round-summary="'+r+'"]').click())})()`);
  await settleUi(evaluate, 'timeline two rounds open');
  assert.equal(await evaluate('document.querySelectorAll("[data-timeline-collapse]").length'), 2);
  assert.equal(await evaluate('document.querySelectorAll("[data-round-detail]").length'), 2);
  assert.equal(await evaluate(`document.querySelector('[data-round-summary="7"]').getAttribute('aria-expanded')`), 'true');
  assert.equal(await evaluate(`document.querySelector('[data-round-summary="24"]').getAttribute('aria-expanded')`), 'true');
  await evaluate(`document.querySelector('[data-round-summary="24"]').click()`);
  await settleUi(evaluate, 'timeline close one of two');
  assert.equal(await evaluate('document.querySelectorAll("[data-timeline-collapse]").length'), 1);
  assert.equal(await evaluate(`Boolean(document.querySelector('[data-round-detail="7"]'))`), true);
  assert.equal(await evaluate(`Boolean(document.querySelector('[data-round-detail="24"]'))`), false);
  await evaluate(`document.querySelector('[data-round-summary="7"]').click()`);
  await settleUi(evaluate, 'timeline close both');
  assert.equal(await evaluate('document.querySelectorAll("[data-timeline-collapse]").length'), 0);

  // Player switch: expansion identity persists (existing behaviour) but content re-derives.
  await evaluate(`document.querySelector("[data-round-summary=\\"24\\"]").click()`);
  await settleUi(evaluate, 'timeline player isolation open');
  const original = await evaluate(`(()=>{const r=window.__s3Report;const player=r.players.find(p=>p.nickname===document.querySelector("[aria-label=\\"目标玩家\\"]").textContent);const round=r.timeline.find(t=>t.playerId===player.id).rounds.find(x=>x.round===24);return {name:player.nickname,kills:round.events.filter(e=>e.type==="kill"||e.type==="death").length,detail:document.querySelector("[data-round-detail=\\"24\\"]").textContent};})()`);
  const alternate = await evaluate(`(()=>{const r=window.__s3Report;const current=document.querySelector("[aria-label=\\"目标玩家\\"]").textContent;const other=r.timeline.find(t=>{const p=r.players.find(x=>x.id===t.playerId);return p&&p.nickname!==current;});return other?r.players.find(p=>p.id===other.playerId).nickname:null;})()`);
  assert.ok(alternate, '没有可用于切换的玩家');
  await selectPlayer(alternate);
  const switched = await evaluate(`(()=>{const r=window.__s3Report;const player=r.players.find(p=>p.nickname===document.querySelector("[aria-label=\\"目标玩家\\"]").textContent);const round=r.timeline.find(t=>t.playerId===player.id).rounds.find(x=>x.round===24);const detail=document.querySelector("[data-round-detail=\\"24\\"]");return {name:player.nickname,kills:round.events.filter(e=>e.type==="kill"||e.type==="death").length,count:document.querySelectorAll("[data-round-detail=\\"24\\"] [data-killfeed-event]").length,text:detail?detail.textContent:null};})()`);
  assert.notEqual(switched.name, original.name);
  assert.equal(await evaluate(`document.querySelector("[data-round-summary=\\"24\\"]").getAttribute("aria-expanded")`), 'true');
  assert.equal(switched.count, switched.kills, '切换玩家后回合内容未按新玩家重建');
  if (switched.kills === 0) assert.ok(switched.text.includes('本回合没有可展示的关键事件'));
  await evaluate(`document.querySelector("[data-round-summary=\\"24\\"]").click()`);
  await settleUi(evaluate, 'timeline player isolation close');
  await selectPlayer(original.name);
  // Start a close and switch players before the 300ms fallback can run.
  await evaluate(`document.querySelector('[data-round-summary="24"]').click()`);
  await settleUi(evaluate, 'unmount-mid-close open');
  await evaluate(`document.querySelector('[data-round-summary="24"]').click()`);
  await selectPlayer(alternate);
  await settleUi(evaluate, 'unmount-mid-close switch');
  assert.equal(await evaluate('document.querySelectorAll("[data-timeline-collapse]").length'), 0);
  assert.equal(await evaluate('document.querySelectorAll("[data-round-detail]").length'), 0);
  await selectPlayer(original.name);
  // Switching players remounts the Findings / Deep Review DOM; re-tag the long entries.
  const retagged = await evaluate(`(()=>{
    const report=[...document.querySelectorAll('#report-panel details')].sort((a,b)=>b.textContent.length-a.textContent.length)[0];
    const deep=[...document.querySelectorAll('#deep-review-panel details')].sort((a,b)=>b.textContent.length-a.textContent.length)[0];
    if(report)report.id='qa-s3-details';
    if(deep)deep.id='qa-s3-deep-details';
    return Boolean(report&&deep);
  })()`);
  assert.equal(retagged, true, '切换玩家后找不到报告/深度复盘 details');

  // ---------------------------------------------------------------- sidebar
  await evaluate('document.getElementById("report-tab").click()');
  await settleUi(evaluate, 'back to report');
  const sidebarSample = () => evaluate(`(async()=>{
    const sidebar=document.querySelector('[data-app-sidebar]');
    const before=sidebar.getBoundingClientRect().width;
    document.querySelector('[data-sidebar-toggle]').click();
    const samples=[];
    const started=performance.now();
    while(performance.now()-started<500){
      await new Promise(resolve=>requestAnimationFrame(resolve));
      samples.push([Math.round(performance.now()-started),sidebar.getBoundingClientRect().width]);
    }
    return { before, after:sidebar.getBoundingClientRect().width, collapsed:sidebar.dataset.collapsed,
      samples, duration:getComputedStyle(sidebar).transitionDuration,
      label:document.querySelector('[data-sidebar-toggle]').getAttribute('aria-label') };
  })()`);
  const sidebarCollapse = await sidebarSample();
  assert.equal(sidebarCollapse.before, 212);
  assert.equal(sidebarCollapse.after, 56);
  assert.equal(sidebarCollapse.collapsed, 'true');
  assert.equal(sidebarCollapse.label, '展开导航');
  assert.ok(sidebarCollapse.samples.some(([, width]) => width > 56 && width < 212), '侧栏收起没有宽度过渡');
  assert.equal(sidebarCollapse.duration, '0.2s');
  const sidebarExpand = await sidebarSample();
  assert.equal(sidebarExpand.before, 56);
  assert.equal(sidebarExpand.after, 212);
  assert.equal(sidebarExpand.collapsed, 'false');
  assert.ok(sidebarExpand.samples.some(([, width]) => width > 56 && width < 212), '侧栏展开没有宽度过渡');

  // ---------------------------------------------------------------- real window sizes
  for (const [width, height] of [[1024, 640], [1920, 1032]]) {
    await resize(width, height);
    await settleUi(evaluate, `window ${width}×${height} settled`);
    await evaluate('document.getElementById("report-tab").click()');
    await settleUi(evaluate, 'report at ' + width);
    await evaluate('document.querySelector("#qa-s3-details summary").scrollIntoView({block:"center"})');
    if (!(await evaluate('document.querySelector("#qa-s3-details").open'))) await evaluate('document.querySelector("#qa-s3-details summary").click()');
    await settleUi(evaluate, 'report details at ' + width);
    await assertNoPageScroll(evaluate, `比赛报告 ${width}×${height} details`);
    await screenshot(`report-details-${width}x${height}`);

    await evaluate('document.getElementById("timeline-tab").click()');
    await settleUi(evaluate, 'timeline at ' + width);
    if (!(await evaluate(`document.querySelector("[data-round-summary=\\"24\\"]").getAttribute("aria-expanded") === "true"`))) {
      await evaluate(`document.querySelector("[data-round-summary=\\"24\\"]").click()`);
    }
    await settleUi(evaluate, 'timeline R24 at ' + width);
    await assertNoPageScroll(evaluate, `回合时间线 ${width}×${height}`);
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
    const bounds = await evaluate('(()=>{const w=document.querySelector("[data-timeline-collapse]");const i=w.querySelector(".timeline-collapse-inner");return {wrapper:w.getBoundingClientRect().height,inner:i.clientHeight,scroll:i.scrollHeight,last:i.lastElementChild.getBoundingClientRect().bottom,bottom:i.getBoundingClientRect().bottom};})()');
    assert.ok(Math.abs(bounds.wrapper - bounds.inner) <= 1, `${width}: 回合容器高度与内容不一致`);
    assert.ok(bounds.scroll <= bounds.inner + 1, `${width}: 回合内容被裁断`);
    assert.ok(bounds.last <= bounds.bottom + 1, `${width}: 回合最后一行被裁断`);
    await screenshot(`timeline-r24-${width}x${height}`);

    await evaluate('document.getElementById("deep-review-tab").click()');
    await settleUi(evaluate, 'deep review at ' + width);
    if (!(await evaluate('document.querySelector("#qa-s3-deep-details").open'))) await evaluate('document.querySelector("#qa-s3-deep-details summary").click()');
    await settleUi(evaluate, 'deep details at ' + width);
    await assertNoPageScroll(evaluate, `深度复盘 ${width}×${height}`);
    await screenshot(`deep-review-caveats-${width}x${height}`);
  }
  await send('Emulation.clearDeviceMetricsOverride');
  await resize(1280, 800);
  await evaluate('document.getElementById("report-tab").click()');
  await settleUi(evaluate, 'restored window');
  for (const summary of await evaluate('[...document.querySelectorAll("[data-round-summary][aria-expanded=true]")].map(b=>b.dataset.roundSummary)')) {
    await evaluate(`document.querySelector('[data-round-summary="${summary}"]').click()`);
  }
  for (const selector of ['#qa-s3-details', '#qa-s3-deep-details']) {
    if (await evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)})?.open)`)) {
      await evaluate(`document.querySelector(${JSON.stringify(selector)} + ' summary').click()`);
    }
  }
  await settleUi(evaluate, 'collapsed before reduced motion');

  // ---------------------------------------------------------------- reduced motion
  await media(true, false);
  await evaluate('document.getElementById("report-tab").click()');
  await settleUi(evaluate, 'reduced motion report');
  const reducedDetails = await evaluate(`(async()=>{
    const d=document.querySelector('#qa-s3-details');
    d.querySelector('summary').click();
    await new Promise(resolve=>requestAnimationFrame(resolve));
    await new Promise(resolve=>requestAnimationFrame(resolve));
    const style=getComputedStyle(d,'::details-content');
    return { open:d.open, height:d.getBoundingClientRect().height, transition:style.transitionProperty,
      duration:style.transitionDuration, running:document.getAnimations().filter(a=>a.playState==='running').length };
  })()`);
  assert.equal(reducedDetails.open, true);
  assert.equal(reducedDetails.duration, '0s');
  assert.ok(reducedDetails.height > 40, 'reduced motion 下 details 应立即完整展开');
  assert.equal(reducedDetails.running, 0);
  await evaluate('document.querySelector("#qa-s3-details summary").click()');
  await settleUi(evaluate, 'reduced motion details close');
  assert.equal(await evaluate('document.querySelector("#qa-s3-details").open'), false);
  const reducedFocus = await evaluate(`(()=>{
    const d=document.querySelector('#qa-s3-details');
    const button=d.querySelector('button');
    button?.focus();
    return { focusable:document.activeElement===button, visibility:getComputedStyle(d,'::details-content').visibility };
  })()`);
  assert.equal(reducedFocus.focusable, false, 'reduced motion 下关闭的证据内容仍可接受焦点');
  assert.equal(reducedFocus.visibility, 'hidden');

  await evaluate('document.getElementById("timeline-tab").click()');
  await settleUi(evaluate, 'reduced motion timeline');
  await evaluate(`document.querySelector("[data-round-summary=\\"24\\"]").click()`);
  await waitForUi(evaluate, 'document.querySelector("[data-timeline-collapse]")?.dataset.expanded === "true"', 'reduced motion timeline expanded');
  const reducedTimelineOpen = await evaluate(`(()=>{const w=document.querySelector("[data-timeline-collapse]");return {expanded:document.querySelector("[data-round-summary=\\"24\\"]").getAttribute("aria-expanded"),height:w?w.getBoundingClientRect().height:null};})()`);
  assert.equal(reducedTimelineOpen.expanded, 'true');
  assert.ok(reducedTimelineOpen.height > 20, 'reduced motion 下回合详情应立即展开');
  await evaluate(`document.querySelector("[data-round-summary=\\"24\\"]").click()`);
  await delay(40);
  assert.equal(await evaluate('document.querySelectorAll("[data-timeline-collapse]").length'), 0, 'reduced motion 下关闭应立即卸载');
  assert.equal(await evaluate(`document.querySelector("[data-round-summary=\\"24\\"]").getAttribute("aria-expanded")`), 'false');
  const reducedSidebar = await evaluate('(()=>{const s=document.querySelector("[data-app-sidebar]");const d=parseFloat(getComputedStyle(s).transitionDuration);return {duration:d,forced:matchMedia("(prefers-reduced-motion: reduce)").matches};})()');
  assert.equal(reducedSidebar.forced, true);
  assert.ok(reducedSidebar.duration <= 0.001, 'reduced motion 下侧栏宽度过渡没有关闭');

  // ---------------------------------------------------------------- forced colours
  await media(false, true);
  await evaluate('document.getElementById("report-tab").click()');
  await settleUi(evaluate, 'forced colours report');
  const forced = await evaluate(`(async()=>{
    const d=document.querySelector('#qa-s3-details');
    if(!d.open) d.querySelector('summary').click();
    await new Promise(resolve=>requestAnimationFrame(resolve));
    await new Promise(resolve=>requestAnimationFrame(resolve));
    const content=getComputedStyle(d,'::details-content');
    const summary=getComputedStyle(d.querySelector('summary'));
    return { forced: matchMedia('(forced-colors: active)').matches, active:d.open,
      contentVisibility:content.contentVisibility, opacity:content.opacity,
      listStyleType:summary.listStyleType, summaryText:d.querySelector('summary').textContent };
  })()`);
  assert.equal(forced.forced, true);
  assert.equal(forced.active, true);
  assert.equal(forced.contentVisibility, 'visible');
  assert.equal(forced.opacity, '1', '高对比度下不得依赖透明度表达状态');
  assert.notEqual(forced.listStyleType, 'none', '高对比度下 summary 标记必须保留');
  await screenshot('forced-colors-details');
  await evaluate('document.getElementById("timeline-tab").click()');
  await settleUi(evaluate, 'forced colours timeline');
  await evaluate(`document.querySelector("[data-round-summary=\\"24\\"]").click()`);
  await settleUi(evaluate, 'forced colours timeline open');
  const forcedTimeline = await evaluate(`(()=>{const w=document.querySelector("[data-timeline-collapse]");return {opacity:getComputedStyle(w).opacity,expanded:w.dataset.expanded,toggle:document.querySelector("[data-round-summary=\\"24\\"] .fui-Badge__icon, [data-round-summary=\\"24\\"]").textContent};})()`);
  assert.equal(forcedTimeline.opacity, '1');
  assert.equal(forcedTimeline.expanded, 'true');
  assert.ok(forcedTimeline.toggle.includes('收起'));
  await screenshot('forced-colors-timeline');
  await evaluate(`document.querySelector("[data-round-summary=\\"24\\"]").click()`);
  await settleUi(evaluate, 'forced colours timeline close');
  await media(false, false);

  // ---------------------------------------------------------------- match switch
  await evaluate(`document.querySelector("[data-round-summary=\\"24\\"]").click()`);
  await settleUi(evaluate, 'match switch precondition');
  assert.ok(await evaluate(`Boolean(document.querySelector("[data-round-detail=\\"24\\"]"))`));
  await evaluate('document.querySelector("[data-sidebar-import]").click()');
  await waitFor(async () => {
    const state = await evaluate('({status:document.querySelector("main").dataset.status,summaries:document.querySelectorAll("[data-round-summary]").length,open:document.querySelectorAll("[data-round-detail]").length,collapse:document.querySelectorAll("[data-timeline-collapse]").length})');
    return state.status === 'success' && state.summaries === 24 && state.open === 0 && state.collapse === 0 ? state : null;
  }, 180_000, '重新导入后回合状态重置', { intervalMs: 200 });
  assert.equal(await evaluate('document.querySelectorAll("[data-round-summary][aria-expanded=true]").length'), 0);
  assert.equal(await evaluate('document.querySelectorAll("[data-round-detail]").length'), 0);
  assert.ok((await evaluate('document.body.textContent')).includes('25 / 20 / 4'));

  assert.deepEqual(exceptions, [], '渲染进程存在未捕获异常');
  console.log('P7-S3 collapse motion: PASS');
  console.log(JSON.stringify({ screenshots, detailsSamples: detailsSamples.map(x => ({ before: x.before, after: x.after, frames: x.samples.length })), timelineSamples: timelineSamples.map(x => ({ expanded: x.expanded, height: x.wrapper?.height ?? null, frames: x.samples.length })) }, null, 2));
} catch (error) {
  runFailure = new Error('P7-S3 collapse motion FAILED\n' + logs.slice(-6000), { cause: error });
} finally {
  try { mainInspector?.socket.close(); } catch {}
  try {
    if (page) await closeApp({ child, evaluate: page.evaluate, socket: page.socket });
  } catch (error) {
    if (!runFailure) runFailure = error;
    else runFailure.cleanup = error;
  }
  try { await scope.cleanup(); } catch (error) {
    if (!runFailure) runFailure = error;
    else runFailure.cleanup = error;
  }
}
if (runFailure) throw runFailure;
