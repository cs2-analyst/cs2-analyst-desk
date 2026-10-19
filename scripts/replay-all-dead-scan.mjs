// Read-only native inventory. No DEM edits, replay-window or sampling overrides.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as native from '../packages/demoparser-native/index.cjs';
import { convertToMatch } from '../packages/dem-parser/dist/providers/converters.js';
import { planReplay } from '../packages/dem-parser/dist/providers/replay.js';

const out=resolve('.tmp/p7-all-dead');mkdirSync(out,{recursive:true});
const result={schema:'p7-all-dead-native-inventory-v1',createdAt:new Date().toISOString(),
  method:'All non-warmup native death ticks, exact roster is_alive rows; formal windows from unmodified convertToMatch + planReplay defaults. Missing/unknown rows never mean all-dead.',
  files:[],status:'COLLECTING'};
for(const name of ['nuke','dust2','inferno','mirage','ancient','anubis','overpass','demo1','demo2','demo']){
  const file='.demo/'+name+'.dem';
  if(!existsSync(file)){result.files.push({file,status:'ABSENT'});continue;}
  const bytes=readFileSync(file),sha256=createHash('sha256').update(bytes).digest('hex');
  const events=native.parseEvents(bytes,['round_start','round_end','round_freeze_end','player_death','player_spawn','player_disconnect','player_team','bomb_exploded'],['team_num','is_alive'],['total_rounds_played','is_warmup_period','game_time']);
  const boundaries=[...new Set(events.filter(e=>e.is_warmup_period!==true&&['round_start','round_end','round_freeze_end'].includes(e.event_name)).map(e=>e.tick))].sort((a,b)=>a-b);
  const match=convertToMatch({id:sha256,header:native.parseHeader(bytes),players:native.parsePlayerInfo(bytes),events,
    stateRows:native.parseTicks(bytes,['team_num','is_alive'],boundaries)});
  const plan=planReplay(match),ids=match.players.map(p=>p.steamId);
  const deaths=events.filter(e=>e.event_name==='player_death'&&e.is_warmup_period!==true);
  const ticks=[...new Set(deaths.map(e=>e.tick))].sort((a,b)=>a-b);
  const rows=native.parseTicks(bytes,['is_alive','team_num'],ticks,ids),byTick=new Map();
  for(const row of rows){const list=byTick.get(row.tick)??[];list.push(row);byTick.set(row.tick,list);}
  const allDead=ticks.flatMap(tick=>{
    const state=byTick.get(tick)??[];
    if(!ids.length||!ids.every(id=>state.filter(r=>r.steamid===id).length===1&&state.find(r=>r.steamid===id).is_alive===false))return [];
    const formal=plan.rounds.find(({round:r})=>tick>=r.startTick&&tick<=r.endTick)?.round;
    const previous=match.rounds.findLast(r=>r.startTick<=tick);
    return [{tick,formalRound:formal?.number??null,previousRound:previous?{round:previous.number,startTick:previous.startTick,endTick:previous.endTick}:null,
      deaths:deaths.filter(e=>e.tick===tick),rows:state}];
  });
  const item={file,sha256,fileBytes:bytes.length,roster:ids,deathTicks:ticks.length,
    windows:plan.rounds.map(({round:r})=>({round:r.number,startTick:r.startTick,endTick:r.endTick})),excludedRounds:plan.excludedRounds,
    exactStateCoverage:{queried:ticks.length,complete:ticks.filter(t=>ids.every(id=>(byTick.get(t)??[]).some(r=>r.steamid===id&&typeof r.is_alive==='boolean'))).length},
    allDead,status:'SCANNED'};
  result.files.push(item);writeFileSync(resolve(out,'native-inventory.json'),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify({file,deathTicks:ticks.length,allDead:allDead.map(e=>({tick:e.tick,formalRound:e.formalRound,previousRound:e.previousRound}))}));
  // Reusable spatial seed: actual native observations, never invented coordinates.
  if(name==='nuke'){
    const seedTicks=[18000,18008,18384,18392,18395,18400];
    const seed={file,sha256,nativeSha256:native.getBindingProvenance().verifiedSha256,
      players:match.players.map(p=>({id:p.steamId,nickname:p.name??p.steamId})),
      rows:native.parseTicks(bytes,['X','Y','Z','yaw','health','is_alive','team_num'],seedTicks,ids)};
    writeFileSync(resolve(out,'native-spatial-seed.json'),JSON.stringify(seed,null,2)+'\n');
  }
  global.gc?.();
}
result.formalAllDead=result.files.flatMap(f=>(f.allDead??[]).filter(e=>e.formalRound!==null).map(e=>({file:f.file,...e})));
result.status='PASS';writeFileSync(resolve(out,'native-inventory.json'),JSON.stringify(result,null,2)+'\n');
assert.ok(result.files.some(f=>f.status==='SCANNED'));
console.log(JSON.stringify({status:result.status,formalAllDead:result.formalAllDead.length}));
