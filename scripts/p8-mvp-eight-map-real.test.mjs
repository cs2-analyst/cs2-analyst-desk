import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const manifest = JSON.parse(readFileSync(new URL('../docs/p8-mvp-eight-map-fixtures.json', import.meta.url), 'utf8'));
const child = fileURLToPath(new URL('./p8-mvp-map-child.mjs', import.meta.url));
const expectedFormations = { de_ancient: 5, de_anubis: 2, de_dust2: 4, de_inferno: 1,
  de_mirage: 3, de_nuke: 4, de_overpass: 2, de_train: 4 };
assert.equal(manifest.records.length, 8);
for (const record of manifest.records) test(`real ${record.map} DEM yields an exact server spatial fact`, t => {
  const result = spawnSync(process.execPath, [child, record.file],
    { encoding: 'utf8', timeout: 180000, maxBuffer: 1024 * 1024 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  const observed = JSON.parse(result.stdout);
  assert.equal(observed.file, record.file);
  assert.equal(observed.map, record.map);
  assert.ok(observed.coverage.eventCards >= 1);
  assert.equal(observed.coverage.formationCards, expectedFormations[record.map]);
  assert.ok(observed.coverage.inspectedTicks > 0);
  t.diagnostic(JSON.stringify(observed));
});
