import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import type { LibraryDeleteResult, LibraryListQuery, LibraryListResult, LibraryStorageResult, MatchLibraryEntry } from '@cs2-analyst/report-contract';
import { LIBRARY_LIST_RESPONSE_BYTES, boundedLibraryResult, isMatchId, normalizeLibraryListQuery } from '../shared/library-ipc.ts';
import { LIBRARY_METADATA_LIMITS, archiveManifestHash, readArchiveManifest, readArchiveReport, verifyLibraryArchive, type ArchiveManifest } from './library-archive.ts';
import { PERFORMANCE_CACHE_VERSION, reportPlayerSummaries, validCachedPlayerSummaries } from './player-performance.ts';

const stagingId = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const samePath = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
/**
 * Only definitive archive corruption may demote a ready row. Filesystem errors such as
 * EBUSY/EACCES/ENOENT from antivirus or a transient lock must leave the healthy record
 * ready and let the next open/export retry.
 */
export function isDefinitiveArchiveFailure(error: unknown): boolean {
  const code = (error as { code?: string })?.code;
  if (code === 'ARCHIVE_UNSUPPORTED') return true;
  if (typeof code === 'string' && /^E[A-Z]+$/.test(code)) return false;
  return error instanceof Error && error.message.startsWith('Invalid match archive');
}
type Phase = 'validated' | 'before-rename' | 'after-rename' | 'before-index-commit' | 'after-index-commit';
interface Options {
  /** Internal test seam: never populated from Renderer, IPC, or environment variables. */
  phase?: (phase: Phase, context: { matchId: string; directory: string }) => void | Promise<void>;
  diagnostic?: (message: string) => void;
}
interface Row { match_id: string; entry_json: string; manifest_hash: string; state: string;
  imported_at: string; map: string; file_name: string; stored_bytes: number }
const rowColumns = 'match_id,entry_json,manifest_hash,state,imported_at,map,file_name,stored_bytes';
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const shortText = (value: unknown, max = 256): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f]/.test(value);
const nonnegative = (value: unknown, max = Number.MAX_SAFE_INTEGER): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max;
function validEntry(value: unknown): value is MatchLibraryEntry {
  if (!record(value) || !isMatchId(value.matchId) || !shortText(value.fileName, LIBRARY_METADATA_LIMITS.fileName) || /[\\/:]/.test(value.fileName)
    || !shortText(value.map, LIBRARY_METADATA_LIMITS.map) || !nonnegative(value.rounds, LIBRARY_METADATA_LIMITS.rounds)
    || !nonnegative(value.storedBytes) || typeof value.importedAt !== 'string' || !Number.isFinite(Date.parse(value.importedAt))
    || !Array.isArray(value.players) || value.players.length > LIBRARY_METADATA_LIMITS.players
    || !record(value.versions) || !record(value.capabilities)
    || !['ready', 'invalid', 'unsupported'].includes(value.state as string)) return false;
  if (value.score !== null && (!record(value.score) || !nonnegative(value.score.initialCT, LIBRARY_METADATA_LIMITS.rounds)
    || !nonnegative(value.score.initialT, LIBRARY_METADATA_LIMITS.rounds))) return false;
  if (!value.players.every(player => record(player) && shortText(player.id) && typeof player.nickname === 'string'
    && player.nickname.length <= LIBRARY_METADATA_LIMITS.nickname && !player.nickname.includes('\0'))) return false;
  const versions = value.versions;
  if (versions.archive !== 1 || versions.report !== 2 || versions.replay !== 1
    || !['application', 'analysis', 'parser', 'native', 'sampling', 'mapResource'].every(key => shortText(versions[key], LIBRARY_METADATA_LIMITS.version))
    || typeof versions.sourceRevision !== 'string' || !/^[a-f0-9]{40}$/.test(versions.sourceRevision)) return false;
  const capabilities = value.capabilities;
  return ['report', 'deepReview', 'timeline', 'analysis', 'replay', 'heatmap'].every(key => {
    const capability = capabilities[key];
    return record(capability) && ['available', 'partial', 'unavailable'].includes(capability.status as string)
      && (capability.reason === null || shortText(capability.reason, LIBRARY_METADATA_LIMITS.reason))
      && (capability.status === 'available' || capability.reason !== null);
  });
}

