import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';
import { mainLibraryRequire, tick } from './library-main-fixture.mjs';
const require = createRequire(import.meta.url), { transformSync } = createRequire(require.resolve('vite'))('esbuild');
// store.ts now imports its pure navigation module with an explicit .ts extension.
const storeRequire = createRequire(new URL('../renderer/src/store.ts', import.meta.url));
async function harness() {
  const handlers = new Map(), workers = [], windows = [];
  class Window extends EventEmitter { constructor() { super(); this.webContents = Object.assign(new EventEmitter(), { mainFrame: {}, send() {}, setWindowOpenHandler() {} }); windows.push(this); } isDestroyed() { return false; } removeMenu() {} async loadFile() {} close() { this.emit('closed'); } static getAllWindows() { return windows; } }
  const app = Object.assign(new EventEmitter(), { whenReady: () => Promise.resolve(), setAppUserModelId() {}, isPackaged: false });
  const electron = { app, BrowserWindow: Window, dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) }, ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, utilityProcess: { fork: () => { const worker = Object.assign(new EventEmitter(), { sent: [], killed: false, postMessage(v) { this.sent.push(v); }, kill() { this.killed = true; this.emit('exit', 0); } }); workers.push(worker); return worker; } } };
  const file = new URL('../electron/main.ts', import.meta.url), code = transformSync(readFileSync(file, 'utf8'), { loader: 'ts', format: 'cjs', define: { 'import.meta.url': JSON.stringify(file.href), '__CS2_ANALYST_TEST_SEAM__': 'false' } }).code;
  vm.runInNewContext(code, { require: n => n === 'electron' ? electron : mainLibraryRequire(n, require), process: { platform: 'win32', env: {} }, console, URL, Buffer, AbortController, setTimeout, clearTimeout });
  await new Promise(r => setImmediate(r));
  const window = windows[0], trusted = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  // Drive the analyze handshake so an accepted path really produces a report.
  const finish = async promise => {
    await tick();
    const worker = workers.at(-1); worker.emit('spawn');
    const sessionId = worker.sent[0].sessionId;
    worker.emit('message', { kind: 'prepared', receipt: {}, report: { schemaVersion: 2, replay: { available: true, sessionId, matchId: 'match', rounds: [{ round: 1, blocks: [{ index: 0 }] }] } } });
    return { result: await promise, sessionId };
  };
  return { handlers, workers, window, trusted, finish };
}
test('dragged DEM import guards sender/frame/path shape and reuses the shared analyze pipeline', async () => {
  const h = await harness();
  for (const event of [{ sender: {}, senderFrame: h.trusted.senderFrame }, { sender: h.trusted.sender, senderFrame: {} }, {}]) {
    assert.equal((await h.handlers.get('report:import-file')(event, 'C:\\demo.dem')).kind, 'error', 'untrusted frames are rejected');
  }
  for (const path of [null, 42, {}, [], '', '   ', 'relative.dem', '../demo.dem']) {
    assert.equal((await h.handlers.get('report:import-file')(h.trusted, path)).kind, 'error', `rejected path: ${String(path)}`);
  }
  assert.equal(h.workers.length, 0, 'invalid paths never spawn an analyze worker');
  const wrongExt = await h.handlers.get('report:import-file')(h.trusted, 'C:\\demo.txt');
  assert.equal(wrongExt.kind, 'error');
  assert.equal(wrongExt.message, '请选择 .dem 文件。');
  assert.equal(h.workers.length, 0, 'non-.dem extension never spawns an analyze worker');
  const { result, sessionId } = await h.finish(h.handlers.get('report:import-file')(h.trusted, 'C:\\match\\demo.dem'));
  assert.equal(result.kind, 'success', 'absolute .dem path runs the same pipeline as the dialog');
  assert.equal(result.report.replay.sessionId, sessionId);
  h.window.close();
});
test('a dragged import and a dialog import never run at the same time', async () => {
  const h = await harness();
  const pending = h.handlers.get('report:import-file')(h.trusted, 'C:\\demo.dem');
  const busy = await h.handlers.get('report:import')(h.trusted);
  assert.equal(busy.kind, 'error'); assert.equal(busy.message, '已有分析任务正在运行。');
  const busyFile = await h.handlers.get('report:import-file')(h.trusted, 'C:\\demo2.dem');
  assert.equal(busyFile.kind, 'error'); assert.equal(busyFile.message, '已有分析任务正在运行。');
  await h.finish(pending);
  h.window.close();
});

