import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { gzip as gzipCallback, gunzip as gunzipCallback } from 'node:zlib';
import type { Match, MatchReplay, MatchSpatialEvidence } from '@cs2-analyst/match-model';
import type { ArchiveVersions, ArchiveCapabilities, LibraryCapability, DesktopMatchReport, DesktopReplayChunk, DesktopReplayRequest } from '@cs2-analyst/report-contract';
import { upgradeReportPerformance } from './player-performance.ts';
export type { ArchiveVersions, ArchiveCapabilities } from '@cs2-analyst/report-contract';

const gzip = promisify(gzipCallback), gunzip = promisify(gunzipCallback);
const MiB = 1024 * 1024;
const restoredSessionBytes = Buffer.byteLength(',"sessionId":"00000000-0000-0000-0000-000000000000"');
export const LIBRARY_ARCHIVE_LIMITS = Object.freeze({ manifestBytes: MiB, fileCount: 4096,
  componentBytes: 256 * MiB, reportBytes: 16 * MiB, totalRawBytes: 512 * MiB,
  totalGzipBytes: 256 * MiB, chunkBytes: MiB, replayBytes: 64 * MiB, players: 64, rounds: 1024 });
/** Summary metadata shared with the SQLite catalogue. A written manifest must stay listable. */
export const LIBRARY_METADATA_LIMITS = Object.freeze({ fileName: 256, map: 64, rounds: 1024,
  players: 64, nickname: 512, version: 1024, reason: 512 });
const capabilityNames = ['report', 'deepReview', 'timeline', 'analysis', 'replay', 'heatmap'] as const;
export type ArchiveFileRole = 'report' | 'heatmap-match' | 'heatmap-replay' | 'heatmap-spatial' | 'replay-chunk';
export interface ArchiveFile { path: string; role: ArchiveFileRole; rawBytes: number; gzipBytes: number;
  sha256: string; gzipSha256: string; round?: number; block?: number }
export interface ArchiveManifest {
  format: 'cs2-analyst-match'; schemaVersion: 1; matchId: string; createdAt: string;
  summary: { fileName: string; map: string; rounds: number; score: { initialCT: number; initialT: number } | null;
    players: { id: string; nickname: string }[] };
  versions: ArchiveVersions; capabilities: ArchiveCapabilities; files: ArchiveFile[];
}
export interface ArchiveWriteInput { report: DesktopMatchReport; chunks: ReadonlyMap<string, string>;
  match: Match; replay: MatchReplay | null; spatial: MatchSpatialEvidence | null; versions: ArchiveVersions }
export interface ArchiveWriteResult { manifest: ArchiveManifest; manifestHash: string; storedBytes: number }
interface ArchiveOptions { signal?: AbortSignal; mode?: 'full' | 'compressed' }
type JsonObject = Record<string, unknown>;
function fail(reason: string): never { throw new Error(`Invalid match archive: ${reason}`); }
function unsupportedVersion(value: unknown): boolean {
  if (!plain(value) || value.format !== 'cs2-analyst-match') return false;
  if (integer(value.schemaVersion, 1) && value.schemaVersion !== 1) return true;
  return plain(value.versions) && Object.entries({ archive: 1, report: 2, replay: 1 }).some(([key, supported]) =>
    integer((value.versions as JsonObject)[key], 1) && (value.versions as JsonObject)[key] !== supported);
}
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const plain = (value: unknown): value is JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const keys = (value: unknown, required: string[], optional: string[] = []): value is JsonObject => plain(value)
  && required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const text = (value: unknown, max = 256): value is string => typeof value === 'string' && value.length > 0
  && value.length <= max && !/[\u0000-\u001f]/.test(value);
const integer = (value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number => typeof value === 'number'
  && Number.isSafeInteger(value) && value >= min && value <= max;
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const samePath = (a: string, b: string) => process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);
function inside(root: string, candidate: string) {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}
function aborted(options?: ArchiveOptions) { options?.signal?.throwIfAborted(); }