function localAbsolute(value: unknown): string {
  if (typeof value !== 'string' || !value || !isAbsolute(value) || value.includes('\0')) throw new Error('比赛库需要有效的本机绝对路径。');
  const path = resolve(value);
  if (path.startsWith('\\\\') || path.startsWith('//')) throw new Error('比赛库不能位于网络或设备路径。');
  return path;
}

/** Production never follows userData, renderer arguments, or a custom test-path variable. */
export function localMatchLibraryRoot(localAppData: unknown = process.env.LOCALAPPDATA): string {
  return join(localAbsolute(localAppData), 'CS2 Analyst', 'MatchLibrary');
}

async function plainDirectory(path: string, create = false): Promise<string> {
  const absolute = localAbsolute(path), volume = parse(absolute).root;
  let current = volume;
  for (const part of relative(volume, absolute).split(sep).filter(Boolean)) {
    current = join(current, part);
    let info;
    try { info = await lstat(current); }
    catch (error) {
      if (!create || !missing(error)) throw error;
      await mkdir(current);
      info = await lstat(current);
    }
    if (!info.isDirectory() || info.isSymbolicLink() || !samePath(realpathSync(current), current)) throw new Error('比赛库目录包含重定向或无效目录。');
    // Native realpath expands valid Windows 8.3 aliases (common in TEMP).
    // Resolve only after the non-native check and lstat reject reparse redirects.
    current = await realpath(current);
  }
  return current;
}

async function plainFileIfPresent(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || !samePath(await realpath(path), path)) throw new Error('比赛库文件包含重定向或无效文件。');
  } catch (error) { if (!missing(error)) throw error; }
}

/** Inspect before any recursive cleanup; never let a junction redirect a removal. */
async function treeBytes(path: string, depth = 0): Promise<number> {
  if (depth > 5) throw new Error('比赛库目录层级无效。');
  await plainDirectory(path);
  let bytes = 0;
  for (const child of await readdir(path, { withFileTypes: true })) {
    const full = join(path, child.name), info = await lstat(full);
    if (info.isSymbolicLink() || !samePath(await realpath(full), full)) throw new Error('比赛库包含重定向文件。');
    if (info.isDirectory()) bytes += await treeBytes(full, depth + 1);
    else if (info.isFile() && info.nlink === 1) bytes += info.size;
    else throw new Error('比赛库包含无效文件。');
  }
  return bytes;
}

function abort(signal?: AbortSignal): void { if (signal?.aborted) throw new DOMException('Import cancelled', 'AbortError'); }
function retryable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : '';
  return /(?:database is (?:locked|busy)|disk I\/O error)/i.test(message);
}

/** A small SQLite catalogue. Archive compression and domain payloads belong to Utility. */
export class LocalMatchLibrary {
  readonly root: string;
  private readonly db: DatabaseSync;
  private readonly options: Options;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private constructor(root: string, db: DatabaseSync, options: Options) { this.root = root; this.db = db; this.options = options; }

