import assert from 'node:assert/strict';
import { checkWindowLayout, assertNoPageScroll, checkSidebarImport, waitForUi, settleUi } from './window-shell-checks.mjs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withCleanup } from './smoke-runtime.mjs';

const KPI_LABELS = ['K / D / A', 'ADR', 'HS%（爆头率）', 'KAST（回合贡献率）',
  'Trade rate（死亡后队友补枪率）', 'Trade kills（补枪击杀）', 'Opening（首杀对决）', 'Clutch（残局）'];

/**
 * Layout A acceptance: eight simultaneously visible KPIs above two independently
 * scrollable columns, with no report-view page scroll and no clipped column content.
 */
export async function checkReportLayout(evaluate, label) {
  const layout = await evaluate(`(() => {
    const panel = document.getElementById('report-panel');
    const grid = panel?.querySelector('[aria-label="玩家指标"]');
    const rect = el => { const r = el.getBoundingClientRect(); return { top: r.top, right: r.right, bottom: r.bottom, left: r.left, width: r.width, height: r.height }; };
    const describeColumn = el => {
      if (!el) return null;
      const heading = el.getAttribute('aria-labelledby');
      const title = heading ? document.getElementById(heading) : null;
      return { rect: rect(el), overflowY: getComputedStyle(el).overflowY, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight,
        scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, scrollTop: el.scrollTop, tabIndex: el.tabIndex,
        role: el.getAttribute('role'), labelledby: heading, headingText: title?.textContent ?? '',
        headingVisible: Boolean(title && title.checkVisibility() && title.getBoundingClientRect().height > 0),
        visible: el.checkVisibility() };
    };
    return {
      panel: panel ? { rect: rect(panel), overflowY: getComputedStyle(panel).overflowY, overflow: panel.scrollHeight - panel.clientHeight } : null,
      grid: grid ? { columns: getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length,
        rows: getComputedStyle(grid).gridTemplateRows.split(' ').filter(Boolean).length,
        bottom: grid.getBoundingClientRect().bottom } : null,
      kpis: [...(panel?.querySelectorAll('[data-report-kpi]') ?? [])].map(el => ({ name: el.dataset.reportKpi,
        text: el.innerText, rect: rect(el), scrollHeight: el.scrollHeight, clientHeight: el.clientHeight,
        scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, visible: el.checkVisibility() })),
      left: describeColumn(panel?.querySelector('[data-report-column="findings"]')),
      right: describeColumn(panel?.querySelector('[data-report-column="utility"]')),
      documentHorizontal: document.documentElement.scrollWidth - innerWidth,
      viewport: [innerWidth, innerHeight],
    };
  })()`);
  assert.ok(layout.panel, label + ': missing report panel');
  assert.equal(layout.panel.overflowY, 'hidden', label + ': report panel must never scroll');
  assert.ok(layout.panel.overflow <= 1, label + ': report panel content overflows by ' + layout.panel.overflow + 'px');
  assert.equal(layout.kpis.length, 8, label + ': eight KPIs must stay visible');
  assert.deepEqual(layout.kpis.map(kpi => kpi.name), KPI_LABELS, label + ': KPI labels');
  assert.equal(layout.grid.columns, 4, label + ': KPI grid must be 4 columns by 2 rows');
  assert.equal(layout.grid.rows, 2, label + ': KPI grid must be 4 columns by 2 rows');
  for (const kpi of layout.kpis) {
    assert.equal(kpi.visible, true, label + ': hidden KPI ' + kpi.name);
    assert.ok(kpi.rect.width > 0 && kpi.rect.height > 0, label + ': collapsed KPI ' + kpi.name);
    assert.ok(kpi.scrollHeight <= kpi.clientHeight + 1, label + ': clipped KPI content ' + kpi.name);
    assert.ok(kpi.rect.right <= layout.panel.rect.right + 1, label + ': KPI outside report panel horizontally ' + kpi.name);
    assert.ok(kpi.scrollWidth <= kpi.clientWidth + 1, label + ': KPI content is horizontally clipped ' + kpi.name);
    assert.ok(kpi.rect.top >= layout.panel.rect.top - 1 && kpi.rect.bottom <= layout.panel.rect.bottom + 1,
      label + ': KPI outside report panel ' + kpi.name);
    assert.ok(kpi.rect.bottom <= layout.viewport[1] + 1, label + ': KPI below viewport ' + kpi.name);
  }
  assert.ok(layout.documentHorizontal <= 1, label + ': horizontal page overflow ' + layout.documentHorizontal + 'px');
  assert.ok(layout.grid.bottom <= layout.left.rect.top + 1, label + ': KPI grid overlaps the content columns');
  assert.ok(layout.grid.bottom <= layout.right.rect.top + 1, label + ': KPI grid overlaps the content columns');
  for (const [name, column] of [['left', layout.left], ['right', layout.right]]) {
    assert.ok(column, label + ': missing ' + name + ' report column');
    assert.equal(column.visible, true, label + ': hidden ' + name + ' column');
    assert.equal(column.role, 'region', label + ': ' + name + ' column must be a labelled region');
    assert.equal(column.tabIndex, 0, label + ': ' + name + ' column must be keyboard focusable');
    assert.equal(column.overflowY, 'auto', label + ': ' + name + ' column owns vertical scrolling');
    assert.ok(column.headingText && column.headingVisible, label + ': ' + name + ' column heading must stay visible');
    assert.ok(column.rect.top >= layout.panel.rect.top - 1 && column.rect.bottom <= layout.panel.rect.bottom + 1,
      label + ': ' + name + ' column outside report panel');
    assert.ok(column.rect.height > 40, label + ': ' + name + ' column lost its usable height (' + column.rect.height + 'px)');
    assert.ok(column.scrollWidth <= column.clientWidth + 1, label + ': ' + name + ' column clips horizontally');
  }
  const scrollCheck = await evaluate(`(() => {
    const check = selector => {
      const el = document.querySelector(selector);
      const overflow = el.scrollHeight - el.clientHeight;
      if (overflow <= 1) return { overflow, ok: true };
      const before = el.scrollTop;
      el.scrollTop = el.scrollHeight;
      const reached = Math.abs(el.scrollTop - overflow) <= 1;
      const last = el.lastElementChild?.getBoundingClientRect();
      const bottom = el.getBoundingClientRect().top + el.clientTop + el.clientHeight;
      const lastReachable = !last || last.bottom <= bottom + 1;
      el.scrollTop = before;
      return { overflow, reached, lastReachable, ok: reached && lastReachable };
    };
    return { left: check('[data-report-column="findings"]'), right: check('[data-report-column="utility"]') };
  })()`);
  for (const name of ['left', 'right']) assert.equal(scrollCheck[name].ok, true, label + ': inaccessible ' + name + ' column content ' + JSON.stringify(scrollCheck[name]));
  // On sub-1024 widths the utility/clutch cards may need horizontal scrolling; that is
  // acceptable only when the card itself is scrollable instead of clipping content.
  const cardScroll = await evaluate(`(() => [...document.querySelectorAll('[data-report-column="utility"] .fui-Card')].map(card => ({
    kind: card.hasAttribute('data-utility-panel') ? 'utility' : 'clutch',
    overflow: card.scrollWidth - card.clientWidth,
    overflowX: getComputedStyle(card).overflowX,
  })))()`);
  assert.ok(cardScroll.length >= 2, label + ': expected utility and clutch cards');
  for (const card of cardScroll) {
    if (card.overflow > 1) assert.equal(card.overflowX, 'auto', label + ': ' + card.kind + ' card hides horizontally clipped content');
  }

  // Both columns own their scroll offset: moving one must not move the other.
  if (layout.right.scrollHeight > layout.right.clientHeight) {
    const independent = await evaluate(`(() => {
      const left = document.querySelector('[data-report-column="findings"]');
      const right = document.querySelector('[data-report-column="utility"]');
      left.scrollTop = 0; right.scrollTop = 0;
      left.scrollTop = Math.min(24, left.scrollHeight - left.clientHeight);
      const afterLeft = { left: left.scrollTop, right: right.scrollTop };
      right.scrollTop = Math.min(18, right.scrollHeight - right.clientHeight);
      const afterRight = { left: left.scrollTop, right: right.scrollTop };
      left.scrollTop = 0; right.scrollTop = 0;
      return { afterLeft, afterRight };
    })()`);
    assert.ok(independent.afterLeft.left > 0, label + ': left column did not scroll');
    assert.equal(independent.afterLeft.right, 0, label + ': left scroll moved the right column');
    assert.ok(independent.afterRight.right > 0, label + ': right column did not scroll');
    assert.equal(independent.afterRight.left, independent.afterLeft.left, label + ': right scroll moved the left column');
  }
  await evaluate('document.querySelector("[data-report-column=findings]").scrollTop = 0; document.querySelector("[data-report-column=utility]").scrollTop = 0');
  return layout;
}

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
  assert.equal(await evaluate(`document.querySelectorAll('[role="tabpanel"]').length`), 6);
  assert.equal(await evaluate(`document.getElementById('report-panel').hidden`), false);
  await checkSidebarImport(evaluate, send, '重新选择 DEM');
  await evaluate(`document.querySelector('[data-sidebar-toggle]').click()`);
  await waitForUi(evaluate, `document.querySelector('[data-app-sidebar]').dataset.collapsed === 'true' && document.getAnimations().every(a => a.playState !== 'running')`, 'collapsed report sidebar');
  await checkSidebarImport(evaluate, send, '重新选择 DEM');
  await assertNoPageScroll(evaluate, '报告折叠导航');
  await evaluate(`document.querySelector('[data-sidebar-toggle]').click()`);
  await waitForUi(evaluate, `document.querySelector('[data-app-sidebar]').dataset.collapsed === 'false' && document.getAnimations().every(a => a.playState !== 'running')`, 'expanded report sidebar');
  await checkReportLayout(evaluate, '比赛报告初始布局');
  // Prove the checks reject a scrollable column whose content is clipped by a fixed height.
  await evaluate(`document.querySelector('[data-report-column="findings"]').style.overflowY = 'hidden'`);
  await withCleanup(() => assert.rejects(() => assertNoPageScroll(evaluate, 'intentional clipping probe'), /inaccessible content/),
    [() => evaluate(`document.querySelector('[data-report-column="findings"]').style.removeProperty('overflow-y')`)]);
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
  for (const [width, height] of [[1280, 900], [1024, 640], [900, 760], [800, 600], [650, 760]]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await evaluate(`document.getElementById('analysis-tab').click()`);
    await waitForUi(evaluate, `document.getElementById('analysis-panel').checkVisibility() && document.getElementById('analysis-panel').clientHeight > 0`, 'visible Analysis layout');
    const divider = await evaluate(`(() => { const s = getComputedStyle(document.querySelector('[data-side-divider]')); return { display: s.display, top: s.marginTop, bottom: s.marginBottom, width: s.width }; })()`);
    if (width <= 650) assert.equal(divider.display, 'none');
    else { assert.notEqual(divider.display, 'none'); assert.equal(divider.top, '16px'); assert.equal(divider.bottom, '16px'); assert.equal(divider.width, '1px'); }
    await evaluate("document.querySelector('[data-app-content]').scrollTo(0, 0)");
    await screenshot(`comparison-${width}`);
    await evaluate(`document.querySelector('[aria-label="回合表现趋势"]').scrollIntoView({ block: 'start' })`);
    await screenshot(`trend-sides-${width}`);
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
    await checkReportLayout(evaluate, `比赛报告 ${width}×${height}`);
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
