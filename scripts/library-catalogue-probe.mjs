// L0 experiment only. Synthetic directory scale is not evidence of 1,000 real matches.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { windowsProcesses } from './installed-smoke-lifecycle.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(process.argv[2] ?? join(root, '.tmp/l0/catalogue-probe.json'));
mkdirSync(dirname(output), { recursive: true });
const owned = mkdtempSync(join(dirname(output), 'catalogue-run-'));
const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const executable = require('electron'), host = join(root, 'scripts/library-catalogue-electron.cjs');
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
const report = { schemaVersion: 1, experiment: 'L0 synthetic SQLite first-page catalogue query', status: 'FAIL',
  startedAt: new Date().toISOString(), ownedDirectory: owned, datasets: [],
  method: 'Each measurement launches a fresh Electron Main process, opens a file database, selects summary columns ordered by indexed import time with LIMIT 50, serializes that page, and exits. No Utility or BrowserWindow is created by the experiment host.',
  limitations: ['10 and 1000 synthetic rows; not 1000 real matches or archives.',
    'Fresh application process for each observation; OS filesystem caches are not cleared, so this is not a cold-disk benchmark.',
    'No archive/payload directory or files exist; successful queries establish catalogue independence only, not a production library API or Renderer list acceptance.',
    'Development Electron runtime; packaged NSIS validation NOT RUN.'],
};
const quantiles = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return { count: sorted.length, method: 'nearest-rank empirical quantile', min: sorted[0], p50: sorted[Math.ceil(sorted.length * .5) - 1],
    p95: sorted[Math.ceil(sorted.length * .95) - 1], max: sorted.at(-1) };
};
let sequence = 0;
async function launch(mode, count, database) {
  const index = sequence++, resultPath = join(owned, `result-${index}.json`), profile = join(owned, `profile-${index}`);
  const startedAt = Date.now(), started = performance.now();
  const child = spawn(executable, [host, mode, String(count), database, resultPath, profile], {
    cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '', launchError, timedOut = false;
  child.stdout.on('data', data => { stdout = (stdout + data).slice(-16_000); });
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-16_000); });
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, 10_000);
  const code = await new Promise(resolveExit => {
    child.once('error', error => { launchError = { message: error.message, code: error.code }; });
    child.once('close', resolveExit);
  });
  clearTimeout(timer);
  let result;
  try { result = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, 'utf8')) : { status: 'FAIL', resultMissing: true }; }
  catch (error) { result = { status: 'FAIL', resultUnreadable: true, error: error.message }; }
  const observation = { pid: child.pid, startedAt: new Date(startedAt).toISOString(), exitCode: code,
    processStartThroughExitMs: performance.now() - started, timedOut, launchError: launchError ?? null, stdout, stderr, ...result };
  writeFileSync(join(owned, `observation-${index}.json`), JSON.stringify(observation, null, 2) + '\n');
  assert.equal(code, 0, JSON.stringify(observation)); assert.equal(timedOut, false, JSON.stringify(observation));
  assert.equal(result.status, 'PASS', JSON.stringify(observation));
  return observation;
}
const started = performance.now();
let failure;
try {
  for (const count of [10, 1000]) {
    const directory = join(owned, `data-${count}`); mkdirSync(directory);
    const database = join(directory, 'library.db'), seeded = await launch('seed', count, database), observations = [];
    for (let index = 0; index < 20; index++) observations.push(await launch('list', count, database));
    assert.ok(observations.every(observation => observation.firstPageHash === seeded.firstPageHash && observation.archiveFilesPresent === 0));
    assert.equal(new Set(observations.map(observation => observation.pid)).size, 20, 'Independent Main process identities');
    report.datasets.push({ simulatedRows: count, seed: seeded, observations,
      returnedRows: observations[0].returnedRows, listBytes: observations[0].listBytes, databaseBytes: observations[0].databaseBytes,
      timing: { processStartThroughExitMs: quantiles(observations.map(observation => observation.processStartThroughExitMs)),
        databaseOpenMs: quantiles(observations.map(observation => observation.timing.databaseOpenMs)),
        firstPageQueryMs: quantiles(observations.map(observation => observation.timing.firstPageQueryMs)),
        openThroughFirstPageMs: quantiles(observations.map(observation => observation.timing.openThroughFirstPageMs)) } });
  }
} catch (error) { failure = error; report.error = { message: error.message, stack: error.stack }; }
finally {
  // Read-only ownership audit. Normal process close or timeout's ChildProcess.kill ends only the launched Main.
  const remaining = (await windowsProcesses()).filter(process => process.commandLine?.includes(host) && process.commandLine.includes(owned));
  report.remainingOwnedProcesses = remaining;
  report.elapsedMs = performance.now() - started;
  report.status = failure || remaining.length ? 'FAIL' : 'PASS';
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  if (remaining.length && !failure) failure = new Error('Owned catalogue Electron processes remained after exit');
}
if (failure) throw failure;
console.log(JSON.stringify({ status: report.status, evidence: output, elapsedMs: report.elapsedMs,
  datasets: report.datasets.map(({ observations, seed, ...dataset }) => dataset) }, null, 2));
