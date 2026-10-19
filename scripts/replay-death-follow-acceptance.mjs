// Built Electron + local DEM evidence. CDP drives the repository's existing Electron
// acceptance path; the session has no Browser skill. No mocked chunks or state dispatch.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { closeApp, connectCdp, waitFor, withCleanup } from './smoke-runtime.mjs';
import { ProcessScope } from './installed-smoke-lifecycle.mjs';

const root=fileURLToPath(new URL('../',import.meta.url)),baseline=process.argv.includes('--baseline');
const scenario=process.argv.find(a=>a.startsWith('--scenario='))?.slice('--scenario='.length)??'nuke';
const cases={
  nuke:{file:'nuke.dem',sha256:'dea9382b9cc263fed9ee4ed7e71fa6be8c176cf888868f05b26d850af6f5cb3c'},
  suicide:{file:'ancient.dem',sha256:'ca7b6b7cefdde927d654ac101ea1bee4fd996efc9b86ac89dac33874a0115f4e',round:19,tick:150403},
  unknown:{file:'ancient.dem',sha256:'ca7b6b7cefdde927d654ac101ea1bee4fd996efc9b86ac89dac33874a0115f4e',round:7,tick:57874},
  posthumous:{file:'demo1.dem',sha256:'f3c3173eae0cd100d15c81c3b734be792f9212256a9c99703b358d3434000852',round:22,tick:121153},
};
assert.ok(cases[scenario],'--scenario must be nuke, suicide, unknown or posthumous');assert.ok(!baseline||scenario==='nuke');
const testCase=cases[scenario];
const out=resolve(root,'.tmp/p7-death-follow',baseline?'baseline':scenario==='nuke'?'fixed':scenario);mkdirSync(out,{recursive:true});
const fixture=join(root,'.demo',testCase.file),digest=createHash('sha256');
for await(const bytes of createReadStream(fixture))digest.update(bytes);
const sha256=digest.digest('hex');assert.equal(sha256,testCase.sha256);
const require=createRequire(new URL('../apps/desktop/package.json',import.meta.url));
const server=createServer();await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
const port=server.address().port;await new Promise(ok=>server.close(ok));
const prefix=join(tmpdir(),'cs2-death-follow-'),profile=mkdtempSync(prefix);
const env={...process.env,CS2_ANALYST_DEM_PATH:fixture};delete env.ELECTRON_RUN_AS_NODE;delete env.ELECTRON_RENDERER_URL;
const child=spawn(require('electron'),['.','--remote-debugging-port='+port,'--user-data-dir='+profile,
  '--disable-features=CalculateNativeWinOcclusion','--disable-backgrounding-occluded-windows'],{
  cwd:join(root,'apps/desktop'),env,windowsHide:true,stdio:['ignore','pipe','pipe'],
});
const scope=new ProcessScope();scope.track(child,'Replay death follow acceptance',Date.now());
let page,logs='';child.stdout.on('data',data=>logs+=data);child.stderr.on('data',data=>logs+=data);
const result={schema:'p7-death-follow-electron-v1',status:'COLLECTING',fixture:'.demo/'+testCase.file,sha256,baseline,scenario,
  method:'Real built Electron/CDP; read-only React refs; actual sidebar selection and base Canvas pixel readback; no mocked chunk or product state dispatch',checks:[],scenes:[],screenshots:[]};
