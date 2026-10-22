import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import vm from 'node:vm';
import { assertOwnedDirectory, createOwnedTempDirectory } from '../../../scripts/owned-qa-run.mjs';
import { mainLibraryRequire, createLibraryDouble, tick } from './library-main-fixture.mjs';
import * as libraryArchive from '../electron/library-archive.ts';
import * as libraryPortable from '../electron/library-portable.ts';
import { writeLibraryArchive } from '../electron/library-archive.ts';
import { verifyPortableArchive, writePortableArchive } from '../electron/library-portable.ts';

const require=createRequire(import.meta.url),{transformSync}=createRequire(require.resolve('vite'))('esbuild');
const MATCH = 'a'.repeat(64);
const portableVersions = { application: '0.1.0', archive: 1, report: 2, replay: 1, analysis: 'test-analysis', parser: 'test-parser',
  native: 'test-native', sampling: 'test-sampling', mapResource: 'test-map', sourceRevision: '1'.repeat(40) };
function archiveInput() {
  return { match: { id: MATCH, map: 'de_dust2', players: [{ steamId: '1' }], rounds: [] }, replay: null, spatial: null, chunks: new Map(),
    versions: portableVersions,
    report: { schemaVersion: 2, match: { id: MATCH, fileName: 'dust2.dem', map: 'de_dust2', rounds: 0, score: null }, selectedPlayer: '1',
      players: [{ id: '1', nickname: 'Tester' }], analytics: [], findings: [], timeline: [],
      analysis: { players: [], perPlayer: [] }, deepReview: { available: false, players: [] } } };
}
async function ownedRun(t) {
  const run = createOwnedTempDirectory('library-main-ops');
  t.after(async () => { assertOwnedDirectory(run); await rm(run.directory, { recursive: true, force: true }); });
  return run;
}
async function archiveFixture(root) {
  const directory = join(root, 'archive');
  await mkdir(directory);
  await writeLibraryArchive(directory, archiveInput());
  return directory;
}
function realEntry(overrides = {}) {
  return { matchId: MATCH, state: 'ready', fileName: 'dust2.dem', map: 'de_dust2', rounds: 0, score: null, players: [],
    importedAt: '2026-10-22T00:00:00.000Z', versions: portableVersions,
    capabilities: Object.fromEntries(['report', 'deepReview', 'timeline', 'analysis', 'replay', 'heatmap']
      .map(name => [name, { status: 'unavailable', reason: 'test' }])), storedBytes: 1, ...overrides };
}
async function harness(options={}) {
  const handlers=new Map(),workers=[],timers=new Map(),messages=[],service=createLibraryDouble(),app=new EventEmitter();let window,timerSequence=0;
  service.discarded=[];service.discardStaging=async id=>{service.discarded.push(id);};service.closed=false;service.close=()=>{service.closed=true;};
  Object.assign(app,{whenReady:()=>Promise.resolve(),isPackaged:options.isPackaged??false,setAppUserModelId(){},getPath:()=> 'C:/owned-test/documents',quit(){this.emit('will-quit');}});
  class Window extends EventEmitter {
    constructor(){super();window=this;this.webContents=Object.assign(new EventEmitter(),{mainFrame:{},send(channel,...args){messages.push({channel,args});},setWindowOpenHandler(){}});}
    isDestroyed(){return false;}removeMenu(){}async loadFile(){}static getAllWindows(){return [window];}
  }
  const electron={app,BrowserWindow:Window,dialog:options.dialog??{},ipcMain:{handle:(name,fn)=>handlers.set(name,fn)},utilityProcess:{fork(){
    if(options.forkThrows)throw new Error('fork failed');
    const worker=Object.assign(new EventEmitter(),{pid:123,sent:[],killed:false,postMessage(value){this.sent.push(value);},kill(){this.killed=true;if(!options.delayExit)this.emit('exit',0);}});workers.push(worker);return worker;
  }}};
  const file=new URL('../electron/main.ts',import.meta.url),code=transformSync(readFileSync(file,'utf8'),{loader:'ts',format:'cjs',define:{'import.meta.url':JSON.stringify(file.href),'__CS2_ANALYST_TEST_SEAM__':JSON.stringify(options.testSeam===true)}}).code;
  vm.runInNewContext(code,{require:name=>name==='electron'?electron:mainLibraryRequire(name,require,service,{archive:libraryArchive,portable:options.portable??libraryPortable}),process:{env:options.env??{},platform:'win32',resourcesPath:'C:/owned-test/resources'},console:{error(){}},URL,Buffer,AbortController,
    setTimeout(fn,ms){const id=++timerSequence;timers.set(id,{fn,ms});return id;},clearTimeout(id){timers.delete(id);}});
  await tick();const trusted={sender:window.webContents,senderFrame:window.webContents.mainFrame};
  const start=async()=>{const promise=handlers.get('report:import-file')(trusted,'C:\\local\\dust2.dem');await tick();const worker=workers.at(-1);worker?.emit('spawn');return {promise,worker};};
  const prepared=worker=>{const sessionId=worker.sent[0].sessionId;worker.emit('message',{kind:'prepared',receipt:{manifestHash:'x',storedBytes:100},report:{schemaVersion:2,match:{id:MATCH},replay:{available:true,sessionId,matchId:MATCH,rounds:[{round:1,blocks:[{index:0}]}]}}});};
  const open=async(matchId)=>{const promise=handlers.get('library:open')(trusted,matchId);await tick();const worker=workers.at(-1);worker?.emit('spawn');return {promise,worker};};
  return {handlers,service,app,trusted,start,prepared,open,workers,timers,messages};
}

