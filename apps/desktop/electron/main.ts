import { app, BrowserWindow, dialog, ipcMain, screen, utilityProcess } from 'electron';
import { fileURLToPath } from 'node:url';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import type { ImportPhase, ImportResult, ImportPlayerChoice, ImportPlayerSelectionResult,
  DesktopReplayMetadata, DesktopReplayRequest, DesktopReplayResult,
  DesktopHeatmapMetadata, DesktopHeatmapRequest, DesktopHeatmapResult,
  LibraryDeleteResult, LibraryExportResult, LibraryImportResult, LibrarySelfPlayerResult } from '@cs2-analyst/report-contract';
import { HEATMAP_MAX_PENDING, HEATMAP_TIMEOUT_MS, validateHeatmapRequest, validateHeatmapResult } from '../shared/heatmap-ipc.ts';
import { LocalMatchLibrary } from './local-library.ts';
import { ArchiveVerificationBroker, ARCHIVE_VERIFICATION_SERVICE_NAME } from './archive-verification.ts';
import { extractPortableArchive, writePortableArchive } from './library-portable.ts';
import { normalizeLibraryListQuery, boundedLibraryResult, isMatchId, LIBRARY_LIST_RESPONSE_BYTES, LIBRARY_STORAGE_RESPONSE_BYTES } from '../shared/library-ipc.ts';

/** Replaced at build time by electron.vite.config.ts. False in production installers. */
declare const __CS2_ANALYST_TEST_SEAM__: boolean;

let mainWindow: BrowserWindow | null = null;
let importing = false;
let opening = false;
let removing = false;
let exporting = false;
let activeWorker: Electron.UtilityProcess | null = null;
let activeReplay: DesktopReplayMetadata | null = null;
let activeHeatmap: DesktopHeatmapMetadata | null = null;
let activeSessionId: string | null = null;
let activeMatchId: string | null = null;
let cancelActiveImport: (() => void) | null = null;
let libraryInstance: LocalMatchLibrary | null = null;
let libraryOpening: Promise<LocalMatchLibrary> | null = null;
interface PendingPlayerPrompt { playerIds: Set<string>; resolve: (playerId: string | null) => void; timer: ReturnType<typeof setTimeout> }
let pendingPlayerPrompt: PendingPlayerPrompt | null = null;
const candidateWorkers = new Map<Electron.UtilityProcess, Promise<void>>();
const candidateCleanups = new Set<Promise<unknown>>();
const archiveVerifier = new ArchiveVerificationBroker(() => utilityProcess.fork(
  fileURLToPath(new URL('./archive-verifier.js', import.meta.url)), [], { serviceName: ARCHIVE_VERIFICATION_SERVICE_NAME }));
const portableControllers = new Set<AbortController>();
const portableCleanups = new Set<Promise<unknown>>();
function cancelPortableOperations() { for (const controller of portableControllers) controller.abort(); archiveVerifier.cancelAll(); }
function portableOperation<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController(); portableControllers.add(controller);
  const pending = Promise.resolve().then(() => operation(controller.signal));
  portableCleanups.add(pending);
  const finished = () => { portableControllers.delete(controller); portableCleanups.delete(pending); };
  void pending.then(finished, finished);
  return pending;
}
function deferredPortableCleanup(cleanup: Promise<void>): void {
  const guarded = cleanup.catch(error => { console.error('Deferred portable archive cleanup failed', error); });
  portableCleanups.add(guarded);
  void guarded.then(() => portableCleanups.delete(guarded));
}
function portableDialog<T>(signal: AbortSignal, open: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error('Portable archive operation cancelled.'));
    signal.addEventListener('abort', abort, { once: true });
    void Promise.resolve().then(open).then(value => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) abort(); else resolve(value);
    }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}