/** Reject a redirected root and every symlink/junction between root and directory. */
export async function assertArchiveDirectory(root: string, directory: string): Promise<void> {
  if (!isAbsolute(root) || !isAbsolute(directory) || !inside(root, directory)) fail('directory outside archive root');
  const absoluteRoot = resolve(root), absoluteDirectory = resolve(directory);
  // realpath expands harmless Windows 8.3 aliases (EVANPA~1). lstat each ancestor
  // distinguishes those aliases from real symlink/junction redirection.
  let current = parse(absoluteRoot).root;
  for (const segment of absoluteRoot.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, segment);
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) fail('unsafe archive directory');
  }
  const canonicalRoot = await realpath(absoluteRoot);
  current = absoluteRoot;
  for (const segment of relative(absoluteRoot, absoluteDirectory).split(sep).filter(Boolean)) {
    current = join(current, segment);
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink() || !inside(canonicalRoot, await realpath(current))) fail('unsafe archive directory');
  }
}

async function safeFileRealpath(target: string): Promise<boolean> {
  return samePath(await realpath(target), join(await realpath(dirname(target)), basename(target)));
}

async function readBounded(directory: string, path: string, maximum: number, exact?: number): Promise<Buffer> {
  const target = join(directory, ...path.split('/'));
  if (!inside(directory, target)) fail('payload path');
  await assertArchiveDirectory(directory, dirname(target));
  const before = await lstat(target);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink > 1 || !await safeFileRealpath(target)
    || before.size > maximum || (exact !== undefined && before.size !== exact)) fail('payload file or size');
  const handle = await open(target, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.ino !== before.ino || info.dev !== before.dev || info.size !== before.size) fail('payload changed before read');
    const bytes = Buffer.alloc(info.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const part = await handle.read(bytes, count, bytes.length - count, count);
      count += part.bytesRead;
      if (!part.bytesRead) break;
    }
    if (count !== info.size || !await safeFileRealpath(target)) fail('payload changed during read');
    return bytes.subarray(0, count);
  } finally { await handle.close(); }
}

function validSummary(value: unknown): boolean {
  if (!keys(value, ['fileName', 'map', 'rounds', 'score', 'players']) || !text(value.fileName, LIBRARY_METADATA_LIMITS.fileName)
    || /[\\/:]/.test(value.fileName) || basename(value.fileName) !== value.fileName || value.fileName === '.' || value.fileName === '..'
    || !text(value.map, LIBRARY_METADATA_LIMITS.map) || !integer(value.rounds, 0, LIBRARY_METADATA_LIMITS.rounds)
    || !Array.isArray(value.players) || value.players.length > LIBRARY_METADATA_LIMITS.players) return false;
  if (value.score !== null && (!keys(value.score, ['initialCT', 'initialT'])
    || !integer(value.score.initialCT, 0, LIBRARY_METADATA_LIMITS.rounds) || !integer(value.score.initialT, 0, LIBRARY_METADATA_LIMITS.rounds))) return false;
  const players = value.players;
  return players.every(player => keys(player, ['id', 'nickname']) && text(player.id) && typeof player.nickname === 'string'
    && player.nickname.length <= LIBRARY_METADATA_LIMITS.nickname && !player.nickname.includes('\0')) && new Set(players.map(player => player.id)).size === players.length;
}
function validVersions(value: unknown): value is ArchiveVersions {
  return keys(value, ['application', 'archive', 'report', 'replay', 'analysis', 'parser', 'native', 'sampling', 'mapResource', 'sourceRevision'])
    && value.archive === 1 && value.report === 2 && value.replay === 1
    && ['application', 'analysis', 'parser', 'native', 'sampling', 'mapResource'].every(key => text(value[key], LIBRARY_METADATA_LIMITS.version))
    && typeof value.sourceRevision === 'string' && /^[a-f0-9]{40}$/.test(value.sourceRevision);
}
function validCapabilities(value: unknown): value is ArchiveCapabilities {
  return keys(value, [...capabilityNames]) && capabilityNames.every(name => {
    const item = value[name];
    return keys(item, ['status', 'reason']) && ['available', 'partial', 'unavailable'].includes(item.status as string)
      && (item.reason === null || text(item.reason, LIBRARY_METADATA_LIMITS.reason)) && (item.status === 'available' || item.reason !== null);
  });
}
function validFile(file: unknown): file is ArchiveFile {
  if (!keys(file, ['path', 'role', 'rawBytes', 'gzipBytes', 'sha256', 'gzipSha256'], ['round', 'block'])
    || !integer(file.rawBytes, 1, LIBRARY_ARCHIVE_LIMITS.componentBytes) || !integer(file.gzipBytes, 1, LIBRARY_ARCHIVE_LIMITS.componentBytes)
    || !sha(file.sha256) || !sha(file.gzipSha256)) return false;
  if (file.role === 'replay-chunk') return integer(file.round, 1, LIBRARY_ARCHIVE_LIMITS.rounds) && integer(file.block, 0, 4095)
    && file.path === `replay/r${file.round}-b${file.block}.json.gz` && file.rawBytes <= LIBRARY_ARCHIVE_LIMITS.chunkBytes;
  const paths: Record<string, string> = { report: 'report.json.gz', 'heatmap-match': 'heatmap/match.json.gz',
    'heatmap-replay': 'heatmap/replay.json.gz', 'heatmap-spatial': 'heatmap/spatial.json.gz' };
  return typeof file.role === 'string' && Object.hasOwn(paths, file.role) && file.path === paths[file.role]
    && !Object.hasOwn(file, 'round') && !Object.hasOwn(file, 'block')
    && (file.role !== 'report' || file.rawBytes <= LIBRARY_ARCHIVE_LIMITS.reportBytes);
}