test('catalogue privileged routes reject foreign frames, invalid limits and oversized service responses',async()=>{
  const h=await harness();
  for(const event of [{},{sender:{},senderFrame:h.trusted.senderFrame},{sender:h.trusted.sender,senderFrame:{}}]){
    assert.equal((await h.handlers.get('library:list')(event,{})).kind,'error');assert.equal((await h.handlers.get('library:storage')(event)).kind,'error');
  }
  assert.equal((await h.handlers.get('library:list')(h.trusted,{limit:101})).kind,'error');
  assert.equal((await h.handlers.get('library:list')(h.trusted,{})).kind,'success');
  h.service.list=()=>({kind:'success',entries:['x'.repeat(600_000)]});
  assert.equal((await h.handlers.get('library:list')(h.trusted,{})).kind,'error');
});
test('a candidate cannot publish success before catalogue commit and precommit cancellation aborts it',async()=>{
  const h=await harness();let release,seen;
  h.service.commitStaging=async(_id,signal)=>{seen=signal;await new Promise(resolve=>{release=resolve;});if(signal.aborted)throw new Error('cancelled');};
  const current=await h.start();h.prepared(current.worker);await tick();assert.ok(seen);assert.equal(seen.aborted,false);
  let completed=false;current.promise.then(()=>{completed=true;});await tick();assert.equal(completed,false);
  await h.handlers.get('report:cancel')(h.trusted);release();assert.equal((await current.promise).kind,'cancelled');assert.equal(seen.aborted,true);
});
test('DEM import asks the Renderer for the local player and persists the chosen identity', async () => {
  const h = await harness();
  let committedSelf = 'unset';
  h.service.commitStaging = async (_id, _signal, _receipt, onCommitted, selfPlayerId) => {
    committedSelf = selfPlayerId;
    onCommitted?.();
    return { entry: { matchId: MATCH, selfPlayerId: selfPlayerId ?? null }, duplicate: false };
  };
  const current = await h.start();
  current.worker.emit('message', { kind: 'players', players: [{ id: '1', nickname: 'A' }, { id: '2', nickname: 'B' }] });
  await tick();
  const prompt = h.messages.find(message => message.channel === 'report:import-players');
  assert.ok(prompt); assert.deepEqual(JSON.parse(JSON.stringify(prompt.args[0])), [{ id: '1', nickname: 'A' }, { id: '2', nickname: 'B' }]);
  assert.equal((await h.handlers.get('report:select-player')(h.trusted, '9')).kind, 'error');
  assert.equal((await h.handlers.get('report:select-player')(h.trusted, '2')).kind, 'success');
  assert.deepEqual(JSON.parse(JSON.stringify(current.worker.sent.at(-1))), { kind: 'player-selection', playerId: '2' });
  const sessionId = current.worker.sent[0].sessionId;
  current.worker.emit('message', { kind: 'prepared', receipt: { manifestHash: 'x', storedBytes: 100 },
    selfPlayerId: '2', report: { schemaVersion: 2, match: { id: MATCH }, players: [{ id: '1' }, { id: '2' }],
      replay: { available: true, sessionId, matchId: MATCH, rounds: [{ round: 1, blocks: [{ index: 0 }] }] } } });
  const result = await current.promise;
  assert.equal(result.kind, 'success'); assert.equal(result.selfPlayerId, '2'); assert.equal(committedSelf, '2');
});

