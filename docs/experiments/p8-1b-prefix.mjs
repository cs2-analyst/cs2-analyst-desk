// P8.1B experiment only. Never import from packages/ or apps/ production code.
import { convertToMatch } from '../../packages/dem-parser/dist/providers/converters.js';
import { isImpactId, isImpactTick, isImpactSide } from '../../packages/deep-review/dist/alive-state.js';

export const unknown = reason => ({ status: 'unknown', reason });
const sorted = xs => [...xs].sort();
export function prefixMatch(raw, cutTick) {
  if (!isImpactTick(cutTick) || cutTick === 0) throw new Error('invalid-cut');
  if ([...raw.events,...raw.stateRows].some(r=>!isImpactTick(r.tick))) throw new Error('unlocatable-source-tick');
  // Cut BEFORE conversion: future round restarts, metadata roster and clock must not
  // influence historical state. Full DEM id stays local, never in the model body.
  const before = rows => rows.filter(r => isImpactTick(r.tick) && r.tick < cutTick);
  return convertToMatch({ id: raw.id, header: { map_name: raw.header.map_name }, players: [],
    events: before(raw.events), stateRows: before(raw.stateRows) });
}

export function resolvePrefix(round, cutTick) {
  const fail = reason => ({ status: 'unknown', reason });
  if (!round || !isImpactTick(cutTick) || !isImpactTick(round.startTick)
      || !isImpactTick(round.freezeEndTick) || round.startTick > round.freezeEndTick
      || round.freezeEndTick >= cutTick) return fail('round-boundary');
  if (isImpactTick(round.endTick) && round.endTick < cutTick) return fail('round-ended');
  const baselines = (round.stateSnapshots ?? []).filter(s => s.boundary === 'freeze_end'
    && s.tick === round.freezeEndTick && s.tick < cutTick);
  if (baselines.length !== 1 || baselines[0].availability !== 'observed') return fail('baseline-missing');
  const base = baselines[0];
  if (base.unidentifiedPlayerCount !== 0) return fail('unidentified');
  const states = new Map();
  for (const p of base.players) {
    if (!isImpactId(p.steamId) || states.has(p.steamId)) return fail('identity-duplicate-or-unknown');
    if (p.participant === false) continue;
    if (p.participant !== true || !isImpactSide(p.side) || typeof p.alive !== 'boolean') return fail('state-unknown');
    states.set(p.steamId, { side: p.side, alive: p.alive });
  }
  // Scope deliberately restricted to a fully observed standard 5v5 freeze baseline.
  for (const side of ['CT', 'T']) if ([...states.values()].filter(p => p.side === side && p.alive).length !== 5)
    return fail('baseline-not-five-alive-per-side');
  if (states.size !== 10) return fail('baseline-roster');
  if (!Array.isArray(round.playerLifecycle)) return fail('lifecycle-unavailable');
  if (round.events.some(e=>!isImpactTick(e.tick))) return fail('unlocatable-event-tick');
  if (round.playerLifecycle.some(e => !isImpactTick(e.tick) || e.tick >= base.tick && e.tick < cutTick))
    return fail('prefix-lifecycle');
  const deaths = round.events.filter(e => e.type === 'kill' && e.tick < cutTick).sort((a,b) => a.tick-b.tick);
  const groups = [];
  for (let i = 0; i < deaths.length;) {
    const tick = deaths[i].tick, rows = [];
    while (i < deaths.length && deaths[i].tick === tick) rows.push(deaths[i++]);
    if (!isImpactTick(tick) || tick <= base.tick) return fail('death-baseline-conflict');
    const victims = new Set();
    const before = Object.fromEntries(['CT','T'].map(s => [s,[...states.values()].filter(p=>p.side===s&&p.alive).length]));
    // Validate the whole atomic group before applying any death. Never infer subtick order.
    for (const e of rows) {
      const p = states.get(e.victim);
      if (!isImpactId(e.victim) || !p || !p.alive || victims.has(e.victim)) return fail('invalid-or-duplicate-death');
      if (e.victimSide !== p.side) return fail('death-side-conflict');
      if (isImpactId(e.killer) && !states.has(e.killer)) return fail('killer-roster-gap');
      victims.add(e.victim);
    }
    for (const id of victims) states.get(id).alive = false;
    const after = Object.fromEntries(['CT','T'].map(s => [s,[...states.values()].filter(p=>p.side===s&&p.alive).length]));
    groups.push({ tick, before, after, victims: sorted(victims) });
  }
  return { status: 'known', baselineTick: base.tick, groups,
    survivors: [...states].filter(([,p]) => p.alive).map(([id,p]) => ({ id,side:p.side })).sort((a,b)=>a.id.localeCompare(b.id)) };
}

