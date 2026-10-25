import assert from 'node:assert/strict';
import test from 'node:test';
import {buildInput,resolvePrefix,prefixMatch,fixedPlan} from './p8-1b-prefix.mjs';
import {planSpatialSampling} from '../../packages/dem-parser/dist/providers/spatial-evidence.js';

const ids=Array.from({length:10},(_,i)=>String(76500000000000000n+BigInt(i)));
const observer=ids[4],enemy=ids[9],params={roundNumber:1,cutTick:101,observer};
function fixture(){
  const stateRows=ids.map((steamid,i)=>({tick:20,steamid,team_num:i<5?3:2,is_alive:true}));
  const events=[{event_name:'round_start',tick:10,total_rounds_played:0},
    {event_name:'round_freeze_end',tick:20,total_rounds_played:0},
    ...ids.filter(s=>s!==observer&&s!==enemy).map((user_steamid,i)=>({event_name:'player_death',tick:i===7?100:30+i,
      total_rounds_played:0,user_steamid,user_team_num:ids.indexOf(user_steamid)<5?3:2,
      attacker_steamid:ids.indexOf(user_steamid)<5?enemy:observer,attacker_team_num:ids.indexOf(user_steamid)<5?2:3,weapon:'ak47'})),
    {event_name:'round_end',tick:200,round:1,total_rounds_played:0,winner:'CT'}];
  const raw={id:'synthetic-only',header:{map_name:'de_dust2'},players:[],events,stateRows};
  const rows=[{tick:100,steamid:observer,X:1,Y:2,Z:3,yaw:40,pitch:0,health:80,is_alive:true,team_num:3},
    {tick:100,steamid:enemy,X:999,Y:999,Z:3,yaw:0,pitch:0,health:99,is_alive:true,team_num:2}];
  return {raw,rows};
}
const state=raw=>resolvePrefix(prefixMatch(raw,101).rounds[0],101);

