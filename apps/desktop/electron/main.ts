import { app, BrowserWindow, dialog, ipcMain, utilityProcess } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, extname, isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import type { ImportPhase, ImportResult, DesktopReplayMetadata, DesktopReplayRequest, DesktopReplayResult,
  DesktopHeatmapMetadata, DesktopHeatmapRequest, DesktopHeatmapResult } from '@cs2-analyst/report-contract';
import { HEATMAP_MAX_PENDING, HEATMAP_TIMEOUT_MS, validateHeatmapRequest, validateHeatmapResult } from '../shared/heatmap-ipc.ts';
import { LocalMatchLibrary } from './local-library.ts';
import { normalizeLibraryListQuery, boundedLibraryResult, LIBRARY_LIST_RESPONSE_BYTES, LIBRARY_STORAGE_RESPONSE_BYTES } from '../shared/library-ipc.ts';

/** Replaced at build time by electron.vite.config.ts. False in production installers. */
declare const __CS2_ANALYST_TEST_SEAM__: boolean;

let mainWindow: BrowserWindow | null = null;
let importing = false;
let activeWorker: Electron.UtilityProcess | null = null;
let activeReplay: DesktopReplayMetadata | null = null;
let activeHeatmap: DesktopHeatmapMetadata | null = null;
let activeSessionId: string | null = null;
let cancelActiveImport: (() => void) | null = null;
let libraryInstance: LocalMatchLibrary | null = null;
let libraryOpening: Promise<LocalMatchLibrary> | null = null;
const candidateWorkers = new Map<Electron.UtilityProcess, Promise<void>>();
const candidateCleanups = new Set<Promise<unknown>>();
function libraryService(): Promise<LocalMatchLibrary> {
  if (libraryInstance) return Promise.resolve(libraryInstance);
  if (!libraryOpening) libraryOpening = LocalMatchLibrary.open().then(value => { libraryInstance = value; return value; })
    .catch(error => { libraryOpening = null; throw error; });
  return libraryOpening;
}
let requestSequence = 0;
const pendingChunks = new Map<number, { worker: Electron.UtilityProcess; request: DesktopReplayRequest; timer: ReturnType<typeof setTimeout>; resolve: (result: DesktopReplayResult) => void }>();
const pendingHeatmaps = new Map<number, { worker: Electron.UtilityProcess; request: DesktopHeatmapRequest; timer: ReturnType<typeof setTimeout>; resolve: (result: DesktopHeatmapResult) => void }>();
function stopAnalysisWorker() {
  const worker=activeWorker;activeWorker=null;activeReplay=null;activeHeatmap=null;activeSessionId=null;
  for(const [id,pending] of pendingChunks){clearTimeout(pending.timer);pending.resolve({kind:'error',message:'回放会话已结束。'});pendingChunks.delete(id);}
  for(const [id,pending] of pendingHeatmaps){clearTimeout(pending.timer);pending.resolve({kind:'error',message:'热力图会话已结束。'});pendingHeatmaps.delete(id);}
  // Graceful clear when possible; process termination also drops every retained domain reference.
  try { worker?.postMessage({kind:'session-release'}); } catch { /* Worker already exited. */ }
  if(worker){
    worker.removeAllListeners();
    // kill() can return false before Utility Process spawn. Retire that late process too.
    if(worker.pid===undefined)worker.once('spawn',()=>worker.kill());
    worker.kill();
  }
}

/** Only the current application's main frame can invoke privileged actions. */
function trustedWindow(event: Electron.IpcMainInvokeEvent): BrowserWindow | null {
  const window = mainWindow;
  return window && !window.isDestroyed() && event.sender === window.webContents
    && event.senderFrame === window.webContents.mainFrame ? window : null;
}

