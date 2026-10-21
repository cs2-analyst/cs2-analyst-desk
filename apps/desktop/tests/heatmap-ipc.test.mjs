import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';
import { mainLibraryRequire, tick } from './library-main-fixture.mjs';
import { fixture } from './heatmap-fixture.mjs';
import { HeatmapSession } from '../electron/heatmap-session.ts';
import { HEATMAP_MAX_PENDING, HEATMAP_TIMEOUT_MS, HEATMAP_RESPONSE_BYTES } from '../shared/heatmap-ipc.ts';

const require=createRequire(import.meta.url),{transformSync}=createRequire(require.resolve('vite'))('esbuild');
async function harness() {
  const handlers=new Map(),workers=[],windows=[],timers=new Map();let timerId=0;
  class Window extends EventEmitter {
    constructor(){super();this.webContents=Object.assign(new EventEmitter(),{mainFrame:{},send(){},setWindowOpenHandler(){}});windows.push(this);}
    isDestroyed(){return false;} removeMenu(){} async loadFile(){} close(){this.emit('closed');}
    static getAllWindows(){return windows;}
  }
  const app=Object.assign(new EventEmitter(),{whenReady:()=>Promise.resolve(),setAppUserModelId(){},isPackaged:false});
  const electron={app,BrowserWindow:Window,dialog:{},ipcMain:{handle:(name,fn)=>handlers.set(name,fn)},utilityProcess:{fork:()=>{
    const worker=Object.assign(new EventEmitter(),{sent:[],killed:false,postMessage(value){this.sent.push(value);},kill(){this.killed=true;this.emit('exit',0);}});workers.push(worker);return worker;
  }}};
  const file=new URL('../electron/main.ts',import.meta.url),code=transformSync(readFileSync(file,'utf8'),{loader:'ts',format:'cjs',define:{'import.meta.url':JSON.stringify(file.href),'__CS2_ANALYST_TEST_SEAM__':'false'}}).code;
  vm.runInNewContext(code,{require:name=>name==='electron'?electron:mainLibraryRequire(name,require),process:{platform:'win32',env:{}},console,URL,Buffer,AbortController,
    setTimeout(fn,ms){const id=++timerId;timers.set(id,{fn,ms});return id;},clearTimeout(id){timers.delete(id);}});
  await new Promise(resolve=>setImmediate(resolve));const window=windows[0],trusted={sender:window.webContents,senderFrame:window.webContents.mainFrame};
  async function imported({replay=true,heatmap=true}={}) {
    const promise=handlers.get('report:import-file')(trusted,'C:\\fixture.dem');await tick();const worker=workers.at(-1);worker.emit('spawn');
    const sessionId=worker.sent[0].sessionId,f=fixture(),session=new HeatmapSession(f.match,f.replay,f.spatial,sessionId);
    const metadata=structuredClone(session.metadata);metadata.available=heatmap;
    worker.emit('message',{kind:'prepared',receipt:{},report:{schemaVersion:2,replay:{available:replay,sessionId,matchId:f.match.id,rounds:[{round:1,blocks:[{index:0}]}]},heatmap:metadata}});
    const report=await promise;
    const request={schemaVersion:1,sessionId,layer:'positions',resolution:32,scope:{rounds:null,playerIds:null,side:'all',floor:null,includeFreezeTime:false,samplingSet:'all-valid'}};
    return {worker,session,sessionId,request,report};
  }
  const grid=request=>handlers.get('heatmap:grid')(trusted,request);
  const reply=(current,result=current.session.get(current.request))=>{
    const sent=current.worker.sent.findLast(m=>m.kind==='heatmap-grid');current.worker.emit('message',{kind:'heatmap-grid',requestId:sent.requestId,result});
  };
  return {handlers,workers,window,trusted,imported,grid,reply,timers};
}

test('Main runtime gate rejects untrusted frames and malformed, invented or extra filters',async()=>{
  const h=await harness(),current=await h.imported(),r=current.request;
  for(const event of [{},{sender:{},senderFrame:h.trusted.senderFrame},{sender:h.trusted.sender,senderFrame:{}}])assert.equal((await h.handlers.get('heatmap:grid')(event,r)).kind,'error');
  const invalid=[null,[],{},Object.assign(new Date(),r),{...r,path:'private.dem'},{...r,schemaVersion:2},{...r,layer:'all'},
    {...r,resolution:128},{...r,sessionId:'old'},...[
      null,[],{}, {...r.scope,layers:['positions']},{...r.scope,side:'Unknown'},{...r.scope,rounds:[0]},
      {...r.scope,rounds:[1,1]},{...r.scope,rounds:[2]},{...r.scope,rounds:[1.5]},{...r.scope,rounds:Array(1000).fill(1)},
      {...r.scope,playerIds:['invented']},{...r.scope,playerIds:['1','1']},{...r.scope,playerIds:['1'.repeat(1000)]},
      {...r.scope,playerIds:Array(100).fill('1')},{...r.scope,floor:'invented'},{...r.scope,includeFreezeTime:1},{...r.scope,samplingSet:'all'},
    ].map(scope=>({...r,scope}))];
  for(const value of invalid)assert.equal((await h.grid(value)).kind,'error',JSON.stringify(value));
  assert.equal(current.worker.sent.filter(m=>m.kind==='heatmap-grid').length,0);
  h.window.close();
});

