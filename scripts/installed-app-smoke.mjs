import { checkReportUx } from './report-ux-checks.mjs';
import { checkDeepReviewUx } from './deep-review-ux-checks.mjs';
import { checkHeatmapUx } from './heatmap-ux-checks.mjs';
import { dust2File, verifyDust2 } from '../apps/desktop/tests/heatmap-real-fixture.mjs';
import { checkWindowShell } from './window-shell-checks.mjs';
import { checkWindowsInstallBranding } from './windows-branding-checks.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import nativeParser from '../packages/demoparser-native/index.cjs';
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { closeApp, connectCdp, dropDiskFile, waitFor as waitForState, withCleanup } from './smoke-runtime.mjs';
import { assertNoConflicts, assertOwnedPath, createOwnedRun, directoryState, ProcessScope, runInstaller, windowsProcesses, windowsRegistrations } from './installed-smoke-lifecycle.mjs';

/**
 * Installed-app smoke for the Windows packaging MVP.
 *
 *   pnpm --filter @cs2-analyst/desktop pack:win        (production installer)
 *   pnpm --filter @cs2-analyst/desktop pack:win:test   (test-seam installer)
 *   pnpm --filter @cs2-analyst/desktop test:installed
 *
 * It silently installs each NSIS artifact into a fresh marked .tmp/installed-smoke-runs/run-*, inspects the
 * installed layout and app.asar, drives the packaged app over the Electron debugging
 * protocol, and uninstalls again. The production artifact is checked for the complete
 * absence of the test seam, so an installed production build cannot import an injected
 * DEM path.
 */

const root = fileURLToPath(new URL('../', import.meta.url));
const desktopDir = join(root, 'apps/desktop');
const demo = join(root, '.demo/demo1.dem');
let run, scope, workDir, brokenDemo, currentConnection;
const auditEvents = [];
function audit(event) {
  auditEvents.push({ at: new Date().toISOString(), ...event });
  if (workDir) writeFileSync(join(workDir, 'lifecycle.json'), JSON.stringify(auditEvents, null, 2));
}
async function prepareRun() {
  if (run) return;
  const [processes, registrations] = await Promise.all([windowsProcesses(), windowsRegistrations()]);
  assertNoConflicts(processes, registrations);
  run = createOwnedRun(root); workDir = run.directory; brokenDemo = join(workDir, 'broken.dem');
  scope = new ProcessScope({ audit });
  for (const [name, variant] of Object.entries(variants)) variant.installDir = join(workDir, 'app-' + name);
  writeFileSync(brokenDemo, 'this is not a cs2 demo');
  writeFileSync(join(workDir, 'not-demo.txt'), 'owned non-DEM fixture');
  audit({ stage: 'preflight', processes: processes.filter(p => p.name === APP_EXE), registrations });
  console.log('Installed smoke evidence directory: ' + workDir);
}

const version = JSON.parse(readFileSync(join(desktopDir, 'package.json'), 'utf8')).version;
const APP_EXE = 'CS2 Analyst.exe';
const UNINSTALLER = 'Uninstall CS2 Analyst.exe';
const SEAM_MARKER = 'CS2_ANALYST_TEST_DEM_PATH';
const NATIVE_TRIPLE = 'win32-x64-msvc';

const variants = {
  production: {
    label: '生产安装包',
    installer: join(root, 'release', version, 'CS2-Analyst-Setup-' + version + '.exe'),
    installDir: undefined,
  },
  'test-seam': {
    label: '测试 seam 安装包',
    installer: join(root, '.tmp/test-output', version, 'CS2-Analyst-TestSeam-Setup-' + version + '.exe'),
    installDir: undefined,
  },
};

/** P5.2.1 product polish: these tokens must never reach the rendered UI. */
const STIFF_ENGLISH = [/\bUtility\b/, /\bFlash\b/, /\bSmoke\b/, /\bHE\b/, /\bIncendiary\b/, /\bMolotov\b/, /\bDecoy\b/, /\bduration\b/i, /\btraded\b/i, /\btradeable\b/i, /可交易/, /被交易/, /\bwin\b/, /\bloss\b/];
function assertNoStiffEnglish(text) {
  for (const pattern of STIFF_ENGLISH) assert.ok(!pattern.test(text), 'UI 出现生硬英文或旧术语：' + pattern);
}

// ---------------------------------------------------------------- process helpers

async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