ipcMain.handle('window:minimize', event => { trustedWindow(event)?.minimize(); });
ipcMain.handle('window:toggle-maximize', event => {
  const window = trustedWindow(event);
  if (!window) return;
  if (window.isMaximized()) window.unmaximize();
  else window.maximize();
});
ipcMain.handle('window:close', event => { trustedWindow(event)?.close(); });
ipcMain.handle('window:is-maximized', event => trustedWindow(event)?.isMaximized() ?? false);
ipcMain.handle('report:cancel', event => { if(trustedWindow(event)&&importing)cancelActiveImport?.(); });
const releaseSession = (event: Electron.IpcMainInvokeEvent, sessionId: unknown) => {
  if(trustedWindow(event)&&typeof sessionId==='string'&&sessionId===activeSessionId)stopAnalysisWorker();
};
// Legacy release has always ended the analysis worker. Both APIs retain that ownership.
ipcMain.handle('replay:release', releaseSession);
ipcMain.handle('session:release', releaseSession);
ipcMain.handle('library:list', async (event, value: unknown) => {
  const query = normalizeLibraryListQuery(value);
  if (!trustedWindow(event) || !query) return { kind: 'error', message: '比赛库查询无效。' };
  try { return boundedLibraryResult((await libraryService()).list(query), LIBRARY_LIST_RESPONSE_BYTES); }
  catch { return { kind: 'error', message: '无法读取本地比赛库，请检查磁盘权限或稍后重试。' }; }
});
ipcMain.handle('library:storage', async event => {
  if (!trustedWindow(event)) return { kind: 'error', message: '比赛库请求无效。' };
  try { return boundedLibraryResult(await (await libraryService()).storage(), LIBRARY_STORAGE_RESPONSE_BYTES); }
  catch { return { kind: 'error', message: '无法读取比赛库磁盘占用。' }; }
});
ipcMain.handle('heatmap:grid', (event, value: unknown): Promise<DesktopHeatmapResult> | DesktopHeatmapResult => {
  const fail = (): DesktopHeatmapResult => ({kind:'error',message:'无效、不可用或已过期的热力图请求。'});
  const metadata=activeHeatmap,worker=activeWorker;
  if(!trustedWindow(event)||!metadata||!worker||!validateHeatmapRequest(value,metadata)||pendingHeatmaps.size>=HEATMAP_MAX_PENDING)return fail();
  // Detach caller-owned arrays before correlating an asynchronous result.
  const request:DesktopHeatmapRequest=JSON.parse(JSON.stringify(value));
  return new Promise(resolve=>{
    const id=++requestSequence,timer=setTimeout(()=>{pendingHeatmaps.delete(id);resolve({kind:'error',message:'热力图请求超时。'});},HEATMAP_TIMEOUT_MS);
    pendingHeatmaps.set(id,{worker,request,timer,resolve});
    try {worker.postMessage({kind:'heatmap-grid',requestId:id,request});}
    catch {clearTimeout(timer);pendingHeatmaps.delete(id);resolve(fail());}
  });
});
ipcMain.handle('replay:chunk', (event, value:unknown): Promise<DesktopReplayResult>|DesktopReplayResult => {
  const fail=():DesktopReplayResult=>({kind:'error',message:'无效或已过期的回放请求。'});
  if(!trustedWindow(event)||!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==3)return fail();
  const request=value as DesktopReplayRequest,session=activeReplay,worker=activeWorker;
  if(!worker||!session||request.sessionId!==session.sessionId||typeof request.sessionId!=='string'||request.sessionId.length!==36
    ||!Number.isSafeInteger(request.round)||request.round<1||!Number.isSafeInteger(request.block)||request.block<0||pendingChunks.size>=4)return fail();
  if(!session.rounds.find(r=>r.round===request.round)?.blocks.some(b=>b.index===request.block))return fail();
  return new Promise(resolve=>{
    const id=++requestSequence,timer=setTimeout(()=>{pendingChunks.delete(id);resolve({kind:'error',message:'回放数据请求超时。'});},15_000);
    pendingChunks.set(id,{worker,request:{...request},timer,resolve});
    try {worker.postMessage({kind:'replay-chunk',requestId:id,request});}
    catch {clearTimeout(timer);pendingChunks.delete(id);resolve(fail());}
  });
});