test('Main accepts correlated single-layer JSON result and rejects mismatched/oversized replies immediately',async()=>{
  const h=await harness(),current=await h.imported();
  let pending=h.grid(current.request);h.reply(current);assert.equal((await pending).kind,'success');
  for(const mutate of [
    value=>{value.sessionId='old';},value=>{value.projection.matchId='other';},value=>{value.projection.grid.resolution=64;},
    value=>{value.projection.scope.side='T';},value=>{value.projection.scope.layers=['kills'];},
    value=>{value.projection.kills={};},value=>{value.projection.positions.grid.cells.pop();},
    value=>{value.projection.positions.grid.cells[0].intensity=NaN;},value=>{value.projection.debug='x'.repeat(HEATMAP_RESPONSE_BYTES);},
    value=>{value.projection.positions.domain=new Map();},value=>{value.projection.map.resourceId='wrong';},
  ]){
    pending=h.grid(current.request);const result=current.session.get(current.request);mutate(result);h.reply(current,result);
    assert.equal((await pending).kind,'error');assert.equal(h.timers.size,0,'malformed reply clears its timeout');
  }
  pending=h.grid(current.request);h.reply(current,{kind:'error',message:'x'.repeat(HEATMAP_RESPONSE_BYTES+1)});
  assert.equal((await pending).kind,'error');assert.equal(h.timers.size,0);
  pending=h.grid(current.request);h.reply(current,{kind:'error',message:'Safe grid failure.'});assert.equal((await pending).kind,'error');
  pending=h.grid(current.request);h.reply(current,null);assert.equal((await pending).kind,'error');h.window.close();
});

test('independent in-flight cap and timeout recover without ending Replay or report',async()=>{
  const h=await harness(),current=await h.imported();
  const pending=Array.from({length:HEATMAP_MAX_PENDING},()=>h.grid(current.request));
  assert.equal((await h.grid(current.request)).kind,'error');
  assert.equal(h.timers.size,HEATMAP_MAX_PENDING);
  for(const timer of [...h.timers.values()]){assert.equal(timer.ms,HEATMAP_TIMEOUT_MS);timer.fn();}
  h.timers.clear();
  for(const result of await Promise.all(pending))assert.equal(result.kind,'error');
  assert.equal(current.worker.killed,false);
  const again=h.grid(current.request);h.reply(current);assert.equal((await again).kind,'success');
  const replay=h.handlers.get('replay:chunk')(h.trusted,{sessionId:current.sessionId,round:1,block:0}),last=current.worker.sent.at(-1);
  current.worker.emit('message',{kind:'replay-chunk',requestId:last.requestId,result:{kind:'success',chunk:{schemaVersion:1,sessionId:current.sessionId,matchId:'test',round:1,block:0,frames:[]}}});
  assert.equal((await replay).kind,'success');h.window.close();
});

test('replace, cancel, release, exit and close settle all pending; late worker cannot affect a new session',async()=>{
  for(const action of ['replace','cancel','release','legacy-release','exit','close']){
    const h=await harness(),first=await h.imported(),pending=h.grid(first.request);
    if(action==='replace'||action==='cancel'){
      if(action==='replace'){
        const second=await h.imported();assert.equal((await h.grid(first.request)).kind,'error');
        first.worker.emit('message',{kind:'heatmap-grid',requestId:1,result:first.session.get(first.request)});
        const next=h.grid(second.request);h.reply(second);assert.equal((await next).kind,'success');
      }else{
        const importing=h.handlers.get('report:import-file')(h.trusted,'C:\\next.dem');await h.handlers.get('report:cancel')(h.trusted);
        assert.equal((await importing).kind,'cancelled');
        h.reply(first);assert.equal((await pending).kind,'success','cancelled candidate preserves active heatmap requests');
        assert.equal(first.worker.killed,false);assert.equal(h.timers.size,0);h.window.close();continue;
      }
    }else if(action==='exit')first.worker.emit('exit',1);
    else if(action==='close')h.window.close();
    else await h.handlers.get(action==='release'?'session:release':'replay:release')(h.trusted,first.sessionId);
    assert.equal((await pending).kind,'error',action);assert.equal(first.worker.killed,true);assert.equal(h.timers.size,0);h.window.close();
  }
});

test('Main retains heatmap-only worker, retains replay-only worker, drops worker with neither source',async()=>{
  for(const availability of [{replay:false,heatmap:true},{replay:true,heatmap:false},{replay:false,heatmap:false}]){
    const h=await harness(),current=await h.imported(availability);assert.equal(current.report.kind,'success');
    assert.equal(current.worker.killed,!availability.replay&&!availability.heatmap);
    if(availability.heatmap){const pending=h.grid(current.request);h.reply(current);assert.equal((await pending).kind,'success');}
    else assert.equal((await h.grid(current.request)).kind,'error');
    await h.handlers.get('session:release')(h.trusted,current.sessionId);assert.equal(current.worker.killed,true);h.window.close();
  }
});

test('unconfirmed candidate exit preserves staging; a late spawn is retired without parsing',async()=>{
  const h=await harness(),importing=h.handlers.get('report:import-file')(h.trusted,'C:\\fixture.dem');await tick();const worker=h.workers.at(-1);
  let spawned=false,kills=0;
  worker.kill=()=>{kills++;worker.killed=spawned;if(spawned)worker.emit('exit',0);return spawned;};
  await h.handlers.get('report:cancel')(h.trusted);
  const [timerId,timer]=[...h.timers].find(([,timer])=>timer.ms===3000);h.timers.delete(timerId);timer.fn();
  assert.equal((await importing).kind,'cancelled');assert.equal(worker.killed,false,'pre-spawn kill cannot stop the future OS process');
  spawned=true;worker.pid=123;worker.emit('spawn');
  assert.equal(worker.killed,true);assert.ok(kills>=2);
  assert.equal(worker.sent.some(message=>Object.hasOwn(message,'filePath')),false,'retired worker never receives a DEM');
  h.window.close();
});
