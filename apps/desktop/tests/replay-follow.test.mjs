import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveReplayFollow } from '../renderer/src/replay-follow.ts';
import { replayFloorAt } from '../renderer/src/replay-floor.ts';
import { replayMapDefinitions } from '../shared/replay-map-geometry.ts';

const ids = ['a','b','c','d'];
const death = (tick,victimId,killerId,alivePlayerIds,id=`death-${tick}-${victimId}`) => ({id,tick,victimId,killerId,alivePlayerIds});
const state = (tick,alivePlayerIds,deadPlayerIds=[]) => ({tick,alivePlayerIds,deadPlayerIds});
const chunk = (deaths,states=[state(0,ids)],backgrounds=[]) => ({matchId:'m',round:2,follow:{deaths,states,backgrounds}});
const resolve = (c,tick,anchor='a') => resolveReplayFollow(c,anchor,tick,ids);

test('normal death follows the actual living killer only when the exact event is reached',()=>{
  const c=chunk([death(10,'a','c',['b','c','d'])]);
  assert.equal(resolve(c,9.999).playerId,'a');
  assert.equal(resolve(c,10).playerId,'c');
  assert.equal(resolve(c,10).cause,'kill');
  assert.equal(resolve(c,10).deathId,'death-10-a');
});

test('self-kill choice is stable across repeated/reverse seeks, playback ticks, cold chunks and roster order',()=>{
  const c=chunk([death(10,'a','a',['d','b','c'])]);
  const saved=structuredClone(c),expected=resolve(c,10).playerId;
  assert.ok(['b','c','d'].includes(expected));assert.equal(resolve(c,10).cause,'suicide');
  for(const tick of [10,11,100,9,10,10,50,10.5]){
    assert.equal(resolve(c,tick).playerId,tick<10?'a':expected);
    assert.deepEqual(resolve({...c,block:19},tick),resolve(c,tick));
  }
  const reversed=structuredClone(c);reversed.follow.deaths[0].alivePlayerIds.reverse();
  assert.equal(resolve(reversed,10).playerId,expected);
  assert.equal(resolveReplayFollow(c,'a',10,[...ids].reverse()).playerId,expected);
  assert.deepEqual(c,saved,'no source mutation or retained mutable random state');
});

test('unknown attacker remains unknown; it never becomes a self-kill or a roster guess',()=>{
  const c=chunk([death(10,'a',null,['b','c'])]);
  assert.equal(resolve(c,10).cause,'unknown');
  assert.ok(['b','c'].includes(resolve(c,10).playerId));
  assert.equal(resolve(chunk([death(10,'a','absent',['b'])]),10).playerId,'b');
});

test('posthumous grenade and simultaneous deaths cannot hand off to a dead attacker',()=>{
  const c=chunk([death(5,'c','b',['a','b','d']),death(10,'a','c',['b','d'])]);
  assert.ok(['b','d'].includes(resolve(c,10).playerId));
  const simultaneous=chunk([death(10,'a','c',['b']),death(10,'c','a',['b'])]);
  assert.equal(resolve(simultaneous,10).playerId,'b');
  assert.equal(resolve(simultaneous,10,'c').playerId,'b');
});

test('death chains reconstruct from explicit anchor and never depend on a prior auto result',()=>{
  const c=chunk([death(10,'a','b',['b','c','d']),death(20,'b','c',['c','d']),death(30,'c','d',['d'])]);
  for(const [tick,expected] of [[0,'a'],[10,'b'],[20,'c'],[30,'d'],[15,'b'],[9,'a'],[20,'c']]){
    assert.equal(resolve(c,tick).playerId,expected);
  }
  assert.equal(resolve(c,15,'d').playerId,'d','manual living choice becomes the new anchor');
  assert.equal(resolve(chunk([]),100).playerId,'a','next round starts from the explicit anchor');
});

