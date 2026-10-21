// Compare independently addressable chunk files on disk. OS cache is not flushed.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { gzipSync, gunzipSync, brotliCompressSync, brotliDecompressSync, constants } from 'node:zlib';
import { performance } from 'node:perf_hooks';
import { digest, quantiles } from './library-spike-core.mjs';
const evidence = resolve(process.argv[2] ?? '.tmp/l0/evidence');
const output = resolve(process.argv[3] ?? `.tmp/l0/codec-reads-${Date.now()}`);
assert.ok(!existsSync(output), 'Never overwrite previous codec evidence'); mkdirSync(output, { recursive: true });
const result = { scope: 'Fresh Node process; independent compressed files with OS cache uncontrolled/warm, not physical cold-disk p95', samples: [] };
for (const name of ['dust2', 'nuke']) {
  const input = join(evidence, name), manifest = JSON.parse(readFileSync(join(input, 'manifest.json'), 'utf8'));
  const target = join(output, name); mkdirSync(target);
  const files = manifest.files.filter(file => file.path.startsWith('replay/'));
  const timings = { 'gzip-6': [], 'brotli-4': [] }, cpu = process.cpuUsage(), encoding = {};
  for (const [codec, compress] of [['gzip-6', raw => gzipSync(raw, { level: 6 })], ['brotli-4', raw => brotliCompressSync(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } })]]) {
    let bytes = 0, encodeMs = 0, writeMs = 0;
    for (const [index, file] of files.entries()) {
      const raw = gunzipSync(readFileSync(join(input, file.path)));
      assert.equal(digest(raw), file.sha256);
      const start = performance.now(), encoded = compress(raw), encodedAt = performance.now();
      writeFileSync(join(target, `${codec}-${index}`), encoded); const writtenAt = performance.now();
      bytes += encoded.length; encodeMs += encodedAt - start; writeMs += writtenAt - encodedAt;
    }
    encoding[codec] = { chunkFiles: files.length, bytes, encodeMs, filesystemWriteMs: writeMs };
  }
  let seed = 0x51a7b9;
  for (let i = 0; i < 128; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const index = seed % files.length, file = files[index];
    for (const [codec, decompress] of [['gzip-6', gunzipSync], ['brotli-4', brotliDecompressSync]]) {
      const start = performance.now(), encoded = readFileSync(join(target, `${codec}-${index}`)), raw = decompress(encoded, { maxOutputLength: file.rawBytes });
      assert.equal(digest(raw), file.sha256); JSON.parse(raw.toString());
      timings[codec].push(performance.now() - start);
    }
  }
  result.samples.push({ fixture: manifest.source, encodings: encoding, independentFileRandomRead: Object.fromEntries(Object.entries(timings).map(([k, v]) => [k, quantiles(v)])), cpuMicroseconds: process.cpuUsage(cpu), maxRssKiB: process.resourceUsage().maxRSS });
}
result.status = 'PASS'; writeFileSync(join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n'); console.log(JSON.stringify({ status: result.status, output, samples: result.samples }));