/**
 * Import path used by automated tests instead of the native file dialog.
 *
 * `CS2_ANALYST_DEM_PATH` only applies to non-packaged builds. The packaged test seam
 * (`CS2_ANALYST_TEST_DEM_PATH`) is compiled in exclusively for the test-seam installer;
 * the production bundle contains neither the variable nor the branch, so an installed
 * production app ignores environment path injection. Disk Files still use the private preload bridge.
 */
function injectedDemoPath(): string | undefined {
  if (__CS2_ANALYST_TEST_SEAM__) return process.env.CS2_ANALYST_TEST_DEM_PATH;
  if (!app.isPackaged) return process.env.CS2_ANALYST_DEM_PATH;
  return undefined;
}

/**
 * Remember only the last DEM directory, never the DEM itself. The file lives under
 * userData so a normal restart keeps the chooser start location. Every filesystem
 * failure is best-effort: a broken setting must never block an otherwise valid import.
 */
const DEM_SETTINGS_FILE = 'demo-settings.json';
async function accessibleDirectory(value: unknown): Promise<string | undefined> {
  if (typeof value !== 'string' || value.trim().length === 0 || !isAbsolute(value)) return undefined;
  try {
    const info = await stat(value);
    if (!info.isDirectory()) return undefined;
    await access(value, fsConstants.R_OK);
    return value;
  } catch {
    return undefined;
  }
}
async function documentsDirectory(): Promise<string | undefined> {
  try {
    return await accessibleDirectory(app.getPath('documents'));
  } catch {
    return undefined;
  }
}
async function lastDemoDirectory(): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await readFile(join(app.getPath('userData'), DEM_SETTINGS_FILE), 'utf8'));
    return await accessibleDirectory(parsed?.lastDemoDirectory);
  } catch {
    return undefined;
  }
}
async function demChooserDirectory(): Promise<string | undefined> {
  return (await lastDemoDirectory()) ?? (await documentsDirectory());
}
async function rememberDemoDirectory(filePath: string): Promise<void> {
  try {
    const directory = await accessibleDirectory(dirname(filePath));
    if (!directory) return;
    const settings = join(app.getPath('userData'), DEM_SETTINGS_FILE);
    await mkdir(dirname(settings), { recursive: true });
    await writeFile(settings, JSON.stringify({ lastDemoDirectory: directory }, null, 2) + '\n', 'utf8');
  } catch {
    // Best-effort only: the import pipeline continues with its existing behaviour.
  }
}

/** Retire a candidate before removing files that it could still be writing. */
function retireCandidate(worker: Electron.UtilityProcess): Promise<boolean> {
  return new Promise(resolve => {
    let ended = false;
    const finish = (confirmed: boolean) => { if (ended) return; ended = true; clearTimeout(timer); resolve(confirmed); };
    const timer = setTimeout(() => finish(false), 3_000);
    worker.once('exit', () => finish(true));
    if (worker.pid === undefined) worker.once('spawn', () => worker.kill());
    worker.kill();
  });
}