/** Processes still running from the installed app. Utility Process workers share the image name. */
async function appProcesses() { return (await scope.live()).filter(p => p.name.toLowerCase() === APP_EXE.toLowerCase()); }
async function killAppProcesses() { await scope.cleanup(); }
async function waitFor(probe, timeoutMs, label, options = {}) {
  return waitForState(probe, timeoutMs, label, { diagnostics: async () => ({
    processes: [...(scope?.owned.values() ?? [])].map(p => ({ pid: p.pid, parentPid: p.parentPid, name: p.name, created: p.created, endedAt: p.endedAt })),
    launches: scope?.roots.map(r => ({ label: r.label, pid: r.pid, exitCode: r.child.exitCode, error: r.error?.message, stderr: r.stderr.slice(-2000), stdout: r.stdout.slice(-2000) })),
    target: workDir ? directoryState(workDir) : null,
    ui: currentConnection?.socket.readyState === WebSocket.OPEN ? await currentConnection.evaluate(`({status:document.querySelector('main')?.dataset.status,selected:document.querySelector('[role=tab][aria-selected=true]')?.id,text:document.body.innerText.slice(-2000)})`).catch(error => ({ diagnosticError: error.message })) : null,
  }), ...options });
}

// ---------------------------------------------------------------- asar inspection

/** Minimal ASAR reader: the header is a pickle containing a JSON directory tree. */
function readAsar(archive) {
  const fd = openSync(archive, 'r');
  try {
    const sizeBuf = Buffer.alloc(8);
    readSync(fd, sizeBuf, 0, 8, 0);
    const headerSize = sizeBuf.readUInt32LE(4);
    const headerBuf = Buffer.alloc(headerSize);
    readSync(fd, headerBuf, 0, headerSize, 8);
    const jsonLength = headerBuf.readUInt32LE(4);
    const header = JSON.parse(headerBuf.subarray(8, 8 + jsonLength).toString('utf8'));
    const files = new Map();
    const walk = (node, prefix) => {
      for (const [name, value] of Object.entries(node.files ?? {})) {
        const entry = prefix ? prefix + '/' + name : name;
        if (value.files) walk(value, entry);
        else files.set(entry, value);
      }
    };
    walk(header, '');
    return { files, dataOffset: 8 + headerSize };
  } finally {
    closeSync(fd);
  }
}

function readAsarFile(archive, dataOffset, info) {
  const size = Number(info.size);
  const fd = openSync(archive, 'r');
  try {
    const buffer = Buffer.alloc(size);
    readSync(fd, buffer, 0, size, dataOffset + Number(info.offset));
    return buffer;
  } finally {
    closeSync(fd);
  }
}

// ---------------------------------------------------------------- install lifecycle

async function install(variant) {
  await prepareRun();
  assertOwnedPath(run, variant.installDir);
  assertNoConflicts(await windowsProcesses(), await windowsRegistrations());
  assert.ok(existsSync(variant.installer), '缺少安装包：' + variant.installer + '（先运行 pnpm --filter @cs2-analyst/desktop pack:win 和 pack:win:test）');
  const installerSize = (statSync(variant.installer).size / 1024 / 1024).toFixed(1);
  assert.equal(existsSync(variant.installDir), false, 'refuse to overwrite an existing installation directory: ' + variant.installDir);
  mkdirSync(variant.installDir, { recursive: true });
  variant.attempted = true;
  await runInstaller(scope, variant.installer, ['/S', '/D=' + variant.installDir], { label: variant.label + ' install', directory: variant.installDir, audit });
  await waitFor(() => existsSync(join(variant.installDir, APP_EXE)), 15_000, variant.label + ' 安装文件出现', { diagnostics: () => directoryState(variant.installDir) });
  variant.installed = true;
  console.log(variant.label + '：安装成功 → ' + variant.installDir + '（安装包 ' + installerSize + ' MB）');
}

async function uninstall(variant) {
  if (!variant.attempted) return;
  assertOwnedPath(run, variant.installDir);
  const uninstaller = join(variant.installDir, UNINSTALLER);
  // Partial install without an uninstaller is preserved for diagnosis; never delete it.
  assert.ok(existsSync(uninstaller), variant.label + ' 缺少卸载器：' + uninstaller);
  const entries = await windowsRegistrations();
  for (const entry of entries) assert.ok(entry.uninstallString?.toLowerCase().includes(uninstaller.toLowerCase()), 'Foreign registration appeared; preserve installation: ' + JSON.stringify(entry));
  await runInstaller(scope, uninstaller, ['/S', '/currentuser'], { label: variant.label + ' uninstall', directory: variant.installDir, audit });
  await waitFor(async () => !existsSync(join(variant.installDir, APP_EXE)) && (await scope.live()).length === 0 && (await windowsRegistrations()).length === 0, 120_000, variant.label + ' 卸载文件、进程与注册移除', { diagnostics: async () => ({ target: directoryState(variant.installDir), registrations: await windowsRegistrations(), processes: await scope.live() }) });
  variant.attempted = false;
  console.log(variant.label + '：卸载成功');
}

