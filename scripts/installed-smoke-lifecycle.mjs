import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { waitFor, withCleanup } from './smoke-runtime.mjs';

// No image-name kill, registry mutation or deletion of historical test directories.
export function command(command, args, timeoutMs = 10_000) {
  return new Promise((resolveResult, reject) => {
    const start = Date.now(), child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false, overflow = false;
    child.stdout.on('data', data => {
      if (stdout.length + data.length > 8 * 1024 * 1024) { overflow = true; child.kill(); }
      else stdout += data;
    });
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-128_000); });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      const result = { code, signal, timedOut, elapsedMs: Date.now() - start, stdout, stderr };
      if (timedOut || overflow || code !== 0) reject(new Error(`Command failed: ${command}; ${JSON.stringify({ ...result, stdout: stdout.slice(-2000), overflow })}`));
      else resolveResult(result);
    });
  });
}

export async function windowsProcesses() {
  const result = await command('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', String.raw`
$ErrorActionPreference='Stop'
$items=@(Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{
  pid=[int]$_.ProcessId; parentPid=[int]$_.ParentProcessId; name=$_.Name; path=$_.ExecutablePath; commandLine=if($_.Name -match 'CS2|Setup|Uninstall|^electron\.exe$'){$_.CommandLine}else{$null};
  created=$_.CreationDate.ToUniversalTime().ToString('o')
  workingSet=[long]$_.WorkingSetSize; peakWorkingSet=([long]$_.PeakWorkingSetSize * 1024)
} })
ConvertTo-Json -InputObject $items -Compress
`]);
  return JSON.parse(result.stdout);
}

export async function windowsRegistrations() {
  const result = await command('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', String.raw`
$ErrorActionPreference='Stop'
$items=@()
foreach($taskHive in @([Microsoft.Win32.RegistryHive]::CurrentUser,[Microsoft.Win32.RegistryHive]::LocalMachine)) {
 foreach($taskView in @([Microsoft.Win32.RegistryView]::Registry32,[Microsoft.Win32.RegistryView]::Registry64)) {
  $taskBase=[Microsoft.Win32.RegistryKey]::OpenBaseKey($taskHive,$taskView)
  try {
   $taskRoot=$taskBase.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Uninstall')
   if($taskRoot) { try { foreach($taskName in $taskRoot.GetSubKeyNames()) {
    $taskKey=$taskRoot.OpenSubKey($taskName)
    if($taskKey) { try { if($taskKey.GetValue('DisplayName') -like '*CS2 Analyst*') {
     $items += [pscustomobject]@{hive="$taskHive";view="$taskView";key=$taskName;displayName=$taskKey.GetValue('DisplayName');installLocation=$taskKey.GetValue('InstallLocation');uninstallString=$taskKey.GetValue('UninstallString');quietUninstallString=$taskKey.GetValue('QuietUninstallString')}
    } } finally { $taskKey.Dispose() } }
   } } finally { $taskRoot.Dispose() } }
  } finally { $taskBase.Dispose() }
 }
}
ConvertTo-Json -InputObject $items -Compress
`]);
  return JSON.parse(result.stdout);
}

export function assertNoConflicts(processes, registrations) {
  const apps = processes.filter(p => /^CS2 Analyst\.exe$/i.test(p.name) || /(?:CS2-Analyst.*Setup|Uninstall CS2 Analyst)\.exe$/i.test(p.name));
  assert.ok(apps.length === 0 && registrations.length === 0,
    `Existing CS2 Analyst installation/process conflict; preserved without changes. Close existing instances and manually inspect/uninstall the old installation before retrying. ${JSON.stringify({ processes: apps, registrations }, null, 2)}`);
}

