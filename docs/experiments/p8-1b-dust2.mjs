// Standalone local validation. Emits aggregates and pseudonymous locators, never raw rows.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { Demoparser2Adapter } from '../../packages/dem-parser/dist/providers/demoparser2-adapter.js';
import { Demoparser2Provider } from '../../packages/dem-parser/dist/index.js';
import { convertToMatch } from '../../packages/dem-parser/dist/providers/converters.js';
import { planSpatialSampling, spatialFields } from '../../packages/dem-parser/dist/providers/spatial-evidence.js';
import { resolveRoundAliveState } from '../../packages/deep-review/dist/alive-state.js';
import native from '../../packages/demoparser-native/index.cjs';
import { buildInput, prefixMatch, resolvePrefix, fixedPlan } from './p8-1b-prefix.mjs';

const file = '.demo/dust2.dem'; // No override or replacement fixture.
const output = process.argv[2] ?? '.tmp/p8-1b/real.json';
const hash = x => createHash('sha256').update(typeof x==='string'?x:JSON.stringify(x)).digest('hex');
const tally = xs => Object.fromEntries([...new Set(xs)].sort().map(k=>[k,xs.filter(x=>x===k).length]));
const coverage = (rows, validators) => Object.fromEntries(Object.entries(validators).map(([key,validate]) => [key,
  {total:rows.length,present:rows.filter(r=>r[key]!==undefined&&r[key]!==null).length,
    valid:rows.filter(r=>validate(r[key])).length}]));
const finite = n => typeof n === 'number' && Number.isFinite(n);
const integer = n => Number.isSafeInteger(n) && n>=0;
const id = s => typeof s==='string'&&/^[1-9]\d*$/.test(s);
const positionFields = {X:finite,Y:finite,Z:finite,yaw:n=>finite(n)&&Math.abs(n)<=180,
  pitch:n=>finite(n)&&Math.abs(n)<=90,health:n=>integer(n)&&n<=100,
  is_alive:n=>typeof n==='boolean',team_num:n=>[0,1,2,3].includes(n),
  active_weapon_name:s=>typeof s==='string'&&s.length>0};
