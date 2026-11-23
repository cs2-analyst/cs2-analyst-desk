import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";

import type { ParserAdapter } from "../adapter.js";
import type { SpatialParseResult, SpatialSamplingOptions } from "../spatial.js";
import { convertToMatch } from "./converters.js";
import { buildSpatialEvidence, planSpatialSampling, spatialFields } from "./spatial-evidence.js";
import { buildReplay, planReplay, replayFields } from './replay.js';
import type { LocalDemEvidenceConsumer, ReplayParseResult } from '../replay.js';
import { boundLocalEvidenceInput } from './prefix-input.js';

// Keep all native APIs and their untyped results behind this adapter.
export class Demoparser2Adapter implements ParserAdapter {
  readonly name = "demoparser2";

  async parse(filePath: string): Promise<unknown> {
    const { bytes, native } = await this.readInput(filePath);
    return this.parseInput(bytes, native);
  }

  async parseWithSpatial(filePath: string, options: SpatialSamplingOptions = {}): Promise<SpatialParseResult> {
    const { match, spatial, performance } = await this.parseEvidence(filePath, options, false);
    return { match, spatial, performance };
  }

  async parseWithReplay(filePath: string, options: SpatialSamplingOptions = {},
    localEvidenceConsumer?: LocalDemEvidenceConsumer): Promise<ReplayParseResult> {
    return this.parseEvidence(filePath, options, true, localEvidenceConsumer);
  }

  private async parseEvidence(filePath: string, options: SpatialSamplingOptions, includeReplay: boolean,
    localEvidenceConsumer?: LocalDemEvidenceConsumer): Promise<ReplayParseResult> {
    const started = performance.now();
    const { bytes, native } = await this.readInput(filePath);
    const input = this.parseInput(bytes, native);
    const match = convertToMatch(input);
    const parsed = performance.now();
    if (localEvidenceConsumer) {
      let activeBytes: Buffer | null = bytes;
      try {
        const parserVersion = `demoparser2:${native.getBindingProvenance().verifiedSha256}`;
        const raw = input as { id: string; header: { map_name: string };
          events: unknown[]; stateRows: unknown[] };
        const prefixInput = structuredClone(boundLocalEvidenceInput(raw));
        await localEvidenceConsumer({ rawInput: prefixInput, parserVersion,
          playerIds: match.players.map(player => player.steamId),
          queryExactTicks: (ticks, playerIds) => {
            if (!activeBytes || !Array.isArray(ticks) || ticks.length === 0 || ticks.length > 64
              || ticks.some(tick => !Number.isSafeInteger(tick) || tick < 0)
              || new Set(ticks).size !== ticks.length || !Array.isArray(playerIds)
              || playerIds.length === 0 || playerIds.length > 10
              || playerIds.some(id => typeof id !== 'string' || !/^[1-9]\d*$/.test(id))
              || new Set(playerIds).size !== playerIds.length) throw new Error('invalid-local-evidence-query');
            return native.parseTicks(activeBytes, spatialFields, [...ticks], [...playerIds]) as unknown;
          } });
      } catch { /* P8 facts degrade independently; report/replay must remain available. */ }
      finally { activeBytes = null; }
    }
    const plan = planSpatialSampling(match, options);
    const ticks = [...plan.coreTicks, ...plan.optionalTicks].sort((a, b) => a - b);
    let rawRows: unknown = [];
    let failed = false;
    if (ticks.length) {
      try {
        // Reuse the input bytes. One new native query, never an empty full-tick query.
        rawRows = native.parseTicks(bytes, spatialFields, ticks) as unknown;
      } catch {
        failed = true;
      }
    }
    const spatial = buildSpatialEvidence(match, plan, rawRows, failed);
    const finished = performance.now();
    let replay = null, replayUnavailableReason: string | null = null;
    if (includeReplay) {
      try {
        const replayPlan = planReplay(match);
        // Projectile rows are optional additive evidence. A native failure degrades flights to
        // effect-only; it never rejects the accepted replay frames or the match report.
        let projectiles: unknown = [];
        if (replayPlan.ticks.length) {
          try { projectiles = native.parseGrenades(bytes, [], false) as unknown; } catch { projectiles = []; }
        }
        replay = buildReplay(match, replayPlan, replayPlan.ticks.length ? native.parseTicks(bytes, replayFields, replayPlan.ticks,
          [...new Set(match.players.map(player=>player.steamId))]) : [], {
          projectiles,
          expiries: (input as { effectEvents?: unknown }).effectEvents,
        });
        if (!replay.rounds.length) { replay = null; replayUnavailableReason = '没有可靠的正式回合窗口。'; }
      } catch { replayUnavailableReason = '回放采样失败或超出本机会话预算；比赛报告仍可用。'; }
    }
    return { match, spatial, replay, replayUnavailableReason, replayMs: performance.now() - finished, performance: {
      parserMs: parsed - started, spatialMs: finished - parsed, totalMs: finished - started, peakMemory: "UNKNOWN",
    } };
  }

  private async readInput(filePath: string) {
    const bytes = await readFile(filePath);
    if (bytes.length < 16 || !bytes.subarray(0, 8).equals(Buffer.from("PBDEMS2\0"))) {
      throw new Error("文件不是有效的 CS2 DEM（PBDEMS2）");
    }

    const native = await import("@cs2-analyst/demoparser-native");
    return { bytes, native };
  }

  private parseInput(bytes: Buffer, native: typeof import("@cs2-analyst/demoparser-native")): unknown {
    const events = native.parseEvents(
      bytes,
      [
        "round_start",
        "round_end",
        "round_freeze_end",
        "player_death",
        "player_hurt",
        "weapon_fire",
        "smokegrenade_detonate",
        "smokegrenade_expired",
        "hegrenade_detonate",
        "flashbang_detonate",
        "inferno_startburn",
        "inferno_expire",
        "decoy_started",
        "player_blind",
        "bomb_pickup",
        "bomb_dropped",
        "bomb_beginplant",
        "bomb_planted",
        "bomb_begindefuse",
        "bomb_defused",
        "bomb_exploded",
        "player_spawn",
        "player_disconnect",
        "player_team",
      ],
      ["team_num", "is_alive"],
      ["total_rounds_played", "is_warmup_period", "game_time"],
    ) as unknown;
    const boundaryTicks = [...new Set((events as Record<string, unknown>[])
      .filter(event => event.is_warmup_period !== true
        && ["round_start", "round_freeze_end", "round_end"].includes(String(event.event_name))
        && typeof event.tick === "number" && Number.isSafeInteger(event.tick) && event.tick >= 0)
      .map(event => event.tick as number))].sort((a, b) => a - b);

    // Replay-only expiry evidence. Remove these rows from the Match input so the frozen
    // Match/Analytics player roster and event list are bit-for-bit unchanged.
    const expiryNames = new Set(["smokegrenade_expired", "inferno_expire"]);
    const effectEvents = (events as Record<string, unknown>[]).filter(event => expiryNames.has(String(event.event_name)));
    const matchEvents = (events as Record<string, unknown>[]).filter(event => !expiryNames.has(String(event.event_name)));
    return {
      id: createHash("sha256").update(bytes).digest("hex"),
      header: native.parseHeader(bytes) as unknown,
      players: native.parsePlayerInfo(bytes) as unknown,
      events: matchEvents,
      effectEvents,
      stateRows: boundaryTicks.length > 0
        ? native.parseTicks(bytes, ["team_num", "is_alive"], boundaryTicks) as unknown
        : [],
    };
  }
}
