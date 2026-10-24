import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { assertOwnedDirectory, createOwnedTempDirectory } from '../../../scripts/owned-qa-run.mjs';
import { writeLibraryArchive, verifyLibraryArchive } from '../electron/library-archive.ts';
import { extractPortableArchive, isPortablePath, PORTABLE_LIMITS, PORTABLE_MAGIC,
  validatePortableHeader, verifyPortableArchive, writePortableArchive } from '../electron/library-portable.ts';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const versions = { application: '0.1.0', archive: 1, report: 2, replay: 1, analysis: 'test-analysis', parser: 'test-parser',
  native: 'test-native', sampling: 'test-sampling', mapResource: 'test-map', sourceRevision: '1'.repeat(40) };
function input(id = 'a'.repeat(64)) {
  return { match: { id, map: 'de_dust2', players: [{ steamId: '1' }], rounds: [] }, replay: null, spatial: null, chunks: new Map(), versions,
    report: { schemaVersion: 2, match: { id, fileName: 'dust2.dem', map: 'de_dust2', rounds: 0, score: null }, selectedPlayer: '1',
      players: [{ id: '1', nickname: 'Tester' }], analytics: [], findings: [], timeline: [],
      analysis: { players: [], perPlayer: [] }, deepReview: { available: false, players: [] } } };
}
async function owned(t) {
  const run = createOwnedTempDirectory('library-portable-test');
  t.after(async () => { assertOwnedDirectory(run); await rm(run.directory, { recursive: true, force: true }); });
  const archive = join(run.directory, 'archive');
  await mkdir(archive);
  await writeLibraryArchive(archive, input());
  return { run, root: run.directory, archive, packagePath: join(run.directory, 'match.cs2a') };
}
function assemble(header, payload, pretty = false) {
  const headerBytes = Buffer.from(pretty ? JSON.stringify(header, null, 2) : JSON.stringify(header), 'utf8');
  const prefix = Buffer.alloc(12);
  PORTABLE_MAGIC.copy(prefix, 0);
  prefix.writeUInt32BE(headerBytes.length, 8);
  return Buffer.concat([prefix, headerBytes, payload]);
}
function split(bytes) {
  assert.ok(bytes.subarray(0, 8).equals(PORTABLE_MAGIC));
  const length = bytes.readUInt32BE(8);
  return { header: JSON.parse(bytes.subarray(12, 12 + length).toString('utf8')), payload: bytes.subarray(12 + length) };
}
function parts(header, payload) {
  const map = new Map();
  let offset = 0;
  for (const file of header.files) { map.set(file.path, payload.subarray(offset, offset + file.bytes)); offset += file.bytes; }
  return map;
}
const joinParts = (header, map) => Buffer.concat(header.files.map(file => map.get(file.path)));
async function staging(root, name = 'stage') {
  const directory = join(root, name);
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory);
  return directory;
}

test('portable v1 round-trips an L1 archive with an exact canonical inventory', async t => {
  const { root, archive, packagePath } = await owned(t);
  const receipt = await writePortableArchive(archive, packagePath);
  assert.equal(PORTABLE_MAGIC.length, 8);
  assert.equal(PORTABLE_MAGIC.toString('latin1'), 'CS2A\r\n\x1a\n');
  assert.deepEqual(receipt.header.files.map(file => file.path), ['manifest.json', 'report.json.gz',
    'heatmap/match.json.gz', 'heatmap/replay.json.gz', 'heatmap/spatial.json.gz']);
  assert.equal(receipt.header.matchId, 'a'.repeat(64));
  assert.equal(receipt.header.archiveSchemaVersion, 1);
  const bytes = await readFile(packagePath);
  assert.equal(receipt.bytes, bytes.length);
  const { header, payload } = split(bytes);
  assert.deepEqual(header, receipt.header);
  assert.ok(Buffer.from(JSON.stringify(header)).equals(bytes.subarray(12, 12 + bytes.readUInt32BE(8))));
  const map = parts(header, payload);
  assert.deepEqual(map.get('manifest.json'), await readFile(join(archive, 'manifest.json')));
  for (const file of header.files) assert.equal(file.bytes, map.get(file.path).length);
  const verified = await verifyPortableArchive(packagePath);
  assert.deepEqual(verified.header, receipt.header);
  assert.deepEqual(verified.manifest, (await verifyLibraryArchive(archive)).manifest);
  const extracted = await staging(root);
  const extractedReceipt = await extractPortableArchive(packagePath, extracted);
  assert.deepEqual(extractedReceipt.header, receipt.header);
  assert.equal((await verifyLibraryArchive(extracted)).manifestHash, (await verifyLibraryArchive(archive)).manifestHash);
  for (const file of header.files) assert.deepEqual(await readFile(join(extracted, ...file.path.split('/'))), map.get(file.path));
});

