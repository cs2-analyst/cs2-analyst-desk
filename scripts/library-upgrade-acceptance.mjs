// L5 upgrade acceptance: install an L1 build, import a match, install the final build over it,
// reopen the old archive, then uninstall and verify the user library is retained.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOwnedQaRun, qaLaunchOptions } from './owned-qa-run.mjs';
import { connectCdp, waitFor, dropDiskFile } from './smoke-runtime.mjs';
import { ProcessScope, runInstaller, assertNoConflicts, windowsProcesses, windowsRegistrations } from './installed-smoke-lifecycle.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const previousInstaller = resolve(process.argv[2] ?? 'E:/cs2-analyst-l1/release/0.1.0/CS2-Analyst-Setup-0.1.0.exe');
const finalInstaller = resolve(process.argv[3] ?? 'release/0.1.0/CS2-Analyst-Setup-0.1.0.exe');
const fixture = resolve(process.argv[4] ?? 'E:/cs2-analyst/.demo/dust2.dem');
assert.match(fixture.replaceAll('\\', '/'), /\/(?:dust2|nuke|inferno|mirage|ancient|anubis|overpass|demo|demo1|demo2)\.dem$/);
const run = createOwnedQaRun('l5-upgrade', { parent: join(root, '.tmp') });
const installation = join(run.directory, 'upgrade-app');
const evidence = { schemaVersion: 1, stage: 'L5-upgrade', startedAt: new Date().toISOString(), run,
  previous: { path: previousInstaller, sha256: createHash('sha256').update(readFileSync(previousInstaller)).digest('hex') },
  final: { path: finalInstaller, sha256: createHash('sha256').update(readFileSync(finalInstaller)).digest('hex') },
  fixture: { fileName: fixture.split(/[\\/]/).at(-1) }, checks: [], status: 'RUNNING' };
