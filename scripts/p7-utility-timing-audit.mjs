// Real-data audit, independent of product timing decisions. No DEM is copied or downloaded.
// Build packages first, then: node scripts/p7-utility-timing-audit.mjs
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { stripTypeScriptTypes } from 'node:module';
import native from '../packages/demoparser-native/index.cjs';
import { Demoparser2Provider } from '../packages/dem-parser/dist/index.js';
import { ReplaySession } from '../apps/desktop/electron/replay-session.ts';

const root = new URL('../', import.meta.url), fixture = new URL('.demo/dust2.dem', root);
const bytes = await readFile(fixture);
const sha256 = createHash('sha256').update(bytes).digest('hex');
assert.equal(sha256, 'db90fe85aab023a1d2c8a5996182e6120d98ef494f02a070b17982b235e4958c');
const effectNames = { smokegrenade_detonate: 'smoke', flashbang_detonate: 'flashbang', hegrenade_detonate: 'hegrenade', inferno_startburn: 'fire', decoy_started: 'decoy' };
const classes = { CSmokeGrenadeProjectile: 'smoke', CFlashbangProjectile: 'flashbang', CHEGrenadeProjectile: 'hegrenade', CMolotovProjectile: 'fire', CDecoyProjectile: 'decoy' };
const weapons = { smoke: ['weapon_smokegrenade'], flashbang: ['weapon_flashbang'], hegrenade: ['weapon_hegrenade'], fire: ['weapon_molotov', 'weapon_incgrenade'], decoy: ['weapon_decoy'] };
const rawEvents = native.parseEvents(bytes, ['weapon_fire', 'grenade_thrown', ...Object.keys(effectNames)], ['team_num'], ['total_rounds_played', 'is_warmup_period']);
const projectileRows = native.parseGrenades(bytes, [], false);
const runs = [], current = new Map();
for (const row of projectileRows) {
  const kind = classes[row.grenade_type];
  if (!kind || !Number.isSafeInteger(row.tick) || ![row.x, row.y, row.z].every(Number.isFinite)) continue;
  let run = current.get(row.grenade_entity_id);
  if (!run || run.kind !== kind || row.tick <= run.last || row.tick > run.last + 2) {
    run = { entityId: row.grenade_entity_id, kind, owner: row.steamid, first: row.tick, last: row.tick, rows: [] };
    runs.push(run); current.set(run.entityId, run);
  }
  run.last = row.tick; run.rows.push(row);
}
const { match, replay } = await new Demoparser2Provider().parseWithReplay(fileURLToPath(fixture));
assert.ok(replay); assert.equal(match.tickRate, 64);
const session = new ReplaySession(match, replay, 'timing-audit');
// Execute the immutable baseline projector against the same parsed evidence. This reconstructs
// the actual before text without keeping an unversioned local capture or changing checkout.
const baselineSha = 'c247469102196e474e7162e2536ee815fd5c0abb';
const baselineSource = execFileSync('git', ['show', `${baselineSha}:apps/desktop/electron/replay-session.ts`], { cwd: fileURLToPath(root), encoding: 'utf8' });
const baselineModule = stripTypeScriptTypes(baselineSource
  .replace("'./player-name.ts'", JSON.stringify(new URL('apps/desktop/electron/player-name.ts', root).href))
  .replace("'../shared/replay-resource.ts'", JSON.stringify(new URL('apps/desktop/shared/replay-resource.ts', root).href)));
