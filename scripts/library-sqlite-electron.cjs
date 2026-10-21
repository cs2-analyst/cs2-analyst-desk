// Only launched by library-sqlite-probe.mjs, with a freshly owned experiment directory.
'use strict';
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');

function open(path) {
  const db = new DatabaseSync(path);
  try {
    const journal = db.prepare('PRAGMA journal_mode=WAL').get().journal_mode;
    assert.equal(journal, 'wal');
    db.exec('PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS entries (id TEXT PRIMARY KEY, state TEXT NOT NULL) STRICT;');
    assert.equal(db.prepare('PRAGMA synchronous').get().synchronous, 2);
    return db;
  } catch (error) { db.close(); throw error; }
}
function roundTrip(path) {
  let db = open(path);
  const version = db.prepare('SELECT sqlite_version() AS version').get().version;
  db.exec("BEGIN IMMEDIATE; INSERT INTO entries VALUES ('committed','ready'); COMMIT;");
  db.exec("BEGIN IMMEDIATE; INSERT INTO entries VALUES ('rolled-back','staging'); ROLLBACK;");
  assert.throws(() => db.prepare('INSERT INTO entries VALUES (?,?)').run('committed', 'duplicate'));
  db.close();
  db = open(path);
  const rows = db.prepare('SELECT id, state FROM entries ORDER BY id').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'committed');
  assert.equal(rows[0].state, 'ready');
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  db.close();
  return { status: 'PASS', sqliteVersion: version, journalMode: 'wal', synchronous: 'FULL',
    fileDatabaseCloseReopen: true, explicitRollback: true, duplicatePrimaryKeyRejected: true, committedRows: rows.length };
}

if (process.parentPort) {
  const [mode, path] = process.argv.slice(2);
  if (mode === 'roundtrip') {
    process.parentPort.postMessage({ kind: 'done', pid: process.pid, result: roundTrip(path), runtime: process.versions });
    process.exit(0);
  } else if (mode === 'crash') {
    const db = open(path);
    db.exec("BEGIN IMMEDIATE; INSERT INTO entries VALUES ('committed-before-kill','ready'); COMMIT;");
    db.exec("BEGIN IMMEDIATE; INSERT INTO entries VALUES ('uncommitted-at-kill','staging');");
    process.parentPort.postMessage({ kind: 'kill-ready', pid: process.pid,
      committed: db.prepare('SELECT count(*) AS n FROM entries').get().n - 1,
      uncommittedVisibleOnlyInWriter: true });
    // An active transaction and open DB remain until Main forcibly terminates this owned child.
    setInterval(() => {}, 1000);
  } else throw new Error('Unexpected utility probe mode');
} else {
  const { app, utilityProcess } = require('electron');
  const [owned, resultPath] = process.argv.slice(2);
  app.setPath('userData', join(owned, 'profile'));
  const result = { status: 'FAIL', runtime: { electron: process.versions.electron, node: process.versions.node,
    platform: process.platform, arch: process.arch, processType: process.type } };
  const children = new Set();
  function utility(mode, path) {
    return new Promise((resolve, reject) => {
      const child = utilityProcess.fork(__filename, [mode, path], { serviceName: 'L0 SQLite experiment', stdio: 'pipe' });
      children.add(child);
      let message, killRequested = false, utilityLogs = '';
      const timer = setTimeout(() => { child.kill(); reject(new Error('Utility SQLite probe timed out')); }, 10_000);
      child.stdout?.on('data', data => { utilityLogs = (utilityLogs + data).slice(-16_000); });
      child.stderr?.on('data', data => { utilityLogs = (utilityLogs + data).slice(-16_000); });
      child.on('message', data => {
        message = data;
        if (mode === 'crash' && data.kind === 'kill-ready') { killRequested = true; assert.equal(child.kill(), true); }
      });
      child.on('exit', exitCode => {
        clearTimeout(timer); children.delete(child);
        if (!message || (mode !== 'crash' && exitCode !== 0)) {
          reject(new Error(`Utility failed ${exitCode}: ${utilityLogs}`)); return;
        }
        resolve({ ...message, exitCode, killRequested, logs: utilityLogs });
      });
    });
  }
  app.whenReady().then(async () => {
    result.main = roundTrip(join(owned, 'main.db'));
    result.utility = await utility('roundtrip', join(owned, 'utility.db'));
    const crashPath = join(owned, 'crash.db');
    const killed = await utility('crash', crashPath);
    // On Windows Utility's exit event can precede release of its SQLite file handles.
    // Keep the first failure and a bounded recovery latency in the experiment evidence.
    const recoveryStarted = performance.now(), transientOpenErrors = [];
    let recovered;
    for (let attempt = 0; attempt < 20; attempt++) {
      try { recovered = open(crashPath); break; }
      catch (error) {
        transientOpenErrors.push({ attempt: attempt + 1, elapsedMs: performance.now() - recoveryStarted, message: error.message });
        if (attempt === 19) throw error;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    const rows = recovered.prepare('SELECT id, state FROM entries ORDER BY id').all();
    const integrity = recovered.prepare('PRAGMA integrity_check').get().integrity_check;
    assert.equal(integrity, 'ok');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, 'committed-before-kill');
    assert.equal(rows[0].state, 'ready');
    assert.equal(recovered.prepare("SELECT count(*) AS n FROM entries WHERE id='uncommitted-at-kill'").get().n, 0);
    recovered.close();
    result.crashRecovery = { status: 'PASS', utilityPid: killed.pid, killed: killed.killRequested,
      utilityExitCode: killed.exitCode, integrity, committedRows: rows.length, uncommittedRowsAbsent: true,
      databaseReopenedAfterUtilityExit: true, recoveryOpenMs: performance.now() - recoveryStarted,
      transientOpenErrors, logs: killed.logs };
    result.status = 'PASS';
    writeFileSync(resultPath, JSON.stringify(result, null, 2) + '\n');
    app.quit();
  }).catch(error => {
    result.error = { message: error.message, stack: error.stack };
    writeFileSync(resultPath, JSON.stringify(result, null, 2) + '\n');
    for (const child of children) child.kill();
    app.exit(1);
  });
}
