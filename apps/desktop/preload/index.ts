import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { DesktopApi, ImportPhase, ImportPlayerChoice, LibraryProgress } from '@cs2-analyst/report-contract';

const api: DesktopApi = {
  version: '0.1.0',
  library: {
    list: query => ipcRenderer.invoke('library:list', query),
    storage: () => ipcRenderer.invoke('library:storage'),
    open: matchId => ipcRenderer.invoke('library:open', matchId),
    remove: matchIds => ipcRenderer.invoke('library:remove', matchIds),
    exportMatch: matchId => ipcRenderer.invoke('library:export', matchId),
    importArchive: () => ipcRenderer.invoke('library:import'),
    setSelfPlayer: (matchId, playerId) => ipcRenderer.invoke('library:set-self-player', matchId, playerId),
  },
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),
    close: () => ipcRenderer.invoke('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
    onMaximizedChange: listener => {
      const handler = (_event: Electron.IpcRendererEvent, maximized: boolean) => listener(maximized);
      ipcRenderer.on('window:maximized-changed', handler);
      return () => ipcRenderer.removeListener('window:maximized-changed', handler);
    },
  },
  importDemo: () => ipcRenderer.invoke('report:import'),
  importDroppedFile: async file => {
    // Only Electron can resolve a disk-backed File; never accept a renderer path.
    let filePath: string;
    try { filePath = webUtils.getPathForFile(file); }
    catch { return { kind: 'error', message: '无法读取拖入文件的位置，请改用点击选择。' }; }
    if (!filePath) return { kind: 'error', message: '无法读取拖入文件的位置，请改用点击选择。' };
    return ipcRenderer.invoke('report:import-file', filePath);
  },
  selectImportPlayer: playerId => ipcRenderer.invoke('report:select-player', playerId),
  onImportPlayers: listener => {
    const handler = (_event: Electron.IpcRendererEvent, players: ImportPlayerChoice[]) => listener(players);
    ipcRenderer.on('report:import-players', handler);
    return () => ipcRenderer.removeListener('report:import-players', handler);
  },
  cancelImport: () => ipcRenderer.invoke('report:cancel'),
  replay: {
    getChunk: request => ipcRenderer.invoke('replay:chunk', { sessionId:request.sessionId,round:request.round,block:request.block }),
    release: sessionId => ipcRenderer.invoke('replay:release',sessionId),
  },
  session: { release: sessionId => ipcRenderer.invoke('session:release',sessionId) },
  heatmap: { getGrid: request => ipcRenderer.invoke('heatmap:grid',request) },
  onProgress: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, phase: ImportPhase, fileName?: string) => listener(phase, fileName);
    ipcRenderer.on('report:progress', handler);
    return () => ipcRenderer.removeListener('report:progress', handler);
  },
  onLibraryProgress: listener => {
    const handler = (_event: Electron.IpcRendererEvent, progress: LibraryProgress) => listener(progress);
    ipcRenderer.on('library:progress', handler);
    return () => ipcRenderer.removeListener('library:progress', handler);
  },
};
contextBridge.exposeInMainWorld('cs2Analyst', api);
