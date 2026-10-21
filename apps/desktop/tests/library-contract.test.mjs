import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { normalizeLibraryListQuery, boundedLibraryResult, LIBRARY_LIST_RESPONSE_BYTES, LIBRARY_STORAGE_RESPONSE_BYTES, isMatchId } from '../shared/library-ipc.ts';

test('catalogue accepts only bounded pagination and fixed sort/filter values', () => {
  assert.deepEqual(normalizeLibraryListQuery(), { offset: 0, limit: 25, search: '', map: null, sort: 'importedAt', direction: 'desc' });
  assert.equal(normalizeLibraryListQuery({ limit: 100, offset: 1_000_000, map: 'de_nuke', search: '玩家', sort: 'storedBytes', direction: 'asc' }).limit, 100);
  for (const value of [null, [], 'query', { path: '../x' }, { limit: 0 }, { limit: 101 }, { offset: -1 }, { offset: 1_000_001 },
    { limit: NaN }, { offset: 0.5 }, { map: '../nuke' }, { map: 'x'.repeat(65) }, { search: 'x'.repeat(129) }, { search: '\0' }, { sort: 'sql' }, { direction: 'DELETE' }]) {
    assert.equal(normalizeLibraryListQuery(value), null, JSON.stringify(value));
  }
});
test('catalogue identity and outgoing byte limits remain independent of archive size', () => {
  assert.ok(isMatchId('a'.repeat(64)));
  for (const value of ['A'.repeat(64), 'a'.repeat(63), '../' + 'a'.repeat(64), null]) assert.equal(isMatchId(value), false);
  assert.equal(LIBRARY_LIST_RESPONSE_BYTES, 512 * 1024);assert.equal(LIBRARY_STORAGE_RESPONSE_BYTES, 16 * 1024);
  const value = { kind: 'success', entries: [], total: 0, offset: 0, limit: 25, unreadableCount: 0 };
  assert.equal(boundedLibraryResult(value, 1024), value);
  assert.equal(boundedLibraryResult({ ...value, text: '地图'.repeat(1000) }, 1024).kind, 'error');
});
test('preload exposes named catalogue methods and forwards bounded query values without a path or SQL API', async () => {
  const require = createRequire(import.meta.url), { transformSync } = createRequire(require.resolve('vite'))('esbuild');
  const source = transformSync(readFileSync(new URL('../preload/index.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'cjs' }).code;
  let api;const calls=[];
  vm.runInNewContext(source, { require: () => ({ contextBridge: { exposeInMainWorld(_name, value) { api=value; } },
    ipcRenderer: { invoke(...args) { calls.push(args);return Promise.resolve({kind:'success'}); } }, webUtils: {} }) });
  assert.deepEqual(Object.keys(api.library).sort(), ['list', 'open', 'storage']);
  const query = { limit: 10, map: 'de_nuke' }, matchId = 'a'.repeat(64);
  await api.library.list(query);await api.library.storage();await api.library.open(matchId);
  assert.deepEqual(calls, [['library:list', query], ['library:storage'], ['library:open', matchId]]);
});