const { ReplaySession: BaselineSession } = await import('data:text/javascript;base64,' + Buffer.from(baselineModule).toString('base64'));
const baseline = new BaselineSession(match, replay, 'timing-audit');
const beforeEvents = new Map();
for (const json of baseline.chunks.values()) for (const event of JSON.parse(json).events) beforeEvents.set(event.id, event);
const listEvents = new Map();
for (const json of session.chunks.values()) for (const event of JSON.parse(json).events) listEvents.set(event.id, event);
const names = new Map(match.players.map(p => [p.steamId, p.nickname.trim()]));
const observations = [];
for (const round of replay.rounds) for (const effect of round.utilities ?? []) {
  const event = round.events.find(e => e.eventIndex === effect.eventIndex).event;
  const raw = rawEvents.filter(r => effectNames[r.event_name] === effect.kind && r.tick === effect.tick && r.entityid === effect.entityId);
  assert.equal(raw.length, 1, 'unique native effect');
  const owner = effect.throwerId;
  const candidates = runs.filter(run => run.kind === effect.kind && run.first <= effect.tick && effect.tick - run.first <= 16 * 64
    && (effect.kind === 'fire'
      ? run.owner === owner && (run.first <= effect.tick && effect.tick <= run.last || Math.abs(effect.tick - run.last) <= 2)
      : run.entityId === effect.entityId && effect.tick <= run.last + 2));
  const run = candidates.length === 1 ? candidates[0] : null;
  // Use release-near-first-observation, owner and weapon class, never effect tick alone.
  const throwCandidates = run ? rawEvents.filter(r => r.event_name === 'weapon_fire' && r.user_steamid === run.owner
    && weapons[effect.kind].includes(r.weapon) && r.tick <= run.first && run.first - r.tick <= 64) : [];
  const shot = throwCandidates.length === 1 ? throwCandidates[0] : null;
  const desktop = listEvents.get(`r${round.round}-e${effect.eventIndex}`);
  const before = beforeEvents.get(desktop.id);
  const kindText = effect.variant ?? effect.kind;
  const actionText = { detonate: '爆开', start_burn: '开始燃烧', start_decoy: '开始生效' }[event.action];
  assert.ok(actionText, 'known observed effect action');
  const expectedDescription = `${names.get(owner) || '未知玩家'} 的 ${kindText} ${actionText}`;
  assert.ok(desktop.description === before.description || desktop.description === expectedDescription, 'baseline or exact corrected effect description');
  const { description: currentDescription, ...currentFields } = desktop;
  const { description: baselineDescription, ...baselineFields } = before;
  assert.deepEqual(currentFields, baselineFields, 'fix changes no event identity, tick, actor, target or position');
  assert.equal(desktop.tick, effect.tick); assert.equal(event.tick, raw[0].tick);
  assert.equal(effect.tick, raw[0].tick);
  const firstRows = run?.rows.slice(0, 2) ?? [], lastRows = run?.rows.slice(-2) ?? [];
  const effectRows = run?.rows.filter(r => Math.abs(r.tick - effect.tick) <= 1) ?? [];
  const nearest = run?.rows.filter(r => r.tick <= effect.tick).at(-1);
  const endpointDistance = nearest ? Math.hypot(nearest.x - raw[0].x, nearest.y - raw[0].y, nearest.z - raw[0].z) : null;
  const start = run && effect.flight?.points.find(p => p[0] === run.first);
  if (run && start) assert.deepEqual(start.slice(1), [run.rows[0].x, run.rows[0].y, run.rows[0].z]);
  const simultaneous = shot ? rawEvents.filter(r => r.event_name === 'weapon_fire' && Object.values(weapons).flat().includes(r.weapon)
    && r.tick === shot.tick && r.user_steamid !== shot.user_steamid) : [];
  const consecutive = shot ? rawEvents.filter(r => r.event_name === 'weapon_fire' && r.user_steamid === owner
    && weapons[effect.kind].includes(r.weapon) && r.tick !== shot.tick && Math.abs(r.tick - shot.tick) <= 10 * 64)
    .map(r => ({ tick: r.tick, weapon: r.weapon })) : [];
  observations.push({ round: round.round, roundStartTick: round.startTick, player: names.get(owner) ?? null, steamId: owner,
    kind: effect.kind, variant: effect.variant, weaponFireTick: shot?.tick ?? null, projectileFirstTick: run?.first ?? null,
    projectileLastTick: run?.last ?? null, nativeEffectTick: raw[0].tick, matchEventTick: event.tick,
    replayEffectTick: effect.tick, desktopListTick: desktop.tick, beforeDescription: before.description,
    desktopListDescription: desktop.description, expectedDescription,
    relativeListSeconds: Number(((desktop.tick - round.startTick) / 64).toFixed(5)),
    flightStartTick: effect.flight?.startTick ?? null,
    throwToFirstSeconds: shot && run ? (run.first - shot.tick) / 64 : null,
    throwToEffectSeconds: shot ? (effect.tick - shot.tick) / 64 : null,
    effectEntityId: effect.entityId, projectileEntityId: run?.entityId ?? null,
    runCandidates: candidates.length, throwCandidates: throwCandidates.length,
    entityReuseRuns: run ? runs.filter(r => r.entityId === run.entityId).length : null,
    simultaneousOtherThrowers: simultaneous.length, simultaneousOtherThrowRecords: simultaneous,
    sameOwnerSameKindNearbyThrows: consecutive,
    endpointDistanceWorldUnits: endpointDistance,
    association: effect.kind === 'fire' ? 'owner + projectile class + unique terminal run within 2 ticks; inferno entity deliberately not equated with projectile entity'
      : 'effect entity + projectile class + unique continuous run containing effect tick (or ending within 2 ticks) + matching native owner',
    confidence: run && shot && owner === run.owner && raw[0].user_steamid === run.owner ? 'high' : 'insufficient',
    nativeEffect: raw[0], nativeThrow: shot, nativeProjectileFirstRows: firstRows, nativeProjectileLastRows: lastRows, nativeProjectileEffectRows: effectRows });
}
const sample = [], add = (o, reason) => { if (o && !sample.some(s => s.round === o.round && s.nativeEffectTick === o.nativeEffectTick && s.effectEntityId === o.effectEntityId)) sample.push({ ...o, sampleReason: reason }); };
for (const kind of Object.values(effectNames)) add(observations.find(o => o.kind === kind && o.confidence === 'high'), `representative ${kind}`);
add(observations.find(o => o.variant === 'incendiary' && o.confidence === 'high'), 'incendiary variant');
add(observations.find(o => o.variant === 'molotov' && o.confidence === 'high'), 'molotov variant');
add(observations.find(o => o.player === 'karrigan' && o.kind === 'smoke' && Math.abs(o.relativeListSeconds - 44.42) < 0.01), 'user-mentioned +44.42 karrigan smoke');
add(observations.find(o => o.simultaneousOtherThrowers > 0 && o.confidence === 'high'), 'same-tick throws by distinct owners');
add(observations.find(o => o.sameOwnerSameKindNearbyThrows.length > 0 && o.kind === 'flashbang' && o.confidence === 'high'), 'same-owner consecutive flash throws');
add(observations.find(o => o.kind === 'fire' && o.effectEntityId !== o.projectileEntityId && o.confidence === 'high'), 'inferno vs projectile entity');
const consecutiveSample = observations.find(o => o.sameOwnerSameKindNearbyThrows.length > 0 && o.kind === 'flashbang' && o.confidence === 'high');
if (consecutiveSample) add(observations.find(o => o.steamId === consecutiveSample.steamId && o.kind === consecutiveSample.kind
  && o.weaponFireTick === consecutiveSample.sameOwnerSameKindNearbyThrows[0].tick), 'consecutive flash second effect, distinct entity');
