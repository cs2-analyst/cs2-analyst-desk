// Aggregates only. Raw DEM, player IDs and coordinates never written to disk.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import native from '../../packages/demoparser-native/index.cjs';
import {Demoparser2Adapter} from '../../packages/dem-parser/dist/providers/demoparser2-adapter.js';
import {convertToMatch} from '../../packages/dem-parser/dist/providers/converters.js';
import {planSpatialSampling} from '../../packages/dem-parser/dist/providers/spatial-evidence.js';
import {resolveRoundAliveState} from '../../packages/deep-review/dist/alive-state.js';
import {replayMapDefinitions,worldToRadar} from '../../apps/desktop/shared/replay-map-geometry.ts';
import {parseOverview,pngDimensions} from '../../scripts/replay-resource-audit.mjs';
import {digest,fields,prefixContext,queryPlan,buildServerInput,variants,perturb} from './p8-1b-r-server.mjs';

const output=process.argv[2]??'.tmp/p8-1b-r/real.json';
const file='.demo/dust2.dem';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const normalized=rows=>rows.map(r=>Object.fromEntries(['tick','steamid',...fields].map(k=>[k,r[k]??null])))
  .sort((a,b)=>a.tick-b.tick||a.steamid.localeCompare(b.steamid));
await mkdir('.tmp/p8-1b-r',{recursive:true});
try {
  const bytes=await readFile(file),fixtureSha=sha(bytes);
  assert.equal(fixtureSha,'db90fe85aab023a1d2c8a5996182e6120d98ef494f02a070b17982b235e4958c');
  const raw=await new Demoparser2Adapter().parse(file),match=convertToMatch(raw);
  assert.equal(match.id,fixtureSha);assert.equal(match.map,'de_dust2');assert.equal(match.rounds.length,24);
  const provenance=native.getBindingProvenance();
  const nativeVersion=JSON.parse(await readFile('packages/demoparser-native/package.json')).version;
  const parserVersion=`${nativeVersion}:${provenance.verifiedSha256}`;
  const original=JSON.parse(await readFile('docs/p8-1b-validation-2026-10-25.json'));
  const historical=original.historical?.record??original;
  const expected=[...new Map(historical.realEvidence.candidates.map(c=>[c.round,{roundNumber:c.round,cutTick:c.cutTick}])).values()];
  const found=[];let checked=0;
  for(const round of match.rounds)for(const g of [...new Set(round.events.filter(e=>e.type==='kill'&&e.tick>=round.startTick&&e.tick<=round.endTick).map(e=>e.tick))]) {
    const params={roundNumber:round.number,cutTick:g+1};checked++;
    if(queryPlan(prefixContext(raw,params),params).eligible)found.push(params);
  }
  assert.deepEqual(found,expected);
  const offline=match.rounds.flatMap(r=>resolveRoundAliveState(r).groups.filter(g=>g.after?.CT===1&&g.after?.T===1).map(g=>({roundNumber:r.number,cutTick:g.tick+1})));
  assert.deepEqual(found,offline);
  console.log('Fixture identity, adapter and four prefix formations verified.');
  const sampling=planSpatialSampling(match);
  const dense=native.parseTicks(bytes,fields,sampling.coreTicks);
  const report={status:'BLOCKED',l1Status:'PASS',l1Scope:'four exact final-tick 1v1 anchors on pinned Dust2 fixture; native-output prefix boundary',
    fixture:{filename:file,sha256:fixtureSha,bytes:(await stat(file)).size,map:match.map,tickRate:match.tickRate,
      rounds:match.rounds.length,players:match.players.length,patchVersion:raw.header.patch_version,mapGeometryVersion:'unconfirmed'},
    parser:{adapter:'demoparser2',packageVersion:nativeVersion,target:provenance.target,source:provenance.source,binarySha256:provenance.verifiedSha256},
    discovery:{checkedDeathTicks:checked,formations:found.length,offlineAndPrefixAgree:true,offlineEnumerationUsesFullRoundEnd:true,
      scope:'offline enumeration locates locked anchors only; perturbations validate fixed-anchor prefix selection, NOT full candidate enumeration',
      fixedAnchorSelectionUsesFutureRoundEnd:false},
    candidates:[],prefix:{variants,comparisons:0,positiveControls:0,status:'PASS',
      compared:'entire body, plan, local reference mapping, selection, schema, coverage, missingness, truncation and metadata',
      scope:'controlled native-output mutations, NOT rewritten DEM decoding; single tick, NOT continuous trajectory'},
    nativeQueries:[],mapAudit:{},notRun:[]};
  for(const params of found) {
    const g=params.cutTick-1,context=prefixContext(raw,params),plan=queryPlan(context,params);
    assert.equal(plan.players.length,2);
    const rows=native.parseTicks(bytes,plan.fields,plan.requestedTicks,plan.players);
    assert.equal(rows.length,2);assert.ok(rows.every(r=>r.tick===g&&plan.players.includes(r.steamid)));
    assert.deepEqual(normalized(rows),normalized(dense.filter(r=>r.tick===g&&plan.players.includes(r.steamid))));
    assert.deepEqual(dense.filter(r=>r.tick===g&&r.is_alive===true).map(r=>r.steamid).sort(),plan.players);
    const baselineIds=context.source.stateRows.filter(r=>r.tick===context.state.baselineTick).map(r=>r.steamid).sort();
    const baseline=native.parseTicks(bytes,['team_num','is_alive'],[context.state.baselineTick],baselineIds);
    const stateKey=r=>({tick:r.tick,steamid:r.steamid,team_num:r.team_num,is_alive:r.is_alive});
    assert.deepEqual(baseline.map(stateKey).sort((a,b)=>a.steamid.localeCompare(b.steamid)),
      context.source.stateRows.filter(r=>r.tick===context.state.baselineTick).map(stateKey).sort((a,b)=>a.steamid.localeCompare(b.steamid)));
    const base=buildServerInput(raw,rows,params,parserVersion);
    assert.equal(base.body.coverage.knownFields,12);assert.equal(base.body.coverage.status,'complete');
    assert.deepEqual(buildServerInput(raw,dense,params,parserVersion),base);
    assert.ok(dense.some(r=>r.tick>=params.cutTick&&plan.players.includes(r.steamid)),'nonvacuous future entity rows');
    for(const variant of variants) {
      const altered=perturb(raw,dense,params,variant);
      assert.notDeepEqual(altered,{raw,rows:dense},`${variant} must actually mutate data`);
      assert.deepEqual(buildServerInput(altered.raw,altered.rows,params,parserVersion),base,`${params.roundNumber}:${variant}`);
      report.prefix.comparisons++;
    }
    const changed=structuredClone(rows);changed[1].health=changed[1].health===42?43:42;changed[1].X+=10;
    const positive=buildServerInput(raw,changed,params,parserVersion);
    assert.notDeepEqual(positive.body.players,base.body.players);assert.notDeepEqual(positive.body.distance,base.body.distance);
    const prior=structuredClone(raw);prior.events=prior.events.filter(e=>!(e.event_name==='player_death'&&e.tick===g));
    assert.equal(buildServerInput(prior,rows,params,parserVersion).body.selection.eligible,false);
    report.prefix.positiveControls+=2;
    const bodyText=JSON.stringify(base.body);
    for(const id of match.players.map(p=>p.steamId))assert.ok(!bodyText.includes(id));
    assert.ok(!bodyText.includes(fixtureSha));
    const round=match.rounds.find(r=>r.number===params.roundNumber);
    const refs=round.events.flatMap((e,eventIndex)=>e.type==='kill'&&e.tick===g?[{round:round.number,type:e.type,tick:g,eventIndex}]:[]);
    const prefixRefs=base.localRefs.find(r=>r.id==='formation');
    const map=replayMapDefinitions.find(m=>m.id==='de_dust2');
    const mapping=rows.map(r=>{const p=worldToRadar(map,{x:r.X,y:r.Y});assert.ok(p&&Number.isFinite(p.x)&&Number.isFinite(p.y));
      return {inside:p.x>=0&&p.x<=1024&&p.y>=0&&p.y<=1024,error:Math.hypot((p.x*map.scale+map.posX)-r.X,(map.posY-p.y*map.scale)-r.Y)};});
    report.candidates.push({round:round.number,anchorTick:g,cutTick:params.cutTick,baselineTick:context.state.baselineTick,
      formationRefs:refs,prefixEvidence:prefixRefs,before:base.body.formation.before,after:base.body.formation.after,
      atomicDeaths:base.body.formation.atomicDeaths,bodySha256:digest(base.body),
      snapshots:base.body.players.map(p=>({alias:p.alias,actualTick:g,knownFields:Object.keys(p.fields),missingFields:[],
        localLocator:'native parseTicks tick + sole alive baseline participant of side',
        recordSha256:base.localRefs.find(r=>r.id===`state-${p.alias}`).canonicalRecordSha256})),
      coverage:base.body.coverage,distance:{horizontal:base.body.distance.horizontal,euclidean:base.body.distance.euclidean,
        unit:'DEM-world-unit',evidenceRefs:base.body.distance.evidenceRefs},
      mapping:{rows:mapping.length,inBounds:mapping.filter(p=>p.inside).length,maxArithmeticRoundTripError:Math.max(...mapping.map(p=>p.error))},
      retrospectiveOnly:{ticksUntilRoundEnd:round.endTick-params.cutTick,excludedFromInput:true},qualifiedCoachingDecision:false});
    report.nativeQueries.push({round:round.number,fields:plan.fields,requestedTicks:plan.requestedTicks,returnedTicks:[...new Set(rows.map(r=>r.tick))],
      requestedPlayers:plan.players.length,returnedRows:rows.length,coverage:'12/12 normalized fields',tickBudget:1,
      comparison:{denseTicks:sampling.coreTicks.length,allPlayersAtAnchor:10,selectedRowsEqual:true,aliveSetsEqual:true,
        prefixFreezeRows:baseline.length,prefixFreezeExactQueryEqual:true},playerSelector:'two survivors derived only from prefix'});
    console.log(`Round ${round.number}: exact state, full input perturbations and positive controls passed.`);
  }
  const expanded=structuredClone(match),cut=found[0].cutTick;
  for(const r of expanded.rounds)for(let t=Math.max(cut,r.freezeEndTick);t<r.endTick;t++)r.events.push({type:'weapon_fire',tick:t,shooter:'local',weapon:'ak47'});
  const changedPlan=planSpatialSampling(expanded);
  const lost=sampling.optionalTicks.filter(t=>t<cut&&!changedPlan.optionalTicks.includes(t)&&!changedPlan.coreTicks.includes(t));
  assert.ok(lost.length>0);
  report.offlineSampler={status:'BLOCKED',witness:'PASS',originalCore:sampling.coreTicks.length,changedCore:changedPlan.coreTicks.length,
    originalOptional:sampling.optionalTicks.length,changedOptional:changedPlan.optionalTicks.length,pastOptionalLost:lost.length,
    firstLostTicks:lost.slice(0,8),productionModified:false,isolatedFromExperimentalInput:true};
  const resources=JSON.parse(await readFile('docs/replay-resources.json')),resource=resources.maps.find(m=>m.map==='de_dust2');
  const localRadar=await readFile('apps/desktop/renderer/src/assets/replay-maps/de_dust2.png');
  const map=replayMapDefinitions.find(m=>m.id==='de_dust2');
  const localOverview=await readFile('apps/desktop/renderer/src/assets/replay-overviews/de_dust2.txt');
  assert.equal(sha(localRadar),resource.images[0].sha256);assert.equal(sha(localOverview),resource.overview.sha256);
  assert.deepEqual(pngDimensions(localRadar),{width:1024,height:1024});
  const overview=parseOverview(localOverview.toString('utf8'),'de_dust2');
  assert.deepEqual(overview.transform,{posX:map.posX,posY:map.posY,scale:map.scale});
  report.mapAudit={definition:map,resourceId:resources.resourceId,sourceOverview:resource.overview,
    sourceImages:resource.images,shippedRadarSha256:sha(localRadar),shippedOverviewSha256:sha(localOverview),
    resourceIntegrity:{status:'PASS',scope:'local image and original overview digests and numeric transform match pinned manifest; NOT DEM build equivalence'},
    numericProjection:{status:'PASS',scope:'8 exact real positions; arithmetic mapping and inverse only',
      rows:8,inBounds:report.candidates.reduce((n,c)=>n+c.mapping.inBounds,0),
      maxArithmeticRoundTripError:Math.max(...report.candidates.map(c=>c.mapping.maxArithmeticRoundTripError)),
      independentGeographicError:null},
    matchedMapProjection:{status:'BLOCKED',reason:'DEM map build and pinned resource version correspondence unconfirmed; numeric round trip is not landmark ground truth'},
    xyzDistance:{status:'PASS',scope:'four endpoint pairs in same native XYZ frame, world units; no physical-unit, route or support claim'},
    navigation:{status:'BLOCKED',reason:'no matched and validated navigation topology'},
    staticLos:{status:'BLOCKED',reason:'no matched collision/occluder dataset or ground-truth cases'},
    multipleFloors:{status:'BLOCKED',reason:'Dust2 single unbounded radar layer; no validated floor boundaries; Z difference is not a floor label'},
    dynamicOcclusion:{status:'BLOCKED',reason:'effect origins and lifetimes do not validate smoke volume/visibility'},
    support:{status:'BLOCKED',reason:'requires validated route, timing and engagement conditions'},
    geometryExecution:{status:'NOT RUN',reason:'matching geometry and benchmark cases absent; no replacement downloaded'},
    movementWindow:{status:'NOT RUN',reason:'single-tick experiment; no continuous or windowed trajectory query'}};
  report.notRun=['POV and attention: UNSUPPORTED by product decision','native decoder on rewritten/truncated DEM bytes',
    'historical windows, movement trajectories and subtick order','matched map geometry benchmarks','other fixtures / cross-map / Electron UI / installed-app tests',
    'backend deployment, SQLite, authentication, models, expert coaching labels, corpus protocols and P8.2'];
  await writeFile(output,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({l1:report.l1Status,overall:report.status,comparisons:report.prefix.comparisons,positiveControls:report.prefix.positiveControls,lost:lost.length}));
} catch(error) {
  await writeFile(output,JSON.stringify({status:error.code==='ENOENT'?'BLOCKED':'FAIL',l1Status:'NOT PASS',reason:String(error.stack??error)},null,2)+'\n');
  console.error(error);process.exitCode=1;
}
