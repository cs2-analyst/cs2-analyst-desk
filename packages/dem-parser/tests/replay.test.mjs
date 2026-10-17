import assert from 'node:assert/strict';
import test from 'node:test';
import { planReplay, buildReplay } from '../dist/providers/replay.js';
const A='1',B='2';
const fixture = () => ({id:'fixture',map:'unknown',tickRate:64,players:[A,B].map(steamId=>({steamId,nickname:'',team:'Unknown'})),
  rounds:[{number:1,winner:null,startTick:0,freezeEndTick:8,endTick:64,events:[],playerLifecycle:[]}]});
const row=(tick,steamid=A,extra={})=>({tick,steamid,X:tick,Y:0,Z:0,yaw:0,health:100,is_alive:true,team_num:2,...extra});
const all = plan => plan.ticks.flatMap(t=>[row(t),row(t,B)]);
test('separate replay plan preserves exact formal events/lifecycle, rejects budget overflow and never guesses clock',()=>{
  const m=fixture();m.rounds[0].events=[{tick:13,type:'bomb',action:'pickup',player:A,playerSide:'T'},{tick:65,type:'bomb'}];m.rounds[0].playerLifecycle=[{tick:15,type:'spawn',player:A,side:'T'}];
  const p=planReplay(m);assert.ok(p.ticks.includes(13)&&p.ticks.includes(15)&&!p.ticks.includes(65));
  assert.throws(()=>planReplay(m,1),/budget/);assert.throws(()=>planReplay(m,60001));
  m.tickRate=undefined;const unknown=planReplay(m);assert.equal(unknown.step,null);assert.deepEqual(unknown.ticks,[0,8,13,15,64]);
  m.rounds[0].endTick=undefined;assert.deepEqual(planReplay(m).excludedRounds,[1]);assert.deepEqual(planReplay(m).ticks,[]);
});
test('missing rows/positions and actual ticks stay explicit and interrupt interpolation segments',()=>{
  const m=fixture(),p=planReplay(m),rows=all(p).filter(r=>!(r.tick===16&&r.steamid===A));
  rows.find(r=>r.tick===32&&r.steamid===A).X=null;
  const out=buildReplay(m,p,rows),samples=out.rounds[0].frames.map(f=>f.players[0]);
  assert.equal(samples[2].actualTick,null);assert.equal(samples[2].segment,null);assert.notEqual(samples[1].segment,samples[3].segment);
  assert.equal(samples[4].position,null);assert.equal(samples[4].segment,null);assert.equal(samples[0].position[0],0);
  assert.ok(out.rounds[0].coverage.missingPlayerSamples>=2);
  assert.throws(()=>buildReplay(m,p,[...rows,rows[0]]),/Duplicate/);
});
test('disconnect stays unknown until explicit spawn; death cannot resurrect from stale Pawn rows',()=>{
  const m=fixture();m.rounds[0].playerLifecycle=[{tick:16,type:'disconnect',player:A},{tick:32,type:'spawn',player:A,side:'T'}];
  m.rounds[0].events=[{type:'kill',tick:40,killer:B,victim:A}];
  const p=planReplay(m),out=buildReplay(m,p,all(p)),sample=t=>out.rounds[0].frames.find(f=>f.requestedTick===t).players[0];
  for(const t of [16,24]) {assert.equal(sample(t).alive,null);assert.equal(sample(t).position,null);assert.equal(sample(t).segment,null);}
  assert.equal(sample(32).alive,true);assert.notEqual(sample(8).segment,sample(32).segment);
  for(const t of [40,48,56]) {assert.equal(sample(t).alive,null);assert.equal(sample(t).stateAmbiguous,true);assert.equal(sample(t).segment,null);}
});
test('same-tick spawn/death/disconnect is ambiguous; round boundaries reset observations without joining segments',()=>{
  const m=fixture();m.rounds[0].playerLifecycle=[{tick:16,type:'spawn',player:A,side:'T'}];m.rounds[0].events=[{type:'kill',tick:16,killer:B,victim:A}];
  const p=planReplay(m),out=buildReplay(m,p,all(p)),s=out.rounds[0].frames.find(f=>f.requestedTick===16).players[0];
  assert.equal(s.stateAmbiguous,true);assert.equal(s.alive,null);assert.equal(s.health,null);assert.equal(s.segment,null);
  assert.equal(out.rounds[0].events[0].eventIndex,0);assert.equal(out.rounds[0].events[0].event.tick,16);
  const before=JSON.stringify(m);buildReplay(m,p,all(p));assert.equal(JSON.stringify(m),before);
});
test('two rounds retain disconnects across unsampled post-round gaps and only known spawn reconnects',()=>{
  const m=fixture();m.rounds[0].endTick=16;
  m.rounds[0].playerLifecycle=[{tick:20,type:'disconnect',player:A}];
  m.rounds.push({number:2,winner:null,startTick:32,endTick:64,events:[],playerLifecycle:[{tick:48,type:'spawn',player:A,side:'T'}]});
  const p=planReplay(m),out=buildReplay(m,p,all(p)),first=out.rounds[0].frames[0].players[0];
  const second=t=>out.rounds[1].frames.find(f=>f.requestedTick===t).players[0];
  assert.ok(!p.ticks.includes(20),'post-round lifecycle is consumed without sampling outside a formal window');
  for(const t of [32,40]){assert.equal(second(t).alive,null);assert.equal(second(t).position,null);assert.equal(second(t).segment,null);}
  assert.equal(second(48).alive,true);assert.notEqual(second(48).segment,first.segment);
  const b1=out.rounds[0].frames[0].players[1],b2=out.rounds[1].frames[0].players[1];assert.notEqual(b1.segment,b2.segment,'round boundary changes per-player segment identity');
  m.rounds[0].playerLifecycle[0].tick=8;const direct=buildReplay(m,planReplay(m),all(planReplay(m)));
  assert.equal(direct.rounds[1].frames[0].players[0].alive,null);
});
test('missing yaw is partial even when positions and discrete state remain valid',()=>{
  const m=fixture(),p=planReplay(m),rows=all(p);delete rows[0].yaw;
  const out=buildReplay(m,p,rows);assert.equal(out.rounds[0].coverage.status,'partial');assert.equal(out.rounds[0].frames[0].players[0].yaw,null);
});
test('player count and total requested player samples are bounded before native queries',()=>{
  const m=fixture();m.players=Array.from({length:65},(_,i)=>({steamId:String(i+1),nickname:'',team:'Unknown'}));
  assert.throws(()=>planReplay(m),/player budget/);m.players.pop();m.rounds[0].endTick=100000;
  assert.throws(()=>planReplay(m),/sample budget/);m.players=[];assert.throws(()=>planReplay(m),/player budget/);
});
test('utility effects use real projectile runs and real expiry/blind/burn windows',()=>{
  const m=fixture();m.rounds[0].endTick=400;
  m.rounds[0].events=[
    {tick:10,type:'weapon_fire',shooter:A,shooterSide:'T',weapon:'weapon_smokegrenade'},
    {tick:60,type:'utility',utility:'smoke',action:'detonate',thrower:A,throwerSide:'T',entityId:7,position:{x:100,y:0,z:0}},
    {tick:100,type:'weapon_fire',shooter:A,shooterSide:'T',weapon:'weapon_molotov'},
    {tick:140,type:'utility',utility:'fire',action:'start_burn',thrower:A,throwerSide:'T',entityId:9,position:{x:200,y:0,z:0}},
    {tick:150,type:'weapon_fire',shooter:A,shooterSide:'T',weapon:'weapon_flashbang'},
    {tick:160,type:'utility',utility:'flashbang',action:'detonate',thrower:A,throwerSide:'T',entityId:15,position:{x:300,y:0,z:0}},
    {tick:160,type:'flash',attacker:A,victim:B,attackerSide:'T',victimSide:'CT',blindDurationSeconds:2,entityId:15},
    {tick:200,type:'damage',attacker:A,victim:B,attackerSide:'T',victimSide:'CT',healthDamage:5,armorDamage:0,healthRemaining:95,armorRemaining:0,weapon:'inferno'},
    {tick:213,type:'damage',attacker:A,victim:B,attackerSide:'T',victimSide:'CT',healthDamage:3,armorDamage:0,healthRemaining:92,armorRemaining:0,weapon:'inferno'},
    {tick:295,type:'weapon_fire',shooter:A,shooterSide:'T',weapon:'weapon_smokegrenade'},
    {tick:300,type:'utility',utility:'hegrenade',action:'detonate',thrower:A,throwerSide:'T',entityId:11,position:{x:400,y:0,z:0}},
    {tick:310,type:'utility',utility:'smoke',action:'detonate',thrower:A,throwerSide:'T',entityId:7,position:{x:500,y:0,z:0}},
    {tick:350,type:'utility',utility:'decoy',action:'start_decoy',thrower:A,throwerSide:'T',entityId:13,position:{x:600,y:0,z:0}},
    {tick:380,type:'utility',utility:'smoke',action:'detonate',thrower:A,throwerSide:'T',entityId:999,position:{x:700,y:0,z:0}},
  ];
  const p=planReplay(m);
  const projectile=(tick,id,type)=>({tick,grenade_entity_id:id,grenade_type:type,steamid:A,name:'',x:tick,y:0,z:tick});
  const projectiles=[];
  for(let tick=20;tick<=70;tick++)projectiles.push(projectile(tick,7,'CSmokeGrenadeProjectile'));
  for(let tick=110;tick<=139;tick++)projectiles.push(projectile(tick,99,'CMolotovProjectile'));
  for(let tick=150;tick<=159;tick++)projectiles.push(projectile(tick,15,'CFlashbangProjectile'));
  for(let tick=290;tick<=299;tick++)projectiles.push(projectile(tick,11,'CHEGrenadeProjectile'));
  for(let tick=300;tick<=309;tick++)projectiles.push(projectile(tick,7,'CSmokeGrenadeProjectile'));
  for(let tick=330;tick<=349;tick++)projectiles.push(projectile(tick,13,'CDecoyProjectile'));
  const out=buildReplay(m,p,all(p),{projectiles,expiries:[
    {event_name:'smokegrenade_expired',tick:250,entityid:7},
    {event_name:'smokegrenade_expired',tick:350,entityid:7},
    {event_name:'inferno_expire',tick:210,entityid:9},
  ]});
  const effects=out.rounds[0].utilities,at=tick=>effects.find(effect=>effect.tick===tick);
  assert.equal(effects.length,7);
  const smoke=at(60);assert.equal(smoke.flight.startTick,10);assert.equal(smoke.flight.endTick,60);
  assert.ok(!smoke.flight.points.some(point=>point[0]>60),'post-detonation projectile rows never join the flight');
  assert.deepEqual(smoke.flight.points[0],[10,10,0,0]);
  assert.equal(smoke.endTick,250);assert.equal(smoke.endSource,'observed');
  const fire=at(140);assert.equal(fire.variant,'molotov');assert.equal(fire.flight.startTick,100);
  assert.equal(fire.flight.endTick,140);assert.equal(fire.endTick,210);assert.equal(fire.endSource,'observed');
  const flash=at(160);assert.equal(flash.flight.startTick,150);assert.equal(flash.endTick,192);assert.equal(flash.endSource,'nominal');
  const he=at(300);assert.equal(he.flight.startTick,290);assert.equal(he.endTick,364);assert.equal(he.endSource,'nominal');
  const secondSmoke=at(310);assert.equal(secondSmoke.flight.startTick,295,'reused entity ids resolve to the nearest run');
  const decoy=at(350);assert.equal(decoy.endTick,350);assert.equal(decoy.endSource,'observed');
  const unmatched=at(380);assert.equal(unmatched.flight,null,'no run is fabricated');assert.equal(unmatched.endSource,'round-end');
  assert.deepEqual(out.rounds[0].blinds,[{victimId:B,attackerId:A,startTick:160,endTick:288}]);
  assert.deepEqual(out.rounds[0].burns,[{victimId:B,startTick:200,endTick:226}]);
});
