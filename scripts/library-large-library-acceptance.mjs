// L5 large-library first-screen simulation with 50 synthetic archives.
// These are isolated synthetic archives, not real matches; no DEM is copied.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOwnedQaRun } from './owned-qa-run.mjs';
import { connectCdp, waitFor } from './smoke-runtime.mjs';
import { ProcessScope } from './installed-smoke-lifecycle.mjs';
import { LocalMatchLibrary } from '../apps/desktop/electron/local-library.ts';
import { writeLibraryArchive } from '../apps/desktop/electron/library-archive.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const run = createOwnedQaRun('l5-large-library', { parent: join(root, '.tmp') });
const libraryRoot = join(run.localAppData, 'CS2 Analyst', 'MatchLibrary');
const versions = { application: '0.1.0', archive: 1, report: 2, replay: 1, analysis: 'synthetic', parser: 'synthetic', native: 'synthetic',
  sampling: 'synthetic', mapResource: 'synthetic', sourceRevision: '1'.repeat(40) };
const digest = value => createHash('sha256').update(value).digest('hex');
const evidence = { schemaVersion: 1, stage: 'L5-large-library', startedAt: new Date().toISOString(), run,
  synthetic: true, count: 50, checks: [], status: 'RUNNING' };
const scope = new ProcessScope(); let child;
function input(index) {
  const id = digest('synthetic-large-' + index);
  return { match: { id, map: 'de_dust2', players: [{ steamId: 'p1' }], rounds: [] }, replay: null, spatial: null, chunks: new Map(), versions,
    report: { schemaVersion: 2, match: { id, fileName: 'synthetic-' + index + '.dem', map: 'de_dust2', rounds: 0, score: null },
      selectedPlayer: 'p1', players: [{ id: 'p1', nickname: 'Synthetic Player' }], analytics: [], findings: [], timeline: [],
      analysis: { players: [], perPlayer: [] }, deepReview: { available: false, players: [] } } };
}
const save = () => writeFileSync(join(run.output, 'large-library.json'), JSON.stringify(evidence, null, 2) + '\n');
try {
  // Build the catalogue entirely offline through the production library service.
  const library = await LocalMatchLibrary.open(libraryRoot);
  const started = performance.now();
  for (let index = 0; index < 50; index++) {
    const staged = await library.createStaging();
    const receipt = await writeLibraryArchive(staged.directory, input(index));
    await library.commitStaging(staged.id, undefined, receipt);
  }
  evidence.buildMs = performance.now() - started;
  evidence.catalogued = library.list({ limit: 100 }).total;
  assert.equal(evidence.catalogued, 50);
  library.close();
  save();

  const portServer = createServer(); await new Promise(done => portServer.listen(0, '127.0.0.1', done));
  const port = portServer.address().port; await new Promise(done => portServer.close(done));
  const env = { ...process.env, LOCALAPPDATA: run.localAppData };
  delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL; delete env.CS2_ANALYST_DEM_PATH; delete env.CS2_ANALYST_TEST_DEM_PATH;
  const desktop = join(root, 'apps/desktop');
  child = spawn(require('electron'), ['.', '--remote-debugging-port=' + port, '--user-data-dir=' + run.profile, '--disable-backgrounding-occluded-windows'],
    { cwd: desktop, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const tracked = scope.track(child, 'L5 large library', Date.now()); await scope.live();
  const target = await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(tracked.stderr);
    try { return (await (await fetch('http://127.0.0.1:' + port + '/json/list', { signal: AbortSignal.timeout(1000) })).json()).find(item => item.type === 'page'); }
    catch { return null; }
  }, 30_000, 'large-library CDP');
  const page = await connectCdp(target.webSocketDebuggerUrl, 90_000); scope.sessions.add(page.socket);
  await waitFor(() => page.evaluate('Boolean(window.cs2Analyst?.library && document.querySelector("[data-library-page]"))'), 30_000, 'large-library page');
  const listStarted = performance.now();
  const list = await page.evaluate('window.cs2Analyst.library.list({ limit: 100 })');
  evidence.listMs = performance.now() - listStarted;
  assert.equal(list.kind, 'success'); assert.equal(list.total, 50); assert.equal(list.entries.length, 50);
  await waitFor(() => page.evaluate('document.querySelectorAll("[data-library-entry]").length === 50'), 30_000, 'fifty rendered rows');
  evidence.renderedRows = await page.evaluate('document.querySelectorAll("[data-library-entry]").length');
  evidence.firstScreenNoChunks = await page.evaluate('document.querySelectorAll("[data-replay-session]").length === 0');
  assert.equal(evidence.firstScreenNoChunks, true);
  evidence.checks.push('50 synthetic catalogue entries listed with one bounded SQLite query, 50 rows rendered, no Replay chunk/session loaded on first screen');
  evidence.checks.push('synthetic archives only; this is not a real-match or open-rendering claim');
  evidence.status = 'PASS';
  try { await page.evaluate('void window.cs2Analyst.window.close()'); } catch { /* CDP disconnect */ }
  await waitFor(() => child.exitCode !== null, 15_000, 'large-library close');
  page.socket.close(); scope.sessions.delete(page.socket);
} catch (error) {
  evidence.status = 'FAIL'; evidence.error = { message: error.message, stack: error.stack }; process.exitCode = 1;
} finally {
  if (child && child.exitCode === null) { try { child.kill('SIGKILL'); } catch { /* best effort */ } }
  try { await scope.cleanup(); } catch (error) { evidence.cleanupError = error.message; evidence.status = 'FAIL'; process.exitCode = 1; }
  evidence.finishedAt = new Date().toISOString(); save();
  console.log(JSON.stringify({ status: evidence.status, evidence: join(run.output, 'large-library.json'), error: evidence.error?.message }));
}
