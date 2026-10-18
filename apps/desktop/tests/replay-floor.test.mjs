import assert from 'node:assert/strict';
import test from 'node:test';
import { replayFloorAt } from '../renderer/src/replay-floor.ts';
import { replayDisplayFrame } from '../renderer/src/replay-state.ts';
import { replayMapDefinitions, resolveMapLayer } from '../shared/replay-map-geometry.ts';
import { explainFrame } from '../../../scripts/replay-diagnosis-core.mjs';
const nuke = replayMapDefinitions.find(m => m.id === 'de_nuke');
const player = (tick, z = -400, alive = true) => [0, tick, 0, 0, z, 0, alive ? 100 : 0, alive, 'T', alive ? 1 : null, false];
const input = (extra = {}) => ({ sessionId:'s',matchId:'m',round:1,playerId:'p',seekRevision:0,
  mode:'auto',tick:0,map:nuke,selected:player(0),...extra });
const seed = () => replayFloorAt(null,input());

test('background history preserves survivors at the death boundary without restoring target coordinates', () => {
  const rows = tick => Array.from({length:10},(_,i)=>[i,tick,0,0,-400,0,100,true,'T',1,false]);
  const a=rows(4352),b=rows(4356);b[0]=player(4356,-400,false);
  const chunk={startTick:4352,endTick:4356,frames:[{tick:4352,players:a,bomb:{}},{tick:4356,players:b,bomb:{}}]};
  const frame=replayDisplayFrame(chunk,4354,8,[],z=>resolveMapLayer(nuke,z));
  assert.equal(frame.players[0][2],null);
  const before=replayFloorAt(null,input({tick:4352,selected:a[0]}));
  const during=replayFloorAt(before,input({tick:4354,selected:frame.players[0]}));
  assert.equal(during.status,'retained');assert.equal(during.layerId,'default');
  const meta={maxInterpolationTicks:8,players:rows(0).map((_,i)=>({id:String(i)}))};
  assert.equal(explainFrame(chunk,4354,meta,nuke,0).eligible,0,'S0 behavior remains reproducible');
  assert.equal(explainFrame(chunk,4354,meta,nuke,0,during.layerId).eligible,9,'S1 draws nine real survivors');
  assert.equal(frame.players[0][2],null,'floor selection does not mutate positions');
});

test('cross-floor interpolation stays unknown, context retains then switches on new evidence', () => {
  const a=player(0,-490),b=player(8,-510);
  const chunk={startTick:0,endTick:8,frames:[{tick:0,players:[a],bomb:{}},{tick:8,players:[b],bomb:{}}]};
  const middle=replayDisplayFrame(chunk,4,8,[],z=>resolveMapLayer(nuke,z)).players[0];
  assert.deepEqual(middle.slice(2,6),[null,null,null,null]);
  let state=replayFloorAt(null,input({selected:a}));
  state=replayFloorAt(state,input({tick:4,selected:middle}));assert.equal(state.status,'retained');
  state=replayFloorAt(state,input({tick:8,selected:b}));assert.equal(state.layerId,'lower');assert.equal(state.status,'known');
});

test('cold, warm, same-tick, backward and large forward seeks cannot inherit floor history', () => {
  assert.equal(replayFloorAt(null,input({selected:undefined})).layerId,null);
  for(const extra of [{seekRevision:1,tick:0},{seekRevision:1,tick:4},{tick:-1},{tick:100,seekRevision:1}]){
    assert.equal(replayFloorAt(seed(),input({...extra,selected:undefined})).layerId,null);
  }
  assert.equal(replayFloorAt(seed(),input({seekRevision:1,tick:100,selected:player(100,-600)})).layerId,'lower');
});

test('target, round, session, DEM, resource and manual-mode changes isolate history', () => {
  for(const extra of [{playerId:'other'},{round:2},{sessionId:'new'},{matchId:'new'},
    {map:{...nuke,resourceId:'new'}},{mode:'lower'}]){
    const state=replayFloorAt(seed(),input({...extra,selected:undefined}));
    if(extra.mode){assert.equal(state.layerId,'lower');assert.equal(state.confirmedLayer,null);}
    else assert.equal(state.layerId,null);
  }
  const manual=replayFloorAt(seed(),input({mode:'lower'}));
  assert.equal(replayFloorAt(manual,input({selected:undefined})).layerId,null);
});

test('pause, resume, speed and chunk changes preserve continuous observed floor context', () => {
  let state=seed();
  for(const tick of [0,0,1,2.5,6.5,10.5,10.5,11,21.24,45]){
    state=replayFloorAt(state,input({tick,selected:undefined}));
    assert.equal(state.layerId,'default');assert.equal(state.status,'retained');
  }
  assert.equal(replayFloorAt(state,input({round:2,tick:100,selected:undefined})).layerId,null);
});

test('dead, ambiguous, broken-segment, missing, nonfinite and boundary XYZ never confirm a layer', () => {
  const dead=player(0,-400,false),ambiguous=player(0),broken=player(0),missing=player(0),invalid=player(0);
  ambiguous[10]=true;broken[9]=null;missing[2]=null;invalid[3]=Infinity;
  for(const selected of [dead,ambiguous,broken,missing,invalid,player(0,-495),player(0,20000)]){
    assert.equal(replayFloorAt(null,input({selected})).layerId,null);
    assert.equal(replayFloorAt(seed(),input({selected,tick:1})).status,'retained');
  }
});

test('Vertigo uses its own threshold; Dust2 remains target-independent', () => {
  const map=replayMapDefinitions.find(m=>m.id==='de_vertigo');
  for(const [z,expected] of [[11701,'default'],[11699,'lower'],[11700,null],[null,null]]){
    assert.equal(replayFloorAt(null,input({map,selected:player(0,z)})).layerId,expected);
  }
  assert.equal(replayFloorAt(null,input({map:replayMapDefinitions.find(m=>m.id==='de_dust2'),selected:undefined})).layerId,'default');
});
