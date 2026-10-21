// L1 real product import/persistence smoke. The original DEM remains local and is never copied.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOwnedQaRun, qaLaunchOptions } from './owned-qa-run.mjs';
import { connectCdp, waitFor, dropDiskFile } from './smoke-runtime.mjs';
import { ProcessScope } from './installed-smoke-lifecycle.mjs';
import { readArchiveManifest, verifyLibraryArchive } from '../apps/desktop/electron/library-archive.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const fixture = resolve(process.argv[2] ?? 'E:/cs2-analyst/.demo/dust2.dem');
const installed = process.argv[3] ? resolve(process.argv[3]) : null;
assert.match(fixture.replaceAll('\\', '/'), /\/(?:dust2|nuke|inferno|mirage|ancient|anubis|overpass|demo|demo1|demo2)\.dem$/);
const run = createOwnedQaRun('l1-foundation', { parent: realpathSync(tmpdir()) });
const result = { schemaVersion: 1, stage: 'L1', startedAt: new Date().toISOString(), installed, run, fixture: { fileName: fixture.split(/[\\/]/).at(-1) }, checks: [] };
const digest = value => createHash('sha256').update(value).digest('hex');
const withoutSession = value => JSON.parse(JSON.stringify(value, (key, item) => key === 'sessionId' ? undefined : item));
const scope = new ProcessScope();let app;
const checkpoint = phase => { result.phase=phase;writeFileSync(join(run.output,'foundation.json'),JSON.stringify(result,null,2)+'\n');console.log(`L1 ${phase}`); };
async function launch() {
  const server = createServer();await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const port=server.address().port;await new Promise(resolveClose => server.close(resolveClose));
  const options=qaLaunchOptions(run),env={...options.env,...(installed?{}:{CS2_ANALYST_DEM_PATH:fixture})};
  delete env.ELECTRON_RUN_AS_NODE;delete env.ELECTRON_RENDERER_URL;delete env.CS2_ANALYST_TEST_DEM_PATH;
  const startedAt=Date.now();
  const child=spawn(installed??require('electron'),[...(installed?[]:['.']),...options.applicationArgs,`--remote-debugging-port=${port}`,'--disable-backgrounding-occluded-windows'],
    {cwd:installed?dirname(installed):join(root,'apps/desktop'),env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  const tracked=scope.track(child,'L1 product Electron',startedAt);await scope.live();
  const target=await waitFor(async()=>{if(child.exitCode!==null)throw new Error(tracked.stderr);try{return (await(await fetch(`http://127.0.0.1:${port}/json/list`,{signal:AbortSignal.timeout(1000)})).json()).find(item=>item.type==='page');}catch{return null;}},30_000,'L1 CDP');
  const page=await connectCdp(target.webSocketDebuggerUrl,90_000);scope.sessions.add(page.socket);
  await waitFor(()=>page.evaluate('Boolean(window.cs2Analyst?.library && document.querySelector("[data-sidebar-import]"))'),30_000,'product preload');
  return {child,page,tracked};
}
async function close(current) {
  try { await current.page.evaluate('void window.cs2Analyst.window.close()'); } catch { /* Closing can disconnect CDP before returning. */ }
  await waitFor(()=>current.child.exitCode!==null,15_000,'product close',{diagnostics:()=>({stderr:current.tracked.stderr})});
  current.page.socket.close();scope.sessions.delete(current.page.socket);
}
const reportExpression = `(() => {const node=document.getElementById('heatmap-panel');let f=node[Object.keys(node).find(k=>k.startsWith('__reactFiber$'))];while(f&&!f.memoizedProps?.report)f=f.return;return f.memoizedProps.report;})()`;
async function prepareDiskFile(page) {
  await page.evaluate(`(() => {const input=document.createElement('input');input.type='file';input.id='qa-l1-source';input.hidden=true;document.body.append(input);})()`);
  const {root}=await page.send('DOM.getDocument');const {nodeId}=await page.send('DOM.querySelector',{nodeId:root.nodeId,selector:'#qa-l1-source'});
  await page.send('DOM.setFileInputFiles',{nodeId,files:[fixture]});
  await page.evaluate('globalThis.__l1DiskFile=document.getElementById("qa-l1-source").files[0];document.getElementById("qa-l1-source").remove()');
}
try {
  checkpoint('fixture-hash');
  const hash=createHash('sha256');for await(const bytes of createReadStream(fixture))hash.update(bytes);result.fixture.sha256=hash.digest('hex');
  checkpoint('launch');app=await launch();assert.equal((await app.page.evaluate('window.cs2Analyst.library.list()')).total,0);
  const importStart=performance.now();
  if(installed)await dropDiskFile(app.page,fixture);else await app.page.evaluate('document.querySelector("[data-sidebar-import]").click()');
  await waitFor(()=>app.page.evaluate('document.querySelector("main")?.dataset.status === "success"'),90_000,'real DEM persistence',{
    diagnostics:()=>app.page.evaluate('({status:document.querySelector("main")?.dataset.status,text:document.body.innerText.slice(-1500)})')});
  const report=await app.page.evaluate(reportExpression);assert.equal(report.match.id,result.fixture.sha256);
  result.importAndPersistMs=performance.now()-importStart;result.reportHash=digest(JSON.stringify(withoutSession(report)));
  const catalogue=await app.page.evaluate('window.cs2Analyst.library.list()');assert.equal(catalogue.kind,'success');assert.equal(catalogue.total,1);assert.equal(catalogue.entries[0].state,'ready');
  result.entry=catalogue.entries[0];result.storage=await app.page.evaluate('window.cs2Analyst.library.storage()');
  const directory=join(run.localAppData,'CS2 Analyst','MatchLibrary','matches',report.match.id);
  assert.ok(existsSync(join(directory,'manifest.json')));const manifest=await readArchiveManifest(directory);
  result.manifestHash=digest(readFileSync(join(directory,'manifest.json')));result.archiveBytes=manifest.files.reduce((sum,file)=>sum+file.gzipBytes,0);
  result.checks.push('actual DEM import returns success only after a ready SQLite entry and complete disk archive exist');
  checkpoint('new-import-persisted');
  const oldSession=report.replay.sessionId,round=report.replay.rounds[0],block=round.blocks[0].index;
  if(installed)await prepareDiskFile(app.page);
  const importCall=installed?'window.cs2Analyst.importDroppedFile(globalThis.__l1DiskFile)':'window.cs2Analyst.importDemo()';
  await app.page.evaluate(`globalThis.__l1CancelledResult=null;void ${importCall}.then(result=>globalThis.__l1CancelledResult=result)`);
  await app.page.evaluate('window.cs2Analyst.cancelImport()');
  const cancelled=await waitFor(()=>app.page.evaluate('globalThis.__l1CancelledResult'),30_000,'cancel candidate');assert.equal(cancelled.kind,'cancelled');
  const oldChunk=await app.page.evaluate(`window.cs2Analyst.replay.getChunk(${JSON.stringify({sessionId:oldSession,round:round.round,block})})`);assert.equal(oldChunk.kind,'success');
  assert.equal((await app.page.evaluate('window.cs2Analyst.library.list()')).total,1);result.checks.push('candidate cancellation preserves ready entry and previous live Replay session');
  checkpoint('cancel-preserved');
  let duplicate;
  if(installed) {
    await app.page.evaluate(`globalThis.__l1DuplicateResult=null;void ${importCall}.then(result=>globalThis.__l1DuplicateResult=result)`);
    const returned=await waitFor(()=>app.page.evaluate('globalThis.__l1DuplicateResult'),90_000,'installed duplicate restores saved snapshot');
    assert.equal(returned.kind,'success');duplicate=returned.report;
  } else {
    await app.page.evaluate('document.querySelector("[data-sidebar-import]").click()');
    await waitFor(()=>app.page.evaluate(`document.querySelector('main')?.dataset.status==='success' && (${reportExpression}).replay.sessionId!==${JSON.stringify(oldSession)}`),90_000,'duplicate restores saved snapshot',{
      diagnostics:()=>app.page.evaluate('({status:document.querySelector("main")?.dataset.status,text:document.body.innerText.slice(-1500)})')});
    duplicate=await app.page.evaluate(reportExpression);
  }
  assert.equal(digest(JSON.stringify(withoutSession(duplicate))),result.reportHash);
  assert.equal(digest(readFileSync(join(directory,'manifest.json'))),result.manifestHash);assert.equal((await app.page.evaluate('window.cs2Analyst.library.list()')).total,1);
  result.checks.push('same SHA duplicate preserves archived report fingerprint and original manifest bytes');
  checkpoint('duplicate-preserved');
  await close(app);app=null;
  checkpoint('full-archive-verification');const verified=await verifyLibraryArchive(directory);assert.equal(verified.manifestHash,result.manifestHash);result.verifiedBytes=verified.storedBytes;
  app=await launch();const restartStart=performance.now();const restarted=await app.page.evaluate('window.cs2Analyst.library.list()');
  result.coldCatalogueMs=performance.now()-restartStart;assert.equal(restarted.total,1);assert.equal(restarted.entries[0].matchId,report.match.id);assert.equal(restarted.entries[0].state,'ready');
  result.checks.push('new Electron process reopens the persisted SQLite catalogue without importing or decoding historical matches');
  assert.equal(await app.page.evaluate('typeof window.require'),'undefined');
  const catalogueJson=JSON.stringify(restarted);assert.ok(!/(?:[A-Za-z]:[\\/]|MatchLibrary|staging[\\/]|matches[\\/])/i.test(catalogueJson),'library DTO must not expose archive paths');
  result.checks.push('Renderer remains sandboxed; library DTO contains no archive paths');
  await close(app);app=null;result.status='PASS';checkpoint('restart-passed');
} catch(error) { result.status='FAIL';result.error={message:error.message,stack:error.stack,appLogs:app?.tracked.stderr};process.exitCode=1; }
finally {
  if(app)try{await close(app);}catch(error){result.cleanupError=error.message;}
  try { await scope.cleanup(); } catch(error) {result.cleanupError=error.message;result.status='FAIL';process.exitCode=1;}result.finishedAt=new Date().toISOString();
  writeFileSync(join(run.output,'foundation.json'),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify({status:result.status,evidence:join(run.output,'foundation.json'),error:result.error?.message}));
}
