import type { LibraryListQuery, LibraryListResult, LibraryStorageResult } from '@cs2-analyst/report-contract';

export const LIBRARY_LIST_RESPONSE_BYTES = 512 * 1024;
export const LIBRARY_STORAGE_RESPONSE_BYTES = 16 * 1024;
export const isMatchId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function normalizeLibraryListQuery(value: unknown): Required<LibraryListQuery> | null {
  if (value === undefined) value = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const query = value as Record<string, unknown>;
  if (Object.keys(query).some(key => !['offset', 'limit', 'search', 'map', 'sort', 'direction'].includes(key))) return null;
  const { offset = 0, limit = 25, search = '', map = null, sort = 'importedAt', direction = 'desc' } = query;
  if (!Number.isSafeInteger(offset) || (offset as number) < 0 || (offset as number) > 1_000_000
    || !Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 100
    || typeof search !== 'string' || search.length > 128 || /[\u0000-\u001f]/.test(search)
    || (map !== null && (typeof map !== 'string' || map.length > 64 || !/^[a-zA-Z0-9_-]+$/.test(map)))
    || !['importedAt', 'map', 'storedBytes'].includes(sort as string) || !['asc', 'desc'].includes(direction as string)) return null;
  return { offset, limit, search, map, sort, direction } as Required<LibraryListQuery>;
}
/** A final response-size guard covers future catalogue schema growth too. */
export function boundedLibraryResult<T extends LibraryListResult | LibraryStorageResult>(value: T, bytes: number): T | { kind: 'error'; message: string } {
  try { if (Buffer.byteLength(JSON.stringify(value), 'utf8') <= bytes) return value; } catch { /* Invalid service response. */ }
  return { kind: 'error', message: '比赛库响应超过安全大小限制，请缩小查询范围。' };
}
