import type { DesktopReplayChunk, DesktopReplayEvent, DesktopReplayFrame, DesktopReplayPlayer, DesktopReplayRoundInfo } from '@cs2-analyst/report-contract';
export const replayBlockAt=(round:DesktopReplayRoundInfo,tick:number)=>round.blocks.find(b=>Math.floor(tick)>=b.startTick&&Math.floor(tick)<=b.endTick);

/** Next round the metadata actually exposes; never invent a round number or a window. */
export function nextReplayRound(metadata: { rounds: DesktopReplayRoundInfo[]; excludedRounds: number[] }, roundNumber: number): DesktopReplayRoundInfo | null {
  const excluded = new Set(metadata.excludedRounds);
  return metadata.rounds
    .filter(round => round.round > roundNumber && !excluded.has(round.round) && round.blocks.length > 0)
    .sort((a, b) => a.round - b.round)[0] ?? null;
}

/** Replay owns its selection; invalid/stale ids fall back to a roster identity without nickname guessing. */
export function resolveReplayPlayerId(players: readonly { id: string }[], candidate: string): string {
  if (players.some(player => player.id === candidate)) return candidate;
  return players[0]?.id ?? '';
}

export const REPLAY_VISIBLE_EVENT_LIMIT = 200;
const hiddenReplayEventTypes = new Set(['weapon_fire', 'damage', 'flash']);

/**
 * Presentation-only append: only events at or before the displayed tick become visible,
 * ids are never appended twice, and the rendered list stays bounded. Same-tick order is
 * whatever the frozen Replay contract supplied; this function never reorders it.
 */
export function appendReplayEvents(current: readonly DesktopReplayEvent[], seen: Set<string>, events: readonly DesktopReplayEvent[],
  tick: number, limit = REPLAY_VISIBLE_EVENT_LIMIT): { events: DesktopReplayEvent[]; appended: number } {
  const appended: DesktopReplayEvent[] = [];
  for (const event of events) {
    if (hiddenReplayEventTypes.has(event.type) || Math.floor(event.tick) > Math.floor(tick) || seen.has(event.id)) continue;
    seen.add(event.id);
    appended.push(event);
  }
  if (!appended.length) return { events: [...current], appended: 0 };
  const next = [...current, ...appended];
  return { events: next.length > limit ? next.slice(next.length - limit) : next, appended: appended.length };
}

export const reliableReplayRate = (rate: number | null): rate is number => rate !== null && Number.isFinite(rate) && rate > 0;

/** Round-relative display only; the slider and clock keep their original tick precision. */
export function replayRoundTime(tick: number, round: Pick<DesktopReplayRoundInfo, 'startTick' | 'endTick'>, rate: number | null): string {
  if (!reliableReplayRate(rate)) return `原始 tick ${Math.round(tick)}`;
  const seconds = Math.floor((Math.max(round.startTick, Math.min(round.endTick, tick)) - round.startTick) / rate);
  const mm = String(Math.floor(seconds / 60) % 60).padStart(2, '0');
  const ss = String(seconds % 60).padStart(2, '0');
  return seconds >= 3600 ? `${Math.floor(seconds / 3600)}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function replayRelativeTick(tick: number, seconds: number, round: Pick<DesktopReplayRoundInfo, 'startTick' | 'endTick'>, rate: number | null): number | null {
  if (!reliableReplayRate(rate)) return null;
  return Math.max(round.startTick, Math.min(round.endTick, tick + seconds * rate));
}

export class ReplayClock {
  tick: number; anchorMs = 0; speed = 1; playing = false;
  constructor(tick: number) { this.tick = tick; }
  read(now: number, tickRate: number | null) { return this.tick + (this.playing && tickRate !== null ? Math.max(0, now-this.anchorMs)/1000*tickRate*this.speed : 0); }
  seek(tick:number,now:number){this.tick=tick;this.anchorMs=now;}
  pause(now:number,rate:number|null){this.seek(this.read(now,rate),now);this.playing=false;}
  play(now:number){this.anchorMs=now;this.playing=true;}
  setSpeed(speed:number,now:number,rate:number|null){this.seek(this.read(now,rate),now);this.speed=speed;}
}
/** Pure presentation interpolation. No value from here returns to parser/analytics/findings. */
export function replayDisplayFrame(chunk:DesktopReplayChunk,tick:number,maxGap:number|null,playerIds:readonly string[]=[],floorAt?:(z:number|null)=>string|null):DesktopReplayFrame|null {
  if(tick<chunk.startTick||Math.floor(tick)>chunk.endTick||tick>(chunk.frames.at(-1)?.tick??-1)||!Number.isFinite(tick))return null;
  let low=0,high=chunk.frames.length;
  while(low<high){const mid=(low+high)>>>1;if(chunk.frames[mid].tick<=tick)low=mid+1;else high=mid;}
  const left=chunk.frames[low-1],right=chunk.frames[low];if(!left)return null;
  if(left.tick===tick)return left;
  const gap=right?right.tick-left.tick:Infinity;
  const players:DesktopReplayPlayer[]=left.players.map(a=>{
    const b=right?.players.find(p=>p[0]===a[0]);
    const interval=!!b&&maxGap!==null&&gap>0&&gap<=maxGap&&a[1]===left.tick&&b[1]===right.tick&&!a[10]&&!b[10]&&a[8]===b[8];
    if(!interval)return [a[0],null,null,null,null,null,null,null,'Unknown',null,a[10]||!!b?.[10]];
    const value:DesktopReplayPlayer=[...a];
    value[2]=value[3]=value[4]=value[5]=null;
    const sameFloor=!floorAt||(floorAt(a[4])!==null&&floorAt(a[4])===floorAt(b[4]));
    if(sameFloor&&a[9]!==null&&a[9]===b[9]&&a[7]===true&&b[7]===true&&a[2]!==null&&a[3]!==null&&a[4]!==null&&b[2]!==null&&b[3]!==null&&b[4]!==null){
      const f=(tick-left.tick)/gap;
      value[2]=a[2]+(b[2]-a[2])*f;value[3]=a[3]+(b[3]-a[3])*f;value[4]=a[4]+(b[4]-a[4])*f;
      if(a[5]!==null&&b[5]!==null){const delta=((b[5]-a[5]+540)%360+360)%360-180;value[5]=a[5]+delta*f;}
    }
    return value;
  });
  let bomb={...left.bomb};
  if(bomb.carrierId){
    const carrierIndex=playerIds.indexOf(bomb.carrierId),carrier=players.find(p=>p[0]===carrierIndex);
    // Reuse the carrier's presentation position only in the same valid observation run.
    bomb={...bomb,position:carrier?.[7]===true&&carrier[2]!==null&&carrier[3]!==null&&carrier[4]!==null?[carrier[2],carrier[3],carrier[4]]:null};
  }
  return {tick,players,bomb};
}
export class ReplayChunkCache {
  private readonly entries = new Map<string,DesktopReplayChunk>();
  get(round:number,block:number){const key=`${round}:${block}`,value=this.entries.get(key);if(value){this.entries.delete(key);this.entries.set(key,value);}return value;}
  put(chunk:DesktopReplayChunk){const key=`${chunk.round}:${chunk.block}`;this.entries.delete(key);this.entries.set(key,chunk);while(this.entries.size>3)this.entries.delete(this.entries.keys().next().value!);}
  clear(){this.entries.clear();}
  get size(){return this.entries.size;}
}
