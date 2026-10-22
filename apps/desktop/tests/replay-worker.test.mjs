import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';
const require=createRequire(import.meta.url),{transformSync}=createRequire(require.resolve('vite'))('esbuild');
test('replay cache failure degrades independently after the successful unchanged report',async()=>{
  const port=new EventEmitter(),sent=[];port.postMessage=value=>sent.push(value);
  const report={schemaVersion:2,match:{id:'id'},analytics:[{kills:4}]};let reads=0;
  const code=transformSync(readFileSync(new URL('../electron/report-worker.ts',import.meta.url),'utf8'),{loader:'ts',format:'cjs'}).code;
  vm.runInNewContext(code,{process:{parentPort:port,on(){}},require:name=>{
    if(name==='@cs2-analyst/dem-parser')return {Demoparser2Provider:class {async parseWithReplay(){reads++;return {match:{id:'id',map:'map'},spatial:{},replay:{},replayUnavailableReason:null};}}};
    if(name==='./report.js')return {buildDesktopReport:()=>report};
    if(name==='./player-name.ts')return {displayPlayerName:(_id,nickname)=>nickname?.trim()?nickname:'未知玩家'};
    if(name==='./replay-session.ts')return {ReplaySession:class {constructor(){throw new Error('budget');}}};
    if(name==='../shared/replay-resource.ts')return {replayResourceId:'resource'};
    if(name==='./heatmap-session.ts')return {createHeatmapSession:()=>({session:null,metadata:{available:false}})};
    throw new Error(name);
  }});
  port.emit('message',{data:{filePath:'local.dem',sessionId:'session'}});await new Promise(r=>setImmediate(r));
  const result=sent.find(m=>m.kind==='success');assert.ok(result);assert.equal(result.report.analytics[0].kills,4);assert.equal(result.report.replay.available,false);
  port.emit('message',{data:{filePath:'other.dem',sessionId:'other'}});await new Promise(r=>setImmediate(r));assert.equal(reads,1,'A replay worker cannot be repurposed to read arbitrary paths');
  port.emit('message',{data:{kind:'replay-chunk',requestId:1,request:{sessionId:'session',round:1,block:0}}});assert.equal(sent.at(-1).result.kind,'error');
});
