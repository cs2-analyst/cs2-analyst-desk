// L0-only runtime experiment. This does not implement or initialize a user library.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProcessScope } from './installed-smoke-lifecycle.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const evidence = resolve(process.argv[2] ?? join(root, '.tmp/l0/sqlite-probe.json'));
mkdirSync(dirname(evidence), { recursive: true });
const owned = mkdtempSync(join(dirname(evidence), 'sqlite-run-'));
const resultPath = join(owned, 'result.json');
const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_RENDERER_URL;
// Optional experiment fault injection, never consumed by the Desktop application.
const timeoutMs = Number(process.env.CS2_ANALYST_SQLITE_PROBE_TIMEOUT_MS ?? 40_000);
assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 40_000);
const started = performance.now(), startedAt = Date.now(), scope = new ProcessScope();
const child = spawn(require('electron'), [join(root, 'scripts/library-sqlite-electron.cjs'), owned, resultPath], {
  cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
});
scope.track(child, 'L0 SQLite runtime probe', startedAt);
let stdout = '', stderr = '', timedOut = false, launchError, cleanupError;
child.stdout.on('data', data => { stdout = (stdout + data).slice(-128_000); });
child.stderr.on('data', data => { stderr = (stderr + data).slice(-128_000); });
const timeout = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
let code;
try {
  const closed = new Promise(res => {
    child.once('error', error => { launchError = { message: error.message, code: error.code }; });
    child.once('close', res);
  });
  await scope.live();
  code = await closed;
} finally {
  clearTimeout(timeout);
  try { await scope.cleanup(); } catch (error) { cleanupError = { message: error.message, stack: error.stack }; }
}
const remainingOwnedProcesses = await scope.live();
let result;
try { result = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, 'utf8'))
  : { status: 'FAIL', error: { message: 'Electron exited without producing a runtime result', resultMissing: true } }; }
catch (error) { result = { status: 'FAIL', error: { message: error.message, resultUnreadable: true } }; }
const report = { schemaVersion: 1, experiment: 'L0 Electron Main/Utility node:sqlite file WAL',
  startedAt: new Date(Date.now() - (performance.now() - started)).toISOString(), elapsedMs: performance.now() - started,
  exitCode: code, ownedDirectory: owned, ...result, logs: { stdout, stderr },
  processLifecycle: { timedOut, timeoutMs, launchError: launchError ?? null, cleanupError: cleanupError ?? null,
    resultExists: existsSync(resultPath), remainingOwnedProcesses },
  limitations: ['Development Electron executable; NSIS packaged/installed compatibility NOT RUN.',
    'Process termination exercises SQLite WAL recovery, not physical power-loss or filesystem durability guarantees.',
    'No user MatchLibrary, user settings, registry or DEM files accessed.'],
};
writeFileSync(evidence, JSON.stringify(report, null, 2) + '\n');
assert.equal(cleanupError, undefined, JSON.stringify(report));
assert.equal(remainingOwnedProcesses.length, 0, JSON.stringify(report));
assert.equal(timedOut, false, JSON.stringify(report));
assert.equal(code, 0, JSON.stringify(report));
assert.equal(result.status, 'PASS');
console.log(JSON.stringify({ status: result.status, evidence, elapsedMs: report.elapsedMs,
  runtime: result.runtime, main: result.main, utility: result.utility, crashRecovery: result.crashRecovery }, null, 2));
