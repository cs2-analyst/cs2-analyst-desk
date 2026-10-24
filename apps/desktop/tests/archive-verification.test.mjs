import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import { ArchiveVerificationBroker, isArchiveVerificationRequest } from '../electron/archive-verification.ts';
import { archiveManifestHash } from '../electron/library-archive.ts';

const tick = () => new Promise(resolve => setImmediate(resolve));
const manifest = () => ({ format: 'cs2-analyst-match', schemaVersion: 2, matchId: 'a'.repeat(64), files: [] });
const storedBytes = value => Buffer.byteLength(JSON.stringify(value));
class Worker extends EventEmitter {
  pid = 100;
  sent = [];
  kills = 0;
  autoExit = true;
  postMessage(value) { this.sent.push(value); }
  kill() { this.kills++; if (this.autoExit && this.pid !== undefined) this.emit('exit', 0); }
}
async function started(options = {}) {
  const worker = new Worker(); Object.assign(worker, options.worker);
  const value = manifest(); let reads = 0;
  const broker = new ArchiveVerificationBroker(() => worker, {
    readManifest: async () => { reads++; return options.recheck && reads > 1 ? options.recheck(value) : value; },
    timeoutMs: options.timeoutMs ?? 5000,
  });
  const controller = new AbortController();
  const promise = broker.verify('C:/owned-test/archive', controller.signal);
  const outcome = promise.then(value => ({ value }), error => ({ error }));
  await tick(); if (options.spawn !== false) worker.emit('spawn');
  const validReceipt = () => ({ kind: 'archive-verified', jobId: worker.sent[0].jobId,
    manifestHash: archiveManifestHash(value), storedBytes: storedBytes(value) });
  return { broker, worker, value, promise, outcome, controller, validReceipt, reads: () => reads };
}

test('broker binds one private job, rechecks the small manifest and confirms Utility exit', async () => {
  const h = await started({ worker: { autoExit: false } });
  assert.equal(isArchiveVerificationRequest(h.worker.sent[0]), true);
  h.worker.emit('message', h.validReceipt()); await tick();
  let complete = false; h.promise.then(() => { complete = true; }); await tick();
  assert.equal(complete, false); assert.equal(h.broker.activeCount, 1); assert.equal(h.worker.kills, 1);
  h.worker.emit('exit', 0);
  const result = await h.promise;
  assert.equal(result.manifestHash, archiveManifestHash(h.value)); assert.equal(result.storedBytes, storedBytes(h.value));
  assert.equal(h.reads(), 2); assert.equal(h.broker.activeCount, 0);
  assert.equal(h.worker.listenerCount('message'), 0); assert.equal(h.worker.listenerCount('spawn'), 0);
});

test('wrong job, digest, byte count, arbitrary payload and duplicate receipts cannot publish success', async () => {
  for (const mutate of [r => { r.jobId = randomUUID(); }, r => { r.manifestHash = 'b'.repeat(64); },
    r => { r.storedBytes++; }, r => { r.sources = ['do not send arrays to Main']; }, r => { r.kind = 'success'; }]) {
    const h = await started(); const response = h.validReceipt(); mutate(response); h.worker.emit('message', response);
    assert.match((await h.outcome).error.message, /receipt/); assert.equal(h.broker.activeCount, 0);
  }
  const h = await started({ worker: { autoExit: false } });
  h.worker.emit('message', h.validReceipt()); h.worker.emit('message', h.validReceipt()); h.worker.emit('exit', 0);
  assert.match((await h.outcome).error.message, /receipt/);
});

test('Main rejects a manifest changed after the worker receipt', async () => {
  const h = await started({ recheck: value => ({ ...value, matchId: 'b'.repeat(64) }) });
  h.worker.emit('message', h.validReceipt());
  assert.match((await h.outcome).error.message, /changed/);
});

test('a verifier crash during the asynchronous Main manifest recheck cannot publish success', async () => {
  let finishRead;
  const h = await started({ recheck: value => new Promise(resolve => { finishRead = () => resolve(value); }) });
  h.worker.emit('message', h.validReceipt()); h.worker.emit('exit', 1);
  assert.match((await h.outcome).error.message, /exited/);
  finishRead(); await tick(); assert.equal(h.broker.activeCount, 0);
});

