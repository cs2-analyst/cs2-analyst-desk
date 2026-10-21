import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { mainLibraryRequire, createLibraryDouble, tick } from './library-main-fixture.mjs';

const require=createRequire(import.meta.url),{transformSync}=createRequire(require.resolve('vite'))('esbuild');
async function harness(options={}) {
  const handlers=new Map(),workers=[],timers=new Map(),service=createLibraryDouble(),app=new EventEmitter();let window,timerSequence=0;
  service.discarded=[];service.discardStaging=async id=>{service.discarded.push(id);};service.closed=false;service.close=()=>{service.closed=true;};
  Object.assign(app,{whenReady:()=>Promise.resolve(),isPackaged:false,setAppUserModelId(){},quit(){this.emit('will-quit');}});
  class Window extends EventEmitter {
    constructor(){super();window=this;this.webContents=Object.assign(new EventEmitter(),{mainFrame:{},send(){},setWindowOpenHandler(){}});}
    isDestroyed(){return false;}removeMenu(){}async loadFile(){}static getAllWindows(){return [window];}
  }
  const electron={app,BrowserWindow:Window,dialog:{},ipcMain:{handle:(name,fn)=>handlers.set(name,fn)},utilityProcess:{fork(){
    if(options.forkThrows)throw new Error('fork failed');
    const worker=Object.assign(new EventEmitter(),{pid:123,sent:[],killed:false,postMessage(value){this.sent.push(value);},kill(){this.killed=true;if(!options.delayExit)this.emit('exit',0);}});workers.push(worker);return worker;
  }}};
  const file=new URL('../electron/main.ts',import.meta.url),code=transformSync(readFileSync(file,'utf8'),{loader:'ts',format:'cjs',define:{'import.meta.url':JSON.stringify(file.href),'__CS2_ANALYST_TEST_SEAM__':'false'}}).code;
  vm.runInNewContext(code,{require:name=>name==='electron'?electron:mainLibraryRequire(name,require,service),process:{env:{},platform:'win32'},console:{error(){}},URL,Buffer,AbortController,
    setTimeout(fn,ms){const id=++timerSequence;timers.set(id,{fn,ms});return id;},clearTimeout(id){timers.delete(id);}});
  await tick();const trusted={sender:window.webContents,senderFrame:window.webContents.mainFrame};
  const start=async()=>{const promise=handlers.get('report:import-file')(trusted,'C:\\local\\dust2.dem');await tick();const worker=workers.at(-1);worker?.emit('spawn');return {promise,worker};};
  const prepared=worker=>{const sessionId=worker.sent[0].sessionId;worker.emit('message',{kind:'prepared',receipt:{manifestHash:'x',storedBytes:100},report:{schemaVersion:2,replay:{available:true,sessionId,matchId:'match',rounds:[{round:1,blocks:[{index:0}]}]}}});};
  const open=async(matchId)=>{const promise=handlers.get('library:open')(trusted,matchId);await tick();const worker=workers.at(-1);worker?.emit('spawn');return {promise,worker};};
  return {handlers,service,app,trusted,start,prepared,open,workers,timers};
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
test('cancellation after the synchronous durable commit notification still returns success',async()=>{
  const h=await harness();let release;
  h.service.commitStaging=async(_id,_signal,_receipt,onCommitted)=>{onCommitted();await new Promise(resolve=>{release=resolve;});return {entry:{matchId:'match'},duplicate:false};};
  const current=await h.start();h.prepared(current.worker);await tick();await h.handlers.get('report:cancel')(h.trusted);release();
  assert.equal((await current.promise).kind,'success');
  await h.handlers.get('session:release')(h.trusted,current.worker.sent[0].sessionId);
});
test('duplicate activation has a separate deadline after durability has been confirmed',async()=>{
  const h=await harness();h.service.archiveDirectory=async()=> 'C:/owned/existing';
  h.service.commitStaging=async(_id,_signal,_receipt,onCommitted)=>{onCommitted();return {entry:{matchId:'match'},duplicate:true};};
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
  assert.deepEqual(await h.service.get(id), { matchId: id, state: 'ready' });
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
  const chunk = await chunkPromise; assert.equal(chunk.kind, 'success');
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
    result: { kind: 'success', chunk: { schemaVersion: 1, matchId: 'match', sessionId: oldSession, round: 1, block: 0, frames: [], events: [] } } });
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
