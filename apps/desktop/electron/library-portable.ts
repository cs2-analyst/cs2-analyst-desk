import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { assertArchiveDirectory, LIBRARY_ARCHIVE_LIMITS, validateArchiveManifest, verifyLibraryArchive, type ArchiveManifest } from './library-archive.ts';

/**
 * Frozen `.cs2a` byte layout (docs/match-library-portable-format.md):
 * magic | uint32BE headerLength | canonical header JSON | concatenated payloads.
 * Nothing here buffers a whole package: header bytes are bounded to 1 MiB and every
 * payload is streamed in 64 KiB slices while its SHA-256 is verified.
 */
const MiB = 1024 * 1024;
const MAGIC = Buffer.from([0x43, 0x53, 0x32, 0x41, 0x0d, 0x0a, 0x1a, 0x0a]);
const PREFIX_BYTES = 12;
const SLICE_BYTES = 64 * 1024;
const FIXED_PATHS = ['manifest.json', 'report.json.gz', 'heatmap/match.json.gz', 'heatmap/replay.json.gz', 'heatmap/spatial.json.gz'] as const;
const REPLAY_PATH = /^replay\/r([1-9]\d{0,3})-b(0|[1-9]\d{0,3})\.json\.gz$/;
const ISO_MILLIS = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

export const PORTABLE_MAGIC = MAGIC;
export const PORTABLE_LIMITS = Object.freeze({ headerBytes: MiB, fileCount: 4097, payloadBytes: 256 * MiB, fileBytes: 256 * MiB });

export interface PortableFile { path: string; bytes: number; sha256: string }
export interface PortableHeader {
  format: 'cs2-analyst-portable';
  schemaVersion: 1;
  archiveSchemaVersion: 1;
  matchId: string;
  createdAt: string;
  files: PortableFile[];
}
export interface PortableReceipt { header: PortableHeader; manifest: ArchiveManifest; bytes: number; payloadBytes: number; files: number }
export interface PortableOptions { signal?: AbortSignal }

type JsonObject = Record<string, unknown>;
const plain = (value: unknown): value is JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const exact = (value: unknown, names: readonly string[]): value is JsonObject => plain(value)
  && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
const integer = (value: unknown, min: number, max: number): value is number => typeof value === 'number'
  && Number.isSafeInteger(value) && value >= min && value <= max;
const sha256 = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const inside = (root: string, candidate: string) => {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
};
function portableFail(reason: string): never { throw new Error(`Invalid portable archive: ${reason}`); }
function unsupportedVersion(): never {
  const error = new Error('Unsupported portable archive schema version.') as Error & { code: string };
  error.code = 'ARCHIVE_UNSUPPORTED';
  throw error;
}
function localPath(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || !isAbsolute(value) || value.includes('\0')) throw new Error(`${label} must be an absolute local path.`);
  const path = resolve(value);
  if (path.startsWith('\\\\')) throw new Error(`${label} must be a local path.`);
  return path;
}

