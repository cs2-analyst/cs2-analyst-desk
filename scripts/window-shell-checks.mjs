import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { waitFor } from './smoke-runtime.mjs';

/** Shared real-Electron assertions, including production installed apps. */
export async function checkWindowLayout(evaluate) {
  const shell = await evaluate(`(() => {
    const bar = document.querySelector('[data-app-titlebar]');
    const buttons = [...bar.querySelectorAll('[data-window-control]')];
    const rect = bar.getBoundingClientRect();
    const logo = bar.querySelector('[data-app-logo]');
    return { title: document.title, logo: !!logo, text: bar.textContent,
      mark: { tag: logo.tagName, loaded: logo.complete && logo.naturalWidth > 0,
        width: logo.getBoundingClientRect().width, height: logo.getBoundingClientRect().height,
        fit: getComputedStyle(logo).objectFit, draggable: logo.draggable },
      height: rect.height, top: rect.top, left: rect.left, right: rect.right, width: innerWidth,
      drag: getComputedStyle(bar).getPropertyValue('-webkit-app-region'),
      logoDrag: getComputedStyle(bar.querySelector('[data-app-logo]').parentElement).getPropertyValue('-webkit-app-region'),
      buttons: buttons.map(b => ({ name: b.dataset.windowControl, label: b.getAttribute('aria-label'),
        width: b.getBoundingClientRect().width, height: b.getBoundingClientRect().height,
        drag: getComputedStyle(b).getPropertyValue('-webkit-app-region'), svg: !!b.querySelector('svg') })),
      contentTop: document.querySelector('main').getBoundingClientRect().top,
      overflow: document.documentElement.scrollWidth > innerWidth,
      contentOverflow: document.querySelector('[data-app-content]').scrollWidth > document.querySelector('[data-app-content]').clientWidth,
      contentDrag: getComputedStyle(document.querySelector('main')).getPropertyValue('-webkit-app-region') };
  })()`);
  assert.equal(shell.title, 'CS2 Analyst'); assert.equal(shell.logo, true); assert.equal(shell.text, 'CS2 Analyst');
  assert.deepEqual(shell.mark, { tag: 'IMG', loaded: true, width: 20, height: 20, fit: 'contain', draggable: false });
  assert.equal(shell.height, 40); assert.equal(shell.top, 0); assert.equal(shell.left, 0); assert.equal(shell.right, shell.width);
  assert.equal(shell.drag, 'drag'); assert.equal(shell.logoDrag, 'no-drag');
  assert.equal(shell.contentTop, 40); assert.equal(shell.overflow, false);
  assert.equal(shell.contentOverflow, false); assert.notEqual(shell.contentDrag, 'drag');
  assert.deepEqual(shell.buttons.map(b => b.name), ['minimize', 'maximize', 'close']);
  for (const b of shell.buttons) { assert.equal(b.width, 46); assert.equal(b.height, 40); assert.equal(b.drag, 'no-drag'); assert.equal(b.svg, true); }
}

/**
 * Page-level scroll must never be the way content becomes reachable: the document, the body
 * and the main column stay locked to the viewport, and every long view scrolls inside its own panel.
 */
export async function waitForUi(evaluate, expression, label) {
  return waitFor(() => evaluate(expression), 5000, label, { intervalMs: 50, diagnostics: () => evaluate(`({
    condition: ${JSON.stringify(expression)}, ready: document.readyState, status: document.querySelector('main')?.dataset.status,
    selected: document.querySelector('[role=tab][aria-selected=true]')?.id,
    replay: document.querySelector('[data-replay-session]')?.dataset,
    canvases: [...document.querySelectorAll('#replay-panel canvas')].map(c=>({width:c.width,height:c.height,data:{...c.dataset}})),
    viewport: [innerWidth, innerHeight, devicePixelRatio], text: document.body.innerText.slice(-2000)
  })`) });
}

/** Geometry/scroll/font stability for screenshots and transitions, bounded to 5s.
 * Poll in Node because occluded Electron windows may suspend requestAnimationFrame.
 * Interaction-specific assertions still follow; three samples cannot replace those assertions.
 */