test('cancelling while the player prompt is open ends the import and kills the candidate', async () => {
  const h = await harness();
  const current = await h.start();
  current.worker.emit('message', { kind: 'players', players: [{ id: '1', nickname: 'A' }] });
  await tick();
  await h.handlers.get('report:cancel')(h.trusted);
  assert.equal((await current.promise).kind, 'cancelled');
  assert.equal(current.worker.killed, true);
  assert.equal(h.messages.some(message => message.channel === 'report:import-players'), true);
});

test('saved-match self identity is validated and persisted through the catalogue service', async () => {
  const h = await harness(), calls = [];
  h.service.setSelfPlayer = async (matchId, playerId) => { calls.push([matchId, playerId]); return { kind: 'success', selfPlayerId: playerId }; };
  assert.equal((await h.handlers.get('library:set-self-player')({}, MATCH, '1')).kind, 'error');
  assert.equal((await h.handlers.get('library:set-self-player')(h.trusted, '../bad', '1')).kind, 'error');
  assert.equal((await h.handlers.get('library:set-self-player')(h.trusted, MATCH, 7)).kind, 'error');
  assert.deepEqual(JSON.parse(JSON.stringify(await h.handlers.get('library:set-self-player')(h.trusted, MATCH, '1'))),
    { kind: 'success', selfPlayerId: '1' });
  assert.deepEqual(JSON.parse(JSON.stringify(await h.handlers.get('library:set-self-player')(h.trusted, MATCH, null))),
    { kind: 'success', selfPlayerId: null });
  assert.deepEqual(calls, [[MATCH, '1'], [MATCH, null]]);
});

test('cancellation after the synchronous durable commit notification still returns success',async()=>{
  const h=await harness();let release;
  h.service.commitStaging=async(_id,_signal,_receipt,onCommitted)=>{onCommitted();await new Promise(resolve=>{release=resolve;});return {entry:{matchId:MATCH},duplicate:false};};
  const current=await h.start();h.prepared(current.worker);await tick();await h.handlers.get('report:cancel')(h.trusted);release();
  assert.equal((await current.promise).kind,'success');
  await h.handlers.get('session:release')(h.trusted,current.worker.sent[0].sessionId);
});
test('duplicate activation has a separate deadline after durability has been confirmed',async()=>{
  const h=await harness();h.service.archiveDirectory=async()=> 'C:/owned/existing';
  h.service.commitStaging=async(_id,_signal,_receipt,onCommitted)=>{onCommitted();return {entry:{matchId:MATCH},duplicate:true};};
  const current=await h.start();h.prepared(current.worker);await tick();
  assert.equal(current.worker.sent.at(-1).kind,'restore-duplicate');
  const timer=[...h.timers.values()].find(timer=>timer.ms===30_000);assert.ok(timer);timer.fn();
  const result=await current.promise;assert.equal(result.kind,'error');assert.match(result.message,/已在本地库.*超时/);
});
test('saved-match open rejects foreign frames, invalid ids and unavailable entries', async () => {
  const h = await harness();
  assert.equal((await h.handlers.get('library:open')({}, 'a'.repeat(64))).kind, 'error');
  assert.equal((await h.handlers.get('library:open')(h.trusted, '../' + 'a'.repeat(64))).kind, 'error');
  h.service.get = () => null;
  assert.equal((await h.handlers.get('library:open')(h.trusted, 'a'.repeat(64))).kind, 'error');
});

test('import cannot start while a saved match is opening', async () => {
  const h = await harness();
  const opened = await h.open('a'.repeat(64));
  assert.equal((await h.handlers.get('report:import-file')(h.trusted, 'C:\\local\\x.dem')).kind, 'error');
  opened.worker.emit('message', { kind: 'error', message: 'stop' });
  assert.equal((await opened.promise).kind, 'error');
});

