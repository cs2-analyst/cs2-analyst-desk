import assert from 'node:assert/strict';
import test from 'node:test';
import { useReport } from '../renderer/src/store.ts';
const oldReport=()=>({match:{id:'old'},selectedPlayer:'1',players:[{id:'1',nickname:'p'}],analytics:[{kills:3}],replay:{available:true,sessionId:'old-session'}});
test('file-dialog and candidate parsing cancellation preserve the active replay session',async()=>{
  const previous=globalThis.window;let finish;
  try{
    globalThis.window={cs2Analyst:{importDemo:()=>new Promise(r=>finish=r),cancelImport:async()=>finish({kind:'cancelled'})}};
    const original=oldReport();useReport.setState({status:'success',report:original,playerId:'1',error:null});
    const dialog=useReport.getState().importDemo();finish({kind:'cancelled'});await dialog;
    assert.equal(useReport.getState().report.replay.sessionId,'old-session');
    const parsing=useReport.getState().importDemo();useReport.getState().setPhase('parsing');
    assert.equal(useReport.getState().report.replay.available,true);assert.equal(useReport.getState().report.replay.sessionId,'old-session');
    await useReport.getState().cancelImport();await parsing;
    assert.equal(useReport.getState().status,'success');assert.deepEqual(useReport.getState().report.analytics,[{kills:3}]);
    assert.equal(original.replay.available,true,'old DTO is not mutated');
  }finally{globalThis.window=previous;useReport.setState({status:'idle',report:null});}
});
test('late progress cannot retire the newly completed report',async()=>{
  const previous=globalThis.window;try{
    const report=oldReport();globalThis.window={cs2Analyst:{importDemo:async()=>({kind:'success',report})}};
    useReport.setState({status:'idle',report:null});await useReport.getState().importDemo();useReport.getState().setPhase('parsing');
    assert.equal(useReport.getState().status,'success');assert.equal(useReport.getState().report.replay.sessionId,'old-session');
  }finally{globalThis.window=previous;useReport.setState({status:'idle',report:null});}
});