// ---------------------------------------------------------------- app driving

async function launchSession(exePath, extraEnv, label, applicationArgs = []) {
  await prepareRun();
  const port = await freePort();
  const profile = join(workDir, 'profile-' + auditEvents.length);
  assertOwnedPath(run, profile);
  const env = { ...process.env, ...extraEnv };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  const startedAt = Date.now();
  const child = spawn(exePath, [...applicationArgs, '--user-data-dir=' + profile, '--remote-debugging-port=' + port, '--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows'], { cwd: join(exePath, '..'), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const tracked = scope.track(child, label, startedAt);
  let logs = '';
  child.stdout.on('data', data => { logs += data; });
  child.stderr.on('data', data => { logs += data; });
  let socket;
  try {
    const page = await waitFor(async () => {
      await scope.live();
      if (tracked.error) throw new Error('应用启动器异常：' + tracked.error.message, { cause: tracked.error });
      if (child.exitCode !== null) throw new Error('应用提前退出：' + child.exitCode + ' ' + logs);
      try {
        const response = await fetch('http://127.0.0.1:' + port + '/json/list', { signal: AbortSignal.timeout(1000) });
        const targets = await response.json();
        const found = targets.find(target => target.type === 'page');
        return found?.webSocketDebuggerUrl ? found : null;
      } catch {
        return null;
      }
    }, 60_000, label + ' 打开调试端口', { diagnostics: () => ({ pid: child.pid, exitCode: child.exitCode, logs }) });

    const connection = await connectCdp(page.webSocketDebuggerUrl);
    currentConnection = connection;
    socket = connection.socket;
    scope.sessions.add(socket);
    const { send, evaluate } = connection, errors = [];
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.method === 'Runtime.exceptionThrown') errors.push(message.params);
    });
    await send('Runtime.enable');
    await send('Page.enable');

    const shell = await waitFor(async () => {
      const state = await evaluate('({ ready: document.readyState, text: document.body.textContent, node: typeof window.require, nodeProcess: typeof window.process, version: window.cs2Analyst?.version })');
      return state?.ready === 'complete' && state.text?.includes('CS2 Analyst') ? state : null;
    }, 60_000, label + ' React 页面');
    await checkWindowShell(evaluate, send);
    return { child, send, evaluate, errors, shell, socket };
  } catch (error) {
    socket?.close();
    return withCleanup(() => { throw new Error(label + ' 启动失败\n' + logs, { cause: error }); }, [() => scope.cleanup()]);
  }
}

async function clickSelectDemo(session) {
  const clicked = await session.evaluate("(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('选择 DEM')); b?.click(); return Boolean(b); })()");
  assert.equal(clicked, true, '未找到“选择 DEM”按钮');
}

async function closeGracefully(session) { return closeApp(session); }

/** Exercise the existing store's disk-File entry with a mounted report, without copying/mutating a private DEM. */
async function importReportDiskFile(session, filePath) {
  await withCleanup(async () => {
    await session.evaluate(`(() => {const i=document.createElement('input');i.id='qa-report-file';i.type='file';i.hidden=true;document.body.append(i);})()`);
    const { root } = await session.send('DOM.getDocument');
    const { nodeId } = await session.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#qa-report-file' });
    await session.send('DOM.setFileInputFiles', { nodeId, files: [filePath] });
    await session.evaluate(`(async() => {
      const node=document.querySelector('main');let root=node[Object.keys(node).find(k=>k.startsWith('__reactFiber$'))];while(root.return)root=root.return;
      const visit=f=>{if(!f)return null;for(let h=f.memoizedState;h;h=h.next)if(typeof h.memoizedState?.importDroppedFile==='function')return h.memoizedState;return visit(f.child)??visit(f.sibling);};
      const state=visit(root.stateNode.current);if(!state)throw new Error('Mounted report store not found');
      await state.importDroppedFile(document.getElementById('qa-report-file').files[0]);
    })()`);
  }, [() => session.evaluate(`document.getElementById('qa-report-file')?.remove()`)]);
}

// ---------------------------------------------------------------- checks

