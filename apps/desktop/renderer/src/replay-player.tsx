import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { Badge, Body1, Button, Caption1, Dropdown, Option, Slider, Spinner, Switch, Title2, Tooltip, makeStyles, tokens } from '@fluentui/react-components';
import type { DesktopReplayChunk, DesktopReplayEvent, DesktopReplayFrame, DesktopReplayMetadata, DesktopReplayRoundInfo, DesktopReplayUtility } from '@cs2-analyst/report-contract';
import { mapResourceState, radarHeading, resolveMapLayer, worldToRadar } from './replay-map';
import type { ReplayMapDefinition } from './replay-map';
import { replayMapAssets } from './replay-map-assets';
import { appendReplayEvents, nextReplayRound, replayBlockAt, replayDisplayFrame, ReplayChunkCache, ReplayClock, resolveReplayPlayerId } from './replay-state';
import { paintReplayArea, paintReplayHEBurst, replayEffectsAt } from './replay-effects';
import type { ReplayEffectFrame } from './replay-effects';
import { QuestionCircleIcon, PauseIcon, PlayIcon } from './icons';
import { useRoundMenu } from './round-menu';
import { palette } from './theme';
import { replayEffectAssetUrls } from './replay-effect-assets';
import type { ReplayEffectImages } from './replay-effect-assets';

/**
 * Desktop analysis layout: the panel owns the full height and nothing here scrolls as a page.
 * Row 1 is the control bar, row 2 splits into map + side rail (each region scrolls locally),
 * row 3 is the transport timeline. Below 860px the rail collapses under the map and the
 * middle region becomes its own scroll area.
 */
const useStyles = makeStyles({
  root: { flex: 1, minHeight: 0, display: 'grid', gridTemplateRows: 'auto minmax(0, 1fr)', gap: '10px' },
  bar: {
    flexShrink: 0, display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '10px', padding: '8px 10px',
    backgroundColor: palette.card, border: `1px solid ${palette.border}`, borderRadius: tokens.borderRadiusLarge,
  },
  barTitle: { display: 'flex', alignItems: 'baseline', gap: '8px' },
  controls: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '8px' },
  dropdown: { minWidth: '104px', maxWidth: '168px' },
  playButton: { minWidth: '92px' },
  switch: { marginLeft: '2px' },
  spacer: { flex: 1 },
  body: {
    minHeight: 0, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 292px', gap: '10px',
    '@media (max-width: 860px)': { gridTemplateColumns: 'minmax(0, 1fr)', overflowY: 'auto' },
  },
  // The transport belongs to the map column only; the rail keeps its own full-height column.
  left: {
    minWidth: 0, minHeight: 0, display: 'grid', gridTemplateRows: 'minmax(0, 1fr) auto', gap: '10px',
    '@media (max-width: 860px)': { gridTemplateRows: 'auto auto' },
  },
  mapColumn: {
    position: 'relative', minWidth: 0, minHeight: 0, overflow: 'hidden',
    display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '8px', boxSizing: 'border-box',
    backgroundColor: palette.replay.surface, border: `1px solid ${palette.border}`, borderRadius: tokens.borderRadiusLarge,
    '@media (max-width: 860px)': { aspectRatio: '1', alignSelf: 'start' },
  },
  map: { position: 'relative', flexShrink: 0 },
  mapInfo: { position: 'absolute', top: '8px', right: '8px', zIndex: 1 },
  help: {
    color: tokens.colorNeutralForeground3, flexShrink: 0,
    ':hover': { color: tokens.colorNeutralForeground1 },
    ':focus-visible': { color: tokens.colorNeutralForeground1 },
  },
  tipContent: { display: 'flex', flexDirection: 'column', gap: '6px', maxWidth: '340px' },
  canvas: { position:'absolute',inset:0,width:'100%',height:'100%',':focus-visible':{outline:`2px solid ${tokens.colorBrandStroke1}`,outlineOffset:'2px'} },
  side: {
    minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', gap: '10px', overflow: 'hidden',
    '@media (max-width: 860px)': { overflow: 'visible' },
  },
  group: {
    flexShrink: 0, display: 'flex', flexDirection: 'column', gap: '6px', padding: '10px',
    backgroundColor: palette.card, border: `1px solid ${palette.border}`, borderRadius: tokens.borderRadiusLarge,
  },
  eventsGroup: {
    flex: '1 1 0', minHeight: 0, overflow: 'hidden',
    '@media (max-width: 860px)': { flex: '0 0 auto' },
  },
  groupHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' },
  groupTitle: { display: 'flex', alignItems: 'center', gap: '2px', minWidth: 0 },
  players: {
    display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0, maxHeight: 'min(34vh, 300px)', overflowY: 'auto',
    // Short windows still need a usable, independently scrolling key-event card.
    '@media (max-height: 720px)': { maxHeight: 'min(16vh, 120px)' },
  },
  player: { justifyContent:'space-between',minWidth:0,gap:'6px',textAlign:'left' },
  name: { overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',minWidth:0 },
  muted: { color:tokens.colorNeutralForeground3 },
  events: {
    display: 'flex', flexDirection: 'column', flex: '1 1 0', minHeight: 0, overflowY: 'auto', gap: '4px',
    '@media (max-width: 860px)': { flex: '0 0 auto', maxHeight: '42vh' },
  },
  event: {
    justifyContent:'flex-start',textAlign:'left',whiteSpace:'normal',
    width:'100%',height:'auto',minHeight:'32px',flexShrink:0,boxSizing:'border-box',
    alignItems:'flex-start',padding:'5px 8px',lineHeight:tokens.lineHeightBase300,
    overflowWrap:'anywhere',wordBreak:'break-word',
  },
  transport: {
    width: '100%', alignSelf: 'end', display: 'flex', flexDirection: 'column', gap: '6px', padding: '10px 12px',
    backgroundColor: palette.card, border: `1px solid ${palette.border}`, borderRadius: tokens.borderRadiusLarge,
    boxSizing: 'border-box',
  },
  transportRow: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '10px' },
  progress: { width:'100%' },
  // Thousands of one-tick steps otherwise produce an opaque Fluent rail tick-mark overlay.
  progressRail: { '::before':{display:'none'} },
});
export interface ReplayJump { round:number; tick?:number; sequence:number }
/**
 * Map help stays a Fluent Tooltip, but its visibility is explicit so a keyboard focus
 * always shows it. Fluent intentionally ignores programmatic focus for mouse users;
 * a real Tab focus must still expose the complete map notes.
 */
