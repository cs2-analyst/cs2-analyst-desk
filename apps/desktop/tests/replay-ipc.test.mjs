import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';
import { mainLibraryRequire, tick } from './library-main-fixture.mjs';
const require=createRequire(import.meta.url),{transformSync}=createRequire(require.resolve('vite'))('esbuild');
async function harness(){
  const handlers=new Map(),workers=[],windows=[];
  class Window extends EventEmitter {constructor(){super();this.webContents=Object.assign(new EventEmitter(),{mainFrame:{},send(){},setWindowOpenHandler(){}});windows.push(this);}isDestroyed(){return false;}removeMenu(){}async loadFile(){}close(){this.emit('closed');} static getAllWindows(){return windows;}}
  const app=Object.assign(new EventEmitter(),{whenReady:()=>Promise.resolve(),setAppUserModelId(){},isPackaged:false}),env={CS2_ANALYST_DEM_PATH:'sample.dem'};
  const electron={app,BrowserWindow:Window,dialog:{showOpenDialog:async()=>({canceled:true,filePaths:[]})},ipcMain:{handle:(name,fn)=>handlers.set(name,fn)},utilityProcess:{fork:()=>{const worker=Object.assign(new EventEmitter(),{sent:[],killed:false,postMessage(v){this.sent.push(v);},kill(){this.killed=true;this.emit('exit',0);}});workers.push(worker);return worker;}}};
  const file=new URL('../electron/main.ts',import.meta.url),code=transformSync(readFileSync(file,'utf8'),{loader:'ts',format:'cjs',define:{'import.meta.url':JSON.stringify(file.href),'__CS2_ANALYST_TEST_SEAM__':'false'}}).code;
  vm.runInNewContext(code,{require:n=>n==='electron'?electron:mainLibraryRequire(n,require),process:{platform:'win32',env},console,URL,Buffer,AbortController,setTimeout,clearTimeout});
  await new Promise(r=>setImmediate(r));const window=windows[0],trusted={sender:window.webContents,senderFrame:window.webContents.mainFrame};
  async function imported(){const promise=handlers.get('report:import')(trusted);await tick();const worker=workers.at(-1);worker.emit('spawn');const sessionId=worker.sent[0].sessionId;
    worker.emit('message',{kind:'prepared',receipt:{},report:{schemaVersion:2,replay:{available:true,sessionId,matchId:'match',rounds:[{round:1,blocks:[{index:0},{index:1}]}]}}});await promise;return {worker,sessionId};}
  return {handlers,workers,window,trusted,imported,env};
}
test('IPC guards sender/frame/session/round/block/shape and releases current persistent worker',async()=>{
  const h=await harness(),{worker,sessionId}=await h.imported();assert.equal(worker.killed,false);
  const valid={sessionId,round:1,block:0};
  for(const request of [null,[],{}, {...valid,path:'bad'},{...valid,round:NaN},{...valid,round:2},{...valid,block:9},{...valid,sessionId:'old'},{...valid,block:0.5}])assert.equal((await h.handlers.get('replay:chunk')(h.trusted,request)).kind,'error');
  for(const event of [{sender:{},senderFrame:h.trusted.senderFrame},{sender:h.trusted.sender,senderFrame:{}},{}])assert.equal((await h.handlers.get('replay:chunk')(event,valid)).kind,'error');
  const response=h.handlers.get('replay:chunk')(h.trusted,valid),message=worker.sent.at(-1);
  worker.emit('message',{kind:'replay-chunk',requestId:message.requestId,result:{kind:'success',chunk:{schemaVersion:1,matchId:'match',sessionId,round:1,block:0,frames:[]}}});assert.equal((await response).kind,'success');
  delete h.env.CS2_ANALYST_DEM_PATH;assert.equal((await h.handlers.get('report:import')(h.trusted)).kind,'cancelled');assert.equal(worker.killed,false,'Cancelling the file dialog preserves the active replay');
  await h.handlers.get('replay:release')(h.trusted,'old');assert.equal(worker.killed,false);
  await h.handlers.get('replay:release')(h.trusted,sessionId);assert.equal(worker.killed,true);
  assert.equal((await h.handlers.get('replay:chunk')(h.trusted,valid)).kind,'error');h.window.close();
});
test('bounded outstanding chunk requests reject floods and release resolves every pending request',async()=>{
  const h=await harness(),{worker,sessionId}=await h.imported(),valid={sessionId,round:1,block:0};
  const pending=Array.from({length:4},()=>h.handlers.get('replay:chunk')(h.trusted,valid));
  assert.equal((await h.handlers.get('replay:chunk')(h.trusted,valid)).kind,'error');
  await h.handlers.get('replay:release')(h.trusted,sessionId);for(const result of await Promise.all(pending))assert.equal(result.kind,'error');assert.equal(worker.killed,true);h.window.close();
});
test('new import rejects pending old chunks/late worker returns; cancellation and window close clean workers',async()=>{
  const h=await harness(),first=await h.imported();
  const pending=h.handlers.get('replay:chunk')(h.trusted,{sessionId:first.sessionId,round:1,block:0});
  const second=await h.imported();assert.equal(first.worker.killed,true);assert.equal((await pending).kind,'error');
  first.worker.emit('message',{kind:'success',report:{replay:{sessionId:first.sessionId}}});assert.equal((await h.handlers.get('replay:chunk')(h.trusted,{sessionId:first.sessionId,round:1,block:0})).kind,'error');
  const request=h.handlers.get('report:import')(h.trusted);await tick();const third=h.workers.at(-1);await h.handlers.get('report:cancel')(h.trusted);assert.equal((await request).kind,'cancelled');assert.equal(third.killed,true);assert.equal(second.worker.killed,false,'cancelled candidate preserves active worker');
  const fourth=await h.imported();h.window.close();assert.equal(fourth.worker.killed,true);
});