const identity = p => `${p.pid}:${p.created}`;
/** Identity includes creation time, so recycled PIDs and unrelated same-name instances are excluded. */
export class ProcessScope {
  constructor({ snapshot = windowsProcesses, terminate = terminateIdentity, audit = () => {} } = {}) {
    this.snapshot = snapshot; this.terminate = terminate; this.audit = audit;
    this.owned = new Map(); this.roots = []; this.sessions = new Set();
  }
  track(child, label, startedAt) {
    assert.ok(Number.isFinite(startedAt), 'record startedAt before spawn; post-spawn timestamps can lose process ownership');
    const record = { child, label, pid: child.pid, startedAt, endedAt: null, error: null, stdout: '', stderr: '' };
    child.on('error', error => { record.error = error; });
    child.on('exit', () => { record.endedAt = Date.now(); });
    child.stdout?.on('data', data => { record.stdout = (record.stdout + data).slice(-128_000); });
    child.stderr?.on('data', data => { record.stderr = (record.stderr + data).slice(-128_000); });
    this.roots.push(record); this.audit({ stage: 'spawn', label, pid: child.pid, startedAt });
    return record;
  }
  observe(processes) {
    for (const root of this.roots) {
      const process = processes.find(p => p.pid === root.pid && Date.parse(p.created) >= root.startedAt && Date.parse(p.created) <= (root.endedAt ?? Infinity));
      if (process && !root.identity) { root.identity = identity(process); this.owned.set(root.identity, { ...process, endedAt: null }); }
    }
    const live = new Set(processes.map(identity));
    for (const [key, p] of this.owned) if (!live.has(key) && p.endedAt === null) p.endedAt = Date.now();
    // Keep parent records after exit: detached NSIS helpers retain their original parent PID.
    let changed;
    do {
      changed = false;
      for (const p of processes) {
        if (this.owned.has(identity(p))) continue;
        const parent = [...this.owned.values()].find(a => a.pid === p.parentPid && !processes.some(other => other.pid === a.pid && identity(other) !== identity(a)) && Date.parse(p.created) >= Date.parse(a.created) && Date.parse(p.created) <= (a.endedAt ?? Infinity));
        // A short-lived launcher may exit before the first CIM snapshot.
        const root = this.roots.find(a => !a.identity && a.pid === p.parentPid && Date.parse(p.created) >= a.startedAt && Date.parse(p.created) <= (a.endedAt ?? Infinity));
        if (parent || root) { this.owned.set(identity(p), { ...p, endedAt: null }); this.audit({ stage: 'descendant', process: p }); changed = true; }
      }
    } while (changed);
    return processes.filter(p => this.owned.has(identity(p)));
  }
  async live() { return this.observe(await this.snapshot()); }
  async cleanup() {
    const errors = [];
    for (const socket of this.sessions) socket.close();
    // Refresh before killing; never act on stale PID alone. Each identity is rechecked by terminate.
    const failed = new Set();
    try { await waitFor(async () => {
      const live = await this.live();
      if (!live.length) return true;
      for (const p of live.reverse()) {
        if (failed.has(identity(p))) continue;
        try { await this.terminate(p); this.audit({ stage: 'terminate', process: p }); }
        catch (error) {
          // NSIS helpers can exit between snapshot and opening a Process handle.
          // Ignore only a proved exit/recycled identity; a live denied process remains a failure.
          if ((await this.snapshot()).some(current => identity(current) === identity(p))) { failed.add(identity(p)); errors.push(error); }
          else this.audit({ stage: 'already-exited', process: p, diagnostic: error.message });
        }
      }
      return false;
    }, 15_000, 'owned process cleanup', { diagnostics: () => [...this.owned.values()] }); }
    catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'Owned process cleanup failed');
  }
}

