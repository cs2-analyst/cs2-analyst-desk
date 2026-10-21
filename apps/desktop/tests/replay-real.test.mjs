import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { Demoparser2Provider } from '@cs2-analyst/dem-parser';
import { ReplaySession,REPLAY_CACHE_BYTES,REPLAY_CHUNK_BYTES } from '../electron/replay-session.ts';
import { localDemFixture } from './local-dem-fixture.mjs';
const file=localDemFixture('dust2.dem');
test('selected Dust2: bounded cache, all chunks JSON-only, random seek and adjacent guard state match',{skip:!existsSync(file)?'Selected local DEM missing; no download':false},async()=>{
  assert.equal(statSync(file).size,557650967);
  const digest=createHash('sha256');for await(const chunk of createReadStream(file))digest.update(chunk);
  assert.equal(digest.digest('hex'),'db90fe85aab023a1d2c8a5996182e6120d98ef494f02a070b17982b235e4958c','Wrong local Dust2 bytes; no substitute');
  const parsed=await new Demoparser2Provider().parseWithReplay(file);assert.ok(parsed.replay,parsed.replayUnavailableReason??'Missing replay');
  const start=performance.now(),session=new ReplaySession(parsed.match,parsed.replay,'00000000-0000-0000-0000-000000000001');
  assert.ok(session.bytes<=REPLAY_CACHE_BYTES);let largest=0,blocks=0;
  for(const round of session.metadata.rounds){
    let prior;
    for(const block of round.blocks){
      const request={sessionId:session.metadata.sessionId,round:round.round,block:block.index};
      const current=session.get(request);assert.ok(current);assert.equal(current.matchId,parsed.match.id);assert.ok(current.frames.length>0);
      const bytes=Buffer.byteLength(JSON.stringify(current));largest=Math.max(largest,bytes);assert.ok(bytes<=REPLAY_CHUNK_BYTES);blocks++;
      assert.equal(current.frames[0].players.length,parsed.replay.players.length);
      assert.ok(current.frames[0].tick<=current.startTick&&current.frames.at(-1).tick>=current.endTick);
      if(prior)for(const frame of prior.frames.filter(f=>current.frames.some(n=>n.tick===f.tick)))assert.deepEqual(current.frames.find(f=>f.tick===frame.tick),frame);
      assert.deepEqual(session.get(request),current,'Direct seek rebuilds the same complete baseline, independent of prior requests');prior=current;
    }
  }
  console.log(JSON.stringify({cacheBytes:session.bytes,largestChunkBytes:largest,blocks,projectionAndChecksMs:performance.now()-start,peakProcessRssKiB:process.resourceUsage().maxRSS}));
  session.clear();assert.equal(session.bytes,0);
});
