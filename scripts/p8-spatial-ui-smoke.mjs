import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeApp, connectCdp, waitFor, withCleanup } from './smoke-runtime.mjs';
import { ProcessScope } from './installed-smoke-lifecycle.mjs';
import { settleUi, assertNoPageScroll } from './window-shell-checks.mjs';

const desktop = fileURLToPath(new URL('../apps/desktop/', import.meta.url));
const demo = fileURLToPath(new URL('../.demo/dust2.dem', import.meta.url));
const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const electron = require('electron');
const qa = process.env.CS2_ANALYST_QA_DIR;
assert.ok(qa && existsSync(qa), 'QA output directory required');
assert.ok(existsSync(demo), 'Dust2 fixture missing');

async function removeOwnedTemp(target) {
  const root = realpathSync(tmpdir()), resolved = realpathSync(target), rel = relative(root, resolved);
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`))
    throw new Error('unsafe temporary cleanup target');
  await rm(resolved, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}
async function freePort() {
  const server = createServer();await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;await new Promise(resolve => server.close(resolve));return port;
}

const profile = mkdtempSync(join(tmpdir(), 'cs2-p8-ui-profile-'));
const localAppData = mkdtempSync(join(tmpdir(), 'cs2-p8-ui-data-'));
const port = await freePort();
const env = { ...process.env, CS2_ANALYST_DEM_PATH: demo, LOCALAPPDATA: localAppData };
delete env.ELECTRON_RUN_AS_NODE;delete env.ELECTRON_RENDERER_URL;
const child = spawn(electron, ['.', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows'],
{ cwd: desktop, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const scope = new ProcessScope();const tracked = scope.track(child, 'p8-spatial-ui', Date.now());
let socket, logs = '';
child.stdout.on('data', data => { logs += data; });child.stderr.on('data', data => { logs += data; });

await withCleanup(async () => {
  const page = await waitFor(async () => {
    await scope.live();if (tracked.error) throw tracked.error;
    if (child.exitCode !== null) throw new Error(`app-exited:${child.exitCode}`);
    try { const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) });
      return (await response.json()).find(target => target.type === 'page' && target.webSocketDebuggerUrl); }
    catch { return null; }
  }, 30000, 'Electron window');
  const connection = await connectCdp(page.webSocketDebuggerUrl);socket = connection.socket;
  const { send, evaluate } = connection, errors = [];
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') errors.push('exception');
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') errors.push('console-error');
  });
  await send('Runtime.enable');await send('Page.enable');
  await waitFor(() => evaluate(`document.readyState==='complete'&&document.body.textContent.includes('CS2 Analyst')`), 30000, 'app ready');
  const importStarted = Date.now();
  await evaluate(`document.querySelector('[data-sidebar-import]').click()`);
  await waitFor(async () => {
    await evaluate(`document.querySelector('[data-import-player-later]')?.click()`);
    return evaluate(`document.querySelector('main')?.dataset.status==='success'&&!!document.getElementById('analysis-tab')`);
  }, 120000, 'DEM import', { diagnostics: () => evaluate(`({status:document.querySelector('main')?.dataset.status,text:document.body.innerText.slice(-800)})`) });
  const importMs = Date.now() - importStarted;
  const openSpatial = async () => {
    await evaluate(`document.getElementById('analysis-tab').click()`);
    await waitFor(() => evaluate(`!document.getElementById('analysis-panel').hidden`), 10000, 'analysis');
    await evaluate(`document.querySelector('[data-analysis-tab="spatial"]').click()`);
    await waitFor(() => evaluate(`!document.querySelector('[data-analysis-panel="spatial"]').hidden`), 10000, 'spatial tab');
    await settleUi(evaluate, 'spatial facts');
  };
  await openSpatial();
  const initial = await evaluate(`(() => {const p=document.querySelector('[data-analysis-panel="spatial"]');
    return {status:p.querySelector('[data-spatial-facts]')?.dataset.spatialFacts,
      cards:p.querySelectorAll('[data-spatial-card]').length,text:p.innerText};})()`);
  assert.ok(['available', 'partial'].includes(initial.status));assert.ok(initial.cards > 0);
  for (const text of ['服务器空间事实', '不证明视野', 'DEM 单位', '查看回放']) assert.ok(initial.text.includes(text), text);
  for (const [width, height] of [[1280, 900], [1024, 640]]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await settleUi(evaluate, `spatial ${width}x${height}`);
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
    await assertNoPageScroll(evaluate, `spatial ${width}x${height}`);
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(join(qa, `spatial-${width}x${height}.png`), Buffer.from(shot.data, 'base64'));
  }
  await send('Emulation.clearDeviceMetricsOverride');
  await evaluate(`document.querySelector('[data-analysis-panel="spatial"] [data-spatial-card] button').click()`);
  await waitFor(() => evaluate(`!document.getElementById('replay-panel').hidden&&!!document.querySelector('[data-replay-session]')`),
    15000, 'spatial replay link');
  await evaluate(`document.querySelector('[data-nav-action="home"]').click()`);
  await waitFor(() => evaluate(`!!document.querySelector('[data-library-entry][data-library-state="ready"]')`), 30000, 'saved library entry');
  await evaluate(`document.querySelector('[data-library-entry][data-library-state="ready"]').click()`);
  await waitFor(() => evaluate(`document.querySelector('main')?.dataset.status==='success'&&!!document.getElementById('analysis-tab')`),
    60000, 'archive reopen');
  await openSpatial();
  const restored = await evaluate(`(() => {const p=document.querySelector('[data-analysis-panel="spatial"]');
    return {status:p.querySelector('[data-spatial-facts]')?.dataset.spatialFacts,
      cards:p.querySelectorAll('[data-spatial-card]').length};})()`);
  assert.deepEqual(restored, { status: initial.status, cards: initial.cards });
  assert.deepEqual(errors, []);
  process.stdout.write(`${JSON.stringify({ status: 'PASS', fixture: 'dust2.dem', importMs,
    spatialStatus: initial.status, cards: initial.cards, archiveRestored: true,
    replayLink: true, viewports: ['1280x900', '1024x640'], browser: 'Electron CDP' })}\n`);
  await closeApp({ child, evaluate, socket });
}, [() => socket?.close(), () => scope.cleanup(), () => removeOwnedTemp(profile), () => removeOwnedTemp(localAppData)]).catch(error => {
  error.message += `\nElectron logs: ${logs.slice(-2000)}`;throw error;
});
