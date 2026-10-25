// Small reviewable evidence, separated from owned temporary archives and raw observations.
// node scripts/library-storage-optimization-summary.mjs <benchmark results.json> <GUI results.json> <new output.json> <reanalysis results.json> <byte-equivalence results.json> <final portable directory> [no-fingerprint control.json]
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { quantiles } from './library-spike-core.mjs';
const read = path => JSON.parse(readFileSync(resolve(path), 'utf8'));
const [benchmarkPath, guiPath, outputPath, reanalysisPath, bytePath, portableDirectory, noFingerprintPath] = process.argv.slice(2);
assert.ok(benchmarkPath && guiPath && outputPath && reanalysisPath && bytePath && portableDirectory,
  'benchmark, GUI, new summary output, reanalysis, byte-equivalence and final one-shot portable directory are required');
const benchmark = read(benchmarkPath), gui = read(guiPath);
assert.equal(benchmark.synthetic, false); assert.equal(benchmark.serial, true); assert.equal(gui.serial, true);
assert.equal(benchmark.explicitGc, false); assert.equal(gui.explicitGc, false);
assert.equal(benchmark.samples, 3); assert.equal(gui.trials, 3);
const portableEvidence = portableDirectory ? benchmark.results.map(sample => read(join(portableDirectory, `portable-probed-${sample.name.replace('.dem', '')}.json`))) : [];
for (const evidence of portableEvidence) {
  assert.match(evidence.sourceRevision, /^[a-f0-9]{40}$/);
  assert.match(evidence.builtEntryFingerprints?.archiveVerifier?.sha256, /^[a-f0-9]{64}$/,
    'final portable evidence must identify the one-shot verifier build');
  assert.ok(evidence.supplemental.length > 0);
  for (const row of evidence.supplemental) {
    assert.equal(row.sourceRevision, evidence.sourceRevision);
    assert.equal(row.explicitGc, false);
    assert.deepEqual(row.builtEntryFingerprints, evidence.builtEntryFingerprints);
  }
}
const maximum = values => { const finite = values.filter(Number.isFinite); return finite.length ? Math.max(...finite) : null; };
function memoryFor(trials, include) {
  const byTrial = trials.map(row => ({ trial: row.trial, attempt: row.attempt,
    windows: row.memory.phases.filter(phase => include(phase.phase)) }));
  const windows = byTrial.flatMap(row => row.windows);
  const nodeFields = ['rss', 'heapTotal', 'heapUsed', 'external', 'arrayBuffers'];
  const roles = ['Main', 'Utility', 'AnalysisUtility', 'VerificationUtility'];
  const node = Object.fromEntries(roles.map(role => [role, Object.fromEntries(nodeFields.map(key => [key,
    maximum(windows.map(phase => phase.peakNodeMemory?.[role]?.[key]))]))]));
  const renderer = Object.fromEntries(['usedSize', 'totalSize', 'embedderHeapUsedSize', 'backingStorageSize'].map(key => [key,
    maximum(windows.map(phase => phase.peakRendererHeap?.[key]))]));
  return { unit: 'bytes', node, Renderer: renderer,
    workingSet: Object.fromEntries([...roles, 'Renderer'].map(role => [role, maximum(windows.map(phase => phase.peakWorkingSetBytes?.[role]))])),
    peakTrackedWorkingSetBytes: maximum(windows.map(phase => phase.peakTrackedWorkingSetBytes)),
    phases: byTrial,
    interpretation: 'Named phases only. Node peaks are single-process role high waters; Utility working set sums simultaneous Analysis and Verification processes. Tracked total is measured at a common timestamp, not a sum of independent role maxima. Working sets include shared pages and are not PSS or complete application physical memory (GPU/network excluded). null means unobserved, not zero.' };
}
const regularPhases = new Set(['new-process-first-open', 'serial-random-seek', 'same-process-reopen', 'switch-match', 'rapid-seek-and-release', 'released-idle']);
const results = benchmark.results.map(sample => {
  const versions = {};
  for (const version of [1, 2]) {
    const backend = sample.versions[version], trials = gui.results.filter(row => row.name === sample.name && row.version === version);
    assert.equal(trials.length, 3); assert.ok(trials.every(row => row.status === 'PASS'));
    const memory = memoryFor(trials, name => regularPhases.has(name));
    const portableSet = portableEvidence.find(row => row.name === sample.name);
    const portableTrials = portableSet ? portableSet.supplemental.filter(row => row.version === version) : [trials[0]];
    assert.ok(portableTrials.length && portableTrials.every(row => row.status === 'PASS'));
    versions[version] = {
      archive: backend.size, firstSaveMs: sample.capture.saves[version][0].saveMs,
      saves: sample.capture.saves[version], saveMs: backend.saveMs,
      toolNewProcessOpenMs: backend.newProcessFirstOpenMs, toolSameProcessReopenMs: backend.sameProcessReopenMs,
      guiNewProcessOpenMs: quantiles(trials.map(row => row.newProcessFirstOpenMs)),
      guiSameProcessReopenMs: quantiles(trials.map(row => row.sameProcessReopenMs)),
      guiSwitchOpenMs: quantiles(trials.map(row => row.switchOpenMs)),
      guiUniqueChunkMs: quantiles(trials.flatMap(row => row.seek.requests.map(request => request.ms))),
      guiImmediateRepeatChunkMs: quantiles(trials.flatMap(row => row.seek.repeats.map(request => request.ms))),
      persistentChunkCacheBytes: 0,
      cache: version === 2 ? 'Session UTF-8 JSON LRU <= 3 MiB; no derived Chunk disk cache; round projection read on a miss.'
        : 'Legacy independent compressed Chunk files are archive members, not a regenerated cache; no application Chunk LRU.',
      canonicalSourceJsonByteExact: backend.portable.reopened.canonicalJsonByteExact,
      allChunkJsonByteExact: backend.portable.reopened.chunksJsonByteExact,
      filteredHeatmapCases: backend.portable.reopened.verifiedHeatmapCases,
      portable: { bytes: backend.portable.packageBytes, toolExportMs: backend.portable.exportMs,
        toolImportAndVerifyMs: backend.portable.importAndVerifyMs,
        sourceRevision: portableSet?.sourceRevision ?? gui.sourceRevision,
        builtEntryFingerprints: portableSet?.builtEntryFingerprints,
        main: { samples: portableTrials.length, exportMs: quantiles(portableTrials.map(row => row.portable.exportMs)),
          importMs: quantiles(portableTrials.map(row => row.portable.importMs)),
          deletedAndRestoredSameId: portableTrials.every(row => row.portable.deletedAndRestoredSameId) },
        memory: memoryFor(portableTrials, name => name.startsWith('portable-')),
        verifierLifecycle: portableTrials.map(row => ({ trial: row.trial, attempt: row.attempt,
          lifecycle: row.memory.utilityLifecycle ?? null })),
      },
      memory,
      releasedUtilityExited: trials.every(row => row.releasedUtilityExited),
      staleRequestsRejected: trials.every(row => row.staleAfterReopenRejected && row.staleAfterSwitchRejected),
      views: trials.flatMap(row => row.views ?? []),
      sharedCatalogueStorage: portableTrials.map(row => ({ trial: row.trial, storage: row.storage })),
    };
  }
  return { name: sample.name, source: sample.source, rounds: sample.rounds, players: sample.players, chunks: sample.chunks,
    heatmapCases: sample.heatmapCases, savedBytes: sample.savedBytes, savedFraction: sample.savedFraction,
    sharedParseAndReportMs: sample.capture.parseAndReportMs, versions };
});
const reanalysis = reanalysisPath ? read(reanalysisPath) : null;
if (reanalysis) assert.ok(reanalysis.results.every(row => row.status === 'PASS'));
const byteEquality = bytePath ? read(bytePath) : null;
if (byteEquality) assert.ok(byteEquality.explicitBufferEquals && byteEquality.results.every(row => row.explicitBufferEquals));
const control = noFingerprintPath ? read(noFingerprintPath) : null;
const controlTrials = control ? control.results ?? control.supplemental ?? [] : [];
if (control) assert.ok(controlTrials.length === 2 && controlTrials.every(row => row.status === 'PASS'));
const summary = {
  schemaVersion: 1, date: '2026-10-25', sourceRevision: benchmark.sourceRevision,
  guiSourceRevision: gui.sourceRevision,
  units: { storage: 'bytes; MB = 1000000 bytes', memory: 'bytes', latency: 'milliseconds; empirical sorted[floor(n*p)] quantiles' },
  serial: true, samples: 3, osFileCacheCleared: false, explicitGc: false,
  inputs: { benchmark: resolve(benchmarkPath), gui: resolve(guiPath), reanalysis: reanalysisPath ? resolve(reanalysisPath) : null,
    byteEquivalence: bytePath ? resolve(bytePath) : null,
    finalPortableDirectory: portableDirectory ? resolve(portableDirectory) : null,
    noFingerprintControl: noFingerprintPath ? resolve(noFingerprintPath) : null },
  builtEntryFingerprints: gui.builtEntryFingerprints ?? gui.results[0]?.builtEntryFingerprints,
  methodology: [
    'Each DEM was parsed once into identical sources for format comparisons. Saves were repeated three times per format.',
    'Both formats use the current common reader. This is a format comparison, not a measurement of the original 9318ed9 double-decoding worker.',
    'Open/seek/switch/release come from 24 fresh GUI processes. Final portable measurements use the one-shot-verifier build and separate samples; older portable Main allocation experiments are not included in the final memory peaks.',
    'New-process open means a fresh process with OS file cache retained. It does not mean a cold physical disk.',
    'GUI IPC times are measured inside Renderer around the real API; CDP transfer and post-request JSON/SHA verification are excluded.',
    'Main and Utility memory comes from passive 100ms observers on exact copies of built code; Renderer heap uses CDP, working sets use app.getAppMetrics.',
    'JS heap, RSS/working set, external and ArrayBuffer values are separate. ArrayBuffers are included in external; no complete native allocator profile is claimed.',
    'Blocking work can hide brief sampled heap peaks. Lifetime maxRSS and process working-set high water supplement sampled observations.',
    'Tool shared parse/report includes independent source identity checks; it is not a GUI import SLA or three independent DEM parse timings.',
    'Raw archives, logs, screenshots and timelines stay in owned temporary directories; only this compact evidence is committed.',
  ],
  results, reanalysis: reanalysis ? {
    serial: reanalysis.serial, nativeDemParses: reanalysis.nativeDemParses, explicitGc: reanalysis.explicitGc,
    demCopiedRenamedOrDownloaded: reanalysis.demCopiedRenamedOrDownloaded, limits: reanalysis.limits,
    results: reanalysis.results.map(row => ({ name: row.name, sourceSha256: row.sourceSha256,
      fromArchiveVersion: row.fromArchiveVersion, toArchiveVersion: row.toArchiveVersion, self: row.self,
      reanalysisMs: row.reanalysisMs, offlineChunks: row.offlineChunks, offlineHeatmapCases: row.offlineHeatmapCases,
      importedAtAndSelfPreserved: row.importedAtAndSelfPreserved, generationChanged: row.generationChanged,
      sourceDemUnmodified: row.sourceDemUnmodified, fullReportCanonicalSourcesAndMetadataByteExact: row.canonical.fullReportCanonicalSourcesAndMetadataByteExact,
      oldGenerationCleaned: row.canonical.oldGenerationCleaned, memory: row.memory, sharedStorage: row.sharedStorage, status: row.status })),
  } : null,
  byteEquivalence: byteEquality ? byteEquality.results.map(row => ({ fixture: row.fixture, sourceSha256: row.sourceSha256,
    roles: row.roles, metadata: row.metadata, chunks: row.chunks, budgets: row.budgets,
    explicitBufferEquals: row.explicitBufferEquals, readDem: row.readDem, runtime: { electron: row.runtime.electron, node: row.runtime.node } })) : null,
  noFingerprintControl: control ? { sourceRevision: control.sourceRevision, builtEntryFingerprints: control.builtEntryFingerprints,
    purpose: 'Additional labelled controls excluding QA JSON/TextEncoder/crypto fingerprints; original integrity/performance evidence is retained separately.',
    results: controlTrials.map(row => ({ name: row.name, version: row.version, trial: row.trial, status: row.status,
      newProcessFirstOpenMs: row.newProcessFirstOpenMs, sameProcessReopenMs: row.sameProcessReopenMs,
      seek: { unique: row.seek.unique, repeated: row.seek.repeated },
      memory: memoryFor([row], () => true), releasedUtilityExited: row.releasedUtilityExited })) } : null,
};
// Keep the machine evidence compact; the companion Markdown contains readable tables.
writeFileSync(resolve(outputPath), JSON.stringify(summary) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ output: resolve(outputPath), samples: results.length }));
