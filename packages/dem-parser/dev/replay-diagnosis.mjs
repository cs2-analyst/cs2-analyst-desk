// S0 only: native queries remain inside dem-parser. No production exports or logging.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Demoparser2Provider } from '../dist/index.js';
import { planReplay, replayFields } from '../dist/providers/replay.js';

/** Command headers only, following the pinned native first_pass/parser.rs format.
 * Does not decode entity payloads or infer state persistence when no update was recorded. */
export function scanDemoCommandTicks(bytes, wantedTicks) {
  assert.equal(bytes.subarray(0, 8).toString(), 'PBDEMS2\0');
  const wanted = new Set(wantedTicks), found = new Map();
  let offset = 16, stopped = false;
  function varint() {
    let n = 0;
    for (let i = 0; i < 5; i++) {
      assert.ok(offset < bytes.length, 'Truncated DEM command header');
      const b = bytes[offset++]; n += (b & 127) * 2 ** (7 * i);
      if (!(b & 128)) return n;
    }
    throw new Error('Invalid DEM command varint');
  }
  while (offset + 3 <= bytes.length) {
    const command = varint() & ~64, tick = varint() | 0, size = varint();
    assert.ok(offset + size <= bytes.length, 'Truncated DEM command payload');
    if (wanted.has(tick)) {
      const commands = found.get(tick) ?? []; commands.push(command); found.set(tick, commands);
    }
    offset += size;
    if (command === 0) { stopped = true; break; }
  }
  return { stopped, inspectedBytes: offset, missingTickCommands: wantedTicks.map(tick => ({ tick, commands: found.get(tick) ?? [] })) };
}

export async function collectReplayDiagnosis(file) {
  const bytes = await readFile(file);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const parsed = await new Demoparser2Provider().parseWithReplay(file);
  assert.ok(parsed.replay, parsed.replayUnavailableReason);
  assert.equal(parsed.match.id, sha256);
  const native = await import('@cs2-analyst/demoparser-native');
  const plan = planReplay(parsed.match);
  const raw = native.parseTicks(bytes, replayFields, plan.ticks, parsed.replay.players);
  const rows = new Map(raw.map(row => [`${row.tick}:${row.steamid}`, row]));
  assert.equal(rows.size, raw.length, 'Duplicate native row');
  let positions = 0, replayPositions = 0, missingRows = 0, differences = 0;
  const missingTicks = [];
  for (const round of parsed.replay.rounds) for (const frame of round.frames) {
    let returned = 0;
    for (const sample of frame.players) {
      const row = rows.get(`${frame.requestedTick}:${sample.playerId}`);
      if (!row) missingRows++; else returned++;
      const valid = row && [row.X, row.Y, row.Z].every(Number.isFinite);
      if (valid) positions++;
      if (sample.position) replayPositions++;
      if (sample.actualTick !== (row ? frame.requestedTick : null)) differences++;
      // Disconnect is allowed to null a stale native position. Any other non-null position must agree.
      if (sample.position && (!valid || sample.position.some((v, i) => v !== [row.X, row.Y, row.Z][i]))) differences++;
    }
    if (!returned) missingTicks.push(frame.requestedTick);
  }
  assert.equal(differences, 0, 'Independent native query disagrees with production Replay');
  return {
    parsed, rows, bytes,
    summary: { sha256, fileBytes: bytes.length, nativeSha256: native.getBindingProvenance().verifiedSha256,
      map: parsed.match.map, tickRate: parsed.replay.tickRate, step: plan.step,
      requestedTicks: plan.ticks.length, expectedPlayerSamples: plan.ticks.length * parsed.replay.players.length,
      returnedRows: raw.length, missingRows, missingTicks, rawValidPositions: positions, replayValidPositions: replayPositions,
      rawAlivePositionRows: raw.filter(r => r.is_alive === true && [r.X, r.Y, r.Z].every(Number.isFinite)).length,
      replayAlivePositionSamples: parsed.replay.rounds.reduce((n, r) => n + r.frames.reduce((m, f) => m + f.players.filter(p => p.alive === true && p.position !== null).length, 0), 0),
      nativeReplayDifferences: differences, rounds: parsed.replay.rounds.length, players: parsed.replay.players,
      commandHeaderAudit: scanDemoCommandTicks(bytes, missingTicks),
      scope: 'Production 8 Hz + event/lifecycle/boundary requested sample opportunities; not all native ticks',
      replayMs: parsed.replayMs },
    async reference(ticks) {
      assert.ok(ticks.length > 0 && ticks.length <= 60000);
      return native.parseTicks(bytes, replayFields, ticks, parsed.replay.players);
    },
  };
}