/** The manifest is small, exact-keyed and independent from report/replay schema versions. */
export function validateArchiveManifest(value: unknown): value is ArchiveManifest {
  if (!keys(value, ['format', 'schemaVersion', 'matchId', 'createdAt', 'summary', 'versions', 'capabilities', 'files'])
    || value.format !== 'cs2-analyst-match' || value.schemaVersion !== 1 || !sha(value.matchId)
    || typeof value.createdAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.createdAt)
    || !Number.isFinite(Date.parse(value.createdAt)) || new Date(value.createdAt).toISOString() !== value.createdAt
    || !validSummary(value.summary) || !validVersions(value.versions)
    || !validCapabilities(value.capabilities) || !Array.isArray(value.files) || value.files.length < 4
    || value.files.length > LIBRARY_ARCHIVE_LIMITS.fileCount || !value.files.every(validFile)) return false;
  const files = value.files as ArchiveFile[];
  return new Set(files.map(file => file.path)).size === files.length
    && ['report', 'heatmap-match', 'heatmap-replay', 'heatmap-spatial'].every(role => files.filter(file => file.role === role).length === 1)
    && files.reduce((sum, file) => sum + file.rawBytes, 0) <= LIBRARY_ARCHIVE_LIMITS.totalRawBytes
    && files.reduce((sum, file) => sum + file.gzipBytes, 0) <= LIBRARY_ARCHIVE_LIMITS.totalGzipBytes
    && files.filter(file => file.role === 'replay-chunk').reduce((sum, file) => sum + file.rawBytes + restoredSessionBytes, 0) <= LIBRARY_ARCHIVE_LIMITS.replayBytes;
}

export const archiveManifestHash = (manifest: ArchiveManifest): string => hash(JSON.stringify(manifest));
export async function readArchiveManifest(directory: string): Promise<ArchiveManifest> {
  const bytes = await readBounded(directory, 'manifest.json', LIBRARY_ARCHIVE_LIMITS.manifestBytes);
  let value: unknown;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { return fail('manifest JSON'); }
  if (unsupportedVersion(value)) {
    const error = new Error('This match archive uses an unsupported schema version.') as Error & { code: string };
    error.code = 'ARCHIVE_UNSUPPORTED'; throw error;
  }
  if (!validateArchiveManifest(value) || !bytes.equals(Buffer.from(JSON.stringify(value)))) fail('manifest contract or canonical JSON');
  return value as ArchiveManifest;
}

