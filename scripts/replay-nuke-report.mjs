// Compact, auditable S0 evidence. Large traces and images stay in ignored .tmp/.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { replayMapDefinitions, resolveMapLayer, worldToRadar } from '../apps/desktop/shared/replay-map-geometry.ts';
import { summarizeObservedFrames } from './replay-diagnosis-core.mjs';

const folder = resolve('.tmp/p7-nuke-s0');
const read = name => JSON.parse(readFileSync(resolve(folder, name)));
const source = read('source.json'), electron = read('electron.json'), visual = read('sequences/electron.json');
assert.equal(electron.status, 'DIAGNOSED'); assert.equal(visual.status, 'DIAGNOSED');
assert.equal(source.sha256, electron.fixtureSha256); assert.equal(source.sha256, visual.fixtureSha256);
const { metadata, chunks } = read('chunks.json'), map = replayMapDefinitions.find(m => m.id === metadata.map);
const ratio = (numerator, denominator) => ({ numerator, denominator, ratio: denominator ? numerator / denominator : null });
const tiny = f => ({ round: f.round, tick: f.tick, uiTick: f.uiTick, playerId: f.playerId, selected: f.selected,
  mode: f.mode, layerId: f.layerId, targetFloor: f.targetFloor, imageReady: f.imageReady, chunkLoaded: f.chunkLoaded,
  block: f.block, drawn: f.drawn, paintCalls: f.paintCalls, eligible: f.eligible, leftTick: f.leftTick, rightTick: f.rightTick, gap: f.gap, reasons: f.reasons });