test('preload resolves Files privately and never exposes a path import capability', async () => {
  let api;
  const calls = [], diskFile = {}, textFile = {}, syntheticFile = {};
  const code = transformSync(readFileSync(new URL('../preload/index.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'cjs' }).code;
  vm.runInNewContext(code, { require: () => ({
    contextBridge: { exposeInMainWorld: (_, value) => { api = value; } },
    ipcRenderer: { invoke: async (channel, path) => { calls.push({ channel, path }); return { kind: 'success' }; } },
    webUtils: { getPathForFile: file => {
      if (file === diskFile) return 'C:\\match\\demo.dem';
      if (file === textFile) return 'C:\\match\\notes.txt';
      if (file === syntheticFile) return '';
      throw new TypeError('Not a File');
    } },
  }) });
  assert.deepEqual(Object.keys(api).sort(), ['library', 'cancelImport', 'importDemo', 'importDroppedFile', 'selectImportPlayer', 'onImportPlayers', 'onProgress', 'replay', 'heatmap', 'session', 'version', 'window'].sort());
  for (const input of [syntheticFile, 'C:\\arbitrary.dem', { path: 'C:\\arbitrary.dem' }, null]) {
    const result = await api.importDroppedFile(input);
    assert.equal(result.kind, 'error');
    assert.match(result.message, /无法读取拖入文件的位置/);
  }
  assert.equal(calls.length, 0, 'unresolved Files never reach IPC');
  assert.equal((await api.importDroppedFile(diskFile)).kind, 'success');
  await api.importDroppedFile(textFile); // Main owns the extension gate, tested above.
  assert.deepEqual(calls, [{ channel: 'report:import-file', path: 'C:\\match\\demo.dem' }, { channel: 'report:import-file', path: 'C:\\match\\notes.txt' }]);
});

test('failed, cancelled and exited imports clean up their worker and release the import lock', async () => {
  const h = await harness();
  for (const outcome of ['error', 'cancelled', 'exit']) {
    const pending = h.handlers.get('report:import-file')(h.trusted, 'C:\\demo.dem');
    await tick();
    const worker = h.workers.at(-1);
    if (outcome === 'cancelled') await h.handlers.get('report:cancel')(h.trusted);
    else if (outcome === 'exit') worker.emit('exit', 1);
    else worker.emit('message', { kind: 'error', message: 'fixture parse failure' });
    assert.equal((await pending).kind, outcome === 'cancelled' ? 'cancelled' : 'error');
    assert.equal(worker.killed, outcome !== 'exit', 'already exited workers need no second kill');
    const { result } = await h.finish(h.handlers.get('report:import-file')(h.trusted, 'C:\\next.dem'));
    assert.equal(result.kind, 'success', 'the next import can recover');
  }
  h.window.close();
});

test('renderer preserves report and player on drop failure/cancel and ignores duplicate/late requests', async () => {
  let complete, calls = 0;
  const bridge = { importDroppedFile: () => { calls++; return new Promise(resolve => { complete = resolve; }); } };
  const module = { exports: {} };
  const code = transformSync(readFileSync(new URL('../renderer/src/store.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'cjs' }).code;
  vm.runInNewContext(code, { require: storeRequire, module, window: { cs2Analyst: bridge } });
  const store = module.exports.useReport;
  const report = { selectedPlayer: 'p1', players: [{ id: 'p1' }], replay: { available: true, sessionId: 'old' } };
  store.setState({ status: 'success', report, playerId: 'p1' });
  for (const result of [{ kind: 'error', message: 'unresolved' }, { kind: 'cancelled' }]) {
    const pending = store.getState().importDroppedFile({});
    await store.getState().importDroppedFile({});
    assert.equal(calls, result.kind === 'error' ? 1 : 2);
    complete(result); await pending;
    assert.equal(store.getState().report, report);
    assert.equal(store.getState().playerId, 'p1');
    store.getState().setPhase('analyzing');
    assert.equal(store.getState().status, result.kind === 'error' ? 'error' : 'success');
  }
  const pending = store.getState().importDroppedFile({});
  store.getState().setPhase('parsing');
  assert.equal(store.getState().report.replay.available, true, 'the previous session remains usable until durable candidate success');
  complete({ kind: 'cancelled' }); await pending;
  assert.equal(store.getState().report.replay.available, true);
  const next = { ...report, selectedPlayer: 'p2' };
  const success = store.getState().importDroppedFile({});
  complete({ kind: 'success', report: next }); await success;
  assert.equal(store.getState().report, next);
  assert.equal(store.getState().playerId, 'p2');
});

test('rejected dialog/File IPC promises preserve report, target and replay before parsing; recovery accepts a new report', async () => {
  for (const method of ['importDemo', 'importDroppedFile']) {
    let reject, resolve;
    const bridge = { [method]: () => new Promise((ok, fail) => { resolve = ok; reject = fail; }) };
    const module = { exports: {} };
    const code = transformSync(readFileSync(new URL('../renderer/src/store.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'cjs' }).code;
    vm.runInNewContext(code, { require: storeRequire, module, window: { cs2Analyst: bridge } });
    const store = module.exports.useReport;
    const report = { selectedPlayer: 'a', players: [{ id: 'a' }, { id: 'b' }], replay: { available: true, sessionId: 'old' } };
    store.setState({ status: 'success', report, playerId: 'b' });
    const pending = store.getState()[method]({});
    reject(new Error('IPC disconnected')); await pending;
    assert.equal(store.getState().status, 'error');
    assert.match(store.getState().error, /桌面分析连接失败/);
    assert.equal(store.getState().report, report); assert.equal(store.getState().playerId, 'b');
    assert.equal(store.getState().report.replay.sessionId, 'old');
    store.getState().selectPlayer('unknown'); assert.equal(store.getState().playerId, 'b');
    const retry = store.getState()[method]({});
    store.getState().setPhase('parsing');
    assert.equal(store.getState().report.replay.available, true);
    const next = { ...report, selectedPlayer: 'a', replay: { available: true, sessionId: 'new' } };
    resolve({ kind: 'success', report: next }); await retry;
    assert.equal(store.getState().status, 'success'); assert.equal(store.getState().report, next);
    assert.equal(store.getState().playerId, 'a'); assert.equal(store.getState().report.replay.sessionId, 'new');
  }
});

test('only successful imports advance the UI revision, including reimporting the same match through either entry', async () => {
  for (const method of ['importDemo', 'importDroppedFile']) {
    let complete;
    const bridge = { [method]: () => new Promise(resolve => { complete = resolve; }) };
    const module = { exports: {} };
    const code = transformSync(readFileSync(new URL('../renderer/src/store.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'cjs' }).code;
    vm.runInNewContext(code, { require: storeRequire, module, window: { cs2Analyst: bridge } });
    const store = module.exports.useReport;
    const report = { match: { id: 'same-match' }, selectedPlayer: 'a', players: [{ id: 'a' }], replay: { available: true, sessionId: 'old' } };
    store.setState({ status: 'success', report, reportRevision: 7, playerId: 'a' });
    for (const result of [{ kind: 'cancelled' }, { kind: 'error', message: 'parse failed' }]) {
      const pending = store.getState()[method]({});
      store.getState().setPhase('parsing');
      assert.equal(store.getState().reportRevision, 7);
      complete(result); await pending;
      assert.equal(store.getState().reportRevision, 7, 'cancel/error preserves report navigation identity');
    }
    for (const revision of [8, 9]) {
      const pending = store.getState()[method]({});
      complete({ kind: 'success', report }); await pending;
      assert.equal(store.getState().reportRevision, revision, 'same match still starts a fresh UI report');
    }
  }
});

test('candidate parsing and failure preserve the previous heatmap-only session identity', async () => {
  let complete;
  const bridge={importDemo:()=>new Promise(resolve=>{complete=resolve;})},module={exports:{}};
  const code=transformSync(readFileSync(new URL('../renderer/src/store.ts',import.meta.url),'utf8'),{loader:'ts',format:'cjs'}).code;
  vm.runInNewContext(code,{require:storeRequire,module,window:{cs2Analyst:bridge}});
  const store=module.exports.useReport;
  const heatmap={available:true,sessionId:'old',layers:Object.fromEntries(['positions','kills','deaths'].map(layer=>[layer,{available:true,unavailableReason:null}]))};
  const report={selectedPlayer:'p1',players:[{id:'p1'}],heatmap};
  store.setState({status:'success',report,playerId:'p1'});
  let pending=store.getState().importDemo();complete({kind:'cancelled'});await pending;
  assert.equal(store.getState().report,report);
  pending=store.getState().importDemo();store.getState().setPhase('parsing');
  assert.equal(store.getState().report.heatmap.available,true);
  for(const layer of Object.values(store.getState().report.heatmap.layers))assert.equal(layer.available,true);
  complete({kind:'error',message:'corrupt'});await pending;
  assert.equal(store.getState().report.heatmap.available,true);assert.equal(heatmap.available,true);
});