function MapInfoTip({ content }: { content: ReactElement }) {
  const s=useStyles(),[open,setOpen]=useState(false),focused=useRef(false),hovered=useRef(false);
  const sync=()=>setOpen(focused.current||hovered.current);
  // Keep the tooltip usable while the pointer travels from the icon into the long notes;
  // the usual hide delay still belongs to Fluent.
  const tip=<div onPointerEnter={()=>{hovered.current=true;setOpen(true);}} onPointerLeave={()=>{hovered.current=false;}}>{content}</div>;
  return <Tooltip content={tip} relationship="description" withArrow visible={open}
    onVisibleChange={(_,data)=>{if(!data.visible&&!focused.current&&!hovered.current)setOpen(false);}}>
    <Button appearance="transparent" size="small" className={s.help} icon={<QuestionCircleIcon size={16} />} aria-label="地图说明"
      onFocus={()=>{focused.current=true;sync();}}
      onBlur={()=>{focused.current=false;sync();}}
      onPointerEnter={()=>{hovered.current=true;sync();}}
      onPointerLeave={()=>{hovered.current=false;}}
      onKeyDown={event=>{if(event.key==='Escape'){focused.current=false;hovered.current=false;setOpen(false);}}} />
  </Tooltip>;
}
/** Compact Fluent help entry for short, static notes (hover and keyboard focus). */
function HelpTip({ label, content }: { label: string; content: string }) {
  const s = useStyles();
  return <Tooltip content={content} relationship="description" withArrow>
    <Button appearance="transparent" size="small" className={s.help}
      icon={<QuestionCircleIcon size={16} />} aria-label={label} />
  </Tooltip>;
}
const blockAt=replayBlockAt;
const timeText=(tick:number,round:DesktopReplayRoundInfo,rate:number|null)=>rate===null?`原始 tick ${Math.round(tick)}`:`+${((tick-round.startTick)/rate).toFixed(2)} 秒`;