function replayCoordinates(path: string): { round: number; block: number } | null {
  const match = REPLAY_PATH.exec(path);
  if (!match) return null;
  const round = Number(match[1]), block = Number(match[2]);
  if (round < 1 || round > LIBRARY_ARCHIVE_LIMITS.rounds || block > 4095) return null;
  return { round, block };
}
/** The whitelist itself rejects traversal, absolute paths, drive letters, UNC and empty segments. */
export function isPortablePath(path: unknown): path is string {
  return typeof path === 'string' && (FIXED_PATHS.includes(path as typeof FIXED_PATHS[number]) || replayCoordinates(path) !== null);
}
function validPortableFile(value: unknown): value is PortableFile {
  return exact(value, ['path', 'bytes', 'sha256']) && isPortablePath(value.path)
    && integer(value.bytes, 1, PORTABLE_LIMITS.fileBytes) && sha256(value.sha256)
    // manifest.json is later read whole by the L1 strict manifest validator.
    && (value.path !== 'manifest.json' || value.bytes <= LIBRARY_ARCHIVE_LIMITS.manifestBytes);
}
export function validatePortableHeader(value: unknown): value is PortableHeader {
  if (!exact(value, ['format', 'schemaVersion', 'archiveSchemaVersion', 'matchId', 'createdAt', 'files'])
    || value.format !== 'cs2-analyst-portable' || value.schemaVersion !== 1 || value.archiveSchemaVersion !== 1
    || !sha256(value.matchId) || typeof value.createdAt !== 'string' || !ISO_MILLIS.test(value.createdAt)
    || !Number.isFinite(Date.parse(value.createdAt)) || new Date(value.createdAt).toISOString() !== value.createdAt
    || !Array.isArray(value.files) || value.files.length < FIXED_PATHS.length || value.files.length > PORTABLE_LIMITS.fileCount) return false;
  const seen = new Set<string>();
  let total = 0;
  for (const file of value.files) {
    if (!validPortableFile(file) || seen.has(file.path)) return false;
    seen.add(file.path);
    total += file.bytes;
    if (total > PORTABLE_LIMITS.payloadBytes) return false;
  }
  return FIXED_PATHS.every(path => seen.has(path));
}
export const portableHeaderBytes = (header: PortableHeader): Buffer => Buffer.from(JSON.stringify(header), 'utf8');

function parseHeader(bytes: Buffer): PortableHeader {
  let value: unknown;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { portableFail('header JSON'); }
  if (!plain(value)) portableFail('header JSON');
  if (value.format === 'cs2-analyst-portable') {
    if (integer(value.schemaVersion, 0, Number.MAX_SAFE_INTEGER) && value.schemaVersion !== 1) unsupportedVersion();
    if (integer(value.archiveSchemaVersion, 0, Number.MAX_SAFE_INTEGER) && value.archiveSchemaVersion !== 1) unsupportedVersion();
  }
  if (!validatePortableHeader(value)) portableFail('header contract');
  if (!Buffer.from(JSON.stringify(value), 'utf8').equals(bytes)) portableFail('canonical header JSON');
  return value;
}

/**
 * The inner manifest keeps L1's strict validation; the portable header is only a
 * transport envelope and never replaces the inner summary/digests.
 */
function validateInnerManifest(bytes: Buffer, header: PortableHeader): ArchiveManifest {
  let value: unknown;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { portableFail('inner manifest JSON'); }
  if (!plain(value)) portableFail('inner manifest JSON');
  if (value.format === 'cs2-analyst-match') {
    if (integer(value.schemaVersion, 0, Number.MAX_SAFE_INTEGER) && value.schemaVersion !== 1) unsupportedVersion();
    const versions = plain(value.versions) ? value.versions : null;
    if (versions && Object.entries({ archive: 1, report: 2, replay: 1 })
      .some(([key, supported]) => integer(versions[key], 0, Number.MAX_SAFE_INTEGER) && versions[key] !== supported)) unsupportedVersion();
  }
  if (!validateArchiveManifest(value) || !Buffer.from(JSON.stringify(value), 'utf8').equals(bytes)) portableFail('inner manifest contract');
  if (value.matchId !== header.matchId) portableFail('inner manifest identity');
  if (value.schemaVersion !== header.archiveSchemaVersion) portableFail('inner manifest schema');
  const remaining = new Map(value.files.map(file => [file.path, file]));
  for (const entry of header.files) {
    if (entry.path === 'manifest.json') continue;
    const file = remaining.get(entry.path);
    if (!file || file.gzipBytes !== entry.bytes || file.gzipSha256 !== entry.sha256) portableFail('inner manifest inventory mismatch');
    remaining.delete(entry.path);
  }
  if (remaining.size) portableFail('inner manifest inventory mismatch');
  return value;
}