/** Session handles are temporary. No stored component contains a sessionId property. */
function serializeStored(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value, (key, item) => {
    if (typeof item === 'number' && !Number.isFinite(item)) fail('non-finite source number');
    return key === 'sessionId' ? undefined : item;
  }), 'utf8');
}
function hasSession(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const pending: unknown[] = [value];
  while (pending.length) {
    const item = pending.pop();
    if (item !== null && typeof item === 'object') {
      if (Object.hasOwn(item, 'sessionId')) return true;
      for (const child of Object.values(item)) if (child !== null && typeof child === 'object') pending.push(child);
    }
  }
  return false;
}

function validateReport(value: unknown, manifest: ArchiveManifest): asserts value is DesktopMatchReport {
  if (!keys(value, ['schemaVersion', 'match', 'selectedPlayer', 'players', 'analytics', 'findings', 'timeline', 'analysis', 'deepReview'], ['replay', 'heatmap'])
    || value.schemaVersion !== 2 || !keys(value.match, ['id', 'fileName', 'map', 'rounds', 'score']) || value.match.id !== manifest.matchId
    || value.match.fileName !== manifest.summary.fileName || value.match.map !== manifest.summary.map
    || value.match.rounds !== manifest.summary.rounds || JSON.stringify(value.match.score) !== JSON.stringify(manifest.summary.score)
    || !Array.isArray(value.players) || JSON.stringify(value.players) !== JSON.stringify(manifest.summary.players)
    || typeof value.selectedPlayer !== 'string' || !value.players.some(player => plain(player) && player.id === value.selectedPlayer)
    || !Array.isArray(value.analytics) || !Array.isArray(value.findings) || !Array.isArray(value.timeline)
    || !plain(value.analysis) || !Array.isArray(value.analysis.players) || !Array.isArray(value.analysis.perPlayer)
    || !plain(value.deepReview) || typeof value.deepReview.available !== 'boolean' || !Array.isArray(value.deepReview.players)
    || hasSession(value)) fail('report contract or identity');
  const replay = value.replay;
  if (replay !== undefined && (!plain(replay) || replay.schemaVersion !== 1 || replay.matchId !== manifest.matchId
    || replay.map !== manifest.summary.map || typeof replay.available !== 'boolean' || !Array.isArray(replay.rounds)
    || !Array.isArray(replay.players) || replay.players.length > LIBRARY_ARCHIVE_LIMITS.players)) fail('replay metadata');
  const advertised = new Set<string>();
  if (plain(replay) && replay.available) {
    for (const round of replay.rounds as unknown[]) {
      if (!plain(round) || !integer(round.round, 1, LIBRARY_ARCHIVE_LIMITS.rounds) || !Array.isArray(round.blocks)) fail('replay round');
      for (const block of round.blocks as unknown[]) {
        if (!plain(block) || !integer(block.index, 0, 4095) || !integer(block.startTick) || !integer(block.endTick)
          || block.endTick < block.startTick) fail('replay block');
        const key = `${round.round}:${block.index}`;
        if (advertised.has(key)) fail('duplicate replay block');
        advertised.add(key);
      }
    }
  }
  const files = manifest.files.filter(file => file.role === 'replay-chunk');
  if (advertised.size !== files.length || files.some(file => !advertised.has(`${file.round}:${file.block}`))) fail('replay catalogue mismatch');
  const heatmap = value.heatmap;
  if (heatmap !== undefined && (!plain(heatmap) || heatmap.schemaVersion !== 1 || heatmap.matchId !== manifest.matchId
    || typeof heatmap.available !== 'boolean' || !plain(heatmap.layers))) fail('heatmap metadata');
  if ((manifest.capabilities.replay.status !== 'unavailable') !== (plain(replay) && replay.available === true)
    || (manifest.capabilities.heatmap.status !== 'unavailable') !== (plain(heatmap) && heatmap.available === true)
    || (manifest.capabilities.deepReview.status !== 'unavailable') !== (value.deepReview.available === true)
    || manifest.capabilities.report.status !== 'available' || manifest.capabilities.analysis.status !== 'available'
    || manifest.capabilities.timeline.status !== 'available') fail('capability declaration mismatch');
}
function validateChunk(value: unknown, manifest: ArchiveManifest, file: ArchiveFile): asserts value is DesktopReplayChunk {
  if (!plain(value) || value.schemaVersion !== 1 || value.matchId !== manifest.matchId || value.round !== file.round || value.block !== file.block
    || !integer(value.startTick) || !integer(value.endTick) || value.endTick < value.startTick
    || !Array.isArray(value.frames) || !Array.isArray(value.events) || hasSession(value)) fail('replay chunk identity or contract');
  for (const frame of value.frames) if (!plain(frame) || !integer(frame.tick) || !Array.isArray(frame.players)
    || frame.players.length > LIBRARY_ARCHIVE_LIMITS.players || !plain(frame.bomb)
    || frame.players.some(player => !Array.isArray(player) || player.length !== 11 || !integer(player[0], 0, LIBRARY_ARCHIVE_LIMITS.players - 1))) fail('replay frame');
  for (const field of ['utilities', 'blinds', 'burns']) if (value[field] !== undefined && !Array.isArray(value[field])) fail('replay effects');
  if (value.follow !== undefined && (!plain(value.follow) || !Array.isArray(value.follow.deaths)
    || !Array.isArray(value.follow.states) || !Array.isArray(value.follow.backgrounds))) fail('replay follow');
  // JSON serialization grows when the new temporary UUID is added. Check the actual recovered shape.
  if (Buffer.byteLength(JSON.stringify({ ...value, sessionId: '00000000-0000-0000-0000-000000000000' })) > LIBRARY_ARCHIVE_LIMITS.chunkBytes) fail('recovered replay chunk budget');
}
function validateSource(value: unknown, manifest: ArchiveManifest, role: ArchiveFileRole): void {
  if (role === 'heatmap-match') {
    if (!keys(value, ['id', 'map', 'players', 'rounds'], ['tickRate']) || value.id !== manifest.matchId || value.map !== manifest.summary.map
      || !Array.isArray(value.players) || value.players.length > LIBRARY_ARCHIVE_LIMITS.players
      || !Array.isArray(value.rounds) || value.rounds.length !== manifest.summary.rounds
      || value.rounds.some(round => !plain(round) || !integer(round.number, 1, LIBRARY_ARCHIVE_LIMITS.rounds) || !Array.isArray(round.events))) fail('heatmap Match source');
  } else if (role === 'heatmap-replay') {
    if (value !== null && (!plain(value) || value.schemaVersion !== 1 || value.matchId !== manifest.matchId
      || value.samplingVersion !== manifest.versions.sampling
      || !Array.isArray(value.players) || value.players.length > LIBRARY_ARCHIVE_LIMITS.players
      || !Array.isArray(value.rounds) || value.rounds.length > LIBRARY_ARCHIVE_LIMITS.rounds
      || value.rounds.some(round => !plain(round) || !integer(round.round, 1, LIBRARY_ARCHIVE_LIMITS.rounds)
        || !Array.isArray(round.frames) || !Array.isArray(round.events) || !Array.isArray(round.lifecycle)))) fail('heatmap Replay source');
  } else if (role === 'heatmap-spatial') {
    if (value !== null && (!plain(value) || value.matchId !== manifest.matchId || !Array.isArray(value.events))) fail('heatmap Spatial source');
  }
  if (hasSession(value)) fail('persisted temporary session');
}