test('all-dead C4, delayed HE, self-kill and unknown final deaths retain only observed background IDs',()=>{
  const map=replayMapDefinitions.find(m=>m.id==='de_nuke');
  for(const killer of ['a','b',null]){
    const c=chunk([death(10,'a',killer,[])],[state(0,['a'],['b','c','d']),state(10,[],ids)],
      [{tick:2,playerId:'a',layerId:'lower'},{tick:30,playerId:'a',layerId:'default'}]);
    const before=structuredClone(c),decision=resolve(c,10);
    assert.equal(decision.playerId,'a');assert.equal(decision.allDead,true);assert.equal(decision.backgroundLayer,'lower');
    const floor=replayFloorAt(null,{sessionId:'s',matchId:'m',round:2,playerId:'a',seekRevision:2,
      mode:'auto',tick:10,map,selected:undefined,allDeadBackground:decision.backgroundLayer});
    assert.equal(floor.status,'retained');assert.equal(floor.layerId,'lower');
    assert.deepEqual(c,before,'no fake coordinates or player observations');
    assert.deepEqual(resolve(c,10),decision);assert.equal(resolve(c,5).allDead,false);
  }
});

test('missing and ambiguous rows are not proof of all-dead, and no evidence never invents a background',()=>{
  const c=chunk([death(10,'a',null,[])],[state(10,[],['a'])],[{tick:1,playerId:'a',layerId:'lower'}]);
  assert.equal(resolve(c,10).allDead,false);assert.equal(resolve(c,10).backgroundLayer,null);
  assert.equal(resolve(chunk([death(10,'a',null,[])],[state(10,[],ids)]),10).backgroundLayer,null);
  assert.equal(resolve({matchId:'m',round:2},10).playerId,'a');
});

test('all-dead Seek preserves the last reliable floor along the followed chain when its final target has no position',()=>{
  const c=chunk([death(10,'a','b',['b']),death(20,'b',null,[])],
    [state(0,['a','b'],['c','d']),state(10,['b'],['a','c','d']),state(20,[],ids)],
    [{tick:2,playerId:'a',layerId:'lower'},{tick:30,playerId:'b',layerId:'default'}]);
  assert.equal(resolve(c,10).playerId,'b');
  assert.equal(resolve(c,20).backgroundLayer,'lower');
  assert.deepEqual(resolve({...c,block:5},20),resolve(c,20));
  assert.equal(resolve(c,19).allDead,false);
});

test('a missing death-tick roster waits for the first confirmed live set and keeps that choice on later seeks',()=>{
  const c=chunk([death(10,'a',null,[])],
    [state(0,ids),state(10,[],['a']),state(11,['b','c'],['a']),state(12,['b','c','d'],['a']),state(20,['d'],['a','b','c'])]);
  const first=resolve(c,11).playerId;
  assert.ok(['b','c'].includes(first));assert.equal(resolve(c,10).playerId,'a');
  assert.equal(resolve(c,12).playerId,first);assert.equal(resolve(c,11).playerId,first);
  assert.equal(resolve(c,20).playerId,'d','observed death without a kill falls back with unknown attribution');
  assert.equal(resolve(c,20).cause,'unknown');
});

test('authoritative corpses cannot confirm a new floor from stale native true rows',()=>{
  const map=replayMapDefinitions.find(m=>m.id==='de_nuke');
  const c=chunk([],[state(0,['a'],['b','c','d']),state(10,[],ids)],[{tick:0,playerId:'a',layerId:'lower'}]);
  const decision=resolve(c,20),stale=[0,20,0,0,-400,0,100,true,'T',1,false];
  assert.equal(decision.allDead,true);assert.deepEqual(decision.deadPlayerIds,ids);
  const selected=decision.deadPlayerIds.includes(decision.playerId)?undefined:stale;
  const floor=replayFloorAt(null,{sessionId:'s',matchId:'m',round:2,playerId:'a',seekRevision:5,
    mode:'auto',tick:20,map,selected,allDeadBackground:decision.backgroundLayer});
  assert.equal(floor.status,'retained');assert.equal(floor.layerId,'lower');
  assert.deepEqual([stale].filter(p=>!decision.deadPlayerIds.includes(ids[p[0]])),[],'no dead player marker is eligible');
  assert.equal(stale[7],true,'source observation stays unmodified');
});
