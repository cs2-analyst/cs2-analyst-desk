// P8.1B-R experiment only. No production API; accepts trusted local native output.
import {createHash} from 'node:crypto';
import {prefixMatch, resolvePrefix} from './p8-1b-prefix.mjs';

export const digest = x => createHash('sha256').update(typeof x === 'string' ? x : JSON.stringify(x)).digest('hex');
export const fields = ['X','Y','Z','yaw','pitch','health','is_alive','team_num','active_weapon_name'];
const tick = n => Number.isSafeInteger(n) && n >= 0;
const finite = n => typeof n === 'number' && Number.isFinite(n);
const unknown = reason => ({status:'unknown',reason});
const pick = (r, keys) => Object.fromEntries(keys.map(k=>[k,r[k] ?? null]));
const canonical = rows => [...new Map(rows.map(r=>[JSON.stringify(r),r])).entries()]
  .sort(([a],[b])=>a.localeCompare(b)).map(([,r])=>r);
const eventKeys = ['event_name','tick','total_rounds_played','round','is_warmup_period',
  'user_steamid','user_team_num','attacker_steamid','attacker_team_num','weapon','winner','team','oldteam'];
const relevant = new Set(['round_start','round_freeze_end','round_end','player_death','player_spawn','player_disconnect','player_team']);

export function prefixContext(raw, {cutTick,roundNumber}) {
  if (!tick(cutTick) || cutTick === 0 || !Number.isSafeInteger(roundNumber) || roundNumber < 1) throw Error('invalid-target');
  // An unlocatable row cannot safely be called future. Fail closed, never discard it silently.
  if ([...raw.events,...raw.stateRows].some(r=>!tick(r.tick))) return {state:unknown('unlocatable-source-tick')};
  const events = canonical(raw.events.filter(r=>r.tick<cutTick && relevant.has(r.event_name)).map(r=>pick(r,eventKeys)));
  // The production converter can omit malformed deaths; that is not evidence of no death.
  if(events.some(r=>r.event_name==='player_death' && !(typeof r.user_steamid==='string'&&/^[1-9]\d*$/.test(r.user_steamid))))
    return {state:unknown('unidentified-prefix-death')};
  const stateRows = canonical(raw.stateRows.filter(r=>r.tick<cutTick).map(r=>pick(r,['tick','steamid','team_num','is_alive'])));
  const keys = stateRows.map(r=>`${r.tick}:${r.steamid}`);
  if (new Set(keys).size !== keys.length) return {state:unknown('conflicting-boundary-row')};
  const source = {id:'local-prefix',header:{map_name:raw.header.map_name},players:[],events,stateRows};
  try {
    const match = prefixMatch(source,cutTick), round = match.rounds.find(r=>r.number===roundNumber);
    const state = resolvePrefix(round,cutTick);
    return {state,source,round};
  } catch { return {state:unknown('prefix-conversion-failed')}; }
}

export function queryPlan(context, {cutTick}) {
  const last = context.state.groups?.at(-1);
  const eligible = context.state.status==='known' && last?.tick===cutTick-1
    && last.after.CT===1 && last.after.T===1 && !(last.before.CT===1 && last.before.T===1);
  return {version:'p8-1b-r-exact-final-tick-v1',requestedTicks:eligible?[cutTick-1]:[],
    players:eligible?context.state.survivors.map(p=>p.id).sort():[],fields:[...fields],tickBudget:1,eligible};
}

export function distance(a,b) {
  if (![a,b].every(p=>p && ['x','y','z'].every(k=>finite(p[k])))) return unknown('invalid-xyz');
  const delta={x:b.x-a.x,y:b.y-a.y,z:b.z-a.z};
  const horizontal=Math.hypot(delta.x,delta.y),euclidean=Math.hypot(delta.x,delta.y,delta.z);
  if (![...Object.values(delta),horizontal,euclidean].every(finite)) return unknown('numeric-overflow');
  return {status:'observed-server-calculation',delta,horizontal,euclidean,unit:'DEM-world-unit',
    semantics:'endpoint distance only; no route, floor, LOS, travel time or support inference'};
}