function validateAvailability(report: DesktopMatchReport, replay: boolean, spatial: boolean): void {
  if (report.replay?.available && !replay) fail('Replay capability lacks canonical source');
  if (report.heatmap?.layers.positions.available && !replay) fail('Heatmap positions lack canonical source');
  if ((report.heatmap?.layers.kills.available || report.heatmap?.layers.deaths.available) && !spatial) fail('Heatmap events lack canonical source');
}

async function decodeFile(directory: string, file: ArchiveFile, options?: ArchiveOptions): Promise<unknown> {
  aborted(options);
  const compressed = await readBounded(directory, file.path, LIBRARY_ARCHIVE_LIMITS.componentBytes, file.gzipBytes);
  if (hash(compressed) !== file.gzipSha256) fail('compressed digest mismatch');
  const raw = await gunzip(compressed, { maxOutputLength: file.rawBytes });
  aborted(options);
  if (raw.length !== file.rawBytes || hash(raw) !== file.sha256) fail('payload digest or size mismatch');
  try { return JSON.parse(raw.toString('utf8')); } catch { return fail('payload JSON'); }
}

async function verifyCompressedFile(directory: string, file: ArchiveFile, options?: ArchiveOptions): Promise<void> {
  aborted(options);
  const target = join(directory, ...file.path.split('/'));
  await assertArchiveDirectory(directory, dirname(target));
  const before = await lstat(target);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink > 1 || before.size !== file.gzipBytes
    || !await safeFileRealpath(target)) fail('compressed file or size');
  const handle = await open(target, 'r');
  try {
    const info = await handle.stat();
    if (info.ino !== before.ino || info.dev !== before.dev || info.size !== before.size) fail('compressed file changed');
    const buffer = Buffer.alloc(64 * 1024), digest = createHash('sha256');
    let position = 0;
    while (true) {
      aborted(options);
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, file.gzipBytes - position + 1), position);
      if (!bytesRead) break;
      position += bytesRead;
      if (position > file.gzipBytes) fail('compressed file grew');
      digest.update(buffer.subarray(0, bytesRead));
    }
    if (position !== file.gzipBytes || digest.digest('hex') !== file.gzipSha256 || !await safeFileRealpath(target)) fail('compressed digest mismatch');
  } finally { await handle.close(); }
}
function requiredFile(manifest: ArchiveManifest, role: ArchiveFileRole): ArchiveFile {
  const file = manifest.files.find(file => file.role === role);
  if (!file) return fail('missing required component');
  return file;
}