test('magic, truncated header and payload, trailing bytes and non-canonical headers are rejected', async t => {
  const { root, archive, packagePath } = await owned(t);
  await writePortableArchive(archive, packagePath);
  const original = await readFile(packagePath);
  const write = async (name, bytes) => { const path = join(root, name); await writeFile(path, bytes); return path; };
  const badMagic = Buffer.from(original); badMagic[0] ^= 1;
  await assert.rejects(verifyPortableArchive(await write('magic.cs2a', badMagic)), /magic/);
  const shortHeader = Buffer.from(original); shortHeader.writeUInt32BE(4096, 8);
  await assert.rejects(verifyPortableArchive(await write('short-header.cs2a', shortHeader)), /truncated header/);
  const hugeHeader = Buffer.from(original); hugeHeader.writeUInt32BE(PORTABLE_LIMITS.headerBytes + 1, 8);
  await assert.rejects(verifyPortableArchive(await write('huge-header.cs2a', hugeHeader)), /header too large/);
  await assert.rejects(verifyPortableArchive(await write('truncated.cs2a', original.subarray(0, original.length - 1))), /truncated payload/);
  await assert.rejects(verifyPortableArchive(await write('trailing.cs2a', Buffer.concat([original, Buffer.from([0])]))), /trailing bytes/);
  const { header, payload } = split(original);
  await assert.rejects(verifyPortableArchive(await write('pretty.cs2a', assemble(header, payload, true))), /canonical header/);
  const expanded = structuredClone(header); expanded.extra = true;
  await assert.rejects(verifyPortableArchive(await write('unknown-key.cs2a', assemble(expanded, payload))), /header contract/);
  const fileKey = structuredClone(header); fileKey.files[0].url = 'https://example.invalid';
  await assert.rejects(verifyPortableArchive(await write('file-key.cs2a', assemble(fileKey, payload))), /header contract/);
});

test('path traversal, absolute paths, duplicates, missing inventory and extra paths are rejected', async t => {
  const { root, archive, packagePath } = await owned(t);
  await writePortableArchive(archive, packagePath);
  const { header, payload } = split(await readFile(packagePath));
  const write = async (name, value) => { const path = join(root, name); await writeFile(path, assemble(value, payload)); return path; };
  for (const [name, mutate] of [
    ['traversal', value => { value.files[1].path = '../report.json.gz'; }],
    ['nested-traversal', value => { value.files[1].path = 'heatmap/../report.json.gz'; }],
    ['absolute', value => { value.files[1].path = 'C:/report.json.gz'; }],
    ['backslash', value => { value.files[1].path = 'heatmap\\match.json.gz'; }],
    ['unc', value => { value.files[1].path = '\\\\server\\share\\report.json.gz'; }],
    ['duplicate', value => { value.files[2].path = 'report.json.gz'; }],
    ['unknown-path', value => { value.files.push({ path: 'script.sql', bytes: 1, sha256: 'a'.repeat(64) }); }],
    ['missing-heatmap', value => { value.files = value.files.filter(file => file.path !== 'heatmap/spatial.json.gz'); }],
  ]) {
    const copy = structuredClone(header);
    mutate(copy);
    await assert.rejects(verifyPortableArchive(await write(name + '.cs2a', copy)), /header contract|header/ , name);
  }
  for (const path of ['../report.json.gz', 'replay/r1-b0.json.gz/', 'replay/r0-b0.json.gz', 'replay/r1-b4096.json.gz',
    '/report.json.gz', 'report.json.gz ', 'replay/r01-b0.json.gz']) assert.equal(isPortablePath(path), false, path);
  for (const path of ['manifest.json', 'report.json.gz', 'heatmap/match.json.gz', 'heatmap/replay.json.gz',
    'heatmap/spatial.json.gz', 'replay/r1-b0.json.gz', 'replay/r1024-b4095.json.gz']) assert.equal(isPortablePath(path), true, path);
});

