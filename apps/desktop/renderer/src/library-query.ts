import type { LibraryListQuery } from '@cs2-analyst/report-contract';

export type LibrarySort = 'importedAt' | 'map' | 'storedBytes';
export type SortDirection = 'asc' | 'desc';

export interface LibraryFilters {
  /** 'all' means no map filter. */
  map: string;
  sort: LibrarySort;
  direction: SortDirection;
}

export const defaultLibraryFilters: LibraryFilters = { map: 'all', sort: 'importedAt', direction: 'desc' };

/** Stable filter options, independent of the currently loaded catalogue page. */
export const libraryMapOptions = ['dust2', 'mirage', 'inferno', 'anubis', 'ancient', 'nuke', 'overpass', 'train', 'cache']
  .map(map => ({ value: `de_${map}`, text: map }));

/** One place that turns UI filter state into the frozen catalogue query. */
export function toLibraryListQuery(filters: LibraryFilters, limit = 100): LibraryListQuery {
  return {
    map: filters.map === 'all' ? null : filters.map,
    sort: filters.sort,
    direction: filters.direction,
    limit,
  };
}

const units = ['B', 'KiB', 'MiB', 'GiB'];
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  let value = bytes, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${unit === 0 ? String(Math.round(value)) : value.toFixed(value >= 10 ? 1 : 2)} ${units[unit]}`;
}

export function formatImportedAt(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '导入时间未知';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function formatImportedDate(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '未知';
  return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