async function analyzeDemo(filePath: string, window: BrowserWindow): Promise<ImportResult> {
  // The previous worker remains usable until a fully persisted candidate is ready.
  const controller = new AbortController();
  const earlyCancel = () => controller.abort();
  cancelActiveImport = earlyCancel;
  let library: LocalMatchLibrary;
  let staging: { id: string; directory: string };
  try {
    library = await libraryService();
    if (controller.signal.aborted) return { kind: 'cancelled' };
    staging = await library.createStaging();
    if (controller.signal.aborted) { await library.discardStaging(staging.id); return { kind: 'cancelled' }; }
  } catch {
    if (cancelActiveImport === earlyCancel) cancelActiveImport = null;
    return controller.signal.aborted ? { kind: 'cancelled' } : { kind: 'error', message: '无法准备本地比赛库。请检查磁盘空间、权限，或关闭另一个应用实例后重试。' };
  }
  return new Promise(resolve => {
    const sessionId=randomUUID();
    let worker: Electron.UtilityProcess;
    try { worker = utilityProcess.fork(fileURLToPath(new URL('./report-worker.js', import.meta.url)), [], { serviceName: 'CS2 DEM Analysis' }); }
    catch {
      if (cancelActiveImport === earlyCancel) cancelActiveImport = null;
      void library.discardStaging(staging.id).catch(error => console.error('Library staging cleanup failed', error))
        .then(() => resolve({ kind: 'error', message: '无法启动分析进程；本地已有比赛保持可用。' }));
      return;
    }
    const exited = new Promise<void>(exit => worker.once('exit', () => { candidateWorkers.delete(worker); exit(); }));
    candidateWorkers.set(worker, exited);
    let settled = false;
    let committed = false;
    let awaitingDuplicate = false;
    let workerExited = false;
    let activationTimeout: ReturnType<typeof setTimeout> | null = null;
    const finish = async (result: ImportResult, retain = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (activationTimeout !== null) clearTimeout(activationTimeout);
      if(cancelActiveImport===cancel)cancelActiveImport=null;
      let safeToClean = retain || workerExited;
      if (!retain) { worker.removeAllListeners('message'); if (!workerExited) safeToClean = await retireCandidate(worker); }
      // A failed candidate never removes an existing ready match. Cleanup is serialized by the service.
      if (safeToClean) {
        try { await library.discardStaging(staging.id); }
        catch (error) { console.error('Library staging cleanup failed', error); }
      } else {
        console.error('Candidate exit was not confirmed; preserving staging until its process actually exits.');
        const cleanup = exited.then(() => library.discardStaging(staging.id)).catch(error => console.error('Deferred staging cleanup failed', error));
        candidateCleanups.add(cleanup);void cleanup.finally(() => candidateCleanups.delete(cleanup));
      }
      resolve(result);
    };
    const cancel=()=>{ if (!committed) { controller.abort(); void finish({kind:'cancelled'}); } };
    cancelActiveImport=cancel;
    const timeout = setTimeout(() => { if (!committed) { controller.abort(); void finish({ kind: 'error', message: '分析和保存超时（10 分钟）。请重新选择 DEM。' }); } }, 10 * 60_000);
    const activate = (report: ImportResult & { kind: 'success' }) => {
      stopAnalysisWorker();
      const metadata=report.report.replay,heatmap=report.report.heatmap;
      const replayAvailable=metadata?.available===true&&metadata.sessionId===sessionId;
      const heatmapAvailable=heatmap?.available===true&&heatmap.sessionId===sessionId;
      activeWorker=worker;activeSessionId=sessionId;
      candidateWorkers.delete(worker);
      activeReplay=replayAvailable?metadata!:null;activeHeatmap=heatmapAvailable?heatmap!:null;
      void finish(report,replayAvailable||heatmapAvailable);
      if (!replayAvailable && !heatmapAvailable) { activeWorker=null;activeSessionId=null; }
    };
    worker.on('spawn', () => {
      if(settled||controller.signal.aborted){worker.kill();return;}
      worker.postMessage({ filePath, sessionId, archiveDirectory: staging.directory });
    });
    worker.on('message', async (message) => {
      if(!message||typeof message!=='object')return;
      if(message.kind==='heatmap-grid'){
        if(activeWorker!==worker)return;
        const pending=pendingHeatmaps.get(message.requestId);if(!pending||pending.worker!==worker)return;
        clearTimeout(pending.timer);pendingHeatmaps.delete(message.requestId);
        // Every recognized reply ends its Promise, including malformed/error replies.
        let valid=false;
        try {valid=activeHeatmap!==null&&validateHeatmapResult(message.result,pending.request,activeHeatmap);}catch { /* Non-JSON/malformed worker reply. */ }
        pending.resolve(valid?message.result:{kind:'error',message:'热力图响应无效或超过大小限制。'});return;
      }
      if(message.kind==='replay-chunk'){
        if(activeWorker!==worker)return;
        const pending=pendingChunks.get(message.requestId);if(!pending||pending.worker!==worker)return;
        const result=message.result as DesktopReplayResult;
        if(result?.kind==='success'){
          const chunk=result.chunk;
          if(chunk?.schemaVersion!==1||chunk?.matchId!==activeReplay?.matchId||chunk?.sessionId!==activeReplay?.sessionId||chunk?.sessionId!==pending.request.sessionId||chunk?.round!==pending.request.round||chunk?.block!==pending.request.block
            ||Buffer.byteLength(JSON.stringify(chunk))>1024*1024)return;
        }else if(result?.kind!=='error')return;
        clearTimeout(pending.timer);pendingChunks.delete(message.requestId);pending.resolve(result);return;
      }
      if(settled)return;
      if (message.kind === 'progress' && message.phase === 'analyzing') {
        if (!window.isDestroyed()) window.webContents.send('report:progress', 'analyzing');
      } else if (message.kind === 'prepared' && !committed && !awaitingDuplicate) {
        if (!message.report || message.report.schemaVersion !== 2 || !message.receipt) {
          void finish({ kind: 'error', message: '比赛存档响应无效。' }); return;
        }
        try {
          const saved = await library.commitStaging(staging.id, controller.signal, message.receipt, () => { committed = true; });
          if (settled) return;
          committed = true;
          if (saved.duplicate) {
            awaitingDuplicate = true;
            activationTimeout = setTimeout(() => void finish({ kind: 'error', message: '比赛已在本地库中，但打开已有档案超时。请重试打开该比赛。' }), 30_000);
            worker.postMessage({ kind: 'restore-duplicate', archiveDirectory: await library.archiveDirectory(saved.entry.matchId), sessionId });
          } else activate({ kind: 'success', report: message.report });
        } catch {
          void finish(controller.signal.aborted ? { kind: 'cancelled' } : { kind: 'error', message: '比赛分析完成，但无法安全保存到本地库。请检查磁盘空间和权限后重试。' });
        }
      } else if (message.kind === 'restored-duplicate' && committed && awaitingDuplicate) {
        activate({ kind: 'success', report: message.report });
      } else if(message.kind==='error')void finish(message);
    });
    worker.on('exit', () => { workerExited=true;if(!settled)void finish({ kind: 'error', message: '分析进程意外退出。请重新选择 DEM。' });else if(activeWorker===worker)stopAnalysisWorker(); });
  });
}

