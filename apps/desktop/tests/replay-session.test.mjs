import assert from 'node:assert/strict';
import test from 'node:test';
import { ReplaySession } from '../electron/replay-session.ts';
import { appendReplayEvents, replayBlockAt } from '../renderer/src/replay-state.ts';
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
  assert.equal(text('r1-e0'),'ropz 的 烟雾弹 爆开');
  assert.equal(text('r1-e1'),'ropz 的 燃烧弹 开始燃烧');
  assert.equal(text('r1-e2'),'未知玩家 的 闪光弹 爆开');
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

test('effect action labels preserve boundary ticks, same-tick order, seek visibility and chunk identity',()=>{
  const {match,replay}=make(),round=replay.rounds[0];
  const utility=(eventIndex,tick,kind,action)=>({eventIndex,event:{type:'utility',tick,utility:kind,action,thrower:'1',throwerSide:'T'}});
  round.events=[
    {eventIndex:0,event:{type:'weapon_fire',tick:140,shooter:'1',shooterSide:'T',weapon:'weapon_smokegrenade'}},
    utility(1,159,'smoke','detonate'),
    utility(2,160,'hegrenade','detonate'),
    utility(3,160,'decoy','start_decoy'),
    utility(4,161,'fire','start_burn'),
  ];
  round.utilities=[{eventIndex:1,kind:'smoke',variant:null,throwerId:'1',entityId:7,tick:159,endTick:300,endSource:'observed',position:null,
    flight:{startTick:140,endTick:159,points:[[140,0,0,0],[159,10,20,0]]}}];
  const original=structuredClone(round),session=new ReplaySession(match,replay,'session');
  assert.deepEqual(round,original,'presentation does not mutate business events or effect evidence');
  const info=session.metadata.rounds[0],get=block=>session.get({sessionId:'session',round:1,block});
  const first=get(0),second=get(1),seen=new Set();
  assert.deepEqual(first.events.map(e=>[e.id,e.tick]),[['r1-e0',140],['r1-e1',159]]);
  assert.deepEqual(second.events.map(e=>[e.id,e.tick]),[['r1-e2',160],['r1-e3',160],['r1-e4',161]]);
  assert.deepEqual(second.events.map(e=>e.description),['p 的 手雷 爆开','p 的 诱饵弹 开始生效','p 的 火焰 开始燃烧']);
  assert.equal(first.utilities[0].tick,159);assert.equal(first.utilities[0].trajectory.startTick,140);
  assert.deepEqual(second.utilities[0],first.utilities[0],'the same long effect spans the boundary without moving its event');
  assert.deepEqual(appendReplayEvents([],new Set(),first.events,158).events.map(e=>e.id),['r1-e0'],'only the observed release appears before the effect');
  const at159=appendReplayEvents([],seen,first.events,159);
  assert.deepEqual(at159.events.map(e=>e.id),['r1-e0','r1-e1']);
  const at160=appendReplayEvents(at159.events,seen,second.events,160);
  assert.deepEqual(at160.events.map(e=>e.id),['r1-e0','r1-e1','r1-e2','r1-e3'],'same-tick source order remains intact');
  assert.equal(appendReplayEvents(at160.events,seen,second.events,160).appended,0,'chunk reload does not duplicate same-tick entries');
  for(const event of second.events)assert.equal(replayBlockAt(info,event.tick).index,1,'event click keeps the observed effect seek tick');
  assert.equal(replayBlockAt(info,159.99).index,0);assert.equal(replayBlockAt(info,160).index,1);
  assert.deepEqual(appendReplayEvents([],new Set(),get(0).events,158).events.map(e=>e.id),['r1-e0'],'backward seek reconstruction contains no future effect');
  assert.deepEqual(get(1),second,'random repeated chunk access is deterministic');
});

test('native grenade releases need no effect/flight, preserve source identity and do not expose gunfire',()=>{
  const {match,replay}=make(),r=replay.rounds[0];
  match.players.push({steamId:'2',nickname:'q'});replay.players.push('2');
  const weapons=['smokegrenade','flashbang','hegrenade','molotov','incgrenade','decoy','flashbang','ak47','unknown'];
  r.events=weapons.map((weapon,eventIndex)=>({eventIndex,event:{type:'weapon_fire',tick:eventIndex<2?159:160+eventIndex,shooter:eventIndex===1?'2':'1',shooterSide:'T',weapon:'weapon_'+weapon}}));
  const original=structuredClone(r.events),s=new ReplaySession(match,replay,'s');
  const a=s.get({sessionId:'s',round:1,block:0}),b=s.get({sessionId:'s',round:1,block:1});
  assert.deepEqual(r.events,original);
  assert.deepEqual(a.events.map(e=>[e.id,e.tick,e.actorId]),[['r1-e0',159,'1'],['r1-e1',159,'2']]);
  assert.deepEqual([...a.events,...b.events].filter(e=>e.type==='utility_throw').map(e=>e.description),[
    'p 投掷了 烟雾弹','q 投掷了 闪光弹','p 投掷了 手雷','p 投掷了 燃烧瓶','p 投掷了 燃烧弹','p 投掷了 诱饵弹','p 投掷了 闪光弹']);
  const seen=new Set(),first=appendReplayEvents([],seen,a.events,159),next=appendReplayEvents(first.events,seen,b.events,170);
  assert.equal(next.events.length,7);assert.equal(appendReplayEvents(next.events,seen,b.events,170).appended,0);
  assert.equal(appendReplayEvents([],new Set(),a.events,158).events.length,0);
  assert.equal(b.events.filter(e=>e.type==='weapon_fire').length,2,'unknown and firearm events stay hidden');
  assert.deepEqual(s.get({sessionId:'s',round:1,block:1}),b);
});

