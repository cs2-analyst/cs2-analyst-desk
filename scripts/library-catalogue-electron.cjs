// L0-only synthetic lightweight catalogue experiment; never part of the Desktop entry points.
'use strict';
const { app } = require('electron');
const { DatabaseSync } = require('node:sqlite');
const { createHash } = require('node:crypto');
const { existsSync, readdirSync, statSync, writeFileSync } = require('node:fs');
const { dirname, join } = require('node:path');
const assert = require('node:assert/strict');
const [mode, countArg, databasePath, resultPath, profilePath] = process.argv.slice(2);
const count = Number(countArg), pageSize = 50;
assert.ok([10, 1000].includes(count));
app.setPath('userData', profilePath);
const result = { status: 'FAIL', mode, simulatedRows: count, pageSize,
  runtime: { electron: process.versions.electron, node: process.versions.node, sqlite: process.versions.sqlite,
    processType: process.type, platform: process.platform, arch: process.arch } };
app.whenReady().then(() => {
  assert.equal(process.type, 'browser', 'Actual Electron Main process required');
  assert.equal(existsSync(join(dirname(databasePath), 'matches')), false);
  assert.equal(existsSync(join(dirname(databasePath), 'payload')), false);
  const started = performance.now();
  const db = new DatabaseSync(databasePath, { readOnly: mode === 'list' });
  const opened = performance.now();
  try {
    if (mode === 'seed') {
      assert.equal(db.prepare('PRAGMA journal_mode=WAL').get().journal_mode, 'wal');
      db.exec(`PRAGMA synchronous=FULL;
        CREATE TABLE experiment_summary (match_id TEXT PRIMARY KEY, map TEXT NOT NULL, file_name TEXT NOT NULL,
          rounds INTEGER NOT NULL, score TEXT, imported_at INTEGER NOT NULL, player_summary TEXT NOT NULL) STRICT;
        CREATE INDEX experiment_import_order ON experiment_summary(imported_at DESC, match_id);
        BEGIN IMMEDIATE;`);
      const insert = db.prepare('INSERT INTO experiment_summary VALUES (?,?,?,?,?,?,?)');
      for (let i = 0; i < count; i++) insert.run(createHash('sha256').update(`synthetic-${count}-${i}`).digest('hex'),
        i % 2 === 0 ? 'de_dust2' : 'de_nuke', `synthetic-${i}.dem`, 24, JSON.stringify({ initialCT: 13, initialT: 11 }),
        1_800_000_000_000 + i, JSON.stringify({ playerId: `synthetic-player-${i % 10}`, nickname: `模拟玩家 ${i % 10}`, kills: 17, deaths: 14, assists: 5 }));
      db.exec('COMMIT; PRAGMA wal_checkpoint(TRUNCATE);');
    } else assert.equal(mode, 'list');
    db.exec('PRAGMA synchronous=FULL;');
    assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    assert.equal(db.prepare('PRAGMA synchronous').get().synchronous, 2);
    const queryStarted = performance.now();
    const rows = db.prepare(`SELECT match_id AS matchId, map, file_name AS fileName, rounds, score,
      imported_at AS importedAt, player_summary AS playerSummary FROM experiment_summary
      ORDER BY imported_at DESC, match_id LIMIT ?`).all(pageSize);
    const queried = performance.now(), json = JSON.stringify(rows), serialized = performance.now();
    assert.equal(rows.length, Math.min(count, pageSize));
    assert.equal(rows[0].importedAt, 1_800_000_000_000 + count - 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM experiment_summary').get().count, count);
    result.timing = { databaseOpenMs: opened - started, firstPageQueryMs: queried - queryStarted,
      serializeMs: serialized - queried, openThroughFirstPageMs: serialized - started };
    result.listBytes = Buffer.byteLength(json); result.returnedRows = rows.length;
    result.firstPageHash = createHash('sha256').update(json).digest('hex');
    result.journalMode = 'wal'; result.synchronous = 'FULL';
  } finally { db.close(); }
  const files = readdirSync(dirname(databasePath));
  assert.ok(files.every(file => /^library\.db(?:-wal|-shm)?$/.test(file)), 'There must be no archive/payload files available to read');
  result.databaseBytes = statSync(databasePath).size;
  result.dataDirectoryFiles = files;
  result.archiveFilesPresent = 0;
  result.status = 'PASS';
  writeFileSync(resultPath, JSON.stringify(result, null, 2) + '\n');
  app.quit();
}).catch(error => {
  result.error = { message: error.message, stack: error.stack };
  writeFileSync(resultPath, JSON.stringify(result, null, 2) + '\n');
  app.exit(1);
});