test('B01 real-shaped prefix resolves 1v1; server own fact does not invent availableTick',()=>{
  const {raw,rows}=fixture(),result=buildInput(raw,rows,params);
  assert.deepEqual(state(raw).survivors.map(p=>p.id),[observer,enemy]);
  assert.equal(result.local.auditedSelf.health.value,80);
  assert.equal(result.local.auditedSelf.health.availableTick,null);
  assert.equal(result.model.self.health.reason,'player-availability-time-unverified');
  assert.ok(Object.values(result.model.capabilities).every(v=>['unknown','abstain'].includes(v)));
});
test('B02 unknown observer channel is not cured by forged labels',()=>{
  const {raw,rows}=fixture();Object.assign(rows[0],{availableTick:100,audience:'self',verified:true});
  assert.equal(buildInput(raw,rows,params).model.self.health.status,'unknown');
});
test('B03 exact own selection does not admit enemy row claiming self',()=>{
  const {raw,rows}=fixture();rows[1].audience='self';rows[1].sourceChannel='self-entity-state';
  assert.deepEqual(buildInput(raw,rows,params).local.auditedSelf.position.value,{x:1,y:2,z:3});
});
test('B04 positive control: own historical values affect nonempty audit evidence',()=>{
  const {raw,rows}=fixture(),before=buildInput(raw,rows,params);rows[0].health=42;
  assert.notDeepEqual(buildInput(raw,rows,params).local.auditedSelf,before.local.auditedSelf);
});
test('B05 cut tick rows are excluded; no nearest-tick or old-state fallback',()=>{
  const {raw,rows}=fixture();rows[0].tick=101;rows.push({...rows[0],tick:99});
  const result=buildInput(raw,rows,params);
  assert.equal(result.model.self.health.reason,'unavailable');assert.equal(result.model.sampling.missing,true);
});
test('B06 duplicate own rows fail closed, even if identical',()=>{
  const {raw,rows}=fixture();rows.push({...rows[0]});
  assert.equal(buildInput(raw,rows,params).model.self.health.reason,'conflicting');
});
test('B07 invalid own values never become observations',()=>{
  const {raw,rows}=fixture();Object.assign(rows[0],{X:NaN,health:-1,yaw:181});
  const {local}=buildInput(raw,rows,params);
  for(const key of ['position','health','view'])assert.equal(local.auditedSelf[key].status,'unknown');
});
test('B08 hidden enemy roster/lifecycle cannot change own missingness or model metadata',()=>{
  const {raw,rows}=fixture(),before=buildInput(raw,rows,params);
  raw.stateRows.find(r=>r.steamid===enemy).is_alive=null;
  raw.events.push({event_name:'player_disconnect',tick:90,total_rounds_played:0,user_steamid:enemy});
  const after=buildInput(raw,rows,params);
  assert.equal(after.local.prefixState.status,'unknown');
  assert.deepEqual(after.model,before.model);assert.deepEqual(after.local.auditedSelf,before.local.auditedSelf);
});
test('B09 suffix results, clock, roster and restarted round do not rewrite prefix',()=>{
  const {raw,rows}=fixture(),before=buildInput(raw,rows,params);
  raw.events.at(-1).winner='T';raw.events.at(-1).game_time=-999;
  raw.events.push({event_name:'round_start',tick:120,round:1,total_rounds_played:0});
  raw.players.push({steamid:'111',name:'future private nickname'});
  assert.deepEqual(buildInput(raw,rows,params),before);
});
test('B10 same tick atomic deaths are unordered; no artificial intermediate 1v1',()=>{
  const {raw}=fixture();raw.events.find(e=>e.event_name==='player_death').tick=100;
  raw.events.push({event_name:'player_death',tick:100,total_rounds_played:0,user_steamid:observer,user_team_num:3,
    attacker_steamid:enemy,attacker_team_num:2});
  const before=state(raw);assert.equal(before.groups.at(-1).after.CT,0);
  raw.events.reverse();assert.deepEqual(state(raw),before);
});
test('B11 death at cut is future and cannot change prefix survivors',()=>{
  const {raw}=fixture(),before=state(raw);
  raw.events.push({event_name:'player_death',tick:101,total_rounds_played:0,user_steamid:observer,user_team_num:3});
  assert.deepEqual(state(raw),before);
});
test('B12 missing freeze and incomplete 5v5 baseline reject candidates',()=>{
  const {raw}=fixture();raw.stateRows.pop();assert.equal(state(raw).status,'unknown');
  raw.stateRows=[];assert.equal(state(raw).reason,'baseline-missing');
});
test('B13 unidentified baseline rejects candidates',()=>{
  const {raw}=fixture();raw.stateRows[0].steamid='0';assert.equal(state(raw).reason,'unidentified');
});
test('B14 duplicate victim death and side conflict reject candidates',()=>{
  const {raw}=fixture();const death=raw.events.find(e=>e.event_name==='player_death');
  raw.events.push({...death});assert.equal(state(raw).reason,'invalid-or-duplicate-death');
  raw.events.pop();death.user_team_num=2;assert.equal(state(raw).reason,'death-side-conflict');
});
test('B15 baseline/same-tick/prefix lifecycle ambiguity rejects; future lifecycle does not',()=>{
  for(const tick of [20,90,101]){
    const {raw}=fixture();raw.events.push({event_name:'player_spawn',tick,total_rounds_played:0,user_steamid:enemy,user_team_num:2});
    assert.equal(state(raw).status,tick<101?'unknown':'known');
  }
});
test('B16 ended or inverted round cannot become candidate',()=>{
  const {raw}=fixture();raw.events.at(-1).tick=100;assert.equal(state(raw).reason,'round-ended');
  const r=prefixMatch(fixture().raw,101).rounds[0];r.freezeEndTick=9;
  assert.equal(resolvePrefix(r,101).reason,'round-boundary');
});
test('B17 world attribution does not invent an identity or invalidate a known victim',()=>{
  const {raw}=fixture();delete raw.events.find(e=>e.event_name==='player_death').attacker_steamid;
  assert.equal(state(raw).status,'known');
});
test('B18 full roster, source hash, nickname, outcome and refs stay outside model',()=>{
  const {raw,rows}=fixture();raw.id='SECRET_HASH';raw.players=[{steamid:observer,name:'SECRET_NAME'}];
  const body=JSON.stringify(buildInput(raw,rows,params).model);
  for(const value of [...ids,'SECRET_HASH','SECRET_NAME','winner','eventIndex','deathTick'])assert.ok(!body.includes(value));
});
test('B19 fixed previous-tick sampler rejects invalid cuts',()=>{
  for(const cut of [0,-1,NaN,Infinity,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>fixedPlan(cut));
  assert.deepEqual(fixedPlan(101).requestedTicks,[100]);
});
test('B20 unlocatable event/state ticks fail local prefix audit, never silently imply complete',()=>{
  for(const target of ['events','stateRows'])for(const tick of [undefined,NaN,-1]){
    const {raw,rows}=fixture();raw[target][0].tick=tick;
    assert.throws(()=>prefixMatch(raw,101),/unlocatable/);
    assert.equal(buildInput(raw,rows,params).local.prefixState.status,'unknown');
  }
});
test('L01 existing offline sampler loses historical optional sample after one future event',()=>{
  const match={id:'synthetic-only',map:'de_dust2',tickRate:64,players:[],rounds:[{number:1,winner:null,
    startTick:10,freezeEndTick:20,endTick:400,events:[{type:'kill',tick:100,killer:observer,victim:enemy}]}]};
  const before=planSpatialSampling(match,{tickBudget:5});
  match.rounds[0].events.push({type:'weapon_fire',tick:300,shooter:observer,weapon:'ak47'});
  const after=planSpatialSampling(match,{tickBudget:5});
  assert.deepEqual(before.optionalTicks,[92]);assert.deepEqual(after.optionalTicks,[]);
  assert.ok(after.omittedOptionalTicks.includes(92));
});
