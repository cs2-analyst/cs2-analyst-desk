// Windows-only reproducible validation runner. No dependencies or production mutations.
import {spawnSync} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const directory='.tmp/p8-1b';mkdirSync(directory,{recursive:true});
const commands=[];
function run(label,command,executable,args,env={}){
  console.log(`START ${label}`);
  const started=new Date().toISOString();
  const result=spawnSync(executable,args,{encoding:'utf8',env:{...process.env,...env},maxBuffer:32*1024*1024,windowsHide:true});
  const log=(result.stdout??'')+(result.stderr??'')+(result.error?String(result.error):'');
  writeFileSync(`${directory}/${label}.log`,log);
  const counts=Object.fromEntries([...log.matchAll(/^# (tests|pass|fail|skipped) (\d+)/gm)].map(m=>[m[1],Number(m[2])]));
  commands.push({label,command,exitCode:result.status,status:result.status===0?'PASS':'FAIL',started,
    ended:new Date().toISOString(),...counts,logSha256:createHash('sha256').update(log).digest('hex')});
  writeFileSync(`${directory}/commands.json`,JSON.stringify(commands,null,2)+'\n');
  console.log(`END ${label} exit=${result.status} ${JSON.stringify(counts)}`);
  if(result.status!==0){console.error(log.slice(-6000));process.exit(1);}
}
const pnpm=(label,args)=>run(label,`pnpm ${args.join(' ')}`,'cmd.exe',['/d','/s','/c',`pnpm ${args.join(' ')}`]);
for(const file of ['p8-1b-prefix.mjs','p8-1b-dust2.mjs','p8-1b-prefix.test.mjs','p8-1b-checks.mjs'])
  run(`syntax-${file}`,`node --check docs/experiments/${file}`,process.execPath,['--check',`docs/experiments/${file}`]);
pnpm('typecheck-force',['exec','turbo','run','typecheck','--force']);
pnpm('build-force',['exec','turbo','run','build','--force']);
pnpm('match-model-tests',['--filter','@cs2-analyst/match-model','test']);
pnpm('parser-contract-tests',['--filter','@cs2-analyst/dem-parser','exec','tsc','-p','tests/tsconfig.json']);
pnpm('deep-review-contract-tests',['--filter','@cs2-analyst/deep-review','exec','tsc','-p','tests/tsconfig.json']);
run('boundary','node --test --test-reporter=tap docs/experiments/p8-1b-prefix.test.mjs',process.execPath,
  ['--test','--test-reporter=tap','docs/experiments/p8-1b-prefix.test.mjs']);
const parserFiles=['converters','native-provenance','provider','round-state','replay','spatial','replay-real']
  .map(n=>`packages/dem-parser/tests/${n}.test.mjs`);
run('parser-tests',`$env:DEM_TEST_FILE='.demo/dust2.dem'; $env:REPLAY_TEST_FILE='.demo/dust2.dem'; node --test --test-concurrency=1 --test-reporter=tap ${parserFiles.join(' ')}`,
  process.execPath,['--test','--test-concurrency=1','--test-reporter=tap',...parserFiles],
  {DEM_TEST_FILE:'.demo/dust2.dem',REPLAY_TEST_FILE:'.demo/dust2.dem'});
const deepFiles=['engagements','execution','findings','kill-impact','teamplay','utility'].map(n=>`packages/deep-review/tests/${n}.test.mjs`);
run('deep-review-tests',`node --test --test-concurrency=1 --test-reporter=tap ${deepFiles.join(' ')}`,process.execPath,
  ['--test','--test-concurrency=1','--test-reporter=tap',...deepFiles]);
run('real','node docs/experiments/p8-1b-dust2.mjs .tmp/p8-1b/real.json',process.execPath,
  ['docs/experiments/p8-1b-dust2.mjs',`${directory}/real.json`]);
console.log('Harness completed. Read real.json gate status: exit 0 does NOT mean P8.1B PASS.');
