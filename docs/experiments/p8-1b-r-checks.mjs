// Windows local evidence runner; no network, fixture copying or production edits.
import {spawnSync} from 'node:child_process';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const directory='.tmp/p8-1b-r';mkdirSync(directory,{recursive:true});
const commands=[];
function run(label,command,executable,args,env={}) {
  console.log(`START ${label}`);const started=new Date().toISOString();
  const r=spawnSync(executable,args,{encoding:'utf8',env:{...process.env,...env},maxBuffer:32*1024*1024,windowsHide:true});
  const log=(r.stdout??'')+(r.stderr??'')+(r.error?String(r.error):'');
  writeFileSync(`${directory}/${label}.log`,log);
  const counts=Object.fromEntries([...log.matchAll(/^# (tests|pass|fail|skipped|cancelled) (\d+)/gm)].map(m=>[m[1],Number(m[2])]));
  const summary=log.split(/\r?\n/).filter(s=>/^# (tests|pass|fail|skipped|cancelled)|Tasks:|successful|"l1"|four prefix|Round \d+:/.test(s.trim())).map(s=>s.trim());
  commands.push({label,command,exitCode:r.status,status:r.status===0?'PASS':'FAIL',started,ended:new Date().toISOString(),
    ...counts,uniqueRuntimeTests:counts.tests??null,summary:summary.length?summary:['Exit '+r.status+'; no TAP runtime count (syntax/compiler/build check).'],
    logSha256:createHash('sha256').update(log).digest('hex'),localLog:`${directory}/${label}.log`});
  writeFileSync(`${directory}/commands.json`,JSON.stringify(commands,null,2)+'\n');
  console.log(`END ${label} exit=${r.status} ${JSON.stringify(counts)}`);
  if(r.status!==0){console.error(log.slice(-5000));process.exit(1);}
}
const pnpm=(label,args)=>run(label,`pnpm ${args.join(' ')}`,'cmd.exe',['/d','/s','/c',`pnpm ${args.join(' ')}`]);
for(const file of ['p8-1b-r-server.mjs','p8-1b-r-server.test.mjs','p8-1b-r-dust2.mjs','p8-1b-r-checks.mjs'])
  run(`syntax-${file}`,`node --check docs/experiments/${file}`,process.execPath,['--check',`docs/experiments/${file}`]);
pnpm('typecheck-force',['exec','turbo','run','typecheck','--force']);
pnpm('build-force',['exec','turbo','run','build','--force']);
pnpm('match-model-tests',['--filter','@cs2-analyst/match-model','test']);
pnpm('parser-contract-tests',['--filter','@cs2-analyst/dem-parser','exec','tsc','-p','tests/tsconfig.json']);
pnpm('deep-review-contract-tests',['--filter','@cs2-analyst/deep-review','exec','tsc','-p','tests/tsconfig.json']);
for(const [label,file] of [['l1-l2-boundary-prefix','p8-1b-r-server.test.mjs'],['historical-experiment-regression','p8-1b-prefix.test.mjs']])
  run(label,`node --test --test-reporter=tap docs/experiments/${file}`,process.execPath,['--test','--test-reporter=tap',`docs/experiments/${file}`]);
const parserFiles=['converters','native-provenance','provider','round-state','replay','spatial','replay-real'].map(n=>`packages/dem-parser/tests/${n}.test.mjs`);
run('parser-tests',`$env:DEM_TEST_FILE='.demo/dust2.dem'; $env:REPLAY_TEST_FILE='.demo/dust2.dem'; node --test --test-concurrency=1 --test-reporter=tap ${parserFiles.join(' ')}`,
  process.execPath,['--test','--test-concurrency=1','--test-reporter=tap',...parserFiles],{DEM_TEST_FILE:'.demo/dust2.dem',REPLAY_TEST_FILE:'.demo/dust2.dem'});
const deepFiles=['engagements','execution','findings','kill-impact','teamplay','utility'].map(n=>`packages/deep-review/tests/${n}.test.mjs`);
run('deep-review-tests',`node --test --test-concurrency=1 --test-reporter=tap ${deepFiles.join(' ')}`,process.execPath,
  ['--test','--test-concurrency=1','--test-reporter=tap',...deepFiles]);
run('real','node docs/experiments/p8-1b-r-dust2.mjs .tmp/p8-1b-r/real.json',process.execPath,['docs/experiments/p8-1b-r-dust2.mjs',`${directory}/real.json`]);
const real=JSON.parse(readFileSync(`${directory}/real.json`));
console.log(`Checks complete: L1=${real.l1Status}, P8.1B-R=${real.status}; exit 0 is not whole-stage PASS.`);
