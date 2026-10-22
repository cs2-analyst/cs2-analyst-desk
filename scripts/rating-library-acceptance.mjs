// Real Electron and whitelisted DEMs. All profiles/library writes are owned temporary data.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { connectCdp, waitFor, closeApp } from './smoke-runtime.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const desktop = join(repo, 'apps/desktop');
const electron = createRequire(join(desktop, 'package.json'))('electron');
const evidenceDir = process.env.CS2_ANALYST_RATING_QA || mkdtempSync(join(tmpdir(), 'cs2-analyst-rating-evidence-'));
mkdirSync(evidenceDir, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), 'cs2-analyst-rating-profile-'));
const localAppData = mkdtempSync(join(tmpdir(), 'cs2-analyst-rating-library-'));
const evidence = { generatedAt: new Date().toISOString(), evidenceDir, profile, localAppData, checks: [], screenshots: [], errors: [], consoleIssues: [] };
async function port() {
  const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const value = server.address().port; await new Promise(resolve => server.close(resolve)); return value;
}
async function launch(demo) {
  const p = await port();
  const env = { ...process.env, LOCALAPPDATA: localAppData, CS2_ANALYST_DEM_PATH: join(repo, '.demo', demo) };
  delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
  const child = spawn(electron, ['.', `--remote-debugging-port=${p}`, `--user-data-dir=${profile}`, '--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'], { cwd: desktop, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; child.stdout.on('data', d => logs += d); child.stderr.on('data', d => logs += d);
  let session;
  try {
  const page = await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(logs);
    try { return (await (await fetch(`http://127.0.0.1:${p}/json/list`)).json()).find(t => t.type === 'page'); } catch { return null; }
  }, 60000, 'Electron debugging port');
  session = { ...await connectCdp(page.webSocketDebuggerUrl), child };
  session.socket.addEventListener('message', e => {
    const m = JSON.parse(e.data); if (m.method === 'Runtime.exceptionThrown') evidence.errors.push(m.params);
    if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) {
      evidence.consoleIssues.push({ type: m.params.type, text: m.params.args.map(a => a.value ?? a.description ?? '').join(' ') });
    }
  });
  await session.send('Runtime.enable'); await session.send('Page.enable'); await session.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await waitFor(() => session.evaluate('!!document.querySelector("[data-library-page]")'), 15000, 'library first paint');
  return session;
  } catch (error) {
    session?.socket.close();
    if (child.pid && child.exitCode === null) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    throw error;
  }
}
async function shot(s, name, width = 1440, height = 900) {
  await s.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await waitFor(() => s.evaluate(`innerWidth===${width} && innerHeight===${height}`), 5000, 'viewport');
  await waitFor(() => s.evaluate(`!document.querySelector('[data-library-storage]')?.textContent.includes('正在读取')`), 15000, 'stable storage footer');
  const data = await s.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const path = join(evidenceDir, name + '.png'); writeFileSync(path, Buffer.from(data.data, 'base64')); evidence.screenshots.push(path);
}
async function click(s, selector) { await s.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`); }
async function library(s) {
  await click(s, '[data-nav-action=home]');
  await waitFor(() => s.evaluate('!!document.querySelector("[data-library-entry]")'), 20000, 'populated library');
}
async function chooseOption(s, label, value) {
  await s.evaluate(`document.querySelector('[aria-label=${JSON.stringify(label)}]').click()`);
  await waitFor(() => s.evaluate(`[...document.querySelectorAll('[role=option]')].some(o=>o.checkVisibility()&&o.getAttribute('data-value')===${JSON.stringify(value)})`), 5000, label + ' option ' + value);
  await s.evaluate(`[...document.querySelectorAll('[role=option]')].find(o=>o.checkVisibility()&&o.getAttribute('data-value')===${JSON.stringify(value)}).click()`);
}
async function selectIdentity(s, id) {
  await chooseOption(s, '比赛记录玩家', id);
  await waitFor(() => s.evaluate(`document.querySelector('[data-library-entry]').dataset.libraryPlayer===${JSON.stringify(id)}`), 5000, 'identity changed');
}
async function importDemo(s, name) {
  const started = Date.now(); await click(s, '[data-library-import-dem]');
  await waitFor(() => s.evaluate('document.querySelector("[data-app-content]")?.dataset.status === "success"'), 240000, 'real ' + name + ' import',
    { diagnostics: () => s.evaluate('document.body.innerText.slice(-1500)') });
  await click(s, '#report-tab');
  evidence.checks.push({ name: name + ' import', elapsedMs: Date.now() - started });
}
async function verifyReportAndLibrary(s, label) {
  const current = await s.evaluate(`({rating:document.querySelector('[data-report-secondary] [data-rating-value]').dataset.ratingValue, file:document.querySelector('[data-report-filename]').textContent, player:document.querySelector('[aria-label="目标玩家"]').textContent})`);
  await shot(s, label + '-report');
  const geometry = await s.evaluate(`(() => {const f=document.querySelector('[data-report-filename]'),r=document.querySelector('[data-report-secondary] [data-rating-value]');const a=f.getBoundingClientRect(),b=r.getBoundingClientRect();return {overlap:a.right>b.left,ellipsis:getComputedStyle(f).textOverflow};})()`);
  assert.equal(geometry.overlap, false); assert.equal(geometry.ellipsis, 'ellipsis');
  await shot(s, label + '-report-narrow', 900, 700);
  const filenameLayout = await s.evaluate(`(() => {const f=document.querySelector('[data-report-filename]');const original=f.textContent;
    f.textContent='long-demo-name-'.repeat(40)+'.dem';const a=f.getBoundingClientRect(),b=document.querySelector('[data-report-secondary] [data-rating-value]').getBoundingClientRect();
    const result={overlap:a.right>b.left,clipped:f.scrollWidth>f.clientWidth,ellipsis:getComputedStyle(f).textOverflow};f.textContent=original;return result;})()`);
  assert.deepEqual(filenameLayout, { overlap: false, clipped: true, ellipsis: 'ellipsis' });
  evidence.checks.push({name: label + ' long filename presentation-only stress', ...filenameLayout});
  await library(s);
  const row = await s.evaluate(`(() => {const r=[...document.querySelectorAll('[data-library-entry]')].find(r=>r.querySelector('[data-library-open]').getAttribute('aria-label')===${JSON.stringify('打开 ' + current.file)}); return {id:r.dataset.libraryEntry,player:r.dataset.libraryPlayer,rating:r.querySelector('[data-rating-value]').dataset.ratingValue,tags:[...r.querySelectorAll('[data-highlight]')].map(t=>t.dataset.highlight),outcome:r.querySelector('[data-library-outcome]').dataset.libraryOutcome};})()`);
  assert.equal(row.rating, current.rating);
  evidence.checks.push({ name: label + ' report/library consistency', ...current, ...row });
  await shot(s, label + '-library');
  const tag = await s.evaluate(`document.querySelector('[data-library-entry="${row.id}"] [data-highlight]')?.getAttribute('aria-label')`);
  if (tag) {
    const target = await s.evaluate(`(() => {const t=document.querySelector('[data-library-entry="${row.id}"] [data-highlight]'); const r=t.getBoundingClientRect();t.focus();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...target });
    await waitFor(() => s.evaluate(`Array.from(document.querySelectorAll('[role=tooltip]')).some(t=>t.textContent===${JSON.stringify(tag)}&&t.checkVisibility())`), 5000, 'highlight tooltip', {diagnostics: () => s.evaluate('({focus:document.hasFocus(),tips:[...document.querySelectorAll("[role=tooltip]")].map(t=>t.outerHTML)})')});
    await shot(s, label + '-highlight-tooltip'); await s.evaluate('document.activeElement.blur()');
  }
  await shot(s, label + '-narrow', 900, 700);
  const layout = await s.evaluate(`(() => {const t=document.querySelector('[data-library-list]'),scroll=t.parentElement;return {table:t.offsetWidth,viewport:scroll.clientWidth,horizontalScroll:scroll.scrollWidth>scroll.clientWidth,pageOverflow:document.documentElement.scrollWidth>innerWidth,tagSizes:[...t.querySelectorAll('[data-highlight]')].map(t=>({w:t.offsetWidth,h:t.offsetHeight}))};})()`);
  assert.equal(layout.horizontalScroll, true); assert.equal(layout.pageOverflow, false);
  for (const tag of layout.tagSizes) assert.deepEqual(tag, { w: 20, h: 20 });
  evidence.checks.push({ name: label + ' narrow geometry', ...layout });
  await s.evaluate(`document.querySelector('[data-library-list]').parentElement.scrollLeft=10000`);
  const actionsReachable = await s.evaluate(`Array.from(document.querySelectorAll('[data-library-open]')).every(b=>{const r=b.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth})`);
  assert.equal(actionsReachable, true);
  await shot(s, label + '-narrow-actions', 900, 700);
  await s.evaluate(`document.querySelector('[data-library-list]').parentElement.scrollLeft=0`);
  await s.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  return row;
}