const progress = text => console.log(text);
try {
  const bytes = await readFile(file);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  assert.equal(sha256,'db90fe85aab023a1d2c8a5996182e6120d98ef494f02a070b17982b235e4958c');
  const raw = await new Demoparser2Adapter().parse(file), match = convertToMatch(raw);
  assert.ok([...raw.events,...raw.stateRows].every(r=>integer(r.tick)),'raw unlocatable tick');
  assert.equal(match.map,'de_dust2'); assert.equal(match.id,sha256);
  const provenance=native.getBindingProvenance();
  const report={status:'RUNNING',fixture:{filename:file,sha256,bytes:(await stat(file)).size,
    map:match.map,tickRate:match.tickRate,rounds:match.rounds.length,players:match.players.length,
    patchVersion:raw.header.patch_version,mapGeometryVersion:'unconfirmed'},
    parser:{adapter:'demoparser2',packageVersion:JSON.parse(await readFile('packages/demoparser-native/package.json')).version,
      source:provenance.source,target:provenance.target,binarySha256:provenance.verifiedSha256},
    nativeEventCounts:tally(raw.events.map(e=>e.event_name)),domainEventCounts:tally(match.rounds.flatMap(r=>r.events.map(e=>e.type))),
    nativeEventFields:Object.fromEntries([...new Set(raw.events.map(e=>e.event_name))].sort().map(name=>[name,
      [...new Set(raw.events.filter(e=>e.event_name===name).flatMap(Object.keys))].sort()])),
    boundaryRows:coverage(raw.stateRows,{tick:integer,steamid:id,team_num:n=>[0,1,2,3].includes(n),is_alive:n=>typeof n==='boolean'}),
    boundaries:match.rounds.map(r=>({round:r.number,startTick:r.startTick,freezeEndTick:r.freezeEndTick,endTick:r.endTick,
      snapshots:r.stateSnapshots.map(s=>({boundary:s.boundary,tick:s.tick,availability:s.availability,
        players:s.players.length,unidentified:s.unidentifiedPlayerCount})),lifecycle:tally(r.playerLifecycle.map(e=>e.type))})),
    eventCoverage:{damage:coverage(raw.events.filter(e=>e.event_name==='player_hurt'),
      {tick:integer,dmg_health:integer,dmg_armor:integer,health:integer,armor:integer,user_steamid:id,attacker_steamid:id}),
      kill:coverage(raw.events.filter(e=>e.event_name==='player_death'),{tick:integer,user_steamid:id,attacker_steamid:id,
        user_team_num:n=>[2,3].includes(n),attacker_team_num:n=>[2,3].includes(n)}),
      fire:coverage(raw.events.filter(e=>e.event_name==='weapon_fire'),{tick:integer,user_steamid:id,
        user_team_num:n=>[2,3].includes(n),weapon:s=>typeof s==='string'&&s.length>0}),
      lifecycle:coverage(raw.events.filter(e=>['player_spawn','player_disconnect','player_team'].includes(e.event_name)),
        {tick:integer,user_steamid:id,user_team_num:n=>[0,1,2,3].includes(n)}),
      bomb:coverage(raw.events.filter(e=>e.event_name.startsWith('bomb_')),
        {tick:integer,user_steamid:id,user_team_num:n=>[2,3].includes(n)}),
      utility:coverage(raw.events.filter(e=>['smokegrenade_detonate','hegrenade_detonate','flashbang_detonate','inferno_startburn','decoy_started'].includes(e.event_name)),{tick:integer,x:finite,y:finite,z:finite}),
      defuse:coverage(raw.events.filter(e=>e.event_name==='bomb_begindefuse'),{haskit:n=>typeof n==='boolean'})}};
  progress('raw adapter and field provenance complete');
  const parsed = await new Demoparser2Provider().parseWithReplay(file);
  assert.deepEqual(parsed.match,match);
  assert.ok(parsed.replay,'replay unavailable');
  const samples=[...new Map(parsed.spatial.events.flatMap(e=>e.samples.map(b=>[`${b.sample.requestedTick}:${b.sample.playerId}`,b.sample]))).values()];
  const coreSamples=[...new Map(parsed.spatial.events.flatMap(e=>e.samples
    .filter(b=>['at-event','boundary'].includes(b.sample.relation))
    .map(b=>[`${b.sample.requestedTick}:${b.sample.playerId}`,b.sample]))).values()];
  const alive=samples.filter(s=>s.alive===true);
  report.existingProducts={unchangedMatch:true,spatial:{sampling:parsed.spatial.sampling,
    coverage:parsed.spatial.coverage,representativeUniqueSamples:samples.length,
    representativeUniqueComplete:samples.filter(s=>s.coverage.status==='complete').length,
    representativeDedup:'requestedTick:playerId; last binding; includes omitted out-of-round context; not a coverage denominator',
    core:{uniqueRequestedPlayerSamples:coreSamples.length,actualExact:coreSamples.filter(s=>s.actualTick===s.requestedTick).length,
      complete:coreSamples.filter(s=>s.coverage.status==='complete').length},
    aliveSamples:alive.length,aliveWeaponPresent:alive.filter(s=>s.activeWeapon!==null).length,
    relevantBindings:parsed.spatial.events.reduce((n,e)=>n+e.samples.filter(b=>b.role==='relevant').length,0)},
    replay:{rounds:parsed.replay.rounds.length,frames:parsed.replay.rounds.reduce((n,r)=>n+r.frames.length,0),
      samples:parsed.replay.rounds.reduce((n,r)=>n+r.frames.reduce((s,f)=>s+f.players.length,0),0),
      excludedRounds:parsed.replay.excludedRounds,source:parsed.replay.source,hz:parsed.replay.hz,
      missingPlayerSamples:parsed.replay.rounds.reduce((n,r)=>n+r.coverage.missingPlayerSamples,0)}};
  // Keep aggregate sampling counts in the committed evidence, not full match tick lists.
  report.existingProducts.spatial.sampling=Object.fromEntries(Object.entries(parsed.spatial.sampling).map(([k,v])=>[k,Array.isArray(v)?v.length:v]));
  const probes=[], candidates=[], outcomes=[];
  const offline=match.rounds.map(r=>resolveRoundAliveState(r));
  let postRoundDeaths=0;
  for(const r of match.rounds){
    postRoundDeaths+=r.events.filter(e=>e.type==='kill'&&e.tick>r.endTick).length;
    const ticks=[...new Set(r.events.filter(e=>e.type==='kill'&&e.tick>=r.startTick&&e.tick<=r.endTick).map(e=>e.tick))];
    for(const g of ticks){
      const cutTick=g+1;
      if(cutTick>=r.endTick){outcomes.push('at-or-after-round-end');continue;}
      const prefix=prefixMatch(raw,cutTick), state=resolvePrefix(prefix.rounds.find(p=>p.number===r.number),cutTick);
      if(state.status!=='known'){outcomes.push(state.reason);continue;}
      const last=state.groups.at(-1);
      if(last?.after.CT!==1||last?.after.T!==1){outcomes.push('not-one-per-side');continue;}
      if(last.before.CT===1&&last.before.T===1){outcomes.push('not-formation');continue;}
      outcomes.push('candidate'); candidates.push({round:r.number,g,cutTick,state});
      for(const survivor of state.survivors)probes.push({roundNumber:r.number,cutTick,observer:survivor.id,side:survivor.side});
    }
  }
  const discovered=offline.flatMap(r=>r.groups.filter(g=>g.after?.CT===1&&g.after?.T===1).map(g=>`${r.round}:${g.tick}`));
  assert.deepEqual(candidates.map(c=>`${c.round}:${c.g}`),discovered);
  report.discovery={roundsChecked:match.rounds.length,offlineCoverage:tally(offline.map(r=>r.coverage.status)),
    atomicGroupsChecked:outcomes.length,postRoundDeathsExcluded:postRoundDeaths,outcomes:tally(outcomes),
    candidates:candidates.length,observerInputs:probes.length,offlineAndPrefixAgree:true};
  assert.ok(candidates.length>0,'no real 1v1 candidate');
  const ticks=candidates.map(c=>c.g);
  const exact=native.parseTicks(bytes,spatialFields,ticks);
  report.fixedQuery={fields:spatialFields,requestedTicks:ticks,returnedTicks:[...new Set(exact.map(r=>r.tick))].sort((a,b)=>a-b),
    fieldCoverage:coverage(exact,positionFields),aliveFieldCoverage:coverage(exact.filter(r=>r.is_alive),positionFields)};
  for(const c of candidates){
    const actual=exact.filter(r=>r.tick===c.g&&r.is_alive===true).map(r=>r.steamid).sort();
    assert.deepEqual(actual,c.state.survivors.map(p=>p.id).sort());
  }
  // Native capability probe only: existing adapter does not request/persist these fields.
  // Names verified in pinned native source maps.rs; never pass them to buildInput.
  const extraFields=['armor_value','active_weapon_ammo','total_ammo_left','inventory','balance','has_defuser','has_helmet'];
  const extras=native.parseTicks(bytes,extraFields,ticks);
  report.incrementalCapability={scope:'four-anchor native probe; not production/decision contract',fields:extraFields,
    inventoryElementValidation:{elements:extras.flatMap(r=>Array.isArray(r.inventory)?r.inventory:[]).length,
      invalid:extras.flatMap(r=>Array.isArray(r.inventory)?r.inventory:[]).filter(s=>typeof s!=='string'||!s.length).length},
    all:coverage(extras,{armor_value:integer,active_weapon_ammo:integer,total_ammo_left:integer,
      inventory:Array.isArray,balance:integer,has_defuser:n=>typeof n==='boolean',has_helmet:n=>typeof n==='boolean'}),
    alive:coverage(extras.filter(r=>exact.some(x=>x.tick===r.tick&&x.steamid===r.steamid&&x.is_alive)),
      {armor_value:integer,active_weapon_ammo:integer,total_ammo_left:integer,inventory:Array.isArray,balance:integer,
        has_defuser:n=>typeof n==='boolean',has_helmet:n=>typeof n==='boolean'})};
  progress('candidate discovery and exact native anchor queries complete');
  // Query the SAME original DEM with extra future ticks. This exercises native row
  // selection, not an alternate DEM. Mutation tests below begin at native-output boundary.
  const denseTicks=[...new Set([...ticks,...parsed.spatial.sampling.coreTicks])].sort((a,b)=>a-b);
  const denseRows=native.parseTicks(bytes,spatialFields,denseTicks);
  report.nativeCoreFields=coverage(denseRows,positionFields);
  const keyrow=r=>Object.fromEntries(['tick','steamid',...spatialFields].map(k=>[k,r[k]]));
  assert.deepEqual(exact.map(keyrow).sort((a,b)=>a.tick-b.tick||a.steamid.localeCompare(b.steamid)),
    denseRows.filter(r=>ticks.includes(r.tick)).map(keyrow).sort((a,b)=>a.tick-b.tick||a.steamid.localeCompare(b.steamid)));
  report.nativeQueryStability={status:'PASS',fixedTicks:ticks.length,denseTicks:denseTicks.length,
    comparedRows:exact.length,scope:'unchanged DEM; different requested future ticks'};
  report.candidates=[];
  const variants=['hidden-enemy-state','hidden-enemy-roster-lifecycle','future-combat','future-winner','future-deaths-final-state',
    'future-count-density','suffix-removed','future-clock','future-restart'];
  let comparisons=0;
  for(const p of probes){
    const base=buildInput(raw,exact,p);
    assert.equal(base.model.capabilities.describeSelf,'abstain');
    assert.ok(Object.values(base.local.auditedSelf).every(f=>f.status==='observed-server-fact'));
    assert.deepEqual(buildInput(raw,denseRows,p).model,base.model);
    for(const variant of variants){
      const altered=structuredClone(raw), rows=structuredClone(denseRows);
      const future=altered.events.filter(e=>e.tick>=p.cutTick);
      if(variant==='hidden-enemy-state')for(const r of rows)if(r.steamid!==p.observer){r.X=999999;r.Y=-999999;r.health=1;r.active_weapon_name='hidden';}
      if(variant==='hidden-enemy-roster-lifecycle'){
        const enemy=altered.stateRows.find(r=>r.tick<p.cutTick&&r.steamid!==p.observer)?.steamid;
        for(const r of altered.stateRows)if(r.steamid===enemy){r.is_alive=null;r.team_num=0;}
        altered.events.push({event_name:'player_disconnect',tick:p.cutTick-2,total_rounds_played:p.roundNumber-1,
          user_steamid:enemy,user_team_num:0});
      }
      if(variant==='future-combat')for(const e of future)if(['player_death','player_hurt','weapon_fire'].includes(e.event_name)){
        e.attacker_steamid=p.observer;e.dmg_health=999;e.health=0;e.weapon='future';}
      if(variant==='future-winner')for(const e of future)if(e.event_name==='round_end')e.winner=e.winner==='CT'?'T':'CT';
      if(variant==='future-deaths-final-state'){
        altered.events=altered.events.filter(e=>e.tick<p.cutTick||e.event_name!=='player_death');
        for(const r of altered.stateRows)if(r.tick>=p.cutTick)r.is_alive=!r.is_alive;
      }
      if(variant==='future-count-density')for(let n=0;n<4096;n++)altered.events.push({event_name:'weapon_fire',tick:p.cutTick+n,
        total_rounds_played:p.roundNumber-1,user_steamid:p.observer,user_team_num:2,weapon:'ak47'});
      if(variant==='suffix-removed'){
        altered.events=altered.events.filter(e=>e.tick<p.cutTick);altered.stateRows=altered.stateRows.filter(e=>e.tick<p.cutTick);
        altered.players=[];
      }
      if(variant==='future-clock')for(const e of future)e.game_time=-999999;
      if(variant==='future-restart')altered.events.push({event_name:'round_start',tick:p.cutTick+1,total_rounds_played:p.roundNumber-1,round:p.roundNumber});
      const changed=buildInput(altered,rows,p);
      assert.deepEqual(changed.model,base.model,variant);
      assert.deepEqual(changed.local.auditedSelf,base.local.auditedSelf,variant);
      assert.deepEqual(fixedPlan(p.cutTick),base.model.sampling.version ? {
        version:base.model.sampling.version,requestedTicks:base.model.sampling.requestedTicks,tickBudget:base.model.sampling.tickBudget}:null);
      comparisons++;
    }
    const privateText=JSON.stringify(base.model);
    assert.ok(!privateText.includes(sha256));
    for(const player of match.players)assert.ok(!privateText.includes(player.steamId));
    const c=candidates.find(c=>c.round===p.roundNumber), round=match.rounds.find(r=>r.number===p.roundNumber);
    report.candidates.push({round:p.roundNumber,anchorTick:c.g,cutTick:p.cutTick,observerAlias:`self-${p.side}`,
      baselineTick:c.state.baselineTick,formationRefs:round.events.flatMap((e,eventIndex)=>e.type==='kill'&&e.tick===c.g?
        [{round:round.number,type:'kill',tick:e.tick,eventIndex}]:[]),
      localRowLocator:{tick:c.g,side:p.side,selection:'sole alive baseline participant of this side'},
      retrospectiveOnly:{ticksUntilRoundEnd:round.endTick-p.cutTick},
      modelBodySha256:hash(base.model),auditedSelfSha256:hash(base.local.auditedSelf),prefixTickRate:base.local.prefixTickRate,
      describeSelf:base.model.capabilities.describeSelf,tacticalDecision:'abstain'});
  }
  report.prefixTests={status:'PASS',scope:'real native history plus controlled native-output mutations; not edited DEM bytes',
    variants,observerInputs:probes.length,comparisons,wholeModelBodyCompared:true,includesUnknownsAliasesSamplingMetadata:true,
    privateIdentifiersAbsent:true,nonemptyLocalOwnStateCompared:true,
    warning:'Strict model self values are unknown: this is refusal stability, NOT usable player-information validation.'};
  // Existing sampler FAIL witness, retaining a real complete historical prefix.
  const cut=candidates[0].cutTick;
  const originalPlan=planSpatialSampling(match), expanded=structuredClone(match);
  for(const r of expanded.rounds)for(let tick=Math.max(cut,r.freezeEndTick);tick<r.endTick;tick++)
    r.events.push({type:'weapon_fire',tick,shooter:probes[0].observer,weapon:'ak47'});
  const changedPlan=planSpatialSampling(expanded);
  const lost=originalPlan.optionalTicks.filter(t=>t<cut&&!changedPlan.optionalTicks.includes(t)&&!changedPlan.coreTicks.includes(t));
  assert.ok(lost.length>0,'expected default-budget prefix instability witness');
  report.offlineSampler={decisionSuitability:'FAIL',witnessStatus:'PASS',tickBudget:originalPlan.tickBudget,
    originalCore:originalPlan.coreTicks.length,changedCore:changedPlan.coreTicks.length,
    originalOptional:originalPlan.optionalTicks.length,changedOptional:changedPlan.optionalTicks.length,
    pastOptionalLost:lost.length,firstLostTicks:lost.slice(0,8),
    isolation:'fixed one-tick native query per cut; no offline sampling/coverage exported'};
  report.status='BLOCKED';
  report.validationHarness='PASS';
  report.blockers=['Native own-entity rows do not establish P8.1A availableTick; no verified player observation channel.',
    'Strict InformationState has no admitted gameplay facts; full P8.1B gate is NOT PASS.'];
  await writeFile(output,JSON.stringify(report,null,2)+'\n');
  progress(JSON.stringify({status:report.status,candidates:candidates.length,observerInputs:probes.length,
    comparisons,offlineSamplerDecisionSuitability:report.offlineSampler.decisionSuitability,output}));
}catch(error){
  await writeFile(output,JSON.stringify({status:error.code==='ENOENT'?'BLOCKED':'FAIL',realValidation:'NOT PASSED',
    reason:String(error.stack??error)},null,2)+'\n');
  console.error(error);process.exitCode=1;
}
