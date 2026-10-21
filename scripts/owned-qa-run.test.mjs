import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { assertOwnedDirectory, assertOwnedPath, createOwnedQaRun, createOwnedTempDirectory, qaLaunchOptions, removeOwnedDirectory } from './owned-qa-run.mjs';

test('separate runs isolate paths and environment; the same run explicitly preserves restart identity', () => {
  const first = createOwnedQaRun(), second = createOwnedQaRun();
  try {
    const original = { LOCALAPPDATA: 'real-user-directory', LocalAppData: 'duplicate-case', OTHER: 'kept' };
    const a = qaLaunchOptions(first, original), restart = qaLaunchOptions(first, original), b = qaLaunchOptions(second, original);
    assert.deepEqual(a, restart);
    assert.notEqual(a.env.LOCALAPPDATA, b.env.LOCALAPPDATA);
    assert.equal(a.env.LOCALAPPDATA, first.localAppData);
    assert.equal(a.env.LocalAppData, undefined);
    assert.deepEqual(a.applicationArgs, [`--user-data-dir=${first.profile}`]);
    assert.equal(a.env.OTHER, 'kept');
    assert.deepEqual(original, { LOCALAPPDATA: 'real-user-directory', LocalAppData: 'duplicate-case', OTHER: 'kept' });
    writeFileSync(join(first.localAppData, 'restart-evidence'), 'persisted');
    assert.equal(readFileSync(join(qaLaunchOptions(first).env.LOCALAPPDATA, 'restart-evidence'), 'utf8'), 'persisted');
  } finally { removeOwnedDirectory(first); removeOwnedDirectory(second); }
});

test('path traversal, sibling prefix tricks, root targets and unsafe labels are rejected', () => {
  const run = createOwnedQaRun();
  try {
    for (const path of [run.directory, dirname(run.directory), join(run.directory, '..', 'escape'), run.directory + '-sibling', tmpdir()]) {
      assert.throws(() => assertOwnedPath(run, path));
    }
    assert.throws(() => createOwnedQaRun('../escape'));
    assert.throws(() => createOwnedQaRun('bad:ads'));
    assert.equal(assertOwnedPath(run, join(run.output, 'new', 'result.json')), join(run.output, 'new', 'result.json'));
  } finally { removeOwnedDirectory(run); }
});

test('a forged root cannot clean a real user directory, and a modified QA layout cannot launch', () => {
  const run = createOwnedQaRun(), outside = createOwnedTempDirectory('user-sentinel');
  const sentinel = join(outside.directory, 'user-data');
  writeFileSync(sentinel, 'never remove');
  try {
    assert.throws(() => removeOwnedDirectory({ ...run, directory: outside.directory }));
    assert.throws(() => removeOwnedDirectory({ ...run, token: outside.token }));
    assert.throws(() => qaLaunchOptions({ ...run, localAppData: outside.directory }));
    assert.equal(readFileSync(sentinel, 'utf8'), 'never remove');
  } finally { removeOwnedDirectory(run); removeOwnedDirectory(outside); }
});

test('missing or changed owner marker blocks removal', () => {
  const run = createOwnedQaRun(), marker = join(run.directory, '.cs2-qa-owner.json');
  const saved = readFileSync(marker);
  try {
    writeFileSync(marker, JSON.stringify({ ...JSON.parse(saved), token: 'wrong' }));
    assert.throws(() => removeOwnedDirectory(run));
    assert.equal(existsSync(run.profile), true);
    unlinkSync(marker);
    assert.throws(() => removeOwnedDirectory(run));
  } finally { writeFileSync(marker, saved); removeOwnedDirectory(run); }
});

test('junction/symlink escape cannot launch, create an owned root or remove outside files', () => {
  const run = createOwnedQaRun(), outside = createOwnedTempDirectory('external-sentinel');
  const sentinel = join(outside.directory, 'user-data'), link = join(run.output, 'redirect');
  writeFileSync(sentinel, 'preserved');
  try {
    symlinkSync(outside.directory, link, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => assertOwnedPath(run, join(link, 'user-data')));
    assert.throws(() => createOwnedTempDirectory('through-link', { parent: link }));
    assert.throws(() => removeOwnedDirectory(run));
    assert.equal(readFileSync(sentinel, 'utf8'), 'preserved');
    unlinkSync(link);
    rmdirSync(run.localAppData);
    symlinkSync(outside.directory, run.localAppData, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => qaLaunchOptions(run));
    assert.throws(() => removeOwnedDirectory(run));
    unlinkSync(run.localAppData);
    mkdirSync(run.localAppData);
  } finally {
    if (existsSync(link)) unlinkSync(link);
    removeOwnedDirectory(run); removeOwnedDirectory(outside);
  }
});

test('cleanup removes only its generated root and leaves sibling evidence intact', () => {
  const parent = mkdtempSync(join(tmpdir(), 'cs2-qa-parent-test-'));
  const a = createOwnedTempDirectory('pack-production', { parent }), b = createOwnedTempDirectory('pack-production', { parent });
  try {
    assert.notEqual(a.directory, b.directory);
    assert.equal(assertOwnedDirectory(a), a.directory);
    writeFileSync(join(b.directory, 'keep'), 'other run');
    removeOwnedDirectory(a);
    assert.equal(existsSync(a.directory), false);
    assert.equal(readFileSync(join(b.directory, 'keep'), 'utf8'), 'other run');
  } finally { if (existsSync(a.directory)) removeOwnedDirectory(a); removeOwnedDirectory(b); rmdirSync(parent); }
});