function checkInstalledLayout(variant, expectSeam) {
  const resources = join(variant.installDir, 'resources');
  assert.deepEqual(readFileSync(join(resources, 'branding/cs2-analyst-mark.png')),
    readFileSync(join(desktopDir, 'resources/branding/cs2-analyst-mark.png')), 'runtime mark must be the original PNG');
  const asar = join(resources, 'app.asar');
  assert.ok(existsSync(asar), '缺少 resources/app.asar');
  const asarSizeMb = statSync(asar).size / 1024 / 1024;
  assert.ok(asarSizeMb < 25, 'app.asar 体积异常（' + asarSizeMb.toFixed(1) + ' MB），可能打进了 monorepo 或测试数据');

  const { files, dataOffset } = readAsar(asar);
  const entries = [...files.keys()];
  for (const entry of entries) {
    assert.ok(entry === 'package.json' || entry.startsWith('dist/'), 'app.asar 含非应用内容：' + entry);
  }
  for (const required of ['dist/electron/main.js', 'dist/electron/report-worker.js', 'dist/electron/node_modules/@cs2-analyst/demoparser-native/index.cjs', 'dist/preload/index.cjs', 'dist/renderer/index.html']) {
    assert.ok(files.has(required), 'app.asar 缺少 ' + required);
  }
  const nativeRelative = 'dist/electron/node_modules/@cs2-analyst/demoparser-native/native/demoparser2.' + NATIVE_TRIPLE + '.node';
  const nativeEntries = entries.filter(entry => entry.endsWith('.node'));
  assert.deepEqual(nativeEntries, [nativeRelative], 'app.asar 应只登记一个原生绑定，且位于 worker 的 node_modules');
  assert.equal(files.get(nativeRelative).unpacked, true, '原生绑定必须以 unpacked 形式打包到 app.asar.unpacked');
  assert.ok(!entries.some(entry => entry.toLowerCase().includes('demo1.dem')), 'app.asar 不应包含测试 DEM');

  const native = join(resources, 'app.asar.unpacked', nativeRelative);
  assert.ok(existsSync(native), '缺少 unpacked 原生绑定：' + native);
  const built = nativeParser.getBindingProvenance();
  const binarySha = createHash('sha256').update(readFileSync(native)).digest('hex');
  assert.equal(binarySha, built.verifiedSha256, 'Installed binary differs from patched MSVC build');
  const installedProvenance = JSON.parse(readAsarFile(asar, dataOffset, files.get('dist/electron/node_modules/@cs2-analyst/demoparser-native/native/provenance.json')).toString('utf8'));
  assert.deepEqual(installedProvenance.source, built.source);
  assert.equal(installedProvenance.binary.sha256, binarySha);
  writeFileSync(join(workDir, 'native-'+(variant === variants.production ? 'production' : 'test-seam')+'.json'),JSON.stringify({path:native,sha256:binarySha,provenance:installedProvenance},null,2));
  const nativeMb = statSync(native).size / 1024 / 1024;
  assert.ok(nativeMb > 3, '原生绑定体积异常：' + nativeMb.toFixed(1) + ' MB');

  const mainSource = readAsarFile(asar, dataOffset, files.get('dist/electron/main.js')).toString('utf8');
  for (const option of ['frame: false', 'resizable: true', 'contextIsolation: true', 'nodeIntegration: false', 'sandbox: true']) {
    assert.ok(mainSource.includes(option), 'installed BrowserWindow missing ' + option);
  }
  assert.ok(mainSource.includes('window.removeMenu()'), 'installed window must remove native menu');
  assert.ok(!mainSource.includes('titleBarOverlay'), 'installed window must use custom caption buttons');
  const workerSource = readAsarFile(asar, dataOffset, files.get('dist/electron/report-worker.js')).toString('utf8');
  const rendererEntry = entries.find(entry => /^dist\/renderer\/assets\/index-.*\.js$/.test(entry));
  assert.ok(rendererEntry, '缺少 renderer bundle');
  const rendererSource = readAsarFile(asar, dataOffset, files.get(rendererEntry)).toString('utf8');

  const officialEntries = entries.filter(e => e.startsWith('dist/renderer/assets/') && e.endsWith('.svg'));
  const officialHashes = new Set(officialEntries.map(e => createHash('sha256').update(readAsarFile(asar, dataOffset, files.get(e))).digest('hex')));
  for (const folder of ['weapons', 'death-notice']) {
    const sourceDir = join(desktopDir, 'renderer/src/assets/killfeed', folder);
    for (const file of readdirSync(sourceDir).filter(f => f.endsWith('.svg'))) {
      const hash = createHash('sha256').update(readFileSync(join(sourceDir, file))).digest('hex');
      assert.ok(officialHashes.has(hash), 'ASAR missing unmodified official asset: ' + file);
    }
  }
  variant.officialAssetUrls = officialEntries.map(e => './' + e.slice('dist/renderer/'.length));
  console.log(variant.label + '：' + officialEntries.length + ' 个官方 SVG（Vite 按内容去重），与源文件字节一致');

  if (expectSeam) {
    assert.ok(mainSource.includes(SEAM_MARKER), '测试 seam 构建应包含 ' + SEAM_MARKER);
  } else {
    assert.ok(!mainSource.includes(SEAM_MARKER), '生产安装包不得包含路径注入 seam');
  }
  for (const forbidden of ['demoparser2', 'laihoe', '@cs2-analyst/analytics', '@cs2-analyst/dem-parser']) {
    assert.ok(!rendererSource.includes(forbidden), 'renderer bundle 不应包含 ' + forbidden);
  }
  assert.ok(workerSource.includes('@cs2-analyst/demoparser-native'), 'worker bundle 应引用原生 parser');
  assert.ok(!entries.some(e=>e.includes('@laihoe')), 'Installed package contains an official native fallback');
  for(const pkg of ['dem-parser','match-model','analytics','findings','deep-review','report-contract']) assert.ok(!workerSource.includes(`"@cs2-analyst/${pkg}"`), 'worker bundle 不应外部依赖领域 workspace 包');

  console.log(variant.label + '：asar ' + asarSizeMb.toFixed(2) + ' MB、' + entries.length + ' 个条目、原生绑定 ' + nativeMb.toFixed(1) + ' MB unpacked、renderer 无 Node/原生 parser');
}

