import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import vm from 'node:vm';
import { mainLibraryRequire } from './library-main-fixture.mjs';

const require = createRequire(import.meta.url), { transformSync } = createRequire(require.resolve('vite'))('esbuild');

async function harness({ documents, userData, env = {}, packaged = false } = {}) {
  const handlers = new Map(), workers = [], windows = [], dialogs = [];
  let dialogResult = { canceled: true, filePaths: [] };
  class Window extends EventEmitter {
    constructor() {
      super();
      this.webContents = Object.assign(new EventEmitter(), { mainFrame: {}, send() {}, setWindowOpenHandler() {} });
      windows.push(this);
    }
    isDestroyed() { return false; }
    removeMenu() {}
    async loadFile() {}
    close() { this.emit('closed'); }
    static getAllWindows() { return windows; }
  }
  const app = Object.assign(new EventEmitter(), {
    whenReady: () => Promise.resolve(), setAppUserModelId() {}, isPackaged: packaged,
    getPath: name => name === 'documents' ? documents : name === 'userData' ? userData : undefined,
  });
  const electron = {
    app, BrowserWindow: Window,
    dialog: { showOpenDialog: async (_window, options) => { dialogs.push(options); return dialogResult; } },
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    utilityProcess: { fork: () => { const worker = Object.assign(new EventEmitter(), { sent: [], killed: false, postMessage(v) { this.sent.push(v); }, kill() { this.killed = true; this.emit('exit',0); } }); workers.push(worker); return worker; } },
  };
  const source = new URL('../electron/main.ts', import.meta.url);
  const code = transformSync(readFileSync(source, 'utf8'), { loader: 'ts', format: 'cjs', define: {
    'import.meta.url': JSON.stringify(source.href), '__CS2_ANALYST_TEST_SEAM__': 'false',
  } }).code;
  vm.runInNewContext(code, { require: name => name === 'electron' ? electron : mainLibraryRequire(name, require), process: { platform: 'win32', env, resourcesPath: join(userData, 'resources') }, console, URL, Buffer, AbortController, setTimeout, clearTimeout });
  await new Promise(resolve => setImmediate(resolve));
  const window = windows[0], trusted = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  const finish = async promise => {
    // Directory persistence awaits the real filesystem before the worker is forked.
    // Each successful import owns a fresh worker; never reuse a previous retained worker.
    let worker = workers.find(candidate => !candidate.__finished);
    for (let attempt = 0; attempt < 100 && !worker; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 5));
      worker = workers.find(candidate => !candidate.__finished);
    }
    if (!worker) throw new Error('analyze worker was never forked');
    worker.__finished = true;
    worker.emit('spawn');
    const sessionId = worker.sent[0].sessionId;
    worker.emit('message', { kind: 'prepared', receipt: {}, report: { schemaVersion: 2, replay: { available: true, sessionId, matchId: 'match', rounds: [{ round: 1, blocks: [{ index: 0 }] }] } } });
    const result = await promise;
    // Let the handler's finally clear the module-level import lock before the next call.
    await new Promise(resolve => setTimeout(resolve, 0));
    return result;
  };
  return { handlers, trusted, dialogs, workers, finish, setDialog: result => { dialogResult = result; }, window };
}

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function readSettings(userData, expected) {
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      const parsed = JSON.parse(readFileSync(join(userData, 'demo-settings.json'), 'utf8'));
      if (expected === undefined || parsed.lastDemoDirectory === expected) return parsed;
    } catch { /* The background write has not landed yet. */ }
    await pause(5);
  }
  throw new Error('demo settings were never written');
}

const roots = [];
function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), 'cs2-analyst-import-dir-'));
  roots.push(root);
  return root;
}
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

