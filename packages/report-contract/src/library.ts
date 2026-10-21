/** Small, JSON-only catalogue contracts. Disk paths and archive payloads stay in Main/Utility. */
export interface ArchiveVersions {
  application: string;
  archive: 1;
  report: 2;
  replay: 1;
  analysis: string;
  parser: string;
  native: string;
  sampling: string;
  mapResource: string;
  sourceRevision: string;
}
export type LibraryCapability = { status: 'available' | 'partial' | 'unavailable'; reason: string | null };
export type ArchiveCapabilities = Record<'report' | 'deepReview' | 'timeline' | 'analysis' | 'replay' | 'heatmap', LibraryCapability>;
export interface MatchLibraryEntry {
  matchId: string;
  fileName: string;
  map: string;
  rounds: number;
  score: { initialCT: number; initialT: number } | null;
  players: { id: string; nickname: string }[];
  importedAt: string;
  versions: ArchiveVersions;
  capabilities: ArchiveCapabilities;
  storedBytes: number;
  state: 'ready' | 'invalid' | 'unsupported';
}
export interface LibraryListQuery {
  offset?: number;
  limit?: number;
  search?: string;
  map?: string | null;
  sort?: 'importedAt' | 'map' | 'storedBytes';
  direction?: 'asc' | 'desc';
}
export type LibraryListResult = { kind: 'success'; entries: MatchLibraryEntry[]; total: number; offset: number; limit: number }
  | { kind: 'error'; message: string };
export type LibraryStorageResult = { kind: 'success'; matchCount: number; archiveBytes: number; indexBytes: number; totalBytes: number }
  | { kind: 'error'; message: string };
