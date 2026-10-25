import assert from 'node:assert/strict';
import test from 'node:test';
import {buildServerInput, distance, variants, perturb} from './p8-1b-r-server.mjs';
const ids=Array.from({length:10},(_,i)=>String(76500000000000000n+BigInt(i)));
const params={roundNumber:1,cutTick:101};
function fixture(){
  const raw={id:'PRIVATE-HASH',header:{map_name:'de_dust2'},players:[{name:'PRIVATE-NAME'}],
    effectEvents:[{event_name:'smokegrenade_expired',tick:200}],
    stateRows:ids.map((steamid,i)=>({tick:20,steamid,team_num:i<5?3:2,is_alive:true})),
    events:[{event_name:'round_start',tick:10,total_rounds_played:0},{event_name:'round_freeze_end',tick:20,total_rounds_played:0},
      ...ids.filter((_,i)=>![4,9].includes(i)).map((user_steamid,i)=>({event_name:'player_death',tick:i===7?100:30+i,
        total_rounds_played:0,user_steamid,user_team_num:ids.indexOf(user_steamid)<5?3:2,
        attacker_steamid:ids[ids.indexOf(user_steamid)<5?9:4],attacker_team_num:ids.indexOf(user_steamid)<5?2:3,weapon:'ak47'})),
      {event_name:'round_end',tick:200,round:1,total_rounds_played:0,winner:'CT'}]};
  const rows=[4,9].map((i,j)=>({tick:100,steamid:ids[i],team_num:i<5?3:2,is_alive:true,
    X:j*3,Y:j*4,Z:0,health:80,yaw:0,pitch:0,active_weapon_name:'ak47'}));
  rows.push({...rows[1],tick:200});raw.stateRows.push({tick:200,steamid:ids[9],team_num:2,is_alive:false});
  return {raw,rows};
}
const build=({raw,rows},p=params)=>buildServerInput(raw,rows,p);
for(const variant of variants)test(`P ${variant}: complete nonempty output stable`,()=>{
  const f=fixture();assert.deepEqual(build(perturb(f.raw,f.rows,params,variant)),build(f));
});
test('L1 nonempty server facts, 1v1 atomic formation and distance, no knowledge claims',()=>{
  const {body,plan}=build(fixture());assert.equal(body.coverage.knownFields,12);assert.equal(plan.players.length,2);
  assert.equal(body.formation.after.CT,1);assert.equal(body.formation.after.T,1);assert.equal(body.distance.euclidean,5);
  assert.equal(body.capabilities.playerKnowledge,'UNSUPPORTED');assert.equal(body.formation.decisionOpportunity,'NOT ESTABLISHED');
});
test('positive control: historical enemy HP and XYZ change appropriate facts and distance',()=>{
  const f=fixture(),b=build(f);f.rows[1].health=42;f.rows[1].X=30;const a=build(f);
  assert.notDeepEqual(a.body,b.body);assert.equal(a.body.players[1].fields.health.value,42);assert.notDeepEqual(a.body.distance,b.body.distance);
});
test('positive control: historical death change affects selection, not just snapshots',()=>{
  const f=fixture();f.raw.events=f.raw.events.filter(e=>e.tick!==100);assert.equal(build(f).body.selection.eligible,false);
});
test('target tick excluded; older row never forward-filled',()=>{
  const f=fixture();f.rows[0].tick=101;f.rows.push({...f.rows[0],tick:99});
  const b=build(f).body;assert.equal(b.players[0].fields.position.status,'unknown');assert.deepEqual(b.sampling.missingPlayers,['CT']);
});
test('conflicting snapshot rows unknown; exact duplicates handled by idempotent canonicalization',()=>{
  const f=fixture();f.rows.push({...f.rows[0],health:42});assert.equal(build(f).body.players[0].fields.health.reason,'conflicting');
});
test('invalid health, position and view never become known; no zero substitution',()=>{
  for(const bad of [{X:NaN},{health:-1},{health:101},{yaw:181},{pitch:91}]) {
    const f=fixture();Object.assign(f.rows[0],bad);assert.equal(build(f).body.coverage.status,'partial');
  }
});
test('snapshot side/alive conflict is explicit and blocks distance',()=>{
  for(const bad of [{team_num:2},{is_alive:false}]) {const f=fixture();Object.assign(f.rows[0],bad);
    assert.equal(build(f).body.players[0].fields.alive.status,'unknown');assert.equal(build(f).body.distance.status,'unknown');}
});
test('missing baseline, invalid identity and conflicting baseline fail closed',()=>{
  for(const mode of ['missing','id','conflict']) {const f=fixture();
    if(mode==='missing')f.raw.stateRows=[];
    if(mode==='id')f.raw.stateRows[0].steamid='0';
    if(mode==='conflict')f.raw.stateRows.push({...f.raw.stateRows[0],is_alive:false});
    assert.equal(build(f).body.selection.eligible,false);
  }
});
test('unlocatable source tick rejected, including unclassifiable suffix',()=>{
  for(const key of ['events','stateRows']){const f=fixture();f.raw[key].push({tick:NaN});
    assert.equal(build(f).body.selection.reason,'unlocatable-source-tick');}
});
test('unidentified prefix death cannot silently disappear in converter',()=>{
  for(const user_steamid of [undefined,null,'0','invalid']) {
    const f=fixture();f.raw.events.push({event_name:'player_death',tick:99,total_rounds_played:0,user_steamid,user_team_num:3});
    assert.equal(build(f).body.selection.reason,'unidentified-prefix-death');
  }
});
test('same-tick reciprocal final deaths never manufacture intermediate 1v1',()=>{
  const f=fixture();for(const i of [4,9])f.raw.events.push({event_name:'player_death',tick:100,total_rounds_played:0,
    user_steamid:ids[i],user_team_num:i<5?3:2,attacker_steamid:ids[i===4?9:4],attacker_team_num:i<5?2:3});
  assert.equal(build(f).body.selection.eligible,false);
});
test('historical lifecycle and round end block formation; future variants already covered',()=>{
  for(const event_name of ['player_spawn','player_disconnect','player_team','round_end']) {
    const f=fixture();f.raw.events.push({event_name,tick:99,total_rounds_played:0,round:1,user_steamid:ids[9],user_team_num:2,winner:'T'});
    assert.equal(build(f).body.selection.eligible,false);
  }
});
test('conflicting same-victim deaths and baseline deaths rejected',()=>{
  for(const mode of ['duplicate','baseline']) {const f=fixture(),e=f.raw.events.find(e=>e.event_name==='player_death');
    if(mode==='duplicate')f.raw.events.push({...e,weapon:'different'});else e.tick=20;
    assert.equal(build(f).body.selection.eligible,false);
  }
});
test('model reference aliases and schema contain no raw identifiers, hash or roster',()=>{
  const b=build(fixture()).body,text=JSON.stringify(b);
  for(const s of [...ids,'PRIVATE-HASH','PRIVATE-NAME','game_time','winner'])assert.ok(!text.includes(s));
  assert.equal(b.schema,'p8-1b-r-server-facts-experiment-v1');assert.equal(b.evidenceRefs.length,3);
});
test('L2 numeric limits, 3D height, symmetry; no map floor or route conclusion',()=>{
  const a={x:0,y:0,z:0},b={x:3,y:4,z:12};assert.equal(distance(a,b).euclidean,13);
  assert.equal(distance(a,b).euclidean,distance(b,a).euclidean);assert.equal(distance(a,b).horizontal,5);
  for(const v of [null,{x:NaN,y:0,z:0},{x:Infinity,y:0,z:0}])assert.equal(distance(a,v).status,'unknown');
  assert.equal(distance({x:-Number.MAX_VALUE,y:0,z:0},{x:Number.MAX_VALUE,y:0,z:0}).status,'unknown');
});
test('invalid target rejected; no current-decision promise for nonformation anchor',()=>{
  for(const cutTick of [0,-1,NaN,Infinity])assert.throws(()=>build(fixture(),{...params,cutTick}));
  assert.equal(build(fixture(),{...params,cutTick:102}).body.selection.eligible,false);
});
