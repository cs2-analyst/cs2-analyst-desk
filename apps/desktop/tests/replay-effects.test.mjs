import assert from 'node:assert/strict';
import test from 'node:test';
import { paintReplayArea, paintReplayHEBurst, replayHEProgress, replayFireFrame, replayHEFragments, replayTrailSeconds, REPLAY_EFFECT_LAYER_ORDER, replayEffectsAt, replayTrajectorySample, replayTrajectoryTrail } from '../renderer/src/replay-effects.ts';

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
  assert.ok(length(fastTrail)>length(slowTrail)*10,'bounded speed window reinforces the distance difference');
  assert.ok(slowTrail.length>=2&&fastTrail.length>=2);
  const long=trajectory([[0,0,0,0],[100,0,1000,0]]);
  const recent=replayTrajectoryTrail(long,100,64);
  assert.ok(recent[0].tick>=100-70,'tail never exceeds the bounded 1.10s window');
  assert.ok(recent.at(-1).tick<=100);
});

test('speed window is bounded and trails retain every bounce, level barrier and missing span',()=>{
  assert.equal(replayTrailSeconds(0,64),.30);
  assert.equal(replayTrailSeconds(2000,64),1.10);
  assert.equal(replayTrailSeconds(2000,null),.34);
  assert.ok(replayTrailSeconds(700,64)>replayTrailSeconds(300,64));
  const path=trajectory([[0,0,0,0],[4,100,0,0],[8,0,0,0],[12,0,100,0],[16,0,0,0],[20,0,0,1000]]);
  const trail=replayTrajectoryTrail(path,20,64);
  assert.deepEqual(trail.map(p=>[p.tick,p.x,p.y,p.z]),path.points,'folds/bounces/floor changes are not skipped by uniform resampling');
  assert.equal(replayTrajectoryTrail(path,-1,64).length,0);
  const gap=trajectory([[0,0,0,0],[4,20,0,0],[30,100,0,0],[34,110,0,0]]);
  assert.ok(replayTrajectoryTrail(gap,34,64,.78).find(p=>p.tick===30).breakBefore);
  assert.ok(replayTrajectoryTrail(gap,29,64,.78).at(-1).breakBefore,'partial missing span cannot be bridged either');
  const fast=trajectory(Array.from({length:33},(_,i)=>[i*4,i*70,0,0]));
  const length=points=>points.at(-1).x-points[0].x;
  assert.ok(length(replayTrajectoryTrail(fast,128,64))>length(replayTrajectoryTrail(fast,128,64,.34))*2);
});

// Recording paint operations proves determinism independent of Chromium GPU/CPU raster
// antialiasing, while the real Electron script separately verifies loaded Canvas pixels.
const paintTrace=(kind,tick,rate=64,eventIndex=1)=>{
  const trace=[],ctx=new Proxy({}, {get:(_,key)=>(...args)=>{
    trace.push([key,...args]);
    if(key==='createRadialGradient'||key==='createLinearGradient')return {addColorStop:(...stops)=>trace.push(['stop',...stops])};
  },set:(_,key,value)=>{trace.push([key,typeof value==='object'?'gradient':value]);return true;}});
  paintReplayArea(ctx,{...utility(kind,100,1500),eventIndex},tick,rate,0,0,40,'decoded-atlas');
  return trace;
};
test('smoke/fire paint has reproducible local deformation, stable plateau alpha and real lifecycle limits',()=>{
  for(const kind of ['smoke','fire']){
    const first=paintTrace(kind,300),later=paintTrace(kind,311);
    assert.deepEqual(paintTrace(kind,300),first,'seek/backward/pause has no accumulated particle state');
    assert.deepEqual(paintTrace(kind,500,128),first,'the same elapsed Replay seconds produce the same local motion at another tick rate');
    assert.notDeepEqual(first,later,'local shapes evolve with Replay time');
    assert.notDeepEqual(first,paintTrace(kind,300,64,2),'distinct effects have stable independent phases');
    assert.deepEqual(first.filter(c=>c[0]==='globalAlpha'),later.filter(c=>c[0]==='globalAlpha'),'no global brightness oscillation');
    assert.deepEqual(paintTrace(kind,99),[]);assert.deepEqual(paintTrace(kind,1501),[]);
    assert.ok(paintTrace(kind,110).find(c=>c[0]==='globalAlpha')[1]<1,'original .35s fade in');
    assert.ok(paintTrace(kind,1490).find(c=>c[0]==='globalAlpha')[1]<1,'original 1.4s fade out');
    assert.equal(first.filter(c=>c[0]==='save').length,first.filter(c=>c[0]==='restore').length,'Canvas stack is balanced');
    assert.ok(paintTrace(kind,300,null).length>0,'unknown rate retains visual fallback');
  }
  assert.equal(paintTrace('smoke',300).filter(c=>c[0]==='createRadialGradient').length,9);
  const fire=paintTrace('fire',300);
  assert.equal(fire.filter(c=>c[0]==='drawImage').length,3,'exactly three sprite instances');
  assert.equal(fire.filter(c=>c[0]==='createLinearGradient').length,0,'no procedural flame replacement');
  assert.equal(fire.filter(c=>c[0]==='createRadialGradient'||c[0]==='arc').length,0,'flame bodies never revert to circular hotspots');
});

