import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';
import { createHeatmapSession } from '../electron/heatmap-session.ts';
import { fixture } from './heatmap-fixture.mjs';

const require=createRequire(import.meta.url),{transformSync}=createRequire(require.resolve('vite'))('esbuild');
async function harness({replay=true,spatial=true,replayFailure=false,heatmapFailure=false,heapFailure=false,gridFailure=false,defer=false}={}) {
  const f=fixture(),port=new EventEmitter(),sent=[],processEvents=new EventEmitter();let parses=0,replayClears=0,heatmapClears=0,complete;
  port.postMessage=value=>sent.push(value);
  const code=transformSync(readFileSync(new URL('../electron/report-worker.ts',import.meta.url),'utf8'),{loader:'ts',format:'cjs'}).code;
  vm.runInNewContext(code,{process:{parentPort:port,on:(...args)=>processEvents.on(...args)},require:name=>{
    if(name==='@cs2-analyst/dem-parser')return {Demoparser2Provider:class {async parseWithReplay(){parses++;if(defer)await new Promise(resolve=>{complete=resolve;});return {...f,replay:replay?f.replay:null,spatial:spatial?f.spatial:null};}}};
    if(name==='./report.js')return {buildDesktopReport:()=>({schemaVersion:2,match:{id:f.match.id},analytics:[{kills:4}]})};
    if(name==='./player-name.ts')return {displayPlayerName:(_id,nickname)=>nickname?.trim()?nickname:'未知玩家'};
    if(name==='./library-derived-replay.ts')return {};
    if(name==='./replay-session.ts')return {ReplaySession:class {
      constructor(){if(replayFailure)throw new Error('budget');this.metadata={available:true,sessionId:'session'};}
      clear(){replayClears++;} get(){return {frames:[]};}
    }};
    if(name==='./heatmap-session.ts')return {createHeatmapSession:(...args)=>{
      const result=heatmapFailure?createHeatmapSession(...args,{project(){throw new Error('projection');}})
        :heapFailure?createHeatmapSession(...args,{getHeapUsed:()=>513*1024*1024}):createHeatmapSession(...args);
      if(result.session){const clear=result.session.clear.bind(result.session);result.session.clear=()=>{heatmapClears++;clear();};if(gridFailure)result.session.get=()=>{throw new Error('private input path');};}
      return result;
    }};
    if(name==='../shared/replay-resource.ts')return {replayResourceId:'resource'};
    throw new Error(name);
  }});
  port.emit('message',{data:{filePath:'local.dem',sessionId:'session'}});
  await new Promise(resolve=>setImmediate(resolve));
  const scope={rounds:null,playerIds:null,side:'all',floor:null,includeFreezeTime:false,samplingSet:'all-valid'};
  const request=(layer='kills')=>({schemaVersion:1,sessionId:'session',layer,resolution:32,scope});
  return {port,sent,processEvents,request,complete,get counts(){return {parses,replayClears,heatmapClears};}};
}

test('Worker initializes once and validates requests again before returning single-layer projections',async()=>{
  const h=await harness();assert.ok(h.sent.find(m=>m.kind==='success').report.heatmap.available);
  h.port.emit('message',{data:{filePath:'another.dem',sessionId:'another'}});
  for(const request of [null,{...h.request(),sessionId:'old'},{...h.request(),resolution:128},{...h.request(),scope:{...h.request().scope,playerIds:['invented']}}]){
    h.port.emit('message',{data:{kind:'heatmap-grid',requestId:1,request}});assert.equal(h.sent.at(-1).result.kind,'error');
  }
  h.port.emit('message',{data:{kind:'heatmap-grid',requestId:2,request:h.request()}});
  assert.equal(h.sent.at(-1).result.kind,'success');assert.equal(h.sent.at(-1).result.projection.positions,null);assert.equal(h.sent.at(-1).result.projection.deaths,null);
  assert.equal(h.counts.parses,1);h.port.emit('message',{data:{kind:'session-release'}});
  assert.deepEqual(h.counts,{parses:1,replayClears:1,heatmapClears:1});
  h.port.emit('message',{data:{kind:'heatmap-grid',requestId:3,request:h.request()}});assert.equal(h.sent.at(-1).result.kind,'error');
  h.processEvents.emit('exit');assert.deepEqual(h.counts,{parses:1,replayClears:1,heatmapClears:1});
});

test('Worker report, Replay budget failure, missing sources and heatmap initialization failure degrade independently',async()=>{
  for(const options of [{replayFailure:true},{replay:false},{spatial:false},{heatmapFailure:true},{heapFailure:true},{replay:false,spatial:false}]){
    const h=await harness(options),report=h.sent.find(m=>m.kind==='success')?.report;assert.ok(report);assert.equal(report.analytics[0].kills,4);
    assert.equal(report.replay.available,!options.replayFailure&&options.replay!==false);
    assert.equal(report.heatmap.available,!options.heatmapFailure&&!options.heapFailure&&(options.replay!==false||options.spatial!==false));
    if(options.heapFailure)assert.equal(report.heatmap.unavailableReason,'memory-budget-exceeded');
    for(const layer of ['positions','kills','deaths']){
      h.port.emit('message',{data:{kind:'heatmap-grid',requestId:1,request:h.request(layer)}});
      const available=!options.heatmapFailure&&!options.heapFailure&&(layer==='positions'?options.replay!==false:options.spatial!==false);
      assert.equal(h.sent.at(-1).result.kind,available?'success':'error');
    }
    h.port.emit('message',{data:{kind:'session-release'}});
  }
});

test('Worker catches a grid exception without leaking thrown text or losing usable Replay',async()=>{
  const h=await harness({gridFailure:true});h.port.emit('message',{data:{kind:'heatmap-grid',requestId:1,request:h.request()}});
  assert.equal(h.sent.at(-1).result.kind,'error');assert.ok(!h.sent.at(-1).result.message.includes('private input path'));
  h.port.emit('message',{data:{kind:'replay-chunk',requestId:2,request:{sessionId:'session',round:1,block:0}}});assert.equal(h.sent.at(-1).result.kind,'success');
  h.processEvents.emit('exit');assert.equal(h.counts.heatmapClears,1);
});

test('release during asynchronous parse prevents late initialization or reentry',async()=>{
  const h=await harness({defer:true});h.port.emit('message',{data:{kind:'session-release'}});h.complete();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(h.sent.some(m=>m.kind==='success'),false);
  h.port.emit('message',{data:{filePath:'next.dem',sessionId:'next'}});assert.equal(h.counts.parses,1);
});