async function readExactly(handle: FileHandle, buffer: Buffer, position: number, length: number): Promise<void> {
  let read = 0;
  while (read < length) {
    const { bytesRead } = await handle.read(buffer, read, length - read, position + read);
    if (!bytesRead) portableFail('truncated payload');
    read += bytesRead;
  }
}
async function writeAll(handle: FileHandle, bytes: Buffer): Promise<void> {
  let written = 0;
  while (written < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, written, bytes.length - written);
    if (!bytesWritten) throw new Error('Portable archive write made no progress.');
    written += bytesWritten;
  }
}
interface OpenedHeader { header: PortableHeader; base: number; payloadBytes: number }
async function readHeader(handle: FileHandle, size: number): Promise<OpenedHeader> {
  if (size < PREFIX_BYTES) portableFail('truncated header');
  const prefix = Buffer.alloc(PREFIX_BYTES);
  await readExactly(handle, prefix, 0, PREFIX_BYTES);
  if (!prefix.subarray(0, MAGIC.length).equals(MAGIC)) portableFail('magic');
  const headerLength = prefix.readUInt32BE(MAGIC.length);
  if (headerLength > PORTABLE_LIMITS.headerBytes) portableFail('header too large');
  if (headerLength < 2) portableFail('header length');
  const base = PREFIX_BYTES + headerLength;
  if (size < base) portableFail('truncated header');
  const bytes = Buffer.alloc(headerLength);
  await readExactly(handle, bytes, PREFIX_BYTES, headerLength);
  const header = parseHeader(bytes);
  const payloadBytes = header.files.reduce((sum, file) => sum + file.bytes, 0);
  if (size < base + payloadBytes) portableFail('truncated payload');
  if (size > base + payloadBytes) portableFail('trailing bytes');
  return { header, base, payloadBytes };
}

interface PayloadSink { write(file: PortableFile, chunk: Buffer): Promise<void>; close(): Promise<void> }
async function walkPayloads(handle: FileHandle, opened: OpenedHeader, sink: PayloadSink | null, signal?: AbortSignal): Promise<void> {
  let position = opened.base;
  for (const file of opened.header.files) {
    const hash = createHash('sha256'), buffer = Buffer.alloc(SLICE_BYTES);
    let read = 0;
    while (read < file.bytes) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, file.bytes - read), position + read);
      if (!bytesRead) portableFail('truncated payload');
      read += bytesRead;
      hash.update(buffer.subarray(0, bytesRead));
      if (sink) await sink.write(file, buffer.subarray(0, bytesRead));
    }
    if (hash.digest('hex') !== file.sha256) portableFail('payload digest mismatch');
    position += file.bytes;
  }
}

async function readPortablePackage(packagePath: string, prepare: ((header: PortableHeader) => Promise<PayloadSink>) | null, options?: PortableOptions): Promise<PortableReceipt> {
  const path = localPath(packagePath, 'Portable archive');
  const handle = await open(path, 'r');
  let sink: PayloadSink | null = null;
  try {
    const before = await handle.stat();
    if (!before.isFile()) portableFail('package file');
    const opened = await readHeader(handle, before.size);
    sink = prepare ? await prepare(opened.header) : null;
    let manifestChunks: Buffer[] | null = null;
    const collector: PayloadSink = sink ?? { write: async (file, chunk) => {
      if (file.path === 'manifest.json') (manifestChunks ??= []).push(Buffer.from(chunk));
    }, close: async () => undefined };
    await walkPayloads(handle, opened, collector, options?.signal);
    await collector.close();
    const after = await handle.stat();
    if (after.size !== before.size) portableFail('package changed during read');
    const manifestBytes = sink && sink instanceof StagingSink ? await sink.manifestBytes() : Buffer.concat(manifestChunks ?? []);
    const manifest = validateInnerManifest(manifestBytes, opened.header);
    return { header: opened.header, manifest, bytes: before.size, payloadBytes: opened.payloadBytes, files: opened.header.files.length };
  } finally {
    try { await sink?.close(); } catch { /* Preserve the primary failure. */ }
    await handle.close();
  }
}

