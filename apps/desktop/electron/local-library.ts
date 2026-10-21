import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import type { LibraryListQuery, LibraryListResult, LibraryStorageResult, MatchLibraryEntry } from '@cs2-analyst/report-contract';
import { LIBRARY_LIST_RESPONSE_BYTES, boundedLibraryResult, isMatchId, normalizeLibraryListQuery } from '../shared/library-ipc.ts';
import { archiveManifestHash, readArchiveManifest, verifyLibraryArchive, type ArchiveManifest } from './library-archive.ts';

const stagingId = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const samePath = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
type Phase = 'validated' | 'before-rename' | 'after-rename' | 'before-index-commit' | 'after-index-commit';
interface Options {
  /** Internal test seam: never populated from Renderer, IPC, or environment variables. */
  phase?: (phase: Phase, context: { matchId: string; directory: string }) => void | Promise<void>;
  diagnostic?: (message: string) => void;
}
interface Row { match_id: string; entry_json: string; manifest_hash: string; state: string }

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
    return this.db.prepare('SELECT match_id, entry_json, manifest_hash, state FROM matches WHERE match_id=?').get(matchId) as Row | undefined;
  }
  private entry(row: Row): MatchLibraryEntry {
    const entry = JSON.parse(row.entry_json) as MatchLibraryEntry;
    if (!entry || entry.matchId !== row.match_id || !isMatchId(entry.matchId)) throw new Error('比赛库索引记录损坏。');
    return { ...entry, state: row.state as MatchLibraryEntry['state'] };
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
      await plainDirectory(path);
      if (!this.row(item.name)) await this.removeDirectory(path);
    }
    for (const row of this.db.prepare('SELECT match_id, entry_json, manifest_hash, state FROM matches').all() as unknown as Row[]) {
      try {
        this.entry(row);
        const manifest = await readArchiveManifest(join(this.root, 'matches', row.match_id));
        if (manifest.matchId !== row.match_id) throw new Error('Archive identity mismatch');
        // Startup reads bounded manifests only, never decompresses historical matches.
        if (archiveManifestHash(manifest) !== row.manifest_hash) throw new Error('Archive manifest changed');
      } catch (error) {
        // Preserve bytes and the existing record for explicit repair/deletion later.
        const unsupported = (error as { code?: string })?.code === 'ARCHIVE_UNSUPPORTED';
        this.db.prepare('UPDATE matches SET state=? WHERE match_id=?').run(unsupported ? 'unsupported' : 'invalid', row.match_id);
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
      const existing = this.get(manifest.matchId);
      if (existing) {
        if (existing.state !== 'ready') throw new Error('已有比赛归档不可用，请先处理损坏记录。');
        await verifyLibraryArchive(await this.archiveDirectory(manifest.matchId), { signal, mode: 'compressed' });
        abort(signal);
        await this.removeDirectory(source);
        // From this synchronous notification onward Main must resolve success even
        // if a cancellation message arrives before the Promise continuation runs.
        try { onCommitted?.(); } catch { this.options.diagnostic?.('Committed-import notification failed.'); }
        return { entry: existing, duplicate: true };
      }
      const target = join(this.root, 'matches', manifest.matchId);
      const entry = this.manifestEntry(manifest, storedBytes);
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
            .run(entry.matchId, entry.importedAt, entry.map, entry.fileName, entry.storedBytes, manifestHash, 'ready', JSON.stringify(entry));
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
    const rows = this.db.prepare(`SELECT match_id,entry_json,manifest_hash,state FROM matches ${where} ORDER BY ${sort} ${direction},match_id ASC LIMIT ? OFFSET ?`)
      .all(...values, query.limit, query.offset) as unknown as Row[];
    const result: LibraryListResult = { kind: 'success', entries: rows.map(row => this.entry(row)), total, offset: query.offset, limit: query.limit };
    return boundedLibraryResult(result, LIBRARY_LIST_RESPONSE_BYTES);
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
