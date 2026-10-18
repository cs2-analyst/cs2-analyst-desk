import assert from 'node:assert/strict';
import { checkWindowLayout, assertNoPageScroll, checkSidebarImport, waitForUi, settleUi } from './window-shell-checks.mjs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withCleanup } from './smoke-runtime.mjs';

/** Shared CDP assertions for built and installed renderers, after demo1 import. */
export async function checkReportUx(evaluate, send, qaDir) {
  // Settle the previous Finding → Timeline scroll and CDP viewport restoration,
  // then cancel its smooth scroll before asserting the exact top-of-page layout.
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await settleUi(evaluate, 'previous Finding scroll and viewport restoration');
  await evaluate("document.activeElement?.blur(); document.querySelector('[data-app-content]').scrollTo({top:0,left:0,behavior:'instant'}); window.scrollTo({top:0,left:0,behavior:'instant'})");
  await checkWindowLayout(evaluate);
  // Wait in Node: occluded Electron windows can pause renderer animation frames.
  const settle = () => settleUi(evaluate);
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await evaluate(`document.getElementById('report-tab').click()`);
  await settle();
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('[data-app-sidebar] [role="tab"]')].map(t => t.querySelector('.fui-Tab__content').textContent)`), ['比赛报告', '深度复盘', '回合时间线', '分析', '比赛回放', '热力图']);
  assert.equal(await evaluate(`[...document.querySelectorAll('[role="tabpanel"]')].filter(p => !p.parentElement.closest('[role="tabpanel"]')).length`), 6);
  assert.equal(await evaluate(`document.getElementById('report-panel').hidden`), false);
  await checkSidebarImport(evaluate, send, '重新选择 DEM');
  await evaluate(`document.querySelector('[data-sidebar-toggle]').click()`);
  await waitForUi(evaluate, `document.querySelector('[data-app-sidebar]').dataset.collapsed === 'true' && document.getAnimations().every(a => a.playState !== 'running')`, 'collapsed report sidebar');
  await checkSidebarImport(evaluate, send, '重新选择 DEM');
  await assertNoPageScroll(evaluate, '报告折叠导航');
  await evaluate(`document.querySelector('[data-sidebar-toggle]').click()`);
  await waitForUi(evaluate, `document.querySelector('[data-app-sidebar]').dataset.collapsed === 'false' && document.getAnimations().every(a => a.playState !== 'running')`, 'expanded report sidebar');
  // Prove these checks reject clipping and hidden-panel false positives on the actual report DOM.
  assert.ok(await evaluate(`document.getElementById('report-panel').scrollHeight > document.getElementById('report-panel').clientHeight`));
  await evaluate(`document.getElementById('report-panel').style.overflowY = 'hidden'`);
  await withCleanup(() => assert.rejects(() => assertNoPageScroll(evaluate, 'intentional clipping probe'), /inaccessible content/),
    [() => evaluate(`document.getElementById('report-panel').style.removeProperty('overflow-y')`)]);
  await evaluate(`document.getElementById('report-panel').hidden = true`);
  await withCleanup(() => assert.rejects(() => assertNoPageScroll(evaluate, 'intentional hidden panel probe'), /selected Tab/),
    [() => evaluate(`document.getElementById('report-panel').hidden = false`)]);
  await assertNoPageScroll(evaluate, '比赛报告滚动末端');
  // Native summary retains keyboard activation and clear focus feedback.
  const summary = await evaluate(`(() => { const s = document.querySelector('#report-panel summary'); s.focus(); return { cursor: getComputedStyle(s).cursor, focused: document.activeElement === s }; })()`);
  assert.equal(summary.cursor, 'pointer');
  assert.equal(summary.focused, true);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', windowsVirtualKeyCode: 13 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  assert.equal(await evaluate(`document.querySelector('#report-panel details').open`), true);
  assert.equal(await evaluate(`document.querySelector('#report-panel summary').matches(':focus-visible')`), true);
  assert.ok(await evaluate(`parseFloat(getComputedStyle(document.querySelector('#report-panel summary')).outlineWidth) >= 2`));
  await evaluate(`document.querySelector('#report-panel details').open = false; document.activeElement.blur()`);
  const hover = await evaluate(`(() => { const s = document.querySelector('#report-panel summary'); s.scrollIntoView({ block: 'center' }); const r = s.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...hover });
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('#report-panel summary')).backgroundColor`), 'rgb(34, 43, 54)');
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0 });
  // Observe scrolling itself: the destination must be visible and expanded at call time.
  await evaluate(`(() => { const original = Element.prototype.scrollIntoView; window.__roundScroll = null;
    window.__restoreRoundScroll = () => { Element.prototype.scrollIntoView = original; };
    Element.prototype.scrollIntoView = function(options) {
      if (this.id === 'round-r24') window.__roundScroll = { visible: !document.getElementById('timeline-panel').hidden, expanded: this.querySelector('button').getAttribute('aria-expanded') };
      return original.call(this, options);
    };
    [...document.querySelectorAll('#report-panel button')].find(b => b.textContent.trim() === '查看 R24').click();
  })()`);
  await settle();
  assert.deepEqual(await evaluate('window.__roundScroll'), { visible: true, expanded: 'true' });
  await evaluate('window.__restoreRoundScroll(); delete window.__restoreRoundScroll; delete window.__roundScroll');
  assert.equal(await evaluate(`document.querySelector('[data-timeline-round="24"]').dataset.highlighted`), 'true');
  const kills = await evaluate(`([...document.querySelectorAll('[data-round-detail="24"] [data-killfeed-event="kill"]')].map(r => ({ attacker: r.querySelector('[data-killfeed-attacker]').textContent, victim: r.querySelector('[data-killfeed-victim]').textContent, weapon: r.querySelector('[data-killfeed-weapon]').dataset.killfeedWeapon, label: r.getAttribute('aria-label'), icons: r.querySelectorAll('img').length })))`);
  assert.equal(kills.length, 4);
  assert.ok(kills.every(k => k.attacker === 'twinkle' && k.icons >= 1));
  assert.ok(kills.some(k => k.weapon === 'ak47' && k.victim === 'tarkz' && k.label.includes('122.20 秒')));
  assert.ok(kills.some(k => k.victim === '8888888888888888888888'));
  assert.equal(await evaluate(`document.querySelector('[data-round-detail="24"]').textContent.includes('→')`), false);
  await evaluate(`(() => { const b = document.querySelector('[data-round-summary="22"]'); if (b.getAttribute('aria-expanded') === 'false') b.click(); })()`);
  await settle();
  const posthumous = await evaluate(`([...document.querySelectorAll('[data-round-detail="22"] [data-killfeed-event="death"]')].map(r => ({ attacker: r.querySelector('[data-killfeed-attacker]').textContent, victim: r.querySelector('[data-killfeed-victim]').textContent, weapon: r.querySelector('[data-killfeed-weapon]').dataset.killfeedWeapon, label: r.getAttribute('aria-label') })))`);
  assert.ok(posthumous.some(k => k.attacker === 'tarkz' && k.victim === 'twinkle' && k.weapon === 'hegrenade' && k.label.includes('32.78 秒')));
  // R24 has no headshot flag; R23 contains a real headshot death for twinkle.
  await evaluate(`(() => { const b = document.querySelector('[data-round-summary="23"]'); if (b.getAttribute('aria-expanded') === 'false') b.click(); })()`);
  await settle();
  const images = await evaluate(`Promise.all([...document.querySelectorAll('[data-round-detail="24"] img, [data-round-detail="22"] img, [data-round-detail="23"] img')].map(async i => { await i.decode(); const r = i.getBoundingClientRect(); return { round: i.closest('[data-round-detail]').dataset.roundDetail, icon: i.dataset.killfeedIcon, src: i.getAttribute('src'), loaded: i.complete && i.naturalWidth > 0, fit: getComputedStyle(i).objectFit, height: r.height, width: r.width, alt: i.alt }; }))`);
  for (const [icon, file] of [['ak47', 'ak47'], ['inferno', 'inferno'], ['hegrenade', 'hegrenade'], ['headshot', 'icon_headshot'], ['flash', 'flashbang_assist']]) {
    assert.ok(images.some(i => i.icon === icon && i.src.includes(file + '-') && i.loaded), icon + ' official asset must load');
  }
  assert.ok(images.some(i => i.round === '23' && i.icon === 'headshot' && i.loaded), 'R23 official headshot');
  assert.ok(images.some(i => i.round === '22' && i.icon === 'flash' && i.loaded), 'R22 official flash assist');
  assert.ok(images.every(i => i.loaded && i.fit === 'contain' && i.height === 22 && i.width <= 96 && i.alt === ''));
  await evaluate(`document.getElementById('analysis-tab').click()`);
  await settle();
  const colors = await evaluate(`([...document.querySelectorAll('[data-comparison-player]')].map(r => ({ current: r.textContent.includes('· 当前'), name: getComputedStyle(r.firstElementChild).color, bar: r.children[1].firstElementChild ? getComputedStyle(r.children[1].firstElementChild).backgroundColor : null })))`);
  assert.ok(colors.some(c => c.current && c.name === 'rgb(98, 171, 245)' && c.bar === c.name));
  assert.ok(colors.filter(c => !c.current).every(c => c.name !== 'rgb(98, 171, 245)' && c.bar !== 'rgb(98, 171, 245)'));
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('[data-multi-kill]')].map(e => e.textContent)`), ['双杀 6', '三杀 1', '四杀 1']);
  assert.equal(await evaluate(`document.getElementById('analysis-panel').textContent.includes('最大柱')`), false);
  // Select a non-default metric and confirm every mounted panel keeps its local state.
  await evaluate(`document.querySelector('[aria-label="对比指标"]').click()`);
  await settle();
  await evaluate(`[...document.querySelectorAll('[role="option"]')].find(o => o.textContent.trim() === 'K/D').click()`);
  await settle();
  const player = await evaluate(`document.querySelector('[aria-label="目标玩家"]').textContent`);
  await evaluate(`document.getElementById('timeline-tab').click()`);
  await settle();
  assert.equal(await evaluate(`document.querySelector('[data-round-summary="24"]').getAttribute('aria-expanded')`), 'true');
  await evaluate(`document.getElementById('analysis-tab').click()`);
  await settle();
  assert.equal(await evaluate(`document.querySelector('[aria-label="对比指标"]').textContent`), 'K/D');
  assert.equal(await evaluate(`document.querySelector('[aria-label="目标玩家"]').textContent`), player);
  const screenshot = async name => {
    if (!qaDir) return;
    await settleUi(evaluate, 'screenshot layout, fonts and scroll');
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(join(qaDir, name + '.png'), Buffer.from(shot.data, 'base64'));
  };
  const selectAnalysisTab = async key => {
    await evaluate(`document.querySelector('[data-analysis-tab="${key}"]').click()`);
    await settle();
    assert.equal(await evaluate(`document.querySelector('[data-analysis-panel="${key}"]').hidden`), false, 'analysis panel ' + key);
    assert.equal(await evaluate(`document.querySelector('[data-analysis-tab="${key}"]').getAttribute('aria-selected')`), 'true', 'analysis selected ' + key);
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
  // Keyboard and real pointer activation both operate the controlled TabList.
  await evaluate(`document.querySelector('[data-analysis-tab="comparison"]').focus()`);
  await pressKey('ArrowRight', 'ArrowRight', 39);
  assert.equal(await evaluate(`document.activeElement?.dataset.analysisTab`), 'trend', 'analysis arrow focus');
  await pressKey('Enter', 'Enter', 13, '\r');
  assert.equal(await evaluate(`document.querySelector('[data-analysis-tab="trend"]').getAttribute('aria-selected')`), 'true');
  await pressKey('ArrowRight', 'ArrowRight', 39);
  assert.equal(await evaluate(`document.activeElement?.dataset.analysisTab`), 'sides', 'analysis arrow focus again');
  await pressKey('Enter', 'Enter', 13, '\r');
  assert.equal(await evaluate(`document.querySelector('[data-analysis-tab="sides"]').getAttribute('aria-selected')`), 'true');
  await pressKey('ArrowLeft', 'ArrowLeft', 37);
  assert.equal(await evaluate(`document.activeElement?.dataset.analysisTab`), 'trend', 'analysis left focus');
  await pressKey('Enter', 'Enter', 13, '\r');
  assert.equal(await evaluate(`document.querySelector('[data-analysis-tab="trend"]').getAttribute('aria-selected')`), 'true');
  await mouseClick('[data-analysis-tab="comparison"]');
  await selectAnalysisTab('comparison');
  // Hover and focus both expose the player comparison Tooltip.
  await evaluate('document.activeElement?.blur()');
  const playerPoint = await evaluate(`(() => { const r = document.querySelector('[data-comparison-player]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...playerPoint });
  await waitForUi(evaluate, `[...document.querySelectorAll('[role="tooltip"]')].some(t => t.textContent.includes('twinkle') && t.textContent.includes('K/D'))`, 'analysis player tooltip hover');
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 });
  await evaluate(`document.querySelector('[data-comparison-player]').focus()`);
  await waitForUi(evaluate, `[...document.querySelectorAll('[role="tooltip"]')].some(t => t.textContent.includes('twinkle') && t.textContent.includes('K/D'))`, 'analysis player tooltip focus');
  for (const [width, height] of [[1920, 1032], [1280, 900], [1024, 640], [900, 760], [800, 600], [650, 760]]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await evaluate(`document.getElementById('analysis-tab').click()`);
    await waitForUi(evaluate, `document.getElementById('analysis-panel').checkVisibility() && document.getElementById('analysis-panel').clientHeight > 0`, 'visible Analysis layout');
    await selectAnalysisTab('comparison');
    await evaluate("document.querySelector('[data-app-content]').scrollTo(0, 0)");
    const analysisOuter = await evaluate(`(() => { const p = document.getElementById('analysis-panel'); return { width: p.scrollWidth - p.clientWidth, height: p.scrollHeight - p.clientHeight }; })()`);
    assert.ok(analysisOuter.width <= 1, width + ' analysis outer horizontal overflow');
    assert.ok(analysisOuter.height <= 1, width + ' analysis outer vertical overflow');
    const comparisonPanel = await evaluate(`(() => { const p = document.querySelector('[data-analysis-panel="comparison"]'); const r = p.getBoundingClientRect(); return { clientHeight: p.clientHeight, scrollHeight: p.scrollHeight, overflowY: getComputedStyle(p).overflowY, bottom: r.bottom }; })()`);
    assert.equal(comparisonPanel.overflowY, 'auto');
    assert.ok(comparisonPanel.clientHeight > 120);
    assert.ok(comparisonPanel.bottom <= height + 1);
    if (width === 1024) assert.ok(comparisonPanel.scrollHeight > comparisonPanel.clientHeight, 'long comparison must scroll inside the tab');
    await screenshot(`comparison-${width}`);
    await selectAnalysisTab('sides');
    const divider = await evaluate(`(() => { const s = getComputedStyle(document.querySelector('[data-side-divider]')); return { display: s.display, top: s.marginTop, bottom: s.marginBottom, width: s.width }; })()`);
    if (width <= 650) assert.equal(divider.display, 'none');
    else { assert.notEqual(divider.display, 'none'); assert.equal(divider.top, '16px'); assert.equal(divider.bottom, '16px'); assert.equal(divider.width, '1px'); }
    await screenshot(`sides-${width}`);
    await selectAnalysisTab('trend');
    await screenshot(`trend-${width}`);
    await evaluate(`document.getElementById('timeline-tab').click()`);
    await settle();
    await assertNoPageScroll(evaluate, `回合时间线 ${width}×${height}`);
    await evaluate(`document.getElementById('round-r24').scrollIntoView({ block: 'center' })`);
    await screenshot(`killfeed-r24-${width}`);
    assert.equal(await evaluate(`document.documentElement.scrollWidth <= window.innerWidth`), true, 'Timeline 整页不得溢出');
    const layout = await evaluate(`([...document.querySelectorAll('[data-round-detail="24"] [data-killfeed-event]')].map(r => { const i=r.querySelector('[data-killfeed-weapon]'); const n=r.querySelector('[data-killfeed-victim]'); return { icon: i.getBoundingClientRect().width, name: getComputedStyle(n).textOverflow }; }))`);
    assert.ok(layout.every(r => r.icon >= 22 && r.name === 'ellipsis'));
    await evaluate(`document.getElementById('round-r22').scrollIntoView({ block: 'center' })`);
    await screenshot(`killfeed-r22-${width}`);
    await evaluate(`document.getElementById('round-r23').scrollIntoView({ block: 'center' })`);
    await screenshot(`killfeed-headshot-r23-${width}`);
    await evaluate(`document.getElementById('report-tab').click(); document.querySelector('[data-app-content]').scrollTo(0, 0)`);
    await settle();
    await assertNoPageScroll(evaluate, `比赛报告 ${width}×${height}`);
    await screenshot(`report-tabs-${width}`);
    await evaluate(`document.querySelector('#report-panel summary').scrollIntoView({ block: 'center' }); document.querySelector('#report-panel summary').focus()`);
    await screenshot(`finding-evidence-${width}`);
    await evaluate(`document.getElementById('analysis-tab').click()`);
    await settle();
    await assertNoPageScroll(evaluate, `分析 ${width}×${height}`);
    assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true, 'Analysis 整页不得溢出');
    await evaluate(`document.getElementById('deep-review-tab').click()`);
    await settle();
    await assertNoPageScroll(evaluate, `深度复盘 ${width}×${height}`);
  }
  await send('Emulation.clearDeviceMetricsOverride');
  await evaluate(`document.getElementById('report-tab').click()`);
  await settle();
}
