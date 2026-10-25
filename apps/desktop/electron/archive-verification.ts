import { randomUUID } from 'node:crypto';
import type { EventEmitter } from 'node:events';
import { isAbsolute, resolve } from 'node:path';
import { archiveCompressedBytes, archiveManifestHash, LIBRARY_ARCHIVE_LIMITS, readArchiveManifest,
  type ArchiveManifest, type ArchiveWriteResult } from './library-archive.ts';

export const ARCHIVE_VERIFICATION_TIMEOUT_MS = 120_000;
export const ARCHIVE_VERIFICATION_SERVICE_NAME = 'CS2 Archive Verification';
export interface ArchiveVerificationRequest {
  kind: 'verify-archive'; jobId: string; directory: string; manifestHash: string;
}
export interface ArchiveVerificationReceipt {
  kind: 'archive-verified'; jobId: string; manifestHash: string; storedBytes: number;
}
interface VerificationWorker extends Pick<EventEmitter, 'on' | 'once' | 'removeListener'> {
  readonly pid?: number; postMessage(message: ArchiveVerificationRequest): void; kill(): unknown;
}
interface Options {
  timeoutMs?: number;
  readManifest?: typeof readArchiveManifest;
}
const uuid = (value: unknown): value is string => typeof value === 'string'
  && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function isArchiveVerificationRequest(value: unknown): value is ArchiveVerificationRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return Object.keys(v).sort().join() === 'directory,jobId,kind,manifestHash' && v.kind === 'verify-archive'
    && uuid(v.jobId) && sha(v.manifestHash) && typeof v.directory === 'string' && v.directory.length <= 32768
    && !v.directory.includes('\0') && isAbsolute(v.directory) && !resolve(v.directory).startsWith('\\\\');
}
function receipt(value: unknown, jobId: string, manifestHash: string, storedBytes: number): value is ArchiveVerificationReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return Object.keys(v).sort().join() === 'jobId,kind,manifestHash,storedBytes' && v.kind === 'archive-verified'
    && v.jobId === jobId && v.manifestHash === manifestHash && v.storedBytes === storedBytes;
}
function bytes(manifest: ArchiveManifest): number {
  return Buffer.byteLength(JSON.stringify(manifest)) + manifest.files.reduce((sum, file) => sum + archiveCompressedBytes(file), 0);
}
const failure = (message: string, code?: string) => Object.assign(new Error(message), code ? { code } : {});
const cancelled = () => failure('Archive verification cancelled.', 'ABORT_ERR');

/** Main owns only small manifests/receipts. Every full decode dies with its one-shot Utility. */
export class ArchiveVerificationBroker {
  private jobs = new Map<VerificationWorker, { exited: Promise<void>; cancel(): void }>();
  private closed = false;
  private fork: () => VerificationWorker;
  private options: Options;
  constructor(fork: () => VerificationWorker, options: Options = {}) { this.fork = fork; this.options = options; }
  get activeCount(): number { return this.jobs.size; }
  cancelAll(): void { for (const job of this.jobs.values()) job.cancel(); }
  async waitForIdle(): Promise<void> { await Promise.all([...this.jobs.values()].map(job => job.exited)); }
  async close(): Promise<void> { this.closed = true; this.cancelAll(); await this.waitForIdle(); }
  async verify(directory: string, signal?: AbortSignal): Promise<ArchiveWriteResult> {
    signal?.throwIfAborted();
    if (this.closed) throw failure('Archive verification broker closed.');
    const readManifest = this.options.readManifest ?? readArchiveManifest;
    const before = await readManifest(directory), manifestHash = archiveManifestHash(before), storedBytes = bytes(before);
    if (storedBytes > LIBRARY_ARCHIVE_LIMITS.totalCompressedBytes + LIBRARY_ARCHIVE_LIMITS.manifestBytes) throw failure('Archive verification budget.');
    signal?.throwIfAborted();
    if (this.closed) throw failure('Archive verification broker closed.');
    const jobId = randomUUID(), worker = this.fork();
    return await new Promise<ArchiveWriteResult>((resolve, reject) => {
      let failed: Error | null = null, validated: ArchiveManifest | null = null, checking = false, hasExited = false, done = false, retired = false;
      let releaseExit!: () => void;
      const exited = new Promise<void>(resolveExit => { releaseExit = resolveExit; });
      const finish = () => {
        if (!hasExited) return;
        if (!retired) {
          retired = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
          worker.removeListener('message', onMessage); worker.removeListener('spawn', onSpawn); worker.removeListener('error', onError);
        }
        if (done || (!failed && !validated)) return;
        done = true;
        if (failed) reject(failed);
        else resolve({ manifest: validated!, manifestHash, storedBytes });
      };
      const kill = () => { try { worker.kill(); } catch { /* Exit confirmation still owns cleanup. */ } };
      const fail = (error: Error) => {
        failed ??= error; clearTimeout(timer); signal?.removeEventListener('abort', abort);
        kill(); finish();
        // Return a controlled failure even if the OS cannot confirm retirement yet.
        // jobs retains the process/late-spawn guard; Main defers cleanup and its lock.
        if (!done) { done = true; reject(failed); }
      };
      const abort = () => fail(cancelled());
      const onError = () => fail(failure('Archive verification Utility failed.'));
      const onSpawn = () => {
        if (failed || signal?.aborted || this.closed) { fail(cancelled()); return; }
        try { worker.postMessage({ kind: 'verify-archive', jobId, directory, manifestHash }); }
        catch { fail(failure('Unable to send archive verification job.')); }
      };
      const onMessage = (value: unknown) => {
        if (done || failed) return;
        if (checking || !receipt(value, jobId, manifestHash, storedBytes)) { fail(failure('Invalid archive verification receipt.')); return; }
        checking = true;
        // A receipt never substitutes for Main's own strict small-manifest read.
        void readManifest(directory).then(after => {
          if (failed || signal?.aborted || this.closed) { fail(cancelled()); return; }
          if (archiveManifestHash(after) !== manifestHash || bytes(after) !== storedBytes) {
            fail(failure('Archive manifest changed during verification.')); return;
          }
          validated = after; kill(); finish();
        }, error => fail(error instanceof Error ? error : failure('Archive manifest recheck failed.')));
      };
      const timer = setTimeout(() => fail(failure('Archive verification timed out.', 'ARCHIVE_VERIFY_TIMEOUT')),
        this.options.timeoutMs ?? ARCHIVE_VERIFICATION_TIMEOUT_MS);
      this.jobs.set(worker, { exited, cancel: abort });
      worker.on('message', onMessage); worker.once('spawn', onSpawn); worker.on('error', onError);
      worker.once('exit', () => {
        hasExited = true; this.jobs.delete(worker); releaseExit();
        if (!failed && !validated) failed = failure('Archive verification Utility exited before Main confirmation.');
        finish();
      });
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted || this.closed) abort();
    });
  }
}