test('saved-match open restores a fresh session from the archive directory', async () => {
  const h = await harness(), id = 'a'.repeat(64);
  assert.deepEqual(await h.service.get(id), { matchId: id, state: 'ready', selfPlayerId: null });
  const opened = await h.open(id);
  assert.equal(opened.worker.sent[0].kind, 'restore');
  assert.equal(opened.worker.sent[0].archiveDirectory, 'C:/owned-test/archive-' + id);
  const sessionId = opened.worker.sent[0].sessionId;
  opened.worker.emit('message', { kind: 'restored', report: { schemaVersion: 2, match: { id },
    replay: { available: true, sessionId, matchId: id, rounds: [{ round: 1, blocks: [{ index: 0 }] }] },
    heatmap: { available: false, sessionId } } });
  const result = await opened.promise;
  assert.equal(result.kind, 'success'); assert.equal(result.report.replay.sessionId, sessionId);
  const chunkPromise = h.handlers.get('replay:chunk')(h.trusted, { sessionId, round: 1, block: 0 }); await tick();
  const request = opened.worker.sent.at(-1); assert.equal(request.kind, 'replay-chunk');
  opened.worker.emit('message', { kind: 'replay-chunk', requestId: request.requestId,
    result: { kind: 'success', chunk: { schemaVersion: 1, matchId: id, sessionId, round: 1, block: 0, frames: [], events: [] } } });
  const chunk = await Promise.race([chunkPromise, new Promise(resolve => setTimeout(() => resolve('pending'), 100))]);
  assert.notEqual(chunk, 'pending', 'missing reply routing must fail instead of hanging'); assert.equal(chunk.kind, 'success');
  opened.worker.emit('exit', 0); await tick();
  const afterExit = await h.handlers.get('replay:chunk')(h.trusted, { sessionId, round: 1, block: 0 });
  assert.equal(afterExit.kind, 'error', 'a dead restored worker must not leave a stale active session');
  assert.equal(opened.worker.killed, true);
});

test('restored worker heatmap replies are routed and cleared on failure', async () => {
  const h = await harness(), id = 'a'.repeat(64);
  const opened = await h.open(id);
  const sessionId = opened.worker.sent[0].sessionId;
  opened.worker.emit('message', { kind: 'restored', report: { schemaVersion: 2, match: { id }, replay: null,
    heatmap: { schemaVersion: 1, sessionId, matchId: id, available: true, unavailableReason: null,
      layers: { positions: { available: true, unavailableReason: null }, kills: { available: false, unavailableReason: 'spatial-unavailable' },
        deaths: { available: false, unavailableReason: 'spatial-unavailable' } },
      map: { id: 'de_dust2', resourceId: null, alignment: 'unavailable', precision: 'schematic-position-distribution' },
      samplingVersion: 's', resolutions: [32], playerIds: [], rounds: [1], floors: [] } } });
  assert.equal((await opened.promise).kind, 'success');
  const pending = h.handlers.get('heatmap:grid')(h.trusted, { schemaVersion: 1, sessionId, layer: 'positions', resolution: 32,
    scope: { rounds: null, playerIds: null, side: 'all', floor: null, includeFreezeTime: false, samplingSet: 'all-valid' } });
  await tick();
  const request = opened.worker.sent.at(-1); assert.equal(request.kind, 'heatmap-grid');
  opened.worker.emit('message', { kind: 'heatmap-grid', requestId: request.requestId, result: { kind: 'error', message: 'bad' } });
  const settled = await Promise.race([pending, new Promise(resolve => setTimeout(() => resolve('pending'), 100))]);
  assert.notEqual(settled, 'pending'); assert.equal(settled.kind, 'error');
  assert.equal([...h.timers.values()].some(timer => timer.ms === 15_000), false, 'reply must clear its timeout');
  await h.handlers.get('session:release')(h.trusted, sessionId);
});

