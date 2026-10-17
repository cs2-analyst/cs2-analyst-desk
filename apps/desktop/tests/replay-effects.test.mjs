import assert from 'node:assert/strict';
import test from 'node:test';
import { REPLAY_EFFECT_LAYER_ORDER, replayEffectsAt, replayTrajectorySample, replayTrajectoryTrail } from '../renderer/src/replay-effects.ts';

const trajectory=(points)=>({startTick:points[0][0],endTick:points.at(-1)[0],points});
const utility=(kind,tick,endTick,path=null)=>({id:`u-${kind}-${tick}`,eventIndex:1,kind,variant:null,throwerId:null,entityId:1,
  tick,endTick,endSource:'observed',position:[0,0,0],trajectory:path});
const chunk=(utilities=[])=>({schemaVersion:1,sessionId:'s',matchId:'m',round:1,block:0,startTick:0,endTick:200,
  frames:[],events:[],utilities,blinds:[{victimId:'v',attackerId:null,startTick:0,endTick:35}],burns:[{victimId:'b',startTick:0,endTick:35}]});

test('trajectory interpolation follows every real sample and never shortcut the endpoints',()=>{
  const path=trajectory([[0,0,0,0],[10,0,100,0],[20,0,0,0]]);
  assert.deepEqual({...replayTrajectorySample(path,5,64)},{tick:5,x:0,y:50,z:0,speed:640});
  assert.deepEqual({...replayTrajectorySample(path,10,64)},{tick:10,x:0,y:100,z:0,speed:640});
  assert.equal(replayTrajectorySample(path,-1,64),null);assert.equal(replayTrajectorySample(path,21,64),null);
  assert.equal(replayTrajectorySample(trajectory([[0,0,0,0]]),0,64).speed,0);
});

test('trail covers only the recent window and grows with speed at the same tick rate',()=>{
  const slow=trajectory([[0,0,0,0],[40,0,40,0]]),fast=trajectory([[0,0,0,0],[40,0,400,0]]);
  const length=trail=>trail.slice(1).reduce((sum,point,index)=>sum+Math.hypot(point.x-trail[index].x,point.y-trail[index].y),0);
  const slowTrail=replayTrajectoryTrail(slow,40,64),fastTrail=replayTrajectoryTrail(fast,40,64);
  assert.ok(length(fastTrail)>length(slowTrail)*5,'fixed time window makes a faster trail longer');
  assert.ok(slowTrail.length>=2&&fastTrail.length>=2);
  const long=trajectory([[0,0,0,0],[100,0,1000,0]]);
  const recent=replayTrajectoryTrail(long,100,64);
  assert.ok(recent[0].tick>=100-23-0.5,'tail is clipped to the recent flight window');
  assert.ok(recent.at(-1).tick<=100);
});

test('areas, bursts, blind and burn state are exact functions of the displayed tick',()=>{
  const smokePath=trajectory([[0,0,0,0],[10,0,100,0]]);
  const decoyPath=trajectory([[40,0,0,0],[50,0,100,0]]);
  const data=chunk([
    utility('smoke',10,100,smokePath),utility('fire',20,40),utility('flashbang',30,32),
    utility('hegrenade',40,104),utility('decoy',50,50,decoyPath),
  ]);
  const flying=replayEffectsAt(data,5,64);
  assert.deepEqual(flying.flying.map(item=>item.utility.kind),['smoke']);
  assert.equal(flying.flying[0].sample.y,50);
  assert.equal(flying.smoke.length,0,'a projectile is not yet an area before detonation');
  const at10=replayEffectsAt(data,10,64);
  assert.deepEqual(at10.smoke.map(item=>item.kind),['smoke']);assert.equal(at10.flying.length,0);
  const during=replayEffectsAt(data,31,64);
  assert.equal(during.smoke.length,1);assert.equal(during.fire.length,1);assert.equal(during.flashes.length,1);
  assert.ok(during.blinds.has('v')&&during.burns.has('b'));
  const middle=replayEffectsAt(data,50,64);
  assert.equal(middle.fire.length,0,'ended fire never lingers');assert.equal(middle.flashes.length,0,'flash burst is short');
  assert.equal(middle.explosions.length,1);assert.equal(middle.burns.size,0,'burn icon follows the real damaged window');
  assert.equal(replayEffectsAt(data,103,64).explosions.length,1);
  assert.equal(replayEffectsAt(data,105,64).explosions.length,0,'HE visual is exactly one second at 64 tick');
  assert.equal(replayEffectsAt(data,101,64).smoke.length,0);
  const decoyFlying=replayEffectsAt(data,45,64);
  assert.deepEqual(decoyFlying.flying.map(item=>item.utility.kind),['decoy']);
  assert.equal(replayEffectsAt(data,50,64).explosions.length,1,'the HE at tick 40 is still within its one-second window at 50');
  const decoyOnly=replayEffectsAt(chunk([utility('decoy',50,50,decoyPath)]),50,64);
  assert.equal(decoyOnly.smoke.length+decoyOnly.fire.length+decoyOnly.flashes.length+decoyOnly.explosions.length,0,'decoy has no persistent area');
});

test('the declared paint order keeps areas and trails below players and status above them',()=>{
  assert.deepEqual([...REPLAY_EFFECT_LAYER_ORDER],['map','areas','trajectories','projectiles','players','status','selection']);
});