/** Shared tail of every import path: extension gate, parsing progress, worker analysis. */
async function analyzeFromPath(filePath: string, window: BrowserWindow, rememberDirectory = false): Promise<ImportResult> {
  if (extname(filePath).toLowerCase() !== '.dem') return { kind: 'error', message: '请选择 .dem 文件。' };
  // Injected test paths must not become a real user's recent directory. Persistence is
  // deliberately fire-and-forget so a slow or broken settings write never delays import.
  if (rememberDirectory) void rememberDemoDirectory(filePath);
  if (!window.isDestroyed()) window.webContents.send('report:progress', 'parsing');
  return await analyzeDemo(filePath, window);
}

ipcMain.handle('report:import', async (event): Promise<ImportResult> => {
  const window = trustedWindow(event);
  if (!window) {
    return { kind: 'error', message: '无效的报告请求。' };
  }
  if (importing) return { kind: 'error', message: '已有分析任务正在运行。' };
  importing = true;
  const progress = (phase: ImportPhase) => { if (!window.isDestroyed()) window.webContents.send('report:progress', phase); };
  try {
    progress('selecting');
    const injected = injectedDemoPath();
    let filePath: string;
    if (injected) {
      filePath = injected;
    } else {
      const defaultPath = await demChooserDirectory();
      const result = await dialog.showOpenDialog(window, {
        title: '选择 CS2 DEM', ...(defaultPath ? { defaultPath } : {}),
        properties: ['openFile'], filters: [{ name: 'CS2 Demo', extensions: ['dem'] }],
      });
      // Cancelling must leave the previously remembered directory untouched.
      if (result.canceled || !result.filePaths.length || window.isDestroyed()) return { kind: 'cancelled' };
      filePath = result.filePaths[0];
    }
    return await analyzeFromPath(filePath, window, injected === undefined);
  } catch (error) {
    console.error('DEM import failed', error);
    return { kind: 'error', message: '无法导入 DEM。请检查文件权限后重新选择。' };
  } finally {
    importing = false;
  }
});

