// Controlled presentation/lifecycle data, NEVER claimed to be native deaths.
// XYZ/yaw are copied verbatim from an independently recorded native Nuke snapshot.
// Missing-position variants remove XYZ; no fabricated position or trajectory is added.
import assert from 'node:assert/strict';
import { replayResourceId } from '../../../apps/desktop/shared/replay-resource.ts';

export function makeFixtures(seed){
  const rows=seed.rows.filter(r=>r.tick===18000),players=seed.players.map(p=>({...p,nickname:rows.find(r=>r.steamid===p.id)?.name??p.nickname}));
  assert.equal(rows.length,players.length);assert.equal(players.length,10);
  const lower=rows.find(r=>r.is_alive===true&&r.Z < -495&&Number.isFinite(r.X)&&Number.isFinite(r.Y));
  const upper=rows.find(r=>r.is_alive===true&&r.Z > -495&&Number.isFinite(r.X)&&Number.isFinite(r.Y));
  assert.ok(lower&&upper,'native spatial seed must include observed players on both floors');
  return ['c4','posthumous-he','suicide','unknown','missing-final-position','no-floor-reference'].map((id,index)=>{
    const missing=id==='missing-final-position',noFloor=id==='no-floor-reference';
    const target=index%2===0?lower:upper,anchor=target.steamid,other=players.find(p=>p.id!==anchor).id;
    const deathTick=18400,startTick=18000,endTick=19023,ids=players.map(p=>p.id);
    const layer=target.Z < -495?'lower':'default';
    const sessionId='controlled-all-dead-'+id;
    const blocks=Array.from({length:8},(_,i)=>({index:i,startTick:startTick+i*128,endTick:startTick+(i+1)*128-1}));
    const metadata={schemaVersion:1,available:true,unavailableReason:null,sessionId,matchId:'controlled:'+seed.sha256,
      map:'de_nuke',resourceId:replayResourceId,samplingVersion:'controlled-test-only',tickRate:64,maxInterpolationTicks:8,
      perspective:'global',players,rounds:[{round:1,startTick,endTick,freezeEndTick:null,coverage:'partial',blocks}],excludedRounds:[]};
    const finalVictims=id==='c4'?[anchor,other]:[anchor];
    const initialAlive=finalVictims;
    const killerId=id==='suicide'?anchor:id==='posthumous-he'?other:null;
    const states=[{tick:startTick,alivePlayerIds:initialAlive,deadPlayerIds:ids.filter(p=>!initialAlive.includes(p))},
      {tick:deathTick,alivePlayerIds:[],deadPlayerIds:ids}];
    const deaths=finalVictims.map(victimId=>({id:`controlled-${id}-${victimId}`,tick:deathTick,victimId,
      killerId,alivePlayerIds:[]}));
    const follow={states,deaths,backgrounds:noFloor?[]:[{tick:startTick,playerId:anchor,layerId:layer}]};
    const ticks=[...new Set([...Array.from({length:129},(_,i)=>startTick+i*8).filter(t=>t<=endTick),...blocks.flatMap(b=>[b.startTick,b.endTick,b.endTick+1]),deathTick-1,deathTick])].sort((a,b)=>a-b);
    const frames=ticks.map(tick=>({tick,players:players.map((p,i)=>{
      const source=rows.find(r=>r.steamid===p.id),alive=tick<deathTick&&initialAlive.includes(p.id);
      const hasPosition=alive&&!noFloor&&!(missing&&tick>=deathTick-8);
      return [i,tick,hasPosition?source.X:null,hasPosition?source.Y:null,hasPosition?source.Z:null,
        hasPosition?source.yaw:null,alive?100:0,alive,source.team_num===3?'CT':'T',hasPosition?1:null,false];
    }),bomb:{action:'none',carrierId:null,position:null,positionSource:null,ambiguous:false}}));
    // Spatially observed seed reused only as a test effect point. The synthetic
    // smoke lifetime is a controlled renderer stimulus, not a native utility claim.
    const utilities=[{id:'controlled-smoke',eventIndex:0,kind:'smoke',variant:null,throwerId:other,entityId:null,
      tick:deathTick-16,endTick:deathTick+96,endSource:'observed',position:[target.X,target.Y,target.Z],trajectory:null}];
    if(id==='posthumous-he')utilities.push({id:'controlled-posthumous-he',eventIndex:1,kind:'hegrenade',variant:null,throwerId:other,entityId:null,
      tick:deathTick,endTick:deathTick,endSource:'observed',position:[target.X,target.Y,target.Z],trajectory:null});
    const events=deaths.map(d=>({id:d.id,tick:d.tick,type:'kill',description:'测试专用受控死亡：'+id,
      actorId:d.killerId,targetId:d.victimId,position:null}));
    if(id==='c4')events.push({id:'controlled-c4-explosion',tick:deathTick,type:'bomb_exploded',description:'测试专用受控 C4 爆炸 · 同 tick 全员死亡',actorId:null,targetId:null,position:null});
    const chunks=blocks.map(b=>({schemaVersion:1,sessionId,matchId:metadata.matchId,round:1,block:b.index,
      startTick:b.startTick,endTick:b.endTick,frames:frames.filter(f=>f.tick>=b.startTick-8&&f.tick<=b.endTick+8),
      events:events.filter(e=>e.tick>=b.startTick&&e.tick<=b.endTick),utilities,blinds:[],burns:[],follow}));
    return {id,anchor,other,deathTick,expectedLayer:layer,noFloor,missing,metadata,chunks,
      provenance:{source:seed.file,sha256:seed.sha256,spatialTick:18000,
        lifecycle:'synthetic controlled DTO only; no native death claim',coordinates:'native snapshot values verbatim or null'}};
  });
}
