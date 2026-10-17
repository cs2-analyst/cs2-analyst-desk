// Recheck native release evidence before exposing it in Replay. Local fixture only.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { Demoparser2Provider } from '../packages/dem-parser/dist/index.js';
import native from '../packages/demoparser-native/index.cjs';
import { fileURLToPath } from 'node:url';
import { ReplaySession } from '../apps/desktop/electron/replay-session.ts';
import { execFileSync } from 'node:child_process';
import { stripTypeScriptTypes } from 'node:module';

const file = new URL('../.demo/dust2.dem', import.meta.url), bytes = readFileSync(file);
const sha256 = createHash('sha256').update(bytes).digest('hex');
assert.equal(sha256, 'db90fe85aab023a1d2c8a5996182e6120d98ef494f02a070b17982b235e4958c');
const kinds = {weapon_smokegrenade:'smoke',weapon_flashbang:'flashbang',weapon_hegrenade:'hegrenade',weapon_molotov:'molotov',weapon_incgrenade:'incendiary',weapon_decoy:'decoy'};
const raw = native.parseEvents(bytes, ['weapon_fire','grenade_thrown'], ['team_num'], ['total_rounds_played','is_warmup_period']);
const parsed = await new Demoparser2Provider().parseWithReplay(fileURLToPath(file));
const {match,replay} = parsed;
assert.ok(replay);
const roster = new Set(replay.players);
const releases = replay.rounds.flatMap(r=>r.events.filter(({event:e})=>e.type==='weapon_fire'&&kinds[e.weapon]).map(({event:e,eventIndex})=>({round:r.round,eventIndex,tick:e.tick,weapon:e.weapon,kind:kinds[e.weapon],owner:e.shooter})));
const nativeRows = raw.filter(r=>r.event_name==='weapon_fire'&&kinds[r.weapon]);
for(const release of releases){
  assert.ok(roster.has(release.owner));
  assert.equal(nativeRows.filter(r=>r.tick===release.tick&&r.weapon===release.weapon&&r.user_steamid===release.owner).length,1,'release has unique native identity');
}
const effects = replay.rounds.flatMap(r=>(r.utilities??[]).map(u=>({...u,round:r.round})));
const classes={CSmokeGrenadeProjectile:'smoke',CFlashbangProjectile:'flashbang',CHEGrenadeProjectile:'hegrenade',CMolotovProjectile:'fire',CDecoyProjectile:'decoy'};
const runs=[],current=new Map();
for(const row of native.parseGrenades(bytes,[],false)){
  const kind=classes[row.grenade_type];if(!kind)continue;
  let run=current.get(row.grenade_entity_id);
  if(!run||run.kind!==kind||row.tick<=run.last||row.tick>run.last+2){
    run={kind,owner:row.steamid,entity:row.grenade_entity_id,first:row.tick,last:row.tick};runs.push(run);current.set(run.entity,run);
  }
  run.last=row.tick;
}
const linked = effects.map(u=>{
  const candidates=runs.filter(r=>r.kind===u.kind&&r.owner===u.throwerId&&r.first<=u.tick&&u.tick-r.first<=16*64
    &&(u.kind==='fire'?Math.abs(r.last-u.tick)<=2:r.entity===u.entityId&&u.tick<=r.last+2));
  assert.equal(candidates.length,1,'one independent native projectile run per effect');
  const run=candidates[0];
  const shots=releases.filter(t=>t.round===u.round&&t.owner===run.owner&&(u.kind==='fire'?['molotov','incendiary'].includes(t.kind):t.kind===u.kind)&&t.tick<=run.first&&run.first-t.tick<=64);
  assert.equal(shots.length,1,'unique native release near projectile creation');
  assert.equal(shots[0].tick,u.flight?.startTick);
  return {round:u.round,kind:u.kind,variant:u.variant,owner:u.throwerId,effectTick:u.tick,entity:u.entityId,flightStart:u.flight?.startTick??null,
    nativeRun:run,entityReused:runs.filter(r=>r.entity===run.entity).length>1,releases:shots};
});
const counts = Object.fromEntries(Object.values(kinds).map(kind=>[kind,{
  releases:releases.filter(t=>t.kind===kind).length,
  effects:linked.filter(u=>(u.variant??u.kind)===kind).length,
  exactFlightStart:linked.filter(u=>(u.variant??u.kind)===kind&&u.releases.length===1).length,
  nativeGrenadeThrown:raw.filter(r=>r.event_name==='grenade_thrown'&&(kinds[r.weapon]??kinds['weapon_'+r.weapon])===kind).length,
}]));
const sameTick=releases.filter(t=>releases.some(o=>o!==t&&o.tick===t.tick&&o.owner!==t.owner));
const consecutive=releases.filter(t=>releases.some(o=>o!==t&&o.owner===t.owner&&o.kind===t.kind&&o.tick>t.tick&&o.tick-t.tick<=640));
const reused=effects.filter(u=>effects.some(o=>o!==u&&o.entityId===u.entityId&&o.tick!==u.tick));
// Compare current projection with the immutable user baseline on exactly the same data.
const baselineSha='ceb463eca609078ba2e6e310cde827fc91d92e90';
const base=execFileSync('git',['show',`${baselineSha}:apps/desktop/electron/replay-session.ts`],{encoding:'utf8'});
const source=stripTypeScriptTypes(base.replace("'./player-name.ts'",JSON.stringify(new URL('../apps/desktop/electron/player-name.ts',import.meta.url).href))
  .replace("'../shared/replay-resource.ts'",JSON.stringify(new URL('../apps/desktop/shared/replay-resource.ts',import.meta.url).href)));