export function fixedPlan(cutTick) {
  if (!isImpactTick(cutTick) || cutTick === 0) throw new Error('invalid-cut');
  return { version: 'p8-1b-exact-previous-tick-v1', requestedTicks: [cutTick - 1], tickBudget: 1 };
}

export function buildInput(raw, rows, { roundNumber, cutTick, observer }) {
  const plan = fixedPlan(cutTick);
  const selected = rows.filter(r => r.tick === cutTick - 1 && r.steamid === observer);
  const row = selected.length === 1 ? selected[0] : null;
  const side = row?.team_num === 2 ? 'T' : row?.team_num === 3 ? 'CT' : null;
  // Never let hidden opponent roster/deaths/lifecycle gate an observer's own sample.
  const coherent = row && row.is_alive === true && side !== null;
  const finite = n => typeof n === 'number' && Number.isFinite(n);
  const known = value => ({ status:'observed-server-fact',value,observedTick:cutTick-1,availableTick:null,
    sourceChannel:'self-entity-state',localEvidenceRef:'e1' });
  const field = (valid,value) => coherent && valid ? known(value) : unknown(selected.length>1?'conflicting':'unavailable');
  const auditedSelf = {
    position: field(row && ['X','Y','Z'].every(k=>finite(row[k])), row ? {x:row.X,y:row.Y,z:row.Z}:null),
    view: field(row && finite(row.yaw)&&Math.abs(row.yaw)<=180&&finite(row.pitch)&&Math.abs(row.pitch)<=90,
      row ? {yaw:row.yaw,pitch:row.pitch}:null),
    health: field(row && Number.isSafeInteger(row.health)&&row.health>0&&row.health<=100,row?.health),
    side: field(side!==null,side), alive:field(row?.is_alive===true,true),
  };
  const self = Object.fromEntries(Object.entries(auditedSelf).map(([key,value])=>[key,
    unknown(value.status==='observed-server-fact'?'player-availability-time-unverified':value.reason)]));
  const model = { schema:'p8-1b-experiment-v1',observer:'self',cut:{tick:cutTick,phase:'before-tick'},
    self,publicAliveCounts:unknown('public-observation-channel-unverified'),
    enemyLastKnownPosition:unknown('no-observation-adapter'),inventory:unknown('not-in-approved-contract'),
    bombKnowledge:unknown('observation-channel-unverified'),
    sampling:{...plan,returnedTicks:row?[cutTick-1]:[],truncated:false,missing:!row},
    capabilities:{describeSelf:'abstain',
      describePublicAlive:'abstain',enemyLastKnownPosition:'unknown',routeSafety:'abstain',
      specificUtility:'abstain',counterStrafeOrReaction:'abstain',counterfactualWinGain:'abstain'},
    evidenceRefs:[] };
  // Native final-tick own state is a game-time proxy; not client receipt/attention evidence.
  // This qualification is part of the model-visible metadata, not a footnote omitted downstream.
  model.timeSemantics = 'own-entity-final-tick; client-receipt-and-perception-time-unverified';
  // Global prefix resolution is an independent local audit and cannot affect model output.
  let prefixState, prefixTickRate=null;
  try {
    const match=prefixMatch(raw,cutTick);
    prefixState=resolvePrefix(match.rounds.find(r=>r.number===roundNumber),cutTick);
    prefixTickRate=match.tickRate??null;
  } catch { prefixState=unknown('prefix-conversion-failed'); }
  const local = { demSha256:raw.id,round:roundNumber,actualTick:cutTick-1,observer,auditedSelf,
    locator:'parseTicks:tick+steamid',prefixState,prefixTickRate };
  return {model,local};
}