test('cancel, crash, error and timeout kill the worker and never return a verification receipt', async () => {
  for (const reason of ['cancel', 'crash', 'error', 'timeout']) {
    const h = await started({ timeoutMs: reason === 'timeout' ? 5 : 5000 });
    if (reason === 'cancel') h.controller.abort();
    if (reason === 'crash') h.worker.emit('exit', 1);
    if (reason === 'error') h.worker.emit('error', new Error('crash'));
    const result = await h.outcome;
    assert.ok(result.error); assert.equal(result.value, undefined); assert.equal(h.broker.activeCount, 0);
    if (reason === 'timeout') assert.equal(result.error.code, 'ARCHIVE_VERIFY_TIMEOUT');
  }
});

test('pre-spawn cancellation retires the late process before cleanup is confirmed', async () => {
  const h = await started({ worker: { autoExit: false, pid: undefined }, spawn: false });
  h.controller.abort();
  let idle = false; const waiting = h.broker.waitForIdle().then(() => { idle = true; });
  await tick(); assert.equal(idle, false);
  h.worker.pid = 100; h.worker.emit('spawn');
  assert.equal(h.worker.sent.length, 0); assert.equal(h.worker.kills, 2);
  h.worker.emit('exit', 0); await waiting;
  assert.ok((await h.outcome).error); assert.equal(idle, true);
});

test('close cancels all jobs, waits actual exit, and prevents new jobs', async () => {
  const h = await started({ worker: { autoExit: false } });
  let closed = false; const closing = h.broker.close().then(() => { closed = true; });
  await tick(); assert.equal(closed, false); h.worker.emit('exit', 0); await closing;
  assert.ok((await h.outcome).error); assert.equal(closed, true);
  await assert.rejects(h.broker.verify('C:/owned-test/archive'), /closed/);
});

test('a fork failure or pre-aborted signal cannot leave a registered worker', async () => {
  const broker = new ArchiveVerificationBroker(() => { throw new Error('fork failed'); }, { readManifest: async () => manifest() });
  await assert.rejects(broker.verify('C:/owned-test/archive'), /fork failed/); assert.equal(broker.activeCount, 0);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(broker.verify('C:/owned-test/archive', controller.signal), { name: 'AbortError' });
});

function verifierHarness(verify) {
  const require = createRequire(import.meta.url), { transformSync } = createRequire(require.resolve('vite'))('esbuild');
  const port = new EventEmitter(), sent = [], exits = [];
  port.postMessage = value => sent.push(value);
  const code = transformSync(readFileSync(new URL('../electron/archive-verifier.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'cjs' }).code;
  vm.runInNewContext(code, { require: name => name === './library-archive.ts' ? { verifyLibraryArchive: verify }
    : name === './archive-verification.ts' ? { isArchiveVerificationRequest } : require(name),
    process: { parentPort: port, exit(code) { exits.push(code); throw new Error('test process exit'); } } });
  return { invoke: data => port.listeners('message')[0]({ data }), sent, exits };
}
test('one-shot verifier returns only the private bounded receipt after full validation', async () => {
  let calls = 0;
  const h = verifierHarness(async () => { calls++; return { manifestHash: 'a'.repeat(64), storedBytes: 123,
    sources: { replay: ['large private source'] }, report: ['private report'] }; });
  const request = { kind: 'verify-archive', jobId: randomUUID(), directory: 'C:/owned-test/archive', manifestHash: 'a'.repeat(64) };
  await h.invoke(request); await h.invoke(request);
  assert.equal(calls, 1); assert.equal(h.sent.length, 1);
  assert.equal(Object.keys(h.sent[0]).sort().join(), 'jobId,kind,manifestHash,storedBytes');
  assert.ok(Buffer.byteLength(JSON.stringify(h.sent[0])) < 256);
});
test('one-shot verifier exits without success for invalid jobs, failed verification or changed manifests', async () => {
  for (const scenario of ['invalid', 'failed', 'changed']) {
    const h = verifierHarness(async () => { if (scenario === 'failed') throw new Error('corrupt'); return { manifestHash: 'b'.repeat(64), storedBytes: 123 }; });
    const request = { kind: 'verify-archive', jobId: randomUUID(), directory: 'C:/owned-test/archive', manifestHash: 'a'.repeat(64) };
    await assert.rejects(h.invoke(scenario === 'invalid' ? { ...request, directory: '../escape' } : request), /test process exit/);
    assert.equal(h.sent.length, 0); assert.deepEqual(h.exits, [1]);
  }
});
