import type { Match, MatchReplay, ReplayRound } from '@cs2-analyst/match-model';
import type { DesktopReplayBlind, DesktopReplayBomb, DesktopReplayBurn, DesktopReplayChunk, DesktopReplayEvent, DesktopReplayFrame, DesktopReplayMetadata,
  DesktopReplayPlayer, DesktopReplayRequest, DesktopReplayRoundInfo, DesktopReplayUtility } from '@cs2-analyst/report-contract';
import { displayPlayerName } from './player-name.ts';
import { replayResourceId } from '../shared/replay-resource.ts';

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
      const utilities=(round.utilities??[]).map(utility=>mapUtility(round.round,utility));
      const blinds:DesktopReplayBlind[]=(round.blinds??[]).map(window=>({...window}));
      const burns:DesktopReplayBurn[]=(round.burns??[]).map(window=>({...window}));
      const events: DesktopReplayEvent[]=round.events.map(({event:e,eventIndex})=>{
        let actorId:string|null=null,targetId:string|null=null,description:string=e.type,position:[number,number,number]|null=null;
        if(e.type==='kill'){actorId=names.has(e.killer)?e.killer:null;targetId=e.victim;description=`${actorId?names.get(actorId):'无已知攻击者'} 击杀 ${names.get(e.victim)??'未知玩家'}`;}
        else if(e.type==='damage'){actorId=e.attacker;targetId=e.victim;description=`伤害事件 · 报告 HP 伤害 ${e.healthDamage}`;}
        else if(e.type==='weapon_fire'){actorId=e.shooter;description=`${names.get(e.shooter)??'未知玩家'} 开火 · ${e.weapon}`;}
        else if(e.type==='utility'){
          const effect=effectByEvent.get(eventIndex);
          // Event thrower first, then the native projectile owner; both are real data.
          const throwerId=e.thrower??effect?.throwerId??null;
          actorId=throwerId;
          const nickname=throwerId&&names.has(throwerId)?names.get(throwerId)!.trim():'';
          description=`${nickname||'未知玩家'} 投掷了 ${effect?.variant??effect?.kind??e.utility}`;
          if(e.position)position=[e.position.x,e.position.y,e.position.z];
        }
        else if(e.type==='flash'){actorId=e.attacker;targetId=e.victim;description=`${names.get(e.victim)??'未知玩家'} 受闪事件`;}
        else if(e.type==='bomb'){actorId=e.player;description=bombLabels[e.action];}
        return {id:`r${round.round}-e${eventIndex}`,tick:e.tick,type:e.type,description,actorId,targetId,position};
      });
      const info:DesktopReplayRoundInfo={round:round.round,startTick:round.startTick,endTick:round.endTick,freezeEndTick:round.freezeEndTick,coverage:round.coverage.status,blocks:[]};
      const add=(startTick:number,endTick:number)=>{
        let first=frames.findIndex(f=>f.tick>=startTick);if(first<0)first=frames.length-1;
        if(first>0&&frames[first].tick>startTick)first--;
        let last=first;while(last+1<frames.length&&frames[last+1].tick<=endTick)last++;if(last+1<frames.length)last++;
        const block=info.blocks.length,chunk:DesktopReplayChunk={schemaVersion:1,sessionId,matchId:match.id,round:round.round,block,startTick,endTick,
          frames:frames.slice(first,last+1),events:events.filter(e=>e.tick>=startTick&&e.tick<=endTick)};
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