test('sprite phases and HE fragments are bounded pure functions, including reverse seek and expiration',()=>{
  const fire=utility('fire',100,1500),he=utility('hegrenade',100,164);
  const frames=seconds=>[0,1,2].map(i=>replayFireFrame(fire,seconds,i));
  assert.ok(new Set(frames(0)).size>1,'instances start out of phase');
  assert.notDeepEqual(frames(0),frames(.12));assert.deepEqual(frames(0),frames(1),'12 steps at 12fps loop exactly');
  for(let s=0;s<100;s+=.13)assert.ok(frames(s).every(f=>f>=0&&f<7));
  const initial=replayHEFragments(he,0),middle=replayHEFragments(he,.3),late=replayHEFragments(he,.9);
  assert.equal(middle.length,9);assert.deepEqual(replayHEFragments(he,.3),middle);
  assert.ok(initial.every(s=>s.x===0&&s.y===0));
  assert.ok(middle.every(s=>Math.hypot(s.x,s.y)<=1.2));
  assert.ok(late.every((s,i)=>s.alpha<middle[i].alpha));
  for(const p of [-1,1,2,NaN])assert.deepEqual(replayHEFragments(he,p),[]);
  assert.deepEqual(replayHEFragments(fire,.3),[]);
  assert.notDeepEqual(replayHEFragments({...he,eventIndex:2},.3),middle);
});

test('HE compresses its complete visual lifecycle into half a second without changing native endTick',()=>{
  const he=utility('hegrenade',100,164),original=structuredClone(he);
  assert.equal(replayHEProgress(he,99,64),null);assert.equal(replayHEProgress(he,100,64),0);
  assert.equal(replayHEProgress(he,116,64),.5);assert.equal(replayHEProgress(he,132,64),null);
  assert.equal(replayHEProgress(he,163,64),null);assert.equal(replayHEProgress(he,116,128),.25);
  assert.equal(replayHEProgress(he,116,null),.5);assert.deepEqual(he,original);
  assert.equal(replayEffectsAt(chunk([he]),131.9,64).explosions.length,1);
  assert.equal(replayEffectsAt(chunk([he]),132,64).explosions.length,0);
  const trace=p=>{
    const calls=[],ctx=new Proxy({}, {get:(_,key)=>(...args)=>{calls.push([key,...args]);if(key==='createRadialGradient')return {addColorStop:(...s)=>calls.push(['stop',...s])};},set:(_,key,v)=>{calls.push([key,typeof v==='object'?'gradient':v]);return true;}});
    paintReplayHEBurst(ctx,he,p,0,0,.25);return calls;
  };
  assert.deepEqual(trace(.25),trace(.25));assert.notDeepEqual(trace(.25),trace(.5));
  assert.deepEqual(trace(1),[]);assert.ok(trace(0).some(c=>c[0]==='createRadialGradient'));
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
  assert.equal(replayEffectsAt(data,71,64).explosions.length,1);
  assert.equal(replayEffectsAt(data,72,64).explosions.length,0,'HE visual is exactly half a second at 64 tick');
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

test('missing optional evidence keeps old chunks usable without inventing flight or effects',()=>{
  for(const absent of [null,undefined,{}]){
    const frame=replayEffectsAt(absent,50,null);
    assert.equal(frame.flying.length+frame.smoke.length+frame.fire.length+frame.flashes.length+frame.explosions.length,0);
  }
  const smoke=utility('smoke',10,100,null);
  assert.equal(replayEffectsAt(chunk([smoke]),5,64).flying.length,0);
  assert.equal(replayEffectsAt(chunk([smoke]),50,null).smoke.length,1,'effect-only fallback does not invent a flight or clock');
  assert.equal(replayEffectsAt(chunk([smoke]),101,64).smoke.length,0);
});