  static async open(root = localMatchLibraryRoot(), options: Options = {}): Promise<LocalMatchLibrary> {
    root = localAbsolute(root);
    root = await plainDirectory(root, true);
    await plainDirectory(join(root, 'matches'), true);
    await plainDirectory(join(root, 'staging'), true);
    const database = join(root, 'library.db');
    for (const suffix of ['', '-wal', '-shm', '-journal']) await plainFileIfPresent(database + suffix);
    let db: DatabaseSync | undefined;
    // SQLite may briefly retain Windows handles just after a killed process exits.
    // Retry only recognized IOERR/BUSY errors, with a strict bound and diagnostics.
    for (const [attempt, wait] of [0, 25, 50, 100, 250].entries()) {
      if (wait) await new Promise(resolveWait => setTimeout(resolveWait, wait));
      try {
        db = new DatabaseSync(database);
        db.exec('PRAGMA busy_timeout=100; PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
        const version = db.prepare('PRAGMA user_version').get()?.user_version;
        if (version !== 0 && version !== 1) throw new Error('比赛库由不受支持的版本创建。');
        db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE IF NOT EXISTS matches (
            match_id TEXT PRIMARY KEY CHECK(length(match_id)=64),
            imported_at TEXT NOT NULL, map TEXT NOT NULL, file_name TEXT NOT NULL,
            stored_bytes INTEGER NOT NULL CHECK(stored_bytes>=0),
            manifest_hash TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('ready','invalid','unsupported')),
            entry_json TEXT NOT NULL CHECK(length(entry_json)<=65536)
          );
          CREATE INDEX IF NOT EXISTS matches_imported_at ON matches(imported_at);
          CREATE INDEX IF NOT EXISTS matches_map ON matches(map);
          CREATE TABLE IF NOT EXISTS player_summary_cache (
            match_id TEXT PRIMARY KEY, manifest_hash TEXT NOT NULL, cache_version TEXT NOT NULL,
            summary_json TEXT NOT NULL CHECK(length(summary_json)<=262144)
          );
          PRAGMA user_version=1;
          COMMIT;`);
        break;
      } catch (error) {
        try { db?.close(); } catch { /* Release a failed opening handle before retry. */ }
        db = undefined;
        if (!retryable(error) || attempt === 4) throw error;
        options.diagnostic?.(`SQLite opening retry ${attempt + 1}: ${error instanceof Error ? error.message : 'I/O error'}`);
      }
    }
    if (!db) throw new Error('无法打开本地比赛库。');
    const library = new LocalMatchLibrary(root, db, options);
    try { await library.recover(); return library; }
    catch (error) { db.close(); throw error; }
  }

  private assertOpen(): void { if (this.closed) throw new Error('比赛库已关闭。'); }
  private async directories(): Promise<void> {
    await plainDirectory(this.root);
    await plainDirectory(join(this.root, 'matches'));
    await plainDirectory(join(this.root, 'staging'));
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(() => { this.assertOpen(); return operation(); });
    this.queue = next.catch(() => undefined);
    return next;
  }
  private async removeDirectory(path: string): Promise<void> {
    await this.directories();
    await treeBytes(path);
    await rm(path, { recursive: true, maxRetries: 5, retryDelay: 25 });
  }

  private row(matchId: string): Row | undefined {
    this.assertOpen();
    if (!isMatchId(matchId)) throw new Error('无效的比赛标识。');
    return this.db.prepare(`SELECT ${rowColumns} FROM matches WHERE match_id=?`).get(matchId) as Row | undefined;
  }
  private entry(row: Row): MatchLibraryEntry {
    let entry: MatchLibraryEntry;
    try { entry = JSON.parse(row.entry_json) as MatchLibraryEntry; }
    catch { throw new Error('比赛库索引记录损坏。'); }
    if (!validEntry(entry) || entry.matchId !== row.match_id
      || !['ready', 'invalid', 'unsupported'].includes(row.state)) throw new Error('比赛库索引记录损坏。');
    return { ...entry, state: row.state as MatchLibraryEntry['state'] };
  }
  private storedBytes(manifest: ArchiveManifest): number {
    return Buffer.byteLength(JSON.stringify(manifest)) + manifest.files.reduce((sum, file) => sum + file.gzipBytes, 0);
  }
  private matchesSnapshot(row: Row, entry: MatchLibraryEntry, manifest: ArchiveManifest, storedBytes: number): boolean {
    const expected = this.manifestEntry(manifest, storedBytes);
    // Compare only the explicitly owned contract fields, independent of object key order.
    const values = (value: MatchLibraryEntry) => [value.matchId, value.fileName, value.map, value.rounds, value.score,
      value.players, value.importedAt, value.versions, value.capabilities, value.storedBytes];
    return row.match_id === manifest.matchId && row.imported_at === expected.importedAt && row.map === expected.map
      && row.file_name === expected.fileName && row.stored_bytes === storedBytes
      && JSON.stringify(values(entry)) === JSON.stringify(values(expected));
  }

  /** Reconcile interrupted new imports without replacing or deleting existing indexed records. */
  private async recover(): Promise<void> {
    await this.directories();
    for (const item of await readdir(join(this.root, 'staging'), { withFileTypes: true })) {
      if (!stagingId.test(item.name)) throw new Error('比赛库暂存目录包含未知项目。');
      await this.removeDirectory(join(this.root, 'staging', item.name));
    }
    for (const item of await readdir(join(this.root, 'matches'), { withFileTypes: true })) {
      if (!isMatchId(item.name)) throw new Error('比赛库包含未知比赛目录。');
      const path = join(this.root, 'matches', item.name);
      // A row-less directory is an interrupted-delete orphan. If it cannot be removed
      // (junction/ACL/EBUSY), retain it with a diagnostic instead of making the whole
      // catalogue unopenable; the next restart can retry.
      if (!this.row(item.name)) {
        try { await this.removeDirectory(path); }
        catch (error) {
          this.options.diagnostic?.('Orphan archive ' + item.name + ' retained: ' + (error instanceof Error ? error.message : 'unknown'));
        }
      }
    }
    for (const row of this.db.prepare(`SELECT ${rowColumns} FROM matches`).all() as unknown as Row[]) {
      let trustedManifest: ArchiveManifest | null = null;
      try {
        if (!isMatchId(row.match_id)) throw new Error('Invalid catalogue match identity');
        const manifest = await readArchiveManifest(join(this.root, 'matches', row.match_id));
        if (manifest.matchId !== row.match_id) throw new Error('Archive identity mismatch');
        // Startup reads bounded manifests only, never decompresses historical matches.
        if (archiveManifestHash(manifest) !== row.manifest_hash) throw new Error('Archive manifest changed');
        trustedManifest = manifest;
        if (!this.matchesSnapshot(row, this.entry(row), manifest, this.storedBytes(manifest))) throw new Error('Catalogue snapshot changed');
      } catch (error) {
        // Preserve bytes and the existing record for explicit repair/deletion later.
        const unsupported = (error as { code?: string })?.code === 'ARCHIVE_UNSUPPORTED';
        if (trustedManifest) {
          // A valid manifest whose digest still matches SQLite can recover the small
          // summary, but corruption is never promoted back to ready automatically.
          const recovered = { ...this.manifestEntry(trustedManifest, this.storedBytes(trustedManifest)), state: 'invalid' as const };
          this.db.prepare('UPDATE matches SET entry_json=?,state=?,imported_at=?,map=?,file_name=?,stored_bytes=? WHERE match_id=?')
            .run(JSON.stringify(recovered), 'invalid', recovered.importedAt, recovered.map, recovered.fileName, recovered.storedBytes, row.match_id);
        } else this.db.prepare('UPDATE matches SET state=? WHERE match_id=?').run(unsupported ? 'unsupported' : 'invalid', row.match_id);
        this.options.diagnostic?.(`Archive ${row.match_id} marked ${unsupported ? 'unsupported' : 'invalid'}`);
      }
    }
  }

  createStaging(): Promise<{ id: string; directory: string }> {
    return this.serial(async () => {
      await this.directories();
      const id = randomUUID(), directory = join(this.root, 'staging', id);
      await mkdir(directory);
      await plainDirectory(directory);
      return { id, directory };
    });
  }
  discardStaging(id: string): Promise<void> {
    return this.serial(async () => {
      if (!stagingId.test(id)) throw new Error('无效的比赛暂存标识。');
      const path = join(this.root, 'staging', id);
      try { await this.removeDirectory(path); } catch (error) { if (!missing(error)) throw error; }
    });
  }

  commitStaging(id: string, signal?: AbortSignal, receipt?: { manifestHash: string; storedBytes: number }, onCommitted?: () => void): Promise<{ entry: MatchLibraryEntry; duplicate: boolean }> {
    return this.serial(async () => {
      if (!stagingId.test(id)) throw new Error('无效的比赛暂存标识。');
      await this.directories();
      const source = join(this.root, 'staging', id);
      abort(signal);
      const verified = await verifyLibraryArchive(source, { signal, mode: 'compressed' });
      if (receipt && (receipt.manifestHash !== verified.manifestHash || receipt.storedBytes !== verified.storedBytes)) throw new Error('比赛归档写入结果不一致。');
      const { manifest, manifestHash, storedBytes } = verified;
      const context = { matchId: manifest.matchId, directory: source };
      await this.options.phase?.('validated', context);
      abort(signal);
      const existingRow = this.row(manifest.matchId);
      if (existingRow) {
        const existing = this.entry(existingRow);
        if (existing.state !== 'ready') throw new Error('已有比赛归档不可用，请先处理损坏记录。');
        let previous;
        try { previous = await verifyLibraryArchive(await this.archiveDirectory(manifest.matchId), { signal, mode: 'compressed' }); }
        catch (error) {
          if (!signal?.aborted && isDefinitiveArchiveFailure(error)) {
            this.db.prepare('UPDATE matches SET state=? WHERE match_id=?').run('invalid', manifest.matchId);
          } else if (!signal?.aborted) {
            this.options.diagnostic?.('Existing archive ' + manifest.matchId + ' temporarily unreadable; state retained.');
          }
          throw error;
        }
        if (previous.manifestHash !== existingRow.manifest_hash
          || !this.matchesSnapshot(existingRow, existing, previous.manifest, previous.storedBytes)) {
          this.db.prepare('UPDATE matches SET state=? WHERE match_id=?').run('invalid', manifest.matchId);
          throw new Error('已有比赛归档与持久索引不一致，请先处理损坏记录。');
        }
        abort(signal);
        await this.removeDirectory(source);
        // From this synchronous notification onward Main must resolve success even
        // if a cancellation message arrives before the Promise continuation runs.
        try { onCommitted?.(); } catch { this.options.diagnostic?.('Committed-import notification failed.'); }
        return { entry: existing, duplicate: true };
      }
      const target = join(this.root, 'matches', manifest.matchId);
      const entry = this.manifestEntry(manifest, storedBytes);
      // The SQLite row check is a character bound; enforce the byte bound here so a
      // contract-valid maximum roster cannot fail after the archive has been renamed.
      const entryJson = JSON.stringify(entry);
      if (Buffer.byteLength(entryJson) > 65536) throw new Error('比赛库索引记录超过安全大小限制。');
      let moved = false, committed = false;
      try {
        await this.options.phase?.('before-rename', context);
        abort(signal);
        try { await lstat(target); throw new Error('比赛归档目标已存在，不能覆盖。'); }
        catch (error) { if (!missing(error)) throw error; }
        await rename(source, target);
        moved = true;
        await this.options.phase?.('after-rename', { ...context, directory: target });
        abort(signal);
        await this.options.phase?.('before-index-commit', { ...context, directory: target });
        abort(signal);
        // No awaits between BEGIN and COMMIT: commit is the cancellation linearization point.
        this.db.exec('BEGIN IMMEDIATE');
        try {
          this.db.prepare('INSERT INTO matches(match_id,imported_at,map,file_name,stored_bytes,manifest_hash,state,entry_json) VALUES(?,?,?,?,?,?,?,?)')
            .run(entry.matchId, entry.importedAt, entry.map, entry.fileName, entry.storedBytes, manifestHash, 'ready', entryJson);
          this.db.exec('COMMIT');
          committed = true;
          try { onCommitted?.(); } catch { this.options.diagnostic?.('Committed-import notification failed.'); }
        } catch (error) { try { this.db.exec('ROLLBACK'); } catch { /* Preserve the original transaction failure. */ } throw error; }
        try { await this.options.phase?.('after-index-commit', { ...context, directory: target }); }
        catch { this.options.diagnostic?.('Post-commit observer failed; durable import remains successful.'); }
        return { entry, duplicate: false };
      } catch (error) {
        if (moved && !committed) {
          try { await this.removeDirectory(target); }
          catch { this.options.diagnostic?.('Interrupted archive cleanup deferred until restart.'); }
        }
        throw error;
      }
    });
  }

  private manifestEntry(manifest: ArchiveManifest, storedBytes: number): MatchLibraryEntry {
    return { matchId: manifest.matchId, ...manifest.summary, importedAt: manifest.createdAt,
      versions: manifest.versions, capabilities: manifest.capabilities, storedBytes, state: 'ready' };
  }
  get(matchId: string): MatchLibraryEntry | null { const row = this.row(matchId); return row ? this.entry(row) : null; }
  async archiveDirectory(matchId: string): Promise<string> {
    const entry = this.get(matchId);
    if (!entry || entry.state !== 'ready') throw new Error('比赛归档不可用。');
    await this.directories();
    const path = join(this.root, 'matches', matchId);
    await plainDirectory(path);
    return path;
  }

  list(value: LibraryListQuery = {}): LibraryListResult {
    this.assertOpen();
    const query = normalizeLibraryListQuery(value);
    if (!query) return { kind: 'error', message: '无效的比赛库查询。' };
    // SQL text is selected from fixed constants. User strings are always bound values.
    const sort = { importedAt: 'imported_at', map: 'map', storedBytes: 'stored_bytes' }[query.sort];
    const direction = query.direction === 'asc' ? 'ASC' : 'DESC';
    const where = 'WHERE (? IS NULL OR map=?) AND (?=\'\' OR instr(lower(file_name),lower(?))>0 OR instr(lower(map),lower(?))>0)';
    const values = [query.map, query.map, query.search, query.search, query.search];
    const total = Number(this.db.prepare(`SELECT count(*) AS count FROM matches ${where}`).get(...values)?.count ?? 0);
    const rows = this.db.prepare(`SELECT ${rowColumns} FROM matches ${where} ORDER BY ${sort} ${direction},match_id ASC LIMIT ? OFFSET ?`)
      .all(...values, query.limit, query.offset) as unknown as Row[];
    const entries: MatchLibraryEntry[] = [];
    let unreadableCount = 0;
    for (const row of rows) {
      try { entries.push(this.entry(row)); }
      catch {
        unreadableCount++;
        this.db.prepare('UPDATE matches SET state=? WHERE match_id=?').run('invalid', row.match_id);
        this.options.diagnostic?.(`Catalogue ${row.match_id} omitted from this page: unreadable index record`);
      }
    }
    const result: LibraryListResult = { kind: 'success', entries, unreadableCount, total, offset: query.offset, limit: query.limit };
    return boundedLibraryResult(result, LIBRARY_LIST_RESPONSE_BYTES);
  }

  /**
   * Derive only the requested page once from saved report metrics, never DEM/Replay.
   * The original archive, manifest hash, catalogue snapshot and import date remain immutable.
   */
  listWithPerformance(value: LibraryListQuery = {}): Promise<LibraryListResult> {
    return this.serial(async () => {
      let query = value;
      while (true) {
        const result = this.list(query);
        if (result.kind !== 'success') return result;
        let overBudget = false;
        for (const entry of result.entries) {
          if (entry.state !== 'ready') continue;
          const row = this.row(entry.matchId);
          if (!row) continue;
          const cached = this.db.prepare('SELECT manifest_hash,cache_version,summary_json FROM player_summary_cache WHERE match_id=?')
            .get(entry.matchId) as { manifest_hash: string; cache_version: string; summary_json: string } | undefined;
          if (cached?.manifest_hash === row.manifest_hash && cached.cache_version === PERFORMANCE_CACHE_VERSION) {
            try {
              const summary: unknown = JSON.parse(cached.summary_json);
              if (validCachedPlayerSummaries(summary, entry.players.map(p => p.id))) {
                Object.assign(entry, summary);
                if (Buffer.byteLength(JSON.stringify(result)) > LIBRARY_LIST_RESPONSE_BYTES) { overBudget = true; break; }
                continue;
              }
            } catch { /* Malformed derived data is rebuilt without demoting the source archive. */ }
          }
          try {
            const directory = await this.archiveDirectory(entry.matchId);
            const manifest = await readArchiveManifest(directory);
            if (archiveManifestHash(manifest) !== row.manifest_hash) throw new Error('Archive manifest changed');
            // readArchiveReport verifies this bounded component's compressed/raw digests.
            const report = await readArchiveReport(directory, manifest, randomUUID());
            const summary = reportPlayerSummaries(report);
            const json = JSON.stringify(summary);
            if (Buffer.byteLength(json) > 262144 || !validCachedPlayerSummaries(summary, entry.players.map(p => p.id))) {
              throw new Error('Invalid derived player summaries');
            }
            this.db.prepare('INSERT OR REPLACE INTO player_summary_cache(match_id,manifest_hash,cache_version,summary_json) VALUES(?,?,?,?)')
              .run(entry.matchId, row.manifest_hash, PERFORMANCE_CACHE_VERSION, json);
            Object.assign(entry, summary);
            if (Buffer.byteLength(JSON.stringify(result)) > LIBRARY_LIST_RESPONSE_BYTES) { overBudget = true; break; }
          } catch (error) {
            // A missing/unreadable metric is unknown, never zero; open keeps its original full verification.
            this.options.diagnostic?.(`Player summary ${entry.matchId} unavailable: ${error instanceof Error ? error.message : 'unknown'}`);
          }
        }
        if (!overBudget || result.limit === 1) return boundedLibraryResult(result, LIBRARY_LIST_RESPONSE_BYTES);
        // Re-query a smaller SQL page, so offset + limit still identifies the next row exactly,
        // including invalid rows omitted by list(). Already derived summaries are reused.
        query = { ...query, limit: Math.max(1, Math.floor(result.limit / 2)) };
      }
    });
  }
  /**
   * Delete catalogue rows in short transactions, then remove the owned archive
   * directories. A directory that survives a failure has already lost its row and is
   * therefore an orphan that the existing startup recovery removes; no other match is
   * touched and capacities keep reflecting the files that actually remain on disk.
   */
  remove(matchIds: unknown): Promise<LibraryDeleteResult> {
    return this.serial(async () => {
      if (!Array.isArray(matchIds) || matchIds.length < 1 || matchIds.length > 100
        || !matchIds.every(matchId => isMatchId(matchId)) || new Set(matchIds).size !== matchIds.length) {
        return { kind: 'error', message: '无效的删除请求。' };
      }
      const removed: string[] = [], failed: { matchId: string; message: string }[] = [];
      for (const matchId of matchIds as string[]) {
        try {
          if (!this.row(matchId)) throw new Error('比赛不存在或已被删除。');
          this.db.exec('BEGIN IMMEDIATE');
          try {
            const result = this.db.prepare('DELETE FROM matches WHERE match_id=?').run(matchId);
            if (Number(result.changes) !== 1) throw new Error('比赛索引未能删除。');
            this.db.prepare('DELETE FROM player_summary_cache WHERE match_id=?').run(matchId);
            this.db.exec('COMMIT');
          } catch (error) { try { this.db.exec('ROLLBACK'); } catch { /* Preserve the delete failure. */ } throw error; }
          try {
            await this.removeDirectory(join(this.root, 'matches', matchId));
          } catch (error) {
            if (!missing(error)) {
              this.options.diagnostic?.('Removed catalogue row ' + matchId + ', but archive cleanup failed: ' + (error instanceof Error ? error.message : 'unknown'));
              throw new Error('比赛索引已删除，但归档目录暂时无法清理；重启后会再次尝试，期间该目录可能仍占用空间。');
            }
          }
          removed.push(matchId);
        } catch (error) {
          failed.push({ matchId, message: error instanceof Error ? error.message : '删除比赛失败。' });
        }
      }
      return { kind: 'success', removed, failed };
    });
  }

  async storage(): Promise<LibraryStorageResult> {
    this.assertOpen();
    await this.directories();
    const archiveBytes = await treeBytes(join(this.root, 'matches'));
    const stagingBytes = await treeBytes(join(this.root, 'staging'));
    let indexBytes = 0;
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      const path = join(this.root, 'library.db') + suffix;
      await plainFileIfPresent(path);
      try { indexBytes += (await stat(path)).size; } catch (error) { if (!missing(error)) throw error; }
    }
    const matchCount = Number(this.db.prepare('SELECT count(*) AS count FROM matches').get()?.count ?? 0);
    return { kind: 'success', matchCount, archiveBytes, indexBytes, totalBytes: archiveBytes + indexBytes + stagingBytes };
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
