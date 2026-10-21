// L5 native caption double-click: real Win32 mouse input on the frameless titlebar.
import assert from 'node:assert/strict';
import { execSync, spawn, spawnSync } from 'node:child_process';
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
const run = createOwnedQaRun('l5-caption', { parent: join(root, '.tmp') });
const evidence = { schemaVersion: 1, stage: 'L5-native-caption', startedAt: new Date().toISOString(), run,
  sourceRevision: execSync('git rev-parse HEAD', { cwd: root, encoding: 'utf8' }).trim(), build: 'dev electron .',
  physicalPointer: true, checks: [], status: 'RUNNING' };
const scope = new ProcessScope(); let child;
const save = () => writeFileSync(join(run.output, 'native-caption.json'), JSON.stringify(evidence, null, 2) + '\n');
const click = (x, y) => {
  const script = `Add-Type @"
using System;
using System.Runtime.InteropServices;
public class QaMouse {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  public struct POINT { public int X; public int Y; }
  public static void Focus(int pid) {
    var p = System.Diagnostics.Process.GetProcessById(pid);
    if (p.MainWindowHandle != IntPtr.Zero) SetForegroundWindow(p.MainWindowHandle);
    System.Threading.Thread.Sleep(400);
  }
  public static string DoubleClick(int x, int y) {
    POINT old; GetCursorPos(out old);
    SetCursorPos(x, y); System.Threading.Thread.Sleep(150);
    for (int i = 0; i < 2; i++) { mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero); mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero); System.Threading.Thread.Sleep(90); }
    SetCursorPos(old.X, old.Y);
    return old.X + "," + old.Y;
  }
  public static string SingleClick(int x, int y) {
    POINT old; GetCursorPos(out old);
    SetCursorPos(x, y); System.Threading.Thread.Sleep(150);
    mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero); mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);
    SetCursorPos(old.X, old.Y);
    return old.X + "," + old.Y;
  }
}
"@
[QaMouse]::DoubleClick(${x}, ${y})`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
const singleClick = (x, y) => {
  const script = `Add-Type @"
using System;
using System.Runtime.InteropServices;
public class QaMouse {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  public struct POINT { public int X; public int Y; }
  public static string SingleClick(int x, int y) {
    POINT old; GetCursorPos(out old);
    SetCursorPos(x, y); System.Threading.Thread.Sleep(150);
    mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero); mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);
    SetCursorPos(old.X, old.Y);
    return old.X + "," + old.Y;
  }
}
"@
[QaMouse]::SingleClick(${x}, ${y})`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
const focusApp = (pid) => {
  const script = `Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class QaFocus {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string cls, string title);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int max);
  public static IntPtr Found = IntPtr.Zero;
  public static bool ByPid(IntPtr h, IntPtr l) {
    uint p; GetWindowThreadProcessId(h, out p);
    if (p == (uint)l.ToInt64() && IsWindowVisible(h)) { Found = h; return false; }
    return true;
  }
  public static string Title(IntPtr h) { var s = new StringBuilder(256); GetWindowText(h, s, 256); return s.ToString(); }
  public static string Focus(int pid) {
    IntPtr h = FindWindow(null, "CS2 Analyst");
    if (h == IntPtr.Zero) { Found = IntPtr.Zero; EnumWindows(ByPid, new IntPtr(pid)); h = Found; }
    keybd_event(0x12, 0, 0, UIntPtr.Zero); keybd_event(0x12, 0, 2, UIntPtr.Zero);
    if (h != IntPtr.Zero) { ShowWindow(h, 9); SetForegroundWindow(h); }
    System.Threading.Thread.Sleep(600);
    var f = GetForegroundWindow(); uint fp; GetWindowThreadProcessId(f, out fp);
    return h + "," + f + "," + fp + "," + Title(f);
  }
}
"@
[QaFocus]::Focus(${pid})`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
try {
  const server = createServer(); await new Promise(done => server.listen(0, '127.0.0.1', done));
  const port = server.address().port; await new Promise(done => server.close(done));
  const env = { ...process.env, LOCALAPPDATA: run.localAppData };
  delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL; delete env.CS2_ANALYST_DEM_PATH; delete env.CS2_ANALYST_TEST_DEM_PATH;
  child = spawn(require('electron'), ['.', '--remote-debugging-port=' + port, '--user-data-dir=' + run.profile], { cwd: join(root, 'apps/desktop'), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const tracked = scope.track(child, 'L5 native caption', Date.now()); await scope.live();
  const target = await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(tracked.stderr);
    try { return (await (await fetch('http://127.0.0.1:' + port + '/json/list', { signal: AbortSignal.timeout(1000) })).json()).find(item => item.type === 'page'); }
    catch { return null; }
  }, 30_000, 'caption CDP');
  const page = await connectCdp(target.webSocketDebuggerUrl, 90_000); scope.sessions.add(page.socket);
  await waitFor(() => page.evaluate('Boolean(document.querySelector("[data-app-titlebar]"))'), 30_000, 'caption titlebar');
  await page.evaluate('void window.cs2Analyst.window.isMaximized()');
  await page.send('Page.bringToFront');
  await new Promise(resolve => setTimeout(resolve, 500));
  const point = async () => page.evaluate('(() => ({ x: Math.round(screenX + outerWidth * 0.25), y: Math.round(screenY + 20) }))()');
  evidence.childPid = child.pid;
  evidence.foreground = focusApp(child.pid);
  let p = await point(); evidence.normalPoint = p;
  singleClick(p.x, p.y);
  await new Promise(resolve => setTimeout(resolve, 700));
  const restoredCursor = click(p.x, p.y);
  evidence.cursorRestored = restoredCursor;
  await waitFor(() => page.evaluate('window.cs2Analyst.window.isMaximized()'), 7000, 'double-click maximize');
  evidence.maximizedAfterFirstDoubleClick = true;
  p = await point(); evidence.maximizedPoint = p;
  click(p.x, p.y);
  await waitFor(async () => (await page.evaluate('window.cs2Analyst.window.isMaximized()')) === false, 7000, 'double-click restore');
  evidence.restoredAfterSecondDoubleClick = true;
  const content = await page.evaluate('(() => ({ x: Math.round(screenX + outerWidth * 0.75), y: Math.round(screenY + outerHeight * 0.6) }))()');
  evidence.contentPoint = content;
  click(content.x, content.y);
  await new Promise(resolve => setTimeout(resolve, 700));
  assert.equal(await page.evaluate('window.cs2Analyst.window.isMaximized()'), false, 'content double-click must not maximize');
  evidence.contentDoubleClickDidNotMaximize = true;
  const control = await page.evaluate(`(() => { const r = document.querySelector('[data-nav-action="back"]').getBoundingClientRect();
    return { x: Math.round(screenX + r.left + r.width / 2), y: Math.round(screenY + r.top + r.height / 2) }; })()`);
  evidence.titlebarControlPoint = control;
  click(control.x, control.y);
  await new Promise(resolve => setTimeout(resolve, 700));
  assert.equal(await page.evaluate('window.cs2Analyst.window.isMaximized()'), false, 'titlebar control double-click must not maximize');
  evidence.controlDoubleClickDidNotMaximize = true;
  evidence.checks.push('real Win32 double-click on the frameless draggable titlebar maximized and restored the window');
  evidence.checks.push('a real double-click in client content did not toggle maximize (non-client hook is scoped)');
  evidence.checks.push('a real double-click on a titlebar no-drag control did not toggle maximize');
  evidence.status = 'PASS';
  // Native-message test; process teardown is delegated to the owned ProcessScope.
  evidence.forcedExit = 'deferred-to-scope-cleanup';
  page.socket.close(); scope.sessions.delete(page.socket);
} catch (error) {
  evidence.status = 'FAIL'; evidence.error = { message: error.message, stack: error.stack }; process.exitCode = 1;
} finally {
  if (child && child.exitCode === null) { try { child.kill('SIGKILL'); } catch { /* best effort */ } }
  try { await scope.cleanup(); } catch (error) { evidence.cleanupError = error.message; evidence.status = 'FAIL'; process.exitCode = 1; }
  evidence.finishedAt = new Date().toISOString(); save();
  console.log(JSON.stringify({ status: evidence.status, evidence: join(run.output, 'native-caption.json'), error: evidence.error?.message }));
}