test('failed saved-match open keeps the previous live session and worker', async () => {
  const h = await harness();
  const current = await h.start(); h.prepared(current.worker);
  const imported = await current.promise; assert.equal(imported.kind, 'success');
  const oldSession = current.worker.sent[0].sessionId;
  const opened = await h.open('a'.repeat(64));
  opened.worker.emit('message', { kind: 'error', message: 'archive broken' });
  assert.equal((await opened.promise).kind, 'error');
  assert.equal(opened.worker.killed, true);
  assert.equal(current.worker.killed, false);
  const pending = h.handlers.get('replay:chunk')(h.trusted, { sessionId: oldSession, round: 1, block: 0 }); await tick();
  const request = current.worker.sent.at(-1); assert.equal(request.kind, 'replay-chunk');
  current.worker.emit('message', { kind: 'replay-chunk', requestId: request.requestId,
    result: { kind: 'success', chunk: { schemaVersion: 1, matchId: MATCH, sessionId: oldSession, round: 1, block: 0, frames: [], events: [] } } });
  assert.equal((await pending).kind, 'success', 'the previous session must still answer after a failed open');
  await h.handlers.get('session:release')(h.trusted, oldSession);
});

test('fork failure cleans its prepared staging directory and returns a recoverable error',async()=>{
  const h=await harness({forkThrows:true}),current=await h.start();assert.equal((await current.promise).kind,'error');assert.deepEqual(h.service.discarded,['stage-1']);
});
test('unconfirmed writer exit keeps staging and the exclusive database open until its actual exit',async()=>{
  const h=await harness({delayExit:true}),current=await h.start();await h.handlers.get('report:cancel')(h.trusted);
  [...h.timers.values()].find(timer=>timer.ms===3000).fn();assert.equal((await current.promise).kind,'cancelled');assert.equal(h.service.discarded.length,0);
  let prevented=false;h.app.emit('before-quit',{preventDefault(){prevented=true;}});assert.equal(prevented,true);assert.equal(h.service.closed,false);
  current.worker.emit('exit',0);await tick();await tick();assert.equal(h.service.closed,true);assert.deepEqual(h.service.discarded,['stage-1']);
});


test('library remove validates trusted frames and ids, then retires the active match worker before deleting', async () => {
  const h = await harness();
  const current = await h.start(); h.prepared(current.worker);
  assert.equal((await current.promise).kind, 'success');
  const session = current.worker.sent[0].sessionId;
  assert.equal((await h.handlers.get('library:remove')({}, [MATCH])).kind, 'error');
  assert.equal((await h.handlers.get('library:remove')({ sender: h.trusted.sender, senderFrame: {} }, [MATCH])).kind, 'error');
  for (const value of [undefined, null, [], 'ids', ['x'.repeat(64)], ['A'.repeat(64)], [MATCH, MATCH],
    Array.from({ length: 101 }, (_, index) => index.toString(16).padStart(64, '0'))]) {
    assert.equal((await h.handlers.get('library:remove')(h.trusted, value)).kind, 'error', JSON.stringify(value)?.slice(0, 60));
  }
  assert.deepEqual(h.service.removed, []);
  let observed = null;
  h.service.remove = async ids => { observed = { ids: [...ids], killed: current.worker.killed }; return { kind: 'success', removed: [...ids], failed: [] }; };
  const result = await h.handlers.get('library:remove')(h.trusted, [MATCH]);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { kind: 'success', removed: [MATCH], failed: [] });
  assert.deepEqual(observed, { ids: [MATCH], killed: true }, 'the worker must be killed before the service deletes files');
  assert.equal((await h.handlers.get('replay:chunk')(h.trusted, { sessionId: session, round: 1, block: 0 })).kind, 'error',
    'the retired session must no longer answer');
});

test('an unconfirmed active worker blocks only its own id and other ids still delete', async () => {
  const h = await harness({ delayExit: true });
  const current = await h.start(); h.prepared(current.worker);
  assert.equal((await current.promise).kind, 'success');
  let call = null;
  h.service.remove = async ids => { call = [...ids]; return { kind: 'success', removed: [...ids], failed: [] }; };
  const other = 'b'.repeat(64);
  const pending = h.handlers.get('library:remove')(h.trusted, [MATCH, other]);
  await tick();
  assert.equal(call, null, 'deletion must wait for the retirement decision');
  const retirement = [...h.timers.values()].find(timer => timer.ms === 3_000);
  assert.ok(retirement, 'retirement must be bounded');
  retirement.fn();
  const result = await pending;
  assert.deepEqual(Array.from(result.removed), [other]);
  assert.deepEqual(Array.from(result.failed, item => item.matchId), [MATCH]);
  assert.deepEqual(call, [other]);
});