const {ReplaySession:Baseline}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const previous=new Baseline(match,replay,'audit'),session=new ReplaySession(match,replay,'audit');
const unique=s=>new Map([...s.chunks.values()].flatMap(json=>JSON.parse(json).events).map(e=>[e.id,e]));
const before=unique(previous),after=unique(session);
assert.equal(before.size,after.size,'all original records retained');
for(const [id,b] of before){
  const a=after.get(id),{description:bd,type:bt,...bf}=b,{description:ad,type:at,...af}=a;
  assert.deepEqual(af,bf,'all ticks/ids/actors/positions unchanged');
  if(at==='utility_throw')assert.equal(bt,'weapon_fire');else assert.equal(at,bt);
  if(bt!=='utility'&&at!=='utility_throw')assert.equal(ad,bd);
}
assert.equal([...after.values()].filter(e=>e.type==='utility_throw').length,releases.length);
const noEffect=releases.filter(t=>!linked.some(u=>u.releases.some(r=>r.eventIndex===t.eventIndex&&r.round===t.round)));
const result={fixture:'.demo/dust2.dem',sha256,counts,totalReleases:releases.length,totalEffects:effects.length,
  nativeRows:nativeRows.length,exactFlightStart:linked.filter(u=>u.releases.length===1).length,
  sameTick: sameTick.slice(0,8),consecutive:consecutive.slice(0,8),reusedEffectEntities:reused.length,
  baselineSha,samples:Object.values(kinds).map(kind=>releases.find(t=>t.kind===kind)),unlinkedEffects:linked.filter(u=>u.releases.length!==1),
  releaseWithoutEffect:noEffect,entityReuseSamples:linked.filter(u=>u.entityReused).slice(0,2),
  infernoSeparateEntitySamples:linked.filter(u=>u.kind==='fire'&&u.entity!==u.nativeRun.entity).slice(0,2),
  decision:'Direct native weapon_fire tick + shooter + exact grenade weapon; no effect-to-throw inference required. Existing effects retained.',
  replayMs:parsed.replayMs,performance:parsed.performance};
mkdirSync(new URL('../.tmp/p7-round-two/',import.meta.url),{recursive:true});
writeFileSync(new URL('../.tmp/p7-round-two/throw-audit.json',import.meta.url),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result,null,2));