let s;
try {
  for (const f of ['demo1.dem', 'demo2.dem']) assert.ok(existsSync(join(repo, '.demo', f)), f + ' must be present; never download/copy DEMs');
  s = await launch('demo1.dem'); await shot(s, 'empty-library');
  await importDemo(s, 'demo1.dem');
  const first = await verifyReportAndLibrary(s, 'demo1'); assert.equal(first.rating, '1.37');
  await selectIdentity(s, first.player);
  await s.evaluate(`document.querySelector('[aria-label="比赛记录玩家"]').click()`);
  await waitFor(() => s.evaluate('[...document.querySelectorAll("[role=option]")].some(o=>o.checkVisibility())'), 5000, 'identity options open');
  const identityOptions = await s.evaluate(`[...document.querySelectorAll('[role=option]')].filter(o=>o.checkVisibility()).map(o=>o.getAttribute('data-value')).filter(v=>v&&v!=='all')`);
  await s.evaluate(`document.querySelector('[aria-label="比赛记录玩家"]').click()`);
  const alternate = identityOptions.find(id => id !== first.player); assert.ok(alternate);
  await selectIdentity(s, alternate);
  const changed = await s.evaluate(`document.querySelector('[data-library-entry] [data-rating-value]').dataset.ratingValue`);
  await click(s, '[data-library-open]');
  await waitFor(() => s.evaluate(`document.querySelector('[data-report-secondary] [data-rating-value]')?.dataset.ratingValue===${JSON.stringify(changed)}`), 20000, 'alternate identity report');
  await click(s, '[aria-label="目标玩家"]');
  await waitFor(() => s.evaluate('document.querySelectorAll("[role=option]").length > 1'), 5000, 'report player options');
  await s.evaluate(`document.querySelector('[role=option][aria-selected="false"]').click()`);
  const reportSwitch = await s.evaluate(`document.querySelector('[data-report-secondary] [data-rating-value]').dataset.ratingValue`);
  await library(s);
  await waitFor(() => s.evaluate(`document.querySelector('[data-library-entry] [data-rating-value]').dataset.ratingValue===${JSON.stringify(reportSwitch)}`), 5000, 'report selection reused by library');
  evidence.checks.push({ name: 'bidirectional identity switching', alternate, alternateRating: changed, reportSwitchRating: reportSwitch });
  await closeApp(s); s = null;
  s = await launch('demo2.dem');
  await importDemo(s, 'demo2.dem');
  await verifyReportAndLibrary(s, 'demo2');
  const catalogueLatency = await s.evaluate(`(async()=>{const start=performance.now();const result=await window.cs2Analyst.library.list({limit:25});return {milliseconds:performance.now()-start,kind:result.kind,count:result.entries?.length}})()`);
  assert.equal(catalogueLatency.kind, 'success'); evidence.checks.push({name:'warm catalogue latency',...catalogueLatency});
  assert.equal(await s.evaluate('document.querySelectorAll("[data-library-entry]").length'), 2);
  await s.evaluate(`(() => {const q=document.querySelector('input[aria-label="搜索比赛"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(q,'demo1');q.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await waitFor(() => s.evaluate('document.querySelectorAll("[data-library-entry]").length===1'), 10000, 'search filters real records');
  await shot(s, 'filtered-library');
  evidence.checks.push({ name: 'search filter', count: 1 });
  assert.deepEqual(evidence.errors, []);
  // Existing unpackaged Electron advisory; retain it in evidence without treating it as an app error.
  evidence.knownConsoleWarnings = evidence.consoleIssues.filter(issue => issue.type === 'warning'
    && issue.text.includes('Electron Security Warning (Insecure Content-Security-Policy)')
    && issue.text.includes('This warning will not show up'));
  assert.deepEqual(evidence.consoleIssues.filter(issue => !evidence.knownConsoleWarnings.includes(issue)), []);
  await closeApp(s); s = null;
  evidence.result = 'PASS';
} catch (error) { evidence.result = 'FAIL'; evidence.failure = error.stack; if (s) { try { await shot(s, 'failure'); await closeApp(s); } catch {} } process.exitCode = 1; }
finally { if(s) { s.socket.close(); if(s.child.exitCode===null) spawnSync('taskkill',['/PID',String(s.child.pid),'/T','/F'],{windowsHide:true}); } }
writeFileSync(join(evidenceDir, 'evidence.json'), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence, null, 2));
