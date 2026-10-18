// S1 comparison; never rewrites S0 source, traces or committed baseline evidence.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { auditFloorContinuity } from './replay-floor-audit.mjs';
import { replayMapDefinitions } from '../apps/desktop/shared/replay-map-geometry.ts';

const read=(folder,name)=>JSON.parse(readFileSync(resolve(folder,name)));
const beforeFolder='.tmp/p7-nuke-s0',afterFolder='.tmp/p7-nuke-s1';
const lifecycle=read(afterFolder,'lifecycle/electron.json');
assert.equal(lifecycle.status,'PASS');assert.equal(lifecycle.ipc.filter(c=>c.contentHash!==undefined).length,141);
const dust2=read('.tmp/p6-qa','built-electron.json'),dust2Ui=read('.tmp/p7-ui-qa','p7-ui-acceptance.json');
assert.equal(dust2.status,'PASS');assert.equal(dust2Ui.status,'PASS');assert.equal(dust2.reportUnchanged,true);
const baseline=read('docs','p7-nuke-replay-diagnosis.json');
const after=read(afterFolder,'electron.json');
assert.equal(after.status,'PASS');
assert.equal(after.fixtureSha256,baseline.fixture.sha256);
const map=replayMapDefinitions.find(m=>m.id==='de_nuke');
const baselineRuns=[...baseline.windows.flatMap(w=>w.runs),...baseline.electron.otherRuns];
const before=[];
for(const run of baselineRuns){
  const frames=read(beforeFolder,run.filename);
  before.push({label:run.label,frames:frames.length,...auditFloorContinuity(frames,map)});
}
const afterRuns=after.runs.map(run=>({label:run.label,frames:run.frames,
  unknownDisplayLayerFrames:run.unknownFloor,targetUnknownFrames:run.targetUnknownFrames,
  retainedFrames:run.retainedFrames,eligibleDrawMismatchFrames:run.eligibleDrawMismatchFrames,
  baseLayerMismatchFrames:run.baseLayerMismatchFrames,longestZeroPlayerMs:run.longestBlankMs,
  waitingMs:run.waitingMs,waitCount:run.waitCount,...run.floorAudit}));
assert.equal(afterRuns.length,48,'45 matrix runs, two boundary runs, full R1/R2');
for(const r of afterRuns){assert.equal(r.erroneousFrames,0);assert.equal(r.layerMismatches,0);}
const total=runs=>({frames:runs.reduce((n,r)=>n+(r.frames??0),0),
  erroneousFrames:runs.reduce((n,r)=>n+r.erroneousFrames,0),erroneousIntervals:runs.reduce((n,r)=>n+r.erroneousIntervals,0),
  totalMs:runs.reduce((n,r)=>n+r.totalMs,0),longestMs:Math.max(...runs.map(r=>r.longestMs)),
  targetUnknownFrames:runs.reduce((n,r)=>n+r.targetUnknown,0),retainedOpportunities:runs.reduce((n,r)=>n+r.retainedOpportunities,0)});