const wait=(probe,label,timeout=30000)=>waitFor(probe,timeout,label,{intervalMs:60,diagnostics:()=>logs.slice(-3000)});
// This oracle reads native DEM events and tick rows directly. It deliberately does
// not import the production follow/floor resolver or infer suicide from null actors.
async function nativeOracle(meta){
  const native=await import('../packages/demoparser-native/index.cjs'),bytes=readFileSync(fixture);
  const events=native.parseEvents(bytes,['player_death','player_spawn','player_disconnect'],['team_num','is_alive'],['total_rounds_played','is_warmup_period']);
  const ids=new Set(meta.players.map(p=>p.id));
  const roundAt=tick=>meta.rounds.find(r=>tick>=r.startTick&&tick<=r.endTick);
  const deaths=events.filter(e=>e.event_name==='player_death'&&e.is_warmup_period!==true&&roundAt(e.tick))
    .map(e=>({round:roundAt(e.tick).round,tick:e.tick,victimId:e.user_steamid,killerId:ids.has(e.attacker_steamid)?e.attacker_steamid:null,weapon:e.weapon,raw:e}));
  const ticks=new Set(deaths.flatMap(e=>[e.tick-1,e.tick,e.tick+1]));
  for(const r of meta.rounds){for(const t of [r.startTick,r.freezeEndTick,r.endTick,...r.blocks.flatMap(b=>[b.startTick,b.endTick])])if(Number.isSafeInteger(t))ticks.add(t);}
  const rows=native.parseTicks(bytes,['X','Y','Z','health','is_alive','team_num'],[...ticks].sort((a,b)=>a-b),[...ids]);
  const byTick=new Map();for(const row of rows){const list=byTick.get(row.tick)??[];list.push(row);byTick.set(row.tick,list);}
  const lifecycle=events.filter(e=>e.event_name!=='player_death'&&e.is_warmup_period!==true&&roundAt(e.tick));
  const states=new Map();
  for(const round of meta.rounds){
    const roundDeaths=deaths.filter(e=>e.round===round.round),roundLife=lifecycle.filter(e=>e.tick>=round.startTick&&e.tick<=round.endTick);
    const atTicks=[...new Set([...byTick.keys(),...roundDeaths.map(e=>e.tick),...roundLife.map(e=>e.tick)])]
      .filter(t=>t>=round.startTick&&t<=round.endTick).sort((a,b)=>a-b);
    const knownDead=new Set(),disconnected=new Set(),status=new Map([...ids].map(id=>[id,'unknown'])),history=[];
    for(const tick of atTicks){
      const victims=new Set(roundDeaths.filter(e=>e.tick===tick).map(e=>e.victimId));
      const spawned=new Set(roundLife.filter(e=>e.tick===tick&&e.event_name==='player_spawn').map(e=>e.user_steamid??e.userid_steamid));
      const left=new Set(roundLife.filter(e=>e.tick===tick&&e.event_name==='player_disconnect').map(e=>e.user_steamid??e.userid_steamid));
      for(const id of spawned){knownDead.delete(id);disconnected.delete(id);status.set(id,'unknown');}
      for(const id of left){disconnected.add(id);if(!knownDead.has(id))status.set(id,'unknown');}
      for(const row of byTick.get(tick)??[]){
        if(row.is_alive===false){knownDead.add(row.steamid);status.set(row.steamid,'dead');}
        else if(row.is_alive===true&&!knownDead.has(row.steamid)&&!disconnected.has(row.steamid))status.set(row.steamid,'alive');
        else if(!knownDead.has(row.steamid))status.set(row.steamid,'unknown');
      }
      // Real deaths and observed false are latched until an actual spawn, so stale
      // native true rows cannot resurrect a grenade thrower or a previously dead target.
      for(const id of victims){knownDead.add(id);status.set(id,'dead');}
      for(const id of spawned)if(victims.has(id)||left.has(id)){knownDead.delete(id);status.set(id,'unknown');}
      history.push({tick,alive:[...ids].filter(id=>status.get(id)==='alive').sort(),dead:[...ids].filter(id=>status.get(id)==='dead').sort()});
    }
    states.set(round.round,history);
  }
  const stateAt=(round,tick)=>states.get(round)?.findLast(s=>s.tick<=tick);
  const aliveAt=(round,tick)=>stateAt(round,tick)?.alive??[];
  const deadBefore=e=>deaths.some(d=>d.round===e.round&&d.victimId===e.killerId&&d.tick<e.tick&&!lifecycle.some(s=>s.event_name==='player_spawn'&&(s.user_steamid??s.userid_steamid)===e.killerId&&s.tick>d.tick&&s.tick<=e.tick));
  const allDead=meta.rounds.flatMap(r=>deaths.filter(e=>e.round===r.round).filter(e=>stateAt(r.round,e.tick)?.dead.length===ids.size));
  const evidence={schema:'p7-death-follow-native-oracle-v1',sha256,nativeSha256:native.getBindingProvenance().verifiedSha256,
    method:'Native player_death attribution and parseTicks exact-state rows, same-tick victims removed atomically; no production follow/floor functions',
    deaths,lifecycle,rows,states:[...states].map(([round,history])=>({round,history})),coverage:{normal:deaths.filter(e=>e.killerId&&e.killerId!==e.victimId&&!deadBefore(e)).length,
      self:deaths.filter(e=>e.killerId===e.victimId).length,unknown:deaths.filter(e=>!e.killerId).length,
      posthumous:deaths.filter(deadBefore).length,allDead:allDead.length}};
  writeFileSync(join(out,'native-oracle.json'),JSON.stringify(evidence,null,2));
  return {deaths,lifecycle,byTick,aliveAt,evidence};
}
await withCleanup(async()=>{
 try{
  await scope.live();
  const target=await wait(async()=>{try{return(await(await fetch('http://127.0.0.1:'+port+'/json/list',{signal:AbortSignal.timeout(1000)})).json()).find(t=>t.type==='page');}catch{return null;}},'Electron CDP');
  page=await connectCdp(target.webSocketDebuggerUrl);const {evaluate}=page;
  const exceptions=[];result.console=[];
  page.socket.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.method==='Runtime.exceptionThrown')exceptions.push(m.params);if(m.method==='Runtime.consoleAPICalled'&&['error','warning'].includes(m.params.type))result.console.push(m.params);});
  await page.send('Runtime.enable');await page.send('Page.enable');
  await wait(()=>evaluate('Boolean(window.cs2Analyst&&document.querySelector("[data-sidebar-import]"))'),'React ready');
  const start=Date.now();await evaluate('document.querySelector("[data-sidebar-import]").click()');
  await wait(()=>evaluate('document.querySelector("main").dataset.status==="success"'),'real Nuke import',120000);
  result.importMs=Date.now()-start;await evaluate('document.getElementById("replay-tab").click()');
  await wait(()=>evaluate('Number(document.querySelector("#replay-panel canvas[role=img]")?.dataset.tick)>0'),'Replay canvas');
  const reportExpr='(()=>{let n=document.getElementById("replay-panel"),f=n[Object.keys(n).find(k=>k.startsWith("__reactFiber$"))];while(f&&!f.memoizedProps?.report)f=f.return;return f.memoizedProps.report;})()';
  const report=await evaluate(reportExpr),meta=report.replay;result.metadata=meta;assert.equal(meta.matchId,sha256);
  await evaluate(`window.__deathRead=()=>{let n=document.querySelector('[data-replay-session]'),f=n[Object.keys(n).find(k=>k.startsWith('__reactFiber$'))];while(f?.return)f=f.return;
    const visit=f=>!f?null:f.memoizedProps?.metadata?.sessionId&&f.memoizedProps?.initialPlayerId!==undefined?f:visit(f.child)||visit(f.sibling);f=visit(f.stateNode.current);if(!f)throw new Error('Replay fiber not found');
    const refs=[];for(let h=f.memoizedState;h;h=h.next)if(h.memoizedState&&typeof h.memoizedState==='object'&&Object.hasOwn(h.memoizedState,'current'))refs.push(h.memoizedState.current);
    const live=refs.find(r=>r?.selectedPlayerId!==undefined),cache=refs.find(r=>r?.entries instanceof Map&&typeof r.put==='function'),clock=refs.find(r=>r?.anchorMs!==undefined);
    const c=document.querySelector('#replay-panel canvas[role=img]'),b=document.querySelector('#replay-panel canvas[aria-hidden=true]'),tick=Number(c.dataset.tick),block=live.info.blocks.find(b=>Math.floor(tick)>=b.startTick&&Math.floor(tick)<=b.endTick);
    const selected=[...document.querySelectorAll('[aria-label=回放玩家状态] button')].findIndex(b=>b.getAttribute('aria-pressed')==='true');
    return {tick,round:live.info.round,playerId:live.selectedPlayerId,sidebarPlayerId:f.memoizedProps.metadata.players[selected]?.id,sidebarText:document.querySelector('[aria-label=回放玩家状态] button[aria-pressed=true]')?.textContent,
      block:block?.index,chunkLoaded:!!cache.entries.get(live.info.round+':'+block?.index),cacheKeys:[...cache.entries.keys()],playing:clock.playing,
      layerId:live.layerId,baseLayer:b.dataset.layer,imageReady:live.imageReady,floorStatus:c.dataset.floorStatus,drawn:Number(c.dataset.playerCount),
      followPlayer:c.dataset.followPlayer??null,followDeath:c.dataset.followDeath??null,followCause:c.dataset.followCause??null,allDead:c.dataset.allDead??null};};`);
  const read=()=>evaluate('window.__deathRead()');
  const choose=async(label,value)=>{await evaluate(`document.querySelector('[aria-label="${label}"]').click()`);await wait(()=>evaluate(`Boolean([...document.querySelectorAll('[role=option]')].find(o=>o.checkVisibility()&&o.textContent.trim()===${JSON.stringify(value)}))`),'option '+value);await evaluate(`[...document.querySelectorAll('[role=option]')].find(o=>o.checkVisibility()&&o.textContent.trim()===${JSON.stringify(value)}).click()`);};
  const pause=async()=>{await evaluate('document.querySelector("[aria-label=暂停回放]")?.click()');await delay(100);};
  const seek=async tick=>{await evaluate(`(()=>{const s=document.querySelector('[aria-label=回放进度]'),set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;for(const v of [${tick}===Number(s.min)?${tick}+1:${tick}-1,${tick}]){set.call(s,v);s.dispatchEvent(new Event('input',{bubbles:true}));}})()`);await wait(async()=>{const s=await read();return Math.abs(s.tick-tick)<.01&&s.chunkLoaded;},'seek '+tick);await delay(120);return read();};
  const selectPlayer=async id=>{const index=meta.players.findIndex(p=>p.id===id);assert.ok(index>=0);await evaluate(`document.querySelectorAll('[aria-label=回放玩家状态] button')[${index}].click()`);await delay(100);};
  const shot=async name=>{const state=await read();state.baseNonempty=await evaluate(`(()=>{const c=document.querySelector('#replay-panel canvas[aria-hidden=true]'),d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;return d.some((v,i)=>i%4===3&&v>0);})()`);const file=join(out,name+'.png');writeFileSync(file,Buffer.from((await page.send('Page.captureScreenshot',{format:'png'})).data,'base64'));result.screenshots.push({file,state});return state;};
  if(scenario==='nuke'){
  const round=meta.rounds.find(r=>r.round===2),karrigan=meta.players.find(p=>p.nickname.trim()==='karrigan');assert.ok(round&&karrigan);
  await choose('回放回合','R2');await choose('回放楼层','跟随玩家');
  const ticks=round.startTick+149.40625*meta.tickRate;assert.ok(Number.isInteger(ticks));
  await seek(ticks-2);await selectPlayer(karrigan.id);await shot('r2-karrigan-before');
  const before=await read();await seek(ticks);const after=await shot('r2-karrigan-death');
  result.scenes.push({label:'R2 karrigan +149.40625s',tick:ticks,before,after});
  if(baseline){assert.equal(after.playerId,karrigan.id,'Baseline must reproduce missing automatic switch');assert.equal(after.baseNonempty,false,'Baseline must reproduce disappearing base');result.status='BASELINE REPRODUCED';}
  else {
    const oracle=await nativeOracle(meta);result.nativeCoverage=oracle.evidence.coverage;
    const event=oracle.deaths.find(e=>e.round===2&&e.tick===ticks&&e.victimId===karrigan.id);assert.ok(event);
    assert.equal(event.killerId,'76561198386265483');assert.equal(event.weapon,'deagle');
    assert.equal(oracle.byTick.get(ticks).find(p=>p.steamid===karrigan.id).is_alive,false);
    assert.equal(oracle.byTick.get(ticks).find(p=>p.steamid===event.killerId).is_alive,true);
    const assertSelection=(state,expected)=>{
      assert.equal(state.playerId,expected,'effective followed identity at '+state.tick);
      assert.equal(state.sidebarPlayerId,expected,'sidebar selects effective identity');
      assert.equal(state.followPlayer,expected,'Canvas follows effective identity');
      assert.ok(oracle.aliveAt(state.round,state.tick).includes(expected),'native lifecycle confirms chosen player alive');
      assert.ok(state.layerId&&state.baseLayer===state.layerId&&state.imageReady,'actual base and player floor agree');
    };
    assertSelection(after,event.killerId);assert.equal(after.baseNonempty,true,'Death must preserve actual map image');
    result.checks.push('R2 tick18395 native death attribution, living donk selected in Canvas/sidebar, nonempty map pixels');

    // Verify every actual worker/Main/preload chunk, including whole-round follow
    // context on blocks that do not contain the death event itself.
    const baselinePath=join(root,'.tmp/p7-nuke-s0/chunks.json');
    const prior=existsSync(baselinePath)?JSON.parse(readFileSync(baselinePath,'utf8')):null;
    if(prior)assert.equal(prior.metadata.matchId,sha256,'prior fixture identity');
    const payload=c=>({frames:c.frames,events:c.events,utilities:c.utilities??[],blinds:c.blinds??[],burns:c.burns??[]});
    const fnv=text=>{let h=2166136261;for(let i=0;i<text.length;i++)h=Math.imul(h^text.charCodeAt(i),16777619);return h>>>0;};
    result.ipc=[];let totalBytes=0,followBytes=0;const contexts=new Map();
    for(const round of meta.rounds){
      let firstFollowHash;
      for(const block of round.blocks){
        const request={sessionId:meta.sessionId,round:round.round,block:block.index};
        const actual=await evaluate(`(async()=>{const r=await window.cs2Analyst.replay.getChunk(${JSON.stringify(request)});if(r.kind!=='success')throw new Error(r.message);const c=r.chunk,fnv=${fnv.toString()};return {
          follow:${block.index===0?'c.follow':'undefined'},followHash:fnv(JSON.stringify(c.follow)),followBytes:JSON.stringify(c.follow).length,
          payloadHash:fnv(JSON.stringify({frames:c.frames,events:c.events,utilities:c.utilities??[],blinds:c.blinds??[],burns:c.burns??[]})),
          bytes:new TextEncoder().encode(JSON.stringify(c)).byteLength,frames:c.frames.length};})()`);
        assert.ok(actual.bytes<=1024*1024,'chunk byte cap');totalBytes+=actual.bytes;followBytes+=actual.followBytes;
        if(block.index===0){assert.ok(actual.follow?.deaths&&actual.follow?.states&&actual.follow?.backgrounds,'whole-round context required');contexts.set(round.round,actual.follow);firstFollowHash=actual.followHash;}
        assert.equal(actual.followHash,firstFollowHash,'whole-round context identical across chunks');
        if(prior){const expected=prior.chunks.find(c=>c.round===round.round&&c.block===block.index);assert.ok(expected);assert.equal(actual.payloadHash,fnv(JSON.stringify(payload(expected))),'unchanged frame/event/effect payload '+round.round+':'+block.index);}
        result.ipc.push({round:round.round,block:block.index,...actual,follow:undefined});
      }
      const context=contexts.get(round.round),deaths=oracle.deaths.filter(e=>e.round===round.round);
      assert.equal(context.deaths.length,deaths.length,'one follow death per native death');
      for(const e of deaths){
        const found=context.deaths.find(d=>d.tick===e.tick&&d.victimId===e.victimId);assert.ok(found,'native victim event retained');
        assert.equal(found.killerId,e.killerId,'native killer ownership');
        assert.ok(!found.alivePlayerIds.includes(e.victimId),'victim excluded at death');
        for(const id of found.alivePlayerIds)assert.ok(oracle.aliveAt(e.round,e.tick).includes(id),'follow candidate independently alive');
      }
    }
    assert.ok(totalBytes<=64*1024*1024,'session byte cap');result.byteBudget={totalBytes,followBytes,maxChunkBytes:Math.max(...result.ipc.map(c=>c.bytes))};
    result.checks.push('all '+result.ipc.length+' real IPC chunks share whole-round context; all native deaths/killers and alive candidates checked; chunk/session caps');
    result.payloadRegression=prior?{status:'PASS',scope:'FNV32 comparison of exact serialized frame/event/utility/blind/burn payloads against retained same-SHA native source chunks; non-cryptographic regression fingerprint',path:baselinePath}:{status:'NOT RUN',reason:'same-fixture retained source chunks absent'};
    if(prior)result.checks.push('all real frame/event/effect payload fingerprints match retained same-fixture source');

    // Resetting the same manual anchor before each direction makes target choice a
    // property of that event/tick rather than an accumulated playback side effect.
    const seekTicks=[ticks,ticks+1,ticks+8,ticks-2,ticks,ticks+16,ticks-2,ticks,ticks,ticks-2,ticks];
    const seekStates=[];
    for(const tick of seekTicks){const state=await seek(tick);assertSelection(state,tick<ticks?karrigan.id:event.killerId);seekStates.push(state);}
    result.scenes.push({label:'repeat and reverse Seek',states:seekStates});
    result.checks.push('repeated, same-tick and reverse Seek reconstruct identical victim/killer selection');
    await seek(round.startTick);await wait(async()=>!(await read()).cacheKeys.includes('2:'+after.block),'evict death chunk');
    const coldBefore=await read(),coldAfter=await seek(ticks);assertSelection(coldAfter,event.killerId);
    result.scenes.push({label:'uncached chunk direct Seek',before:coldBefore,after:coldAfter});
    result.checks.push('direct Seek from round start into uncached death chunk reconstructs same target');

    // Follow three other real victims at their exact death ticks. Selection is
    // changed only through the actual player buttons and slider control.
    const additional=oracle.deaths.filter(e=>e.killerId&&e.killerId!==e.victimId&&e.round!==2&&oracle.aliveAt(e.round,e.tick).includes(e.killerId))
      .filter((e,i,a)=>a.findIndex(d=>d.round===e.round)===i).slice(0,3);
    for(const e of additional){
      await choose('回放回合','R'+e.round);await seek(e.tick-1);await selectPlayer(e.victimId);
      const state=await seek(e.tick);assertSelection(state,e.killerId);
      result.scenes.push({label:'normal kill exact seek',event:{round:e.round,tick:e.tick,victimId:e.victimId,killerId:e.killerId},state});
    }
    result.checks.push('ordinary deaths from '+additional.length+' additional real rounds select independently verified living killers');

    await choose('回放回合','R2');
    const targetBlock=round.blocks.find(b=>ticks>=b.startTick&&ticks<=b.endTick),crossStart=targetBlock.startTick-32;
    assert.ok(crossStart>=round.startTick);await seek(crossStart);await selectPlayer(karrigan.id);await choose('回放倍速','4×');
    await evaluate(`window.__deathFrames=[];window.__deathObserver=new MutationObserver(()=>window.__deathFrames.push(window.__deathRead()));window.__deathObserver.observe(document.querySelector('#replay-panel canvas[role=img]'),{attributes:true,attributeFilter:['data-tick']});document.querySelector('[aria-label=播放回放]').click();`);
    await wait(async()=>{const s=await read();return s.round===2&&s.tick>=ticks+32;},'cross-chunk actual playback');await pause();
    const frames=await evaluate('window.__deathObserver.disconnect();window.__deathFrames');assert.ok(frames.length>5);
    assert.ok(frames.some(f=>f.block===targetBlock.index-1)&&frames.some(f=>f.block===targetBlock.index),'actual painted samples cross block');
    for(const state of frames.filter(f=>f.chunkLoaded)){
      const expected=state.tick<ticks?karrigan.id:event.killerId;assert.equal(state.playerId,expected,'continuous actual followed target');
      assert.ok(oracle.aliveAt(state.round,state.tick).includes(state.playerId),'continuous target independently alive');
      assert.ok(state.layerId&&state.baseLayer===state.layerId&&state.imageReady,'continuous background retained');
    }
    writeFileSync(join(out,'r2-cross-chunk-frames.json'),JSON.stringify(frames,null,2));
    result.scenes.push({label:'continuous 4x cross-chunk death',frameCount:frames.length,blocks:[...new Set(frames.map(f=>f.block))],first:frames[0],last:frames.at(-1)});
    await shot('r2-karrigan-playback-after');result.checks.push('continuous 4x crosses real chunk boundary and switches at death without empty floor');

    // A natural round transition must use the original manual anchor, not treat an
    // automatic handoff as a new manual preference.
    await seek(round.endTick-16);await evaluate('document.querySelector("[aria-label=播放回放]").click()');
    const next=meta.rounds.find(r=>r.round>2);await wait(async()=>(await read()).round===next.round,'natural next round');await pause();
    const nextState=await read();assertSelection(nextState,karrigan.id);result.scenes.push({label:'natural next round',state:nextState});
    result.checks.push('natural continuous next round restores original manual anchor with living state');
    result.uncovered=[
      ...(!result.nativeCoverage.self?[{scenario:'self suicide stable random fallback',status:'NOT RUN — real DEM',reason:'No confirmed self-attributed death in this Nuke fixture; synthetic unit tests are separate evidence'}]:[]),
      ...(!result.nativeCoverage.unknown?[{scenario:'unknown killer fallback',status:'NOT RUN — real DEM',reason:'No unknown-attribution death in this Nuke fixture'}]:[]),
      ...(!result.nativeCoverage.posthumous?[{scenario:'delayed grenade/dead killer',status:'NOT RUN — real DEM',reason:'No confirmed posthumous kill in this Nuke fixture'}]:[]),
      ...(!result.nativeCoverage.allDead?[{scenario:'all players dead (C4/grenade/suicide/other)',status:'NOT RUN — real DEM',reason:'No all-dead round death group observed in this Nuke fixture'}]:[]),
    ];
    result.status='PASS (covered real scenarios)';
  }
  }else{
    const oracle=await nativeOracle(meta);result.nativeCoverage=oracle.evidence.coverage;
    const round=meta.rounds.find(r=>r.round===testCase.round);assert.ok(round&&testCase.tick>=round.startTick&&testCase.tick<=round.endTick,'real event lies inside formal Replay window');
    const event=oracle.deaths.find(e=>e.round===round.round&&e.tick===testCase.tick);assert.ok(event,'exact native death');
    const alive=oracle.aliveAt(round.round,event.tick),nativeRows=oracle.byTick.get(event.tick);assert.ok(alive.length>0,'real surviving fallback candidates');
    if(scenario==='suicide')assert.equal(event.killerId,event.victimId,'native actor identity confirms self suicide');
    else if(scenario==='posthumous'){assert.notEqual(event.killerId,event.victimId);assert.equal(event.weapon,'hegrenade');assert.equal(nativeRows.find(r=>r.steamid===event.killerId)?.is_alive,false,'real HE attacker is already dead');assert.ok(!alive.includes(event.killerId));}
    else{assert.equal(event.killerId,null,'native attacker unavailable');assert.equal(event.weapon,'planted_c4');}
    await choose('回放回合','R'+round.round);await seek(event.tick-8);await selectPlayer(event.victimId);
    const before=await shot(scenario+'-before');const at=await seek(event.tick),after=await shot(scenario+'-death');
    const fallback=at.playerId;
    const assertFallback=state=>{
      assert.equal(state.playerId,fallback,'same real event keeps stable fallback');assert.equal(state.sidebarPlayerId,fallback);assert.equal(state.followPlayer,fallback);
      assert.ok(alive.includes(fallback),'fallback independently alive');assert.notEqual(fallback,event.victimId);
      if(scenario==='posthumous')assert.notEqual(fallback,event.killerId,'dead thrower cannot be followed');
      assert.equal(state.followCause,scenario==='suicide'?'suicide':scenario==='unknown'?'unknown':'kill');
      assert.ok(state.layerId&&state.baseLayer===state.layerId&&state.imageReady,'actual radar remains ready');
    };
    assertFallback(at);assert.equal(after.baseNonempty,true);
    result.scenes.push({label:scenario+' exact native death',event:{round:event.round,tick:event.tick,roundElapsedSeconds:(event.tick-round.startTick)/meta.tickRate,victimId:event.victimId,killerId:event.killerId,weapon:event.weapon},alive,before,after});
    const repeated=[];
    for(const tick of [event.tick,Math.min(round.endTick,event.tick+1),Math.min(round.endTick,event.tick+8),event.tick-8,event.tick,event.tick-8,event.tick,event.tick]){
      const state=await seek(tick);if(tick>=event.tick)assertFallback(state);else assert.equal(state.playerId,event.victimId,'reverse seek reconstructs original manual anchor');repeated.push(state);
    }
    await seek(round.startTick);await delay(150);
    const cacheBefore=await read(),uncached=!cacheBefore.cacheKeys.includes(round.round+':'+at.block);
    const direct=await seek(event.tick);assertFallback(direct);
    result.scenes.push({label:'repeat reverse and direct edge Seek',states:repeated,cacheBefore,direct,
      coldCoverage:uncached?'PASS':'NOT RUN — automatic adjacent-block prefetch retains this event block; cold Seek separately covered by Nuke/Ancient'});
    const block=round.blocks.find(b=>event.tick>=b.startTick&&event.tick<=b.endTick),from=block.index?block.startTick-16:event.tick-64;
    await seek(from);await selectPlayer(event.victimId);await choose('回放倍速','4×');
    if(event.tick===round.endTick){
      await evaluate(`(()=>{const s=document.querySelector('[data-replay-session] input[role=switch]');if(!s)throw new Error('Continuous switch not found');if(s.checked)s.click();})()`);
      await wait(()=>evaluate('document.querySelector("[data-replay-session]").dataset.replayContinuous==="off"'),'continuous disabled at endpoint');
    }
    await evaluate(`window.__deathFrames=[];window.__deathObserver=new MutationObserver(()=>window.__deathFrames.push(window.__deathRead()));window.__deathObserver.observe(document.querySelector('#replay-panel canvas[role=img]'),{attributes:true,attributeFilter:['data-tick']});document.querySelector('[aria-label=播放回放]').click();`);
    await wait(async()=>{const state=await read();return state.round===round.round&&state.tick>=Math.min(round.endTick,event.tick+16);},'real edge playback');await pause();
    const frames=await evaluate('window.__deathObserver.disconnect();window.__deathFrames');assert.ok(frames.some(f=>f.tick<event.tick)&&frames.some(f=>f.tick>=event.tick));
    for(const state of frames.filter(f=>f.chunkLoaded)){
      if(state.tick>=event.tick){assert.equal(state.playerId,fallback);assert.ok(oracle.aliveAt(state.round,state.tick).includes(state.playerId));}
      assert.ok(state.imageReady&&state.layerId&&state.baseLayer===state.layerId,'no empty radar during real edge playback');
    }
    writeFileSync(join(out,'playback-frames.json'),JSON.stringify(frames,null,2));await shot(scenario+'-playback-after');
    const blocks=[...new Set(frames.map(f=>f.block))];if(block.index)assert.ok(blocks.length>1,'edge playback crosses real chunk boundary');
    result.scenes.push({label:'actual 4x edge playback',frames:frames.length,blocks,first:frames[0],last:frames.at(-1)});
    result.checks.push('real '+testCase.file+' '+scenario+' native identity/lifecycle verified inside formal Replay window',
      'fallback is a true living player and excludes victim/dead attacker; same event stable under repeated/reverse/same/direct Seek'+(uncached?' (uncached block)':''),
      'actual 4x playback crosses death'+(block.index?' and real chunk boundary':'')+' with consistent fallback and nonempty radar');
    result.uncovered=[{scenario:'all players dead',status:'NOT RUN — real Replay',reason:'Observed C4 all-dead sample occurs outside current formal Replay round end; not used as UI acceptance evidence'}];
    result.status='PASS (covered real scenarios)';
  }
  result.page=await evaluate('({url:location.href,title:document.title,text:document.getElementById("replay-panel").innerText,overlay:Boolean(document.querySelector("vite-error-overlay"))})');
  assert.match(result.page.url,/index\.html$/);assert.ok(result.page.title&&result.page.text.includes('比赛回放'));assert.equal(result.page.overlay,false);
  result.exceptions=exceptions;assert.deepEqual(exceptions,[]);
  const expectedWarning=m=>m.type==='warning'&&m.args.some(a=>a.value?.includes?.('Electron Security Warning (Insecure Content-Security-Policy)'));
  result.consoleHealth={knownUnpackagedElectronWarnings:result.console.filter(expectedWarning).length,unexpected:result.console.filter(m=>!expectedWarning(m))};
  assert.deepEqual(result.consoleHealth.unexpected,[],'no relevant app console errors/warnings');
  await evaluate('delete window.__deathRead');await closeApp({child,evaluate,socket:page.socket});
 }catch(error){result.status='FAIL';result.error={message:error.message,stack:error.stack};throw error;}
},[
  ()=>{writeFileSync(join(out,'electron.json'),JSON.stringify(result,null,2));writeFileSync(join(out,'electron.log'),logs);},
  ()=>page?.socket.close(),()=>scope.cleanup(),
  async()=>{assert.ok(resolve(profile).startsWith(resolve(prefix)));await rm(profile,{recursive:true,force:true,maxRetries:8,retryDelay:250});},
]);
console.log(JSON.stringify({status:result.status,out,checks:result.checks,nativeCoverage:result.nativeCoverage,
  chunks:result.ipc?.length,byteBudget:result.byteBudget,uncovered:result.uncovered}));
