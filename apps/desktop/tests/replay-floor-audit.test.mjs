import assert from 'node:assert/strict';
import test from 'node:test';
import { auditFloorContinuity } from '../../../scripts/replay-floor-audit.mjs';
import { replayMapDefinitions } from '../shared/replay-map-geometry.ts';
const map=replayMapDefinitions.find(m=>m.id==='de_nuke');
const selected=[0,0,0,0,-400,0,100,true,'T',1,false],survivor={sample:[1,0,0,0,-400,0,100,true,'T',1,false]};
const frame=(ms,extra={})=>({ms,tick:ms,round:1,playerId:'p',mode:'auto',selected,layerId:'default',drawn:2,chunkLoaded:true,players:[survivor],...extra});
test('independent oracle catches history silently lost as unknown, excludes native gaps and cold seeks',()=>{
  const unknown=[0,null,null,null,null,null,null,null,'Unknown',null,false];
  const bad=frame(40,{selected:unknown,layerId:null,drawn:0,floorStatus:'unknown'});
  const result=auditFloorContinuity([frame(0),bad,frame(60)],map);
  assert.equal(result.erroneousFrames,1);assert.equal(result.erroneousIntervals,1);assert.equal(result.totalMs,20);
  assert.equal(auditFloorContinuity([bad],map).erroneousFrames,0,'cold seek has no reliable history');
  assert.equal(auditFloorContinuity([frame(0),{...bad,players:[]}],map).erroneousFrames,0,'native missing rows do not become fake positions');
  assert.equal(auditFloorContinuity([frame(0),{...bad,layerId:'default',drawn:1}],map).erroneousFrames,0);
});