class StagingSink implements PayloadSink {
  readonly directory: string;
  private readonly handles = new Map<string, FileHandle>();
  private manifestPath: string | null = null;
  constructor(directory: string) { this.directory = directory; }
  async write(file: PortableFile, chunk: Buffer): Promise<void> {
    let handle = this.handles.get(file.path);
    if (!handle) {
      const target = join(this.directory, ...file.path.split('/'));
      if (!inside(this.directory, target)) portableFail('payload path');
      handle = await open(target, 'wx', 0o600);
      this.handles.set(file.path, handle);
      if (file.path === 'manifest.json') this.manifestPath = target;
    }
    await writeAll(handle, chunk);
  }
  async close(): Promise<void> {
    let failure: unknown = null;
    for (const handle of this.handles.values()) {
      try { await handle.sync(); } catch (error) { failure ??= error; }
      try { await handle.close(); } catch (error) { failure ??= error; }
    }
    this.handles.clear();
    if (failure) throw failure;
  }
  async manifestBytes(): Promise<Buffer> {
    if (!this.manifestPath) portableFail('missing inner manifest');
    return await readFile(this.manifestPath);
  }
}

async function inspectSourceFile(target: string, maximum: number, signal?: AbortSignal): Promise<{ bytes: number; sha256: string }> {
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > maximum) portableFail('source file');
  const handle = await open(target, 'r');
  try {
    const before = await handle.stat();
    if (before.size !== info.size) portableFail('source changed');
    const buffer = Buffer.alloc(SLICE_BYTES), hash = createHash('sha256');
    let read = 0;
    while (read < before.size) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, before.size - read), read);
      if (!bytesRead) break;
      read += bytesRead;
      hash.update(buffer.subarray(0, bytesRead));
    }
    if (read !== before.size) portableFail('source changed');
    return { bytes: read, sha256: hash.digest('hex') };
  } finally { await handle.close(); }
}
async function copySourceFile(target: string, expected: PortableFile, destination: FileHandle, signal?: AbortSignal): Promise<void> {
  const handle = await open(target, 'r');
  try {
    const info = await handle.stat();
    if (info.size !== expected.bytes) portableFail('source changed during export');
    const buffer = Buffer.alloc(SLICE_BYTES), hash = createHash('sha256');
    let read = 0;
    while (read < expected.bytes) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, expected.bytes - read), read);
      if (!bytesRead) portableFail('source truncated during export');
      read += bytesRead;
      hash.update(buffer.subarray(0, bytesRead));
      await writeAll(destination, buffer.subarray(0, bytesRead));
    }
    if (hash.digest('hex') !== expected.sha256) portableFail('source changed during export');
  } finally { await handle.close(); }
}

/** Verify without writing; the caller still runs L1 verifyLibraryArchive on its staging copy. */
export function verifyPortableArchive(packagePath: string, options?: PortableOptions): Promise<PortableReceipt> {
  return readPortablePackage(packagePath, null, options);
}

/**
 * Stream a validated package into an empty, owned staging directory. Every payload is
 * written with `wx` and hashed in the same pass. On failure the caller owns removal of
 * the staging directory; existing matches are never touched here.
 */
export async function extractPortableArchive(packagePath: string, stagingDirectory: string, options?: PortableOptions): Promise<PortableReceipt> {
  const staging = localPath(stagingDirectory, 'Staging directory');
  await assertArchiveDirectory(staging, staging);
  if ((await readdir(staging)).length) portableFail('staging directory must be empty');
  return await readPortablePackage(packagePath, async header => {
    await mkdir(join(staging, 'heatmap'));
    if (header.files.some(file => file.path.startsWith('replay/'))) await mkdir(join(staging, 'replay'));
    return new StagingSink(staging);
  }, options);
}

/**
 * Full export path. The L1 archive is verified (including every decompressed component)
 * before a single package byte is written, then each source file is re-hashed while it is
 * streamed into the exclusive destination. The caller owns the destination lifecycle
 * (temporary name + atomic rename) and removes it on failure.
 */
