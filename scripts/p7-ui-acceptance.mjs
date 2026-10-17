// P7 manual UI acceptance: real built Electron, real dust2 DEM, no product test hooks.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { closeApp, connectCdp, waitFor, withCleanup } from './smoke-runtime.mjs';
import { ProcessScope } from './installed-smoke-lifecycle.mjs';
import { settleUi, waitForUi } from './window-shell-checks.mjs';

const root = fileURLToPath(new URL('../', import.meta.url)), desktop = join(root, 'apps/desktop');
const demo = join(root, '.demo/dust2.dem'), qa = join(root, '.tmp/p7-ui-qa');
mkdirSync(qa, { recursive: true });
assert.ok(existsSync(demo), 'BLOCKED: local .demo/dust2.dem missing; no download/substitute');
assert.equal(statSync(demo).size, 557650967);
const digest = createHash('sha256');
for await (const chunk of createReadStream(demo)) digest.update(chunk);
assert.equal(digest.digest('hex'), 'db90fe85aab023a1d2c8a5996182e6120d98ef494f02a070b17982b235e4958c', 'wrong local Dust2 bytes');
const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const server = createServer();
await new Promise(ok => server.listen(0, '127.0.0.1', ok));
const port = server.address().port;
await new Promise(ok => server.close(ok));
const profilePrefix = join(tmpdir(), 'cs2-analyst-p7-ui-profile-'), profile = mkdtempSync(profilePrefix);
const env = { ...process.env, CS2_ANALYST_DEM_PATH: demo };
delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
const child = spawn(require('electron'), ['.', '--remote-debugging-port=' + port, '--user-data-dir=' + profile,
  '--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows'], {
  cwd: desktop, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
});
const scope = new ProcessScope(), tracked = scope.track(child, 'P7 UI acceptance', Date.now());
let logs = '', page, failure;
child.stdout.on('data', data => { logs += data; }); child.stderr.on('data', data => { logs += data; });
const metrics = { fixture: '.demo/dust2.dem', screenshots: [], checks: [] };
const wait = (probe, label, timeout = 30000) => waitFor(probe, timeout, label, { intervalMs: 50, diagnostics: () => ({ logs: logs.slice(-3000) }) });
try {
  await scope.live();
  const target = await wait(async () => {
    try { return (await (await fetch('http://127.0.0.1:' + port + '/json/list', { signal: AbortSignal.timeout(1000) })).json()).find(t => t.type === 'page'); }
    catch { return null; }
  }, 'CDP page');
  page = await connectCdp(target.webSocketDebuggerUrl);
  const evaluate = page.evaluate;
  const exceptions = [];
  page.socket.addEventListener('message', event => { const message = JSON.parse(event.data); if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params); });
  await page.send('Runtime.enable'); await page.send('Page.enable');
  const shot = async name => {
    const result = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const path = join(qa, name + '.png'); writeFileSync(path, Buffer.from(result.data, 'base64')); metrics.screenshots.push(path); return path;
  };
  await wait(() => evaluate('Boolean(window.cs2Analyst && document.querySelector("main"))'), 'preload/React');
  assert.equal(await evaluate('typeof window.require'), 'undefined');
  await evaluate('document.querySelector("[data-sidebar-import]").click()');
  await wait(() => evaluate('document.querySelector("main").dataset.status === "success"'), 'real import', 120000);
  const report = await evaluate('(() => {const node=document.getElementById("replay-panel");let f=node[Object.keys(node).find(k=>k.startsWith("__reactFiber$"))];while(f&&!f.memoizedProps?.report)f=f.return;return f.memoizedProps.report;})()');
  const meta = report.replay;
  assert.equal(meta.available, true, meta.unavailableReason || 'replay available');
  metrics.session = meta.sessionId; metrics.rounds = meta.rounds.length;

  // Report page: the renamed Findings section and the merged utility card with two tabs.
  await evaluate('document.getElementById("report-tab").click()');
  await settleUi(evaluate, 'report utility tabs');
  const reportText = await evaluate('document.getElementById("report-panel").innerText');
  assert.ok(reportText.includes('简要分析'));
  assert.equal(reportText.includes('基础规则提示'), false);
  const utilityState = await evaluate(`(() => {
    const card = document.querySelector('[data-utility-panel]');
    const selected = document.querySelector('[data-utility-tab][aria-selected="true"]');
    return { selected: selected?.querySelector('.fui-Tab__content')?.textContent ?? selected?.textContent, tabs: [...card.querySelectorAll('[data-utility-tab]')].map(t => t.querySelector('.fui-Tab__content')?.textContent ?? t.textContent),
      rows: [...card.querySelectorAll('[data-utility-row]')].map(r => [r.dataset.utilityRow, r.querySelector('[data-utility-row-value]').textContent]),
      text: card.innerText };
  })()`);
  assert.equal(utilityState.selected, '投掷统计');
  assert.deepEqual(utilityState.tabs, ['投掷统计', '伤害统计']);
  assert.deepEqual(utilityState.rows.map(([label]) => label), ['闪光弹', '烟雾弹', '高爆手雷', '燃烧弹', '诱饵弹']);
  assert.equal(utilityState.text.includes('燃烧瓶'), false, 'incendiary and molotov merge into one row');
  assert.equal(utilityState.text.includes('投掷数量'), false);
  await evaluate('document.querySelector("[data-utility-tab=damage]").click()');
  await settleUi(evaluate, 'utility damage tab');
  const damageState = await evaluate(`(() => {
    const card = document.querySelector('[data-utility-panel]');
    const selected = document.querySelector('[data-utility-tab][aria-selected="true"]');
    return { selected: selected?.querySelector('.fui-Tab__content')?.textContent ?? selected?.textContent,
      rows: [...card.querySelectorAll('[data-utility-row]')].map(r => [r.dataset.utilityRow, r.querySelector('[data-utility-row-value]').textContent]),
      text: card.innerText };
  })()`);
  assert.equal(damageState.selected, '伤害统计');
  assert.deepEqual(damageState.rows.map(([label]) => label), ['闪光弹', '烟雾弹', '高爆手雷', '燃烧弹', '诱饵弹']);
  assert.match(damageState.rows.find(([label]) => label === '闪光弹')[1], /^\d+\/\d+\/\d+$/, 'flash composite is enemy/team/assist');
  assert.equal(damageState.rows.find(([label]) => label === '烟雾弹')[1], '-');
  assert.equal(damageState.rows.find(([label]) => label === '诱饵弹')[1], '-');
  assert.ok(damageState.rows.find(([label]) => label === '高爆手雷')[1].includes('点'));
  assert.ok(damageState.rows.find(([label]) => label === '燃烧弹')[1].includes('点'));
  await shot('p7-report-damage-tab');
  await evaluate('document.querySelector("[data-utility-flash]").focus()');
  await wait(() => evaluate('[...document.querySelectorAll("[role=tooltip]")].some(t => t.textContent.includes("致盲敌人") && t.textContent.includes("闪光助攻"))'), 'flash value tooltip', 10000);
  await evaluate('document.querySelector("[aria-label=道具面板说明]").focus()');
  await wait(() => evaluate('[...document.querySelectorAll("[role=tooltip]")].some(t => t.textContent.includes("受闪次数") && t.textContent.includes("有效闪光次数"))'), 'utility help tooltip', 10000);
  await evaluate('document.querySelector("[data-utility-tab=throws]").click()');
  await settleUi(evaluate, 'utility throws tab return');
  assert.equal(await evaluate('document.querySelector("[data-utility-tab][aria-selected=true] .fui-Tab__content").textContent'), '投掷统计');
  await shot('p7-report-default');

  // Timeline: the panel itself never scrolls; only the round list inside the card does.
  await evaluate('document.getElementById("timeline-tab").click()');
  await settleUi(evaluate, 'timeline internal scroll');
  const timelineState = await evaluate(`(() => {
    const panel = document.getElementById('timeline-panel');
    const list = document.querySelector('[data-timeline-list]');
    return { panelOverflow: panel.scrollHeight - panel.clientHeight, panelStyle: getComputedStyle(panel).overflowY,
      listOverflow: list.scrollHeight - list.clientHeight, listStyle: getComputedStyle(list).overflowY,
      rows: document.querySelectorAll('[data-round-summary]').length,
      text: panel.innerText };
  })()`);
  assert.ok(timelineState.panelOverflow <= 1, 'timeline panel has no view-level scroll');
  assert.equal(timelineState.listStyle, 'auto');
  assert.ok(timelineState.listOverflow > 0, '24 rounds scroll inside the card');
  assert.equal(timelineState.rows, 24);
  assert.ok(timelineState.text.includes('回合时间线') && timelineState.text.includes('时间'));
  assert.ok(await evaluate('document.documentElement.scrollHeight-innerHeight<=1'));
  await shot('p7-timeline-default');

  await evaluate('document.getElementById("replay-tab").click()');

  await wait(() => evaluate('document.querySelector("[data-replay-session]")?.dataset.replayMapReady==="true" && Number(document.querySelector("[data-replay-session]")?.dataset.replayRevision)>0'), 'replay first frame');
  await settleUi(evaluate, 'replay initial');

  const replayBodyText = await evaluate('document.getElementById("replay-panel").innerText');
  assert.equal(replayBodyText.includes('最近炸弹'), false, 'player status no longer repeats the bomb line');
  assert.equal(replayBodyText.includes('仅显示当前播放进度已到达的事件。'), false, 'key-event explanation moved into its help tooltip');
  const panes = await evaluate(`(() => {
    const panel = document.getElementById('replay-panel');
    const map = document.querySelector('[data-replay-map]').getBoundingClientRect();
    const transport = document.querySelector('[data-replay-transport]');
    const t = transport.getBoundingClientRect();
    const rail = document.querySelector('[data-replay-rail]').getBoundingClientRect();
    return { map: [map.left, map.right, map.bottom], transport: [t.left, t.right, t.top, t.bottom],
      railLeft: rail.left, panelBottom: panel.getBoundingClientRect().bottom,
      inLeft: transport.parentElement.hasAttribute('data-replay-left'),
      overflow: panel.scrollHeight - panel.clientHeight };
  })()`);
  assert.equal(panes.inLeft, true, 'transport stays inside the left map column');
  assert.ok(Math.abs(panes.map[0] - panes.transport[0]) <= 1, 'transport left edge aligns with the map container');
  assert.ok(Math.abs(panes.map[1] - panes.transport[1]) <= 1, 'transport right edge aligns with the map container');
  assert.ok(panes.transport[2] >= panes.map[2] - 1 && panes.transport[3] <= panes.panelBottom + 1, 'transport sits below the map inside the panel');
  assert.ok(panes.transport[1] < panes.railLeft, 'the rail is an independent right column');
  assert.ok(panes.overflow <= 1, 'the replay panel has no page-level overflow');

  const labels = await evaluate('document.getElementById("replay-panel").innerText');
  assert.ok(labels.includes('比赛回放')); assert.equal(labels.includes('地图回放'), false);
  assert.ok(labels.includes('地图版本未确认')); assert.equal(labels.includes('仅示意'), false);
  assert.equal(await evaluate('document.querySelector("[aria-label=地图说明]") !== null'), true);
  await evaluate('document.querySelector("[aria-label=地图说明]").focus()');
  assert.equal(await evaluate('document.activeElement?.getAttribute("aria-label")==="地图说明"'), true, 'keyboard focus reaches the map info icon');
  await wait(() => evaluate('[...document.querySelectorAll("[role=tooltip]")].some(t=>t.textContent.includes("全局比赛观察视角"))'), 'map info focus tooltip', 10000);
  assert.ok(await evaluate('[...document.querySelectorAll("[role=tooltip]")].some(t=>t.textContent.includes("白框为选中玩家"))'));
  await evaluate('document.activeElement.blur()');
  const infoRect = await evaluate('(() => {const r=document.querySelector("[aria-label=地图说明]").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()');
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: infoRect.x, y: infoRect.y });
  await wait(() => evaluate('[...document.querySelectorAll("[role=tooltip]")].some(t=>t.textContent.includes("全局比赛观察视角"))'), 'map info hover tooltip', 10000);
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 4 });
  await wait(() => evaluate('![...document.querySelectorAll("[role=tooltip]")].some(t=>t.checkVisibility()&&t.textContent.includes("全局比赛观察视角"))'), 'map info hover closes', 5000);
  await evaluate('document.querySelector("[aria-label=关键事件说明]").focus()');
  await wait(() => evaluate('[...document.querySelectorAll("[role=tooltip]")].some(t => t.textContent.includes("仅显示当前播放进度已到达的事件") && t.textContent.includes("同 tick"))'), 'key-event help tooltip', 10000);
  await evaluate('document.activeElement.blur()');
  metrics.checks.push('naming + map label + map info tooltip + key-event help');

  const switchState = await evaluate('(() => {const s=document.querySelector("[role=switch]");return {checked:s.checked, label:s.parentElement.innerText};})()');
  assert.equal(switchState.checked, true); assert.ok(switchState.label.includes('连续播放'));

  await evaluate('document.querySelector("[aria-label=回放回合]").click()');
  await waitForUi(evaluate, 'Boolean([...document.querySelectorAll("[role=listbox]")].at(-1)?.querySelector("[role=option]"))', 'round menu open');
  const menu = await evaluate('(() => {const box=[...document.querySelectorAll("[role=listbox]")].at(-1),r=box.getBoundingClientRect(),selected=box.querySelector("[aria-selected=true]"),sr=selected?.getBoundingClientRect();return {height:r.height,top:r.top,bottom:r.bottom,viewport:innerHeight,scrollHeight:box.scrollHeight,clientHeight:box.clientHeight,overflow:getComputedStyle(box).overflowY,maxHeight:getComputedStyle(box).maxHeight,inline:box.getAttribute("style"),options:box.querySelectorAll("[role=option]").length,selectedVisible:Boolean(sr&&sr.top>=r.top-1&&sr.bottom<=r.bottom+1)};})()');
  assert.equal(menu.options, meta.rounds.length); assert.ok(menu.options >= 20, 'dust2 exposes a long round list');
  assert.ok(menu.height <= 320.5); assert.ok(menu.top >= -1 && menu.bottom <= menu.viewport + 1);
  assert.equal(menu.overflow, 'auto'); assert.ok(menu.scrollHeight > menu.clientHeight); assert.equal(menu.selectedVisible, true);
  await shot('p7-round-menu-320');
  await evaluate('document.querySelector("[aria-label=回放回合]").focus()');
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await waitForUi(evaluate, '(() => {const b=document.querySelector("[role=listbox]");return !b || !b.checkVisibility();})()', 'round menu escape');
  metrics.checks.push('round menu height/scroll/selected/escape');

  const targetBefore = (await evaluate('document.querySelector("[aria-label=目标玩家]").textContent')).trim();
  await evaluate('document.querySelector("[aria-label=回放玩家状态] button:nth-child(3)").click()');
  assert.equal(await evaluate('document.querySelector("[aria-label=回放玩家状态] button:nth-child(3)").getAttribute("aria-pressed")'), 'true');
  assert.equal((await evaluate('document.querySelector("[aria-label=目标玩家]").textContent')).trim(), targetBefore);
  await evaluate('document.getElementById("report-tab").click();document.getElementById("replay-tab").click()');
  await waitForUi(evaluate, 'document.getElementById("replay-panel").checkVisibility()', 'replay tab return');
  assert.equal(await evaluate('document.querySelector("[aria-label=回放玩家状态] button:nth-child(3)").getAttribute("aria-pressed")'), 'true');
  await evaluate('document.querySelector("[aria-label=目标玩家]").click()');
  await waitForUi(evaluate, 'document.querySelectorAll("[role=option]").length>0', 'target options');
  const changed = await evaluate('(() => {const box=[...document.querySelectorAll("[role=listbox]")].filter(b=>b.checkVisibility()).at(-1);const option=[...box.querySelectorAll("[role=option]")].find(o=>o.textContent.trim()!==' + JSON.stringify(targetBefore) + ');if(!option)return null;option.click();return option.textContent.trim();})()');
  assert.ok(changed);
  await waitForUi(evaluate, 'document.querySelector("[aria-label=目标玩家]").textContent.trim()===' + JSON.stringify(changed), 'target changed');
  await evaluate('document.getElementById("replay-tab").click()');
  await waitForUi(evaluate, 'document.getElementById("replay-panel").checkVisibility()', 'replay after external target');
  assert.equal(await evaluate('document.querySelector("[aria-label=回放玩家状态] button:nth-child(3)").getAttribute("aria-pressed")'), 'true');
  metrics.checks.push('replay player selection independent');

  const play = 'document.querySelector("[aria-label=播放回放]")', pause = 'document.querySelector("[aria-label=暂停回放]")';
  const playWidth = await evaluate(play + '.getBoundingClientRect().width');
  assert.ok(await evaluate(play + '.querySelector("svg") !== null'));
  assert.equal((await evaluate(play + '.textContent')).trim(), '');
  await evaluate(play + '.click()');
  await waitForUi(evaluate, 'document.querySelector("[aria-label=暂停回放]") !== null', 'pause label');
  const pauseWidth = await evaluate(pause + '.getBoundingClientRect().width');
  assert.ok(Math.abs(playWidth - pauseWidth) <= 1, 'play/pause button width is stable');
  assert.ok(await evaluate(pause + '.querySelector("svg") !== null'));
  assert.equal((await evaluate(pause + '.textContent')).trim(), '');
  await evaluate(pause + '.click()');
  await waitForUi(evaluate, 'document.querySelector("[aria-label=播放回放]") !== null', 'play label after pause');
  assert.ok(Math.abs(await evaluate(play + '.getBoundingClientRect().width') - playWidth) <= 1);
  metrics.checks.push('play/pause icon-only, aria label and stable width');

  const seek = async value => {
    const setValue = async next => evaluate('(()=>{const s=document.querySelector("[aria-label=回放进度]");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(s,' + next + ');s.dispatchEvent(new Event("input",{bubbles:true}));})()');
    // A controlled Fluent Slider can suppress an input event when the DOM value already
    // equals the requested target (for example immediately after playback pauses at the
    // round end). Force one nearby value first so the final seek is never a no-op.
    const current = Number(await evaluate('Number(document.querySelector("[aria-label=回放进度]").value)'));
    if (current === value) {
      const bounds = await evaluate('(()=>{const s=document.querySelector("[aria-label=回放进度]");return {min:Number(s.min),max:Number(s.max)};})()');
      const bridge = value > bounds.min ? value - 1 : value < bounds.max ? value + 1 : value;
      if (bridge !== value) { await setValue(bridge); await delay(24); }
    }
    await setValue(value);
    await wait(() => evaluate('Math.abs(Number(document.querySelector("#replay-panel canvas[role=img]").dataset.tick)-' + value + ')<.01'), 'seek ' + value);
  };
  const chooseRound = async round => {
    await evaluate('document.querySelector("[aria-label=回放回合]").click()');
    await waitForUi(evaluate, 'Boolean([...document.querySelectorAll("[role=option]")].find(o=>o.textContent.trim()==="R' + round + '"))', 'round option R' + round);
    await evaluate('[...document.querySelectorAll("[role=option]")].find(o=>o.textContent.trim()==="R' + round + '").click()');
    await wait(() => evaluate('document.querySelector("[data-replay-session]").dataset.replayRound==="' + round + '"'), 'round R' + round + ' selected');
  };
  const setContinuous = async on => {
    const checked = await evaluate('document.querySelector("[role=switch]").checked');
    if (checked !== on) await evaluate('document.querySelector("[role=switch]").click()');
    assert.equal(await evaluate('document.querySelector("[role=switch]").checked'), on);
  };
  const first = meta.rounds[0], second = meta.rounds[1], last = meta.rounds.at(-1);
  await evaluate('document.querySelector("[aria-label=回放倍速]").click()');
  await waitForUi(evaluate, 'Boolean([...document.querySelectorAll("[role=option]")].find(o=>o.textContent.trim()==="2×"))', 'speed option');
  await evaluate('[...document.querySelectorAll("[role=option]")].find(o=>o.textContent.trim()==="2×").click()');
  await waitForUi(evaluate, 'document.querySelector("[aria-label=回放倍速]").textContent.includes("2×")', 'speed 2x');
  await setContinuous(false); await chooseRound(first.round); await seek(first.endTick - 8);
  await evaluate(play + '.click()');
  await waitForUi(evaluate, 'document.querySelector("[aria-label=播放回放]") !== null && document.querySelector("[data-replay-session]").dataset.replayRound==="' + first.round + '"', 'continuous off end');
  assert.ok(Number(await evaluate('document.querySelector("#replay-panel canvas[role=img]").dataset.tick')) >= first.endTick - 1);
  await setContinuous(true); await seek(first.endTick - 8);
  await evaluate(play + '.click()');
  await waitForUi(evaluate, 'document.querySelector("[data-replay-session]").dataset.replayRound==="' + second.round + '" && Number(document.querySelector("#replay-panel canvas[role=img]").dataset.tick)>=' + second.startTick + ' && document.querySelector("[aria-label=暂停回放]") !== null', 'continuous next round');
  assert.ok((await evaluate('document.querySelector("[aria-label=回放倍速]").textContent')).includes('2×'), 'speed survives a round transition');
  await evaluate(pause + '.click()');
  await waitForUi(evaluate, 'document.querySelector("[aria-label=播放回放]") !== null', 'paused after continuous');
  await seek(second.startTick + 10); await evaluate(play + '.click()');
  await wait(() => evaluate('Number(document.querySelector("#replay-panel canvas[role=img]").dataset.tick)>' + (second.startTick + 20)), 'manual pause playback');
  await evaluate(pause + '.click()');
  await waitForUi(evaluate, 'document.querySelector("[aria-label=播放回放]") !== null', 'manual pause');
  const pausedTick = await evaluate('Number(document.querySelector("#replay-panel canvas[role=img]").dataset.tick)');
  await delay(300);
  assert.equal(await evaluate('Number(document.querySelector("#replay-panel canvas[role=img]").dataset.tick)'), pausedTick);
  await chooseRound(last.round); await seek(last.endTick - 8); await evaluate(play + '.click()');
  await waitForUi(evaluate, 'document.querySelector("[aria-label=播放回放]") !== null && document.querySelector("[data-replay-session]").dataset.replayRound==="' + last.round + '"', 'last round stop');
  metrics.checks.push('continuous off/on, manual pause, last-round stop');
  await shot('p7-replay-last-round');

  // Key events: real same-tick rows, cross-chunk accumulation, content-driven height,
  // click/keyboard seek, append auto-scroll, pause, round reset and internal scrolling.
  const roundSnapshots = new Map();
  const readRound = async number => {
    if (roundSnapshots.has(number)) return roundSnapshots.get(number);
    const info = meta.rounds.find(round => round.round === number);
    assert.ok(info && info.blocks.length > 0, 'round ' + number + ' has replay blocks');
    const request = JSON.stringify({ sessionId: meta.sessionId, round: number });
    const chunks = await evaluate('(async () => { const out = []; for (const block of ' + JSON.stringify(info.blocks.map(block => block.index)) +
      ') { const result = await window.cs2Analyst.replay.getChunk({' + request.slice(1, -1) +
      ', block}); out.push({ kind: result.kind, message: result.message ?? null, block, events: result.kind === "success" ? result.chunk.events : [] }); } return out; })()');
    assert.equal(chunks.length, info.blocks.length);
    for (const [index, result] of chunks.entries()) assert.equal(result.kind, 'success', 'replay chunk ' + number + ':' + index + ' available: ' + (result.message ?? ''));
    const events = chunks.flatMap(result => result.events
      .filter(event => !['weapon_fire', 'damage', 'flash'].includes(event.type))
      .map(event => ({ ...event, block: result.block })));
    const snapshot = { info, chunks, events };
    roundSnapshots.set(number, snapshot);
    return snapshot;
  };
  let sameTickPair = null;
  for (const round of meta.rounds.slice(0, 4)) {
    const snapshot = await readRound(round.round);
    const groups = new Map();
    for (const event of snapshot.events) {
      const list = groups.get(event.tick) ?? [];
      list.push(event);
      groups.set(event.tick, list);
    }
    const pair = [...groups.values()].find(list => list.length > 1);
    if (pair) { sameTickPair = { round: round.round, snapshot, tick: pair[0].tick, events: pair }; break; }
  }
  assert.ok(sameTickPair, 'a real round exposes same-tick key events');
  const sameTickIds = sameTickPair.events.map(event => event.id);
  const sameTickBlock = sameTickPair.events[0].block;
  const priorEvent = sameTickPair.snapshot.events.filter(event => event.block < sameTickBlock)
    .sort((a, b) => a.tick - b.tick || a.id.localeCompare(b.id)).at(-1);
  assert.ok(priorEvent, 'a key event precedes the same-tick block for cross-chunk accumulation');
  const laterEvent = sameTickPair.snapshot.events.filter(event => event.tick > sameTickPair.tick)
    .sort((a, b) => a.tick - b.tick || a.id.localeCompare(b.id))[0];
  assert.ok(laterEvent, 'a key event follows the same-tick pair');
  const clickEvent = sameTickPair.snapshot.events.filter(event => event.tick < sameTickPair.tick)
    .sort((a, b) => b.tick - a.tick || a.id.localeCompare(b.id))[0];
  assert.ok(clickEvent, 'an earlier key event exists for the mouse click');
  const keyEvent = sameTickPair.snapshot.events.filter(event => event.tick < clickEvent.tick)
    .sort((a, b) => b.tick - a.tick || a.id.localeCompare(b.id))[0];
  assert.ok(keyEvent, 'an earlier key event exists for keyboard focus');
  const firstSnapshot = await readRound(first.round);
  const populateRoundEvents = async (roundNumber, snapshot, label) => {
    await chooseRound(roundNumber);
    for (const block of snapshot.info.blocks) {
      await seek(block.endTick);
      const expected = snapshot.events.filter(event => event.block <= block.index).length;
      await wait(() => evaluate('Number(document.querySelector("[data-replay-session]").dataset.replayVisibleEvents) >= ' + expected), 'events through block ' + block.index + ' at ' + label, 15000);
    }
    const expected = Math.min(snapshot.events.length, 200);
    assert.equal(await evaluate('Number(document.querySelector("[data-replay-session]").dataset.replayVisibleEvents)'), expected, 'every round event accumulates at ' + label);
    assert.equal(new Set(await visibleEventIds()).size, expected, 'round event accumulation has no duplicates at ' + label);
  };
  const eventNode = id => "document.querySelector('[data-replay-event=" + JSON.stringify(id) + "]')";
  const visibleEventIds = () => evaluate('[...document.querySelectorAll("[data-replay-event]")].map(button => button.dataset.replayEvent)');
  const waitForEvent = (id, label, timeout = 10000) => wait(() => evaluate('Boolean(' + eventNode(id) + ')'), label, timeout);
  const chooseSpeed = async value => {
    await evaluate('document.querySelector("[aria-label=回放倍速]").click()');
    await waitForUi(evaluate, 'Boolean([...document.querySelectorAll("[role=option]")].find(o => o.textContent.trim() === "' + value + '×"))', 'speed option ' + value);
    await evaluate('[...document.querySelectorAll("[role=option]")].find(o => o.textContent.trim() === "' + value + '×").click()');
    await waitForUi(evaluate, 'document.querySelector("[aria-label=回放倍速]").textContent.includes("' + value + '×")', 'speed ' + value);
  };

  await chooseRound(sameTickPair.round);
  await seek(priorEvent.tick);
  await waitForEvent(priorEvent.id, 'event before the same-tick block');
  assert.ok((await visibleEventIds()).includes(priorEvent.id));
  await chooseSpeed(4);
  await evaluate(play + '.click()');
  await wait(() => evaluate('Number(document.querySelector("#replay-panel canvas[role=img]").dataset.tick) >= ' + sameTickPair.tick), 'play across the chunk boundary', 30000);
  await evaluate(pause + '.click()');
  await waitForUi(evaluate, 'document.querySelector("[aria-label=播放回放]") !== null', 'paused across the chunk boundary');
  for (const id of sameTickIds) await waitForEvent(id, 'same-tick event ' + id);
  const accumulatedIds = await visibleEventIds();
  assert.ok(accumulatedIds.includes(priorEvent.id), 'the pre-boundary row survives the chunk switch');
  assert.ok(sameTickIds.every(id => accumulatedIds.includes(id)), 'both same-tick rows append across the chunk switch');
  assert.equal(new Set(accumulatedIds).size, accumulatedIds.length, 'chunk accumulation never duplicates an event id');
  const sameTickTexts = await evaluate(JSON.stringify(sameTickIds) + ".map(id => document.querySelector('[data-replay-event=\"' + id + '\"]').textContent)");
  assert.ok(sameTickTexts.length >= 2);
  assert.equal(new Set(sameTickTexts).size, sameTickTexts.length, 'same-tick rows remain distinct');
  const eventListText = await evaluate('document.querySelector("[aria-label=回放事件浏览]").innerText');
  assert.equal(eventListText.includes('同 tick，顺序未知'), false, 'the removed same-tick marker is absent');
  assert.equal(eventListText.includes('同 tick'), false, 'the event list no longer labels same-tick rows');
  const rowLayout = await evaluate("(() => { const list = document.querySelector('[aria-label=回放事件浏览]'); const rows = [...list.querySelectorAll('[data-replay-event]')].map(row => { const rect = row.getBoundingClientRect(), style = getComputedStyle(row); return { id: row.dataset.replayEvent, top: rect.top, bottom: rect.bottom, height: rect.height, scrollHeight: row.scrollHeight, clientHeight: row.clientHeight, scrollWidth: row.scrollWidth, clientWidth: row.clientWidth, flexShrink: style.flexShrink, whiteSpace: style.whiteSpace, overflowWrap: style.overflowWrap, wordBreak: style.wordBreak, minHeight: style.minHeight, lineHeight: style.lineHeight, paddingTop: style.paddingTop, paddingBottom: style.paddingBottom }; }); return { rows, list: { scrollHeight: list.scrollHeight, clientHeight: list.clientHeight, overflowY: getComputedStyle(list).overflowY } }; })()");
  assert.ok(rowLayout.rows.length >= 2);
  const orderedRows = [...rowLayout.rows].sort((a, b) => a.top - b.top);
  assert.equal(orderedRows.slice(1).filter((row, index) => row.top < orderedRows[index].bottom - 1).length, 0, 'key-event rows never overlap');
  for (const row of rowLayout.rows) {
    assert.equal(row.flexShrink, '0', row.id + ' never shrinks');
    assert.equal(row.whiteSpace, 'normal', row.id + ' can wrap');
    assert.equal(row.overflowWrap, 'anywhere', row.id + ' breaks long words');
    assert.equal(row.minHeight, '32px', row.id + ' keeps a readable minimum height');
    assert.ok(row.height >= 30, row.id + ' grows with its content');
    assert.ok(row.scrollHeight <= row.clientHeight + 1, row.id + ' is not vertically clipped');
    assert.ok(row.scrollWidth <= row.clientWidth + 1, row.id + ' is not horizontally clipped');
    assert.ok(parseFloat(row.paddingTop) >= 4 && parseFloat(row.paddingBottom) >= 4, row.id + ' keeps vertical padding');
  }
  assert.equal(rowLayout.list.overflowY, 'auto');
  assert.ok(rowLayout.list.scrollHeight > rowLayout.list.clientHeight, 'many events scroll inside the card');
  await shot('p7-replay-events');

  const syntheticRows = await evaluate("(() => { const list = document.querySelector('[aria-label=回放事件浏览]'); const sample = list.querySelector('[data-replay-event]'); const cases = [['single', '+0.00 秒 · 短事件'], ['multi', '+1.00 秒 · 多行事件描述需要完整换行显示，包含英文道具名称 Smoke Grenade'], ['long', '+2.00 秒 · ' + 'LongEnglishWeaponNameWithoutSpaces'.repeat(3)]]; const nodes = cases.map(([name, text]) => { const node = sample.cloneNode(true); node.removeAttribute('data-replay-event'); node.dataset.qaEventRow = name; node.textContent = text; list.append(node); return node; }); return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => { const listRect = list.getBoundingClientRect(); const rows = nodes.map(node => { const rect = node.getBoundingClientRect(), style = getComputedStyle(node); return { name: node.dataset.qaEventRow, height: rect.height, top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight, scrollWidth: node.scrollWidth, clientWidth: node.clientWidth, flexShrink: style.flexShrink, whiteSpace: style.whiteSpace, overflowWrap: style.overflowWrap, minHeight: style.minHeight }; }); const ordered = [...list.querySelectorAll('[data-replay-event],[data-qa-event-row]')].map(node => node.getBoundingClientRect()).sort((a, b) => a.top - b.top); resolve({ rows, overlaps: ordered.slice(1).filter((rect, index) => rect.top < ordered[index].bottom - 1).length, listLeft: listRect.left, listRight: listRect.right }); }))); })()");
  const [singleRow, multiRow, longRow] = syntheticRows.rows;
  assert.deepEqual(syntheticRows.rows.map(row => row.name), ['single', 'multi', 'long']);
  assert.ok(multiRow.height >= singleRow.height + 10, 'multi-line text grows the Fluent Button');
  assert.ok(longRow.height >= singleRow.height + 10, 'an unbroken long word wraps and grows the row');
  assert.equal(syntheticRows.overlaps, 0);
  for (const row of syntheticRows.rows) {
    assert.equal(row.flexShrink, '0');
    assert.equal(row.whiteSpace, 'normal');
    assert.equal(row.overflowWrap, 'anywhere');
    assert.equal(row.minHeight, '32px');
    assert.ok(row.scrollHeight <= row.clientHeight + 1, row.name + ' renders every line');
    assert.ok(row.scrollWidth <= row.clientWidth + 1, row.name + ' never breaks the rail width');
    assert.ok(row.left >= syntheticRows.listLeft - 1 && row.right <= syntheticRows.listRight + 1, row.name + ' stays inside the list');
  }
  const scrollSyntheticIntoView = async name => {
    await evaluate('(() => { const list = document.querySelector("[aria-label=回放事件浏览]"); const row = [...list.querySelectorAll("[data-qa-event-row]")].find(node => node.dataset.qaEventRow === "' + name + '"); list.scrollTo({top:Math.max(0, row.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop),behavior:"instant"}); })()');
    await settleUi(evaluate, 'synthetic ' + name + ' scroll');
    const visible = await evaluate('(() => { const list = document.querySelector("[aria-label=回放事件浏览]"); const lr = list.getBoundingClientRect(); const row = [...list.querySelectorAll("[data-qa-event-row]")].find(node => node.dataset.qaEventRow === "' + name + '"); const r = row.getBoundingClientRect(); return r.top >= lr.top - 1 && r.bottom <= lr.bottom + 1; })()');
    assert.equal(visible, true, name + ' row is fully visible in its saved screenshot');
  };
  await scrollSyntheticIntoView('single');
  await shot('p7-replay-events-wrapping');
  await scrollSyntheticIntoView('long');
  await shot('p7-replay-events-overlong');
  await evaluate('document.querySelectorAll("[data-qa-event-row]").forEach(node => node.remove())');

  const denseRows = await evaluate("(() => { const list = document.querySelector('[aria-label=回放事件浏览]'); const sample = list.querySelector('[data-replay-event]'); const nodes = Array.from({ length: 40 }, (_, index) => { const node = sample.cloneNode(true); node.removeAttribute('data-replay-event'); node.dataset.qaEventRow = 'dense'; node.textContent = '+3.' + String(index).padStart(2, '0') + ' 秒 · 追加事件 ' + index + ' ' + '长'.repeat(index % 12); list.append(node); return node; }); return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => { const rows = nodes.map(node => { const rect = node.getBoundingClientRect(), style = getComputedStyle(node); return { top: rect.top, bottom: rect.bottom, height: rect.height, flexShrink: style.flexShrink }; }); const ordered = rows.slice().sort((a, b) => a.top - b.top); list.scrollTop = list.scrollHeight; resolve({ count: rows.length, minHeight: Math.min(...rows.map(row => row.height)), flexShrink: [...new Set(rows.map(row => row.flexShrink))], overlaps: ordered.slice(1).filter((row, index) => row.top < ordered[index].bottom - 1).length, scrollHeight: list.scrollHeight, clientHeight: list.clientHeight, scrollTop: list.scrollTop, maxScrollTop: list.scrollHeight - list.clientHeight }); }))); })()");
  assert.equal(denseRows.count, 40);
  assert.ok(denseRows.minHeight >= 32, 'dense rows keep their content height');
  assert.deepEqual(denseRows.flexShrink, ['0']);
  assert.equal(denseRows.overlaps, 0);
  assert.ok(denseRows.scrollHeight > denseRows.clientHeight, 'the event list scrolls internally');
  assert.ok(denseRows.scrollTop > 0 && denseRows.scrollTop >= denseRows.maxScrollTop - 1, 'the internal list reaches its newest row');
  await evaluate('document.querySelector("[aria-label=回放事件浏览]").scrollTop = 0; document.querySelectorAll("[data-qa-event-row]").forEach(node => node.remove())');
  await evaluate('document.activeElement?.blur()');
  await seek(sameTickPair.tick);
  await wait(() => evaluate('!(' + eventNode(laterEvent.id) + ')'), 'later row trimmed before the append scroll');
  const autoScrollBefore = await evaluate("(() => { const list = document.querySelector('[aria-label=回放事件浏览]'); list.scrollTop = 0; return { top: list.scrollTop, overflow: list.scrollHeight - list.clientHeight }; })()");
  assert.ok(autoScrollBefore.overflow > 0);
  await seek(laterEvent.tick);
  await waitForEvent(laterEvent.id, 'later event appended');
  await wait(() => evaluate('(() => { const list = document.querySelector("[aria-label=回放事件浏览]"); return list.scrollTop >= list.scrollHeight - list.clientHeight - 8; })()'), 'event list auto-scrolls to the newest row', 5000);
  const autoScrollAfter = await evaluate("(() => { const list = document.querySelector('[aria-label=回放事件浏览]'); return { top: list.scrollTop, max: list.scrollHeight - list.clientHeight }; })()");
  assert.ok(autoScrollAfter.top > 5);
  assert.ok(autoScrollAfter.top >= autoScrollAfter.max - 8, 'the append scroll reaches the newest row');

  await evaluate(eventNode(clickEvent.id) + '.click()');
  await wait(() => evaluate('Math.abs(Number(document.querySelector("#replay-panel canvas[role=img]").dataset.tick) - ' + clickEvent.tick + ') < .01'), 'event mouse click seeks');
  const afterClickIds = await visibleEventIds();
  assert.ok(afterClickIds.includes(clickEvent.id));
  assert.equal(afterClickIds.includes(laterEvent.id), false, 'seeking back to an event drops later rows');
  assert.equal(await evaluate('document.querySelector("[aria-label=播放回放]") !== null'), true, 'event click pauses playback');
  await evaluate(eventNode(keyEvent.id) + '.focus()');
  assert.equal(await evaluate('document.activeElement?.dataset.replayEvent'), keyEvent.id);
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', windowsVirtualKeyCode: 13 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await wait(() => evaluate('Math.abs(Number(document.querySelector("#replay-panel canvas[role=img]").dataset.tick) - ' + keyEvent.tick + ') < .01'), 'event keyboard seek');
  const afterKeyIds = await visibleEventIds();
  assert.ok(afterKeyIds.includes(keyEvent.id));
  assert.equal(afterKeyIds.includes(clickEvent.id), false, 'keyboard seek trims later rows');
  await evaluate('document.activeElement?.blur()');
  const pausedCount = await evaluate('Number(document.querySelector("[data-replay-session]").dataset.replayVisibleEvents)');
  await delay(300);
  assert.equal(await evaluate('Number(document.querySelector("[data-replay-session]").dataset.replayVisibleEvents)'), pausedCount, 'pause does not append events');
  await seek(laterEvent.tick);
  await waitForEvent(laterEvent.id, 'forward seek restores a later row');
  const forwardCount = await evaluate('Number(document.querySelector("[data-replay-session]").dataset.replayVisibleEvents)');
  assert.ok(forwardCount >= pausedCount);
  const rail = await evaluate('(() => {const side=document.querySelector("[data-replay-rail]"), groups=side.children, player=groups[0], events=groups[1], list=events.querySelector("[aria-label=回放事件浏览]"), s=side.getBoundingClientRect(), p=player.getBoundingClientRect(), e=events.getBoundingClientRect();return {side:[s.top,s.bottom,s.height],player:[p.top,p.bottom,p.height],events:[e.top,e.bottom,e.height],overflow:getComputedStyle(list).overflowY,pageOverflow:document.documentElement.scrollHeight-innerHeight,listOverflow:list.scrollHeight-list.clientHeight};})()');
  assert.ok(rail.events[2] > 0); assert.ok(rail.events[1] <= rail.side[1] + 1, 'event card fills the remaining rail height');
  assert.equal(rail.overflow, 'auto'); assert.ok(rail.pageOverflow <= 1);
  assert.ok(rail.listOverflow > 0, 'the event list keeps its own scroll');
  await seek(clickEvent.tick);
  const backwardIds = await visibleEventIds();
  assert.equal(backwardIds.includes(laterEvent.id), false, 'backward seek drops later rows');
  assert.ok(backwardIds.length <= forwardCount);
  const otherRound = meta.rounds.find(round => round.round !== sameTickPair.round && round.blocks.length > 0);
  await chooseRound(otherRound.round);
  const switchedIds = await visibleEventIds();
  assert.equal(switchedIds.some(id => accumulatedIds.includes(id)), false, 'round switch clears the previous round key events');
  assert.ok(switchedIds.every(id => id.startsWith('r' + otherRound.round + '-')), 'only the newly selected round keeps key events');
  assert.equal((await evaluate('document.querySelector("[aria-label=回放事件浏览]").innerText')).includes('同 tick'), false);
  await chooseRound(first.round);
  metrics.checks.push('same-tick rows, cross-chunk accumulation, click/keyboard seek, autoscroll, pause, round reset, content height');

  await evaluate('document.getElementById("heatmap-tab").click()');
  await wait(() => evaluate('document.querySelector("[data-heatmap-session]") && document.querySelector("[data-heatmap-session]").dataset.heatmapEnabled==="positions"'), 'heatmap default position layer', 30000);
  assert.equal(await evaluate('document.querySelector("[aria-label=玩家位置密度]").getAttribute("aria-pressed")'), 'true');
  assert.equal(await evaluate('document.querySelector("[aria-label=击杀位置]").getAttribute("aria-pressed")'), 'false');
  assert.equal(await evaluate('document.querySelector("[aria-label=死亡位置]").getAttribute("aria-pressed")'), 'false');
  await evaluate('document.querySelector("[aria-label=玩家位置密度]").click()');
  await settleUi(evaluate, 'position layer off');
  await evaluate('document.getElementById("report-tab").click();document.getElementById("heatmap-tab").click()');
  await settleUi(evaluate, 'heatmap tab return');
  assert.equal(await evaluate('document.querySelector("[aria-label=玩家位置密度]").getAttribute("aria-pressed")'), 'false', 'tab return does not re-enable a manually closed position layer');
  const heatmapText = await evaluate('document.getElementById("heatmap-panel").innerText');
  assert.ok(heatmapText.includes('地图版本未确认')); assert.equal(heatmapText.includes('仅示意'), false);
  await evaluate('document.querySelector("[aria-label=热力图回合]").click()');
  await waitForUi(evaluate, 'Boolean([...document.querySelectorAll("[role=listbox]")].at(-1)?.querySelector("[role=option]"))', 'heatmap round menu');
  const heatmapMenu = await evaluate('(() => {const box=[...document.querySelectorAll("[role=listbox]")].at(-1),r=box.getBoundingClientRect();return {height:r.height,options:box.querySelectorAll("[role=option]").length,overflow:getComputedStyle(box).overflowY,scrollHeight:box.scrollHeight,clientHeight:box.clientHeight};})()');
  assert.ok(heatmapMenu.height <= 320.5); assert.equal(heatmapMenu.overflow, 'auto'); assert.ok(heatmapMenu.options >= 20);
  await evaluate('document.querySelector("[aria-label=热力图回合]").focus()');
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await waitForUi(evaluate, '(() => {const b=document.querySelector("[role=listbox]");return !b || !b.checkVisibility();})()', 'heatmap round menu escape');
  await evaluate('document.querySelector("[aria-label=玩家位置密度]").click()');
  await wait(() => evaluate('Boolean(document.querySelector("[data-heatmap-stats=positions]"))'), 'positions stats after re-enable', 30000);
  await shot('p7-heatmap-default-positions');
  metrics.checks.push('heatmap default positions, tab-return persistence, round menu, label');

  for (const [width, height] of [[1024, 640], [1920, 1032]]) {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await waitForUi(evaluate, 'innerWidth===' + width + ' && innerHeight===' + height, 'viewport ' + width);
    await settleUi(evaluate, 'layout ' + width);
    assert.equal(await evaluate('document.documentElement.scrollHeight-innerHeight <= 1'), true);
    await evaluate('document.getElementById("report-tab").click()');
    await settleUi(evaluate, 'report ' + width);
    assert.equal(await evaluate('document.documentElement.scrollHeight-innerHeight <= 1'), true);
    assert.equal(await evaluate('document.querySelector("[data-utility-tab][aria-selected=true] .fui-Tab__content").textContent'), '投掷统计');
    await shot('p7-report-' + width + 'x' + height);
    await evaluate('document.getElementById("timeline-tab").click()');
    await settleUi(evaluate, 'timeline ' + width);
    const compactTimeline = await evaluate('(() => {const panel=document.getElementById("timeline-panel"),list=document.querySelector("[data-timeline-list]");return {panelOverflow:panel.scrollHeight-panel.clientHeight,listOverflow:list.scrollHeight-list.clientHeight,listStyle:getComputedStyle(list).overflowY,page:document.documentElement.scrollHeight-innerHeight};})()');
    assert.ok(compactTimeline.panelOverflow <= 1, 'timeline panel must not scroll at ' + width + 'x' + height);
    assert.equal(compactTimeline.listStyle, 'auto');
    assert.ok(compactTimeline.listOverflow > 0, 'timeline rounds must scroll inside the card at ' + width + 'x' + height);
    assert.ok(compactTimeline.page <= 1);
    await shot('p7-timeline-' + width + 'x' + height);
    await evaluate('document.getElementById("replay-tab").click()');
    await settleUi(evaluate, 'replay ' + width);
    await populateRoundEvents(first.round, firstSnapshot, width + 'x' + height);
    await settleUi(evaluate, 'replay events ' + width);
    const compact = await evaluate('(() => { const side = document.querySelector("[data-replay-rail]"), groups = side.children, list = groups[1].querySelector("[aria-label=回放事件浏览]"); const rows = [...list.querySelectorAll("[data-replay-event]")].map(row => { const rect = row.getBoundingClientRect(), style = getComputedStyle(row); return { height: rect.height, top: rect.top, bottom: rect.bottom, scrollHeight: row.scrollHeight, clientHeight: row.clientHeight, flexShrink: style.flexShrink }; }); const ordered = rows.slice().sort((a, b) => a.top - b.top); const buttons = [...list.querySelectorAll("[data-replay-event]")]; const sameTickIds = ' + JSON.stringify(sameTickIds) + '; const sameTickRows = sameTickIds.filter(id => buttons.some(button => button.dataset.replayEvent === id)).length; const map = document.querySelector("[data-replay-map]").getBoundingClientRect(), transport = document.querySelector("[data-replay-transport]").getBoundingClientRect(); return { eventsHeight: groups[1].getBoundingClientRect().height, listHeight: list.clientHeight, playerHeight: groups[0].getBoundingClientRect().height, sideHeight: side.getBoundingClientRect().height, playerMax: getComputedStyle(document.querySelector("[aria-label=回放玩家状态]")).maxHeight, playerBottom: groups[0].getBoundingClientRect().bottom, eventsTop: groups[1].getBoundingClientRect().top, map: [map.left, map.right], transport: [transport.left, transport.right], page: document.documentElement.scrollHeight - innerHeight, listOverflow: list.scrollHeight - list.clientHeight, rows, overlaps: ordered.slice(1).filter((row, index) => row.top < ordered[index].bottom - 1).length, sameTickRows, text: list.innerText }; })()');
    assert.ok(compact.eventsHeight >= 90, 'key events card keeps usable height at ' + width + 'x' + height);
    assert.ok(compact.listHeight >= 24, 'key events list keeps a usable scroll viewport at ' + width + 'x' + height);
    assert.ok(compact.listOverflow > 0, 'key events scroll inside the card at ' + width + 'x' + height);
    assert.equal(compact.sameTickRows, sameTickIds.length, 'same-tick rows survive at ' + width + 'x' + height);
    assert.equal(compact.overlaps, 0, 'key-event rows never overlap at ' + width + 'x' + height);
    assert.ok(compact.rows.length >= 2);
    for (const row of compact.rows) {
      assert.equal(row.flexShrink, '0', 'key-event rows never shrink at ' + width + 'x' + height);
      assert.ok(row.height >= 32, 'key-event rows keep their content height at ' + width + 'x' + height);
      assert.ok(row.scrollHeight <= row.clientHeight + 1, 'key-event rows are not clipped at ' + width + 'x' + height);
    }
    assert.equal(compact.text.includes('同 tick'), false);
    assert.ok(compact.playerBottom <= compact.eventsTop + 1);
    assert.ok(Math.abs(compact.map[0] - compact.transport[0]) <= 1 && Math.abs(compact.map[1] - compact.transport[1]) <= 1, 'transport aligns with the map container at ' + width + 'x' + height);
    assert.ok(compact.page <= 1);
    // Appending more native throw rows can leave the normal smooth auto-scroll in flight.
    // Finish it before positioning evidence; geometry-only settleUi does not observe this list.
    await wait(()=>evaluate('(()=>{const l=document.querySelector("[aria-label=回放事件浏览]");return l.scrollTop>=l.scrollHeight-l.clientHeight-1;})()'),'event append scroll completes '+width,5000);
    await evaluate('(() => { const list = document.querySelector("[aria-label=回放事件浏览]"); const ids = ' + JSON.stringify(sameTickIds) + '; const buttons = [...list.querySelectorAll("[data-replay-event]")]; const row = buttons.find(button => button.dataset.replayEvent === ids[0]); if (!row) throw new Error("same-tick row missing"); list.scrollTo({top:Math.max(0, row.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop),behavior:"instant"}); })()');
    await settleUi(evaluate, 'event list same-tick scroll ' + width);
    const sameTickVisible = await evaluate('(() => { const list = document.querySelector("[aria-label=回放事件浏览]"); const lr = list.getBoundingClientRect(); const ids = ' + JSON.stringify(sameTickIds) + '; const buttons = [...list.querySelectorAll("[data-replay-event]")]; return ids.map(id => { const row = buttons.find(button => button.dataset.replayEvent === id); const r = row.getBoundingClientRect(); return r.top >= lr.top - 1 && r.bottom <= lr.bottom + 1; }); })()');
    metrics['sameTickLayout'+width]=await evaluate('(()=>{const l=document.querySelector("[aria-label=回放事件浏览]"),r=l.getBoundingClientRect();return {top:r.top,bottom:r.bottom,scrollTop:l.scrollTop,rows:'+JSON.stringify(sameTickIds)+'.map(id=>{const e=document.querySelector(`[data-replay-event="${id}"]`),r=e.getBoundingClientRect();return {id,text:e.textContent,top:r.top,bottom:r.bottom};})};})()');
    assert.deepEqual(sameTickVisible, sameTickIds.map(() => true), 'same-tick rows are visible in the saved screenshot at ' + width);
    await shot('p7-replay-events-' + width + 'x' + height);
    await shot('p7-replay-' + width + 'x' + height);
    await evaluate('document.getElementById("heatmap-tab").click()');
    await settleUi(evaluate, 'heatmap ' + width);
    const heatmapBar = await evaluate('(() => {const bar=document.querySelector("[data-heatmap-bar]"),title=bar.querySelector("h2, [class*=fui-Title2]"),badge=bar.querySelector("[class*=fui-Badge]");const r=bar.getBoundingClientRect(),t=title?.getBoundingClientRect(),b=badge?.getBoundingClientRect();return {titleLeft:t?t.left-r.left:null,badgeRight:b?r.right-b.right:null,layers:bar.querySelectorAll("[aria-pressed]").length,page:document.documentElement.scrollHeight-innerHeight};})()');
    assert.equal(heatmapBar.layers, 3);
    assert.ok(heatmapBar.titleLeft <= 16, 'heatmap title stays on the left of the toolbar');
    assert.ok(heatmapBar.badgeRight <= 16, 'map-version badge stays on the right of the toolbar');
    assert.ok(heatmapBar.page <= 1);
    await shot('p7-heatmap-' + width + 'x' + height);
    metrics.checks.push('layout ' + width + 'x' + height + ' (report/timeline/replay/heatmap)');
  }
  await page.send('Emulation.clearDeviceMetricsOverride');
  // A failed next-round load must stop continuous switching and surface a retryable error.
  await evaluate('document.getElementById("replay-tab").click()');
  await settleUi(evaluate, 'replay before failure check');
  await chooseRound(first.round); await setContinuous(true); await seek(first.endTick - 8);
  await evaluate('window.cs2Analyst.replay.release(document.querySelector("[data-replay-session]").dataset.replaySession)');
  await evaluate(play + '.click()');
  await wait(() => evaluate('document.querySelector("[data-replay-session]").dataset.replayRound==="' + second.round + '" && Boolean(document.querySelector("[role=alert]")) && Boolean(document.querySelector("[aria-label=播放回放]"))'), 'auto-switch failure stops', 15000);
  const failureText = await evaluate('document.querySelector("[role=alert]").innerText');
  assert.ok(/无效|结束|不可用/.test(failureText), 'a retryable failure is shown');
  assert.ok(await evaluate('[...document.querySelectorAll("[role=alert] button")].some(b=>b.textContent.includes("重试"))'));
  await shot('p7-continuous-failure');
  metrics.checks.push('failed next-round load stops auto-switch with retry');
  assert.deepEqual(exceptions, []);
  metrics.status = 'PASS';
} catch (error) {
  failure = new Error('P7 UI acceptance failed\n' + logs, { cause: error });
  metrics.status = 'FAIL'; metrics.error = String(error.stack || error);
  if (page) try { await shot('p7-failure'); } catch {}
} finally {
  writeFileSync(join(qa, 'p7-ui-acceptance.json'), JSON.stringify(metrics, null, 2) + '\n');
  await withCleanup(() => { if (failure) throw failure; }, [
    async () => { if (page) await closeApp({ child, evaluate: page.evaluate, socket: page.socket }); },
    () => { page?.socket.close(); },
    () => scope.cleanup(),
    async () => { assert.ok(profile.startsWith(profilePrefix)); await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); },
  ]);
}
console.log(JSON.stringify({ status: metrics.status, checks: metrics.checks, screenshots: metrics.screenshots }));
