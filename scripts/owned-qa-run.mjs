import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const markerName = '.cs2-qa-owner.json';
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function absoluteLocalPath(value) {
  assert.ok(typeof value === 'string' && isAbsolute(value) && !value.includes('\0'), 'expected an absolute local path');
  const path = resolve(value);
  assert.ok(!path.startsWith('\\\\'), 'UNC and device paths are not owned QA paths');
  return path;
}

function unredirectedDirectory(path) {
  assert.equal(lstatSync(path).isSymbolicLink(), false, `refuse redirected directory: ${path}`);
  assert.equal(lstatSync(path).isDirectory(), true, `expected directory: ${path}`);
  assert.ok(samePath(realpathSync(path), path), `refuse redirected ancestor: ${path}`);
}

/** Create a fresh, marked directory; no existing directory is adopted or cleaned. */
export function createOwnedTempDirectory(label, { parent = tmpdir() } = {}) {
  assert.match(label, /^[a-z0-9][a-z0-9-]{0,47}$/, 'label must be a short filename-safe name');
  const checkedParent = absoluteLocalPath(parent);
  unredirectedDirectory(checkedParent);
  const prefix = `cs2-${label}-`;
  const directory = mkdtempSync(join(checkedParent, prefix));
  const run = { schemaVersion: 1, parent: checkedParent, directory, prefix, token: randomUUID() };
  writeFileSync(join(directory, markerName), JSON.stringify(run) + '\n', { flag: 'wx', mode: 0o600 });
  return Object.freeze(run);
}

/** Validate the exact ownership record before use, including its parent and marker. */
export function assertOwnedDirectory(run) {
  assert.ok(run && run.schemaVersion === 1 && typeof run.prefix === 'string' && /^cs2-[a-z0-9-]+-$/.test(run.prefix));
  assert.ok(typeof run.token === 'string' && uuid.test(run.token), 'invalid ownership token');
  const parent = absoluteLocalPath(run.parent), directory = absoluteLocalPath(run.directory);
  assert.ok(samePath(dirname(directory), parent) && basename(directory).startsWith(run.prefix), 'owned root must be a direct generated child');
  assert.ok(basename(directory).length > run.prefix.length, 'owned root must have a unique suffix');
  unredirectedDirectory(parent);
  unredirectedDirectory(directory);
  const marker = join(directory, markerName), info = lstatSync(marker);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.size <= 4096, 'invalid ownership marker');
  const saved = JSON.parse(readFileSync(marker, 'utf8'));
  assert.deepEqual(saved, { schemaVersion: 1, parent: run.parent, directory: run.directory, prefix: run.prefix, token: run.token }, 'ownership record mismatch');
  return directory;
}

/** Resolve a descendant only; neither the run root nor paths outside it are valid targets. */
export function assertOwnedPath(run, target) {
  const directory = assertOwnedDirectory(run), path = absoluteLocalPath(target);
  const rel = relative(directory, path);
  assert.ok(rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep), 'target must be inside the owned run');
  let current = path;
  while (!samePath(current, directory)) {
    try {
      const info = lstatSync(current);
      assert.equal(info.isSymbolicLink(), false, `refuse redirected target: ${current}`);
      assert.ok(samePath(realpathSync(current), current), `refuse redirected target ancestor: ${current}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const ancestor = dirname(current);
    assert.ok(!samePath(ancestor, current), 'owned root was not reached');
    current = ancestor;
  }
  return path;
}

/** A reusable launch identity: reuse this same record to test a genuine app restart. */
export function createOwnedQaRun(label = 'library-qa', options) {
  const owned = createOwnedTempDirectory(label, options);
  const run = { ...owned, profile: join(owned.directory, 'profile'), localAppData: join(owned.directory, 'localAppData'), output: join(owned.directory, 'output') };
  for (const path of [run.profile, run.localAppData, run.output]) {
    assertOwnedPath(owned, path);
    mkdirSync(path);
  }
  return Object.freeze(run);
}

/** Only the child environment changes. Never mutate the controller's user environment. */
export function qaLaunchOptions(run, baseEnv = process.env) {
  assertOwnedDirectory(run);
  for (const [key, name] of [['profile', 'profile'], ['localAppData', 'localAppData'], ['output', 'output']]) {
    assert.equal(run[key], join(run.directory, name), 'QA paths must use the fixed owned layout');
    unredirectedDirectory(assertOwnedPath(run, run[key]));
  }
  const env = Object.fromEntries(Object.entries(baseEnv).filter(([key]) => key.toLowerCase() !== 'localappdata'));
  env.LOCALAPPDATA = run.localAppData;
  return { env, applicationArgs: [`--user-data-dir=${run.profile}`] };
}

/** Refuse redirected descendants before recursive removal; failed runs can instead be retained. */
export function removeOwnedDirectory(run) {
  const directory = assertOwnedDirectory(run);
  const visit = path => {
    for (const item of readdirSync(path, { withFileTypes: true })) {
      const child = assertOwnedPath(run, join(path, item.name));
      if (lstatSync(child).isDirectory()) visit(child);
    }
  };
  visit(directory);
  // Recheck ownership immediately before the only recursive filesystem operation.
  assertOwnedDirectory(run);
  rmSync(directory, { recursive: true, force: false, maxRetries: 10, retryDelay: 100 });
}