function finishPlayerPrompt(playerId: string | null): boolean {
  const pending = pendingPlayerPrompt;
  if (!pending) return false;
  pendingPlayerPrompt = null;
  clearTimeout(pending.timer);
  pending.resolve(playerId);
  return true;
}
/** Ask the Renderer who the local user is, after the DEM player list is known. */
function askImportPlayer(window: BrowserWindow, players: ImportPlayerChoice[], signal: AbortSignal): Promise<string | null> {
  if (window.isDestroyed()) return Promise.resolve(null);
  return new Promise(resolve => {
    const prompt: PendingPlayerPrompt = {
      playerIds: new Set(players.map(player => player.id)),
      resolve: playerId => { signal.removeEventListener('abort', abort); resolve(playerId); },
      timer: setTimeout(() => finishPlayerPrompt(null), 10 * 60_000),
    };
    const abort = () => {
      if (pendingPlayerPrompt === prompt) finishPlayerPrompt(null);
    };
    pendingPlayerPrompt = prompt;
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { finishPlayerPrompt(null); return; }
    window.webContents.send('report:import-players', players);
    window.webContents.send('report:progress', 'awaiting-player');
  });
}
function libraryService(): Promise<LocalMatchLibrary> {
  if (libraryInstance) return Promise.resolve(libraryInstance);
  if (!libraryOpening) libraryOpening = LocalMatchLibrary.open().then(value => { libraryInstance = value; return value; })
    .catch(error => { libraryOpening = null; throw error; });
  return libraryOpening;
}
let requestSequence = 0;
const pendingChunks = new Map<number, { worker: Electron.UtilityProcess; request: DesktopReplayRequest; timer: ReturnType<typeof setTimeout>; resolve: (result: DesktopReplayResult) => void }>();
const pendingHeatmaps = new Map<number, { worker: Electron.UtilityProcess; request: DesktopHeatmapRequest; timer: ReturnType<typeof setTimeout>; resolve: (result: DesktopHeatmapResult) => void }>();
function routeHeatmapReply(worker: Electron.UtilityProcess, message: Record<string, unknown>): boolean {
  if (activeWorker !== worker) return false;
  const pending = pendingHeatmaps.get(message.requestId as number);
  if (!pending || pending.worker !== worker) return false;
  clearTimeout(pending.timer); pendingHeatmaps.delete(message.requestId as number);
  let valid = false;
  try { valid = activeHeatmap !== null && validateHeatmapResult(message.result, pending.request, activeHeatmap); }
  catch { /* Non-JSON/malformed worker reply. */ }
  pending.resolve(valid ? message.result as DesktopHeatmapResult : { kind: 'error', message: '热力图响应无效或超过大小限制。' });
  return true;
}
function routeReplayReply(worker: Electron.UtilityProcess, message: Record<string, unknown>): boolean {
  if (activeWorker !== worker) return false;
  const pending = pendingChunks.get(message.requestId as number);
  if (!pending || pending.worker !== worker) return false;
  const result = message.result as DesktopReplayResult;
  let valid = result?.kind === 'error';
  if (result?.kind === 'success') {
    const chunk = result.chunk;
    valid = chunk?.schemaVersion === 1 && chunk?.matchId === activeReplay?.matchId && chunk?.sessionId === activeReplay?.sessionId
      && chunk?.sessionId === pending.request.sessionId && chunk?.round === pending.request.round && chunk?.block === pending.request.block
      && Buffer.byteLength(JSON.stringify(chunk)) <= 1024 * 1024;
  }
  clearTimeout(pending.timer); pendingChunks.delete(message.requestId as number);
  pending.resolve(valid ? result : { kind: 'error', message: '回放响应无效或超过大小限制。' });
  return true;
}
function stopAnalysisWorker() {
  const worker=activeWorker;activeWorker=null;activeReplay=null;activeHeatmap=null;activeSessionId=null;activeMatchId=null;
  for(const [id,pending] of pendingChunks){clearTimeout(pending.timer);pending.resolve({kind:'error',message:'回放会话已结束。'});pendingChunks.delete(id);}
  for(const [id,pending] of pendingHeatmaps){clearTimeout(pending.timer);pending.resolve({kind:'error',message:'热力图会话已结束。'});pendingHeatmaps.delete(id);}
  // Graceful clear when possible; process termination also drops every retained domain reference.
  try { worker?.postMessage({kind:'session-release'}); } catch { /* Worker already exited. */ }
  if(worker){
    // Keep exit listeners: a caller may be awaiting real termination before deleting files.
    worker.removeAllListeners('message');
    // kill() can return false before Utility Process spawn. Retire that late process too.
    if(worker.pid===undefined)worker.once('spawn',()=>worker.kill());
    worker.kill();
  }
}

/**
 * Stop the worker that owns the active match and wait (bounded) for the process to
 * actually exit. A live worker must never keep reading an archive that is being deleted.
 */
function retireActiveWorker(): Promise<boolean> {
  const worker = activeWorker;
  if (!worker) { activeMatchId = null; return Promise.resolve(true); }
  const exited = new Promise<boolean>(resolveExit => {
    let settled = false;
    const finish = (confirmed: boolean) => { if (settled) return; settled = true; clearTimeout(timer); resolveExit(confirmed); };
    const timer = setTimeout(() => finish(false), 3_000);
    worker.once('exit', () => finish(true));
  });
  stopAnalysisWorker();
  return exited;
}

const ARCHIVE_EXTENSION = '.cs2a';
const LIBRARY_DELETE_LIMIT = 100;
function normalizeMatchIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > LIBRARY_DELETE_LIMIT) return null;
  const ids: string[] = [], seen = new Set<string>();
  for (const item of value) {
    if (!isMatchId(item) || seen.has(item)) return null;
    seen.add(item); ids.push(item);
  }
  return ids;
}
function localAbsolutePath(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim() || !isAbsolute(value) || value.includes('\0')) return null;
  const path = resolve(value);
  return path.startsWith('\\\\') ? null : path;
}
/**
 * QA-only acceptance seam. Production packaged builds ignore these variables; the
 * explicitly built test-seam installer may use them for installed file-dialog tests.
 * Renderer never sees either path.
 */