const quantiles=values=>{const a=[...values].sort((a,b)=>a-b);return {p50:a[Math.floor(a.length*.5)],p95:a[Math.floor(a.length*.95)],max:a.at(-1)};};
const fullFrames=read(afterFolder,'full-r1-r2-auto-1-frames.json');
const w1=read(afterFolder,'w1-跟随玩家-1-frames.json');
const near4354=w1.filter(f=>f.tick>4352&&f.tick<4356).sort((a,b)=>Math.abs(a.tick-4354)-Math.abs(b.tick-4354))[0];
assert.equal(near4354.drawn,9);assert.equal(near4354.selected[2],null);
const assets=after.runs[0].first.imageCache;
const memory=existsSync(resolve(afterFolder,'memory-observations.json'))?read(afterFolder,'memory-observations.json'):null;
const memoryPeaks=[...lifecycle.processMemory.filter(p=>p.role==='utility').map(p=>p.peak),...after.processMemory.filter(p=>p.role==='utility').map(p=>p.peak),...(memory?.samples??[]).flatMap(s=>s.utility.map(p=>p.peak))];
const output={schema:'p7-nuke-replay-fix-v1',date:'2026-10-18',baseline:'f44141a5aaa01d140efd8486f8f99fee288fd027',
  scope:'S1 only; real built Electron/CDP, offline, no new DEM query in production; S0 committed evidence unchanged',
  fixture:baseline.fixture,baselineEvidenceSha256:createHash('sha256').update(readFileSync('docs/p7-nuke-replay-diagnosis.json')).digest('hex'),
  status:after.status,page:after.page,exceptions:after.exceptions,checks:{...after.checks,...lifecycle.checks},
  supplementalLifecycle:{status:lifecycle.status,checks:lifecycle.checks,verifiedEventUtilityChunks:lifecycle.ipc.length,exceptions:lifecycle.exceptions},
  dust2:{status:dust2.status,fixtureSha256:dust2.fixtureSha256,reportUnchanged:dust2.reportUnchanged,reportFingerprint:dust2.reportFingerprint,totalImportMs:dust2.totalImportMs,firstFrameMs:dust2.firstFrameMs,ipcMs:dust2.ipcMs,drawP95Ms:dust2.drawP95Ms,utilityImportPeakBytes:Math.max(...dust2.processMemory.filter(p=>p.Role==='analysis-utility').map(p=>p.PeakWorkingSet64)),uiStatus:dust2Ui.status,uiChecks:dust2Ui.checks},
  comparison:{before:total(before),after:total(afterRuns),
    method:'Identical independent observation oracle applied separately to retained S0 actual-paint traces and new S1 traces; each file is one uninterrupted forward run after seek. Does not trust S1 floorStatus to detect errors. Wall time, not native-tick truth; totals across intentionally repeated runs, not whole-match prevalence.'},
  windows:baseline.windows.map(w=>({index:w.index,round:w.round,ticks:[w.startTick,w.endTick],target:w.nickname,
    baselineOneX:before.find(r=>r.label===`w${w.index}-跟随玩家-1`),
    afterOneX:afterRuns.find(r=>r.label===`w${w.index}-跟随玩家-1`),
    sourceMissingTicks:w.reference.selectedPlayerMissingTicks,
    scope:w.index===5?'Native gaps remain: no fake coordinates; zero eligible players is excluded from erroneous blank metric':'Target positions remain unavailable at conservative interpolation boundaries'})),
  w1Evidence:{scope:'Closest actual forward-playing paint to tick4354; fractional observed tick explicitly retained',
    tick:near4354.tick,selected:near4354.selected,layerId:near4354.layerId,status:near4354.floorStatus,drawn:near4354.drawn,
    baseLayer:near4354.baseLayer,paintCalls:near4354.paintCalls},
  runs:afterRuns,beforeRuns:before,
  performance:{importMs:after.importMs,firstFrameMs:after.firstFrameMs,ipc:quantiles(after.ipc.map(r=>r.ms)),
    verifiedChunks:after.ipc.length,ipcFramesParity:true,verifiedEventUtilityChunks:lifecycle.ipc.length,eventUtilityParity:true,drawMs:quantiles(fullFrames.filter(f=>f.imageReady&&f.drawn>0).map(f=>f.drawP95)),
    drawScope:'Quantiles of production rolling-120-draw p95 snapshots across full R1/R2; observer overhead present. Not raw independent draw sample quantiles or an FPS claim.',
    utilityPeakBytes:Math.max(...memoryPeaks),
    utilityPeakScope:memory?memory.scope+' Supplemental lifecycle run also samples OS historical peaks after import and before closing the reimported worker.':'OS historical peak snapshots at import, after playback and after lifecycle; per-process peaks, not application total',
    utilityMemorySamples:{main:memory?.samples??after.processMemory.filter(p=>p.role==='utility'),supplementalLifecycle:lifecycle.processMemory.filter(p=>p.role==='utility')},
    imageCache:{images:assets.map(a=>({layer:a.id,width:a.width,height:a.height,status:a.status})),
      pngBytes:map.layers.reduce((sum,l)=>sum+statSync(resolve('apps/desktop/renderer/src/assets/replay-maps',l.image)).size,0),
      estimatedRgbaBytes:assets.reduce((sum,a)=>sum+a.width*a.height*4,0),
      scope:'Actual two decoded 1024x1024 images / compressed bytes; RGBA estimate excludes browser decoder/GPU overhead and is not a measured OS memory delta. One extra layer vs previous one-image owner; lifecycle disposal verified.'}},
  screenshots:after.screenshots.map(s=>({path:`${afterFolder}/${s.name}`,tick:s.state.tick,mode:s.state.mode,
    layer:s.state.layerId,status:s.state.floorStatus,drawn:s.state.drawn,baseNonempty:s.state.baseNonempty})),
  limitations:['No real Vertigo fixture: geometry/synthetic threshold tests only',
    'No full 21-round per-display-frame playthrough, all-player permutations, disconnect demo, installed build, physical multi-monitor DPI or independent manual walkthrough',
    'Known parser <=5s replay-query budget remains independently tracked; S1 does not optimize or remeasure native query timing',
    'Normal empty floors, native missing rows and cold seeks without reliable history intentionally remain blank',
    'Original map resource/DEM-version match remains unconfirmed; no topology/LOS claim']};
writeFileSync(resolve('docs/p7-nuke-replay-fix.json'),JSON.stringify(output,null,2)+'\n');
console.log(JSON.stringify({comparison:output.comparison,performance:output.performance,w1:output.w1Evidence,checks:output.checks},null,2));