async function validateInventory(directory: string, manifest: ArchiveManifest): Promise<void> {
  await assertArchiveDirectory(directory, directory);
  const expected = new Set(['manifest.json', ...manifest.files.map(file => file.path)]);
  const directories = new Set(['heatmap', ...(manifest.files.some(file => file.role === 'replay-chunk') ? ['replay'] : [])]);
  let count = 0;
  for (const rootEntry of await readdir(directory, { withFileTypes: true })) {
    if (rootEntry.isSymbolicLink()) fail('archive symlink');
    if (rootEntry.isDirectory()) {
      if (!directories.delete(rootEntry.name)) fail('unexpected archive directory');
      await assertArchiveDirectory(directory, join(directory, rootEntry.name));
      for (const entry of await readdir(join(directory, rootEntry.name), { withFileTypes: true })) {
        if (!entry.isFile() || entry.isSymbolicLink() || !expected.delete(`${rootEntry.name}/${entry.name}`)) fail('unexpected archive member');
        if (++count > LIBRARY_ARCHIVE_LIMITS.fileCount) fail('archive file count');
      }
    } else {
      if (!rootEntry.isFile() || !expected.delete(rootEntry.name)) fail('unexpected archive member');
      if (++count > LIBRARY_ARCHIVE_LIMITS.fileCount + 1) fail('archive file count');
    }
  }
  if (expected.size || directories.size) fail('missing archive member');
}