test('whole-round follow facts preserve real killer, suicide and unknown attribution across arbitrary blocks',()=>{
  const {match,replay}=make(),round=replay.rounds[0];
  match.players=['1','2','3','4'].map(steamId=>({steamId,nickname:steamId}));replay.players=['1','2','3','4'];
  round.frames=round.frames.map(frame=>({...frame,players:replay.players.map(playerId=>({...frame.players[0],playerId}))}));
  round.events=[
    {eventIndex:10,event:{type:'kill',tick:100,killer:'2',victim:'1'}},
    {eventIndex:11,event:{type:'kill',tick:159,killer:'2',victim:'2'}},
    {eventIndex:12,event:{type:'kill',tick:160,killer:'2',victim:'3',weapon:'hegrenade'}},
    {eventIndex:13,event:{type:'kill',tick:170,killer:'world',victim:'4'}},
  ];
  const original=structuredClone(round),session=new ReplaySession(match,replay,'follow');
  const get=block=>session.get({sessionId:'follow',round:1,block});
  const follow=get(2).follow;
  assert.deepEqual(round,original,'presentation never rewrites source rows or death attribution');
  assert.deepEqual(follow.deaths,[
    {id:'r1-e10',tick:100,killerId:'2',victimId:'1',alivePlayerIds:['2','3','4']},
    {id:'r1-e11',tick:159,killerId:'2',victimId:'2',alivePlayerIds:['3','4']},
    {id:'r1-e12',tick:160,killerId:'2',victimId:'3',alivePlayerIds:['4']},
    {id:'r1-e13',tick:170,killerId:null,victimId:'4',alivePlayerIds:[]},
  ]);
  assert.deepEqual(follow.states.at(-1),{tick:170,alivePlayerIds:[],deadPlayerIds:['1','2','3','4']},'death wins over stale true Pawn rows without inventing a spawn');
  assert.deepEqual(get(0).follow,follow);assert.deepEqual(get(1).follow,follow);
  assert.deepEqual(get(2).follow,follow,'cold/repeat/reverse block access has identical whole-round evidence');
  assert.ok(!JSON.stringify(follow).includes('position'),'follow contains no synthetic player positions');
});

test('follow eligibility groups same-tick deaths, preserves unknown state and respects spawn/disconnect barriers',()=>{
  const {match,replay}=make(),round=replay.rounds[0];
  match.players=['1','2','3'].map(steamId=>({steamId,nickname:steamId}));replay.players=['1','2','3'];
  round.frames=round.frames.map(frame=>({...frame,players:replay.players.map(playerId=>({...frame.players[0],playerId}))}));
  round.lifecycle=[{type:'spawn',tick:50,player:'1',side:'T'},{type:'disconnect',tick:60,player:'3'},
    {type:'spawn',tick:80,player:'3',side:'T'},{type:'spawn',tick:120,player:'1',side:'T'}];
  round.events=[{eventIndex:0,event:{type:'kill',tick:50,killer:'2',victim:'1'}},
    {eventIndex:1,event:{type:'kill',tick:100,killer:'1',victim:'2'}},
    {eventIndex:2,event:{type:'kill',tick:100,killer:'2',victim:'3'}}];
  round.frames.find(frame=>frame.requestedTick===90).players.find(player=>player.playerId==='1').actualTick=null;
  const follow=new ReplaySession(match,replay,'life').get({sessionId:'life',round:1,block:0}).follow;
  const at=tick=>follow.states.filter(state=>state.tick<=tick).at(-1);
  assert.deepEqual(at(50),{tick:50,alivePlayerIds:['2','3'],deadPlayerIds:[]},'same-tick spawn/death remains unknown');
  assert.deepEqual(at(60),{tick:60,alivePlayerIds:['2'],deadPlayerIds:[]},'disconnect is unknown, never dead or eligible');
  assert.deepEqual(at(80),{tick:80,alivePlayerIds:['2','3'],deadPlayerIds:[]},'only explicit known spawn reconnects');
  assert.deepEqual(follow.deaths.filter(death=>death.tick===100).map(death=>death.alivePlayerIds),[[],[]],'all deaths at tick apply atomically, so neither killer is eligible');
  assert.deepEqual(at(120),{tick:120,alivePlayerIds:['1'],deadPlayerIds:['2','3']},'later unambiguous spawn can restore life');
});

