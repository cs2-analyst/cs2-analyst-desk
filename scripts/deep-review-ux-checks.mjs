import { assertNoPageScroll, settleUi, waitForUi } from './window-shell-checks.mjs';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Internal domain vocabulary that must never reach Deep Review user copy. */
const INTERNAL_TERMS = ['Engagement', 'direct contact', 'evidence', 'partial', 'coverage', 'linkage',
  'received', 'return contact', 'same-tick', 'eventIndex', 'fireEvidence', 'denominator'];

/** Runtime-only fixtures through React's existing report props; no shipped test seam. */
export async function checkDeepReviewUx(evaluate, send, qaDir) {
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  const settle = () => settleUi(evaluate);
  const screenshot = async name => {
    if (!qaDir) return;
    await settleUi(evaluate, 'screenshot layout, fonts and scroll');
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(join(qaDir, name + '.png'), Buffer.from(shot.data, 'base64'));
  };
  const tooltipVisible = text => `[...document.querySelectorAll('[role="tooltip"]')].some(t => t.checkVisibility() && t.getBoundingClientRect().width > 0 && t.textContent.includes(${JSON.stringify(text)}))`;
  // 比赛报告 is the default entry; Deep Review must be explicitly reachable from it.
  await evaluate(`document.getElementById('deep-review-tab').click()`);
  await settle();
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('[data-app-sidebar] [role="tab"]')].map(t => t.querySelector('.fui-Tab__content').textContent)`), ['比赛报告', '深度复盘', '回合时间线', '分析', '比赛回放', '热力图']);
  assert.equal(await evaluate(`[...document.querySelectorAll('[role="tabpanel"]')].filter(p => !p.parentElement.closest('[role="tabpanel"]')).length`), 6);
  await assertNoPageScroll(evaluate, '深度复盘初始导航');
  // Find the actual report consumed by this Renderer. Fixtures mutate only this QA process.
  assert.equal(await evaluate(`(() => {
    const node = document.getElementById('deep-review-panel');
    let fiber = node[Object.keys(node).find(k => k.startsWith('__reactFiber$'))];
    while (fiber && !fiber.memoizedProps?.report?.deepReview) fiber = fiber.return;
    if (!fiber) return false;
    window.__qaReport = fiber.memoizedProps.report;
    window.__qaDeepOriginal = window.__qaReport.deepReview;
    return true;
  })()`), true);
  const refresh = async () => {
    await evaluate(`document.getElementById('report-tab').click()`); await settle();
    await evaluate(`document.getElementById('deep-review-tab').click()`); await settle();
  };
  const checkTabs = async active => {
    const tabs = await evaluate(`[...document.querySelectorAll('#deep-review-panel [data-deep-tab]')].map(t => ({
      key: t.dataset.deepTab,
      label: t.querySelector('.fui-Tab__content')?.textContent ?? t.textContent,
      selected: t.getAttribute('aria-selected'),
      panelHidden: document.querySelector('[data-deep-panel="' + t.dataset.deepTab + '"]').hidden,
    }))`);
    assert.deepEqual(tabs.map(t => t.label), ['优先复盘', '亮点', '补充观察']);
    assert.deepEqual(tabs.map(t => t.key), ['reviews', 'highlights', 'contexts']);
    for (const t of tabs) {
      assert.equal(t.selected, String(t.key === active), 'selected tab: ' + t.key);
      assert.equal(t.panelHidden, t.key !== active, 'panel visibility: ' + t.key);
    }
  };
  const showTab = async key => {
    await evaluate(`document.querySelector('[data-deep-tab="${key}"]').click()`); await settle();
    await checkTabs(key);
  };
  const mouseClick = async selector => {
    const point = await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
    await settle();
  };
  const pressKey = async (key, code, windowsVirtualKeyCode, text) => {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode, ...(text ? { text } : {}) });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode });
    await settle();
  };
  const select = async name => {
    await evaluate(`document.querySelector('[aria-label="目标玩家"]').click()`);
    await waitForUi(evaluate, `document.querySelectorAll('[role=option]').length > 0`, 'player options');
    assert.equal(await evaluate(`(() => { const o = [...document.querySelectorAll('[role="option"]')].find(o => o.textContent === ${JSON.stringify(name)}); o?.click(); return Boolean(o); })()`), true);
    await settle();
  };
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1400, deviceScaleFactor: 1, mobile: false });
  // Prefer a real player with all three kinds for the default screenshot.
  const real = await evaluate(`(() => { const p = window.__qaReport.deepReview.players.find(p => p.reviews.length && p.highlights.length && p.contexts.length); return p ? window.__qaReport.players.find(x => x.id === p.playerId).nickname : null; })()`);
  if (real) await select(real);
  await showTab('reviews');
  assert.equal(await evaluate(`document.querySelectorAll('#deep-review-panel [data-deep-tab]').length`), 3, 'Deep Review must always show three tabs');
  // Keyboard: arrows move focus, Enter activates the focused Tab.
  await evaluate(`document.querySelector('[data-deep-tab="reviews"]').focus()`);
  await pressKey('ArrowRight', 'ArrowRight', 39);
  assert.equal(await evaluate(`document.activeElement?.dataset.deepTab`), 'highlights', 'ArrowRight moves tab focus');
  await pressKey('Enter', 'Enter', 13, '\r');
  await checkTabs('highlights');
  await pressKey('ArrowRight', 'ArrowRight', 39);
  assert.equal(await evaluate(`document.activeElement?.dataset.deepTab`), 'contexts', 'ArrowRight moves tab focus again');
  await pressKey('Enter', 'Enter', 13, '\r');
  await checkTabs('contexts');
  await pressKey('ArrowLeft', 'ArrowLeft', 37);
  assert.equal(await evaluate(`document.activeElement?.dataset.deepTab`), 'highlights', 'ArrowLeft moves tab focus');
  await pressKey('Enter', 'Enter', 13, '\r');
  await checkTabs('highlights');
  // Real pointer activation, not programmatic .click().
  await mouseClick('[data-deep-tab="reviews"]');
  await checkTabs('reviews');
  await mouseClick('[data-deep-tab="contexts"]');
  await checkTabs('contexts');
  await mouseClick('[data-deep-tab="reviews"]');
  await checkTabs('reviews');
  // Help is reachable by pointer hover and by keyboard focus.
  await evaluate('document.activeElement?.blur()');
  const helpPoint = await evaluate(`(() => { const r = document.querySelector('[data-deep-help]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...helpPoint });
  await waitForUi(evaluate, tooltipVisible('根据 DEM 中能够明确记录的交火'), 'Deep Review help tooltip hover');
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 });
  await waitForUi(evaluate, `!(${tooltipVisible('根据 DEM 中能够明确记录的交火')})`, 'Deep Review help tooltip hover closed');
  // Keyboard navigation, not programmatic focus: Fluent ignores programmatic focus
  // for description tooltips unless the user is navigating with the keyboard.
  await evaluate(`document.querySelector('[aria-label="目标玩家"]').focus()`);
  await pressKey('Tab', 'Tab', 9);
  assert.equal(await evaluate(`document.activeElement?.hasAttribute('data-deep-help')`), true, 'Tab reaches the Deep Review help button');
  await waitForUi(evaluate, tooltipVisible('根据 DEM 中能够明确记录的交火'), 'Deep Review help tooltip focus');
  await screenshot('deep-review-real-default');
  if (real) assert.deepEqual(await evaluate(`[...document.querySelectorAll('#deep-review-panel [data-deep-kind]')].map(c => c.dataset.deepKind).filter((kind, index, all) => all.indexOf(kind) === index)`), ['review', 'highlight', 'context']);
  const realText = await evaluate(`document.getElementById('deep-review-panel').textContent`);
  for (const token of INTERNAL_TERMS) assert.ok(!realText.includes(token), '真实复盘文案泄漏内部术语：' + token);
  for (const stale of ['部分证据', '证据边界', '上下文', '可判定场景']) assert.ok(!realText.includes(stale), '旧文案仍出现：' + stale);
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 620, deviceScaleFactor: 1, mobile: false });
  for (const [tab, kind, name] of [['highlights', 'highlight', 'deep-review-real-highlight'], ['contexts', 'context', 'deep-review-real-context']]) {
    const found = await evaluate(`Boolean(document.querySelector('#deep-review-panel [data-deep-kind="${kind}"]'))`);
    if (!found) continue;
    await showTab(tab);
    await evaluate(`document.querySelector('[data-deep-panel="${tab}"]').scrollTo(0, 0)`);
    await screenshot(name);
  }
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1400, deviceScaleFactor: 1, mobile: false });
  // Switching first-level views must preserve the selected Deep Review tab and panel content.
  await showTab('contexts');
  await evaluate(`document.getElementById('report-tab').click()`); await settle();
  await evaluate(`document.getElementById('deep-review-tab').click()`); await settle();
  await checkTabs('contexts');
  await showTab('reviews');
  const partial = await evaluate(`Boolean(document.querySelector('[data-deep-panel="reviews"] [data-deep-kind] details'))`);
  if (partial) {
    await evaluate(`const d = document.querySelector('[data-deep-panel="reviews"] [data-deep-kind] details'); d.open = true; d.scrollIntoView({ block: 'center' })`);
    await screenshot('deep-review-real-caveat');
  }
  await evaluate(`document.querySelector('#deep-review-panel [data-deep-rounds]')?.click()`);
  await settle();
  await screenshot('deep-review-real-timeline');
  await evaluate(`document.getElementById('deep-review-tab').click()`);
  await settle();
  await select('twinkle');
  const id = await evaluate(`document.querySelector('[data-deep-player]').dataset.deepPlayer`);
  // Synthetic A+B+D, with technical decoys to catch accidental visible ref rendering.
  await evaluate(`(() => {
    const f = kind => ({ id: kind, ruleId: 'deep.synthetic.' + kind, category: kind === 'review' ? 'execution' : kind === 'highlight' ? 'impact' : 'teamplay', kind,
      title: ({ review: '先被对手打到后的反击情况', highlight: 'R24 的 4K 改变了人数局面', context: '队友阵亡后，同一交火中的后续跟进' })[kind],
      summary: '合成 UX 场景：仅验证展示与回合定位，不构成真实比赛结论。', occurrences: 6, eligibleOccurrences: 10,
      relatedRounds: [7, 24], occurrenceLabel: '符合此情况：6 / 10 次', caveats: ['这不代表你的站位一定孤立，也不能说明队友当时看得到、来得及或具备支援条件。'],
      evidenceRefs: [{ engagementId: 'SECRET-ENGAGEMENT', eventIndex: 987654, tick: 876543, playerId: '76561198099999999' }] });
    window.__qaReport.deepReview = { available: true, players: window.__qaDeepOriginal.players.map(p => p.playerId === ${JSON.stringify(id)}
      ? { playerId: p.playerId, coverage: { status: 'partial' }, reviews: [f('review')], highlights: [f('highlight')], contexts: [f('context')] } : p) };
  })()`);
  await refresh();
  await checkTabs('reviews');
  await evaluate(`document.querySelector('[data-app-content]').scrollTo(0, 0)`);
  const warningPoint = await evaluate(`(() => { const r = document.querySelector('[data-deep-partial-help]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...warningPoint });
  await waitForUi(evaluate, tooltipVisible('具体限制可在每张卡片的「说明与限制」中查看'), 'Deep Review partial tooltip hover');
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 });
  await waitForUi(evaluate, `!(${tooltipVisible('具体限制可在每张卡片的「说明与限制」中查看')})`, 'Deep Review partial tooltip hover closed');
  await evaluate(`document.querySelector('[data-deep-partial-help]').focus()`);
  await waitForUi(evaluate, tooltipVisible('具体限制可在每张卡片的「说明与限制」中查看'), 'Deep Review partial tooltip focus');
  const text = await evaluate(`document.getElementById('deep-review-panel').textContent`);
  for (const expected of ['复盘重点', '亮点', '补充观察', '说明与限制', '符合此情况：6 / 10 次']) assert.ok(text.includes(expected), expected);
  for (const raw of ['SECRET-ENGAGEMENT', '987654', '876543', '76561198099999999', 'eventIndex']) assert.ok(!text.includes(raw), raw);
  for (const token of INTERNAL_TERMS) assert.ok(!text.includes(token), '合成复盘文案泄漏内部术语：' + token);
  for (const stale of ['部分证据', '证据边界', '上下文', '可判定场景']) assert.ok(!text.includes(stale), '旧文案仍出现：' + stale);
  const colors = await evaluate(`[...document.querySelectorAll('[data-deep-label]')].map(b => ({ kind: b.dataset.deepLabel, color: getComputedStyle(b).color }))`);
  assert.equal(new Set(colors.map(b => b.color)).size, 3);
  assert.equal(colors.find(b => b.kind === 'context').color, 'rgb(143, 157, 176)', 'context uses neutral foreground');
  assert.ok(await evaluate(`![...document.querySelectorAll('#deep-review-panel details')].some(d => d.open)`));
  for (const [tab, name] of [['reviews', 'deep-review-synthetic-review'], ['highlights', 'deep-review-synthetic-highlight'], ['contexts', 'deep-review-synthetic-context']]) {
    await showTab(tab);
    await evaluate(`document.querySelector('[data-deep-panel="${tab}"]').scrollTo(0, 0)`);
    await screenshot(name);
  }
  await showTab('reviews');
  await evaluate(`document.querySelector('[data-deep-panel="reviews"] details').open = true`);
  await screenshot('deep-review-synthetic-partial-caveat');
  // 比赛回放 starts from the existing related round and remains a separate view.
  assert.equal(await evaluate(`(() => { const b = [...document.querySelectorAll('[data-deep-panel="reviews"] button')].find(b => b.textContent.trim() === '比赛回放 R7'); b?.click(); return Boolean(b); })()`), true);
  await waitForUi(evaluate, `!document.getElementById('replay-panel').hidden && Boolean(document.querySelector('[data-replay-round="7"]'))`, 'Deep Review replay round');
  await evaluate(`document.getElementById('deep-review-tab').click()`);
  await settle();
  await checkTabs('reviews');
  await evaluate(`(() => {
    const original = Element.prototype.scrollIntoView;
    window.__qaScroll = null; window.__qaRestoreScroll = () => { Element.prototype.scrollIntoView = original; };
    Element.prototype.scrollIntoView = function(options) {
      if (this.id.startsWith('round-r')) window.__qaScroll = { id: this.id, visible: !document.getElementById('timeline-panel').hidden,
        expanded: [7, 24].map(r => document.querySelector('[data-round-summary="' + r + '"]').getAttribute('aria-expanded')) };
      return original.call(this, options);
    };
    document.querySelector('[data-deep-rounds]').click();
  })()`);
  await settle();
  assert.deepEqual(await evaluate('window.__qaScroll'), { id: 'round-r7', visible: true, expanded: ['true', 'true'] });
  assert.equal(await evaluate(`document.getElementById('round-r7').dataset.highlighted`), 'true');
  await screenshot('deep-review-synthetic-timeline-occurrences');
  await evaluate(`window.__qaRestoreScroll(); delete window.__qaRestoreScroll; delete window.__qaScroll`);
  await showTab('contexts');
  await select('tarkz');
  assert.notEqual(await evaluate(`document.querySelector('[data-deep-player]').dataset.deepPlayer`), id);
  assert.ok(await evaluate(`!document.getElementById('deep-review-panel').textContent.includes('合成 UX 场景')`));
  await checkTabs('reviews');
  await showTab('contexts');
  await select('twinkle');
  await checkTabs('reviews');
  // A genuinely long list must scroll only inside the active tab; the view stays fixed.
  await send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 640, deviceScaleFactor: 1, mobile: false });
  await evaluate(`(() => {
    const p = window.__qaReport.deepReview.players.find(p => p.playerId === ${JSON.stringify(id)});
    p.coverage = { status: 'complete' };
    p.highlights = []; p.contexts = [];
    p.reviews = Array.from({ length: 9 }, (_, i) => ({ id: 'qa-long-' + i, ruleId: 'deep.synthetic.long', category: 'execution', kind: 'review',
      title: '长列表复盘卡片 ' + (i + 1), summary: '合成长列表用于验证只有当前选项卡内容区滚动，页面本身不动。', occurrences: 2, eligibleOccurrences: 4,
      relatedRounds: [7], occurrenceLabel: '符合此情况：2 / 4 次', caveats: [] }));
  })()`);
  await refresh();
  await checkTabs('reviews');
  const longScroll = await evaluate(`(() => {
    const outer = document.getElementById('deep-review-panel');
    const panel = document.querySelector('[data-deep-panel="reviews"]');
    panel.scrollTop = panel.scrollHeight;
    const last = panel.lastElementChild.lastElementChild.getBoundingClientRect();
    const bottom = panel.getBoundingClientRect().top + panel.clientTop + panel.clientHeight;
    return { outer: outer.scrollHeight - outer.clientHeight, panel: panel.scrollHeight - panel.clientHeight,
      cards: panel.querySelectorAll('[data-deep-kind]').length, lastReachable: last.bottom <= bottom + 1, scrollTop: panel.scrollTop };
  })()`);
  assert.ok(longScroll.outer <= 1, 'long deep review list must not scroll the outer view');
  assert.ok(longScroll.panel > 0, 'long deep review list must scroll inside the active tab');
  assert.equal(longScroll.cards, 9);
  assert.equal(longScroll.lastReachable, true);
  assert.ok(longScroll.scrollTop > 0);
  await screenshot('deep-review-long-list');
  await evaluate(`(() => { const p = window.__qaReport.deepReview.players.find(p => p.playerId === ${JSON.stringify(id)}); p.reviews = []; p.highlights = []; p.contexts = []; p.coverage.status = 'complete'; })()`);
  await refresh();
  await checkTabs('reviews');
  const emptyText = await evaluate(`document.getElementById('deep-review-panel').textContent`);
  for (const copy of ['这场暂时没有需要重点复盘的地方，先把好状态保持住。', '高光可能在路上，这场还没有足够证据点亮它。', '观察哨今天很安静，没有额外值得补充的记录。']) {
    assert.ok(emptyText.includes(copy), copy);
  }
  assert.equal(await evaluate(`document.querySelectorAll('#deep-review-panel [data-deep-empty]').length`), 3);
  assert.equal(await evaluate(`document.querySelectorAll('#deep-review-panel [data-deep-kind]').length`), 0);
  // Unavailable is a visible data error, not a playful empty state.
  await evaluate(`(() => { const p = window.__qaReport.deepReview.players.find(p => p.playerId === ${JSON.stringify(id)}); p.reviews = []; p.highlights = []; p.contexts = []; p.coverage.status = 'unavailable'; })()`);
  await refresh();
  await checkTabs('reviews');
  assert.ok(await evaluate(`document.getElementById('deep-review-panel').textContent.includes('本场录像无法用于深度复盘，基础比赛报告仍可查看。')`));
  assert.equal(await evaluate(`document.querySelectorAll('#deep-review-panel [data-deep-unavailable-panel]').length`), 3);
  assert.equal(await evaluate(`document.querySelectorAll('#deep-review-panel [data-deep-empty]').length`), 0);
  assert.equal(await evaluate(`document.querySelectorAll('#deep-review-panel [data-deep-kind]').length`), 0);
  await assertNoPageScroll(evaluate, '深度复盘不可用');
  await screenshot('deep-review-unavailable');
  // Restore real data and collapsed rounds for the historical checks following this test.
  await evaluate(`window.__qaReport.deepReview = window.__qaDeepOriginal; delete window.__qaDeepOriginal; delete window.__qaReport`);
  await refresh();
  await checkTabs('reviews');
  for (const [width, height] of [[1920, 1032], [1024, 640], [900, 760], [800, 600], [650, 760]]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await settle();
    assert.equal(await evaluate(`document.documentElement.scrollWidth <= window.innerWidth`), true);
    const outer = await evaluate(`(() => { const p = document.getElementById('deep-review-panel'); return { width: p.scrollWidth - p.clientWidth, height: p.scrollHeight - p.clientHeight }; })()`);
    assert.ok(outer.width <= 1, width + ' deep review horizontal overflow');
    assert.ok(outer.height <= 1, width + ' deep review outer vertical overflow');
    await assertNoPageScroll(evaluate, '深度复盘 ' + width);
    for (const tab of ['reviews', 'highlights', 'contexts']) {
      await showTab(tab);
      const panel = await evaluate(`(() => { const p = document.querySelector('[data-deep-panel="${tab}"]'); const r = p.getBoundingClientRect(); return { clientHeight: p.clientHeight, scrollHeight: p.scrollHeight, widthOverflow: p.scrollWidth - p.clientWidth, top: r.top, bottom: r.bottom, overflowY: getComputedStyle(p).overflowY }; })()`);
      assert.equal(panel.overflowY, 'auto', tab + ' must own its vertical scrolling');
      assert.ok(panel.widthOverflow <= 1, tab + ' horizontal overflow');
      assert.ok(panel.clientHeight > 120, tab + ' lost usable height');
      assert.ok(panel.bottom <= height + 1, tab + ' extends below viewport');
      assert.ok(panel.scrollHeight >= panel.clientHeight, tab + ' invalid scroll height');
      await screenshot('deep-review-real-' + width + '-' + tab);
    }
  }
  await evaluate(`[...document.querySelectorAll('[data-round-summary][aria-expanded="true"]')].forEach(b => b.click())`);
  await send('Emulation.clearDeviceMetricsOverride');
}