const digest = value => createHash('sha256').update(value).digest('hex');
const withoutSession = value => JSON.parse(JSON.stringify(value, (key, item) => key === 'sessionId' ? undefined : item));
const scope = new ProcessScope(); let child, socket;
const save = () => writeFileSync(join(run.output, 'upgrade.json'), JSON.stringify(evidence, null, 2) + '\n');
async function launch() {
  const server = createServer(); await new Promise(done => server.listen(0, '127.0.0.1', done));
  const port = server.address().port; await new Promise(done => server.close(done));
  const options = qaLaunchOptions(run), env = { ...options.env };
  delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL; delete env.CS2_ANALYST_TEST_DEM_PATH; delete env.CS2_ANALYST_DEM_PATH;
  const startedAt = Date.now();
  const exe = join(installation, 'CS2 Analyst.exe');
  child = spawn(exe, [...options.applicationArgs, '--remote-debugging-port=' + port, '--disable-backgrounding-occluded-windows'],
    { cwd: dirname(exe), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const tracked = scope.track(child, 'L5 installed app', startedAt); await scope.live();
  const target = await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(tracked.stderr);
    try { return (await (await fetch('http://127.0.0.1:' + port + '/json/list', { signal: AbortSignal.timeout(1000) })).json()).find(item => item.type === 'page'); }
    catch { return null; }
  }, 30_000, 'L5 CDP');
  const page = await connectCdp(target.webSocketDebuggerUrl, 90_000); socket = page.socket; scope.sessions.add(socket);
  await waitFor(() => page.evaluate('Boolean(window.cs2Analyst?.library && (document.querySelector("[data-import-card]") || document.querySelector("[data-library-page]")))'), 30_000, 'installed preload');
  return { child, page, tracked };
}
async function close(current) {
  try { await current.page.evaluate('void window.cs2Analyst.window.close()'); } catch { /* CDP may disconnect first. */ }
  await waitFor(() => current.child.exitCode !== null, 15_000, 'installed close', { diagnostics: () => ({ stderr: current.tracked.stderr }) });
  current.page.socket.close(); scope.sessions.delete(current.page.socket);
}
const reportExpression = `(() => {const node=document.getElementById('heatmap-panel');let f=node[Object.keys(node).find(k=>k.startsWith('__reactFiber$'))];while(f&&!f.memoizedProps?.report)f=f.return;return f.memoizedProps.report;})()`;
try {
  assertNoConflicts(await windowsProcesses(), await windowsRegistrations());
  assert.ok(existsSync(previousInstaller) && existsSync(finalInstaller));
  assert.ok(!existsSync(installation));
  await runInstaller(scope, previousInstaller, ['/S', '/D=' + installation], { label: 'L5 install previous', directory: installation, audit: event => { evidence.checks.push('previous-install: ' + event.stage); } });
  evidence.previous.installed = existsSync(join(installation, 'CS2 Analyst.exe'));
  assert.equal(evidence.previous.installed, true);
  save();
  let app = await launch();
  await dropDiskFile(app.page, fixture);
  await waitFor(() => app.page.evaluate('document.querySelector("main")?.dataset.status === "success"'), 120_000, 'previous import', {
    diagnostics: () => app.page.evaluate('({status:document.querySelector("main")?.dataset.status,text:document.body.innerText.slice(-1000)})') });
  const oldReport = await app.page.evaluate(reportExpression);
  evidence.old = { matchId: oldReport.match.id, reportHash: digest(JSON.stringify(withoutSession(oldReport))) };
  const oldList = await app.page.evaluate('window.cs2Analyst.library.list()');
  assert.equal(oldList.total, 1);
  evidence.old.sourceRevision = oldList.entries[0].versions.sourceRevision;
  await close(app); app = null;
  evidence.checks.push('previous build imported and persisted a ready archive without the final build');
  save();
  await runInstaller(scope, finalInstaller, ['/S', '/D=' + installation], { label: 'L5 upgrade to final', directory: installation, audit: event => { evidence.checks.push('final-install: ' + event.stage); } });
  evidence.final.installed = existsSync(join(installation, 'CS2 Analyst.exe'));
  save();
  app = await launch();
  await waitFor(() => app.page.evaluate('document.querySelectorAll("[data-library-entry]").length === 1'), 30_000, 'upgraded library entry');
  const upgradedList = await app.page.evaluate('window.cs2Analyst.library.list()');
  assert.equal(upgradedList.kind, 'success'); assert.equal(upgradedList.total, 1); assert.equal(upgradedList.entries[0].matchId, evidence.old.matchId);
  evidence.upgradedEntry = { matchId: upgradedList.entries[0].matchId, state: upgradedList.entries[0].state, sourceRevision: upgradedList.entries[0].versions.sourceRevision };
  await app.page.evaluate('document.querySelector("[data-library-entry] button").click()');
  await waitFor(() => app.page.evaluate('document.querySelector("main")?.dataset.status === "success"'), 60_000, 'upgraded open', {
    diagnostics: () => app.page.evaluate('({status:document.querySelector("main")?.dataset.status,text:document.body.innerText.slice(-1000)})') });
  const newReport = await app.page.evaluate(reportExpression);
  evidence.upgraded = { matchId: newReport.match.id, reportHash: digest(JSON.stringify(withoutSession(newReport))) };
  assert.equal(newReport.match.id, evidence.old.matchId);
  assert.equal(evidence.upgraded.reportHash, evidence.old.reportHash, 'upgrade must not re-analyse or change the archived report');
  evidence.checks.push('final build listed and opened the previous build archive with an identical report fingerprint');
  await close(app); app = null;
  await runInstaller(scope, join(installation, 'Uninstall CS2 Analyst.exe'), ['/S', '/currentuser'], { label: 'L5 uninstall final', directory: installation, audit: event => { evidence.checks.push('uninstall: ' + event.stage); } });
  await waitFor(async () => !existsSync(join(installation, 'CS2 Analyst.exe')) && (await windowsRegistrations()).length === 0, 30_000, 'upgrade uninstall');
  const manifest = join(run.localAppData, 'CS2 Analyst', 'MatchLibrary', 'matches', evidence.old.matchId, 'manifest.json');
  assert.ok(existsSync(manifest));
  evidence.retainedManifestSha256 = createHash('sha256').update(readFileSync(manifest)).digest('hex');
  evidence.checks.push('uninstall preserved the user library archive');
  evidence.status = 'PASS';
} catch (error) {
  evidence.status = 'FAIL'; evidence.error = { message: error.message, stack: error.stack }; process.exitCode = 1;
} finally {
  if (child && child.exitCode === null) { try { child.kill('SIGKILL'); } catch { /* best effort */ } }
  try { await scope.cleanup(); } catch (error) { evidence.cleanupError = error.message; evidence.status = 'FAIL'; process.exitCode = 1; }
  evidence.finishedAt = new Date().toISOString(); save();
  console.log(JSON.stringify({ status: evidence.status, evidence: join(run.output, 'upgrade.json'), error: evidence.error?.message }));
}
