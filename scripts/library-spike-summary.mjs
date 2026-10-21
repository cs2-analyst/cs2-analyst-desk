// Build the public L0 measurement summary without publishing player identities or source snapshots.
import assert from 'node:assert/strict';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { digest, quantiles } from './library-spike-core.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const native = createRequire(import.meta.url)(join(root, 'packages/demoparser-native/index.cjs')).getBindingProvenance();
const [benchmarkArg, sqliteArg, electronArg, codecArg, faultArg, verificationArg, catalogueArg, outputArg] = process.argv.slice(2);
assert.ok(outputArg, 'Usage: library-spike-summary.mjs benchmark.json sqlite.json electron.json codec.json fault.json verification.json catalogue.json output.json');
const read = path => JSON.parse(readFileSync(resolve(path), 'utf8'));
const benchmark = read(benchmarkArg), sqlite = read(sqliteArg), electron = read(electronArg), codec = read(codecArg), faults = read(faultArg), verification = read(verificationArg), catalogue = read(catalogueArg);
for (const input of [sqlite, electron, codec, faults, verification, catalogue]) assert.equal(input.status, 'PASS');
const artifact = path => ({ path: relative(root, resolve(path)).replaceAll('\\', '/'), bytes: statSync(path).size, sha256: digest(readFileSync(path)) });
const pngArtifact = path => { const bytes = readFileSync(path); assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a'); return { ...artifact(path), width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }; };
const groups = files => {
  const result = {};
  for (const file of files) {
    const key = file.path.startsWith('replay/') ? 'replayChunks' : file.path.startsWith('heatmap/') ? file.path.split('/')[1].split('.')[0] : 'report';
    const group = result[key] ??= { count: 0, rawBytes: 0, maxRawBytes: 0, 'gzip-6': { bytes: 0, encodeMs: 0, decodeMs: 0, cpuUserMicroseconds: 0, cpuSystemMicroseconds: 0 }, 'brotli-4': { bytes: 0, encodeMs: 0, decodeMs: 0, cpuUserMicroseconds: 0, cpuSystemMicroseconds: 0 } };
    group.count++; group.rawBytes += file.rawBytes; group.maxRawBytes = Math.max(group.maxRawBytes, file.rawBytes);
    for (const name of ['gzip-6', 'brotli-4']) {
      for (const metric of ['bytes', 'encodeMs', 'decodeMs']) group[name][metric] += file.codecs[name][metric];
      group[name].cpuUserMicroseconds += file.codecs[name].cpuMicroseconds.user;
      group[name].cpuSystemMicroseconds += file.codecs[name].cpuMicroseconds.system;
    }
  }
  return result;
};
const result = { schemaVersion: 1, stage: 'L0', experimentResult: 'PASS', gateDecision: 'REVIEW — Orchestrator independent decision pending; not L1–L5 acceptance',
  executedAt: benchmark.executedAt, productBaseline: '43bbd98fe42adafd501aca6e30af8c253e770e85', measurementRuntime: benchmark.runtime,
  parser: { version: '0.42.0-backport.363.1', source: native.source, target: native.target, binarySha256: native.verifiedSha256,
    provenance: 'Native package verifies source manifest and binary SHA on loading; same fixed binding as the capture production parser.' },
  measurementGitHead: benchmark.sourceBaseline,
  provenance: 'Original measurements are unchanged. Capture preceded the later experimentalPipelineMs label, GC-required guard, fixture guard, all-chunk cold verification and write-cost breakdown instrumentation. The newer all-chunk cold counter / write-cost breakdown were not executed for this record and are not claimed as evidence. All chunks were codec-byte-checked at capture; cold random reads are counted separately.',
  realMatchCount: 2,
  samples: benchmark.samples.map(sample => {
    const m = sample.manifest, restored = sample.restore, ui = electron.samples.find(s => s.fixture.sha256 === m.source.sha256);
    const fullCheck = verification.samples.find(s => s.fixture.sha256 === m.source.sha256);
    assert.equal(restored.heatmapCasesEqual, m.heatmapComparisons.length); assert.equal(ui.status, 'PASS'); assert.equal(ui.views.length, 6);
    assert.equal(ui.reportHash, m.reportHash); assert.equal(fullCheck.replayChunksEqual, m.replay.count);
    assert.equal(fullCheck.filesVerified, m.files.length);
    const manifestPath = resolve(benchmarkArg, '..', m.source.fileName.replace('.dem', ''), 'manifest.json');
    const manifestBytes = statSync(manifestPath).size;
    return { fixture: m.source, reportSchemaVersion: m.reportSchema, replaySchemaVersion: m.replaySchema,
      components: groups(m.files), replay: m.replay, storage: { rawPayloadBytes: m.storage.rawPayloadBytes,
        gzipPayloadBytes: m.storage.gzipPayloadBytes, experimentalManifestBytes: manifestBytes,
        measuredGzipSnapshotLogicalBytes: manifestBytes + m.storage.gzipPayloadBytes, fileCount: m.storage.fileCount,
        brotliCandidatePayloadBytes: m.storage.brotliPayloadBytes,
        portableContainerOverhead: 'Not applicable: disposable directory snapshot, not a .cs2a container. No claim of a complete persisted Brotli snapshot; individual files/codec reads validated.',
        excluded: 'Experiment logs, restore result JSON and NTFS directory/allocation-unit overhead; no raw DEM or bundled media included.' },
      timing: { ...m.timing, experimentalPipelineMs: m.timing.experimentalPipelineMs ?? m.timing.existingProductionImportMs,
        existingProductionImportMs: undefined, note: 'Node26 experimental parse/report/session plus explicit GC; not measured first-import Electron/NSIS latency. Both codec comparisons are included in compressionComparisonAndWriteMs.' },
      captureMemory: { ...m.observed, classification: 'Lifecycle peak of Node26 experiment including native parsing, serialization, both codecs and full projection matrix; not production Utility-only peak.' },
      experimentalGc: m.experimentalGc,
      persistedFileVerification: { filesVerified: fullCheck.filesVerified, replayChunksEqual: fullCheck.replayChunksEqual,
        originalTickSamplesEqual: fullCheck.originalTickSamplesEqual, rawBytesVerified: fullCheck.rawBytesVerified,
        compressedBytesVerified: fullCheck.compressedBytesVerified, elapsedMs: fullCheck.elapsedMs,
        scope: 'All persisted files read, bounded-inflated and SHA checked; each replay block identity and original tick sample compared. Separate from the original cold-process random read matrix.' },
      restored: { reportHash: restored.reportHash, reportMs: restored.reportMs, randomReadMs: restored.randomReadMs,
        exactRawTickFrames: restored.exactRawTickFrames, canonicalSourceLoadMs: restored.canonicalSourceLoadMs,
        heatmapCasesEqual: restored.heatmapCasesEqual, heatmapProjectionMs: restored.heatmapProjectionMs,
        maxMeasuredHeatmapResponseBytes: Math.max(...m.heatmapComparisons.map(comparison => comparison.bytes)),
        totalMs: restored.totalMs, cpuMicroseconds: restored.cpuMicroseconds, memory: restored.observed },
      electron: { openMs: ui.openMs, views: ui.views.map(v => v.view), playersChanged: ui.players.length,
        replayChecks: ui.replay.length, replayEffectLabels: ui.replay.map(v => v.label).filter(v => v?.startsWith('effect-')),
        representativeHeatmapRequests: ui.heatmap.length, renderedUiFilters: ui.uiFilters,
        originalDemAbsent: ui.originalDemAbsent, newSessionCreated: true, exitCode: ui.exitCode,
        utilityObservedPeakWorkingSetBytes: ui.processes.find(process => process.pid === ui.hostAudit.imports[0].pid)?.peakWorkingSet,
        utilityInitialization: ui.hostAudit.imports.map(({ sessionId, pid, runtime, memory, ...other }) => ({ pid, runtime, memory, ...other })),
        scope: 'Actual unchanged production Renderer/preload; disposable snapshot Main/Utility host. No forced GC. Not L2 production IPC or NSIS acceptance.' },
      artifacts: { manifest: artifact(manifestPath), restored: artifact(resolve(benchmarkArg, '..', m.source.fileName.replace('.dem', ''), 'restore.json')),
        screenshots: ui.views.map(v => pngArtifact(resolve(electronArg, '..', m.source.fileName.replace('.dem', ''), v.view + '.png'))) } };
  }),
  isolationSimulation: { realMatchCount: 2, independentCopiedArchives: 10, eachFreshProcess: true, demCopied: false,
    randomReadCount: benchmark.isolationSimulation.results.reduce((n, r) => n + r.randomReadMs.count, 0),
    totalExactHeatmapComparisons: benchmark.isolationSimulation.results.reduce((n, r) => n + r.heatmapCasesEqual, 0),
    allOriginalDemPathsAbsent: benchmark.isolationSimulation.results.every(r => r.originalDemAbsent),
    reopenTotalMs: quantiles(benchmark.isolationSimulation.results.map(r => r.totalMs)),
    scope: 'Ten separate snapshot directories derived from two real matches; not ten real matches and not SQLite/list scalability.' },
  independentCodecFiles: codec,
  experimentalCatalogue: { status: catalogue.status, method: catalogue.method, limitations: catalogue.limitations,
    remainingOwnedProcesses: catalogue.remainingOwnedProcesses,
    datasets: catalogue.datasets.map(dataset => {
      assert.equal(dataset.observations.length, 20);
      assert.ok(dataset.observations.every(observation => observation.status === 'PASS' && observation.archiveFilesPresent === 0));
      return { simulatedRows: dataset.simulatedRows, coldProcessObservations: dataset.observations.length,
        runtime: dataset.seed.runtime, returnedRows: dataset.returnedRows, listBytes: dataset.listBytes,
        databaseBytes: dataset.databaseBytes, timing: dataset.timing, archiveFilesPresent: 0 };
    }) },
  sqlite: { runtime: sqlite.runtime, main: sqlite.main, utility: sqlite.utility.result, crashRecovery: sqlite.crashRecovery,
    priorSuccessfulRuns: ['sqlite-probe.json', 'sqlite-probe-repeat-2.json', 'sqlite-probe-repeat-3.json'].map(name => {
      const path = join(root, '.tmp/l0', name), observed = read(path); assert.equal(observed.status, 'PASS');
      return { artifact: artifact(path), recoveryOpenMs: observed.crashRecovery.recoveryOpenMs,
        transientOpenErrors: observed.crashRecovery.transientOpenErrors };
    }),
    lifecycle: sqlite.processLifecycle, limitations: sqlite.limitations,
    requiredDownstreamConstraint: 'Windows Utility exit may precede release of SQLite file handles. Close failed connections and use bounded retry; preserve diagnostics. No infinite retry or swallowed corruption.' },
  faults,
  recommendations: { payload: 'A: complete canonical Match + MatchReplay + MatchSpatialEvidence for every current Heatmap scope. B equivalence is not proven and must not be substituted.',
    codec: 'Provisional gzip level 6: complete snapshot cold restoration and Electron bridge verified. Brotli quality 4 is smaller/faster in this observation and independently random-readable; adopting it requires a complete reader/writer round-trip in L1.',
    chunks: 'Independently compressed bounded Replay chunks, remove transient sessionId on disk, generate fresh runtime UUID and preserve the original chunk and IPC budgets.',
    database: 'Electron built-in node:sqlite, tiny indexed rows with WAL and synchronous FULL; native third-party SQLite dependency not required by this runtime. Packaged/installed compatibility still an L1/L5 gate.',
    localAppData: 'Resolve and validate Windows LOCALAPPDATA / CS2 Analyst / MatchLibrary; keep existing Electron userData/settings unchanged. Reject symlinks/path escapes in L1.',
    indexing: 'Library first screen must query small catalogue rows without decompressing archived matches. The experiment does not implement or benchmark a production catalogue.' },
  unchangedDebt: ['P7 independent Replay query 5131.302ms exceeds 5000ms; this experiment does not resolve it.', 'Map/DEM resource-version matching unconfirmed.', 'P7 historical NOT RUN items remain NOT RUN.'],
  notRun: ['NSIS node:sqlite/package compatibility', 'Production L1 transaction / crash-atomic catalogue + archive behavior', 'Production cold-start library list/large catalogue', 'Physical power-loss test', 'Installed six-view offline restore', 'P8'],
  artifacts: { benchmark: artifact(benchmarkArg), sqlite: artifact(sqliteArg), electron: artifact(electronArg), codec: artifact(codecArg), faults: artifact(faultArg), fullVerification: artifact(verificationArg), catalogue: artifact(catalogueArg), initialNodeFailure: artifact(join(root, '.tmp/l0/initial-capture-memory-admission.log')) },
  preservedFailures: [
    ['sqlite-uncommitted-kill-first-attempt', '.tmp/l0/sqlite-run-bmXGQY/result.json'],
    ['sqlite-forced-1ms-timeout-expected-failure', '.tmp/l0/sqlite-probe-forced-timeout.json'],
    ['electron-hidden-compositor-screenshot-timeout', '.tmp/l0/offline-electron/acceptance.json'],
    ['electron-player-name-whitespace-probe-timeout', '.tmp/l0/offline-electron-final/acceptance.json'],
    ['electron-projection-resolution-probe-timeout', '.tmp/l0/offline-electron-final-3/acceptance.json'],
  ].map(([kind, path]) => { const source = read(join(root, path)); assert.equal(source.status, 'FAIL'); return { kind, ...artifact(join(root, path)) }; }),
  scripts: ['library-storage-spike.mjs', 'library-spike-core.mjs', 'library-spike.test.mjs', 'library-spike-faults.mjs', 'library-spike-codec-reads.mjs', 'library-spike-verify-snapshots.mjs', 'library-spike-summary.mjs', 'library-sqlite-probe.mjs', 'library-sqlite-electron.cjs', 'library-offline-electron.mjs', 'library-offline-host.cjs', 'library-catalogue-probe.mjs', 'library-catalogue-electron.cjs'].map(name => artifact(join(root, 'scripts', name))) };
writeFileSync(resolve(outputArg), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ output: resolve(outputArg), realMatchCount: result.realMatchCount, samples: result.samples.map(s => ({ fixture: s.fixture.fileName, gzipSnapshotBytes: s.storage.measuredGzipSnapshotLogicalBytes, views: s.electron.views.length, filteredUiResponses: s.electron.renderedUiFilters?.length })) }));
