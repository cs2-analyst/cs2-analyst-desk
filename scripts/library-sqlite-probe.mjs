// L0-only runtime experiment. This does not implement or initialize a user library.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const evidence = resolve(process.argv[2] ?? join(root, '.tmp/l0/sqlite-probe.json'));
mkdirSync(dirname(evidence), { recursive: true });
const owned = mkdtempSync(join(dirname(evidence), 'sqlite-run-'));
const resultPath = join(owned, 'result.json');
const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_RENDERER_URL;
const started = performance.now();
const child = spawn(require('electron'), [join(root, 'scripts/library-sqlite-electron.cjs'), owned, resultPath], {
  cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
});
let stdout = '', stderr = '';
child.stdout.on('data', data => { stdout = (stdout + data).slice(-128_000); });
child.stderr.on('data', data => { stderr = (stderr + data).slice(-128_000); });
const timeout = setTimeout(() => { child.kill(); }, 40_000);
let code;
try {
  code = await new Promise((res, rej) => { child.once('error', rej); child.once('close', res); });
} finally { clearTimeout(timeout); }
const result = JSON.parse(readFileSync(resultPath, 'utf8'));
const report = { schemaVersion: 1, experiment: 'L0 Electron Main/Utility node:sqlite file WAL',
  startedAt: new Date(Date.now() - (performance.now() - started)).toISOString(), elapsedMs: performance.now() - started,
  exitCode: code, ownedDirectory: owned, ...result, logs: { stdout, stderr },
  limitations: ['Development Electron executable; NSIS packaged/installed compatibility NOT RUN.',
    'Process termination exercises SQLite WAL recovery, not physical power-loss or filesystem durability guarantees.',
    'No user MatchLibrary, user settings, registry or DEM files accessed.'],
};
writeFileSync(evidence, JSON.stringify(report, null, 2) + '\n');
assert.equal(code, 0, JSON.stringify(report));
assert.equal(result.status, 'PASS');
console.log(JSON.stringify({ status: result.status, evidence, elapsedMs: report.elapsedMs,
  runtime: result.runtime, main: result.main, utility: result.utility, crashRecovery: result.crashRecovery }, null, 2));
