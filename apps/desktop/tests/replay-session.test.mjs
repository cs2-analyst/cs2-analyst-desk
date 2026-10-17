import assert from 'node:assert/strict';
import test from 'node:test';
import { ReplaySession } from '../electron/replay-session.ts';
const make=()=>{
  const match={id:'match',map:'de_dust2',players:[{steamId:'1',nickname:'p'}],rounds:[]};
  const frames=Array.from({length:401},(_,tick)=>({requestedTick:tick,players:[{playerId:'1',actualTick:tick,position:[tick,0,0],yaw:0,health:100,alive:true,side:'T',segment:1,stateAmbiguous:false}]}));
  const replay={schemaVersion:1,matchId:'match',samplingVersion:'test',source:'native-final-tick-observation',tickRate:8,hz:8,maxInterpolationTicks:1,players:['1'],excludedRounds:[],rounds:[{
    round:1,startTick:0,endTick:400,freezeEndTick:8,frames,coverage:{requestedFrames:401,missingPlayerSamples:0,status:'complete'},lifecycle:[],events:[
      {eventIndex:0,event:{type:'bomb',tick:100,action:'planted',player:'1',playerSide:'T'}},
      {eventIndex:1,event:{type:'bomb',tick:350,action:'exploded',player:'1',playerSide:'T'}}]}]};
  return {match,replay};
};
test('random block access contains independent bomb/player baseline and guard frames, without whole-match IPC',()=>{
  const {match,replay}=make(),s=new ReplaySession(match,replay,'session');
  const info=s.metadata.rounds[0];assert.equal(info.blocks.length,3);
  const second=s.get({sessionId:'session',round:1,block:1});assert.equal(second.frames[0].bomb.action,'planted');assert.deepEqual(second.frames[0].bomb.position,[100,0,0]);
  const third=s.get({sessionId:'session',round:1,block:2});assert.equal(third.frames.at(-1).bomb.action,'exploded');
  const first=s.get({sessionId:'session',round:1,block:0});assert.deepEqual(first.frames.at(-1),second.frames[0]);
  assert.equal(s.get({sessionId:'old',round:1,block:0}),null);assert.equal(s.get({sessionId:'session',round:2,block:0}),null);
  const hash=JSON.stringify(s.get({sessionId:'session',round:1,block:1}));assert.equal(JSON.stringify(second),hash);
  assert.ok(!JSON.stringify(second).includes('filePath'));s.clear();assert.equal(s.bytes,0);assert.equal(s.chunks.size,0);
});
test('oversized chunks split further; cache/single-tick overflow fails explicitly',()=>{
  const {match,replay}=make(),s=new ReplaySession(match,replay,'session',{chunkBytes:6000,cacheBytes:1000000});
  assert.ok(s.metadata.rounds[0].blocks.length>3);for(const json of s.chunks.values())assert.ok(Buffer.byteLength(json)<=6000);
  assert.throws(()=>new ReplaySession(match,replay,'session',{chunkBytes:1000000,cacheBytes:1}),/cache budget/);
  assert.throws(()=>new ReplaySession(match,replay,'session',{chunkBytes:1,cacheBytes:1000000}),/single-tick/);
});
test('same-tick bomb transitions preserve ambiguity; no order or trajectory is invented',()=>{
  const {match,replay}=make();replay.rounds[0].events.push({eventIndex:2,event:{type:'bomb',tick:100,action:'drop',player:'1',playerSide:'T'}});
  const s=new ReplaySession(match,replay,'session'),c=s.get({sessionId:'session',round:1,block:1});
  assert.equal(c.frames[0].bomb.ambiguous,true);assert.equal(c.frames[0].bomb.position,null);
});
test('utility key-event copy uses the real thrower and chunks carry only overlapping effect evidence',()=>{
  const {match,replay}=make();
  match.players=[{steamId:'1',nickname:' ropz '},{steamId:'2',nickname:'donk'}];
  replay.players=['1','2'];
  replay.rounds[0].events=[
    {eventIndex:0,event:{type:'utility',tick:100,utility:'smoke',action:'detonate',thrower:'1',throwerSide:'T',entityId:7,position:{x:10,y:20,z:30}}},
    {eventIndex:1,event:{type:'utility',tick:150,utility:'fire',action:'start_burn',thrower:'1',throwerSide:'T',entityId:9,position:{x:40,y:50,z:60}}},
    {eventIndex:2,event:{type:'utility',tick:160,utility:'flashbang',action:'detonate',thrower:null,throwerSide:'Unknown',entityId:11,position:{x:70,y:80,z:90}}},
    {eventIndex:3,event:{type:'kill',tick:200,killer:'1',victim:'2'}},
    {eventIndex:4,event:{type:'bomb',tick:250,action:'planted',player:'1',playerSide:'T'}},
  ];
  replay.rounds[0].utilities=[
    {eventIndex:0,kind:'smoke',variant:null,throwerId:'1',entityId:7,tick:100,endTick:300,endSource:'observed',position:[10,20,30],
      flight:{startTick:80,endTick:100,points:[[80,0,0,0],[90,10,0,0],[100,10,20,30]]}},
    {eventIndex:1,kind:'fire',variant:'incendiary',throwerId:'1',entityId:9,tick:150,endTick:310,endSource:'observed',position:[40,50,60],flight:null},
    {eventIndex:2,kind:'flashbang',variant:null,throwerId:null,tick:160,endTick:162,endSource:'nominal',position:[70,80,90],flight:null},
  ];
  replay.rounds[0].blinds=[{victimId:'2',attackerId:'1',startTick:90,endTick:180}];
  replay.rounds[0].burns=[{victimId:'2',startTick:200,endTick:260}];
  const s=new ReplaySession(match,replay,'session'),first=s.get({sessionId:'session',round:1,block:0});
  const second=s.get({sessionId:'session',round:1,block:1}),third=s.get({sessionId:'session',round:1,block:2});
  const text=id=>[...first.events,...second.events].find(event=>event.id===id)?.description;
  assert.equal(text('r1-e0'),'ropz 投掷了 smoke');
  assert.equal(text('r1-e1'),'ropz 投掷了 incendiary');
  assert.equal(text('r1-e2'),'未知玩家 投掷了 flashbang');
  assert.equal(text('r1-e3'),' ropz  击杀 donk','non-utility copy is untouched');
  assert.equal(text('r1-e4'),'炸弹安放完成');
  assert.deepEqual(first.utilities.map(utility=>utility.kind),['smoke','fire']);
  assert.deepEqual(second.utilities.map(utility=>utility.kind),['smoke','fire','flashbang']);
  assert.equal(third.utilities,undefined,'effects that ended before a block are not retained');
  assert.deepEqual(second.utilities[0].trajectory.points,[[80,0,0,0],[90,10,0,0],[100,10,20,30]]);
  assert.deepEqual(first.blinds,[{victimId:'2',attackerId:'1',startTick:90,endTick:180}]);
  assert.equal(first.burns,undefined);assert.deepEqual(second.burns,[{victimId:'2',startTick:200,endTick:260}]);
  assert.equal(first.utilities[0].id,'r1-u0');
});
