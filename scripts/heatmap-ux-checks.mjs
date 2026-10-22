import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { jsonHash } from '../apps/desktop/tests/heatmap-real-fixture.mjs';
import { waitFor, withCleanup } from './smoke-runtime.mjs';
import { settleUi } from './window-shell-checks.mjs';

/** Real mounted component state, inspected in QA only; no shipped debug API or DTO fields. */
export const heatmapSnapshotExpression = `(() => {
  const node = document.querySelector('[data-heatmap-session]');
  if (!node) return null;
  let root = node[Object.keys(node).find(k => k.startsWith('__reactFiber$'))];
  while (root?.return) root = root.return;
  const visit = fiber => {
    if (!fiber) return null;
    if (fiber.memoizedProps?.sessionActive !== undefined && fiber.memoizedProps?.players) return fiber;
    return visit(fiber.child) ?? visit(fiber.sibling);
  };
  const fiber = visit(root.stateNode.current);
  if (!fiber) return null;
  const hooks = []; for (let hook = fiber.memoizedState; hook; hook = hook.next) if (hook.queue?.dispatch) hooks.push(hook.memoizedState);
  return { active: fiber.memoizedProps.active, metadata: fiber.memoizedProps.metadata, scope: hooks.find(s=>s?.samplingSet), resolution: hooks.find(s=>[16,32,64].includes(s)), enabled: hooks.find(s=>Array.isArray(s)&&s.every(l=>['positions','kills','deaths'].includes(l))), results: hooks.find(s=>s&&typeof s.key==='string'&&s.layers) };
})()`;
const readReport = `(() => {let f=document.getElementById('heatmap-panel')[Object.keys(document.getElementById('heatmap-panel')).find(k=>k.startsWith('__reactFiber$'))];while(f&&!f.memoizedProps?.report)f=f.return;return f?.memoizedProps.report;})()`;
const pixelExpression = `(() => {const c=document.querySelector('#heatmap-panel canvas'),d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let h=2166136261,opaque=0;for(let i=0;i<d.length;i++){h=Math.imul(h^d[i],16777619);if(i%4===3&&d[i])opaque++;}return {hash:h>>>0,opaque,width:c.width,height:c.height};})()`;
const radarMapAsset = new URL('../apps/desktop/renderer/src/assets/replay-maps/de_dust2.png', import.meta.url);
const radarMapBytes = readFileSync(radarMapAsset);
const radarMapSha256 = createHash('sha256').update(radarMapBytes).digest('hex');
const radarMapDataUrl = `data:image/png;base64,${radarMapBytes.toString('base64')}`;
const radarReferenceExpression = source => `(async() => {
  const canvas = document.querySelector('#heatmap-panel canvas');
  const image = new Image(); image.src = ${JSON.stringify(source)}; await image.decode();
  const reference = document.createElement('canvas'); reference.width = canvas.width; reference.height = canvas.height;
  const context = reference.getContext('2d');
  context.drawImage(image, 0, 0, reference.width, reference.height);
  const data = context.getImageData(0, 0, reference.width, reference.height).data;
  let hash = 2166136261, opaque = 0;
  for (let i = 0; i < data.length; i++) { hash = Math.imul(hash ^ data[i], 16777619); if (i % 4 === 3 && data[i]) opaque++; }
  window.__qaRadarBaseData = data;
  window.__qaRadarBaseOpaque = opaque;
  return { asset: 'renderer/src/assets/replay-maps/de_dust2.png', sha256: ${JSON.stringify(radarMapSha256)}, naturalSize: [image.naturalWidth, image.naturalHeight], width: reference.width, height: reference.height, hash: hash >>> 0, opaque };
})()`;
const baseComparisonExpression = `(() => {
  const canvas = document.querySelector('#heatmap-panel canvas'), actual = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  const expected = window.__qaRadarBaseData;
  if (!expected || expected.length !== actual.length) throw new Error('Independent radar baseline dimensions changed');
  const width = canvas.width, height = canvas.height, step = 4, navigationStep = 24;
  let hash = 2166136261, opaque = 0, differentBytes = 0, differentPixels = 0;
  let alphaSamples = 0, alphaMatches = 0, interiorColorSamples = 0, interiorColorMatches = 0;
  let navigationAlphaSamples = 0, navigationAlphaMatches = 0, navigationInteriorColorSamples = 0, navigationInteriorColorMatches = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    let changed = false;
    for (let k = 0; k < 4; k++) { hash = Math.imul(hash ^ actual[i + k], 16777619); if (actual[i + k] !== expected[i + k]) { differentBytes++; changed = true; } }
    if (changed) differentPixels++;
    if (actual[i + 3]) opaque++;
    if (x % step === 0 && y % step === 0) {
      alphaSamples++;
      if ((actual[i + 3] > 0) === (expected[i + 3] > 0)) alphaMatches++;
      if (x >= 2 && y >= 2 && x < width - 2 && y < height - 2) {
        let stableInterior = true;
        for (let dy = -2; dy <= 2 && stableInterior; dy++) for (let dx = -2; dx <= 2; dx++) {
          if (expected[((y + dy) * width + x + dx) * 4 + 3] !== 255) { stableInterior = false; break; }
        }
        if (stableInterior) {
          interiorColorSamples++;
          if (actual[i + 3] === 255 && [0, 1, 2].every(k => Math.abs(actual[i + k] - expected[i + k]) <= 3)) interiorColorMatches++;
        }
      }
    }
    if (x % navigationStep === 0 && y % navigationStep === 0) {
      navigationAlphaSamples++;
      if ((actual[i + 3] > 0) === (expected[i + 3] > 0)) navigationAlphaMatches++;
      if (x >= 2 && y >= 2 && x < width - 2 && y < height - 2) {
        let stableInterior = true;
        for (let dy = -2; dy <= 2 && stableInterior; dy++) for (let dx = -2; dx <= 2; dx++) {
          if (expected[((y + dy) * width + x + dx) * 4 + 3] !== 255) { stableInterior = false; break; }
        }
        if (stableInterior) {
          navigationInteriorColorSamples++;
          if (actual[i + 3] === 255 && [0, 1, 2].every(k => Math.abs(actual[i + k] - expected[i + k]) <= 3)) navigationInteriorColorMatches++;
        }
      }
    }
  }
  return { hash: hash >>> 0, width, height, opaque, opaqueRatio: opaque / window.__qaRadarBaseOpaque,
    differentBytes, differentPixels, alphaSamples, alphaMatches, alphaMaskMatchRate: alphaMatches / alphaSamples,
    interiorColorSamples, interiorColorMatches, interiorColorMatchRate: interiorColorMatches / interiorColorSamples,
    navigationAlphaSamples, navigationAlphaMatches, navigationAlphaMaskMatchRate: navigationAlphaMatches / navigationAlphaSamples,
    navigationInteriorColorSamples, navigationInteriorColorMatches, navigationInteriorColorMatchRate: navigationInteriorColorMatches / navigationInteriorColorSamples };
})()`;

