// L1 production NSIS/SQLite compatibility, isolated from existing installations and user libraries.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOwnedRun, assertOwnedPath, assertNoConflicts, ProcessScope, runInstaller, windowsProcesses, windowsRegistrations, directoryState } from './installed-smoke-lifecycle.mjs';
import { assertOwnedDirectory } from './owned-qa-run.mjs';
import { waitFor } from './smoke-runtime.mjs';

const root=fileURLToPath(new URL('../',import.meta.url)),fixture=resolve(process.argv[2]??'E:/cs2-analyst/.demo/nuke.dem');
const version=JSON.parse(readFileSync(join(root,'apps/desktop/package.json'),'utf8')).version;
const installer=join(root,'release',version,`CS2-Analyst-Setup-${version}.exe`);
const run=createOwnedRun(root),installation=join(run.directory,'production-app');assertOwnedPath(run,installation);
const scope=new ProcessScope(),evidence={stage:'L1',scope:'Production NSIS SQLite foundation; not full L5 acceptance',run,events:[],installer:{path:installer},startedAt:new Date().toISOString()};
let installed=false,foundation;
const save=()=>writeFileSync(join(run.directory,'l1-installed.json'),JSON.stringify(evidence,null,2)+'\n');
const audit=event=>{evidence.events.push(event);save();};
try {
  assertNoConflicts(await windowsProcesses(),await windowsRegistrations());
  assert.ok(!existsSync(installation));assert.ok(existsSync(installer));
  evidence.installer.sha256=createHash('sha256').update(readFileSync(installer)).digest('hex');
  await runInstaller(scope,installer,['/S','/D='+installation],{label:'L1 production install',directory:installation,audit});
  installed=true;assert.ok(existsSync(join(installation,'CS2 Analyst.exe')));
  const registrations=await windowsRegistrations();assert.ok(registrations.some(item=>item.installLocation?.toLowerCase()===installation.toLowerCase()));evidence.installedRegistrations=registrations;
  const startedAt=Date.now(),child=spawn(process.execPath,[join(root,'scripts/library-foundation-acceptance.mjs'),fixture,join(installation,'CS2 Analyst.exe')],
    {cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});
  const controller=scope.track(child,'L1 installed product acceptance',startedAt);
  await waitFor(async()=>{await scope.live();if(controller.error)throw controller.error;return child.exitCode!==null;},240_000,'installed foundation smoke',{
    diagnostics:()=>({stdout:controller.stdout,stderr:controller.stderr})});
  writeFileSync(join(run.directory,'foundation-controller.log'),controller.stdout+'\nSTDERR\n'+controller.stderr);
  assert.equal(child.exitCode,0,controller.stdout+'\n'+controller.stderr);
  const summary=controller.stdout.trim().split(/\r?\n/).reverse().map(line=>{try{return JSON.parse(line);}catch{return null;}}).find(item=>item?.evidence);
  assert.equal(summary?.status,'PASS');foundation=JSON.parse(readFileSync(summary.evidence,'utf8'));assertOwnedDirectory(foundation.run);
  assert.equal(foundation.status,'PASS');evidence.foundation={path:summary.evidence,sha256:createHash('sha256').update(readFileSync(summary.evidence)).digest('hex'),checks:foundation.checks};
  await scope.cleanup();
  await runInstaller(scope,join(installation,'Uninstall CS2 Analyst.exe'),['/S','/currentuser'],{label:'L1 production uninstall',directory:installation,audit});
  installed=false;
  await waitFor(async()=>!existsSync(join(installation,'CS2 Analyst.exe'))&&(await windowsRegistrations()).length===0,30_000,'owned uninstallation completion');
  evidence.afterUninstall={installation:directoryState(installation),registrations:await windowsRegistrations()};
  const manifest=join(foundation.run.localAppData,'CS2 Analyst','MatchLibrary','matches',foundation.entry.matchId,'manifest.json');
  assert.ok(existsSync(manifest));assert.equal(createHash('sha256').update(readFileSync(manifest)).digest('hex'),foundation.manifestHash);
  evidence.afterUninstall.archivedManifestRetained=true;evidence.status='PASS';
} catch(error) {evidence.status='HOLD';evidence.error={message:error.message,stack:error.stack};process.exitCode=1;}
finally {
  try {await scope.cleanup();}catch(error){evidence.cleanupError=error.message;process.exitCode=1;}
  if(installed&&existsSync(join(installation,'Uninstall CS2 Analyst.exe'))) {
    try {await runInstaller(scope,join(installation,'Uninstall CS2 Analyst.exe'),['/S','/currentuser'],{label:'L1 failed-run owned uninstall',directory:installation,audit});}
    catch(error){evidence.uninstallError=error.message;process.exitCode=1;}
  }
  evidence.finishedAt=new Date().toISOString();save();console.log(JSON.stringify({status:evidence.status,evidence:join(run.directory,'l1-installed.json'),error:evidence.error?.message}));
}