export async function settleUi(evaluate, label = 'rendered layout and scroll stability') {
  let previous, stable = 0, last;
  return waitFor(async () => {
    last = await evaluate(`({ ready: document.readyState === 'complete' && document.fonts.status === 'loaded' && document.getAnimations().every(a => a.playState !== 'running'),
      viewport: [innerWidth, innerHeight], selected: document.querySelector('[role=tab][aria-selected=true]')?.id,
      text: document.querySelector('main')?.textContent, options: [...document.querySelectorAll('[role=option]')].map(o => o.textContent),
      geometry: [...document.querySelectorAll('[role=tabpanel], [data-app-content], [data-app-sidebar], [data-replay-body]')].filter(e => e.checkVisibility()).map(e => { const r=e.getBoundingClientRect(); return [r.x,r.y,r.width,r.height,e.scrollTop,e.scrollLeft,e.scrollHeight]; }) })`);
    const signature = JSON.stringify(last);
    stable = last.ready && signature === previous ? stable + 1 : 0;
    previous = signature;
    return stable >= 2;
  }, 5000, label, { intervalMs: 50, diagnostics: () => last });
}

// Exercise the actual scroll range, and restore it so acceptance does not change navigation state.
export async function assertLocalScroll(evaluate, selector, label, { descendantsOnly = false } = {}) {
  const results = await evaluate(`(() => {
    const roots = [...document.querySelectorAll(${JSON.stringify(selector)})].filter(e => e.checkVisibility() && e.clientHeight > 0);
    return roots.map(e => {
      const overflow = e.scrollHeight - e.clientHeight, style = getComputedStyle(e).overflowY;
      if (overflow <= 1) return { overflow, ok: true };
      if (${descendantsOnly} && !['auto', 'scroll'].includes(style)) return { overflow, ok: true };
      if (!['auto', 'scroll'].includes(style)) return { overflow, style, ok: false,
        tag: e.tagName, id: e.id, className: String(e.className).slice(0, 160), text: e.textContent?.slice(0, 120) };
      const original = e.scrollTop;
      e.scrollTo({ top: e.scrollHeight, behavior: 'instant' });
      const reached = Math.abs(e.scrollTop - overflow) <= 1;
      const last = e.lastElementChild?.getBoundingClientRect();
      const bottom = e.getBoundingClientRect().top + e.clientTop + e.clientHeight;
      const lastReachable = !last || last.bottom <= bottom + 1;
      e.scrollTo({ top: original, behavior: 'instant' });
      return { overflow, style, reached, lastReachable, ok: reached && lastReachable };
    });
  })()`);
  assert.ok(results.length > 0, `${label}: no visible scroll surface matched ${selector}`);
  for (const result of results) assert.equal(result.ok, true, `${label}: inaccessible content ${JSON.stringify(result)}`);
}

export async function assertNoPageScroll(evaluate, label) {
  const scroll = await evaluate(`(() => {
    const content = document.querySelector('[data-app-content]');
    const panels = [...document.querySelectorAll('[role="tabpanel"]')].filter(p => !p.hidden && p.checkVisibility() && p.clientHeight > 0);
    const selected = [...document.querySelectorAll('[role="tab"][aria-selected="true"]')]
      .filter(tab => tab.checkVisibility()).map(tab => tab.getAttribute('aria-controls')).filter(Boolean);
    return { document: document.documentElement.scrollHeight - innerHeight,
      body: document.body.scrollHeight - innerHeight,
      horizontal: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth,
      content: content.scrollHeight - content.clientHeight,
      panels: panels.map(p => p.id), selected };
  })()`);
  for (const key of ['document', 'body', 'content', 'horizontal']) assert.ok(scroll[key] <= 1, `${label}: ${key} overflow ${scroll[key]}px`);
  assert.deepEqual([...scroll.panels].sort(), [...scroll.selected].sort(), `${label}: every visible tab panel must belong to a visible selected Tab`);
  for (const panel of scroll.selected) {
    if (panel === 'replay-panel') continue;
    await assertLocalScroll(evaluate, '#' + panel, label);
    // Nested Timeline/Analysis/Deep Review scroll surfaces also need usable local scrolling.
    await assertLocalScroll(evaluate, '#' + panel + ' *', label, { descendantsOnly: true });
  }
  if (!scroll.selected.length) {
    await assertLocalScroll(evaluate, '[data-import-card] > button, [data-import-card]', label);
  }
}