async function terminateIdentity(p) {
  assert.ok(Number.isSafeInteger(p.pid) && p.pid > 0);
  assert.ok(Number.isFinite(Date.parse(p.created)));
  // Hold a Process handle and verify its start time before killing that exact process.
  const encoded = Buffer.from(JSON.stringify(p)).toString('base64');
  await command('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
$ErrorActionPreference='Stop'
$taskIdentity=([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | ConvertFrom-Json)
$taskProcess=Get-Process -Id $taskIdentity.pid -ErrorAction SilentlyContinue
if($taskProcess) { try {
 $taskHandle=$taskProcess.Handle
 if([Math]::Abs(($taskProcess.StartTime.ToUniversalTime() - [DateTime]::Parse($taskIdentity.created).ToUniversalTime()).TotalMilliseconds) -lt 1) { $taskProcess.Kill() }
} catch [System.InvalidOperationException] { } finally { $taskProcess.Dispose() } }
exit 0
`]);
}

export function directoryState(directory) {
  if (!existsSync(directory)) return { path: directory, exists: false };
  return { path: directory, exists: true, entries: readdirSync(directory).slice(0, 40) };
}

export function createOwnedRun(workspace) {
  const parent = join(realpathSync(workspace), '.tmp', 'installed-smoke-runs');
  mkdirSync(parent, { recursive: true });
  assert.equal(realpathSync(parent).toLowerCase(), resolve(parent).toLowerCase(), 'test parent must not be a junction/symlink');
  const directory = mkdtempSync(join(parent, 'run-')), token = randomUUID();
  writeFileSync(join(directory, '.smoke-owner.json'), JSON.stringify({ token, workspace: realpathSync(workspace), directory, createdAt: new Date().toISOString() }));
  return { directory, token, workspace: realpathSync(workspace) };
}

export function assertOwnedPath(run, target) {
  const rel = relative(run.directory, resolve(target));
  assert.ok(rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep) && !resolve(target).startsWith('\\\\'), 'target must be inside owned run');
  const marker = JSON.parse(readFileSync(join(run.directory, '.smoke-owner.json'), 'utf8'));
  assert.equal(marker.token, run.token); assert.equal(marker.directory, run.directory); assert.equal(marker.workspace, run.workspace);
  assert.equal(realpathSync(run.directory).toLowerCase(), resolve(run.directory).toLowerCase(), 'owned run must not be redirected');
  let current = resolve(target);
  const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  while (!samePath(current, run.directory)) {
    if (existsSync(current)) assert.equal(lstatSync(current).isSymbolicLink(), false, `refuse redirected path: ${current}`);
    const parent = dirname(current);
    assert.notEqual(parent, current, 'owned run ancestor not reached');
    current = parent;
  }
}

export async function runInstaller(scope, executable, args, { label, directory, timeoutMs = 120_000, audit = () => {} }) {
  assert.ok(existsSync(executable), `Missing installer/uninstaller: ${executable}`);
  const startedAt = Date.now();
  let child;
  try { child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (error) {
    const details = { stage: label, executable, args, elapsedMs: Date.now() - startedAt, launcherError: error.message, target: directoryState(directory) };
    audit(details);
    throw new Error(`${label} launcher error: ${JSON.stringify(details)}`, { cause: error });
  }
  const record = scope.track(child, label, startedAt);
  let success = false;
  return withCleanup(async () => {
    const result = await waitFor(async () => {
      await scope.live();
      if (record.error) throw new Error(`${label} launcher error: ${record.error.message}`, { cause: record.error });
      return child.exitCode !== null ? { code: child.exitCode } : null;
    }, timeoutMs, `${label} installer exit`, { diagnostics: () => ({ ...diagnostic(), owned: [...scope.owned.values()] }) });
    if (result.code !== 0) throw new Error(`${label} installer exit failed: ${JSON.stringify(diagnostic())}`);
    success = true;
    return result;
  }, [async () => { audit(diagnostic()); }, async () => { if (!success) await scope.cleanup(); }]);
  function diagnostic() { return { stage: label, executable, args, exitCode: child.exitCode, signal: child.signalCode, elapsedMs: Date.now() - startedAt, stdout: record.stdout, stderr: record.stderr, launcherError: record.error?.message, target: directoryState(directory) }; }
}
