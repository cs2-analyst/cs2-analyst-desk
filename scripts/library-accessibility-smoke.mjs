// L5 emulated DPI / forced-colors smoke. Physical DPI and Narrator remain NOT RUN.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOwnedQaRun } from './owned-qa-run.mjs';
import { connectCdp, waitFor } from './smoke-runtime.mjs';
import { ProcessScope } from './installed-smoke-lifecycle.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const run = createOwnedQaRun('l5-accessibility', { parent: join(root, '.tmp') });
const evidence = { schemaVersion: 1, stage: 'L5-accessibility', startedAt: new Date().toISOString(), run,
  emulated: true, physicalDPI: 'NOT RUN', narrator: 'NOT RUN', states: [], checks: [], status: 'RUNNING' };
const scope = new ProcessScope(); let child;
const save = () => writeFileSync(join(run.output, 'accessibility.json'), JSON.stringify(evidence, null, 2) + '\n');
const measure = page => page.evaluate(`(() => {
  const bar = document.querySelector('[data-app-titlebar]').getBoundingClientRect();
  const brand = document.querySelector('[data-app-brand]').getBoundingClientRect();
  const back = document.querySelector('[data-nav-action="back"]');
  return { dpr: devicePixelRatio, innerWidth, innerHeight,
    titlebar: { left: bar.left, width: bar.width }, brand: { left: brand.left, width: brand.width },
    delta: Math.abs(brand.left + brand.width / 2 - (bar.left + bar.width / 2)),
    backColor: getComputedStyle(back).color, backAriaDisabled: back.getAttribute('aria-disabled'),
    forcedColors: matchMedia('(forced-colors: active)').matches };
})()`);
try {
  const server = createServer(); await new Promise(done => server.listen(0, '127.0.0.1', done));
  const port = server.address().port; await new Promise(done => server.close(done));
  const env = { ...process.env, LOCALAPPDATA: run.localAppData };
  delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL; delete env.CS2_ANALYST_DEM_PATH; delete env.CS2_ANALYST_TEST_DEM_PATH;
  child = spawn(require('electron'), ['.', '--remote-debugging-port=' + port, '--user-data-dir=' + run.profile], { cwd: join(root, 'apps/desktop'), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const tracked = scope.track(child, 'L5 accessibility', Date.now()); await scope.live();
  const target = await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(tracked.stderr);
    try { return (await (await fetch('http://127.0.0.1:' + port + '/json/list', { signal: AbortSignal.timeout(1000) })).json()).find(item => item.type === 'page'); }
    catch { return null; }
  }, 30_000, 'accessibility CDP');
  const page = await connectCdp(target.webSocketDebuggerUrl, 90_000); scope.sessions.add(page.socket);
  const { send, socket } = page;
  await waitFor(() => page.evaluate('Boolean(document.querySelector("[data-app-brand]"))'), 30_000, 'accessibility shell');
  for (const [label, width, height, dpr] of [['1024x640@1.25', 1024, 640, 1.25], ['1024x640@1.5', 1024, 640, 1.5], ['1920x1032@1.5', 1920, 1032, 1.5]]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dpr, mobile: false });
    await new Promise(resolve => setTimeout(resolve, 250));
    const state = await measure(page);
    state.label = label; evidence.states.push(state);
    assert.ok(state.delta <= 1, label + ' brand center delta ' + state.delta);
    assert.equal(state.dpr, dpr);
  }
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'active' }] });
  await new Promise(resolve => setTimeout(resolve, 250));
  const forced = await measure(page);
  evidence.forcedColors = forced;
  assert.equal(forced.forcedColors, true, 'emulated forced-colors must be active');
  assert.notEqual(forced.backColor, 'rgba(0, 0, 0, 0)', 'navigation icon must retain a visible color');
  evidence.checks.push('emulated 125%/150% DPI and forced-colors keep the brand within 1px and navigation visible');
  evidence.checks.push('these are CDP emulation results; physical DPI, real Windows high contrast and Narrator are NOT RUN');
  evidence.status = 'PASS';
  try { await page.evaluate('void window.cs2Analyst.window.close()'); } catch { /* CDP disconnect */ }
  await waitFor(() => child.exitCode !== null, 15_000, 'accessibility close');
  socket.close(); scope.sessions.delete(socket);
} catch (error) {
  evidence.status = 'FAIL'; evidence.error = { message: error.message, stack: error.stack }; process.exitCode = 1;
} finally {
  if (child && child.exitCode === null) { try { child.kill('SIGKILL'); } catch { /* best effort */ } }
  try { await scope.cleanup(); } catch (error) { evidence.cleanupError = error.message; evidence.status = 'FAIL'; process.exitCode = 1; }
  evidence.finishedAt = new Date().toISOString(); save();
  console.log(JSON.stringify({ status: evidence.status, evidence: join(run.output, 'accessibility.json'), error: evidence.error?.message }));
}