test('follow background history stores only reliable uniquely resolved floor transitions without coordinates',()=>{
  const {match,replay}=make(),round=replay.rounds[0];match.map='de_nuke';
  for(const frame of round.frames)frame.players[0].position=[0,0,frame.requestedTick<20?-600:-400];
  round.frames.find(frame=>frame.requestedTick===5).players[0].position=[0,0,-400];
  round.frames.find(frame=>frame.requestedTick===5).players[0].segment=null;
  round.frames.find(frame=>frame.requestedTick===6).players[0].position=[0,0,-400];
  round.frames.find(frame=>frame.requestedTick===6).players[0].actualTick=null;
  round.frames.find(frame=>frame.requestedTick===7).players[0].position=[0,0,-400];
  round.frames.find(frame=>frame.requestedTick===7).players[0].stateAmbiguous=true;
  round.frames.find(frame=>frame.requestedTick===8).players[0].position=[0,0,-495];
  round.frames.find(frame=>frame.requestedTick===9).players[0].position=[NaN,0,-400];
  round.events=[{eventIndex:0,event:{type:'kill',tick:30,killer:'world',victim:'1'}}];
  for(const frame of round.frames.filter(frame=>frame.requestedTick>=30))frame.players[0].position=[0,0,-600];
  const follow=new ReplaySession(match,replay,'floors').get({sessionId:'floors',round:1,block:2}).follow;
  assert.deepEqual(follow.backgrounds,[{tick:0,playerId:'1',layerId:'lower'},{tick:20,playerId:'1',layerId:'default'}]);
  assert.deepEqual(Object.keys(follow.backgrounds[0]).sort(),['layerId','playerId','tick'],'historical floor never fabricates or restores XYZ');
  assert.deepEqual(follow.states.at(-1),{tick:30,alivePlayerIds:[],deadPlayerIds:['1']});
});

test('reliable dead observation cannot revive from a later stale true row without known spawn',()=>{
  const {match,replay}=make(),round=replay.rounds[0];
  round.frames.find(frame=>frame.requestedTick===10).players[0].alive=false;
  round.lifecycle=[{type:'spawn',tick:200,player:'1',side:'T'}];
  const follow=new ReplaySession(match,replay,'observed').get({sessionId:'observed',round:1,block:2}).follow;
  const at=tick=>follow.states.filter(state=>state.tick<=tick).at(-1);
  assert.deepEqual(at(10),{tick:10,alivePlayerIds:[],deadPlayerIds:['1']});
  assert.deepEqual(at(199),{tick:10,alivePlayerIds:[],deadPlayerIds:['1']});
  assert.deepEqual(at(200),{tick:200,alivePlayerIds:['1'],deadPlayerIds:[]});
  assert.deepEqual(follow.deaths,[],'a native false observation is not fabricated into a death event');
});

test('conflicting duplicate same-tick victim attribution is unknown and never arbitrarily credits a killer',()=>{
  const {match,replay}=make(),round=replay.rounds[0];
  match.players=['1','2','3'].map(steamId=>({steamId,nickname:steamId}));replay.players=['1','2','3'];
  round.frames=round.frames.map(frame=>({...frame,players:replay.players.map(playerId=>({...frame.players[0],playerId}))}));
  round.events=[{eventIndex:10,event:{type:'kill',tick:100,killer:'2',victim:'1'}},
    {eventIndex:11,event:{type:'kill',tick:100,killer:'3',victim:'1'}}];
  const follow=new ReplaySession(match,replay,'duplicate').get({sessionId:'duplicate',round:1,block:0}).follow;
  assert.deepEqual(follow.deaths,[{id:'r1-e10',tick:100,killerId:null,victimId:'1',alivePlayerIds:['2','3']}]);
  assert.equal(round.events.length,2,'source events stay intact');
});

test('disconnect cannot erase a confirmed corpse, while a living disconnect alone remains unknown',()=>{
  const {match,replay}=make(),round=replay.rounds[0];
  match.players=['1','2','3'].map(steamId=>({steamId,nickname:steamId}));replay.players=['1','2','3'];
  round.frames=round.frames.map(frame=>({...frame,players:replay.players.map(playerId=>({...frame.players[0],playerId}))}));
  round.lifecycle=[{type:'disconnect',tick:20,player:'1'},{type:'disconnect',tick:20,player:'3'}];
  round.events=[{eventIndex:0,event:{type:'kill',tick:10,killer:'2',victim:'1'}},
    {eventIndex:1,event:{type:'kill',tick:30,killer:'world',victim:'2'}}];
  const follow=new ReplaySession(match,replay,'left').get({sessionId:'left',round:1,block:0}).follow;
  assert.deepEqual(follow.states.at(-1),{tick:30,alivePlayerIds:[],deadPlayerIds:['1','2']},'corpse stays dead; disconnected living player 3 remains unknown');
});
