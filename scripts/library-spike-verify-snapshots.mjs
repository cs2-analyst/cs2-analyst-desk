// L0 only: read every persisted component and compare with the original capture oracle.
// No DEM access, parser call, archive mutation, session restoration, UI or catalogue claim.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { performance } from 'node:perf_hooks';
import { digest, hashJson } from './library-spike-core.mjs';
const evidence = resolve(process.argv[2] ?? '.tmp/l0/evidence');
const output = resolve(process.argv[3] ?? `.tmp/l0/full-snapshot-verification-${Date.now()}.json`);
assert.ok(!existsSync(output), 'Never overwrite prior evidence');
const result = { status: 'PASS', scope: 'Read-only persisted snapshot full-file and full-Replay-chunk verification against original capture oracle; not a new DEM parse or six-view cold restore.', samples: [] };
for (const name of ['dust2', 'nuke']) {
  const start = performance.now(), base = join(evidence, name), manifest = JSON.parse(readFileSync(join(base, 'manifest.json')));
  let rawBytes = 0, compressedBytes = 0; const chunks = [];
  for (const file of manifest.files) {
    const compressed = readFileSync(join(base, file.path));
    assert.equal(compressed.length, file.gzipBytes); assert.equal(digest(compressed), file.gzipSha256);
    const raw = gunzipSync(compressed, { maxOutputLength: file.rawBytes });
    assert.equal(raw.length, file.rawBytes); assert.equal(digest(raw), file.sha256);
    rawBytes += raw.length; compressedBytes += compressed.length;
    if (file.path.startsWith('replay/')) {
      const chunk = JSON.parse(raw), oracle = manifest.chunkIndex.find(info => info.path === file.path);
      assert.ok(oracle); assert.equal(chunk.matchId, manifest.source.sha256); assert.equal(chunk.schemaVersion, 1);
      assert.equal(chunk.round, oracle.round); assert.equal(chunk.block, oracle.block); assert.equal(Object.hasOwn(chunk, 'sessionId'), false);
      assert.equal(hashJson(chunk), oracle.sha256);
      const frame = chunk.frames.find(frame => frame.tick === oracle.sample.tick); assert.ok(frame); assert.deepEqual(frame.players, oracle.sample.players);
      chunks.push({ round: oracle.round, block: oracle.block, rawBytes: raw.length, sha256: oracle.sha256, rawTickSampleEqual: true });
    } else if (file.path === 'report.json.gz') assert.equal(hashJson(JSON.parse(raw)), manifest.reportHash);
  }
  assert.equal(chunks.length, manifest.replay.count); assert.equal(rawBytes, manifest.storage.rawPayloadBytes);
  assert.equal(compressedBytes, manifest.storage.gzipPayloadBytes);
  result.samples.push({ fixture: manifest.source, filesVerified: manifest.files.length, replayChunksEqual: chunks.length,
    originalTickSamplesEqual: chunks.length, rawBytesVerified: rawBytes, compressedBytesVerified: compressedBytes,
    elapsedMs: performance.now() - start, chunks });
}
result.maxRssKiB = process.resourceUsage().maxRSS;
writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ status: result.status, evidence: output, samples: result.samples.map(({ chunks, ...sample }) => sample) }));