test('export streams a verified cs2a to the injected dev path and returns only a basename and bytes', async t => {
  const run = await ownedRun(t), archive = await archiveFixture(run.directory), destination = join(run.directory, 'exported.cs2a');
  const h = await harness({ env: { CS2_ANALYST_EXPORT_PATH: destination } });
  h.service.get = () => realEntry();
  h.service.archiveDirectory = async () => archive;
  const result = await h.handlers.get('library:export')(h.trusted, MATCH);
  assert.equal(result.kind, 'success');
  assert.deepEqual(Object.keys(result).sort(), ['bytes', 'fileName', 'kind']);
  assert.equal(result.fileName, 'exported.cs2a');
  assert.equal(result.bytes, (await stat(destination)).size);
  assert.equal(JSON.stringify(result).includes(run.directory), false, 'no filesystem path may cross to Renderer');
  const verified = await verifyPortableArchive(destination);
  assert.equal(verified.header.matchId, MATCH); assert.equal(verified.manifest.matchId, MATCH);
  assert.deepEqual(readdirSync(run.directory).filter(name => name.endsWith('.tmp')), []);
});

test('the export dialog supplies the destination, appends .cs2a, and cancellation writes nothing', async t => {
  const run = await ownedRun(t), archive = await archiveFixture(run.directory), chosen = join(run.directory, 'chosen');
  const h = await harness({ dialog: { showSaveDialog: async () => ({ canceled: false, filePath: chosen }) } });
  h.service.get = () => realEntry(); h.service.archiveDirectory = async () => archive;
  const result = await h.handlers.get('library:export')(h.trusted, MATCH);
  assert.equal(result.kind, 'success'); assert.equal(result.fileName, 'chosen.cs2a'); assert.ok(existsSync(chosen + '.cs2a'));
  const cancelled = await harness({ dialog: { showSaveDialog: async () => ({ canceled: true, filePath: '' }) } });
  cancelled.service.get = () => realEntry(); cancelled.service.archiveDirectory = async () => archive;
  assert.equal((await cancelled.handlers.get('library:export')(cancelled.trusted, MATCH)).kind, 'cancelled');
  assert.equal(existsSync(join(run.directory, 'cancelled.cs2a')), false);
});

test('export guards reject foreign frames, malformed ids, unavailable entries and busy imports', async t => {
  const run = await ownedRun(t), archive = await archiveFixture(run.directory);
  const h = await harness({ env: { CS2_ANALYST_EXPORT_PATH: join(run.directory, 'guarded.cs2a') } });
  assert.equal((await h.handlers.get('library:export')({}, MATCH)).kind, 'error');
  assert.equal((await h.handlers.get('library:export')(h.trusted, '../' + MATCH)).kind, 'error');
  h.service.get = () => realEntry({ state: 'invalid' }); h.service.archiveDirectory = async () => archive;
  assert.equal((await h.handlers.get('library:export')(h.trusted, MATCH)).kind, 'error');
  h.service.get = () => null;
  assert.equal((await h.handlers.get('library:export')(h.trusted, MATCH)).kind, 'error');
  const busy = await harness();
  const current = await busy.start();
  assert.equal((await busy.handlers.get('library:export')(busy.trusted, MATCH)).kind, 'error');
  assert.equal((await busy.handlers.get('library:import')(busy.trusted)).kind, 'error');
  await busy.handlers.get('report:cancel')(busy.trusted);
  assert.equal((await current.promise).kind, 'cancelled');
});

test('export failures leave no success file and no temporary file behind', async t => {
  const run = await ownedRun(t), archive = await archiveFixture(run.directory);
  const h = await harness({ env: { CS2_ANALYST_EXPORT_PATH: join(run.directory, 'broken.cs2a') } });
  h.service.get = () => realEntry(); h.service.archiveDirectory = async () => archive;
  const compressed = await readFile(join(archive, 'report.json.gz'));
  compressed[compressed.length - 1] ^= 1;
  await writeFile(join(archive, 'report.json.gz'), compressed);
  const failed = await h.handlers.get('library:export')(h.trusted, MATCH);
  assert.equal(failed.kind, 'error');
  assert.equal(JSON.stringify(failed).includes(run.directory), false);
  assert.equal(existsSync(join(run.directory, 'broken.cs2a')), false);
  const healthy = await ownedRun(t), good = await archiveFixture(healthy.directory);
  const directoryTarget = join(healthy.directory, 'directory-target.cs2a');
  await mkdir(directoryTarget);
  const rename = await harness({ env: { CS2_ANALYST_EXPORT_PATH: directoryTarget } });
  rename.service.get = () => realEntry(); rename.service.archiveDirectory = async () => good;
  assert.equal((await rename.handlers.get('library:export')(rename.trusted, MATCH)).kind, 'error');
  assert.equal(existsSync(directoryTarget), true);
  assert.deepEqual(readdirSync(healthy.directory).filter(name => name.includes('.tmp')), [], 'a failed rename removes its temp file');
});