function checkShortcut() {
  const candidates = [
    join(process.env.APPDATA ?? '', 'Microsoft/Windows/Start Menu/Programs/CS2 Analyst.lnk'),
    join(process.env.USERPROFILE ?? '', 'Desktop/CS2 Analyst.lnk'),
  ];
  const found = candidates.filter(candidate => candidate && existsSync(candidate));
  console.log('快捷方式：' + (found.length ? found.join('；') : '未在默认位置找到（可能被系统重定向）'));
}

// ---------------------------------------------------------------- scenarios

async function productionScenario() {
  const variant = variants.production;
  await withCleanup(async () => {
    await install(variant);
    checkInstalledLayout(variant, false);
    checkWindowsInstallBranding(variant, false);
    const exe = join(variant.installDir, APP_EXE);

    // 1. 正常启动 / Renderer 无 Node 暴露 / 正常关闭。
    const session = await launchSession(exe, {}, variant.label);
    assert.equal(session.shell.node, 'undefined', '渲染进程不应暴露 Node.js');
    assert.equal(session.shell.nodeProcess, 'undefined', '渲染进程不应暴露 process');
    assert.equal(session.shell.version, version, 'preload 桥接未加载');
    const loadedAssets = await session.evaluate(`Promise.all(${JSON.stringify(variant.officialAssetUrls)}.map(async src => { const i = new Image(); i.src = new URL(src, location.href).href; await i.decode(); return i.complete && i.naturalWidth > 0; }))`);
    assert.ok(loadedAssets.length > 0 && loadedAssets.every(Boolean), '生产安装版官方图片 URL 必须全部可加载');
    const exitCode = await closeGracefully(session);
    assert.equal(exitCode, 0, '关闭窗口后应用未正常退出');
    await waitFor(async () => (await appProcesses()).length === 0, 15_000, '应用进程退出');
    console.log(variant.label + '：启动、preload 桥接、无 Node 暴露、正常关闭通过');

    // 2. 环境变量注入在正式安装版必须无效：点击选择 DEM 后仍走原生对话框，不自动导入。
    await killAppProcesses();
    const injected = await launchSession(exe, { CS2_ANALYST_DEM_PATH: demo, CS2_ANALYST_TEST_DEM_PATH: demo }, variant.label + '（注入测试）');
    await clickSelectDemo(injected);
    await waitFor(async () => {
      const text = await injected.evaluate('document.body.textContent');
      return text?.includes('正在选择 DEM') ? text : null;
    }, 20_000, '选择阶段');
    // Observe the negative security property continuously for a bounded 15s window.
    const until = Date.now() + 15_000;
    while (Date.now() < until) {
      const status = await injected.evaluate('document.querySelector("main").dataset.status');
      assert.equal(status, 'selecting', 'production injection unexpectedly completed or failed');
      await delay(200);
    }
    const afterWait = await injected.evaluate('document.body.textContent');
    assert.ok(!afterWait.includes('twinkle') && !afterWait.includes('25 / 20 / 4'), '正式安装版不得接受注入的 DEM 路径');
    assert.ok(afterWait.includes('CS2 Analyst'), '页面不应白屏');
    await killAppProcesses();
    await waitFor(async () => (await appProcesses()).length === 0, 15_000, '强制结束应用进程');
    console.log(variant.label + '：注入 DEM 路径无效，正式安装版保留原生文件对话框');
    const disk = await launchSession(exe, {}, variant.label + '（磁盘 File）');
    assert.equal(await disk.evaluate('typeof window.cs2Analyst.importDemoFile'), 'undefined');
    assert.equal(await disk.evaluate('typeof window.cs2Analyst.getFilePath'), 'undefined');
    await dropDiskFile(disk, join(workDir, 'not-demo.txt'));
    await waitFor(() => disk.evaluate(`document.querySelector('main').dataset.status==='error'&&document.body.textContent.includes('请选择 .dem 文件')`), 10_000, 'production rejects non-DEM disk File');
    assert.equal((await appProcesses()).some(p => p.commandLine?.includes('node.mojom.NodeService')), false, 'non-DEM never starts a worker');
    await dropDiskFile(disk, demo);
    await waitFor(() => disk.evaluate(`document.querySelector('main').dataset.status==='success'&&document.body.textContent.includes('25 / 20 / 4')&&document.body.textContent.includes('91.38')`), 120_000, 'production recovers via disk File / real report');
    await checkReportUx(disk.evaluate, disk.send);
    assert.deepEqual(disk.errors, []);
    await closeGracefully(disk);
    await waitFor(async () => (await appProcesses()).length === 0, 20_000, 'production disk File worker cleanup');
    console.log(variant.label + '：真实磁盘 File、非 DEM 拒绝与恢复、报告和进程清理通过（CDP File，非 Explorer）');
    // Production uses the existing disk-backed File import; no DEM-path environment seam.
    const heatmap = await launchSession(exe, {}, variant.label + '（Dust2 热力图磁盘 File）');
    await dropDiskFile(heatmap, dust2File);
    await waitFor(() => heatmap.evaluate(`document.querySelector('main').dataset.status==='success'`), 120_000, 'production Dust2 File import');
    const heatmapQa = join(workDir, 'heatmap-production'); mkdirSync(heatmapQa);
    const result = await checkHeatmapUx(heatmap.evaluate, heatmap.send, { qaDir: heatmapQa, expectedDust2: true });
    writeFileSync(join(workDir, 'production-heatmap.json'), JSON.stringify(result, null, 2));
    await heatmap.evaluate(`document.getElementById('replay-tab').click()`);
    await waitFor(() => heatmap.evaluate(`Number(document.querySelector('#replay-panel canvas[role=img]')?.dataset.playerCount)>0`), 15_000, 'production Replay preserved after heatmap');
    assert.deepEqual(heatmap.errors, []);
    await closeGracefully(heatmap);
    await waitFor(async () => (await appProcesses()).length === 0, 20_000, 'production heatmap worker cleanup');
    audit({ stage: 'production-heatmap', status: 'PASS', cases: result.cases.length });
  }, [() => killAppProcesses(), () => uninstall(variant), () => killAppProcesses()]);
}