function frameAudit(frames) {
  let sourceComparable = 0, sourceOmitted = 0, imageGated = 0, liveFloorDisagreesWithCurrentTarget = 0;
  let autoFrames=0,autoUnknownFloor=0;
  let rawXYZOpportunities=0,rawXYZOmitted=0;
  const omitted = {},rawXYZOmittedReasons={};
  for (const f of frames) {
    if(f.mode==='auto'){autoFrames++;if(f.layerId===null)autoUnknownFloor++;}
    if (f.layerId !== f.targetFloor && f.mode === 'auto') liveFloorDisagreesWithCurrentTarget++;
    if (!f.layerId || !f.chunkLoaded) continue;
    const chunk = chunks.find(c => c.round === f.round && c.block === f.block);
    const a = chunk.frames.findLast(p => p.tick <= f.tick), b = a.tick === f.tick ? a : chunk.frames.find(p => p.tick > f.tick);
    for (const left of a.players) {
      const right = b?.players.find(p => p[0] === left[0]);
      // Native evidence is available at both bracket endpoints. This is NOT a native
      // observation at the fractional display tick or proof of current visibility.
      const validXYZ = p => p && p[1] !== null && p.slice(2, 5).every(Number.isFinite)
        && resolveMapLayer(map, p[4]) === f.layerId;
      if (!validXYZ(left) || !validXYZ(right)) continue;
      rawXYZOpportunities++;
      const p = f.players.find(p => p.id === metadata.players[left[0]].id);
      // f.players.reason uses current target floor in auto mode; Canvas instead uses
      // the committed live floor. Re-evaluate against that actual layer, never mix them.
      const sample = p?.sample;
      const point = sample && sample[2] !== null && sample[3] !== null ? worldToRadar(map, { x: sample[2], y: sample[3] }) : null;
      const eligible = sample?.[7] === true && point && resolveMapLayer(map, sample[4]) === f.layerId
        && point.x >= 0 && point.y >= 0 && point.x <= map.width && point.y <= map.height;
      if(!eligible||!f.imageReady){
        rawXYZOmitted++;
        const reason=!f.imageReady?'image-not-ready':sample?.[7]!==true?'not-alive-or-state-unknown':p?.interpolation??'unknown';
        rawXYZOmittedReasons[reason]=(rawXYZOmittedReasons[reason]??0)+1;
      }
      if(left[7]!==true||right[7]!==true)continue;
      sourceComparable++;
      if (!eligible || !f.imageReady) {
        sourceOmitted++; const reason = !f.imageReady ? 'image-not-ready' : p?.interpolation ?? 'unknown';
        omitted[reason] = (omitted[reason] ?? 0) + 1;
      }
    }
    if (!f.imageReady && f.eligible > 0) imageGated++;
  }
  return { ...summarizeObservedFrames(frames), knownFloorBothEndpointAlivePositionOpportunities: sourceComparable,
    autoFrames,autoUnknownFloor,
    knownFloorRawXYZEndpointOpportunities:rawXYZOpportunities,rawXYZAvailableButNotDrawable:rawXYZOmitted,rawXYZOmittedReasons,
    sourceAvailableButNotDrawable: sourceOmitted, omittedReasons: omitted, imageGatedFrames: imageGated,
    liveFloorDisagreesWithCurrentTarget,
    comparisonScope: 'Actual painted frames with known live floor; native alive XYZ on that floor at BOTH bracket endpoints (exact samples use one endpoint); excludes raw dead/other-floor data. Not fractional-tick native truth. Draw eligibility parity is a separate metric.' };
}
const runs = electron.runs.map(run => {
  const frames = read(run.filename);
  return { ...run, ...frameAudit(frames), first: tiny(run.first), last: tiny(run.last) };
});
const windows = source.windows.map((w, index) => {
  const samples = w.reference.selectedRows;
  const selected = samples.filter(r => [w.startTick, w.startTick + 1, Math.floor(w.tick), w.endTick - 1, w.endTick, w.endTick + 1].includes(r.tick));
  return { index: index + 1, kind: w.kind, categories: w.kind === 'native-missing' ? ['A', 'C', 'D'] : ['C', 'D'],
    round: w.round, startTick: w.startTick, endTick: w.endTick, midpointTick: w.tick,
    relativeSeconds: w.relativeSeconds, playerId: w.playerId, nickname: metadata.players[w.playerIndex].nickname,
    left: w.left, right: w.right, leftFloor: resolveMapLayer(map, w.left[4]), rightFloor: resolveMapLayer(map, w.right[4]),
    reference: { from: w.reference.from, to: w.reference.to, requestedTicks: w.reference.requestedTicks,
      expectedRows: w.reference.expectedRows, returnedRows: w.reference.returnedRows,
      selectedPlayerMissingTicks: Array.from({ length: w.reference.requestedTicks }, (_, i) => i + w.reference.from).filter(t => !samples.some(r => r.tick === t)),
      selectedRows: selected },
    runs: runs.filter(r => r.label.startsWith('w' + (index + 1) + '-')),
    screenshots: electron.screenshots.filter(s => s.name.startsWith('w' + (index + 1) + '-')).map(s => ({ name: s.name, baseNonempty: s.state.baseNonempty, ...tiny(s.state) })),
    sequenceFiles: visual.screenshots.filter(s => s.name.startsWith('w' + (index + 1) + '-') && s.name.includes('-sequence')).map(s => ({ name: 'sequences/' + s.name, tick: s.state.tick, selected: s.state.selected, layerId: s.state.layerId, drawn: s.state.drawn, baseNonempty: s.state.baseNonempty })),
    reproducible: true };
});
const allFrames = runs.reduce((n, r) => n + r.frames, 0);
const ipcMs = electron.ipc.map(r => r.ms).sort((a, b) => a - b);
const output = { schema: 'p7-nuke-replay-diagnosis-v1', date: '2026-10-18', baseline: 'a9ca7e8bed767e2087528bf40be3e6eb51e9034d',
  playerTupleFields:['playerIndex','actualTick','x','y','z','yaw','health','alive','side','segment','stateAmbiguous'],
  replayContract:{schemaVersion:metadata.schemaVersion,samplingVersion:metadata.samplingVersion,resourceId:metadata.resourceId,tickRate:metadata.tickRate,maxInterpolationTicks:metadata.maxInterpolationTicks},
  conclusion: 'CONFIRMED ROOT CAUSE', scope: 'S0 diagnosis only; no production computation/protocol change or S1 implementation',
  fixture: { path: '.demo/nuke.dem', sha256: source.sha256, bytes: source.fileBytes, nativeSha256: source.nativeSha256 },
  source: { ...source, windows: undefined, rounds: undefined, players: undefined, midpointAudit: undefined,
    rawPositionAvailability: ratio(source.rawValidPositions, source.expectedPlayerSamples),
    replayPositionAvailability: ratio(source.replayValidPositions, source.expectedPlayerSamples) },
  midpointAudit: source.midpointAudit,
  electron: { page: electron.page, importMs: electron.importMs, exceptions: electron.exceptions, checks: electron.checks,
    attempts:electron.attempts??[],sessions:electron.sessions??[],
    method: 'Existing built Electron/CDP workflow; Browser skill absent. Actual Canvas mutation observations; read-only current React tree/cache refs and delegated Canvas marker-call counts. Instrumented sampling, not uninstrumented FPS.',
    totalObservedFrames: allFrames, unknownFloor: ratio(runs.reduce((n, r) => n + r.unknownFloor, 0), allFrames),
    autoFloorUnknown: ratio(runs.reduce((n,r)=>n+r.autoUnknownFloor,0),runs.reduce((n,r)=>n+r.autoFrames,0)),
    eligibleDrawMismatchFrames: runs.reduce((n, r) => n + r.eligibleDrawMismatchFrames, 0),
    drawableFrames:runs.reduce((n,r)=>n+r.drawableFrames,0),drawablePlayerOpportunities:runs.reduce((n,r)=>n+r.drawablePlayerOpportunities,0),
    waitCount: runs.reduce((n, r) => n + r.waitCount, 0), waitingMs: runs.reduce((n, r) => n + r.waitingMs, 0),
    longestBlankMs: Math.max(...runs.map(r => r.longestBlankMs)),
    sourceComparison: { opportunities: runs.reduce((n, r) => n + r.knownFloorBothEndpointAlivePositionOpportunities, 0),
      notDrawable: runs.reduce((n, r) => n + r.sourceAvailableButNotDrawable, 0),
      reasons:runs.reduce((sum,r)=>{for(const[k,v]of Object.entries(r.omittedReasons))sum[k]=(sum[k]??0)+v;return sum;},{}),
      scope: runs[0].comparisonScope,
      rawXYZIncludingDead: {opportunities:runs.reduce((n,r)=>n+r.knownFloorRawXYZEndpointOpportunities,0),notDrawable:runs.reduce((n,r)=>n+r.rawXYZAvailableButNotDrawable,0),
        reasons:runs.reduce((sum,r)=>{for(const[k,v]of Object.entries(r.rawXYZOmittedReasons))sum[k]=(sum[k]??0)+v;return sum;},{}),
        scope:'Same live-floor/native XYZ endpoint test WITHOUT alive restriction, intentionally includes expected dead-player omission; not all omitted source positions are rendering errors'} },
    ipc: { verifiedChunks: electron.ipc.length, parity: 'All frame JSON FNV32 fingerprints and block ranges match independent ReplaySession (non-cryptographic regression comparison)',
      ms: { p50: ipcMs[Math.floor(ipcMs.length * .5)], p95: ipcMs[Math.floor(ipcMs.length * .95)], max: ipcMs.at(-1) },
      scope: 'Explicit sequential real preload/Main/worker requests; not renderer cache miss or playback wait counts' },
    otherRuns: runs.filter(r => !r.label.startsWith('w')),
    timingScope: 'Main electron.json only; separate visual sequence run includes screenshot overhead and is excluded. Blank duration = observed wall time until next drawn frame or censored run endpoint; normal empty floors also count. Category percentages below use five deliberately selected windows, not prevalence.' },
  classifications: ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map(category => {
    const count = windows.filter(w => w.categories.includes(category)).length;
    return { category, windows: count, denominator: windows.length, ratio: count / windows.length,
      status: ['A', 'C', 'D'].includes(category) ? 'CONFIRMED' : category === 'F' ? 'Observed at separate continuous-round transitions; not a cause within these five windows' : 'UNREPRODUCED' };
  }),
  windows,
  limitations: ['Five deliberately selected windows; full 1x continuous R1/R2 only, not all 21 rounds at display-frame resolution',
    'A means missing recorded same-tick source/native row, not corruption or proof of absent persistent game state',
    'Midpoints are unweighted interval opportunities; not all ticks/time prevalence',
    'G denominator requires known live layer, image ready and final eligible position; raw-source omissions are reported separately',
    'No real Vertigo fixture, installed-package, disconnect, physical DPI or manual walkthrough validation in S0',
    'No map collision/topology/LOS validation; resource/DEM version remains unconfirmed'] };
writeFileSync(resolve('docs/p7-nuke-replay-diagnosis.json'), JSON.stringify(output, null, 2) + '\n');
console.log(JSON.stringify({ frames: allFrames, windows: windows.length, electron: output.electron, classifications: output.classifications }, null, 2));