export async function writePortableArchive(sourceDirectory: string, destination: string, options?: PortableOptions): Promise<PortableReceipt> {
  const source = localPath(sourceDirectory, 'Archive directory');
  const target = localPath(destination, 'Export destination');
  if (inside(source, target)) throw new Error('Export destination must be outside the match archive.');
  options?.signal?.throwIfAborted();
  const verified = await verifyLibraryArchive(source, { signal: options?.signal });
  const manifest = verified.manifest;
  const role = (name: string) => {
    const matches = manifest.files.filter(file => file.role === name);
    if (matches.length !== 1) portableFail('source archive inventory');
    return matches[0];
  };
  const components = [role('report'), role('heatmap-match'), role('heatmap-replay'), role('heatmap-spatial'),
    ...manifest.files.filter(file => file.role === 'replay-chunk')
      .sort((left, right) => (left.round! - right.round!) || (left.block! - right.block!))];
  if (components.length !== manifest.files.length) portableFail('source archive inventory');
  const candidates: { path: string; target: string; maximum: number; expect?: { bytes: number; sha256: string } }[] = [
    { path: 'manifest.json', target: join(source, 'manifest.json'), maximum: LIBRARY_ARCHIVE_LIMITS.manifestBytes,
      expect: { bytes: Buffer.byteLength(JSON.stringify(manifest)), sha256: digest(JSON.stringify(manifest)) } },
    ...components.map(file => ({ path: file.path, target: join(source, ...file.path.split('/')),
      maximum: LIBRARY_ARCHIVE_LIMITS.componentBytes, expect: { bytes: file.gzipBytes, sha256: file.gzipSha256 } })),
  ];
  if (candidates.length > PORTABLE_LIMITS.fileCount) portableFail('file count');
  const files: PortableFile[] = [];
  let payloadBytes = 0;
  for (const candidate of candidates) {
    options?.signal?.throwIfAborted();
    const inspected = await inspectSourceFile(candidate.target, candidate.maximum, options?.signal);
    if (candidate.expect && (inspected.bytes !== candidate.expect.bytes || inspected.sha256 !== candidate.expect.sha256)) {
      portableFail('source archive changed during export');
    }
    payloadBytes += inspected.bytes;
    if (payloadBytes > PORTABLE_LIMITS.payloadBytes) portableFail('payload too large');
    files.push({ path: candidate.path, bytes: inspected.bytes, sha256: inspected.sha256 });
  }
  const header: PortableHeader = { format: 'cs2-analyst-portable', schemaVersion: 1,
    archiveSchemaVersion: manifest.schemaVersion, matchId: manifest.matchId, createdAt: new Date().toISOString(), files };
  if (!validatePortableHeader(header)) portableFail('writer header');
  const headerBytes = portableHeaderBytes(header);
  if (headerBytes.length > PORTABLE_LIMITS.headerBytes) portableFail('header too large');
  const lengthBytes = Buffer.alloc(4);
  lengthBytes.writeUInt32BE(headerBytes.length, 0);
  let handle: FileHandle | undefined, created = false;
  try {
    handle = await open(target, 'wx', 0o600);
    created = true;
    await writeAll(handle, MAGIC);
    await writeAll(handle, lengthBytes);
    await writeAll(handle, headerBytes);
    for (const candidate of candidates) {
      await copySourceFile(candidate.target, files.find(file => file.path === candidate.path)!, handle, options?.signal);
    }
    await handle.sync();
    const info = await handle.stat();
    if (info.size !== PREFIX_BYTES + headerBytes.length + payloadBytes) portableFail('written package size');
    return { header, manifest, bytes: info.size, payloadBytes, files: files.length };
  } catch (error) {
    try { await handle?.close(); } catch { /* Preserve the primary failure. */ }
    handle = undefined;
    if (created) { try { await unlink(target); } catch { /* Caller also removes its temporary path. */ } }
    throw error;
  } finally { try { await handle?.close(); } catch { /* Already closed after a failure. */ } }
}
