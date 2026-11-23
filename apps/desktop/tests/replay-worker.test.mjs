import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';
const require=createRequire(import.meta.url),{transformSync}=createRequire(require.resolve('vite'))('esbuild');
async function reanalysisHarness({ expectedMatchId = 'a'.repeat(64), selfPlayerId = 'self' } = {}) {
  const port = new EventEmitter(), sent = [], identities = [];
  port.postMessage = value => sent.push(value);
  const code = transformSync(readFileSync(new URL('../electron/report-worker.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'cjs' }).code;
  vm.runInNewContext(code, { process: { parentPort: port, on() {} }, require: name => {
    if (name === '@cs2-analyst/dem-parser') return { Demoparser2Provider: class { async parseWithReplay() { return { match: { id: 'a'.repeat(64), map: 'de_dust2', players: [{ steamId: 'self', nickname: 'Self' }] }, spatial: null, replay: null }; } } };
    if (name === './report.js') return { buildDesktopReport: (_m, _p, _s, _t, self) => { identities.push(self); return { schemaVersion: 2, players: [{ id: 'self' }], analysis: { players: [], perPlayer: [] }, match: { id: 'a'.repeat(64) } }; } };
    if (name === './spatial-facts.ts') return { buildDesktopSpatialFacts: async () => null, unavailableDesktopSpatialFacts: matchId => ({ matchId, status: 'unavailable' }) };
    if (name === '@cs2-analyst/report-contract') return { isDesktopSpatialFacts: () => false };
    if (name === './player-name.ts') return { displayPlayerName: (_id, name) => name };
    if (name === './replay-session.ts') return { ReplaySession: class {} };
    if (name === './library-derived-replay.ts') return {};
    if (name === '../shared/replay-resource.ts') return { replayResourceId: 'resource' };
    if (name === './heatmap-session.ts') return { createHeatmapSession: () => ({ session: null, metadata: { available: false } }) };
    throw new Error(name);
  } });
  port.emit('message', { data: { filePath: 'local.dem', sessionId: 'session', expectedMatchId, selfPlayerId } });
  await new Promise(r => setImmediate(r));
  return { sent, identities };
}

test('reanalysis worker checks the parsed DEM identity before any analysis or replacement', async () => {
  const h = await reanalysisHarness({ expectedMatchId: 'b'.repeat(64) });
  assert.match(h.sent.find(m => m.kind === 'error').message, /不匹配/);
  assert.deepEqual(h.identities, []);
  assert.equal(h.sent.some(m => ['players', 'prepared', 'success'].includes(m.kind)), false);
});
test('reanalysis worker retains the saved self choice, including null, without prompting again', async () => {
  for (const self of ['self', null]) {
    const h = await reanalysisHarness({ selfPlayerId: self });
    assert.deepEqual(h.identities, [self]);
    assert.equal(h.sent.some(m => m.kind === 'players'), false);
    assert.equal(h.sent.find(m => m.kind === 'success').selfPlayerId, self);
  }
});
test('reanalysis worker rejects a missing saved player rather than clearing the identity', async () => {
  const h = await reanalysisHarness({ selfPlayerId: 'missing' });
  assert.match(h.sent.find(m => m.kind === 'error').message, /缺少已选择的玩家/);
  assert.deepEqual(h.identities, []);
});

test('replay cache failure degrades independently after the successful unchanged report',async()=>{
  const port=new EventEmitter(),sent=[];port.postMessage=value=>sent.push(value);
  const report={schemaVersion:2,match:{id:'id'},players:[],analysis:{players:[],perPlayer:[]},analytics:[{kills:4}]};let reads=0;
  const code=transformSync(readFileSync(new URL('../electron/report-worker.ts',import.meta.url),'utf8'),{loader:'ts',format:'cjs'}).code;
  vm.runInNewContext(code,{process:{parentPort:port,on(){}},require:name=>{
    if(name==='@cs2-analyst/dem-parser')return {Demoparser2Provider:class {async parseWithReplay(){reads++;return {match:{id:'id',map:'map'},spatial:{},replay:{},replayUnavailableReason:null};}}};
    if(name==='./report.js')return {buildDesktopReport:()=>report};
    if(name==='./spatial-facts.ts')return {buildDesktopSpatialFacts:async()=>null,unavailableDesktopSpatialFacts:matchId=>({matchId,status:'unavailable'})};
    if(name==='@cs2-analyst/report-contract')return {isDesktopSpatialFacts:()=>false};
    if(name==='./player-name.ts')return {displayPlayerName:(_id,nickname)=>nickname?.trim()?nickname:'未知玩家'};
    if(name==='./replay-session.ts')return {ReplaySession:class {constructor(){throw new Error('budget');}}};
    if(name==='./library-derived-replay.ts')return {};
    if(name==='../shared/replay-resource.ts')return {replayResourceId:'resource'};
    if(name==='./heatmap-session.ts')return {createHeatmapSession:()=>({session:null,metadata:{available:false}})};
    throw new Error(name);
  }});
  port.emit('message',{data:{filePath:'local.dem',sessionId:'session'}});await new Promise(r=>setImmediate(r));
  const result=sent.find(m=>m.kind==='success');assert.ok(result);assert.equal(result.report.analytics[0].kills,4);assert.equal(result.report.replay.available,false);
  port.emit('message',{data:{filePath:'other.dem',sessionId:'other'}});await new Promise(r=>setImmediate(r));assert.equal(reads,1,'A replay worker cannot be repurposed to read arbitrary paths');
  port.emit('message',{data:{kind:'replay-chunk',requestId:1,request:{sessionId:'session',round:1,block:0}}});assert.equal(sent.at(-1).result.kind,'error');
});