/** Full validation belongs in the Utility Process; the Main catalogue only reads the small manifest. */
export async function verifyLibraryArchive(directory: string, options?: ArchiveOptions): Promise<ArchiveWriteResult> {
  aborted(options);
  const manifest = await readArchiveManifest(directory);
  await validateInventory(directory, manifest);
  let report: DesktopMatchReport | null = null;
  const sources = new Set<ArchiveFileRole>();
  for (const file of manifest.files) {
    if (options?.mode === 'compressed') { await verifyCompressedFile(directory, file, options); continue; }
    const value = await decodeFile(directory, file, options);
    if (file.role === 'report') { validateReport(value, manifest); report = value; }
    else if (file.role === 'replay-chunk') validateChunk(value, manifest, file);
    else { validateSource(value, manifest, file.role); if (value !== null) sources.add(file.role); }
  }
  if (report) validateAvailability(report, sources.has('heatmap-replay'), sources.has('heatmap-spatial'));
  return { manifest, manifestHash: archiveManifestHash(manifest),
    storedBytes: Buffer.byteLength(JSON.stringify(manifest)) + manifest.files.reduce((sum, file) => sum + file.gzipBytes, 0) };
}

async function writeExclusive(directory: string, path: string, bytes: Buffer, options?: ArchiveOptions): Promise<void> {
  aborted(options);
  const target = join(directory, ...path.split('/'));
  await assertArchiveDirectory(directory, dirname(target));
  const handle = await open(target, 'wx');
  try { await handle.writeFile(bytes, options?.signal ? { signal: options.signal } : undefined); await handle.sync(); }
  finally { await handle.close(); }
  aborted(options);
}

export async function writeLibraryArchive(directory: string, input: ArchiveWriteInput, options?: ArchiveOptions): Promise<ArchiveWriteResult> {
  aborted(options);
  await assertArchiveDirectory(directory, directory);
  if ((await readdir(directory)).length) fail('staging directory must be empty');
  if (!sha(input.match.id) || input.report.match.id !== input.match.id || input.report.match.map !== input.match.map
    || input.report.match.rounds !== input.match.rounds.length || !validVersions(input.versions)) fail('writer identity or versions');
  await mkdir(join(directory, 'heatmap'));
  if (input.chunks.size) await mkdir(join(directory, 'replay'));
  const available = (): LibraryCapability => ({ status: 'available', reason: null });
  const missing = (reason: string): LibraryCapability => ({ status: 'unavailable', reason });
  const report = input.report;
  validateAvailability(report, input.replay !== null, input.spatial !== null);
  const heatmapAvailable = report.heatmap?.available === true;
  const heatmapLayers = report.heatmap?.layers;
  const manifest: ArchiveManifest = { format: 'cs2-analyst-match', schemaVersion: 1, matchId: input.match.id,
    createdAt: new Date().toISOString(), summary: { ...report.match, players: report.players } as ArchiveManifest['summary'],
    versions: { ...input.versions }, capabilities: { report: available(), timeline: available(), analysis: available(),
      deepReview: report.deepReview.available ? available() : missing('deep-review-unavailable'),
      replay: report.replay?.available ? available() : missing(report.replay?.unavailableReason ?? 'replay-unavailable'),
      heatmap: !heatmapAvailable ? missing(report.heatmap?.unavailableReason ?? 'heatmap-unavailable')
        : heatmapLayers && Object.values(heatmapLayers).every(layer => layer.available) ? available()
        : { status: 'partial', reason: 'some-heatmap-layers-unavailable' } }, files: [] };
  // The permanent summary has no internal identity alias or original input path.
  manifest.summary = { fileName: report.match.fileName, map: report.match.map, rounds: report.match.rounds,
    score: report.match.score, players: report.players };
  if (!validSummary(manifest.summary)) fail('writer summary');
  const add = async (path: string, role: ArchiveFileRole, value: unknown, coordinates?: { round: number; block: number }) => {
    aborted(options);
    const raw = serializeStored(value);
    const maximum = role === 'replay-chunk' ? LIBRARY_ARCHIVE_LIMITS.chunkBytes
      : role === 'report' ? LIBRARY_ARCHIVE_LIMITS.reportBytes : LIBRARY_ARCHIVE_LIMITS.componentBytes;
    if (!raw.length || raw.length > maximum) fail('writer component budget');
    const encoded = await gzip(raw, { level: 6 });
    aborted(options);
    const file: ArchiveFile = { path, role, rawBytes: raw.length, gzipBytes: encoded.length, sha256: hash(raw), gzipSha256: hash(encoded), ...coordinates };
    manifest.files.push(file);
    if (manifest.files.length > LIBRARY_ARCHIVE_LIMITS.fileCount
      || manifest.files.reduce((sum, file) => sum + file.rawBytes, 0) > LIBRARY_ARCHIVE_LIMITS.totalRawBytes
      || manifest.files.reduce((sum, file) => sum + file.gzipBytes, 0) > LIBRARY_ARCHIVE_LIMITS.totalGzipBytes) fail('writer archive budget');
    const stored = JSON.parse(raw.toString('utf8'));
    if (role === 'replay-chunk') validateChunk(stored, manifest, file);
    else if (role !== 'report') validateSource(stored, manifest, role);
    await writeExclusive(directory, path, encoded, options);
  };
  await add('report.json.gz', 'report', report);
  await add('heatmap/match.json.gz', 'heatmap-match', input.match);
  await add('heatmap/replay.json.gz', 'heatmap-replay', input.replay);
  await add('heatmap/spatial.json.gz', 'heatmap-spatial', input.spatial);
  for (const [key, json] of input.chunks) {
    if (!/^[1-9]\d*:(?:0|[1-9]\d*)$/.test(key)) fail('writer replay key');
    const [round, block] = key.split(':').map(Number);
    await add(`replay/r${round}-b${block}.json.gz`, 'replay-chunk', JSON.parse(json), { round, block });
  }
  if (!validateArchiveManifest(manifest)) fail('writer manifest');
  validateReport(JSON.parse(serializeStored(report).toString('utf8')), manifest);
  const bytes = Buffer.from(JSON.stringify(manifest));
  if (bytes.length > LIBRARY_ARCHIVE_LIMITS.manifestBytes) fail('writer manifest budget');
  await writeExclusive(directory, 'manifest.json', bytes, options);
  return { manifest, manifestHash: hash(bytes), storedBytes: bytes.length + manifest.files.reduce((sum, file) => sum + file.gzipBytes, 0) };
}