export async function checkSidebarImport(evaluate, send, expectedLabel) {
  const button = await evaluate(`(() => { const b = document.querySelector('[data-sidebar-import]'); b.focus();
    return { label: b.getAttribute('aria-label'), disabled: b.disabled, focus: document.activeElement === b, tabIndex: b.tabIndex }; })()`);
  assert.equal(button.label, expectedLabel);
  assert.equal(button.disabled, false);
  assert.equal(button.focus, true);
  assert.equal(button.tabIndex, 0);
  if (send) {
    const tree = await send('Accessibility.getFullAXTree');
    assert.ok(tree.nodes.some(n => !n.ignored && n.role?.value === 'button' && n.name?.value === expectedLabel), 'import has a real accessibility-tree name');
  }
}

/** App shell acceptance: home import card, drag-drop wiring, collapsible sidebar and icon alignment. Runs pre-import. */
export async function checkAppShell(evaluate, send) {
  const shell = await evaluate(`(() => {
    const sidebar = document.querySelector('[data-app-sidebar]');
    const toggle = document.querySelector('[data-sidebar-toggle]');
    const card = document.querySelector('[data-import-card]');
    const pick = [...document.querySelectorAll('button')].find(b => b.textContent.includes('选择 DEM'));
    const tabs = [...document.querySelectorAll('[data-app-sidebar] [role="tab"]')];
    return {
      sidebar: Boolean(sidebar), toggle: Boolean(toggle), card: Boolean(card), pick: Boolean(pick),
      tabCount: tabs.length, tabsDisabled: tabs.every(t => t.disabled),
      width: sidebar.getBoundingClientRect().width,
      collapsedAttr: sidebar.getAttribute('data-collapsed'),
    };
  })()`);
  await assertNoPageScroll(evaluate, '首页');
  assert.equal(shell.sidebar, true, '缺少桌面侧边栏');
  assert.equal(shell.toggle, true, '缺少侧边栏折叠按钮');
  assert.equal(shell.card, true, '首页缺少导入卡片');
  assert.equal(shell.pick, true, '首页缺少“选择 DEM”入口');
  assert.equal(shell.tabCount, 6, '侧边栏应列出 6 个报告视图');
  assert.equal(shell.tabsDisabled, true, '未导入时导航项应不可用');
  assert.equal(shell.collapsedAttr, 'false');
  assert.ok(shell.width > 150, '展开态侧边栏应显示图标与文本');

  // Drag-and-drop wiring: dragover highlights the card, drop runs the file-entry pipeline.
  await evaluate(`(() => {
    const transfer = new DataTransfer(); transfer.items.add(new File(['synthetic'], 'demo.dem'));
    window.__testDrop = transfer;
    document.querySelector('[data-import-card]').dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  })()`);
  await waitForUi(evaluate, `document.querySelector('[data-import-card]')?.dataset.dragOver === 'true'`, 'drop highlight');
  await evaluate(`document.querySelector('[data-import-card]').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: window.__testDrop })); delete window.__testDrop`);
  await waitForUi(evaluate, `document.querySelector('main').dataset.status === 'error' && document.body.textContent.includes('无法读取拖入文件的位置')`, 'synthetic File rejection');
  assert.equal(await evaluate(`document.querySelector('[data-import-card]').dataset.dragOver`), 'false');
  assert.equal(await evaluate(`typeof window.cs2Analyst.importDemoFile + ',' + typeof window.cs2Analyst.getFilePath`), 'undefined,undefined');
  await assertNoPageScroll(evaluate, '首页拖放错误');

  await evaluate(`document.querySelector('[data-sidebar-toggle]').click()`);
  await waitForUi(evaluate, `document.getAnimations().every(a => a.playState !== 'running')`, 'sidebar transition');
  const collapsed = await evaluate(`(() => {
    const sidebar = document.querySelector('[data-app-sidebar]');
    const iconCenter = el => { const icon = el.querySelector('svg').getBoundingClientRect(); return icon.x + icon.width / 2; };
    const labels = [...document.querySelectorAll('[data-app-sidebar] .fui-Tab__content')];
    return {
      width: sidebar.getBoundingClientRect().width,
      attr: sidebar.getAttribute('data-collapsed'),
      hiddenLabels: labels.every(n => getComputedStyle(n).display === 'none'),
      navIconX: iconCenter(document.getElementById('report-tab')),
      toggleIconX: iconCenter(document.querySelector('[data-sidebar-toggle]')),
      toggleLabel: document.querySelector('[data-sidebar-toggle]').getAttribute('aria-label'),
    };
  })()`);
  assert.equal(collapsed.attr, 'true');
  assert.ok(collapsed.width < shell.width / 2, '折叠后侧边栏应只保留图标列');
  assert.equal(collapsed.hiddenLabels, true, '折叠态不应显示导航文本');
  assert.ok(Math.abs(collapsed.navIconX - collapsed.toggleIconX) <= 1, '折叠后折叠按钮与导航图标应在同一垂直线');
  assert.equal(collapsed.toggleLabel, '展开导航');
  await checkSidebarImport(evaluate, send, '重新选择 DEM');
  await waitForUi(evaluate, `document.querySelector('[role="tooltip"]')?.textContent.includes('重新选择 DEM')`, 'collapsed import tooltip');

  await evaluate(`document.querySelector('[data-sidebar-toggle]').click()`);
  await waitForUi(evaluate, `document.getAnimations().every(a => a.playState !== 'running')`, 'sidebar transition');
  const restored = await evaluate(`(() => {
    const sidebar = document.querySelector('[data-app-sidebar]');
    const labels = [...document.querySelectorAll('[data-app-sidebar] .fui-Tab__content')];
    return { width: sidebar.getBoundingClientRect().width, attr: sidebar.getAttribute('data-collapsed'),
      visibleLabels: labels.every(n => getComputedStyle(n).display !== 'none') };
  })()`);
  assert.equal(restored.attr, 'false');
  assert.equal(restored.width, shell.width, '展开后宽度应恢复');
  assert.equal(restored.visibleLabels, true, '展开态应恢复图标与文本');
  await checkSidebarImport(evaluate, send, '重新选择 DEM');
  console.log('App shell: 首页导入卡片、点击/拖放入口、侧边栏展开/折叠与图标对齐 PASS');
}

export async function checkWindowShell(evaluate, send) {
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await checkWindowLayout(evaluate);
  await checkAppShell(evaluate, send);
  assert.equal(await evaluate(`document.querySelector('[data-window-control="maximize"]').getAttribute('aria-label')`), '最大化');
  const waitLabel = async expected => {
    await waitForUi(evaluate, `document.querySelector('[data-window-control="maximize"]').getAttribute('aria-label') === ${JSON.stringify(expected)}`, 'native window state label ' + expected);
  };
  await evaluate(`document.querySelector('[data-window-control="maximize"]').click()`);
  await waitLabel('还原');
  assert.equal(await evaluate('window.cs2Analyst.window.isMaximized()'), true);
  await checkWindowLayout(evaluate);
  // Windows reports maximize before the native transition animation finishes.
  // Let that transition settle before testing the opposite native operation.
  await delay(1000);
  await evaluate(`document.querySelector('[data-window-control="maximize"]').click()`);
  await waitLabel('最大化');
  assert.equal(await evaluate('window.cs2Analyst.window.isMaximized()'), false);
  console.log('Custom window shell: real Main maximize/restore, drag/no-drag and layout PASS');
}