export function buildServerInput(raw, rows, params, parserVersion='local-pinned-native') {
  const context=prefixContext(raw,params), plan=queryPlan(context,params), g=params.cutTick-1;
  const refs=[],localRefs=[];
  const body={schema:'p8-1b-r-server-facts-experiment-v1',scope:'L1-server-facts; NOT PlayerKnowledge',
    cut:{tick:params.cutTick,phase:'before-tick'},timeSemantics:'final state at previous whole tick; same-tick deaths atomic; no subtick order',
    parserVersion,selection:{eligible:plan.eligible,reason:plan.eligible?'prefix-one-per-side-formation':context.state.reason??'not-formation'},
    sampling:{version:plan.version,requestedTicks:plan.requestedTicks,fields:plan.fields,playerCount:plan.players.length,
      tickBudget:1,returnedTicks:[],missingPlayers:[],truncated:false},
    formation:unknown('prefix-unavailable'),players:[],coverage:{knownFields:0,totalFields:0,status:'unavailable'},
    distance:unknown('missing-endpoints'),evidenceRefs:refs,
    capabilities:{playerKnowledge:'UNSUPPORTED',pov:'UNSUPPORTED',attention:'UNSUPPORTED',
      route:'BLOCKED',los:'BLOCKED',dynamicOcclusion:'BLOCKED',support:'BLOCKED',tacticalJudgment:'BLOCKED'},
    metadata:{map:raw.header.map_name,mapGeometryVersion:'unconfirmed',continuousTrajectory:'NOT RUN',availableTick:'not-established'}};
  if (!plan.eligible) return {body,plan,localRefs};
  const baseline=context.source.stateRows.filter(r=>r.tick===context.state.baselineTick);
  const deaths=context.source.events.filter(r=>r.event_name==='player_death'&&r.tick>=context.state.baselineTick);
  refs.push({id:'formation',kind:'server-prefix-alive-reduction',tick:g});
  localRefs.push({id:'formation',baselineTick:context.state.baselineTick,baselineDigest:digest(baseline),
    deathRefs:deaths.map(r=>({tick:r.tick,kind:r.event_name,canonicalRecordSha256:digest(r)}))});
  const last=context.state.groups.at(-1);
  body.formation={status:'observed-server-fact',before:last.before,after:last.after,observedTick:g,
    atomicDeaths:last.victims.length,evidenceRef:'formation',decisionOpportunity:'NOT ESTABLISHED'};
  for (const survivor of [...context.state.survivors].sort((a,b)=>a.side.localeCompare(b.side))) {
    const alias=survivor.side, ref=`state-${alias}`;
    const selected=canonical(rows.filter(r=>r.tick===g&&r.steamid===survivor.id).map(r=>pick(r,['tick','steamid',...fields])));
    const row=selected.length===1?selected[0]:null;
    const reason=selected.length>1?'conflicting':selected.length===0?'unavailable':'invalid';
    const expected=survivor.side==='CT'?3:2;
    const coherent=row?.team_num===expected && row?.is_alive===true;
    const field=(valid,value)=>coherent&&valid?{status:'observed-server-fact',value,observedTick:g,evidenceRef:ref}:unknown(reason);
    const values={position:field(row&&['X','Y','Z'].every(k=>finite(row[k])),row?{x:row.X,y:row.Y,z:row.Z}:null),
      health:field(Number.isSafeInteger(row?.health)&&row.health>0&&row.health<=100,row?.health),
      view:field(finite(row?.yaw)&&Math.abs(row.yaw)<=180&&finite(row?.pitch)&&Math.abs(row.pitch)<=90,row?{yaw:row.yaw,pitch:row.pitch}:null),
      side:field(coherent,alias),alive:field(coherent,true),
      weapon:field(typeof row?.active_weapon_name==='string'&&row.active_weapon_name.length>0,row?.active_weapon_name)};
    body.players.push({alias,fields:values});
    body.coverage.totalFields+=Object.keys(values).length;
    body.coverage.knownFields+=Object.values(values).filter(v=>v.status==='observed-server-fact').length;
    if (selected.length) body.sampling.returnedTicks=[g];
    if (!row) body.sampling.missingPlayers.push(alias);
    if (row) {
      refs.push({id:ref,kind:'native-exact-entity',requestedTick:g,actualTick:row.tick});
      localRefs.push({id:ref,tick:g,playerId:survivor.id,canonicalRecordSha256:digest(row)});
    }
  }
  body.coverage.status=body.coverage.knownFields===body.coverage.totalFields?'complete':'partial';
  const positions=body.players.map(p=>p.fields.position);
  if (positions.every(p=>p.status==='observed-server-fact')) body.distance={...distance(...positions.map(p=>p.value)),evidenceRefs:['state-CT','state-T']};
  return {body,plan,localRefs};
}

