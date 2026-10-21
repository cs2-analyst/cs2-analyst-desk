// L5 rollback open/render: older L2 build opens a library written by the final build.
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
const olderInstaller = resolve(process.argv[2] ?? 'E:/cs2-analyst-l2/release/0.1.0/CS2-Analyst-Setup-0.1.0.exe');
const localAppData = resolve(process.argv[3] ?? 'E:/cs2-analyst/.tmp/cs2-l5-upgrade-UnfIHd/localAppData');
const expectedMatch = process.argv[4] ?? 'db90fe85aab023a1d2c8a5996182e6120d98ef494f02a070b17982b235e4958c';
const expectedReport = process.argv[5] ?? 'e071bfa72302b05b955018158614dc90494ca9d769b3873497efc8bb5771f748';
assert.ok(existsSync(olderInstaller) && existsSync(join(localAppData, 'CS2 Analyst', 'MatchLibrary', 'library.db')));
const run = createOwnedQaRun('l5-rollback-open', { parent: join(root, '.tmp') });
const installation = join(run.directory, 'rollback-open-app');
const evidence = { schemaVersion: 1, stage: 'L5-rollback-open', startedAt: new Date().toISOString(), run,
  installer: { path: olderInstaller, sha256: createHash('sha256').update(readFileSync(olderInstaller)).digest('hex') },
  localAppData, expectedMatch, expectedReport, checks: [], status: 'RUNNING' };
const digest = value => createHash('sha256').update(value).digest('hex');
const withoutSession = value => JSON.parse(JSON.stringify(value, (key, item) => key === 'sessionId' ? undefined : item));
const scope = new ProcessScope(); let child;
const save = () => writeFileSync(join(run.output, 'rollback-open.json'), JSON.stringify(evidence, null, 2) + '\n');
const reportExpression = `(() => {const node=document.getElementById('heatmap-panel');let f=node[Object.keys(node).find(k=>k.startsWith('__reactFiber$'))];while(f&&!f.memoizedProps?.report)f=f.return;return f.memoizedProps.report;})()`;
try {
  assertNoConflicts(await windowsProcesses(), await windowsRegistrations());
  await runInstaller(scope, olderInstaller, ['/S', '/D=' + installation], { label: 'L5 rollback-open install', directory: installation });
  const server = createServer(); await new Promise(done => server.listen(0, '127.0.0.1', done));
  const port = server.address().port; await new Promise(done => server.close(done));
  const env = { ...process.env, LOCALAPPDATA: localAppData };
  delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL; delete env.CS2_ANALYST_DEM_PATH; delete env.CS2_ANALYST_TEST_DEM_PATH;
  const exe = join(installation, 'CS2 Analyst.exe');
  child = spawn(exe, ['--remote-debugging-port=' + port, '--user-data-dir=' + join(run.directory, 'profile')], { cwd: dirname(exe), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const tracked = scope.track(child, 'L5 rollback-open app', Date.now()); await scope.live();
  const target = await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(tracked.stderr);
    try { return (await (await fetch('http://127.0.0.1:' + port + '/json/list', { signal: AbortSignal.timeout(1000) })).json()).find(item => item.type === 'page'); }
    catch { return null; }
  }, 30_000, 'rollback-open CDP');
  const page = await connectCdp(target.webSocketDebuggerUrl, 90_000); scope.sessions.add(page.socket);
  await waitFor(() => page.evaluate('Boolean(window.cs2Analyst?.library && document.querySelector("[data-library-entry]"))'), 30_000, 'rollback-open library entry');
  const list = await page.evaluate('window.cs2Analyst.library.list()');
  assert.equal(list.total, 1); assert.equal(list.entries[0].matchId, expectedMatch); assert.equal(list.entries[0].state, 'ready');
  await page.evaluate('document.querySelector("[data-library-entry] button").click()');
  await waitFor(() => page.evaluate('document.querySelector("main")?.dataset.status === "success"'), 60_000, 'rollback-open report', {
    diagnostics: () => page.evaluate('({status:document.querySelector("main")?.dataset.status,text:document.body.innerText.slice(-1000)})') });
  const opened = await page.evaluate(reportExpression);
  evidence.opened = { matchId: opened.match.id, reportHash: digest(JSON.stringify(withoutSession(opened))) };
  assert.equal(evidence.opened.matchId, expectedMatch);
  assert.equal(evidence.opened.reportHash, expectedReport, 'older build must render the same archived report');
  evidence.checks.push('older L2 build lists and opens the final-build archive with an identical report fingerprint');
  try { await page.evaluate('void window.cs2Analyst.window.close()'); } catch { /* CDP disconnect */ }
  await waitFor(() => child.exitCode !== null, 15_000, 'rollback-open close');
  page.socket.close(); scope.sessions.delete(page.socket);
  await runInstaller(scope, join(installation, 'Uninstall CS2 Analyst.exe'), ['/S', '/currentuser'], { label: 'L5 rollback-open uninstall', directory: installation });
  await waitFor(async () => !existsSync(join(installation, 'CS2 Analyst.exe')) && (await windowsRegistrations()).length === 0, 30_000, 'rollback-open uninstall');
  evidence.checks.push('rollback-open uninstall preserved the external library');
  evidence.status = 'PASS';
} catch (error) {
  evidence.status = 'FAIL'; evidence.error = { message: error.message, stack: error.stack }; process.exitCode = 1;
} finally {
  if (child && child.exitCode === null) { try { child.kill('SIGKILL'); } catch { /* best effort */ } }
  try { await scope.cleanup(); } catch (error) { evidence.cleanupError = error.message; evidence.status = 'FAIL'; process.exitCode = 1; }
  evidence.finishedAt = new Date().toISOString(); save();
  console.log(JSON.stringify({ status: evidence.status, evidence: join(run.output, 'rollback-open.json'), error: evidence.error?.message }));
}
