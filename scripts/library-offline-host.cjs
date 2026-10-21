// Disposable L0 experiment host. Never registered in the production Electron build.
'use strict';
const assert = require('node:assert/strict');
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { gunzipSync } = require('node:zlib');
const hash = value => createHash('sha256').update(value).digest('hex');

if (process.parentPort) {
  const [snapshot, bundle] = process.argv.slice(2);
  const { createHeatmapSession, validateHeatmapRequest, validateHeatmapResult } = require(bundle);
  const manifest = JSON.parse(readFileSync(join(snapshot, 'manifest.json'), 'utf8'));
  const load = path => {
    const descriptor = manifest.files.find(file => file.path === path); assert.ok(descriptor);
    const compressed = readFileSync(join(snapshot, path));
    assert.equal(compressed.length, descriptor.gzipBytes); assert.equal(hash(compressed), descriptor.gzipSha256);
    const raw = gunzipSync(compressed, { maxOutputLength: descriptor.rawBytes });
    assert.equal(raw.length, descriptor.rawBytes); assert.equal(hash(raw), descriptor.sha256);
    return JSON.parse(raw.toString('utf8'));
  };
  const sessionId = randomUUID(), report = load('report.json.gz');
  const canonical = ['match', 'replay', 'spatial'].map(name => load(`heatmap/${name}.json.gz`));
  const beforeHeatmap = process.memoryUsage();
  const heatmap = createHeatmapSession(...canonical, sessionId);
  assert.ok(heatmap.session && heatmap.metadata.available, 'Existing production heap admission must pass');
  report.replay.sessionId = sessionId; report.heatmap = heatmap.metadata;
  process.parentPort.on('message', ({ data }) => {
    const { requestId, kind, request } = data;
    let result;
    if (kind === 'chunk') {
      const info = manifest.chunkIndex.find(chunk => chunk.round === request.round && chunk.block === request.block);
      if (!info || request.sessionId !== sessionId) result = { kind: 'error', message: '实验快照会话已失效。' };
      else {
        const chunk = load(info.path); chunk.sessionId = sessionId;
        assert.ok(Buffer.byteLength(JSON.stringify(chunk)) <= 1024 * 1024);
        result = { kind: 'success', chunk };
      }
    } else if (kind === 'heatmap') {
      result = validateHeatmapRequest(request, heatmap.metadata) ? heatmap.session.get(request)
        : { kind: 'error', message: '实验筛选请求无效。' };
      if (result.kind === 'success') assert.ok(validateHeatmapResult(result, request, heatmap.metadata));
    } else throw new Error('Unexpected experiment message');
    process.parentPort.postMessage({ requestId, result });
  });
  process.parentPort.postMessage({ kind: 'ready', report, pid: process.pid, runtime: process.versions,
    memory: { beforeHeatmap, afterHeatmap: process.memoryUsage(), gcForced: false } });
} else {
  const { app, BrowserWindow, ipcMain, utilityProcess } = require('electron');
  const [root, snapshot, bundle, out] = process.argv.slice(2);
  let window, worker, ready, currentId;
  const pending = new Map(), audit = { kind: 'L0 experiment bridge', imports: [], requests: [], releases: [], runtime: process.versions };
  let sequence = 0;
  const trusted = event => window && !window.isDestroyed() && event.sender === window.webContents
    && event.senderFrame === window.webContents.mainFrame;
  function stop() {
    for (const request of pending.values()) { clearTimeout(request.timer); request.resolve({ kind: 'error', message: '实验会话已结束。' }); }
    pending.clear();
    worker?.kill(); worker = null; ready = null; currentId = null;
  }
  function invoke(kind, request) {
    if (!worker || request?.sessionId !== currentId || pending.size >= 4) return { kind: 'error', message: '实验会话无效。' };
    return new Promise(resolve => {
      const requestId = ++sequence, start = performance.now();
      const timer = setTimeout(() => { pending.delete(requestId); resolve({ kind: 'error', message: '实验请求超时。' }); }, 15_000);
      pending.set(requestId, { timer, resolve, start, kind }); worker.postMessage({ requestId, kind, request });
    });
  }
  ipcMain.handle('window:minimize', event => { if (trusted(event)) window.minimize(); });
  ipcMain.handle('window:toggle-maximize', event => { if (trusted(event)) window.isMaximized() ? window.unmaximize() : window.maximize(); });
  ipcMain.handle('window:close', event => { if (trusted(event)) window.close(); });
  ipcMain.handle('window:is-maximized', event => trusted(event) && window.isMaximized());
  ipcMain.handle('report:cancel', () => {});
  for (const channel of ['session:release', 'replay:release']) ipcMain.handle(channel, (event, sessionId) => {
    if (trusted(event) && sessionId === currentId) { audit.releases.push(sessionId); stop(); }
  });
  ipcMain.handle('replay:chunk', (event, request) => trusted(event) ? invoke('chunk', request) : { kind: 'error', message: '拒绝' });
  ipcMain.handle('heatmap:grid', (event, request) => trusted(event) ? invoke('heatmap', request) : { kind: 'error', message: '拒绝' });
  ipcMain.handle('report:import', async event => {
    if (!trusted(event)) return { kind: 'error', message: '拒绝' };
    stop();
    const started = performance.now();
    ready = new Promise((resolve, reject) => {
      worker = utilityProcess.fork(__filename, [snapshot, bundle], { serviceName: 'L0 offline snapshot experiment', stdio: 'pipe' });
      const ownedWorker = worker;
      let initialized = false;
      const timer = setTimeout(() => { reject(new Error('Offline utility initialization timed out')); stop(); }, 30_000);
      worker.stderr?.on('data', data => process.stderr.write(data));
      worker.on('message', data => {
        if (ownedWorker !== worker) return;
        if (data.kind === 'ready') {
          initialized = true; clearTimeout(timer); currentId = data.report.replay.sessionId;
          audit.imports.push({ pid: data.pid, sessionId: currentId, readyMs: performance.now() - started, memory: data.memory });
          resolve({ kind: 'success', report: data.report });
        } else {
          const request = pending.get(data.requestId); if (!request) return;
          clearTimeout(request.timer); pending.delete(data.requestId);
          audit.requests.push({ kind: request.kind, ms: performance.now() - request.start, bytes: Buffer.byteLength(JSON.stringify(data.result)) });
          request.resolve(data.result);
        }
      });
      worker.on('exit', code => { if (!initialized) { clearTimeout(timer); reject(new Error(`Offline utility exited ${code}`)); } });
    });
    try { return await ready; } catch (error) { return { kind: 'error', message: error.message }; }
  });
  app.whenReady().then(async () => {
    window = new BrowserWindow({ width: 1024, height: 640, show: false, frame: false,
      webPreferences: { preload: join(root, 'apps/desktop/dist/preload/index.cjs'), contextIsolation: true,
        nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
    window.on('closed', () => { stop(); writeFileSync(join(out, 'host-audit.json'), JSON.stringify(audit, null, 2) + '\n'); app.quit(); });
    await window.loadFile(join(root, 'apps/desktop/dist/renderer/index.html'));
    // A hidden native window has no compositor frame for Page.captureScreenshot.
    window.showInactive();
  }).catch(error => { console.error(error); app.exit(1); });
  app.on('before-quit', stop);
}
