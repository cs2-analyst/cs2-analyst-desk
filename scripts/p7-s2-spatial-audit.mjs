// Development-only P7-S2 evidence collector. Uses the production parser/presenter;
// it does not query native APIs, alter domain evidence, or persist a DEM/large trace.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Demoparser2Provider } from '../packages/dem-parser/dist/index.js';
import { projectMapHeatmap } from '../apps/desktop/shared/heatmap.ts';
import { replayMapDefinitions, resolveMapLayer } from '../apps/desktop/shared/replay-map-geometry.ts';

const [fileArg, outputArg] = process.argv.slice(2);
assert.ok(fileArg && outputArg, 'node scripts/p7-s2-spatial-audit.mjs <local nuke.dem> <output-directory>');
const file = resolve(fileArg), output = resolve(outputArg);
assert.equal(file.split(/[\\/]/).at(-1), 'nuke.dem');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sum = xs => xs.reduce((a, b) => a + b, 0);
const finitePosition = p => Array.isArray(p) && p.length === 3 && p.every(Number.isFinite);
const sha = createHash('sha256');
for await (const bytes of createReadStream(file)) sha.update(bytes);
const sha256 = sha.digest('hex'), bytes = (await stat(file)).size;
const prior = await Promise.all(['diagnosis', 'fix'].map(async name => {
  const path = resolve(`docs/p7-nuke-replay-${name}.json`);
  const record = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(record.fixture.sha256, sha256);
  assert.equal(record.fixture.bytes, bytes);
  return { path: `docs/p7-nuke-replay-${name}.json`, sha256: record.fixture.sha256, bytes: record.fixture.bytes };
}));
const previousFiles = [];
for (const name of ['source.json', 'chunks.json']) {
  const path = resolve(dirname(file), '../.tmp/p7-nuke-s0', name);
  try {
    const record = JSON.parse(await readFile(path, 'utf8'));
    previousFiles.push({ path, bytes: (await stat(path)).size, keys: Object.keys(record),
      containsMatch: Object.hasOwn(record, 'match'), containsSpatial: Object.hasOwn(record, 'spatial'),
      containsHeatmap: Object.hasOwn(record, 'heatmap'), reasonInsufficient: 'Replay diagnostic summary/chunks lack Match roster snapshots and exact Spatial kill actor/target evidence required by production Heatmap.' });
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

// parseWithReplay is the current production input to HeatmapSession (no parseWithHeatmap API).
const parsed = await new Demoparser2Provider().parseWithReplay(file);
const { match, spatial, replay } = parsed;
assert.equal(match.id, sha256); assert.equal(match.map, 'de_nuke'); assert.ok(replay);
assert.equal(match.tickRate, 64); assert.equal(replay.hz, 8); assert.equal(replay.maxInterpolationTicks, 8);
const before = { match: hash(match), spatial: hash(spatial), replay: hash(replay) };
const resolution = 32;
const safeTick = value => Number.isSafeInteger(value) && value >= 0;
const sourceWindows = [...match.rounds].sort((a, b) => a.number - b.number).flatMap(round => {
  if (!safeTick(round.startTick) || !safeTick(round.endTick) || round.endTick < round.startTick) return [];
  const freezeKnown = safeTick(round.freezeEndTick) && round.freezeEndTick >= round.startTick && round.freezeEndTick <= round.endTick;
  return [{ round: round.number, startTick: freezeKnown ? round.freezeEndTick : round.startTick, endTick: round.endTick }];
});

// Independent arithmetic uses pinned overview numbers to compare every grid cell,
// grid floor/mapping rejections and observation categories. Event rejection
// reasons are checked by arithmetic conservation, not independently classified.
function pointDetails(point) {
  const [x, y, z] = point.position;
  const floor = z >= -10000 && z < -495 ? 'lower' : z > -495 && z <= 10000 ? 'default' : null;
  const rx = (x + 3453) / (7 * 1024), ry = (2887 - y) / (7 * 1024);
  const cell = rx >= 0 && ry >= 0 && rx < 1 && ry < 1
    ? Math.floor(ry * resolution) * resolution + Math.floor(rx * resolution) : null;
  return { ...point, floor, cell };
}
function positionPoints(samplingSet) {
  const points = [], windows = [], observations = { expectedOpportunities: 0, validPositionSamples: 0,
    confirmedDeadObservations: 0, observedButUnusable: 0, missingPositionObservations: 0 };
  for (const window of sourceWindows) {
    const round = match.rounds.find(r => r.number === window.round);
    const rr = replay.rounds.find(r => r.round === window.round);
    const snapshot = round.stateSnapshots?.find(s => s.boundary === 'freeze_end' && s.availability === 'observed')
      ?? round.stateSnapshots?.find(s => s.boundary === 'start' && s.availability === 'observed');
    const ids = new Set(snapshot ? snapshot.players.filter(p => p.participant === true).map(p => p.steamId) : replay.players);
    let requestedFrames = 0;
    for (const frame of rr.frames) {
      if (frame.requestedTick < window.startTick || frame.requestedTick > window.endTick
        || (samplingSet === 'uniform-8hz' && (frame.requestedTick - round.startTick) % 8 !== 0)) continue;
      requestedFrames++;
      const byId = new Map(frame.players.map(p => [p.playerId, p]));
      for (const id of ids) {
        observations.expectedOpportunities++;
        const sample = byId.get(id);
        if (!sample || sample.actualTick !== frame.requestedTick || !safeTick(sample.actualTick) || !finitePosition(sample.position)) {
          observations.missingPositionObservations++; continue;
        }
        if (sample.alive === false && sample.stateAmbiguous === false) { observations.confirmedDeadObservations++; continue; }
        if (sample.alive !== true || sample.stateAmbiguous !== false || !['CT', 'T'].includes(sample.side) || sample.segment === null) {
          observations.observedButUnusable++; continue;
        }
        observations.validPositionSamples++;
        points.push(pointDetails({ round: window.round, tick: frame.requestedTick, requestedTick: frame.requestedTick, actualTick: sample.actualTick,
          playerId: sample.playerId, position: sample.position, segment: sample.segment, source: 'Replay exact native observation' }));
      }
    }
    windows.push({ ...window, requestedFrames, rosterSize: ids.size });
  }
  return { points, windows, observations };
}
function eventPoints(role) {
  const points = [];
  for (const window of sourceWindows) {
    const round = match.rounds.find(r => r.number === window.round);
    round.events.forEach((event, eventIndex) => {
      if (event.type !== 'kill' || event.tick < window.startTick || event.tick > window.endTick) return;
      const subject = role === 'actor' ? event.killer : event.victim;
      if (!match.players.some(p => p.steamId === subject)) return;
      const entries = spatial.events.filter(e => e.eventRef.round === round.number && e.eventRef.type === 'kill'
        && e.eventRef.tick === event.tick && e.eventRef.eventIndex === eventIndex);
      if (entries.length !== 1) return;
      const samples = entries[0].samples.filter(b => b.role === role && b.sample.relation === 'at-event');
      if (samples.length !== 1) return;
      const sample = samples[0].sample;
      if (sample.playerId !== subject || sample.actualTick !== event.tick || sample.requestedTick !== event.tick || !sample.position) return;
      const p = [sample.position.x, sample.position.y, sample.position.z];
      if (!finitePosition(p)) return;
      points.push(pointDetails({ round: round.number, tick: event.tick, requestedTick: sample.requestedTick, actualTick: sample.actualTick, eventIndex, role,
        playerId: subject, position: p, relation: sample.relation, alive: sample.alive, source: 'Spatial exact at-event observation' }));
    });
  }
  return points;
}
function summarize(projection) {
  const { positions, kills, deaths, ...other } = projection;
  const layer = item => {
    const { grid, ...counts } = item;
    const { cells, ...gridCounts } = grid;
    return { ...counts, grid: { ...gridCounts, populatedCells: cells.filter(c => c.cellSampleCount > 0).length,
      cellCountsSha256: hash(cells.map(c => c.cellSampleCount)) } };
  };
  return { ...other, positions: layer(positions), kills: layer(kills), deaths: layer(deaths) };
}
function validateLayer(projections, name, points) {
  const categories = { default: 0, lower: 0, unknown: 0 };
  for (const p of points) categories[p.floor ?? 'unknown']++;
  for (const [key, dto] of Object.entries(projections)) {
    const floor = key === 'all' ? null : key, layer = dto[name], g = layer.grid;
    const selected = points.filter(p => floor === null || p.floor === floor);
    const cells = Array(resolution * resolution).fill(0);
    for (const p of selected) if (p.cell !== null) cells[p.cell]++;
    assert.equal(g.validPositionSamples, selected.length);
    assert.equal(g.unknownLayer, categories.unknown);
    assert.equal(g.otherFloor, floor === null ? 0 : points.filter(p => p.floor !== null && p.floor !== floor).length);
    assert.equal(g.invalidMapping, 0); assert.equal(g.outOfBounds, selected.filter(p => p.cell === null).length);
    assert.deepEqual(g.cells.map(c => c.cellSampleCount), cells);
    assert.equal(sum(cells), g.aggregatedSamples);
    assert.equal(g.validPositionSamples, g.aggregatedSamples + g.outOfBounds + g.invalidMapping);
    if (name === 'positions') {
      const o = layer.observations;
      assert.equal(o.expectedOpportunities, o.validPositionSamples + o.confirmedDeadObservations + o.observedButUnusable + o.missingPositionObservations);
      assert.equal(o.validPositionSamples, points.length);
    } else assert.equal(layer.scopeEvents, layer.locatableEvents + sum(Object.values(layer.unlocatableReasons)));
  }
  const byCell = new Map();
  for (const p of points) if (p.cell !== null) {
    const group = byCell.get(p.cell) ?? { default: [], lower: [], unknown: [] };
    group[p.floor ?? 'unknown'].push(p); byCell.set(p.cell, group);
  }
  const merged = [...byCell].filter(([, g]) => g.default.length && g.lower.length);
  let sameTick = null;
  for (const [cell, group] of merged) {
    const known = new Map(group.default.map(p => [`${p.round}:${p.tick}`, p]));
    const lower = group.lower.find(p => known.has(`${p.round}:${p.tick}`));
    if (lower) { sameTick = { cell, main: known.get(`${lower.round}:${lower.tick}`), lower }; break; }
  }
  const chosen = sameTick ?? (merged.length ? { cell: merged[0][0], main: merged[0][1].default[0], lower: merged[0][1].lower[0] } : null);
  if (chosen) chosen.productionCellCounts = Object.fromEntries(Object.entries(projections).map(([floor, dto]) => [floor, dto[name].grid.cells[chosen.cell].cellSampleCount]));
  const nearest = [...points].sort((a, b) => Math.abs(a.position[2] + 495) - Math.abs(b.position[2] + 495));
  const nearestBoundarySamples = [], seenZ = new Set();
  for (const point of nearest) if (!seenZ.has(point.position[2])) {
    nearestBoundarySamples.push(point); seenZ.add(point.position[2]);
    if (nearestBoundarySamples.length === 3) break;
  }
  return { selectedSourcePoints: points.length, categories, mergedMainLowerCells: merged.length,
    mergedBucketExample: chosen, exampleSameTick: sameTick !== null,
    nearestBoundarySamples,
    invariantStatus: 'PASS: independent source selection, per-cell counts, floor rejections, event/observation and grid conservation' };
}
const scopes = {};
for (const samplingSet of ['all-valid', 'uniform-8hz']) {
  const projections = Object.fromEntries([null, 'default', 'lower'].map(floor => [floor ?? 'all',
    projectMapHeatmap(match, replay, spatial, { floor, samplingSet, resolution })]));
  const selectedPositions = positionPoints(samplingSet);
  for (const projection of Object.values(projections)) {
    assert.deepEqual(projection.windows, selectedPositions.windows);
    for (const [key, value] of Object.entries(selectedPositions.observations)) assert.equal(projection.positions.observations[key], value);
  }
  const points = { positions: selectedPositions.points, kills: eventPoints('actor'), deaths: eventPoints('target') };
  scopes[samplingSet] = { projections: Object.fromEntries(Object.entries(projections).map(([k, dto]) => [k, summarize(dto)])),
    checks: Object.fromEntries(Object.entries(points).map(([name, selected]) => [name, validateLayer(projections, name, selected)])) };
}
assert.deepEqual({ match: hash(match), spatial: hash(spatial), replay: hash(replay) }, before);
const boundaryCases = [];
for (const [id, shared, low, high] of [['de_nuke', -495, -10000, 10000], ['de_vertigo', 11700, -10000, 20000]]) {
  const definition = replayMapDefinitions.find(m => m.id === id);
  for (const [label, z, expected] of [['below', shared - 0.001, 'lower'], ['shared', shared, null], ['above', shared + 0.001, 'default'],
    ['missing', null, null], ['NaN', NaN, null], ['below-range', low - 1, null], ['above-range', high + 1, null]]) {
    const actual = resolveMapLayer(definition, z); assert.equal(actual, expected);
    boundaryCases.push({ map: id, input: label, z: Number.isNaN(z) ? 'NaN' : z, expected, actual, provenance: 'SYNTHETIC geometry boundary only' });
  }
}
const evidence = { schema: 'p7-s2-real-spatial-heatmap-v1', status: 'PASS', fixture: { path: file, sha256, bytes, matchedS0S1: prior },
  baseline: 'f1a05b8', command: `node scripts/p7-s2-spatial-audit.mjs "${file}" "${output}"`,
  existingEvidenceReview: previousFiles,
  rationaleForNewParse: 'Existing S0/S1 artifacts do not contain exact Spatial+Match evidence for faithful three-layer production projection. One production parseWithReplay supplies Match, Spatial and Replay to the unchanged pure presenter.',
  executionHistory: [{ attempt: 1, exitCode: -1, status: 'INTERRUPTED', reason: 'Collector nearest-boundary sample deduplication used quadratic findIndex; stopped the verified collector process and replaced it with Set and early stop. No product/parser assertion failure was observed.' },
    { attempt: 2, status: 'Completed collector; shell records final exit code separately', finalSourceSha256: createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex') }],
  parseEntry: 'Demoparser2Provider.parseWithReplay (same as report-worker); parseWithHeatmap does not exist',
  input: { map: match.map, tickRate: match.tickRate, rounds: match.rounds.length, players: match.players.length,
    replaySource: replay.source, replaySamplingVersion: replay.samplingVersion, replayRequestedFrames: sum(replay.rounds.map(r => r.frames.length)),
    spatialProvenance: spatial.provenance, spatialEventRefs: spatial.events.length, spatialCoverage: spatial.coverage,
    spatialSampling: { coreTicks: spatial.sampling.coreTicks.length, optionalTicks: spatial.sampling.optionalTicks.length,
      omittedOptionalTicks: spatial.sampling.omittedOptionalTicks.length, returnedTicks: spatial.sampling.returnedTicks.length, rowCount: spatial.sampling.rowCount },
    immutableEvidenceHashes: before },
  scope: { rounds: 'all 21 retained formal rounds', playerIds: 'all round roster participants', side: 'all', includeFreezeTime: false,
    resolution, layers: ['positions', 'kills', 'deaths'], floors: ['all', 'default', 'lower'], samplingSets: ['all-valid', 'uniform-8hz'],
    precision: 'schematic-position-distribution', alignment: 'unconfirmed', interpolationUsedInHeatmap: false },
  oracleScope: 'Shares accepted production Match/Spatial/Replay domain observations only. Windows and roster are rebuilt from Match, observation categories are recounted without presenter helpers, and Nuke floor ranges (-10000,-495,10000) and radar arithmetic (-3453,2887,7,1024) are explicitly pinned constants. Every production grid cell and grid floor/mapping rejection count is independently compared. Event unlocatableReasons are checked by arithmetic conservation only, not independently classified. Does not independently establish map-version alignment or native entity freshness.',
  scopes, syntheticBoundaryChecks: boundaryCases,
  vertigo: { status: 'NOT RUN', reason: 'No local .demo/vertigo.dem; no download, replacement or synthetic real-map acceptance.' },
  limits: ['Exact native final-tick observation does not prove entity freshness or subtick state.', 'At-death-event target XYZ is not pre-death aim or route evidence.',
    'Merged XY buckets do not establish a shared traversable space, LOS, cover, path reachability, intent or tactical value.', 'Map/radar version alignment remains unconfirmed.'] };
await mkdir(output, { recursive: true });
const outputFile = resolve(output, 'real-spatial-heatmap.json');
await writeFile(outputFile, JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify({ status: evidence.status, outputFile, sha256, scopes: Object.fromEntries(Object.entries(scopes).map(([name, value]) => [name, value.checks])) }, null, 2));
