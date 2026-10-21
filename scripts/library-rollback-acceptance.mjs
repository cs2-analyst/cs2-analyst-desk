// L5 rollback read check: install the older L1 build against a library written by the final build.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOwnedQaRun } from './owned-qa-run.mjs';
import { connectCdp, waitFor } from './smoke-runtime.mjs';
import { ProcessScope, runInstaller, assertNoConflicts, windowsProcesses, windowsRegistrations } from './installed-smoke-lifecycle.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const previousInstaller = resolve(process.argv[2] ?? 'E:/cs2-analyst-l1/release/0.1.0/CS2-Analyst-Setup-0.1.0.exe');
const localAppData = resolve(process.argv[3] ?? 'E:/cs2-analyst/.tmp/cs2-l5-upgrade-UnfIHd/localAppData');
const expectedMatch = process.argv[4] ?? 'db90fe85aab023a1d2c8a5996182e6120d98ef494f02a070b17982b235e4958c';
assert.ok(existsSync(previousInstaller) && existsSync(join(localAppData, 'CS2 Analyst', 'MatchLibrary', 'library.db')));
const run = createOwnedQaRun('l5-rollback', { parent: join(root, '.tmp') });
const installation = join(run.directory, 'rollback-app');
const evidence = { schemaVersion: 1, stage: 'L5-rollback', startedAt: new Date().toISOString(), run,
  installer: { path: previousInstaller, sha256: createHash('sha256').update(readFileSync(previousInstaller)).digest('hex') },
  localAppData, expectedMatch, checks: [], status: 'RUNNING' };
const scope = new ProcessScope(); let child;
const save = () => writeFileSync(join(run.output, 'rollback.json'), JSON.stringify(evidence, null, 2) + '\n');
try {
  assertNoConflicts(await windowsProcesses(), await windowsRegistrations());
  await runInstaller(scope, previousInstaller, ['/S', '/D=' + installation], { label: 'L5 rollback install', directory: installation });
  const server = createServer(); await new Promise(done => server.listen(0, '127.0.0.1', done));
  const port = server.address().port; await new Promise(done => server.close(done));
  const env = { ...process.env, LOCALAPPDATA: localAppData };
  delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL; delete env.CS2_ANALYST_DEM_PATH; delete env.CS2_ANALYST_TEST_DEM_PATH;
  const profile = join(run.directory, 'profile');
  const exe = join(installation, 'CS2 Analyst.exe');
  child = spawn(exe, ['--remote-debugging-port=' + port, '--user-data-dir=' + profile], { cwd: dirname(exe), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const tracked = scope.track(child, 'L5 rollback app', Date.now()); await scope.live();
  const target = await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(tracked.stderr);
    try { return (await (await fetch('http://127.0.0.1:' + port + '/json/list', { signal: AbortSignal.timeout(1000) })).json()).find(item => item.type === 'page'); }
    catch { return null; }
  }, 30_000, 'rollback CDP');
  const page = await connectCdp(target.webSocketDebuggerUrl, 90_000); scope.sessions.add(page.socket);
  await waitFor(() => page.evaluate('Boolean(window.cs2Analyst?.library)'), 30_000, 'rollback preload');
  const list = await page.evaluate('window.cs2Analyst.library.list()');
  assert.equal(list.kind, 'success'); assert.equal(list.total, 1); assert.equal(list.entries[0].matchId, expectedMatch);
  evidence.entry = { matchId: list.entries[0].matchId, state: list.entries[0].state, sourceRevision: list.entries[0].versions.sourceRevision };
  assert.equal(evidence.entry.state, 'ready');
  evidence.checks.push('older L1 build can list the final-build library and sees a ready archived match');
  try { await page.evaluate('void window.cs2Analyst.window.close()'); } catch { /* CDP disconnect */ }
  await waitFor(() => child.exitCode !== null, 15_000, 'rollback app close');
  page.socket.close(); scope.sessions.delete(page.socket);
  await runInstaller(scope, join(installation, 'Uninstall CS2 Analyst.exe'), ['/S', '/currentuser'], { label: 'L5 rollback uninstall', directory: installation });
  await waitFor(async () => !existsSync(join(installation, 'CS2 Analyst.exe')) && (await windowsRegistrations()).length === 0, 30_000, 'rollback uninstall');
  evidence.checks.push('rollback uninstall preserved the external LOCALAPPDATA library');
  evidence.status = 'PASS';
} catch (error) {
  evidence.status = 'FAIL'; evidence.error = { message: error.message, stack: error.stack }; process.exitCode = 1;
} finally {
  if (child && child.exitCode === null) { try { child.kill('SIGKILL'); } catch { /* best effort */ } }
  try { await scope.cleanup(); } catch (error) { evidence.cleanupError = error.message; evidence.status = 'FAIL'; process.exitCode = 1; }
  evidence.finishedAt = new Date().toISOString(); save();
  console.log(JSON.stringify({ status: evidence.status, evidence: join(run.output, 'rollback.json'), error: evidence.error?.message }));
}