const counts = Object.fromEntries(Object.values(effectNames).map(kind => [kind, observations.filter(o => o.kind === kind).length]));
const high = observations.filter(o => o.confidence === 'high');
const mismatchedCopy = high.filter(o => /投掷了/.test(o.desktopListDescription) && o.throwToEffectSeconds > 0);
const sourceFiles = {};
for (const path of ['apps/desktop/electron/replay-session.ts', 'packages/dem-parser/src/providers/converters.ts', 'packages/dem-parser/src/providers/replay.ts']) {
  sourceFiles[path] = createHash('sha256').update(await readFile(new URL(path, root))).digest('hex');
}
const result = {
  fixture: '.demo/dust2.dem', sha256, tickRate: 64, sourceSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fileURLToPath(root), encoding: 'utf8' }).trim(),
  sourceState: 'sourceSha is HEAD at audit time; tested working-tree sources are identified by sourceFileSha256', sourceFileSha256: sourceFiles,
  baselineSha, baselineDescriptionProvenance: 'immutable baseline ReplaySession executed with the same current native-parsed MatchReplay; all event fields except description compared for equality',
  nativeBinarySha256: native.getBindingProvenance().verifiedSha256,
  verdict: mismatchedCopy.length ? 'CONFIRMED BUG' : 'CONFIRMED BUG FIXED',
  conclusion: 'Utility effect and list ticks are correctly preserved detonation/start ticks. Calling the effect-timed list entry a throw is a display-copy semantic error; preserve ticks and label the observed effect action.',
  counts, nativeRows: projectileRows.length, continuousRuns: runs.length, auditedEffects: observations.length,
  highConfidenceAssociations: high.length, insufficientAssociations: observations.length - high.length,
  nativeGrenadeThrownRecords: rawEvents.filter(e => e.event_name === 'grenade_thrown').length,
  allMatchReplayDesktopTicksEqualNativeEffect: observations.every(o => o.nativeEffectTick === o.matchEventTick && o.matchEventTick === o.replayEffectTick && o.replayEffectTick === o.desktopListTick),
  firstObservationMinusWeaponFireTicks: [...new Set(high.map(o => (o.projectileFirstTick - o.weaponFireTick)))].sort((a, b) => a - b),
  ambiguous: observations.filter(o => o.confidence !== 'high').map(({ nativeEffect, nativeThrow, nativeProjectileFirstRows, nativeProjectileLastRows, nativeProjectileEffectRows, ...o }) => o),
  samples: sample,
  limits: ['weapon_fire is an independently observed native grenade-use event; it does not claim a sub-tick hand-release animation timestamp.',
    'projectile first tick is the first recorded native projectile position, not proof of the precise physical creation/release instant.',
    'fire owner/time association is weaker than a shared serialised entity handle; only unique candidates are marked high, and inferno entity is not a projectile ID.',
    'audit covers this exact local Dust2 only, not every engine/demo version.'],
};
assert.equal(result.auditedEffects, 632); assert.ok(result.allMatchReplayDesktopTicksEqualNativeEffect);
for (const kind of Object.values(effectNames)) assert.ok(sample.some(o => o.kind === kind), `representative ${kind}`);
await writeFile(new URL('docs/p7-utility-timing-evidence.json', root), JSON.stringify(result, null, 2) + '\n');
await mkdir(new URL('.tmp/p7-timing-audit/', root), { recursive: true });
await writeFile(new URL('.tmp/p7-timing-audit/all-observations.json', root), JSON.stringify(observations, null, 2) + '\n');
console.log(JSON.stringify({ verdict: result.verdict, counts, associations: `${high.length}/${observations.length}`, samples: sample.map(o => ({ round: o.round, player: o.player, kind: o.kind, variant: o.variant,
  throw: o.weaponFireTick, first: o.projectileFirstTick, effect: o.nativeEffectTick, list: o.desktopListTick,
  seconds: o.relativeListSeconds, difference: o.throwToEffectSeconds, confidence: o.confidence, reason: o.sampleReason })), ambiguous: result.ambiguous }, null, 2));