test('import streams the package into owned staging, verifies it and reports the duplicate flag', async t => {
  const run = await ownedRun(t), archive = await archiveFixture(run.directory), packagePath = join(run.directory, 'match.cs2a');
  await writePortableArchive(archive, packagePath);
  const staging = join(run.directory, 'staging');
  await mkdir(staging);
  const h = await harness({ env: { CS2_ANALYST_IMPORT_PATH: packagePath } });
  h.service.createStaging = async () => ({ id: 'stage-1', directory: staging });
  let committed = null;
  h.service.commitStaging = async (id, signal, receipt, onCommitted) => {
    const verified = await libraryArchive.verifyLibraryArchive(staging);
    committed = { id, receipt, verified };
    onCommitted?.();
    return { entry: realEntry(), duplicate: true };
  };
  const result = await h.handlers.get('library:import')(h.trusted);
  assert.equal(result.kind, 'success'); assert.equal(result.duplicate, true); assert.equal(result.entry.matchId, MATCH);
  assert.equal(JSON.stringify(result).includes(run.directory), false);
  assert.equal(committed.id, 'stage-1');
  assert.equal(committed.receipt.manifestHash, committed.verified.manifestHash);
  assert.equal(committed.receipt.storedBytes, committed.verified.storedBytes);
  assert.ok(existsSync(join(staging, 'manifest.json')));
  assert.deepEqual(h.service.discarded, []);
});

test('corrupt or truncated packages are rejected before commit, discard staging and keep existing matches', async t => {
  const run = await ownedRun(t), archive = await archiveFixture(run.directory), valid = join(run.directory, 'valid.cs2a');
  await writePortableArchive(archive, valid);
  const original = await readFile(valid);
  const flipped = Buffer.from(original); flipped[flipped.length - 1] ^= 1;
  const corrupt = join(run.directory, 'corrupt.cs2a'); await writeFile(corrupt, flipped);
  const truncated = join(run.directory, 'truncated.cs2a'); await writeFile(truncated, original.subarray(0, original.length - 1));
  for (const packagePath of [corrupt, truncated]) {
    const staging = join(run.directory, 'stage-' + (packagePath === corrupt ? 'flip' : 'trunc'));
    await mkdir(staging);
    const h = await harness({ env: { CS2_ANALYST_IMPORT_PATH: packagePath } });
    h.service.createStaging = async () => ({ id: 'stage-1', directory: staging });
    let commits = 0;
    h.service.commitStaging = async () => { commits++; return { entry: realEntry(), duplicate: false }; };
    const result = await h.handlers.get('library:import')(h.trusted);
    assert.equal(result.kind, 'error');
    assert.equal(JSON.stringify(result).includes(run.directory), false);
    assert.equal(commits, 0, 'an invalid package must never reach the catalogue');
    assert.deepEqual(h.service.discarded, ['stage-1']);
    assert.equal(h.service.get(MATCH).state, 'ready', 'the existing match record is untouched');
  }
});