test('per-file limits, total payload budget and file count are bounded before allocation', async t => {
  const { root, archive, packagePath } = await owned(t);
  await writePortableArchive(archive, packagePath);
  const { header, payload } = split(await readFile(packagePath));
  const write = async (name, value) => { const path = join(root, name); await writeFile(path, assemble(value, payload)); return path; };
  const perFile = structuredClone(header); perFile.files[0].bytes = PORTABLE_LIMITS.fileBytes + 1;
  await assert.rejects(verifyPortableArchive(await write('per-file.cs2a', perFile)), /header contract/);
  const total = structuredClone(header); total.files[1].bytes = 200 * 1024 * 1024; total.files[2].bytes = 200 * 1024 * 1024;
  await assert.rejects(verifyPortableArchive(await write('total.cs2a', total)), /header contract/);
  const many = structuredClone(header);
  for (let block = 0; block < 4093; block++) many.files.push({ path: `replay/r1-b${block}.json.gz`, bytes: 1, sha256: 'b'.repeat(64) });
  assert.equal(many.files.length, 4098);
  await assert.rejects(verifyPortableArchive(await write('many.cs2a', many)), /header contract/);
  const boundary = structuredClone(header);
  for (let block = 0; block < 4092; block++) boundary.files.push({ path: `replay/r1-b${block}.json.gz`, bytes: 1, sha256: 'b'.repeat(64) });
  assert.equal(boundary.files.length, 4097);
  assert.equal(validatePortableHeader(boundary), true);
  assert.equal(validatePortableHeader(header), true);
});

test('payload digest mismatch and inner manifest tamper are rejected by the codec', async t => {
  const { root, archive, packagePath } = await owned(t);
  await writePortableArchive(archive, packagePath);
  const original = await readFile(packagePath);
  const write = async (name, bytes) => { const path = join(root, name); await writeFile(path, bytes); return path; };
  const flipped = Buffer.from(original); flipped[flipped.length - 1] ^= 1;
  await assert.rejects(verifyPortableArchive(await write('flip.cs2a', flipped)), /payload digest mismatch/);
  const { header, payload } = split(original);
  const map = parts(header, payload);
  const fixManifest = (document) => {
    const bytes = Buffer.from(JSON.stringify(document));
    map.set('manifest.json', bytes);
    const entry = header.files.find(file => file.path === 'manifest.json');
    entry.bytes = bytes.length;
    entry.sha256 = digest(bytes);
  };
  const identity = JSON.parse(map.get('manifest.json').toString('utf8'));
  identity.matchId = 'b'.repeat(64);
  fixManifest(identity);
  const identityPath = await write('identity.cs2a', assemble(header, joinParts(header, map)));
  await assert.rejects(verifyPortableArchive(identityPath), /inner manifest identity/);

  const restored = JSON.parse(JSON.stringify(JSON.parse((await readFile(join(archive, 'manifest.json'))).toString('utf8'))));
  const inv = structuredClone(restored); inv.files[0].gzipSha256 = 'c'.repeat(64);
  const map2 = parts(header, payload);
  const bytes2 = Buffer.from(JSON.stringify(inv));
  map2.set('manifest.json', bytes2);
  header.files.find(file => file.path === 'manifest.json').sha256 = digest(bytes2);
  header.files.find(file => file.path === 'manifest.json').bytes = bytes2.length;
  await assert.rejects(verifyPortableArchive(await write('inventory.cs2a', assemble(header, joinParts(header, map2)))), /inner manifest inventory mismatch/);
});

