import assert from 'node:assert/strict';
import test from 'node:test';
import { ReplayClock,ReplayChunkCache,replayBlockAt,replayDisplayFrame,replayRoundTime,replayRelativeTick } from '../renderer/src/replay-state.ts';
const player=(tick,x,yaw,segment=1,extra=[])=>[0,tick,x,0,0,yaw,100,true,'T',segment,false,...extra];
const bomb={action:'planted',carrierId:null,position:[1,2,3],positionSource:'actor-at-event',ambiguous:false};
const chunk=(a=player(0,0,179),b=player(8,8,-179))=>({schemaVersion:1,sessionId:'s',matchId:'m',round:1,block:0,startTick:0,endTick:8,events:[],frames:[{tick:0,players:[a],bomb},{tick:8,players:[b],bomb}]});

test('transport time is relative to the selected round, formats hours, and never fabricates an unreliable clock',()=>{
  const r={startTick:12000,endTick:12000+128*92.75};
  assert.equal(replayRoundTime(r.startTick,r,128),'00:00');
  assert.equal(replayRoundTime(r.startTick+128*61.8,r,128),'01:01');
  assert.equal(replayRoundTime(r.endTick,r,128),'01:32');
  assert.equal(replayRoundTime(r.endTick+1000,r,128),'01:32');
  assert.equal(replayRoundTime(r.startTick-1000,r,128),'00:00');
  const long={startTick:90000,endTick:90000+64*3661};
  assert.equal(replayRoundTime(long.endTick,long,64),'1:01:01');
  for(const rate of [null,0,-1,NaN,Infinity])assert.equal(replayRoundTime(12345,r,rate),'原始 tick 12345');
});

test('relative transport seeks use actual tick rates, retain fractional tick precision and clamp both ends',()=>{
  for(const rate of [32,64,128,63.5]){
    const r={startTick:10000,endTick:30000},at=20000.125;
    assert.equal(replayRelativeTick(at,-10,r,rate),at-10*rate);
    assert.equal(replayRelativeTick(at,30,r,rate),at+30*rate);
    assert.equal(replayRelativeTick(r.startTick+1,-10,r,rate),r.startTick);
    assert.equal(replayRelativeTick(r.endTick-1,30,r,rate),r.endTick);
  }
  for(const rate of [null,0,-1,NaN,Infinity])assert.equal(replayRelativeTick(20000,30,{startTick:10000,endTick:30000},rate),null);
});

test('1.5x really advances the clock and changing speed preserves the current tick without restarting',()=>{
  const c=new ReplayClock(12000);c.play(1000);
  const before=c.read(2500,128);c.setSpeed(1.5,2500,128);
  assert.equal(c.read(2500,128),before);
  assert.equal(c.read(4500,128),before+2*128*1.5);
  c.setSpeed(.5,4500,128);assert.equal(c.read(6500,128),before+2*128*1.5+128);
  c.pause(6500,128);const paused=c.tick;c.setSpeed(1.5,9000,128);
  assert.equal(c.read(10000,128),paused);assert.equal(c.playing,false);
});
test('clock anchors elapsed time, pause/seek/speed and delayed frames without accumulating drift',()=>{
  const c=new ReplayClock(64);c.play(1000);assert.equal(c.read(6000,64),384);c.pause(6000,64);assert.equal(c.read(9000,64),384);
  c.seek(100,9000);c.play(9000);c.setSpeed(2,10000,64);assert.equal(c.read(11000,64),292);
  c.pause(11000,64);c.seek(10,12000);assert.equal(c.read(18000,null),10);
});
test('short-arc display changes only continuous position/yaw; direct seek matches sequential discrete facts',()=>{
  const c=chunk(),middle=replayDisplayFrame(c,4,8);assert.equal(middle.players[0][2],4);assert.equal(middle.players[0][5],180);assert.equal(middle.players[0][6],100);
  assert.deepEqual(replayDisplayFrame(c,8,8),c.frames[1]);assert.deepEqual(replayDisplayFrame(c,4,8),middle);
  assert.equal(replayDisplayFrame(c,9,8),null);assert.deepEqual(middle.bomb,bomb);
});
test('missing/ambiguous/dead/spawn/segment/gap boundaries never gain interpolated coordinates',()=>{
  for(const edit of [b=>b[1]=null,b=>b[2]=null,b=>b[7]=false,b=>b[9]=2,b=>b[10]=true]){const c=chunk();edit(c.frames[1].players[0]);assert.equal(replayDisplayFrame(c,4,8).players[0][2],null);}
  assert.equal(replayDisplayFrame(chunk(),4,null).players[0][7],null);
  assert.equal(replayDisplayFrame(chunk(),4,2).players[0][2],null);
  const c=chunk();c.frames[1].players[0][5]=null;assert.equal(replayDisplayFrame(c,4,8).players[0][5],null);
});
test('renderer LRU retains at most three chunks and never retains another session after clear',()=>{
  const cache=new ReplayChunkCache();for(let block=0;block<5;block++)cache.put({...chunk(),block});assert.equal(cache.size,3);assert.equal(cache.get(1,0),undefined);assert.ok(cache.get(1,4));cache.clear();assert.equal(cache.size,0);
});
test('fractional boundary tick belongs to the prior integer block and uses its guard without a blank frame',()=>{
  const round={blocks:[{index:0,startTick:0,endTick:7},{index:1,startTick:8,endTick:15}]};
  const c={...chunk(),endTick:7};assert.equal(replayBlockAt(round,7.5).index,0);assert.equal(replayDisplayFrame(c,7.5,8).players[0][2],7.5);
  assert.equal(replayBlockAt(round,8).index,1);assert.equal(replayDisplayFrame(chunk(),8.5,8),null);
});
test('carrier marker follows only a valid interpolated carrier; missing/lifecycle gaps remove its location',()=>{
  const c=chunk();for(const f of c.frames)f.bomb={...bomb,action:'pickup',carrierId:'player',positionSource:'carrier-sample'};
  assert.deepEqual(replayDisplayFrame(c,4,8,['player']).bomb.position,[4,0,0]);
  c.frames[1].players[0][9]=2;assert.equal(replayDisplayFrame(c,4,8,['player']).bomb.position,null);
});
test('cross-floor observations do not manufacture a floor from interpolated Z',()=>{
  const c=chunk();c.frames[0].players[0][4]=-496;c.frames[1].players[0][4]=-494;
  const floor=z=>z===null||z===-495?null:z< -495?'lower':'default';
  assert.equal(replayDisplayFrame(c,4,8,[],floor).players[0][4],null);
  assert.equal(replayDisplayFrame(c,0,8,[],floor).players[0][4],-496,'Exact observed floor remains available');
});