test('import cancellation leaves no staging; production ignores path injection while test-seam may use it', async t => {
  const run = await ownedRun(t), archive = await archiveFixture(run.directory), packagePath = join(run.directory, 'match.cs2a');
  await writePortableArchive(archive, packagePath);
  const h = await harness({ dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) } });
  let created = 0; h.service.createStaging = async () => { created++; return { id: 'stage-1', directory: join(run.directory, 'cancelled-stage') }; };
  assert.equal((await h.handlers.get('library:import')(h.trusted)).kind, 'cancelled');
  assert.equal(created, 0);
  const packaged = await harness({ isPackaged: true, env: { CS2_ANALYST_IMPORT_PATH: packagePath },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) } });
  assert.equal((await packaged.handlers.get('library:import')(packaged.trusted)).kind, 'cancelled',
    'production must ignore the environment path');
  const seamStage = join(run.directory, 'seam-stage'); await mkdir(seamStage);
  const seam = await harness({ isPackaged: true, testSeam: true, env: { CS2_ANALYST_IMPORT_PATH: packagePath } });
  seam.service.createStaging = async () => ({ id: 'stage-seam', directory: seamStage });
  seam.service.commitStaging = async () => ({ entry: realEntry(), duplicate: true });
  assert.equal((await seam.handlers.get('library:import')(seam.trusted)).kind, 'success',
    'the dedicated test-seam build may use the QA path');
  const relative = await harness({ env: { CS2_ANALYST_IMPORT_PATH: 'relative.cs2a' } });
  assert.equal((await relative.handlers.get('library:import')(relative.trusted)).kind, 'error');
  assert.deepEqual(relative.service.discarded, []);
  const wrongExtension = await harness({ env: { CS2_ANALYST_IMPORT_PATH: join(run.directory, 'match.zip') } });
  assert.equal((await wrongExtension.handlers.get('library:import')(wrongExtension.trusted)).kind, 'error');
});

test('export dev path injection is ignored by packaged builds while the dialog path is used', async t => {
  const run = await ownedRun(t), archive = await archiveFixture(run.directory);
  const injected = join(run.directory, 'injected.cs2a'), chosen = join(run.directory, 'dialog.cs2a');
  const h = await harness({ isPackaged: true, env: { CS2_ANALYST_EXPORT_PATH: injected },
    dialog: { showSaveDialog: async () => ({ canceled: false, filePath: chosen }) } });
  h.service.get = () => realEntry(); h.service.archiveDirectory = async () => archive;
  const result = await h.handlers.get('library:export')(h.trusted, MATCH);
  assert.equal(result.kind, 'success'); assert.equal(result.fileName, 'dialog.cs2a');
  assert.ok(existsSync(chosen)); assert.equal(existsSync(injected), false);
});

test('the import dialog supplies a .cs2a package, and other extensions are rejected without staging', async t => {
  const run = await ownedRun(t), archive = await archiveFixture(run.directory), packagePath = join(run.directory, 'dialog.cs2a');
  await writePortableArchive(archive, packagePath);
  const staging = join(run.directory, 'dialog-staging');
  await mkdir(staging);
  const calls = [];
  const h = await harness({ dialog: { showOpenDialog: async (_window, options) => { calls.push(options); return { canceled: false, filePaths: [packagePath] }; } } });
  h.service.createStaging = async () => ({ id: 'stage-1', directory: staging });
  h.service.commitStaging = async () => ({ entry: realEntry(), duplicate: false });
  const result = await h.handlers.get('library:import')(h.trusted);
  assert.equal(result.kind, 'success'); assert.equal(result.duplicate, false);
  assert.deepEqual(Array.from(calls[0].properties), ['openFile']);
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].filters)), [{ name: 'CS2 Analyst 比赛归档', extensions: ['cs2a'] }]);
  let created = 0;
  const wrong = await harness({ dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [join(run.directory, 'match.zip')] }) } });
  wrong.service.createStaging = async () => { created++; return { id: 'stage-1', directory: staging }; };
  assert.equal((await wrong.handlers.get('library:import')(wrong.trusted)).kind, 'error');
  assert.equal(created, 0);
});

test('destructive removal and open/import entry points cannot race each other', async () => {
  const h = await harness();
  let release;
  h.service.remove = async () => { await new Promise(resolve => { release = resolve; }); return { kind: 'success', removed: [MATCH], failed: [] }; };
  const removal = h.handlers.get('library:remove')(h.trusted, [MATCH]);
  await tick();
  assert.equal((await h.handlers.get('library:open')(h.trusted, MATCH)).kind, 'error', 'open must not start during removal');
  assert.equal((await h.handlers.get('library:import')(h.trusted)).kind, 'error', 'archive import must not start during removal');
  release();
  assert.equal((await removal).kind, 'success');
  const opened = h.handlers.get('library:open')(h.trusted, MATCH);
  await tick();
  assert.equal((await h.handlers.get('library:remove')(h.trusted, [MATCH])).kind, 'error', 'removal must not start while a saved match is opening');
  const worker = h.workers.at(-1);
  worker.emit('message', { kind: 'error', message: 'stop' });
  assert.equal((await opened).kind, 'error');
});