const colorRgb = (hex: string): [number, number, number] => {
  const value = Number.parseInt(hex.slice(1), 16);
  return [value >> 16 & 255, value >> 8 & 255, value & 255];
};
/** Canvas alpha compositing is intentional: areas stay translucent so the radar remains readable. */
const rgba = (hex: string, alpha: number) => {
  const [r, g, b] = colorRgb(hex);
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, alpha)).toFixed(3)})`;
};
const mapRadius = (map: { scale: number; width: number }, world: number) => world / map.scale * map.width / 1024;
const emptyEffects = (): ReplayEffectFrame => ({ flying: [], smoke: [], fire: [], flashes: [], explosions: [], blinds: new Set(), burns: new Set() });
const effectColor = (kind: DesktopReplayUtility['kind']) => kind === 'smoke' ? palette.utility.smoke
  : kind === 'flashbang' ? palette.utility.flashbang : kind === 'hegrenade' ? palette.utility.he
  : kind === 'fire' ? palette.utility.incendiary : palette.utility.decoy;
function radial(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number, color: string, alpha: number, inner = 0.05) {
  if (!(radius > 0) || !(alpha > 0)) return;
  const gradient = ctx.createRadialGradient(x, y, radius * inner, x, y, radius);
  gradient.addColorStop(0, rgba(color, alpha));
  gradient.addColorStop(0.55, rgba(color, alpha * 0.55));
  gradient.addColorStop(1, rgba(color, 0));
  ctx.fillStyle = gradient;
  ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.fill();
}
/** Layer 2: persistent smoke/fire areas. Both fade in/out from real ticks and never hide players. */
function drawArea(ctx: CanvasRenderingContext2D, map: ReplayMapDefinition, layerId: string,
  utility: DesktopReplayUtility, tick: number, rate: number | null, atlas?: CanvasImageSource) {
  if (!utility.position || resolveMapLayer(map, utility.position[2]) !== layerId) return;
  const point = worldToRadar(map, { x: utility.position[0], y: utility.position[1] });
  if (!point) return;
  paintReplayArea(ctx, utility, tick, rate, point.x, point.y, mapRadius(map, utility.kind === 'smoke' ? 184 : 158), atlas);
}
/** Layer 3: only the most recent flight, thinning and fading towards the tail. */
function drawTrail(ctx: CanvasRenderingContext2D, map: ReplayMapDefinition, layerId: string,
  trail: { tick: number; x: number; y: number; z: number; breakBefore?: boolean }[], color: string) {
  if (trail.length < 2) return;
  ctx.lineCap = 'round';
  for (let index = 0; index < trail.length - 1; index++) {
    const a = trail[index], b = trail[index + 1];
    if (b.breakBefore || resolveMapLayer(map, a.z) !== layerId || resolveMapLayer(map, b.z) !== layerId) continue;
    const from = worldToRadar(map, { x: a.x, y: a.y }), to = worldToRadar(map, { x: b.x, y: b.y });
    if (!from || !to) continue;
    const head = (b.tick - trail[0].tick) / Math.max(1, trail.at(-1)!.tick - trail[0].tick);
    const width = 0.9 + 5.3 * head;
    ctx.globalAlpha = 0.10 + 0.80 * Math.pow(head, 1.2);
    // A faint dark under-stroke keeps the trail readable over both dark and sand-coloured
    // radar areas without turning it into an opaque line.
    ctx.strokeStyle = 'rgba(17,24,33,0.45)'; ctx.lineWidth = width + 1.6;
    ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke();
    ctx.strokeStyle = color; ctx.lineWidth = width;
    ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke();
  }
  ctx.globalAlpha = 1;
}
/** Layer 4: small projectile glyphs, deliberately compact so they never mask the map. */
function drawProjectile(ctx: CanvasRenderingContext2D, map: ReplayMapDefinition, layerId: string,
  utility: DesktopReplayUtility, x: number, y: number, z: number, images: ReplayEffectImages) {
  if (resolveMapLayer(map, z) !== layerId) return;
  const point = worldToRadar(map, { x, y });
  if (!point) return;
  const icon = images[utility.variant ?? utility.kind];
  if (!icon) return;
  const height = 23, width = Math.min(27, height * icon.naturalWidth / icon.naturalHeight);
  ctx.save(); ctx.translate(point.x, point.y);
  ctx.fillStyle = 'rgba(17,24,33,0.88)';
  ctx.beginPath(); ctx.arc(0, 0, 15, 0, Math.PI * 2); ctx.fill();
  ctx.drawImage(icon, -width / 2, -height / 2, width, height);
  ctx.restore();
}
/** Layer 4: short, bright-but-bounded bursts. Players are painted later. */
function drawBurst(ctx: CanvasRenderingContext2D, map: ReplayMapDefinition, layerId: string,
  utility: DesktopReplayUtility, progress: number) {
  if (!utility.position || resolveMapLayer(map, utility.position[2]) !== layerId) return;
  const point = worldToRadar(map, { x: utility.position[0], y: utility.position[1] });
  if (!point) return;
  if (utility.kind === 'flashbang') {
    const radius = mapRadius(map, 120 + 620 * progress);
    radial(ctx, point.x, point.y, radius, '#ffffff', Math.pow(1 - progress, 1.7) * 0.58, 0.02);
    return;
  }
  paintReplayHEBurst(ctx, utility, progress, point.x, point.y, mapRadius(map, 1));
}
/** Layer 6: player status overlays above every player point. */
function drawStatusIcon(ctx: CanvasRenderingContext2D, x: number, y: number, kind: 'blind' | 'burn') {
  ctx.save(); ctx.translate(x, y); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  const outline = 'rgba(17,24,33,0.92)';
  if (kind === 'blind') {
    ctx.strokeStyle = outline; ctx.lineWidth = 4.4; ctx.beginPath(); ctx.ellipse(0, 0, 7.2, 4.4, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-6.8, 6.8); ctx.lineTo(6.8, -6.8); ctx.stroke();
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.9; ctx.beginPath(); ctx.ellipse(0, 0, 7.2, 4.4, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-6.8, 6.8); ctx.lineTo(6.8, -6.8); ctx.stroke();
    ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(0, 0, 1.7, 0, Math.PI * 2); ctx.fill();
  } else {
    ctx.strokeStyle = outline; ctx.lineWidth = 4.4;
    ctx.beginPath(); ctx.moveTo(0, 7.2); ctx.bezierCurveTo(-6.2, 2.7, -3.2, -2.7, -0.9, -7.1); ctx.bezierCurveTo(1.6, -2.4, 5.8, -0.2, 4.4, 3.1); ctx.bezierCurveTo(3.8, 5.3, 2.2, 7.2, 0, 7.2); ctx.stroke();
    ctx.fillStyle = palette.utility.incendiary; ctx.beginPath(); ctx.moveTo(0, 7.2); ctx.bezierCurveTo(-6.2, 2.7, -3.2, -2.7, -0.9, -7.1); ctx.bezierCurveTo(1.6, -2.4, 5.8, -0.2, 4.4, 3.1); ctx.bezierCurveTo(3.8, 5.3, 2.2, 7.2, 0, 7.2); ctx.fill();
  }
  ctx.restore();
}

export function ReplayPlayer({ metadata, initialPlayerId, active, jump }: {
  metadata:DesktopReplayMetadata;initialPlayerId:string;active:boolean;jump:ReplayJump|null;
}) {
  const s=useStyles(),first=metadata.rounds[0];
  const [roundNumber,setRoundNumber]=useState(first?.round??0),[tick,setTick]=useState(first?.startTick??0);
  const [playing,setPlaying]=useState(false),[speed,setSpeed]=useState(1),[floor,setFloor]=useState('auto');
  const [continuous,setContinuous]=useState(true);
  // Session identity makes reset immediate, even if the component survives a new import.
  const [nicknames,setNicknames]=useState({sessionId:metadata.sessionId,visible:false});
  const showNicknames=nicknames.sessionId===metadata.sessionId&&nicknames.visible;
  const effectImages=useRef<ReplayEffectImages>({});
  const [loading,setLoading]=useState(false),[error,setError]=useState<string|null>(null),[revision,setRevision]=useState(0);
  const [imageReady,setImageReady]=useState(false),[imageFailed,setImageFailed]=useState(false);
  const [selectedReplayPlayerId,setSelectedReplayPlayerId]=useState(()=>resolveReplayPlayerId(metadata.players,initialPlayerId));
  const [visibleEvents,setVisibleEvents]=useState<DesktopReplayEvent[]>([]),[appendSequence,setAppendSequence]=useState(0);
  const cache=useRef(new ReplayChunkCache()),clock=useRef(new ReplayClock(first?.startTick??0));
  const inFlight=useRef(false),generation=useRef(0),resume=useRef(false),failed=useRef(new Set<string>());
  const baseCanvas=useRef<HTMLCanvasElement>(null),canvas=useRef<HTMLCanvasElement>(null),box=useRef<HTMLDivElement>(null);
  const image=useRef<HTMLImageElement|null>(null),drawTimes=useRef<number[]>([]);
  const mapColumn=useRef<HTMLDivElement>(null),fit=useRef<()=>void>(()=>{});
  const roundMenu=useRoundMenu();
  const eventsList=useRef<HTMLDivElement>(null);
  const visibleEventsRef=useRef<DesktopReplayEvent[]>([]),seenEventIds=useRef(new Set<string>()),lastEventTick=useRef(-Infinity);
  const continuousRef=useRef(continuous);continuousRef.current=continuous;
  const info=metadata.rounds.find(r=>r.round===roundNumber);
  const block=info?blockAt(info,tick):undefined,chunk=block?cache.current.get(roundNumber,block.index):undefined;
  const playerIds=metadata.players.map(p=>p.id);
  const mapState=mapResourceState(metadata.map,replayMapAssets),map=mapState.definition;
  const frame=chunk?replayDisplayFrame(chunk,tick,metadata.maxInterpolationTicks,playerIds,map?z=>resolveMapLayer(map,z):undefined):null;
  const selectedIndex=metadata.players.findIndex(p=>p.id===selectedReplayPlayerId),selected=frame?.players.find(p=>p[0]===selectedIndex);
  const layerId=map?(floor==='auto'?resolveMapLayer(map,selected?.[4]??null):floor):null;
  const layer=map?.layers.find(l=>l.id===layerId),url=layer?replayMapAssets[layer.image]:undefined;
  const availableMap=mapState.status!=='unavailable'&&!imageFailed;
  const live=useRef({info,selectedPlayerId:selectedReplayPlayerId,active,map,layerId,imageReady,showNicknames});
  live.current={info,selectedPlayerId:selectedReplayPlayerId,active,map,layerId,imageReady,showNicknames};

  useEffect(()=>{setSelectedReplayPlayerId(current=>metadata.players.some(p=>p.id===current)?current:resolveReplayPlayerId(metadata.players,initialPlayerId));},[metadata.sessionId]);

  function resetVisibleEvents(){
    visibleEventsRef.current=[];seenEventIds.current.clear();lastEventTick.current=-Infinity;setVisibleEvents([]);
  }
  function trimVisibleEvents(at:number){
    const reached=Math.floor(at),kept=visibleEventsRef.current.filter(event=>Math.floor(event.tick)<=reached);
    lastEventTick.current=reached;
    if(kept.length===visibleEventsRef.current.length)return;
    visibleEventsRef.current=kept;seenEventIds.current=new Set(kept.map(event=>event.id));setVisibleEvents(kept);
  }
  function appendVisibleEvents(currentChunk:DesktopReplayChunk|undefined,round:DesktopReplayRoundInfo|null,at:number){
    if(!currentChunk||!round)return;
    const reached=Math.floor(at);
    if(reached<lastEventTick.current){visibleEventsRef.current=[];seenEventIds.current.clear();setVisibleEvents([]);}
    lastEventTick.current=reached;
    const result=appendReplayEvents(visibleEventsRef.current,seenEventIds.current,currentChunk.events,reached);
    if(!result.appended)return;
    visibleEventsRef.current=result.events;setVisibleEvents(result.events);setAppendSequence(sequence=>sequence+1);
  }
  useEffect(()=>{
    if(appendSequence===0)return;
    const list=eventsList.current;if(!list)return;
    // Never yank the list while the user is operating an event with the keyboard.
    if(list.contains(document.activeElement))return;
    const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
    list.scrollTo({top:list.scrollHeight,behavior:reduced?'auto':'smooth'});
  },[appendSequence]);

  function seek(next:number,round=live.current.info,resetEvents=false) {
    if(!round)return;
    clock.current.pause(performance.now(),metadata.tickRate);resume.current=false;setPlaying(false);
    const bounded=Math.max(round.startTick,Math.min(round.endTick,next));clock.current.seek(bounded,performance.now());setTick(bounded);setError(null);
    if(resetEvents)resetVisibleEvents();else trimVisibleEvents(bounded);
  }
  function selectRound(number:number,nextTick?:number){
    const round=metadata.rounds.find(r=>r.round===number);if(!round)return;
    live.current.info=round;setRoundNumber(number);seek(nextTick??round.startTick,round,true);
  }
  function toggle(){
    const round=live.current.info;if(!round||metadata.tickRate===null)return;
    if(clock.current.playing){clock.current.pause(performance.now(),metadata.tickRate);resume.current=false;setPlaying(false);setTick(clock.current.tick);}
    else {if(clock.current.tick>=round.endTick){clock.current.seek(round.startTick,performance.now());trimVisibleEvents(round.startTick);setTick(round.startTick);}clock.current.play(performance.now());setPlaying(true);}
  }
  async function load(round:DesktopReplayRoundInfo,index:number,prefetch=false){
    const key=`${round.round}:${index}`;
    if(inFlight.current||cache.current.get(round.round,index))return;
    if(failed.current.has(key)){if(!prefetch){setError('该回放数据块不可用，请重试。');resume.current=false;setLoading(false);}return;}
    inFlight.current=true;const token=generation.current;
    if(!prefetch)setLoading(true);
    try {
      const result=await window.cs2Analyst.replay.getChunk({sessionId:metadata.sessionId!,round:round.round,block:index});
      if(token!==generation.current)return;
      if(result.kind!=='success')throw new Error(result.message);
      const next=result.chunk;
      if(next.schemaVersion!==1||next.sessionId!==metadata.sessionId||next.matchId!==metadata.matchId||next.round!==round.round||next.block!==index)throw new Error('回放会话已更新。');
      cache.current.put(next);setRevision(n=>n+1);
      const currentRound=live.current.info;
      if(resume.current&&live.current.active&&!document.hidden&&currentRound?.round===round.round&&blockAt(currentRound,clock.current.tick)?.index===index){
        resume.current=false;clock.current.play(performance.now());setPlaying(true);
      }
    }catch(reason){if(token===generation.current){failed.current.add(key);if(!prefetch){setError(reason instanceof Error?reason.message:'回放数据不可用。');resume.current=false;setPlaying(false);}}}
    finally {if(token===generation.current){inFlight.current=false;if(!prefetch)setLoading(false);}}
  }
  function paint(current:DesktopReplayFrame|null,currentChunk:DesktopReplayChunk|undefined,at:number){
    const target=canvas.current,view=live.current;if(!target)return;
    const ctx=target.getContext('2d');if(!ctx)return;
    const started=performance.now();ctx.setTransform(1,0,0,1,0,0);ctx.clearRect(0,0,target.width,target.height);
    target.dataset.tick=String(at);target.dataset.playerCount='0';target.dataset.nicknameCount='0';
    target.dataset.effectAssets=String(Object.keys(effectImages.current).length);
    // Effects are a pure function of the chunk and the current tick: no accumulation, so
    // seek/pause/round changes cannot leave a stale area or reveal a future one.
    const effects=current&&currentChunk?replayEffectsAt(currentChunk,at,metadata.tickRate):emptyEffects();
    target.dataset.effects=String(effects.smoke.length+effects.fire.length+effects.flashes.length+effects.explosions.length);
    target.dataset.smoke=String(effects.smoke.length);target.dataset.fire=String(effects.fire.length);
    target.dataset.flying=String(effects.flying.length);target.dataset.flashes=String(effects.flashes.length);
    target.dataset.explosions=String(effects.explosions.length);target.dataset.blind=String(effects.blinds.size);target.dataset.burn=String(effects.burns.size);
    if(!view.map||!current||!view.imageReady||!view.layerId)return;
    const map=view.map,layerId=view.layerId;ctx.setTransform(target.width/map.width,0,0,target.height/map.height,0,0);
    // Layer 2: persistent areas. They are translucent and painted before every player mark.
    for(const utility of effects.smoke)drawArea(ctx,map,layerId,utility,at,metadata.tickRate,effectImages.current.fireAtlas);
    for(const utility of effects.fire)drawArea(ctx,map,layerId,utility,at,metadata.tickRate,effectImages.current.fireAtlas);
    // Layer 3: recent trails only, then layer 4 projectile icons/bursts.
    for(const flying of effects.flying)drawTrail(ctx,map,layerId,flying.trail,effectColor(flying.utility.kind));
    for(const flying of effects.flying)drawProjectile(ctx,map,layerId,flying.utility,flying.sample.x,flying.sample.y,flying.sample.z,effectImages.current);
    for(const burst of effects.flashes)drawBurst(ctx,map,layerId,burst.utility,burst.progress);
    for(const burst of effects.explosions)drawBurst(ctx,map,layerId,burst.utility,burst.progress);
    // Layer 5: players and their existing discrete markers.
    let drawnPlayers=0;
    const statusMarks:{x:number;y:number;kind:'blind'|'burn'}[]=[];
    const labels:{x:number;y:number;text:string;chosen:boolean}[]=[];
    for(const p of current.players){
      if(p[7]!==true||p[2]===null||p[3]===null||resolveMapLayer(map,p[4])!==view.layerId)continue;
      const point=worldToRadar(map,{x:p[2],y:p[3]});if(!point||point.x<0||point.y<0||point.x>map.width||point.y>map.height)continue;
      drawnPlayers++;
      const chosen=metadata.players[p[0]]?.id===view.selectedPlayerId,color=p[8]==='CT'?palette.replay.ct:p[8]==='T'?palette.replay.t:palette.replay.unknown;
      ctx.fillStyle=color;ctx.strokeStyle=chosen?palette.replay.selection:palette.replay.surface;ctx.lineWidth=chosen?3:2;
      ctx.beginPath();if(p[8]==='CT')ctx.rect(point.x-14,point.y-14,28,28);else ctx.arc(point.x,point.y,chosen?18:14,0,Math.PI*2);ctx.fill();ctx.stroke();
      if(p[5]!==null){const heading=radarHeading(p[5]);if(heading){ctx.strokeStyle=color;ctx.lineWidth=3;ctx.beginPath();ctx.moveTo(point.x+heading.x*20,point.y+heading.y*20);ctx.lineTo(point.x+heading.x*32,point.y+heading.y*32);ctx.stroke();}}
      ctx.font='bold 15px Segoe UI';ctx.textAlign='center';ctx.fillStyle=palette.replay.surface;ctx.fillText(String(p[0]+1),point.x,point.y+4);
      const playerId=metadata.players[p[0]]?.id;
      if(playerId&&effects.blinds.has(playerId))statusMarks.push({x:point.x+22,y:point.y-14,kind:'blind'});
      if(playerId&&effects.burns.has(playerId))statusMarks.push({x:point.x+22,y:point.y+14,kind:'burn'});
      if(view.showNicknames||chosen)labels.push({x:point.x,y:point.y,text:metadata.players[p[0]]?.nickname.slice(0,22)??'',chosen});
    }
    const bomb=current.bomb;
    if(bomb.position&&resolveMapLayer(map,bomb.position[2])===view.layerId){const p=worldToRadar(map,{x:bomb.position[0],y:bomb.position[1]});if(p){ctx.strokeStyle=palette.replay.bomb;ctx.lineWidth=3;ctx.strokeRect(p.x-8,p.y-8,16,16);}}
    // Layer 6: real blind/burn status above all player points; layer 7: selection label.
    for(const mark of statusMarks)drawStatusIcon(ctx,mark.x,mark.y,mark.kind);
    // Keep names readable in CSS pixels even when the radar is small. Try four nearby
    // offsets, avoiding prior labels/player centres where possible; no persistent layout state.
    const labelScale=Math.max(1,map.width/Math.max(1,target.clientWidth));
    const fontSize=Math.max(14,10*labelScale),padding=3*labelScale;
    const placed:{left:number;top:number;right:number;bottom:number}[]=[];
    for(const label of labels){
      ctx.font=`${fontSize}px Segoe UI`;ctx.textAlign='center';
      const width=ctx.measureText(label.text).width+padding*2,height=fontSize+padding*2;
      const gap=20+padding;
      const candidates=[[label.x,label.y-gap-height],[label.x,label.y+gap],
        [label.x+gap+width/2,label.y-height/2],[label.x-gap-width/2,label.y-height/2]].map(([cx,top])=>{
          const left=Math.max(2,Math.min(map.width-width-2,cx-width/2));
          top=Math.max(2,Math.min(map.height-height-2,top));
          const right=left+width,bottom=top+height;
          const collisions=placed.filter(r=>left<r.right&&right>r.left&&top<r.bottom&&bottom>r.top).length
            +labels.filter(p=>p.x+18>left&&p.x-18<right&&p.y+18>top&&p.y-18<bottom).length;
          return {left,top,right,bottom,collisions};
        });
      const rect=candidates.reduce((best,r)=>r.collisions<best.collisions?r:best);
      placed.push(rect);
      ctx.fillStyle='rgba(17,24,33,.86)';ctx.fillRect(rect.left,rect.top,width,height);
      ctx.fillStyle=label.chosen?palette.replay.selection:'#f5f7fa';
      ctx.fillText(label.text,rect.left+width/2,rect.top+padding+fontSize*.80);
    }
    target.dataset.nicknameCount=String(labels.length);
    const times=drawTimes.current;times.push(performance.now()-started);if(times.length>120)times.shift();
    target.dataset.playerCount=String(drawnPlayers);
    target.dataset.drawP95=String([...times].sort((a,b)=>a-b)[Math.floor(times.length*.95)]??0);
  }
  useEffect(()=>{
    let disposed=false;
    const images=Object.entries(replayEffectAssetUrls).map(([key,url])=>{
      const img=new Image();
      img.onload=()=>{if(!disposed)effectImages.current[key as keyof ReplayEffectImages]=img;};
      img.src=url;return img;
    });
    return()=>{disposed=true;for(const img of images)img.onload=null;effectImages.current={};};
  },[]);
  useEffect(()=>()=>{generation.current++;cache.current.clear();resume.current=false;},[metadata.sessionId]);
  useEffect(()=>{if(jump)selectRound(jump.round,jump.tick);},[jump?.sequence]);
  useEffect(()=>{
    if(!active||!metadata.available){clock.current.pause(performance.now(),metadata.tickRate);resume.current=false;setPlaying(false);return;}
    let raf=0,lastUi=0;
    const animate=(now:number)=>{
      let round=live.current.info;if(!round)return;
      let at=Math.min(round.endTick,clock.current.read(now,metadata.tickRate));
      if(at>=round.endTick&&clock.current.playing){
        const next=continuousRef.current?nextReplayRound(metadata,round.round):null;
        if(next){
          // The next round is a real metadata window; switch to its start and only resume
          // after its first block is available. The clock never runs ahead of loaded data.
          clock.current.pause(now,metadata.tickRate);
          live.current.info=next;setRoundNumber(next.round);clock.current.seek(next.startTick,now);
          resetVisibleEvents();setError(null);round=next;at=next.startTick;setTick(at);
          const firstBlock=blockAt(next,at),loaded=firstBlock?cache.current.get(next.round,firstBlock.index):undefined;
          if(loaded&&!document.hidden){clock.current.play(now);setPlaying(true);}
          else {resume.current=!document.hidden;setPlaying(false);}
        }else{
          clock.current.seek(round.endTick,now);clock.current.pause(now,metadata.tickRate);resume.current=false;setPlaying(false);
        }
      }
      const needed=blockAt(round,at),data=needed?cache.current.get(round.round,needed.index):undefined;
      if(!data&&needed){
        if(clock.current.playing){resume.current=true;clock.current.seek(at,now);clock.current.pause(now,metadata.tickRate);setPlaying(false);}
        void load(round,needed.index);
      }
      appendVisibleEvents(data,round,at);
      paint(data?replayDisplayFrame(data,at,metadata.maxInterpolationTicks,playerIds,live.current.map?z=>resolveMapLayer(live.current.map!,z):undefined):null,data,at);
      if(now-lastUi>=100){setTick(at);lastUi=now;}
      if(data&&needed&&!inFlight.current){const neighbor=[needed.index+1,needed.index-1].find(index=>round.blocks.some(b=>b.index===index)&&!cache.current.get(round.round,index)&&!failed.current.has(`${round.round}:${index}`));if(neighbor!==undefined)void load(round,neighbor,true);}
      raf=requestAnimationFrame(animate);
    };
    const hidden=()=>{if(document.hidden){clock.current.pause(performance.now(),metadata.tickRate);resume.current=false;setPlaying(false);}};
    raf=requestAnimationFrame(animate);document.addEventListener('visibilitychange',hidden);
    return()=>{cancelAnimationFrame(raf);document.removeEventListener('visibilitychange',hidden);clock.current.pause(performance.now(),metadata.tickRate);resume.current=false;};
  },[active,metadata.sessionId]);
  useEffect(()=>{
    image.current=null;setImageReady(false);setImageFailed(false);
    fit.current=()=>{};
    const base=baseCanvas.current;if(base)base.getContext('2d')?.clearRect(0,0,base.width,base.height);
    if(!url||mapState.status==='unavailable')return;
    const img=new Image();let disposed=false;
    img.onload=()=>{if(!disposed){image.current=img;setImageReady(true);drawBackground();}};
    img.onerror=()=>{if(!disposed)setImageFailed(true);};img.src=url;
    function drawBackground(){const base=baseCanvas.current;if(!base)return;const ctx=base.getContext('2d');ctx?.clearRect(0,0,base.width,base.height);if(image.current)ctx?.drawImage(image.current,0,0,base.width,base.height);}
    // Canvas pixel sizing lives in the layout effect below; drawing belongs to the image lifecycle.
    fit.current=drawBackground;drawBackground();
    return()=>{disposed=true;fit.current=()=>{};img.onload=null;img.onerror=null;};
  },[url,active]);
  // The radar keeps its 1:1 shape and fills the largest square the column allows; nothing here can push page height.
  useEffect(()=>{
    const host=mapColumn.current,map=box.current;
    if(!host||!map)return;
    const apply=()=>{
      const rect=host.getBoundingClientRect();
      const style=getComputedStyle(host);
      // The bounding box includes padding/borders under either box-sizing mode.
      const width=rect.width-parseFloat(style.borderLeftWidth)-parseFloat(style.borderRightWidth)-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight);
      const height=rect.height-parseFloat(style.borderTopWidth)-parseFloat(style.borderBottomWidth)-parseFloat(style.paddingTop)-parseFloat(style.paddingBottom);
      const size=Math.floor(Math.min(width,height));
      if(size<=0)return; // Mounted inactive Tabs have no measurable content box.
      if(map.style.width!==`${size}px`){map.style.width=`${size}px`;map.style.height=`${size}px`;}
      const pixels=Math.max(1,Math.round(size*(window.devicePixelRatio||1)));
      let resized=false;
      for(const c of [baseCanvas.current,canvas.current])if(c&&(c.width!==pixels||c.height!==pixels)){c.width=pixels;c.height=pixels;resized=true;}
      if(resized)fit.current();
    };
    apply();
    const observer=new ResizeObserver(apply);observer.observe(host);
    // Moving between monitors can change DPR without changing the CSS content box.
    let resolution:MediaQueryList;
    const watchResolution=()=>{
      resolution?.removeEventListener('change',watchResolution);
      apply();resolution=matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      resolution.addEventListener('change',watchResolution);
    };
    watchResolution();
    return()=>{observer.disconnect();resolution.removeEventListener('change',watchResolution);};
  },[availableMap]);
  if(!metadata.available||!info)return <section className={s.root} aria-label="比赛回放"><div className={s.group}><Title2>比赛回放</Title2><Body1>{metadata.unavailableReason??'本场缺少可靠回放窗口，比赛报告仍可用。'}</Body1></div></section>;
  const eventsHelp=`仅显示当前播放进度已到达的事件。同 tick 不推断先后顺序。${metadata.excludedRounds.length?` ${metadata.excludedRounds.length} 个回合窗口不可靠，未开放回放。`:''}`;
  return <section className={s.root} aria-label="比赛回放" data-replay-session={metadata.sessionId} data-replay-match={metadata.matchId} data-replay-round={roundNumber} data-replay-tick={tick} data-replay-cache={cache.current.size} data-replay-block={block?.index} data-replay-revision={revision} data-replay-map-ready={imageReady} data-replay-visible-events={visibleEvents.length} data-replay-continuous={continuous?'on':'off'} data-replay-nicknames={showNicknames?'on':'off'}>
    <div className={s.bar}>
      <div className={s.barTitle}><Title2>比赛回放</Title2><Caption1 className={s.muted}>R{roundNumber}</Caption1></div>
      <div className={s.controls}>
        <Button appearance="primary" className={s.playButton} aria-label={playing?'暂停回放':'播放回放'} aria-pressed={playing} disabled={metadata.tickRate===null||!active} onClick={toggle} icon={playing?<PauseIcon size={16}/>:<PlayIcon size={16}/>}>{playing?'暂停':'播放'}</Button>
        <Dropdown className={s.dropdown} aria-label="回放倍速" value={`${speed}×`} selectedOptions={[String(speed)]} disabled={metadata.tickRate===null} onOptionSelect={(_,d)=>{if(!d.optionValue)return;const value=Number(d.optionValue);clock.current.setSpeed(value,performance.now(),metadata.tickRate);setSpeed(value);}}>{[.25,.5,1,2,4].map(v=><Option key={v} value={String(v)}>{`${v}×`}</Option>)}</Dropdown>
        <Dropdown ref={roundMenu.triggerRef} className={s.dropdown} aria-label="回放回合" value={`R${roundNumber}`} selectedOptions={[String(roundNumber)]} listbox={{className:roundMenu.listboxClassName}} positioning={roundMenu.positioning} onOpenChange={roundMenu.onOpenChange} onOptionSelect={(_,d)=>d.optionValue&&selectRound(Number(d.optionValue))}>{metadata.rounds.map(r=><Option key={r.round} value={String(r.round)}>{`R${r.round}`}</Option>)}</Dropdown>
        <Switch className={s.switch} checked={continuous} onChange={(_,d)=>setContinuous(d.checked)} label="连续播放" />
        <Switch className={s.switch} checked={showNicknames} onChange={(_,d)=>setNicknames({sessionId:metadata.sessionId,visible:d.checked})} label="显示昵称" />
        {map&&map.layers.length>1?<Dropdown className={s.dropdown} aria-label="回放楼层" value={floor==='auto'?'跟随玩家':map.layers.find(l=>l.id===floor)?.label} selectedOptions={[floor]} onOptionSelect={(_,d)=>d.optionValue&&setFloor(d.optionValue)}><Option value="auto">跟随玩家</Option>{map.layers.map(l=><Option key={l.id} value={l.id}>{l.label}</Option>)}</Dropdown>:null}
      </div>
      <span className={s.spacer} />
      <Badge appearance="tint" color="warning">地图版本未确认</Badge>
    </div>
    <div className={s.body} data-replay-body>
      <div className={s.left} data-replay-left>
      {availableMap?<div ref={mapColumn} className={s.mapColumn} data-replay-map>
        <div className={s.mapInfo}>
          <MapInfoTip content={<div className={s.tipContent}>
            <span>全局比赛观察视角 · 朝向仅为记录方向，不表示看到了敌人。位置插值仅用于显示。</span>
            <span>CT 蓝方块 / T 橙圆点；白框为选中玩家。</span>
            <span>炸弹标记为事件关联位置；道具图标沿回放记录的真实垂直投影轨迹移动。</span>
            <span>烟雾/火焰按真实生效与结束记录显示；闪光/手雷为短促展示动画。拖尾只覆盖最近一段飞行；没有可靠轨迹时只显示效果，不伪造路径。</span>
            {map&&map.layers.length>1?<span>{layer?`当前${layer.label}；其他层点位隐藏。`:'选中玩家楼层未知，请手动选层。'}未知 Z 与共享高度边界不自动归层。</span>:null}
            {info.coverage==='partial'?<span>该回合存在缺失或歧义状态；断点不连接，未知状态不补齐。</span>:null}
          </div>} />
        </div>
        <div ref={box} className={s.map}>
          <canvas ref={baseCanvas} className={s.canvas} aria-hidden="true" />
          <canvas ref={canvas} className={s.canvas} tabIndex={0} role="img" aria-label={`R${roundNumber} 全局地图；空格播放或暂停，左右方向键定位，Home/End跳至回合起止。`} onKeyDown={e=>{if(e.key===' '){e.preventDefault();toggle();}else if(['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){e.preventDefault();const at=clock.current.read(performance.now(),metadata.tickRate);seek(e.key==='Home'?info.startTick:e.key==='End'?info.endTick:at+(e.key==='ArrowLeft'?-1:1)*(metadata.tickRate??1));}}} />
        </div>
      </div>:<div ref={mapColumn} className={s.mapColumn} data-replay-map><Body1>本机没有配套雷达资源或图片无法装载；仍可浏览事件与玩家状态。</Body1></div>}
        <div className={s.transport} data-replay-transport>
          <Slider aria-label="回放进度" className={s.progress} rail={{className:s.progressRail}}
            min={info.startTick} max={info.endTick} step={1} value={Math.round(tick)} aria-valuetext={timeText(tick,info,metadata.tickRate)} onChange={(_,d)=>seek(d.value)} />
          <div className={s.transportRow}>
            <Body1 data-replay-time>{timeText(tick,info,metadata.tickRate)} / {timeText(info.endTick,info,metadata.tickRate)}</Body1>
            {info.freezeEndTick!==null&&tick<info.freezeEndTick?<Badge appearance="outline">冻结阶段</Badge>:null}
            {loading?<Spinner size="tiny" label="加载回放数据…"/>:null}
            {error?<div role="alert"><Body1>{error}</Body1><Button size="small" onClick={()=>{failed.current.clear();setError(null);}}>重试</Button></div>:null}
            {metadata.tickRate===null?<Caption1>时钟不可靠，仅支持原始 tick 与事件定位，不能正常倍速播放。</Caption1>:null}
          </div>
        </div>
      </div>
      <div className={s.side} data-replay-rail>
        <div className={s.group}>
          <div className={s.groupHeader}><Caption1>玩家状态</Caption1><Caption1 className={s.muted}>{metadata.players.length} 人</Caption1></div>
          <div className={s.players} aria-label="回放玩家状态">
            {metadata.players.map((player,index)=>{const p=frame?.players.find(p=>p[0]===index);return <Button key={player.id} className={s.player} appearance={player.id===selectedReplayPlayerId?'secondary':'subtle'} aria-pressed={player.id===selectedReplayPlayerId} onClick={()=>setSelectedReplayPlayerId(player.id)} title={player.nickname}><span className={s.name}>{index+1}. {player.nickname}</span><Caption1>{p?.[8]??'Unknown'} · {p?.[7]===false?'阵亡':p?.[7]===true?`${p[6]??'—'} HP`:'未知'}</Caption1></Button>;})}
          </div>
        </div>
        <div className={`${s.group} ${s.eventsGroup}`}>
          <div className={s.groupHeader}><div className={s.groupTitle}><Caption1>关键事件</Caption1><HelpTip label="关键事件说明" content={eventsHelp} /></div><Caption1 className={s.muted}>已播放 · {visibleEvents.length}</Caption1></div>
          <div ref={eventsList} className={s.events} aria-label="回放事件浏览" aria-live="polite" aria-relevant="additions">{visibleEvents.length?visibleEvents.map(e=><Button key={e.id} className={s.event} appearance="subtle" size="small" data-replay-event={e.id} onClick={()=>seek(e.tick)}>{timeText(e.tick,info,metadata.tickRate)} · {e.description}</Button>):<Caption1>当前播放进度还没有关键事件。</Caption1>}</div>
        </div>
      </div>
    </div>
  </section>;
}