export async function checkHeatmapUx(evaluate, send, { qaDir, direct, memory = async () => {}, full = false, expectedDust2 = false } = {}) {
  const metrics = { cases: [], layouts: [], draws: [], method: 'Real Renderer/preload/Main/Utility; React current-tree read only for DTO parity. Pixel FNV over actual Canvas RGBA. Draw timing wraps native Canvas context, no product telemetry.' };
  const wait = (probe, label) => waitFor(probe, 25_000, label, { intervalMs: 30, diagnostics: () => evaluate(`document.getElementById('heatmap-panel').innerText`) });
  const snapshot = () => evaluate(heatmapSnapshotExpression);
  const painted = () => evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())))`);
  const choose = async (name, value) => {
    if (name === '回合') {
      await chooseRound(value ? 'R' + value : '全部回合');
      return;
    }
    const label = '热力图' + name;
    const optionValue = value === '' || value === null || value === undefined ? 'all' : String(value);
    await evaluate(`document.querySelector('[aria-label=${JSON.stringify(label)}]').click()`);
    await waitFor(() => evaluate(`Boolean([...document.querySelectorAll('[role=option]')].find(o=>o.checkVisibility()&&o.getAttribute('data-value')===${JSON.stringify(optionValue)}))`), 5000, 'heatmap option ' + label + ' ' + optionValue);
    await evaluate(`[...document.querySelectorAll('[role=option]')].find(o=>o.checkVisibility()&&o.getAttribute('data-value')===${JSON.stringify(optionValue)}).click()`);
    await waitFor(() => evaluate('![...document.querySelectorAll("[role=option]")].some(o=>o.checkVisibility())'), 5000, 'heatmap menu closed ' + label);
  };
  const chooseRound = async label => {
    await evaluate(`document.querySelector('[aria-label="热力图回合"]').click()`);
    await waitFor(() => evaluate(`Boolean([...document.querySelectorAll('[role=option]')].find(o=>o.textContent.trim()===${JSON.stringify(label)}))`), 5000, 'heatmap round option ' + label);
    await evaluate(`[...document.querySelectorAll('[role=option]')].find(o=>o.textContent.trim()===${JSON.stringify(label)}).click()`);
    await waitFor(() => evaluate(`document.querySelector('[aria-label="热力图回合"]').textContent===${JSON.stringify(label)}`), 5000, 'heatmap round value ' + label);
  };
  const ready = async () => wait(async () => {
    const s = await snapshot();
    if (!s) return null;
    // All layers off is a valid state; only wait for enabled layers to be ready.
    for (const layer of s.enabled) {
      const state = s.results.layers[layer];
      if (state?.status === 'error') throw new Error(`${layer}: ${state.message}`);
      if (state?.status !== 'ready') return null;
      const p = state.projection;
      if (p.grid.resolution !== s.resolution || Object.keys(s.scope).some(key => JSON.stringify(p.scope[key]) !== JSON.stringify(s.scope[key]))) return null;
    }
    return s;
  }, 'current heatmap DTOs');
  const matchesRadarBaseline = pixels => Math.abs(pixels.opaqueRatio - 1) <= .01
    && pixels.alphaMaskMatchRate >= .999 && pixels.interiorColorMatchRate >= .99;
  const matchesNavigationRadar = pixels => pixels.opaqueRatio >= .97
    && pixels.navigationAlphaMaskMatchRate >= .99 && pixels.navigationInteriorColorMatchRate >= .95;
  const verify = async label => {
    const s = await ready();
    for (const layer of s.enabled) {
      const projection = s.results.layers[layer].projection;
      const request = { schemaVersion: 1, sessionId: s.metadata.sessionId, layer, resolution: s.resolution, scope: s.scope };
      // Every UI case is checked against a separate actual bridge call; built smoke also checks the pure projector.
      const bridge = await evaluate(`window.cs2Analyst.heatmap.getGrid(${JSON.stringify(request)})`);
      assert.equal(bridge.kind, 'success'); assert.deepEqual(projection, bridge.projection, label + ' UI/IPC');
      if (direct) assert.deepEqual(projection, direct(request), label + ' UI/pure projection');
      metrics.cases.push({ label, layer, resolution: s.resolution, scope: s.scope, hash: jsonHash(projection),
        count: projection[layer].grid.aggregatedSamples });
    }
    return s;
  };
  const shot = async name => { if (qaDir) { const result = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); writeFileSync(join(qaDir, name + '.png'), Buffer.from(result.data, 'base64')); } };
  const radarComparisonImages = async name => {
    if (!qaDir) return;
    const images = await evaluate(`(() => {
      const canvas = document.querySelector('#heatmap-panel canvas'), reference = document.createElement('canvas');
      reference.width = canvas.width; reference.height = canvas.height;
      const context = reference.getContext('2d'), data = context.createImageData(reference.width, reference.height);
      data.data.set(window.__qaRadarBaseData); context.putImageData(data, 0, 0);
      return { actual: canvas.toDataURL('image/png'), reference: reference.toDataURL('image/png') };
    })()`);
    for (const [suffix, dataUrl] of Object.entries(images)) writeFileSync(join(qaDir, name + '-' + suffix + '.png'), Buffer.from(dataUrl.split(',')[1], 'base64'));
  };
  assert.equal(await evaluate(`document.querySelectorAll('[data-app-sidebar] [role=tab]').length`), 6);
  const panels = await evaluate(`(() => {
    const top = [...document.querySelectorAll('[role=tabpanel]')].filter(p => !p.parentElement.closest('[role=tabpanel]'));
    return top.map(p => ({ id: p.id, tab: document.getElementById(p.getAttribute('aria-labelledby'))?.getAttribute('aria-controls') }));
  })()`);
  assert.deepEqual(panels.map(p => p.id).sort(),
    ['analysis-panel', 'deep-review-panel', 'heatmap-panel', 'replay-panel', 'report-panel', 'timeline-panel'],
    'six first-level panels remain present alongside the nested Analysis/Deep Review panels');
  for (const panel of panels) assert.equal(panel.tab, panel.id, 'first-level Tab must control its panel');
  const start = performance.now();
  await evaluate(`document.getElementById('replay-tab').focus()`);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
  assert.equal(await evaluate(`document.activeElement.id`), 'heatmap-tab', 'sixth tab participates in existing keyboard navigation');
  await evaluate(`document.getElementById('heatmap-tab').click()`);
  await settleUi(evaluate, 'heatmap initial layout');
  assert.deepEqual((await snapshot()).enabled, ['positions'], 'position density is on by default when its source is available');
  assert.equal(await evaluate(`document.querySelectorAll('#heatmap-panel button[aria-pressed=true]').length`), 1);
  assert.equal(await evaluate(`document.querySelectorAll('#heatmap-panel button[aria-pressed=false]').length`), 2, 'kill/death layers stay off');
  await ready();
  await wait(() => evaluate(`document.querySelector('#heatmap-panel canvas').width>1`), 'radar backing size');
  // A decoded image must really have been painted, even before the guidance overlay is dismissed.
  await wait(async () => (await evaluate(pixelExpression)).opaque > 0, 'actual radar pixels');
  metrics.firstDisplayMs = performance.now() - start;
  await memory('base-only');
  const targetPlayer = await evaluate(`document.querySelector('[aria-label="目标玩家"]').textContent`);
  const mapBadge = await evaluate(`document.getElementById('heatmap-panel').innerText`);
  assert.ok(mapBadge.includes('地图版本未确认')); assert.equal(mapBadge.includes('仅示意'), false, 'the shortened label is authoritative');
  let base;
  for (const [layer, label] of [['positions', '玩家位置密度'], ['kills', '击杀位置'], ['deaths', '死亡位置']]) {
    if (layer === 'positions') {
      await evaluate(`document.querySelector('#heatmap-panel button[aria-label="玩家位置密度"]').click()`);
      await settleUi(evaluate, 'default position off for pixel baseline');
      base = await evaluate(pixelExpression);
    }
    await evaluate(`(() => {const c=document.querySelector('#heatmap-panel canvas');window.__qaRadarPixels=c.getContext('2d').getImageData(0,0,c.width,c.height);})()`);
    const began = performance.now();
    if (layer === 'positions') {
      await evaluate(`document.querySelector('#heatmap-panel button[aria-label="玩家位置密度"]').focus()`);
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', windowsVirtualKeyCode: 13 });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    } else await evaluate(`document.querySelector('#heatmap-panel button[aria-label=${JSON.stringify(label)}]').click()`);
    await ready(); await painted();
    const uiObservedMs = performance.now() - began;
    const s = await verify('single-' + layer);
    await settleUi(evaluate, 'layer pixels');
    const pixels = await evaluate(pixelExpression);
    assert.notEqual(pixels.hash, base.hash, layer + ' must change actual pixels');
    const composite = await evaluate(`(() => {const s=${heatmapSnapshotExpression},p=s.results.layers[${JSON.stringify(layer)}].projection,c=document.querySelector('#heatmap-panel canvas'),a=c.getContext('2d').getImageData(0,0,c.width,c.height).data,b=window.__qaRadarPixels.data,color=getComputedStyle(document.querySelector('[data-heatmap-stats=${layer}]').firstElementChild).color.match(/[0-9.]+/g).slice(0,3).map(Number);let checked=0,matched=0;for(const cell of p[${JSON.stringify(layer)}].grid.cells){if(!cell.cellSampleCount||cell.intensity<.1)continue;const n=p.grid.resolution,x=Math.floor((cell.index%n+.5)*c.width/n),y=Math.floor((Math.floor(cell.index/n)+.5)*c.height/n),i=(y*c.width+x)*4,alpha=cell.intensity*.8,ba=b[i+3]/255,oa=alpha+ba*(1-alpha);const expected=color.map((v,k)=>(v*alpha+b[i+k]*ba*(1-alpha))/oa);checked++;if(expected.every((v,k)=>Math.abs(v-a[i+k])<=4)&&Math.abs(oa*255-a[i+3])<=2)matched++;}delete window.__qaRadarPixels;return {checked,matched};})()`);
    assert.ok(composite.checked > 0 && composite.matched / composite.checked >= .95, `${layer} cell-center source-over pixels ${JSON.stringify(composite)}`);
    metrics.cases.at(-1).pixelComposite = composite;
    metrics.cases.at(-1).uiObservedMs = uiObservedMs;
    metrics.cases.at(-1).qaParityFlowMs = performance.now() - began;
    if (expectedDust2) {
      if (layer === 'positions') assert.equal(s.results.layers[layer].projection.positions.observations.validPositionSamples, 178514);
      else { assert.equal(s.results.layers[layer].projection[layer].scopeEvents, 162); assert.equal(s.results.layers[layer].projection[layer].locatableEvents, layer === 'kills' ? 161 : 162); }
    }
    if (layer === 'positions') await memory('single-position');
    await evaluate(`document.querySelector('#heatmap-panel button[aria-label=${JSON.stringify(label)}]').click()`);
    await settleUi(evaluate, 'layer off');
    assert.notEqual((await evaluate(pixelExpression)).hash, pixels.hash, 'switch off changes the painted layer back to the radar');
  }
  await evaluate(`document.querySelectorAll('#heatmap-panel button[aria-pressed]').forEach(b=>b.click())`);
  await verify('three-layers'); await memory('three-layers');
  // All pair combinations, with all existing layer statistics still checked against IPC.
  for (const label of ['玩家位置密度', '击杀位置', '死亡位置']) {
    await evaluate(`document.querySelector('#heatmap-panel button[aria-label=${JSON.stringify(label)}]').click()`);
    await verify('pair-without-' + label);
    await evaluate(`document.querySelector('#heatmap-panel button[aria-label=${JSON.stringify(label)}]').click()`); await ready();
  }
  for (const n of [16, 32, 64]) { await choose('分辨率', n); await verify('resolution-' + n); }
  const meta = (await snapshot()).metadata;
  for (const [name, value, reset] of [['玩家', meta.playerIds[0], ''], ['阵营', 'CT', 'all'], ['阵营', 'T', 'all'], ['回合', meta.rounds[0], ''], ['楼层', meta.floors[0], ''], ['采样集', 'uniform-8hz', 'all-valid']]) {
    const began = performance.now(); await choose(name, value); await ready(); await painted();
    const uiObservedMs = performance.now() - began;
    await verify('filter-' + name + '-' + value);
    metrics.cases.at(-1).uiObservedMs = uiObservedMs;
    metrics.cases.at(-1).qaParityFlowMs = performance.now() - began;
    await choose(name, reset);
  }
  await evaluate(`document.querySelector('#heatmap-panel input[type=checkbox]').click()`); await verify('freeze-included');
  await evaluate(`document.querySelector('#heatmap-panel input[type=checkbox]').click()`); await ready();
  await choose('玩家', meta.playerIds[0]); await choose('回合', meta.rounds[0]);
  let zeroEvents = false;
  for (const side of ['CT', 'T']) {
    await choose('阵营', side); const s = await verify('single-player-round-' + side);
    if (s.results.layers.kills.projection.kills.scopeEvents === 0) {
      zeroEvents = true; assert.ok((await evaluate(`document.querySelector('[data-heatmap-stats=kills]').innerText`)).includes('当前筛选范围内没有可统计事件'));
      assert.equal(await evaluate(`document.querySelector('#heatmap-panel button[aria-label="击杀位置"]').disabled`), false);
    }
  }
  assert.ok(zeroEvents, 'real zero-event scope is distinct from an unavailable source');
  await choose('玩家', ''); await choose('回合', ''); await choose('阵营', 'all'); await ready();
  assert.equal(await evaluate(`document.querySelector('[aria-label="目标玩家"]').textContent`), targetPlayer);
  // UI stress uses real IPC. Main's strict cap rejects any overrun; all final states must succeed.
  for (let i = 0; i < 24; i++) await choose('阵营', i === 23 ? 'T' : i % 2 ? 'CT' : 'all');
  await wait(async () => (await snapshot()).scope.side === 'T', 'last rapid filter'); await verify('rapid-last-T');
  await choose('阵营', 'all'); await choose('分辨率', 32); await ready();
  await memory('after-repeated-filters');
  for (const [width, height, dpr] of [[1024, 640, 1], [1024, 640, 2], [1920, 1032, 2], [1920, 1032, 1]]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dpr, mobile: false });
    await settleUi(evaluate, 'heatmap DPR and geometry');
    await wait(() => evaluate(`(() => {const c=document.querySelector('#heatmap-panel canvas'),r=c.getBoundingClientRect();return r.width>0&&c.width===Math.round(r.width*devicePixelRatio);})()`), 'DPR backing store');
    const layout = await evaluate(`(() => {const c=document.querySelector('#heatmap-panel canvas'),r=c.getBoundingClientRect(),h=document.querySelector('[data-heatmap-map]').getBoundingClientRect();return {css:[r.width,r.height],pixels:[c.width,c.height],canvasCount:document.querySelectorAll('#heatmap-panel canvas').length,bytes:c.width*c.height*4,pageOverflow:document.documentElement.scrollWidth>innerWidth||document.documentElement.scrollHeight>innerHeight,contained:r.x>=h.x&&r.right<=h.right+.5&&r.y>=h.y&&r.bottom<=h.bottom+.5,sideOverflow:getComputedStyle(document.querySelector('#heatmap-panel aside')).overflowY};})()`);
    assert.equal(layout.canvasCount, 1); assert.equal(layout.pageOverflow, false); assert.equal(layout.contained, true); assert.equal(layout.css[0], layout.css[1]); assert.equal(layout.sideOverflow, 'auto');
    metrics.layouts.push({ width, height, dpr, ...layout }); await shot(`heatmap-${width}x${height}-dpr${dpr}`);
  }
  await send('Emulation.clearDeviceMetricsOverride');
  // A manual position-layer off must survive Tab leave/return; the default applies only at mount.
  await evaluate(`document.querySelector('#heatmap-panel button[aria-label="玩家位置密度"]').click()`);
  await settleUi(evaluate, 'manual position off');
  assert.equal((await snapshot()).enabled.includes('positions'), false);
  for (let i = 0; i < 5; i++) {
    await evaluate(`document.getElementById('report-tab').click()`); await settleUi(evaluate, 'hidden map');
    await evaluate(`document.getElementById('heatmap-tab').click()`); await settleUi(evaluate, 'map return');
    assert.equal((await snapshot()).enabled.includes('positions'), false, 'tab return must not re-enable a user-closed position layer');
    assert.ok((await evaluate(pixelExpression)).opaque > 0);
  }
  await evaluate(`document.querySelector('#heatmap-panel button[aria-label="玩家位置密度"]').click()`); await ready();
  await memory('after-tab-returns');
  // All layers off: compare stable full-map samples to an independent image and observe overlay draw calls.
  await settleUi(evaluate, 'settle before all-off draw observation'); await painted();
  await evaluate(`document.querySelectorAll('#heatmap-panel button[aria-pressed=true]').forEach(b=>b.click())`);
  await settleUi(evaluate, 'all layers off'); await painted();
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('#heatmap-panel button[aria-pressed]')].map(b=>b.getAttribute('aria-pressed'))`), ['false', 'false', 'false']);
  await evaluate(`(() => {const canvas=document.querySelector('#heatmap-panel canvas'),proto=CanvasRenderingContext2D.prototype,original=proto.fillRect;window.__qaHeatmapFillRects=0;window.__qaRestoreHeatmapFillRect=()=>{proto.fillRect=original;delete window.__qaRestoreHeatmapFillRect;};proto.fillRect=function(...args){if(this.canvas===canvas)window.__qaHeatmapFillRects++;return original.apply(this,args);};window.dispatchEvent(new Event('resize'));})()`);
  await painted();
  const radarReference = await evaluate(radarReferenceExpression(radarMapDataUrl));
  assert.ok(radarReference.opaque > 0, 'independent base map reference must contain painted radar pixels');
  const allOffPixels = await wait(async () => {
    const pixels = await evaluate(baseComparisonExpression);
    return matchesRadarBaseline(pixels) ? pixels : null;
  }, 'all-off base map paint');
  const allOffOverlayFillRects = await evaluate(`(() => {const count=window.__qaHeatmapFillRects;window.__qaRestoreHeatmapFillRect();delete window.__qaHeatmapFillRects;return count;})()`);
  await shot('heatmap-all-layers-off');
  const baseMapSampleFailure = allOffPixels.alphaMaskMatchRate < .999 || allOffPixels.interiorColorMatchRate < .99 || Math.abs(allOffPixels.opaqueRatio - 1) > .01;
  if (baseMapSampleFailure) await radarComparisonImages('heatmap-all-off-canvas-diagnostic');
  assert.ok(allOffPixels.opaque > 0, 'base map must remain visible when all layers are off');
  assert.equal(allOffOverlayFillRects, 0, 'all-off canvas performs no overlay cell fillRect draws');
  assert.ok(Math.abs(allOffPixels.opaqueRatio - 1) <= .01, `all-off map coverage must match the independent radar within 1% ${JSON.stringify({ radarReference, allOffPixels })}`);
  assert.ok(allOffPixels.alphaMaskMatchRate >= .999, `all-off map silhouette must match at 99.9% of whole-map samples ${JSON.stringify({ radarReference, allOffPixels })}`);
  assert.ok(allOffPixels.interiorColorMatchRate >= .99, `all-off stable map interior samples must match within three RGB levels at 99% ${JSON.stringify({ radarReference, allOffPixels })}`);
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('#heatmap-panel [data-heatmap-stats]')].map(node=>node.getAttribute('data-heatmap-stats'))`), [], 'no position-density or event statistics are rendered with all layers off');
  assert.equal(await evaluate(`document.querySelector('#heatmap-panel canvas').isConnected`), true);
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('#heatmap-panel canvas')).display`), 'block');
  const noticeVisible = await evaluate(`(() => {const notice = document.querySelector('[data-heatmap-map] [role=status]'); return notice ? getComputedStyle(notice).display !== 'none' : false;})()`);
  assert.equal(noticeVisible, false, 'no overlay placeholder when all layers off');
  metrics.baseMap = { reference: radarReference, allOff: { ...allOffPixels, overlayFillRects: allOffOverlayFillRects }, singleLayer: [], afterTabReturn: null };
  // Re-enable each layer on its own. Only its matching projection/statistics may return.
  for (const [layer, label] of [['positions', '玩家位置密度'], ['kills', '击杀位置'], ['deaths', '死亡位置']]) {
    await evaluate(`document.querySelector('#heatmap-panel button[aria-label=${JSON.stringify(label)}]').click()`);
    await ready(); await painted();
    const single = await verify('all-off-single-' + layer);
    assert.deepEqual(single.enabled, [layer], `${layer}: only the selected layer is enabled`);
    assert.deepEqual(await evaluate(`[...document.querySelectorAll('#heatmap-panel [data-heatmap-stats]')].map(node=>node.getAttribute('data-heatmap-stats'))`), [layer], `${layer}: only its statistics are rendered`);
    const visiblePixels = await evaluate(pixelExpression);
    assert.ok(visiblePixels.opaque > 0);
    assert.notEqual(visiblePixels.hash, allOffPixels.hash, `${layer}: data overlay must change the all-off Canvas pixels`);
    const layerCase = metrics.cases.at(-1);
    assert.ok(layerCase.count > 0, `${layer}: projection must contain samples for the visible layer`);
    metrics.baseMap.singleLayer.push({ layer, count: layerCase.count, pixels: visiblePixels, enabled: single.enabled });
    await evaluate(`document.querySelector('#heatmap-panel button[aria-label=${JSON.stringify(label)}]').click()`);
    await settleUi(evaluate, `${layer} off after all-off single-layer check`); await painted();
    assert.deepEqual((await snapshot()).enabled, [], `${layer}: closing it returns to the all-off state`);
    const restored = await wait(async () => {
      const pixels = await evaluate(baseComparisonExpression);
      return matchesRadarBaseline(pixels) ? pixels : null;
    }, `${layer} base-map restoration`);
    assert.ok(Math.abs(restored.opaqueRatio - 1) <= .01 && restored.alphaMaskMatchRate >= .999 && restored.interiorColorMatchRate >= .99,
      `${layer}: closing the single layer restores the independent radar image ${JSON.stringify(restored)}`);
    assert.deepEqual(await evaluate(`[...document.querySelectorAll('#heatmap-panel [data-heatmap-stats]')].map(node=>node.getAttribute('data-heatmap-stats'))`), []);
    metrics.baseMap.singleLayer.at(-1).restored = restored;
  }
  // Navigate away and return: all-off state persists.
  await evaluate(`document.getElementById('report-tab').click()`); await settleUi(evaluate, 'leave all-off');
  await evaluate(`document.getElementById('heatmap-tab').click()`); await settleUi(evaluate, 'return to all-off');
  assert.deepEqual((await snapshot()).enabled, [], 'all-off state must survive tab navigation');
  await painted();
  const returnBeforeSettledSample = await evaluate(baseComparisonExpression);
  let returnPixels;
  try {
    returnPixels = await wait(async () => {
      const pixels = await evaluate(baseComparisonExpression);
      return matchesNavigationRadar(pixels) ? pixels : null;
    }, 'base-map repaint after tab return');
  } catch (error) {
    await radarComparisonImages('heatmap-all-off-after-tab-return-diagnostic');
    const canvasState = await evaluate(`(() => {const c=document.querySelector('#heatmap-panel canvas'),r=c.getBoundingClientRect(),h=document.querySelector('[data-heatmap-map]').getBoundingClientRect(),p=document.getElementById('heatmap-panel');return {backing:[c.width,c.height],canvasRect:[r.x,r.y,r.width,r.height],hostRect:[h.x,h.y,h.width,h.height],panelHidden:p.hidden,panelRect:(()=>{const q=p.getBoundingClientRect();return [q.x,q.y,q.width,q.height]})(),canvasStyle:{width:c.style.width,height:c.style.height,display:getComputedStyle(c).display,visibility:getComputedStyle(c).visibility},activeTab:document.querySelector('[role=tab][aria-selected=true]')?.id,componentActive:${heatmapSnapshotExpression}.active,devicePixelRatio,notice:document.querySelector('[data-heatmap-map] [role=status]')?.innerText??null};})()`);
    error.message += `; canvasState=${JSON.stringify({ returnBeforeSettledSample, canvasState })}`;
    throw error;
  }
  assert.ok(returnPixels.opaque > 0, 'base map still visible after tab return');
  assert.ok(matchesNavigationRadar(returnPixels), `tab return must preserve the independent radar silhouette and stable interior samples ${JSON.stringify(returnPixels)}`);
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('#heatmap-panel [data-heatmap-stats]')].map(node=>node.getAttribute('data-heatmap-stats'))`), [], 'tab return must not restore data overlays');
  metrics.baseMap.afterTabReturn = { ...returnPixels, beforeSettledSample: returnBeforeSettledSample };
  await shot('heatmap-all-layers-off-after-tab-return');
  await evaluate(`delete window.__qaRadarBaseData;delete window.__qaRadarBaseOpaque`);
  await evaluate(`document.querySelector('#heatmap-panel button[aria-label="玩家位置密度"]').click()`); await ready();
  await memory('after-all-layers-off-checks');
  await evaluate(`window.cs2Analyst.window.toggleMaximize()`); await settleUi(evaluate, 'native maximize heatmap');
  assert.ok((await evaluate(pixelExpression)).opaque > 0);
  await evaluate(`window.cs2Analyst.window.toggleMaximize()`); await settleUi(evaluate, 'native restore heatmap');
  if (full) {
    await evaluate(`(() => {const c=document.querySelector('#heatmap-panel canvas'),ctx=c.getContext('2d'),alpha=Object.getOwnPropertyDescriptor(CanvasRenderingContext2D.prototype,'globalAlpha'),transform=ctx.setTransform,draw=ctx.drawImage;let start=0,painted=false;window.__qaDrawTimes=[];ctx.setTransform=function(...args){start=performance.now();painted=false;return transform.apply(this,args);};ctx.drawImage=function(...args){painted=true;return draw.apply(this,args);};Object.defineProperty(ctx,'globalAlpha',{configurable:true,get(){return alpha.get.call(this);},set(value){alpha.set.call(this,value);if(value===1&&painted){window.__qaDrawTimes.push(performance.now()-start);painted=false;}}});window.__qaRestoreCanvas=()=>{delete ctx.globalAlpha;ctx.setTransform=transform;ctx.drawImage=draw;};})()`);
    await withCleanup(async () => {
      for (const n of [16, 32, 64]) {
        await choose('分辨率', n); await ready(); await settleUi(evaluate, 'benchmark DTO ready');
        await evaluate(`window.__qaDrawTimes=[]`);
        for (let i = 0; i < 60; i++) { await evaluate(`window.dispatchEvent(new Event('resize'))`); await wait(() => evaluate(`window.__qaDrawTimes.length>${i}`), 'actual draw sample'); }
        const values = await evaluate(`window.__qaDrawTimes.slice(0,60)`), sorted = values.toSorted((a, b) => a - b);
        metrics.draws.push({ resolution: n, samples: values.length, medianMs: sorted[30], p95Ms: sorted[57], maxMs: sorted.at(-1) });
      }
    }, [() => evaluate(`window.__qaRestoreCanvas();delete window.__qaRestoreCanvas;delete window.__qaDrawTimes`)]);
  }
  // QA-only metadata faults on the actual report; restore before leaving the test.
  await evaluate(`window.__qaHeatmapReport=${readReport};window.__qaHeatmapOriginal=window.__qaHeatmapReport.heatmap;`);
  const refresh = async () => { await evaluate(`document.getElementById('report-tab').click()`); await settleUi(evaluate, 'fault refresh away'); await evaluate(`document.getElementById('heatmap-tab').click()`); await settleUi(evaluate, 'fault refresh return'); };
  await withCleanup(async () => {
    for (const [layer, reason, text] of [['positions', 'replay-unavailable', '位置回放源不可用'], ['kills', 'spatial-unavailable', '精确事件位置源不可用']]) {
      await evaluate(`window.__qaHeatmapReport.heatmap={...window.__qaHeatmapOriginal,layers:{...window.__qaHeatmapOriginal.layers,${layer}:{available:false,unavailableReason:${JSON.stringify(reason)}}}}`); await refresh();
      assert.ok((await evaluate(`document.getElementById('heatmap-panel').innerText`)).includes(text));
      assert.equal(await evaluate(`document.querySelector('#heatmap-panel button[aria-label="死亡位置"]').disabled`), false);
    }
    await evaluate(`window.__qaHeatmapReport.heatmap={...window.__qaHeatmapOriginal,available:false,unavailableReason:'session-ended',layers:Object.fromEntries(['positions','kills','deaths'].map(l=>[l,{available:false,unavailableReason:'session-ended'}]))}`); await refresh();
    assert.equal(await evaluate(`document.querySelectorAll('#heatmap-panel button[aria-pressed][disabled]').length`), 3);
    assert.ok((await evaluate(`document.getElementById('heatmap-panel').innerText`)).includes('分析会话已结束'));
    await evaluate(`window.__qaHeatmapReport.heatmap={...window.__qaHeatmapOriginal,map:{...window.__qaHeatmapOriginal.map,resourceId:'missing-qa-map'}}`); await refresh();
    assert.ok((await evaluate(`document.getElementById('heatmap-panel').innerText`)).includes('地图映射或底图不可用'));
    await evaluate(`window.__qaOriginalImage=window.Image;window.Image=class extends window.__qaOriginalImage{set src(value){super.src=value?value+'.missing-qa':'';}get src(){return super.src;}};window.__qaHeatmapReport.heatmap=window.__qaHeatmapOriginal;`); await refresh();
    // The image failure is only observable with an enabled layer that requests the bitmap.
    if (!(await snapshot()).enabled.includes('positions')) await evaluate(`document.querySelector('#heatmap-panel button[aria-label="玩家位置密度"]').click()`);
    await wait(() => evaluate(`document.getElementById('heatmap-panel').innerText.includes('地图图片加载失败')`), 'image failure fallback');
    await ready();
    assert.ok(await evaluate(`document.querySelector('#heatmap-panel [data-heatmap-stats]')!==null`));
  }, [async () => { await evaluate(`if(window.__qaOriginalImage){window.Image=window.__qaOriginalImage;delete window.__qaOriginalImage;}window.__qaHeatmapReport.heatmap={...window.__qaHeatmapOriginal,map:{...window.__qaHeatmapOriginal.map,resourceId:'missing-qa-map'}};`); await refresh(); await evaluate(`window.__qaHeatmapReport.heatmap=window.__qaHeatmapOriginal`); await refresh(); await evaluate(`delete window.__qaHeatmapReport;delete window.__qaHeatmapOriginal`); }]);
  if (!(await snapshot()).enabled.includes('positions')) await evaluate(`document.querySelector('#heatmap-panel button[aria-label="玩家位置密度"]').click()`);
  await ready();
  await verify('restored-after-faults'); await shot('heatmap-final');
  metrics.status = 'PASS';
  return metrics;
}
