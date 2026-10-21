// In-memory service double for existing Main IPC tests. Archive durability has separate real disk/child-process tests.
import * as libraryIpc from '../shared/library-ipc.ts';
import * as libraryArchive from '../electron/library-archive.ts';
import * as libraryPortable from '../electron/library-portable.ts';
export const tick = () => new Promise(resolve => setImmediate(resolve));
export function mainLibraryRequire(name, require, service = createLibraryDouble(), modules = {}) {
  if (name === './local-library.ts') return { LocalMatchLibrary: { open: async () => service } };
  if (name === '../shared/library-ipc.ts') return libraryIpc;
  if (name === './library-archive.ts') return modules.archive ?? libraryArchive;
  if (name === './library-portable.ts') return modules.portable ?? libraryPortable;
  return require(name);
}
export function createLibraryDouble() {
  return {
    sequence: 0,
    async createStaging() { const id = `stage-${++this.sequence}`; return { id, directory: `C:/owned-test/${id}` }; },
    async discardStaging() {},
    async commitStaging(_id, signal, _receipt, onCommitted) {
      if (signal?.aborted) throw new Error('cancelled');
      onCommitted?.(); return { entry: { matchId: 'match' }, duplicate: false };
    },
    removed: [],
    async remove(matchIds) { this.removed.push([...matchIds]); return { kind: 'success', removed: [...matchIds], failed: [] }; },
    get(matchId) { return { matchId, state: 'ready' }; },
    async archiveDirectory(matchId) { return `C:/owned-test/archive-${matchId}`; },
    list() { return { kind: 'success', entries: [], total: 0, offset: 0, limit: 25 }; },
    async storage() { return { kind: 'success', matchCount: 0, archiveBytes: 0, indexBytes: 0, totalBytes: 0 }; },
    close() {},
  };
}
