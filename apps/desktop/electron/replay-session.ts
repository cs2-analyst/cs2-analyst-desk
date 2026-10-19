import type { Match, MatchReplay, ReplayRound } from '@cs2-analyst/match-model';
import type { DesktopReplayBlind, DesktopReplayBomb, DesktopReplayBurn, DesktopReplayChunk, DesktopReplayEvent, DesktopReplayFollow, DesktopReplayFrame, DesktopReplayMetadata,
  DesktopReplayPlayer, DesktopReplayRequest, DesktopReplayRoundInfo, DesktopReplayUtility } from '@cs2-analyst/report-contract';
import { displayPlayerName } from './player-name.ts';
import { replayResourceId } from '../shared/replay-resource.ts';
import { replayThrownUtility, replayUtilityLabel } from '../shared/replay-presentation.ts';
import { replayMapDefinitions, resolveMapLayer } from '../shared/replay-map-geometry.ts';

export const REPLAY_CHUNK_BYTES = 1024 * 1024;
export const REPLAY_CACHE_BYTES = 64 * 1024 * 1024;
const bombLabels: Record<string,string> = { pickup:'拾取炸弹',drop:'掉落炸弹',plant_start:'开始安包',planted:'炸弹安放完成',defuse_start:'开始拆弹',defused:'炸弹拆除成功',exploded:'炸弹爆炸' };
const emptyBomb = (): DesktopReplayBomb => ({ action:'unknown',carrierId:null,position:null,positionSource:null,ambiguous:false });
const overlaps = (startTick:number,endTick:number,from:number,to:number)=>startTick<=to&&endTick>=from;
/** An effect belongs to a block when its flight or its real window overlaps that block. */
const utilityOverlaps = (utility:DesktopReplayUtility,startTick:number,endTick:number)=>
  (utility.trajectory?overlaps(startTick,endTick,utility.trajectory.startTick,utility.trajectory.endTick):false)
  ||overlaps(startTick,endTick,utility.tick,utility.endTick);