test('a summary-only inner manifest tamper is caught before the staged archive is committed', async t => {
  const { root, archive, packagePath } = await owned(t);
  await writePortableArchive(archive, packagePath);
  const { header, payload } = split(await readFile(packagePath));
  const map = parts(header, payload);
  const manifest = JSON.parse(map.get('manifest.json').toString('utf8'));
  manifest.summary.map = 'de_nuke';
  const bytes = Buffer.from(JSON.stringify(manifest));
  map.set('manifest.json', bytes);
  const entry = header.files.find(file => file.path === 'manifest.json');
  entry.bytes = bytes.length; entry.sha256 = digest(bytes);
  const tampered = join(root, 'tampered.cs2a');
  await writeFile(tampered, assemble(header, joinParts(header, map)));
  const extracted = await staging(root);
  await extractPortableArchive(tampered, extracted);
  await assert.rejects(verifyLibraryArchive(extracted), /identity/);
});

test('unsupported outer and inner schema versions fail with a distinguishable code', async t => {
  const { root, archive, packagePath } = await owned(t);
  await writePortableArchive(archive, packagePath);
  const { header, payload } = split(await readFile(packagePath));
  const write = async (name, value) => { const path = join(root, name); await writeFile(path, assemble(value, payload)); return path; };
  const outer = structuredClone(header); outer.schemaVersion = 2;
  await assert.rejects(verifyPortableArchive(await write('outer.cs2a', outer)), { code: 'ARCHIVE_UNSUPPORTED' });
  const nested = structuredClone(header); nested.archiveSchemaVersion = 3;
  await assert.rejects(verifyPortableArchive(await write('nested.cs2a', nested)), { code: 'ARCHIVE_UNSUPPORTED' });
  const map = parts(header, payload);
  const manifest = JSON.parse(map.get('manifest.json').toString('utf8'));
  manifest.versions.report = 3;
  const bytes = Buffer.from(JSON.stringify(manifest));
  map.set('manifest.json', bytes);
  const entry = header.files.find(file => file.path === 'manifest.json');
  entry.bytes = bytes.length; entry.sha256 = digest(bytes);
  const innerPath = join(root, 'inner.cs2a');
  await writeFile(innerPath, assemble(header, joinParts(header, map)));
  await assert.rejects(verifyPortableArchive(innerPath), { code: 'ARCHIVE_UNSUPPORTED' });
});

test('extraction requires an empty owned staging directory and never escapes it', async t => {
  const { root, archive, packagePath } = await owned(t);
  await writePortableArchive(archive, packagePath);
  const nonEmpty = await staging(root, 'nonempty');
  await writeFile(join(nonEmpty, 'keep'), 'x');
  await assert.rejects(extractPortableArchive(packagePath, nonEmpty), /staging directory must be empty/);
  assert.equal(await readFile(join(nonEmpty, 'keep'), 'utf8'), 'x');
  const plain = await staging(root, 'plain');
  const extracted = await extractPortableArchive(packagePath, plain);
  assert.equal(extracted.files, 5);
  assert.ok((await stat(join(plain, 'heatmap', 'spatial.json.gz'))).isFile());
});

test('writer rejects unhealthy sources, destinations inside the archive and cancellation without a success file', async t => {
  const { root, archive, packagePath } = await owned(t);
  const insideTarget = join(archive, 'export.cs2a');
  await assert.rejects(writePortableArchive(archive, insideTarget), /outside the match archive/);
  await assert.rejects(stat(insideTarget), { code: 'ENOENT' });
  const controller = new AbortController(); controller.abort();
  const cancelled = join(root, 'cancelled.cs2a');
  await assert.rejects(writePortableArchive(archive, cancelled, { signal: controller.signal }), { name: 'AbortError' });
  await assert.rejects(stat(cancelled), { code: 'ENOENT' });
  const corrupt = join(root, 'corrupt');
  await mkdir(corrupt);
  await writeLibraryArchive(corrupt, input());
  const compressed = await readFile(join(corrupt, 'report.json.gz'));
  compressed[compressed.length - 1] ^= 1;
  await writeFile(join(corrupt, 'report.json.gz'), compressed);
  const rejected = join(root, 'rejected.cs2a');
  await assert.rejects(writePortableArchive(corrupt, rejected), /digest/);
  await assert.rejects(stat(rejected), { code: 'ENOENT' });
  assert.equal(packagePath.endsWith('.cs2a'), true);
});