/** Drag-and-drop import: same pipeline as the dialog, with an absolute .dem path resolved inside preload. */
ipcMain.handle('report:import-file', async (event, value: unknown): Promise<ImportResult> => {
  const window = trustedWindow(event);
  if (!window) return { kind: 'error', message: '无效的报告请求。' };
  if (typeof value !== 'string' || !value.trim() || !isAbsolute(value)) return { kind: 'error', message: '无效的 DEM 路径。' };
  if (importing) return { kind: 'error', message: '已有分析任务正在运行。' };
  importing = true;
  try {
    return await analyzeFromPath(value, window, true);
  } catch (error) {
    console.error('DEM import failed', error);
    return { kind: 'error', message: '无法导入 DEM。请检查文件权限后重新选择。' };
  } finally {
    importing = false;
  }
});

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    // Comfortable working window on a 1080p desktop: the navigation rail, the
    // report split and the replay layout all stay intact down to this size.
    minWidth: 1024,
    minHeight: 640,
    frame: false,
    resizable: true,
    backgroundColor: '#111821',
    title: 'CS2 Analyst',
    icon: app.isPackaged
      ? join(process.resourcesPath, 'branding/cs2-analyst-mark.png')
      : fileURLToPath(new URL('../../resources/branding/cs2-analyst-mark.png', import.meta.url)),
    webPreferences: {
      preload: fileURLToPath(new URL('../preload/index.cjs', import.meta.url)),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const window = mainWindow;
  window.removeMenu();
  const maximizedChanged = () => {
    if (!window.isDestroyed()) window.webContents.send('window:maximized-changed', window.isMaximized());
  };
  window.on('maximize', maximizedChanged);
  window.on('unmaximize', maximizedChanged);

  mainWindow.on('closed', () => {
    cancelActiveImport?.();stopAnalysisWorker();
    mainWindow = null;
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', event => event.preventDefault());

  if (process.env.ELECTRON_RENDERER_URL) {
    await mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    await mainWindow.loadFile(fileURLToPath(new URL('../renderer/index.html', import.meta.url)));
  }
}

app.whenReady().then(async () => {
  app.setAppUserModelId(__CS2_ANALYST_TEST_SEAM__ ? 'com.evanpatchouli.cs2analyst.testseam' : 'com.evanpatchouli.cs2analyst');
  await createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
let shutdownReady = false, shutdownRunning = false;
app.on('before-quit', event => {
  if (shutdownReady || (candidateWorkers.size === 0 && candidateCleanups.size === 0)) return;
  event.preventDefault();
  if (shutdownRunning) return;
  shutdownRunning = true;
  cancelActiveImport?.();stopAnalysisWorker();
  // Keep the exclusive library writer lock until every candidate writer has really exited.
  const pending = [...candidateWorkers.entries()];
  for (const [worker] of pending) worker.kill();
  void Promise.all(pending.map(([, exit]) => exit)).then(async () => {
    await Promise.all([...candidateCleanups]);
    libraryInstance?.close();shutdownReady = true;app.quit();
  }).catch(error => { shutdownRunning=false;console.error('Waiting for library writers to exit failed', error); });
});
app.on('will-quit', () => { cancelActiveImport?.(); if (candidateWorkers.size === 0) libraryInstance?.close(); });