function mapUtility(round:number,utility:NonNullable<ReplayRound['utilities']>[number]):DesktopReplayUtility{
  return {id:`r${round}-u${utility.eventIndex}`,eventIndex:utility.eventIndex,kind:utility.kind,variant:utility.variant,
    throwerId:utility.throwerId,entityId:utility.entityId,tick:utility.tick,endTick:utility.endTick,endSource:utility.endSource,
    position:utility.position,trajectory:utility.flight?{startTick:utility.flight.startTick,endTick:utility.flight.endTick,points:utility.flight.points}:null};
}
function roundFrames(round: ReplayRound, replay: MatchReplay): DesktopReplayFrame[] {
  let bomb = emptyBomb(), cursor = 0;
  const events = round.events.map(e=>e.event).filter(e=>e.type==='bomb').sort((a,b)=>a.tick-b.tick);
  return round.frames.map(frame => {
    while(cursor<events.length && events[cursor].tick<=frame.requestedTick) {
      const tick=events[cursor].tick, group=[];
      while(cursor<events.length&&events[cursor].tick===tick)group.push(events[cursor++]);
      if(group.length!==1){bomb={...emptyBomb(),ambiguous:true};continue;}
      const event=group[0], associated=round.frames.find(f=>f.requestedTick===event.tick)?.players.find(p=>p.playerId===event.player);
      const position=associated?.actualTick===event.tick?associated.position:null;
      if(event.action==='pickup'||event.action==='plant_start') bomb={action:event.action,carrierId:event.player,position:null,positionSource:null,ambiguous:false};
      else if(event.action==='planted'||event.action==='drop')bomb={action:event.action,carrierId:null,position,positionSource:position?'actor-at-event':null,ambiguous:false};
      else bomb={...bomb,action:event.action,carrierId:null};
    }
    let current={...bomb};
    if(current.carrierId){ const carrier=frame.players.find(p=>p.playerId===current.carrierId);current={...current,position:carrier?.actualTick===frame.requestedTick&&carrier.alive===true?carrier.position:null,positionSource:'carrier-sample'}; }
    const players: DesktopReplayPlayer[]=frame.players.map(p=>[replay.players.indexOf(p.playerId),p.actualTick,
      p.position?.[0]??null,p.position?.[1]??null,p.position?.[2]??null,p.yaw,p.health,p.alive,p.side,p.segment,p.stateAmbiguous]);
    return {tick:frame.requestedTick,players,bomb:current};
  });
}
/** Project existing exact-tick life evidence once, before independent block serialization. */
function roundFollow(round: ReplayRound, replay: MatchReplay, mapId: string): DesktopReplayFollow {
  const follow: DesktopReplayFollow={deaths:[],states:[],backgrounds:[]};
  const known=new Set(replay.players), map=replayMapDefinitions.find(map=>map.id===mapId);
  const deaths=round.events.filter(({event})=>event.type==='kill').sort((a,b)=>a.event.tick-b.event.tick||a.eventIndex-b.eventIndex);
  const lifecycle=[...round.lifecycle].sort((a,b)=>a.tick-b.tick);
  const killed=new Set<string>(), observedDead=new Set<string>(), disconnected=new Set<string>(), conflicted=new Set<string>();
  const layers=new Map<string,string>();
  let deathCursor=0,lifeCursor=0,previousState='';
  for(const frame of round.frames){
    const pendingDeaths:typeof deaths=[];
    while(deathCursor<deaths.length&&deaths[deathCursor].event.tick<=frame.requestedTick)pendingDeaths.push(deaths[deathCursor++]);
    const pendingLife:typeof lifecycle=[];
    while(lifeCursor<lifecycle.length&&lifecycle[lifeCursor].tick<=frame.requestedTick)pendingLife.push(lifecycle[lifeCursor++]);
    const ticks=[...new Set([...pendingDeaths.map(({event})=>event.tick),...pendingLife.map(event=>event.tick)])].sort((a,b)=>a-b);
    for(const tick of ticks){
      const deadAt=new Set(pendingDeaths.filter(({event})=>event.tick===tick).map(({event})=>event.type==='kill'?event.victim:''));
      for(const id of replay.players){
        const life=pendingLife.filter(event=>event.tick===tick&&(event.player===id||event.player===null));
        const spawned=life.some(event=>event.type==='spawn'&&event.player===id);
        const left=life.some(event=>event.type==='disconnect'||(event.type==='side_change'&&event.disconnect));
        if(left)disconnected.add(id);
        else if(spawned){disconnected.delete(id);killed.delete(id);observedDead.delete(id);conflicted.delete(id);}
        if(deadAt.has(id))killed.add(id);
        if(spawned&&(left||deadAt.has(id)))conflicted.add(id);
      }
    }
    const alivePlayerIds:string[]=[],deadPlayerIds:string[]=[];
    for(const id of replay.players){
      const sample=frame.players.find(player=>player.playerId===id);
      const reliable=sample?.actualTick===frame.requestedTick&&!sample.stateAmbiguous;
      // Disconnect is not a death. It also cannot undo an already confirmed death.
      if(disconnected.has(id)&&!killed.has(id)&&!observedDead.has(id))continue;
      if(reliable&&sample?.alive===false)observedDead.add(id);
      // A real death remains authoritative through missing/stale Pawn rows. A same-tick
      // spawn/death collision stays unknown until a later reliable observation or spawn.
      if(conflicted.has(id)&&reliable&&sample?.alive===false)conflicted.delete(id);
      if(!conflicted.has(id)&&(killed.has(id)||observedDead.has(id)))deadPlayerIds.push(id);
      else if(!conflicted.has(id)&&reliable&&sample?.alive===true&&!killed.has(id))alivePlayerIds.push(id);
      if(map&&alivePlayerIds.at(-1)===id&&sample?.segment!==null&&sample?.position?.every(Number.isFinite)){
        const layerId=resolveMapLayer(map,sample.position[2]);
        if(layerId!==null&&layers.get(id)!==layerId){follow.backgrounds.push({tick:frame.requestedTick,playerId:id,layerId});layers.set(id,layerId);}
      }
    }
    alivePlayerIds.sort();deadPlayerIds.sort();
    const state=JSON.stringify([alivePlayerIds,deadPlayerIds]);
    if(state!==previousState){follow.states.push({tick:frame.requestedTick,alivePlayerIds,deadPlayerIds});previousState=state;}
    const groupedVictims=new Set<string>();
    for(const {event,eventIndex} of pendingDeaths){
      if(event.type!=='kill')continue;
      const key=`${event.tick}:${event.victim}`;
      if(groupedVictims.has(key))continue;
      groupedVictims.add(key);
      const killers=new Set(pendingDeaths.filter(({event:other})=>other.type==='kill'&&other.tick===event.tick&&other.victim===event.victim)
        .map(({event:other})=>other.type==='kill'&&known.has(other.killer)?other.killer:null));
      // planReplay includes every death tick. Never borrow future state if a malformed
      // caller omitted that observation; unknown eligibility is the honest fallback.
      follow.deaths.push({id:`r${round.round}-e${eventIndex}`,tick:event.tick,victimId:event.victim,
        killerId:killers.size===1?[...killers][0]:null,alivePlayerIds:event.tick===frame.requestedTick?[...alivePlayerIds]:[]});
    }
  }
  return follow;
}
export class ReplaySession {
  readonly metadata: DesktopReplayMetadata;
  readonly cacheKey: string;
  readonly chunks = new Map<string,string>();
  bytes = 0;
  constructor(match: Match, replay: MatchReplay, sessionId: string, limits = { chunkBytes:REPLAY_CHUNK_BYTES, cacheBytes:REPLAY_CACHE_BYTES }) {
    if(match.id!==replay.matchId||replay.schemaVersion!==1)throw new Error('Replay identity/schema mismatch');
    const names = new Map(match.players.map(p=>[p.steamId,displayPlayerName(p.steamId,p.nickname)]));
    this.cacheKey=[match.id,replay.schemaVersion,replay.samplingVersion,replayResourceId].join(':');
    this.metadata={schemaVersion:1,available:true,unavailableReason:null,sessionId,matchId:match.id,map:match.map,resourceId:replayResourceId,
      samplingVersion:replay.samplingVersion,tickRate:replay.tickRate,maxInterpolationTicks:replay.maxInterpolationTicks,perspective:'global',
      players:replay.players.map(id=>({id,nickname:names.get(id)??'未知玩家'})),rounds:[],excludedRounds:replay.excludedRounds};
    for(const round of replay.rounds){
      const frames=roundFrames(round,replay), effectByEvent=new Map((round.utilities??[]).map(utility=>[utility.eventIndex,utility]));
      const follow=roundFollow(round,replay,match.map);
      const utilities=(round.utilities??[]).map(utility=>mapUtility(round.round,utility));
      const blinds:DesktopReplayBlind[]=(round.blinds??[]).map(window=>({...window}));
      const burns:DesktopReplayBurn[]=(round.burns??[]).map(window=>({...window}));
      const events: DesktopReplayEvent[]=round.events.map(({event:e,eventIndex})=>{
        let actorId:string|null=null,targetId:string|null=null,description:string=e.type,position:[number,number,number]|null=null,type:string=e.type;
        if(e.type==='kill'){actorId=names.has(e.killer)?e.killer:null;targetId=e.victim;description=`${actorId?names.get(actorId):'无已知攻击者'} 击杀 ${names.get(e.victim)??'未知玩家'}`;}
        else if(e.type==='damage'){actorId=e.attacker;targetId=e.victim;description=`伤害事件 · 报告 HP 伤害 ${e.healthDamage}`;}
        else if(e.type==='weapon_fire'){
          actorId=e.shooter;
          const utility=replayThrownUtility(e.weapon);
          // Native release tick and shooter are direct evidence. Do not derive either
          // from flight/effect entities (which can be reused or absent altogether).
          if(utility){type='utility_throw';description=`${names.get(e.shooter)?.trim()||'未知玩家'} 投掷了 ${replayUtilityLabel(utility)}`;}
          else description=`${names.get(e.shooter)??'未知玩家'} 开火 · ${e.weapon}`;
        }
        else if(e.type==='utility'){
          const effect=effectByEvent.get(eventIndex);
          // Event thrower first, then the native projectile owner; both are real data.
          const throwerId=e.thrower??effect?.throwerId??null;
          actorId=throwerId;
          const nickname=throwerId&&names.has(throwerId)?names.get(throwerId)!.trim():'';
          // Utility ticks are native detonation/start observations, not weapon_fire ticks.
          // Name that observed action without moving events or any effect/flight window.
          const action=e.action==='start_burn'?'开始燃烧':e.action==='start_decoy'?'开始生效':'爆开';
          description=`${nickname||'未知玩家'} 的 ${replayUtilityLabel(effect?.variant??effect?.kind??e.utility)} ${action}`;
          if(e.position)position=[e.position.x,e.position.y,e.position.z];
        }
        else if(e.type==='flash'){actorId=e.attacker;targetId=e.victim;description=`${names.get(e.victim)??'未知玩家'} 受闪事件`;}
        else if(e.type==='bomb'){actorId=e.player;description=bombLabels[e.action];}
        return {id:`r${round.round}-e${eventIndex}`,tick:e.tick,type,description,actorId,targetId,position};
      });
      const info:DesktopReplayRoundInfo={round:round.round,startTick:round.startTick,endTick:round.endTick,freezeEndTick:round.freezeEndTick,coverage:round.coverage.status,blocks:[]};
      const add=(startTick:number,endTick:number)=>{
        let first=frames.findIndex(f=>f.tick>=startTick);if(first<0)first=frames.length-1;
        if(first>0&&frames[first].tick>startTick)first--;
        let last=first;while(last+1<frames.length&&frames[last+1].tick<=endTick)last++;if(last+1<frames.length)last++;
        const block=info.blocks.length,chunk:DesktopReplayChunk={schemaVersion:1,sessionId,matchId:match.id,round:round.round,block,startTick,endTick,
          frames:frames.slice(first,last+1),events:events.filter(e=>e.tick>=startTick&&e.tick<=endTick),follow};
        const blockUtilities=utilities.filter(utility=>utilityOverlaps(utility,startTick,endTick));
        const blockBlinds=blinds.filter(window=>overlaps(startTick,endTick,window.startTick,window.endTick));
        const blockBurns=burns.filter(window=>overlaps(startTick,endTick,window.startTick,window.endTick));
        // Omit empty additive arrays so effect-free chunks keep their previous JSON shape.
        if(blockUtilities.length)chunk.utilities=blockUtilities;
        if(blockBlinds.length)chunk.blinds=blockBlinds;
        if(blockBurns.length)chunk.burns=blockBurns;
        const json=JSON.stringify(chunk),size=Buffer.byteLength(json);
        if(size>limits.chunkBytes){if(endTick<=startTick)throw new Error('Replay single-tick chunk budget exceeded');const mid=Math.floor((startTick+endTick)/2);add(startTick,mid);add(mid+1,endTick);return;}
        if(this.bytes+size>limits.cacheBytes)throw new Error('Replay session cache budget exceeded');
        this.chunks.set(`${round.round}:${block}`,json);this.bytes+=size;info.blocks.push({index:block,startTick,endTick});
      };
      const span=replay.tickRate===null?round.endTick-round.startTick+1:20*replay.tickRate;
      for(let start=round.startTick;start<=round.endTick;start+=span)add(start,Math.min(round.endTick,start+span-1));
      this.metadata.rounds.push(info);
    }
  }
  get(request:DesktopReplayRequest):DesktopReplayChunk|null {
    if(request.sessionId!==this.metadata.sessionId||!Number.isSafeInteger(request.round)||!Number.isSafeInteger(request.block))return null;
    const json=this.chunks.get(`${request.round}:${request.block}`);return json?JSON.parse(json):null;
  }
  clear(){this.chunks.clear();this.bytes=0;}
}