test('DEM chooser starts at Documents, remembers the selected folder, survives cancel and falls back when stale', async () => {
  const root = tempRoot(), documents = join(root, 'Documents'), userData = join(root, 'userData');
  const first = join(root, 'first'), second = join(root, 'second');
  for (const directory of [documents, userData, first, second]) mkdirSync(directory, { recursive: true });
  const h = await harness({ documents, userData });
  const dialogImport = async () => {
    const pending = h.handlers.get('report:import')(h.trusted);
    return await h.finish(pending);
  };
  h.setDialog({ canceled: false, filePaths: [join(first, 'one.dem')] });
  assert.equal((await dialogImport()).kind, 'success');
  assert.equal(h.dialogs.at(-1).defaultPath, documents, 'first dialog defaults to Documents');
  assert.deepEqual(await readSettings(userData, first), { lastDemoDirectory: first });
  h.setDialog({ canceled: false, filePaths: [join(second, 'two.dem')] });
  await dialogImport();
  assert.equal(h.dialogs.at(-1).defaultPath, first, 'the next dialog uses the remembered folder');
  assert.equal((await readSettings(userData, second)).lastDemoDirectory, second);
  // A fresh app process with the same userData keeps the remembered folder.
  const restarted = await harness({ documents, userData });
  restarted.setDialog({ canceled: true, filePaths: [] });
  await restarted.handlers.get('report:import')(restarted.trusted);
  assert.equal(restarted.dialogs.at(-1).defaultPath, second, 'the remembered folder survives an application restart');
  restarted.window.close();
  const before = readFileSync(join(userData, 'demo-settings.json'), 'utf8');
  h.setDialog({ canceled: true, filePaths: [] });
  assert.equal((await h.handlers.get('report:import')(h.trusted)).kind, 'cancelled');
  assert.equal(readFileSync(join(userData, 'demo-settings.json'), 'utf8'), before, 'cancel never overwrites the remembered folder');
  writeFileSync(join(userData, 'demo-settings.json'), JSON.stringify({ lastDemoDirectory: join(root, 'removed') }));
  h.setDialog({ canceled: true, filePaths: [] });
  await h.handlers.get('report:import')(h.trusted);
  assert.equal(h.dialogs.at(-1).defaultPath, documents, 'a missing remembered folder falls back to Documents');
  h.window.close();
});

test('a valid dropped DEM updates the remembered folder; injected test paths never touch it', async () => {
  const root = tempRoot(), documents = join(root, 'Documents'), userData = join(root, 'userData');
  const dragged = join(root, 'dragged'), injected = join(root, 'injected');
  for (const directory of [documents, userData, dragged, injected]) mkdirSync(directory, { recursive: true });
  const h = await harness({ documents, userData });
  h.setDialog({ canceled: false, filePaths: [join(root, 'dialog', 'dialog.dem')] });
  mkdirSync(join(root, 'dialog'), { recursive: true });
  await h.finish(h.handlers.get('report:import')(h.trusted));
  await readSettings(userData, join(root, 'dialog'));
  const remembered = readFileSync(join(userData, 'demo-settings.json'), 'utf8');
  assert.equal((await h.finish(h.handlers.get('report:import-file')(h.trusted, join(dragged, 'drop.dem')))).kind, 'success');
  assert.equal((await readSettings(userData, dragged)).lastDemoDirectory, dragged, 'a valid drop can update the folder');
  writeFileSync(join(userData, 'demo-settings.json'), remembered);
  const injectedHarness = await harness({ documents, userData, env: { CS2_ANALYST_DEM_PATH: join(injected, 'env.dem') } });
  assert.equal((await injectedHarness.finish(injectedHarness.handlers.get('report:import')(injectedHarness.trusted))).kind, 'success');
  assert.equal(injectedHarness.dialogs.length, 0, 'the development injection bypasses the dialog');
  assert.equal(readFileSync(join(userData, 'demo-settings.json'), 'utf8'), remembered, 'the injected path never pollutes the recent folder');
  h.window.close(); injectedHarness.window.close();
});

test('production ignores both test path variables and still opens the chooser', async () => {
  const root = tempRoot(), documents = join(root, 'Documents'), userData = join(root, 'userData');
  mkdirSync(documents, { recursive: true }); mkdirSync(userData, { recursive: true });
  const h = await harness({ documents, userData, packaged: true,
    env: { CS2_ANALYST_DEM_PATH: join(root, 'dev.dem'), CS2_ANALYST_TEST_DEM_PATH: join(root, 'seam.dem') } });
  assert.equal((await h.handlers.get('report:import')(h.trusted)).kind, 'cancelled');
  assert.equal(h.dialogs.length, 1, 'production opened the native chooser instead of accepting injection');
  assert.equal(h.workers.length, 0);
  h.window.close();
});

test('a persistence failure never blocks a normal DEM import', async () => {
  const root = tempRoot(), documents = join(root, 'Documents'), blocked = join(root, 'not-a-directory');
  mkdirSync(documents, { recursive: true });
  writeFileSync(blocked, 'file blocks the settings directory');
  const h = await harness({ documents, userData: blocked });
  h.setDialog({ canceled: false, filePaths: [join(documents, 'demo.dem')] });
  assert.equal((await h.finish(h.handlers.get('report:import')(h.trusted))).kind, 'success');
  await pause(50);
  assert.equal(existsSync(join(blocked, 'demo-settings.json')), false);
  h.window.close();
});