export const variants=['future-enemy-state','future-combat-add','future-combat-remove','future-outcome-end-state',
  'future-roster-lifecycle-restart','future-budget-flood','remove-entire-suffix','future-clock',
  'row-order-exact-duplicates','future-density'];
export function perturb(raw,rows,params,variant) {
  const r=structuredClone(raw),s=structuredClone(rows),cut=params.cutTick;
  const future=r.events.filter(e=>e.tick>=cut);
  if (variant==='future-enemy-state') for(const row of s) if(row.tick>=cut)
    Object.assign(row,{X:98765,Y:-98765,Z:12345,health:1,yaw:179,pitch:-89,active_weapon_name:'future'});
  if (variant==='future-combat-add'||variant==='future-budget-flood'||variant==='future-density') {
    const count=variant==='future-budget-flood'?30000:variant==='future-density'?513:4;
    for(let i=0;i<count;i++)r.events.push({event_name:['player_hurt','player_death','weapon_fire','smokegrenade_detonate'][i%4],
      tick:cut+i,total_rounds_played:params.roundNumber-1,user_steamid:'987654321',user_team_num:2});
  }
  if (variant==='future-combat-remove')r.events=r.events.filter(e=>e.tick<cut||!['player_hurt','player_death','weapon_fire','smokegrenade_detonate','flashbang_detonate','inferno_startburn'].includes(e.event_name));
  if (variant==='future-outcome-end-state') {
    for(const e of future)if(e.event_name==='round_end')e.winner='future-outcome';
    for(const row of r.stateRows)if(row.tick>=cut)Object.assign(row,{is_alive:false,team_num:0});
  }
  if (variant==='future-roster-lifecycle-restart') {
    r.players=[{steamid:'987654321',name:'FUTURE-SECRET'}];
    r.effectEvents=[{event_name:'inferno_expire',tick:cut+1}];
    r.offlineCoverage={status:'future-only',count:999999};r.finalScore=[99,0];
    for(const event_name of ['round_start','player_spawn','player_disconnect','player_team'])r.events.push({event_name,tick:cut,
      total_rounds_played:params.roundNumber-1,round:params.roundNumber,user_steamid:'987654321',user_team_num:2});
    r.stateRows.push({tick:cut,steamid:'987654321',team_num:2,is_alive:true});
  }
  if(variant==='remove-entire-suffix') {
    r.events=r.events.filter(e=>e.tick<cut);r.stateRows=r.stateRows.filter(e=>e.tick<cut);r.players=[];
    if(Array.isArray(r.effectEvents))r.effectEvents=r.effectEvents.filter(e=>e.tick<cut);
    return {raw:r,rows:s.filter(e=>e.tick<cut)};
  }
  if(variant==='future-clock') {for(const e of future)e.game_time=-999999;r.header.playback_time=999999;r.header.tick_rate=128;}
  if(variant==='row-order-exact-duplicates') {
    r.events=[...r.events,...r.events.map(e=>({...e}))].reverse();
    r.stateRows=[...r.stateRows,...r.stateRows.map(e=>({...e}))].reverse();
    return {raw:r,rows:[...s,...s.map(e=>({...e}))].reverse()};
  }
  return {raw:r,rows:s};
}
