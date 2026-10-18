import { resolveMapLayer, worldToRadar } from '../apps/desktop/shared/replay-map-geometry.ts';

/** Independent observation oracle. Does not trust the implementation's retained/unknown flag.
 * Each trace is one forward play run after an explicit seek; no seeks occur within a trace. */
export function auditFloorContinuity(frames, map) {
  let context=null,confirmed=null,previousTick=-Infinity,blankStart=null;
  let erroneousFrames=0,erroneousIntervals=0,totalMs=0,longestMs=0,layerMismatches=0,targetUnknown=0,retainedOpportunities=0;
  for(const f of frames){
    const key=JSON.stringify([f.round,f.playerId,f.mode]);
    if(key!==context||f.tick<previousTick){context=key;confirmed=null;}
    previousTick=f.tick;
    const p=f.selected;
    const reliable=p?.[7]===true&&p[9]!==null&&!p[10]&&p.slice(2,5).every(v=>v!==null&&Number.isFinite(v));
    const target=reliable?resolveMapLayer(map,p[4]):null;
    if(f.mode==='auto'&&target===null)targetUnknown++;
    if(target!==null)confirmed=target;
    const expected=f.mode==='auto'?confirmed:f.mode;
    if(expected&&f.layerId!==expected)layerMismatches++;
    const eligible=(f.players??[]).filter(row=>{
      const q=row.sample,point=q[2]===null||q[3]===null?null:worldToRadar(map,{x:q[2],y:q[3]});
      return q[7]===true&&point&&resolveMapLayer(map,q[4])===expected
        &&point.x>=0&&point.y>=0&&point.x<=map.width&&point.y<=map.height;
    }).length;
    const opportunity=f.mode==='auto'&&!target&&!!expected&&eligible>0&&f.chunkLoaded;
    if(opportunity)retainedOpportunities++;
    const erroneous=opportunity&&f.drawn===0;
    if(erroneous){erroneousFrames++;if(blankStart===null){blankStart=f.ms;erroneousIntervals++;}}
    if(blankStart!==null&&!erroneous){const duration=f.ms-blankStart;totalMs+=duration;longestMs=Math.max(longestMs,duration);blankStart=null;}
  }
  if(blankStart!==null){const duration=frames.at(-1).ms-blankStart;totalMs+=duration;longestMs=Math.max(longestMs,duration);}
  return {erroneousFrames,erroneousIntervals,totalMs,longestMs,layerMismatches,targetUnknown,retainedOpportunities,
    scope:'Independent prior reliable alive XYZ/segment history per forward run; native gaps, empty floors and cold seeks without history excluded. Wall times include observer overhead and endpoint censoring.'};
}
