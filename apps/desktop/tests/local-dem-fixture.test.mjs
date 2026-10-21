import assert from 'node:assert/strict';
import test from 'node:test';
import { localDemFixture, allowedDemFile } from './local-dem-fixture.mjs';
test('test-only fixture root selects existing local locations by strict current-stage filenames', () => {
  const previous=process.env.CS2_ANALYST_FIXTURE_ROOT;
  try {
    process.env.CS2_ANALYST_FIXTURE_ROOT='E:/cs2-analyst/.demo';
    assert.match(localDemFixture('dust2.dem'), /cs2-analyst[\\/]\.demo[\\/]dust2\.dem$/);
    for(const name of ['demo3.dem','train.dem','match-final.dem','../dust2.dem','dust2.txt'])assert.throws(()=>localDemFixture(name));
    assert.throws(()=>allowedDemFile('relative/demo1.dem'));
    process.env.CS2_ANALYST_FIXTURE_ROOT='relative';assert.throws(()=>localDemFixture('nuke.dem'));
  } finally {if(previous===undefined)delete process.env.CS2_ANALYST_FIXTURE_ROOT;else process.env.CS2_ANALYST_FIXTURE_ROOT=previous;}
});