async function testSeamScenario() {
  const variant = variants['test-seam'];
  await withCleanup(async () => {
    await install(variant);
    checkInstalledLayout(variant, true);
    checkWindowsInstallBranding(variant, true);
    const exe = join(variant.installDir, APP_EXE);

    // 3. 真实 demo1.dem 全链路报告。
    const session = await launchSession(exe, { CS2_ANALYST_TEST_DEM_PATH: demo }, variant.label);
    await clickSelectDemo(session);
    const body = await waitFor(async () => {
      const text = await session.evaluate('document.body.textContent');
      return text?.includes('25 / 20 / 4') ? text : null;
    }, 300_000, variant.label + ' demo1 报告');
    for (const expected of ['de_dust2', '13 : 11', 'twinkle', '25 / 20 / 4', '91.38', '75%', '22.2%',
      'CT 方 ADR 明显低于 T 方', '死亡后队友补枪偏少', '本场多次闪到队友', 'R24 1v3 残局获胜',
      '本场首杀对决贡献突出', '重新选择 DEM']) {
      assert.ok(body.includes(expected), '报告缺少内容：' + expected);
    }
    const findingCount = await session.evaluate("document.querySelectorAll('[data-rule]').length");
    assert.equal(findingCount, 5, 'twinkle 应显示 5 条 Findings');
    assert.equal(await session.evaluate(`document.getElementById('report-tab').getAttribute('aria-selected')`), 'true');
    assert.equal(await session.evaluate(`document.getElementById('report-panel').hidden`), false);
    assert.equal(await session.evaluate(`document.querySelectorAll('[data-app-sidebar] [role="tab"]').length`), 6);
    await checkDeepReviewUx(session.evaluate, session.send);
    await session.evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '查看 R24').click()`);
    await waitFor(async () => session.evaluate(`!document.getElementById('timeline-panel').hidden`), 10_000, '安装版 Finding 切换 Timeline');
    await waitFor(async () => session.evaluate(`document.querySelector('[data-round-detail="24"]')?.textContent.includes('8888888888888888888888')`), 10_000, '安装版 Timeline 长数字昵称');
    await session.evaluate(`document.getElementById('analysis-tab').click()`);
    await waitFor(async () => session.evaluate(`!document.getElementById('analysis-panel').hidden`), 10_000, '安装版 Analysis Views');
    const analysis = await session.evaluate(`(() => {
      const rows = [...document.querySelectorAll('[data-comparison-player]')];
      return { count: rows.length, names: rows.map(r => r.textContent),
        rounds: document.querySelectorAll('[data-trend-round]').length,
        ct: document.querySelector('[data-analysis-side="CT"]').textContent,
        t: document.querySelector('[data-analysis-side="T"]').textContent };
    })()`);
    assert.equal(analysis.count, 10);
    assert.ok(analysis.names.some(name => name.includes('8888888888888888888888')), '安装版分析页保留长数字昵称');
    assert.equal(analysis.rounds, 24);
    assert.ok(analysis.ct.includes('10 / 10 / 3') && analysis.ct.includes('68.25'));
    assert.ok(analysis.t.includes('15 / 10 / 1') && analysis.t.includes('114.50'));
    await session.evaluate(`document.getElementById('report-tab').click()`);
    assert.equal(await session.evaluate(`document.querySelector('[data-round-summary="24"]').getAttribute('aria-expanded')`), 'true');
    await checkReportUx(session.evaluate, session.send);
    await session.evaluate(`document.querySelector('[aria-label="目标玩家"]').click()`);
    await waitFor(async () => session.evaluate(`([...document.querySelectorAll('[role="option"]')].some(o => o.textContent === '8888888888888888888888'))`), 10_000, '安装版 Dropdown 长数字昵称');
    console.log(variant.label + '：Analysis Views、Tab 状态保留、Timeline / Analysis / Dropdown 长数字昵称通过');
    await session.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    const previousPlayer = await session.evaluate(`document.querySelector('[aria-label="目标玩家"]').textContent`);
    await importReportDiskFile(session, brokenDemo);
    await waitFor(() => session.evaluate(`document.querySelector('main').dataset.status==='error'&&document.body.textContent.includes('无法分析此 DEM')`), 60_000, 'failed reimport error with old report');
    assert.equal(await session.evaluate(`document.querySelector('[aria-label="目标玩家"]').textContent`), previousPlayer);
    assert.equal(await session.evaluate(`document.querySelectorAll('[data-app-sidebar] [role=tab]').length`), 6, 'old report remains mounted');
    assert.ok(await session.evaluate(`document.body.textContent.includes('25 / 20 / 4')`));
    await session.evaluate(`document.getElementById('replay-tab').click()`);
    await waitFor(() => session.evaluate(`document.getElementById('replay-panel').textContent.includes('上一次回放会话已结束')`), 10_000, 'failed import retires old replay session');
    await waitFor(async () => !(await appProcesses()).some(p => p.commandLine?.includes('node.mojom.NodeService')), 20_000, 'failed reimport worker cleanup');
    await clickSelectDemo(session);
    await waitFor(() => session.evaluate(`document.querySelector('main').dataset.status==='success'&&document.getElementById('report-tab').getAttribute('aria-selected')==='true'`), 120_000, 'successful recovery after corrupt reimport');
    console.log(variant.label + '：导入失败保留旧报告和玩家、旧回放失效、worker 释放及重新导入恢复通过');
    assertNoStiffEnglish(body);
    assert.deepEqual(session.errors, [], '页面存在未捕获异常');
    const exitCode = await closeGracefully(session);
    assert.equal(exitCode, 0, '关闭窗口后应用未正常退出');
    await waitFor(async () => (await appProcesses()).length === 0, 20_000, '分析结束后无残留进程');
    console.log(variant.label + '：demo1 报告与开发环境一致（twinkle 25/20/4、ADR 91.38、KAST 75%、Trade 22.2%、R24 1v3 win、5 条 Findings）');
    const heatmap = await launchSession(exe, { CS2_ANALYST_TEST_DEM_PATH: dust2File }, variant.label + '（Dust2 热力图）');
    await clickSelectDemo(heatmap);
    await waitFor(() => heatmap.evaluate(`document.querySelector('main').dataset.status==='success'`), 120_000, 'test-seam Dust2 import');
    const heatmapQa = join(workDir, 'heatmap-test-seam'); mkdirSync(heatmapQa);
    const heatmapResult = await checkHeatmapUx(heatmap.evaluate, heatmap.send, { qaDir: heatmapQa, expectedDust2: true });
    writeFileSync(join(workDir, 'test-seam-heatmap.json'), JSON.stringify(heatmapResult, null, 2));
    const oldSession = await heatmap.evaluate(`document.querySelector('[data-heatmap-session]').dataset.heatmapSession`);
    await clickSelectDemo(heatmap);
    await waitFor(() => heatmap.evaluate(`document.querySelector('main').dataset.status==='success'&&document.getElementById('report-tab').getAttribute('aria-selected')==='true'&&document.querySelector('[data-heatmap-session]').dataset.heatmapSession!==${JSON.stringify(oldSession)}`), 120_000, 'installed heatmap session replacement');
    await heatmap.evaluate(`document.getElementById('heatmap-tab').click()`);
    await waitFor(() => heatmap.evaluate(`document.querySelector('#heatmap-panel canvas').width>1`), 15_000, 'replacement heatmap ready');
    // New session default state: position density ON, kill/death OFF.
    assert.deepEqual(await heatmap.evaluate(`[...document.querySelectorAll('#heatmap-panel button[aria-pressed]')].map(b=>b.getAttribute('aria-pressed'))`), ['true', 'false', 'false'], 'new session default: position ON, kills/deaths OFF');
    assert.deepEqual(heatmap.errors, []); await closeGracefully(heatmap);
    await waitFor(async () => (await appProcesses()).length === 0, 20_000, 'test-seam heatmap worker cleanup');
    audit({ stage: 'test-seam-heatmap', status: 'PASS', cases: heatmapResult.cases.length, replacement: 'PASS' });

    // 4. 分析进行中关闭应用不得残留 analysis worker。
    await killAppProcesses();
    const mid = await launchSession(exe, { CS2_ANALYST_TEST_DEM_PATH: demo }, variant.label + '（中途关闭）');
    await clickSelectDemo(mid);
    await waitFor(async () => {
      const text = await mid.evaluate('document.body.textContent');
      return text?.includes('正在后台解析 DEM') || text?.includes('正在生成指标') ? text : null;
    }, 60_000, variant.label + ' 进入解析阶段');
    await waitFor(async () => (await appProcesses()).some(p => p.commandLine?.includes('node.mojom.NodeService')), 30_000, variant.label + ' Utility Process 启动');
    assert.ok(['parsing', 'analyzing'].includes(await mid.evaluate(`document.querySelector('main').dataset.status`)), 'mid-close must still observe an in-flight analysis');
    const midExit = await closeGracefully(mid);
    assert.equal(midExit, 0, '分析中途关闭窗口应正常退出');
    await waitFor(async () => (await appProcesses()).length === 0, 20_000, variant.label + ' 无残留 analysis worker');
    console.log(variant.label + '：分析中途关闭应用后无残留 analysis worker');

    // 5. 损坏 DEM 仍显示错误且不白屏。
    await killAppProcesses();
    const broken = await launchSession(exe, { CS2_ANALYST_TEST_DEM_PATH: brokenDemo }, variant.label + '（损坏 DEM）');
    await clickSelectDemo(broken);
    const errorText = await waitFor(async () => {
      const text = await broken.evaluate('document.body.textContent');
      return text?.includes('无法分析此 DEM') ? text : null;
    }, 90_000, variant.label + ' 损坏 DEM 错误');
    assert.ok(errorText.includes('重新选择 DEM'), '错误后应保留重新选择入口');
    assert.ok(errorText.includes('CS2 Analyst'), '错误后页面不应白屏');
    assertNoStiffEnglish(errorText);
    await closeGracefully(broken);
    console.log(variant.label + '：损坏 DEM 显示错误且不白屏');
  }, [() => killAppProcesses(), () => uninstall(variant), () => killAppProcesses()]);
}

// ---------------------------------------------------------------- entry

export { install, uninstall, launchSession, closeGracefully, clickSelectDemo, checkInstalledLayout, appProcesses, variants, waitFor };

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  assert.ok(existsSync(demo), '缺少测试 DEM：' + demo);
  await verifyDust2();
  await prepareRun();
  // SIGINT/SIGTERM use the same owned-only cleanup; evidence survives interruption.
  let interrupted = false;
  const stop = async signal => {
    if (interrupted) return;
    interrupted = true;
    console.error('Installed smoke interrupted:', signal);
    try { await scope.cleanup(); } catch (error) { console.error(error); }
    process.exit(1);
  };
  const onInt = () => void stop('SIGINT'), onTerm = () => void stop('SIGTERM');
  process.once('SIGINT', onInt); process.once('SIGTERM', onTerm);
  await withCleanup(async () => {
    await productionScenario();
    await testSeamScenario();
    console.log('installed-app smoke 全部通过');
  }, [() => scope.cleanup(), () => { process.off('SIGINT', onInt); process.off('SIGTERM', onTerm); }]);
}
