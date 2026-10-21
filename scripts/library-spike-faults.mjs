// L0 experiment: actual Windows file-lock failures against disposable snapshot copies.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, unlinkSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { digest, decodeVerified } from './library-spike-core.mjs';

const source = resolve(process.argv[2] ?? '.tmp/l0/evidence/dust2');
const destination = mkdtempSync(resolve('.tmp/l0/faults-'));
const manifest = JSON.parse(readFileSync(join(source, 'manifest.json'), 'utf8'));
const file = manifest.files.find(f => f.path.startsWith('replay/'));
const original = readFileSync(join(source, file.path));
const stored = join(destination, 'stored.gz'), staging = join(destination, 'staging.gz');
copyFileSync(join(source, file.path), stored);
writeFileSync(staging, original.subarray(0, Math.floor(original.length / 2)));
assert.throws(() => decodeVerified(readFileSync(staging), file));
assert.equal(digest(readFileSync(stored)), file.gzipSha256);

const quote = text => "'" + text.replaceAll("'", "''") + "'";
const command = `$stream = [System.IO.File]::Open(${quote(stored)}, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None); try { [Console]::WriteLine('LOCKED'); [Console]::ReadLine() | Out-Null } finally { $stream.Dispose() }`;
const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
let logs = '', deletionError, replacementError;
child.stderr.on('data', data => logs += data);
try {
  await new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error('File lock helper timeout ' + logs)), 10000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.stdout.on('data', data => { logs += data; if (logs.includes('LOCKED')) { clearTimeout(timer); done(); } });
    child.once('exit', code => { clearTimeout(timer); reject(new Error('File lock helper exited before ready: ' + code + ' ' + logs)); });
  });
  try { unlinkSync(stored); } catch (error) { deletionError = error.code; }
  assert.ok(['EBUSY', 'EACCES', 'EPERM'].includes(deletionError), `Expected actual Windows lock deletion failure: ${deletionError}`);
  try { renameSync(staging, stored); } catch (error) { replacementError = error.code; }
  assert.ok(['EBUSY', 'EACCES', 'EPERM'].includes(replacementError), `Expected actual Windows lock replacement failure: ${replacementError}`);
} finally {
  child.stdin.end('\n');
  if (child.exitCode === null) await once(child, 'exit');
}
assert.equal(child.exitCode, 0);
assert.equal(digest(readFileSync(stored)), file.gzipSha256, 'Existing valid snapshot survives interrupted staging and both actual file operation failures');
decodeVerified(readFileSync(stored), file);
const result = { status: 'PASS', scope: 'L0 experimental files, not production library crash-atomicity acceptance',
  interruptedStagingRejected: true, deletionError, replacementError, originalBytesUnchanged: true,
  sourceOriginalUnchanged: digest(readFileSync(join(source, file.path))) === file.gzipSha256,
  helperExitCode: child.exitCode, directory: destination };
writeFileSync(join(destination, 'result.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