function developmentInjectedPath(variable: string): string | undefined {
  if (app.isPackaged && !__CS2_ANALYST_TEST_SEAM__) return undefined;
  const value = process.env[variable];
  return typeof value === 'string' && value.trim() ? value : undefined;
}
const withArchiveExtension = (path: string): string => extname(path).toLowerCase() === ARCHIVE_EXTENSION ? path : path + ARCHIVE_EXTENSION;
function exportFileName(fileName: string): string {
  const base = fileName.replace(/\.dem$/i, '').replace(/[\\/:*?"<>|]/g, '_').slice(0, 200);
  return `${base || 'match'}${ARCHIVE_EXTENSION}`;
}
async function exportDefaultPath(fileName: string): Promise<string> {
  const name = exportFileName(fileName);
  try { return join(app.getPath('documents'), name); } catch { return name; }
}
function importFailureMessage(error: unknown): string {
  if ((error as { code?: string })?.code === 'ARCHIVE_UNSUPPORTED') return '该比赛由更新版本的 CS2 Analyst 导出，当前版本无法读取。';
  if (/portable archive/i.test(error instanceof Error ? error.message : '')) return '比赛归档无效、已损坏或超过安全限制，未导入任何内容。';
  return '无法导入比赛归档；现有比赛保持不变。';
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
ipcMain.handle('report:cancel', event => {
  if (!trustedWindow(event)) return;
  if (importing) cancelActiveImport?.();
  cancelPortableOperations();
});
ipcMain.handle('report:select-player', (event, playerId: unknown): ImportPlayerSelectionResult => {
  if (!trustedWindow(event)) return { kind: 'error', message: '无效的玩家选择请求。' };
  if (playerId !== null && (typeof playerId !== 'string' || !playerId || playerId.length > 256)) {
    return { kind: 'error', message: '无效的玩家选择。' };
  }
  const pending = pendingPlayerPrompt;
  if (!pending) return { kind: 'error', message: '当前没有等待中的玩家选择。' };
  if (playerId !== null && !pending.playerIds.has(playerId)) return { kind: 'error', message: '所选玩家不属于本场比赛。' };
  finishPlayerPrompt(playerId);
  return { kind: 'success' };
});
const releaseSession = (event: Electron.IpcMainInvokeEvent, sessionId: unknown) => {
  if(trustedWindow(event)&&typeof sessionId==='string'&&sessionId===activeSessionId)stopAnalysisWorker();
};
// Legacy release has always ended the analysis worker. Both APIs retain that ownership.
ipcMain.handle('replay:release', releaseSession);
ipcMain.handle('session:release', releaseSession);
ipcMain.handle('library:list', async (event, value: unknown) => {
  const query = normalizeLibraryListQuery(value);
  if (!trustedWindow(event) || !query) return { kind: 'error', message: '比赛库查询无效。' };
  try { return boundedLibraryResult(await (await libraryService()).listWithPerformance(query), LIBRARY_LIST_RESPONSE_BYTES); }
  catch { return { kind: 'error', message: '无法读取本地比赛库，请检查磁盘权限或稍后重试。' }; }
});
ipcMain.handle('library:storage', async event => {
  if (!trustedWindow(event)) return { kind: 'error', message: '比赛库请求无效。' };
  try { return boundedLibraryResult(await (await libraryService()).storage(), LIBRARY_STORAGE_RESPONSE_BYTES); }
  catch { return { kind: 'error', message: '无法读取比赛库磁盘占用。' }; }
});
ipcMain.handle('library:open', async (event, matchId: unknown): Promise<ImportResult> => {
  if (!trustedWindow(event) || !isMatchId(matchId)) return { kind: 'error', message: '无效的比赛请求。' };
  if (importing || opening || removing || exporting) return { kind: 'error', message: '已有比赛任务正在运行。' };
  opening = true;
  try { return await openSavedMatch(matchId); }
  finally { opening = false; }
});
ipcMain.handle('library:reanalyze', async (event, matchId: unknown): Promise<ImportResult> => {
  const window = trustedWindow(event);
  if (!window || !isMatchId(matchId)) return { kind: 'error', message: '无效的比赛请求。' };
  if (importing || opening || removing || exporting) return { kind: 'error', message: '已有比赛任务正在运行。' };
  importing = true;
  try {
    const entry = (await libraryService()).get(matchId);
    if (!entry || entry.state !== 'ready') return { kind: 'error', message: '该比赛当前不可用，无法重新分析。' };
    window.webContents.send('report:progress', 'selecting');
    const injected = injectedDemoPath();
    let filePath: string;
    if (injected) filePath = injected;
    else {
      const defaultPath = await demChooserDirectory();
      const selected = await dialog.showOpenDialog(window, { title: '重新分析：选择这场比赛的源 DEM',
        ...(defaultPath ? { defaultPath } : {}), properties: ['openFile'], filters: [{ name: 'CS2 Demo', extensions: ['dem'] }] });
      if (selected.canceled || !selected.filePaths.length || window.isDestroyed()) return { kind: 'cancelled' };
      filePath = selected.filePaths[0];
    }
    return await analyzeFromPath(filePath, window, injected === undefined,
      { matchId, selfPlayerId: entry.selfPlayerId ?? null, importedAt: entry.importedAt });
  } catch (error) {
    console.error('Match reanalysis failed', error);
    return { kind: 'error', message: '无法重新分析比赛；原报告保持不变。请检查源 DEM 和磁盘权限后重试。' };
  } finally { importing = false; }
});
ipcMain.handle('library:remove', async (event, value: unknown): Promise<LibraryDeleteResult> => {
  if (!trustedWindow(event)) return { kind: 'error', message: '比赛库请求无效。' };
  const matchIds = normalizeMatchIds(value);
  if (!matchIds) return { kind: 'error', message: '无效的删除请求。' };
  if (importing || opening || removing || exporting) return { kind: 'error', message: '已有比赛任务正在运行，请稍后再删除。' };
  removing = true;
  try {
    const failed: { matchId: string; message: string }[] = [];
    let deletable = matchIds;
    // Never remove an archive that the live Replay/Heatmap worker can still read.
    const retiring = activeMatchId;
    if (retiring !== null && matchIds.includes(retiring)) {
      // Capture the id: retiring the session clears activeMatchId. Only remove the archive
      // after the worker actually exited; otherwise report this id and keep its files.
      if (!await retireActiveWorker()) {
        failed.push({ matchId: retiring, message: '回放会话仍在使用该比赛，请稍后重试。' });
        deletable = matchIds.filter(id => id !== retiring);
      }
    }
    if (!deletable.length) return { kind: 'success', removed: [], failed };
    const result = await (await libraryService()).remove(deletable);
    return result.kind === 'success' ? { kind: 'success', removed: result.removed, failed: [...failed, ...result.failed] } : result;
  } catch {
    return { kind: 'error', message: '无法删除本地比赛，请稍后重试。' };
  } finally {
    removing = false;
  }
});
ipcMain.handle('library:set-self-player', async (event, matchId: unknown, playerId: unknown): Promise<LibrarySelfPlayerResult> => {
  if (!trustedWindow(event) || !isMatchId(matchId)) return { kind: 'error', message: '无效的玩家身份请求。' };
  if (playerId !== null && (typeof playerId !== 'string' || !playerId || playerId.length > 256)) {
    return { kind: 'error', message: '无效的玩家身份。' };
  }
  if (importing || opening || removing || exporting) return { kind: 'error', message: '已有比赛任务正在运行，请稍后再设置玩家。' };
  try { return await (await libraryService()).setSelfPlayer(matchId, playerId); }
  catch { return { kind: 'error', message: '无法保存玩家身份，请稍后重试。' }; }
});
ipcMain.handle('library:export', async (event, matchId: unknown): Promise<LibraryExportResult> => {
  const window = trustedWindow(event);
  if (!window || !isMatchId(matchId)) return { kind: 'error', message: '无效的导出请求。' };
  if (importing || opening || removing || exporting) return { kind: 'error', message: '已有比赛任务正在运行，请稍后再导出。' };
  exporting = true;
  return portableOperation<LibraryExportResult>(async signal => {
    let temporary: string | null = null;
    try {
      const library = await libraryService();
      const entry = library.get(matchId);
      if (!entry || entry.state !== 'ready') return { kind: 'error', message: '该比赛当前不可用，无法导出。' };
      const archiveDirectory = await library.archiveDirectory(matchId);
      let destination: string;
      const injected = developmentInjectedPath('CS2_ANALYST_EXPORT_PATH');
      if (injected !== undefined) {
        const path = localAbsolutePath(injected);
        if (!path) return { kind: 'error', message: '导出目标路径无效。' };
        destination = withArchiveExtension(path);
      } else {
        const defaultPath = await exportDefaultPath(entry.fileName);
        const chosen = await portableDialog(signal, () => dialog.showSaveDialog(window, { title: '导出比赛归档',
          defaultPath,
          filters: [{ name: 'CS2 Analyst 比赛归档', extensions: ['cs2a'] }] }));
        if (chosen.canceled || !chosen.filePath || window.isDestroyed()) return { kind: 'cancelled' };
        const path = localAbsolutePath(chosen.filePath);
        if (!path) return { kind: 'error', message: '导出目标路径无效。' };
        destination = withArchiveExtension(path);
      }
      signal.throwIfAborted();
      temporary = join(dirname(destination), `.${basename(destination)}.${randomUUID()}.tmp`);
      if (!window.isDestroyed()) window.webContents.send('library:progress', { operation: 'export', phase: 'writing', fileName: basename(destination) });
      const written = await writePortableArchive(archiveDirectory, temporary, { signal,
        verify: (directory, signal) => archiveVerifier.verify(directory, signal) });
      const info = await stat(temporary);
      if (info.size !== written.bytes) throw new Error('Exported package size mismatch.');
      signal.throwIfAborted();
      // Same-volume rename replaces atomically on Windows once the bytes are durable.
      await rename(temporary, destination);
      temporary = null;
      return { kind: 'success', fileName: basename(destination), bytes: info.size };
    } catch (error) {
      if (signal.aborted) return { kind: 'cancelled' };
      console.error('Match export failed', error);
      return { kind: 'error', message: '无法导出比赛归档。请检查目标位置、磁盘空间后重试。' };
    } finally {
      const cleanup = async () => {
        if (temporary) { try { await rm(temporary, { force: true }); } catch { /* Best-effort temp cleanup. */ } }
        exporting = false;
      };
      if (archiveVerifier.activeCount) deferredPortableCleanup(archiveVerifier.waitForIdle().then(cleanup));
      else await cleanup();
    }
  });
});
ipcMain.handle('library:import', async (event): Promise<LibraryImportResult> => {
  const window = trustedWindow(event);
  if (!window) return { kind: 'error', message: '比赛库请求无效。' };
  if (importing || opening || removing || exporting) return { kind: 'error', message: '已有比赛任务正在运行。' };
  importing = true;
  return portableOperation<LibraryImportResult>(async signal => {
    let retiring = false;
    try {
      let filePath: string;
      const injected = developmentInjectedPath('CS2_ANALYST_IMPORT_PATH');
      if (injected !== undefined) {
        const path = localAbsolutePath(injected);
        if (!path || extname(path).toLowerCase() !== ARCHIVE_EXTENSION) return { kind: 'error', message: '请选择 .cs2a 比赛归档。' };
        filePath = path;
      } else {
        const chosen = await portableDialog(signal, () => dialog.showOpenDialog(window, { title: '导入比赛归档', properties: ['openFile'],
          filters: [{ name: 'CS2 Analyst 比赛归档', extensions: ['cs2a'] }] }));
        if (chosen.canceled || !chosen.filePaths.length || window.isDestroyed()) return { kind: 'cancelled' };
        const path = localAbsolutePath(chosen.filePaths[0]);
        if (!path || extname(path).toLowerCase() !== ARCHIVE_EXTENSION) return { kind: 'error', message: '请选择 .cs2a 比赛归档。' };
        filePath = path;
      }
      signal.throwIfAborted();
      const library = await libraryService();
      signal.throwIfAborted();
      const staging = await library.createStaging();
      let committed = false;
      try {
        // Stream into the owned staging directory, then re-verify every component with L1
        // before the catalogue transaction can publish anything.
        if (!window.isDestroyed()) window.webContents.send('library:progress', { operation: 'importArchive', phase: 'validating', fileName: basename(filePath) });
        await extractPortableArchive(filePath, staging.directory, { signal });
        const verified = await archiveVerifier.verify(staging.directory, signal);
        if (!window.isDestroyed()) window.webContents.send('library:progress', { operation: 'importArchive', phase: 'writing', fileName: basename(filePath) });
        const saved = await library.commitStaging(staging.id, signal,
          { manifestHash: verified.manifestHash, storedBytes: verified.storedBytes }, () => { committed = true; });
        committed = true;
        return { kind: 'success', entry: saved.entry, duplicate: saved.duplicate };
      } catch (error) {
        if (signal.aborted && !committed) return { kind: 'cancelled' };
        console.error('Match archive import rejected', error);
        return { kind: 'error', message: committed ? '比赛归档已保存，请在比赛库中查看；现有记录没有回滚。' : importFailureMessage(error) };
      } finally {
        // A failed verifier may not have exited yet. Return its controlled error,
        // but retain busy/SQLite ownership and defer staging removal until real exit.
        const discard = async () => {
          try { await library.discardStaging(staging.id); } catch (error) { console.error('Import staging cleanup failed', error); }
        };
        if (!committed && archiveVerifier.activeCount) {
          retiring = true;
          deferredPortableCleanup(archiveVerifier.waitForIdle().then(async () => { await discard(); importing = false; }));
        } else if (!committed) await discard();
      }
    } catch (error) {
      if (signal.aborted) return { kind: 'cancelled' };
      console.error('Match archive import failed', error);
      return { kind: 'error', message: '无法导入比赛归档；现有比赛保持不变。' };
    } finally {
      if (!retiring) importing = false;
    }
  });
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

interface ReanalysisTarget { matchId: string; selfPlayerId: string | null; importedAt: string }
async function analyzeDemo(filePath: string, window: BrowserWindow, replacement?: ReanalysisTarget): Promise<ImportResult> {
  // The previous worker remains usable until a fully persisted candidate is ready.
  const controller = new AbortController();
  const earlyCancel = () => controller.abort();
  cancelActiveImport = earlyCancel;
  let library: LocalMatchLibrary;
  let staging: { id: string; directory: string };
  try {
    library = await libraryService();
    if (controller.signal.aborted) {
      if (cancelActiveImport === earlyCancel) cancelActiveImport = null;
      return { kind: 'cancelled' };
    }
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
    let awaitingPlayers = false;
    let workerExited = false;
    let selectedSelfPlayerId: string | null = null;
    let preparedMatchId: string | null = null;
    let duplicateSelfPlayerId: string | null = null;
    let activationTimeout: ReturnType<typeof setTimeout> | null = null;
    const finish = async (result: ImportResult, retain = false) => {
      if (settled) return;
      settled = true;
      finishPlayerPrompt(null);
      clearTimeout(timeout);
      if (activationTimeout !== null) clearTimeout(activationTimeout);
      if(cancelActiveImport===cancel)cancelActiveImport=null;
      if (result.kind !== 'success') {
        if (!committed) controller.abort();
        else if (replacement && preparedMatchId) {
          // The catalogue switch already committed: never report a rollback. A lost
          // candidate can be replaced by restoring the durable snapshot in a new worker.
          const restored = await openSavedMatch(preparedMatchId);
          if (restored.kind === 'success') result = restored;
          else {
            stopAnalysisWorker();
            result = { kind: 'error', savedMatchId: preparedMatchId,
              message: '新报告已保存，但暂时无法打开。请从比赛库重新打开该记录。' };
          }
        }
      }
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
      activeMatchId=isMatchId(report.report.match?.id)?report.report.match.id:null;
      candidateWorkers.delete(worker);
      activeReplay=replayAvailable?metadata!:null;activeHeatmap=heatmapAvailable?heatmap!:null;
      void finish(report,replayAvailable||heatmapAvailable);
      if (!replayAvailable && !heatmapAvailable) { activeWorker=null;activeSessionId=null;activeMatchId=null; }
    };
    worker.on('spawn', () => {
      if(settled||controller.signal.aborted){worker.kill();return;}
      worker.postMessage({ filePath, sessionId, archiveDirectory: staging.directory,
        ...(replacement ? { expectedMatchId: replacement.matchId, selfPlayerId: replacement.selfPlayerId, createdAt: replacement.importedAt } : {}) });
    });
    worker.on('message', async (message) => {
      if(!message||typeof message!=='object')return;
      if(message.kind==='heatmap-grid'){ routeHeatmapReply(worker,message);return; }
      if(message.kind==='replay-chunk'){ routeReplayReply(worker,message);return; }
      if(settled)return;
      if (message.kind === 'players' && !awaitingPlayers) {
        if (replacement) { void finish({ kind: 'error', message: '重新分析协议无效；原报告保持不变。' }); return; }
        const offered = Array.isArray(message.players) ? message.players : null;
        if (!offered || offered.length < 1 || offered.length > 64) {
          void finish({ kind: 'error', message: 'DEM 玩家列表无效，无法询问你的身份。' }); return;
        }
        const players: ImportPlayerChoice[] = [];
        const seen = new Set<string>();
        for (const item of offered) {
          if (!item || typeof item !== 'object' || Array.isArray(item)
            || typeof item.id !== 'string' || !item.id || item.id.length > 256 || seen.has(item.id)
            || typeof item.nickname !== 'string' || item.nickname.length > 512 || item.nickname.includes('\0')) {
            void finish({ kind: 'error', message: 'DEM 玩家列表无效，无法询问你的身份。' }); return;
          }
          seen.add(item.id); players.push({ id: item.id, nickname: item.nickname });
        }
        awaitingPlayers = true;
        void (async () => {
          const choice = await askImportPlayer(window, players, controller.signal);
          awaitingPlayers = false;
          if (settled) return;
          selectedSelfPlayerId = choice;
          try { worker.postMessage({ kind: 'player-selection', playerId: choice }); }
          catch { void finish({ kind: 'error', message: '无法继续分析：分析进程不可用。' }); }
        })();
        return;
      }
      if (message.kind === 'progress' && (message.phase === 'analyzing' || message.phase === 'saving')) {
        if (!window.isDestroyed()) window.webContents.send('report:progress', message.phase);
      } else if (message.kind === 'prepared' && !committed && !awaitingDuplicate) {
        if (!message.report || message.report.schemaVersion !== 2 || !message.receipt) {
          void finish({ kind: 'error', message: '比赛存档响应无效。' }); return;
        }
        try {
          preparedMatchId = isMatchId(message.report.match?.id) ? message.report.match.id : null;
          const candidateSelf = message.selfPlayerId === undefined ? selectedSelfPlayerId : message.selfPlayerId;
          const validSelf = typeof candidateSelf === 'string' && Array.isArray(message.report.players)
            && message.report.players.some((player: { id?: unknown }) => player?.id === candidateSelf) ? candidateSelf : null;
          selectedSelfPlayerId = validSelf;
          if (replacement && message.report.match?.id !== replacement.matchId) {
            void finish({ kind: 'error', message: '所选 DEM 与这条比赛记录不匹配；原报告保持不变。' }); return;
          }
          const saved = replacement
            ? await library.replaceStaging(staging.id, replacement.matchId, controller.signal, message.receipt, () => { committed = true; })
            : await library.commitStaging(staging.id, controller.signal, message.receipt, () => { committed = true; }, validSelf);
          if (settled) return;
          committed = true;
          const savedSelf = replacement ? saved.entry.selfPlayerId ?? null : saved.entry.selfPlayerId ?? validSelf;
          if (saved.duplicate) {
            duplicateSelfPlayerId = savedSelf;
            awaitingDuplicate = true;
            activationTimeout = setTimeout(() => void finish({ kind: 'error', message: '比赛已在本地库中，但打开已有档案超时。请重试打开该比赛。' }), 30_000);
            let directory: string;
            try { directory = await library.archiveDirectory(saved.entry.matchId); }
            catch { awaitingDuplicate = false; void finish({ kind: 'error', message: '已有比赛档案当前不可用，请检查比赛库完整性。' }); return; }
            if (settled) return;
            worker.postMessage({ kind: 'restore-duplicate', archiveDirectory: directory, sessionId });
          } else activate({ kind: 'success', report: message.report, selfPlayerId: savedSelf });
        } catch {
          void finish(controller.signal.aborted ? { kind: 'cancelled' } : { kind: 'error', message: '比赛分析完成，但无法安全保存到本地库。请检查磁盘空间和权限后重试。' });
        }
      } else if (message.kind === 'restored-duplicate' && committed && awaitingDuplicate) {
        activate({ kind: 'success', report: message.report, selfPlayerId: duplicateSelfPlayerId });
      } else if(message.kind==='error')void finish(message);
    });
    worker.on('exit', () => { workerExited=true;if(!settled)void finish({ kind: 'error', message: '分析进程意外退出。请重新选择 DEM。' });else if(activeWorker===worker)stopAnalysisWorker(); });
  });
}

/** Reopen a saved archive in a fresh Utility worker; the old session survives until success. */
async function openSavedMatch(matchId: string): Promise<ImportResult> {
  let directory: string;
  let selfPlayerId: string | null = null;
  try {
    const library = await libraryService();
    const entry = library.get(matchId);
    if (!entry || entry.state !== 'ready') return { kind: 'error', message: '该比赛当前不可用。' };
    selfPlayerId = entry.selfPlayerId ?? null;
    directory = await library.archiveDirectory(matchId);
  } catch {
    return { kind: 'error', message: '无法读取已保存的比赛，请检查比赛库完整性。' };
  }
  const sessionId = randomUUID();
  let worker: Electron.UtilityProcess;
  try { worker = utilityProcess.fork(fileURLToPath(new URL('./report-worker.js', import.meta.url)), [], { serviceName: 'CS2 Saved Match Restore' }); }
  catch { return { kind: 'error', message: '无法启动恢复进程；当前比赛保持可用。' }; }
  const exited = new Promise<void>(exit => worker.once('exit', () => { candidateWorkers.delete(worker); exit(); }));
  candidateWorkers.set(worker, exited);
  return new Promise(resolve => {
    let settled = false;
    const finish = async (result: ImportResult, activate = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.removeAllListeners('message');
      if (!activate) {
        await retireCandidate(worker);
        resolve(result);
        return;
      }
      if (result.kind !== 'success') { await retireCandidate(worker); resolve(result); return; }
      // The restored worker keeps serving heatmap and Replay requests for this session.
      worker.on('message', message => {
        if (!message || typeof message !== 'object') return;
        if (message.kind === 'heatmap-grid') routeHeatmapReply(worker, message);
        else if (message.kind === 'replay-chunk') routeReplayReply(worker, message);
      });
      stopAnalysisWorker();
      const report = result.report, replay = report.replay, heatmap = report.heatmap;
      const replayAvailable = replay?.available === true && replay.sessionId === sessionId;
      const heatmapAvailable = heatmap?.available === true && heatmap.sessionId === sessionId;
      activeWorker = worker; activeSessionId = sessionId; activeMatchId = matchId;
      activeReplay = replayAvailable ? replay! : null; activeHeatmap = heatmapAvailable ? heatmap! : null;
      candidateWorkers.delete(worker);
      if (!replayAvailable && !heatmapAvailable) {
        activeWorker = null; activeSessionId = null; activeMatchId = null; void retireCandidate(worker);
      }
      resolve(result);
    };
    const timer = setTimeout(() => void finish({ kind: 'error', message: '打开已保存比赛超时；当前比赛保持可用。' }), 60_000);
    worker.on('spawn', () => {
      if (settled) { worker.kill(); return; }
      worker.postMessage({ kind: 'restore', archiveDirectory: directory, sessionId });
    });
    worker.on('message', message => {
      if (settled || !message || typeof message !== 'object') return;
      if (message.kind === 'restored') {
        const report = message.report;
        if (!report || report.schemaVersion !== 2 || report.match?.id !== matchId
          || (report.replay?.available === true && report.replay.sessionId !== sessionId)
          || (report.heatmap?.available === true && report.heatmap.sessionId !== sessionId)) {
          void finish({ kind: 'error', message: '已保存比赛的报告无效；当前比赛保持可用。' });
          return;
        }
        const validSelf = selfPlayerId && Array.isArray(report.players)
          && report.players.some((player: { id?: unknown }) => player?.id === selfPlayerId) ? selfPlayerId : null;
        void finish({ kind: 'success', report, selfPlayerId: validSelf }, true);
      } else if (message.kind === 'error') void finish(message);
    });
    worker.on('exit', () => {
      if (!settled) void finish({ kind: 'error', message: '恢复进程意外退出；当前比赛保持可用。' });
      else if (activeWorker === worker) stopAnalysisWorker();
    });
  });
}

/** Shared tail of every import path: extension gate, parsing progress, worker analysis. */
async function analyzeFromPath(filePath: string, window: BrowserWindow, rememberDirectory = false, replacement?: ReanalysisTarget): Promise<ImportResult> {
  if (extname(filePath).toLowerCase() !== '.dem') return { kind: 'error', message: '请选择 .dem 文件。' };
  // Injected test paths must not become a real user's recent directory. Persistence is
  // deliberately fire-and-forget so a slow or broken settings write never delays import.
  if (rememberDirectory) void rememberDemoDirectory(filePath);
  if (!window.isDestroyed()) window.webContents.send('report:progress', 'parsing', basename(filePath));
  return await analyzeDemo(filePath, window, replacement);
}

ipcMain.handle('report:import', async (event): Promise<ImportResult> => {
  const window = trustedWindow(event);
  if (!window) {
    return { kind: 'error', message: '无效的报告请求。' };
  }
  if (importing || opening || removing || exporting) return { kind: 'error', message: '已有分析任务正在运行。' };
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
  if (importing || opening || removing || exporting) return { kind: 'error', message: '已有分析任务正在运行。' };
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
  if (process.platform === 'win32' && typeof window.hookWindowMessage === 'function') {
    // A frameless window has no native caption; WM_NCLBUTTONDBLCLK on the drag region
    // must still follow the Windows maximize/restore expectation.
    let lastCaptionDoubleClick = 0;
    const captionDoubleClick = (clientArea: boolean) => (_wParam: Buffer, lParam: Buffer) => {
      const now = Date.now();
      if (now - lastCaptionDoubleClick < 250 || window.isDestroyed()) return;
      const bounds = window.getContentBounds();
      let x: number, y: number;
      if (lParam && lParam.length >= 4) {
        const packed = lParam.readUInt32LE(0);
        x = packed & 0xffff; y = (packed >>> 16) & 0xffff;
        if (clientArea) { x += bounds.x; y += bounds.y; }
      } else {
        const point = screen.getCursorScreenPoint(); x = point.x; y = point.y;
      }
      // The custom 40px titlebar is a caption, but its no-drag groups (history and
      // window controls) are not: only the empty/brand middle may toggle the window.
      const controlsInset = 160;
      if (x < bounds.x + controlsInset || x >= bounds.x + bounds.width - controlsInset
        || y < bounds.y || y >= bounds.y + 40) return;
      lastCaptionDoubleClick = now;
      if (window.isMaximized()) window.unmaximize(); else window.maximize();
    };
    // The drag region is classified as a client area on Windows, so both messages are
    // observed; coordinates come from lParam and are scoped to the caption middle.
    window.hookWindowMessage(0x00A3, captionDoubleClick(false));
    window.hookWindowMessage(0x0203, captionDoubleClick(true));
  }

  mainWindow.on('closed', () => {
    cancelActiveImport?.();cancelPortableOperations();stopAnalysisWorker();
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
  if (shutdownReady || (candidateWorkers.size === 0 && candidateCleanups.size === 0
    && archiveVerifier.activeCount === 0 && portableCleanups.size === 0)) return;
  event.preventDefault();
  if (shutdownRunning) return;
  shutdownRunning = true;
  cancelActiveImport?.();cancelPortableOperations();stopAnalysisWorker();
  // Keep the exclusive library writer lock until every candidate writer has really exited.
  const pending = [...candidateWorkers.entries()];
  for (const [worker] of pending) worker.kill();
  void Promise.all([...pending.map(([, exit]) => exit), archiveVerifier.close()]).then(async () => {
    await Promise.all([...candidateCleanups]);
    await Promise.all([...portableCleanups]);
    libraryInstance?.close();shutdownReady = true;app.quit();
  }).catch(error => { shutdownRunning=false;console.error('Waiting for library writers to exit failed', error); });
});
app.on('will-quit', () => {
  cancelActiveImport?.();cancelPortableOperations();void archiveVerifier.close();
  if (candidateWorkers.size === 0 && archiveVerifier.activeCount === 0 && portableCleanups.size === 0) libraryInstance?.close();
});
