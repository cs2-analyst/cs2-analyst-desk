// Read immutable raw soak results; commit only this bounded, payload-free evidence.
// node scripts/library-renderer-memory-summary.mjs <IPC results.json> <UI results.json> <new output.json> [native-before.json intermediate.json image-diagnostic.json final-fixed.json]
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function referenceCounts(state, currentCycle) {
  assert.equal(state.reportRootCleared, true);
  if (state.nonEmptyReplayCaches !== undefined) assert.equal(state.nonEmptyReplayCaches, 0, 'A released UI Replay cache still contains chunks');
  const result = { baseline: {}, previous: {}, current: {} };
  for (const [key, counts] of Object.entries(state.counts)) {
    const split = key.indexOf(':'), cycle = Number(key.slice(0, split)), kind = key.slice(split + 1);
    assert.ok(Number.isInteger(cycle) && cycle >= -1 && cycle <= currentCycle);
    assert.ok(Number.isSafeInteger(counts.live) && counts.live >= 0 && Number.isSafeInteger(counts.dead) && counts.dead >= 0);
    const group = cycle === -1 ? 'baseline' : cycle < currentCycle ? 'previous' : 'current';
    const target = result[group][kind] ??= { live: 0, dead: 0 };
    target.live += counts.live; target.dead += counts.dead;
  }
  return result;
}
const collected = counts => Object.keys(counts).length > 0 && Object.values(counts).every(value => value.live === 0);
const max = values => values.length ? Math.max(...values) : null;
function snapshot(value, cycle) {
  return { at: value.at, heap: value.heap, dom: value.dom, references: referenceCounts(value.references, cycle),
    referencesByBirthCycle: value.references.counts, nonEmptyReplayCaches: value.references.nonEmptyReplayCaches,
    boundEffectImages: value.references.boundEffectImages, effectImageSourceAttributes: value.references.effectImageSourceAttributes,
    largeReplayCanvases: value.references.largeReplayCanvases };
}
function cohort(raw, path, name) {
  assert.equal(raw.serial, true); assert.equal(raw.explicitGc, false);
  assert.ok(raw.results.length > 0 && raw.results.every(row => row.status === 'PASS'));
  assert.ok(raw.results.every(row => row.version === 1 || row.version === 2));
  assert.equal(new Set(raw.results.map(row => `${row.version}:${row.trial}`)).size, raw.results.length, 'Every process trial must be unique');
  assert.match(raw.qaScriptSha256, /^[0-9a-f]{64}$/);
  const configPath = join(dirname(path), 'gui-run.json'), config = JSON.parse(readFileSync(configPath));
  assert.deepEqual(config.builtEntryFingerprints, raw.builtEntryFingerprints);
  assert.equal(config.qaScriptSha256, raw.qaScriptSha256);
  const wholeBuildSha256 = createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(config.app.original).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)))).digest('hex');
  const runtimes = [1, 2].map(version => JSON.parse(readFileSync(join(dirname(path), `seed-v${version}.json`))).runtime);
  assert.deepEqual(runtimes[0], runtimes[1]);
  assert.ok(runtimes[0].electron && runtimes[0].node);
  const runtime = Object.fromEntries(['electron', 'node', 'chrome', 'v8'].map(key => [key, runtimes[0][key]]));
  const versions = [1, 2].map(version => raw.results.filter(row => row.version === version));
  assert.equal(versions[0].length, versions[1].length);
  assert.equal(versions[0].length, config.trials);
  for (const rows of versions) assert.deepEqual(rows.map(row => row.trial).sort((a, b) => a - b), Array.from({ length: config.trials }, (_, index) => index));
  const results = raw.results.map(row => {
    assert.equal(row.fingerprintMemoryIncluded, false); assert.equal(row.explicitGc, false);
    assert.equal(row.qaScriptSha256, raw.qaScriptSha256);
    assert.deepEqual(row.builtEntryFingerprints, raw.builtEntryFingerprints);
    assert.equal(row.soak.explicitGc, false); assert.equal(row.soak.artificialAllocationPressure, false);
    const s = row.soak, quiet = snapshot(s.quiet.sample, s.options.cycles - 1);
    const phases = row.memory.phases.filter(phase => phase.phase.startsWith('soak-') && phase.phase !== 'soak-final-screenshot');
    const releasePhases = phases.filter(phase => /released-idle$|^(soak-final-idle|soak-quiet-final-idle)$/.test(phase.phase));
    assert.equal(releasePhases.length, s.options.cycles + 2);
    assert.ok(releasePhases.every(phase => phase.lastWorkingSetBytes?.Utility === 0));
    assert.equal(row.releasedUtilityExited, true);
    assert.equal(s.cycles.length, s.options.cycles);
    const cycles = s.cycles.map(c => {
      assert.equal(c.ui.length, s.options.uiEvery && c.cycle % s.options.uiEvery === 0 ? 2 : 0);
      const phase = phases.find(phase => phase.phase === `soak-${c.cycle}-released-idle`);
      return { cycle: c.cycle, openMs: c.openMs, switchMs: c.switchMs, requests: c.requests, seekMs: c.seekMs,
        actualUiMatches: c.ui.map(ui => ({ matchId: ui.matchId, references: ui.references, cacheReferences: ui.cacheReferences,
          nonEmptyReplayCachesAfterUnmount: ui.nonEmptyReplayCachesAfterUnmount,
          displayedTicks: ui.positions.map(position => position.tick), maximumChunkCacheEntries: max(ui.positions.map(position => position.cache)) })),
        immediate: snapshot(c.immediate, c.cycle), idle: snapshot(c.idle, c.cycle),
        releasedWorkingSetBytes: phase.lastWorkingSetBytes, releasedTrackedWorkingSetBytes: phase.lastTrackedWorkingSetBytes };
    });
    return { version: row.version, trial: row.trial, sourceRevision: row.sourceRevision, qaScriptSha256: row.qaScriptSha256,
      rawTrial: row.outputDirectory, runtime,
      durationMs: s.quiet.sample.at - row.startupAt, options: s.options,
      originalPortableRelease: snapshot(s.baseline, -1), cycles,
      firstAllBaselineObjectsCollectedCycle: collected(referenceCounts(s.baseline.references, -1).baseline) ? -1
        : cycles.find(c => collected(c.idle.references.baseline))?.cycle ?? null,
      observedFinalIdle: s.idle.map(value => snapshot(value, s.options.cycles - 1)),
      quietFinalIdle: { durationMs: s.quiet.durationMs, ...quiet },
      finalWorkingSetBytes: releasePhases.at(-1).lastWorkingSetBytes,
      allBaselineTrackedObjectsCollected: collected(quiet.references.baseline),
      allTrackedObjectsCollected: Object.values(quiet.references).every(collected),
      trackedObjects: Object.values(quiet.references).flatMap(Object.values).reduce((sum, value) => sum + value.live + value.dead, 0),
      peakWorkingSetBytes: Object.fromEntries(['Main', 'Renderer', 'Utility'].map(role => [role,
        max(phases.map(phase => phase.peakWorkingSetBytes?.[role]).filter(Number.isFinite))])),
      peakTrackedWorkingSetBytes: max(phases.map(phase => phase.peakTrackedWorkingSetBytes).filter(Number.isFinite)),
      businessUtilitiesAbsentAtEveryRelease: true, staleSessionRequestsRejected: row.staleAfterReopenRejected && row.staleAfterSwitchRejected,
      status: row.status };
  });
  return { name, input: resolve(path), configPath: resolve(configPath), wholeBuildSha256, productionFiles: Object.keys(config.app.original).length,
    resourceProbeVersion: config.resourceProbeVersion ?? 1, resourceProbeDefinition: config.resourceProbeDefinition ?? 'Legacy boundEffectImages counts src attribute presence; older probes may not record native resources.',
    newProcessesPerFormat: versions[0].length,
    sourceRevision: raw.sourceRevision, builtEntryFingerprints: raw.builtEntryFingerprints, qaScriptSha256: raw.qaScriptSha256, results };
}
function imageDiagnostic(raw, path, expectedBuild) {
  assert.equal(raw.serial, true); assert.equal(raw.explicitGc, false);
  const config = JSON.parse(readFileSync(join(dirname(path), 'gui-run.json')));
  const build = createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(config.app.original).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)))).digest('hex');
  assert.equal(build, expectedBuild);
  assert.equal(config.diagnostics.kind, 'image-loader-versus-helper-diagnostic');
  assert.equal(raw.results.length, 2);
  assert.deepEqual(raw.results.map(row => row.version).sort(), [1, 2]);
  assert.equal(createHash('sha256').update(readFileSync(join(dirname(path), 'controller-source.mjs'))).digest('hex'), raw.qaScriptSha256);
  assert.equal(createHash('sha256').update(readFileSync(join(dirname(path), 'image-diagnostic-source.mjs'))).digest('hex'), config.diagnostics.scriptSha256);
  const results = raw.results.map(row => {
    assert.equal(row.status, 'PASS');
    assert.equal(row.qaScriptSha256, raw.qaScriptSha256);
    assert.deepEqual(row.builtEntryFingerprints, raw.builtEntryFingerprints);
    const terminal = row.soak.quiet.sample.diagnostics;
    assert.equal(terminal.registered, 56); assert.equal(terminal.retainedDisposedCallbacks, 1);
    assert.deepEqual(Object.keys(terminal.groups).sort(), [...config.diagnostics.variants].sort());
    for (const [name, value] of Object.entries(terminal.groups)) {
      assert.equal(value.live + value.dead, 8);
      assert.equal(value.live, name.includes('remove') ? 8 : 0, 'Same-runtime clearing-mode control must reproduce the recorded result');
    }
    return { version: row.version, rawTrial: row.outputDirectory, baseline: row.soak.baseline.diagnostics,
      cycles: row.soak.cycles.map(cycle => ({ cycle: cycle.cycle, idle: cycle.idle.diagnostics })), terminal };
  });
  return { input: resolve(path), qaScriptSha256: raw.qaScriptSha256, metadata: config.diagnostics, wholeBuildSha256: build,
    archivedControllerSource: join(dirname(path), 'controller-source.mjs'), archivedDiagnosticSource: join(dirname(path), 'image-diagnostic-source.mjs'),
    results, interpretation: 'Clearing-mode diagnosis under ordinary real archive operations, not a RAM benchmark or an exact Blink-internal retainer diagnosis. The intentionally retained callback control is labelled.' };
}
export function summarize(ipc, ui, ipcPath, uiPath, followup = null) {
  assert.deepEqual(ipc.builtEntryFingerprints, ui.builtEntryFingerprints, 'UI and IPC use the identical production build');
  assert.ok(ipc.results.every(row => row.soak.options.uiEvery === 0), 'The direct IPC cohort must exclude actual UI cycles');
  assert.ok(ui.results.every(row => row.soak.options.uiEvery > 0), 'The UI cohort must include actual UI cycles');
  const cohorts = [cohort(ipc, ipcPath, 'direct-ipc'), cohort(ui, uiPath, 'ipc-and-actual-ui')];
  assert.equal(cohorts[0].wholeBuildSha256, cohorts[1].wholeBuildSha256, 'All production dist files, including Renderer/preload/assets, must match');
  let nativeResourceFollowup = null;
  if (followup) {
    const { before: nativeBefore, intermediate: nativeIntermediate, diagnostic, fixed: nativeFixed, paths } = followup;
    assert.ok(nativeBefore && nativeIntermediate && diagnostic && nativeFixed && paths.length === 4);
    assert.equal(nativeBefore.qaScriptSha256, nativeIntermediate.qaScriptSha256, 'Before/initial source-removal probes use identical QA code');
    const before = cohort(nativeBefore, paths[0], 'native-resource-before');
    const intermediate = cohort(nativeIntermediate, paths[1], 'source-removal-attempt-superseded');
    const fixed = cohort(nativeFixed, paths[3], 'native-resource-final-fixed');
    assert.equal(before.wholeBuildSha256, cohorts[0].wholeBuildSha256, 'Native before probes must use the original production snapshot');
    assert.notEqual(fixed.wholeBuildSha256, before.wholeBuildSha256, 'Fixed evidence needs the changed production build');
    for (const raw of [nativeBefore, nativeIntermediate, nativeFixed]) for (const row of raw.results) {
      assert.ok(row.soak.options.uiEvery > 0);
      for (const cycle of row.soak.cycles) for (const ui of cycle.ui) {
        assert.equal(ui.cacheReferences.effectImages, 8);
        assert.equal(ui.cacheReferences.canvases, 2);
      }
    }
    assert.ok(nativeBefore.results.some(row => row.soak.cycles.some(cycle => cycle.immediate.references.boundEffectImages > 0
      && cycle.immediate.references.largeReplayCanvases > 0)), 'Before evidence must actually observe resource bindings after release');
    for (const row of nativeFixed.results) {
      assert.equal(row.soak.options.nativeReleaseExpected, 1);
      for (const sample of [...row.soak.cycles.flatMap(cycle => [cycle.immediate, cycle.idle]), ...row.soak.idle, row.soak.quiet.sample]) {
        assert.equal(sample.references.boundEffectImages, 0, 'Fixed released images still bind sources');
        assert.equal(sample.references.largeReplayCanvases, 0, 'Fixed released canvases retain large dimensions');
      }
      assert.equal(row.soak.quiet.sample.references.counts['0:ui-effect-image'].live, 0,
        'Final evidence must observe natural recovery of the oldest image wrappers, not merely detached src');
    }
    nativeResourceFollowup = { before, supersededSourceRemovalAttempt: intermediate,
      clearingModeDiagnostic: imageDiagnostic(diagnostic, paths[2], intermediate.wholeBuildSha256),
      fixed, fixedResourcesDetachedAtAllReleaseSamples: true, oldestFixedImageWrappersNaturallyCollected: true,
      interpretation: 'Before has two UI cycles; both attempted and final fixes have eight. Probe v1 counted attribute presence; v2 counts non-empty src and separately retains attribute presence. Use wrapper age/collection and binding/canvas invariants, not a causal RSS percentage. The failed source-removal attempt and original eight-cycle before-build observations remain explicit.' };
  }
  return { schemaVersion: 1, units: { memory: 'bytes', latency: 'milliseconds' },
    explicitGc: false, artificialAllocationPressure: false, osFileCacheCleared: false, readOrCopiedDem: false,
    methodology: [
      'Fresh isolated libraries/profiles; serial v1/v2 processes with balanced trial order. Original no-fingerprint portable sequence precedes each soak.',
      'WeakRef probes retain only weak handles; synchronous dereference/Fiber traversal results contain counts and IDs, never target objects.',
      'QA source hashes are separate per cohort; within each cohort both formats use the identical QA source. The UI cohort adds real cache/chunk weak probes and puts Nuke last before terminal idle; terminal memory is not a direct UI-versus-IPC overhead comparison.',
      'UI probes traverse HostRoot.stateNode.current and assert match identity. Trusted slider keys, displayed frame tick, applied Heatmap data and real cache clearing are checked before release.',
      'Main OS process observations continue at 100ms. Renderer heap polling is suspended in the final separately labelled quiet interval; no Renderer CDP requests occur until its terminal sample.',
      'Snapshots, queryObjects, collectGarbage and memory-pressure notifications are not used. Natural collection is established only for weak handles that actually disappeared.',
      'Still-live weak handles before a natural collection do not prove strong retention. These bounded runs cannot prove absence of every possible leak.',
      'Working sets include shared pages and exclude GPU/network; they are not PSS. Renderer JS heap/backing/embedder observations are distinct from OS working set.',
      'Final screenshots are a separate phase and excluded from the terminal idle/peak summaries. Raw traces, screenshots and archive payloads remain in owned temporary directories.'
    ], cohorts, nativeResourceFollowup };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [ipcPath, uiPath, outputPath, ...paths] = process.argv.slice(2);
  assert.ok(ipcPath && uiPath && outputPath, 'IPC results, UI results and a new output path are required');
  assert.ok(paths.length === 0 || paths.length === 4, 'Provide native before, intermediate attempt, clearing-mode diagnostic and final fixed evidence together');
  const followup = paths.length ? { paths,
    before: JSON.parse(readFileSync(paths[0])), intermediate: JSON.parse(readFileSync(paths[1])),
    diagnostic: JSON.parse(readFileSync(paths[2])), fixed: JSON.parse(readFileSync(paths[3])) } : null;
  const summary = summarize(JSON.parse(readFileSync(ipcPath)), JSON.parse(readFileSync(uiPath)), ipcPath, uiPath,
    followup);
  writeFileSync(resolve(outputPath), JSON.stringify(summary) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ output: resolve(outputPath), bytes: Buffer.byteLength(JSON.stringify(summary)) }));
}