export async function readArchiveReport(directory: string, manifest: ArchiveManifest, sessionId: string): Promise<DesktopMatchReport> {
  if (!validateArchiveManifest(manifest) || !uuid(sessionId)) fail('read report request');
  const value = await decodeFile(directory, requiredFile(manifest, 'report'));
  validateReport(value, manifest);
  const report = value as DesktopMatchReport;
  if (report.replay) report.replay.sessionId = report.replay.available ? sessionId : null;
  if (report.heatmap) report.heatmap.sessionId = sessionId;
  return upgradeReportPerformance(report);
}
export async function readArchiveChunk(directory: string, manifest: ArchiveManifest, request: DesktopReplayRequest): Promise<DesktopReplayChunk> {
  if (!validateArchiveManifest(manifest) || !uuid(request.sessionId) || !integer(request.round, 1, LIBRARY_ARCHIVE_LIMITS.rounds)
    || !integer(request.block, 0, 4095)) fail('read chunk request');
  const file = manifest.files.find(file => file.role === 'replay-chunk' && file.round === request.round && file.block === request.block);
  if (!file) return fail('unknown replay chunk');
  const value = await decodeFile(directory, file);
  validateChunk(value, manifest, file);
  return { ...value, sessionId: request.sessionId };
}
export async function readArchiveSources(directory: string, manifest: ArchiveManifest): Promise<{ match: Match; replay: MatchReplay | null; spatial: MatchSpatialEvidence | null }> {
  if (!validateArchiveManifest(manifest)) fail('read source manifest');
  const values: unknown[] = [];
  for (const role of ['heatmap-match', 'heatmap-replay', 'heatmap-spatial'] as const) {
    const value = await decodeFile(directory, requiredFile(manifest, role));
    validateSource(value, manifest, role);
    values.push(value);
  }
  return { match: values[0] as Match, replay: values[1] as MatchReplay | null, spatial: values[2] as MatchSpatialEvidence | null };
}
