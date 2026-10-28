import type { Match } from "@cs2-analyst/match-model";

import type { DemoParser } from "../parser.js";
import type { SpatialParseResult, SpatialSamplingOptions } from "../spatial.js";
import { convertToMatch } from "./converters.js";
import { Demoparser2Adapter } from "./demoparser2-adapter.js";
import type { LocalDemEvidenceConsumer, ReplayParseResult } from '../replay.js';

/**
 * demoparser2 implementation entry point.
 *
 * This adapter converts demoparser2 output into match-model.
 * The rest of the application must not depend on demoparser2 directly.
 */
export class Demoparser2Provider implements DemoParser {
  private readonly adapter = new Demoparser2Adapter();

  async parse(filePath: string): Promise<Match> {
    try {
      return convertToMatch(await this.adapter.parse(filePath));
    } catch (cause) {
      throw new Error(`无法解析 DEM 文件：${filePath}`, { cause });
    }
  }

  /** Explicit opt-in; the existing desktop parse/report path remains unchanged. */
  async parseWithSpatial(filePath: string, options?: SpatialSamplingOptions): Promise<SpatialParseResult> {
    try {
      return await this.adapter.parseWithSpatial(filePath, options);
    } catch (cause) {
      throw new Error(`无法解析 DEM 空间证据：${filePath}`, { cause });
    }
  }

  /** Explicit continuous replay; shares input/Match/Spatial without changing sparse evidence. */
  async parseWithReplay(filePath: string, options?: SpatialSamplingOptions,
    localEvidenceConsumer?: LocalDemEvidenceConsumer): Promise<ReplayParseResult> {
    try { return await this.adapter.parseWithReplay(filePath, options, localEvidenceConsumer); }
    catch (cause) { throw new Error(`无法解析 DEM 回放：${filePath}`, { cause }); }
  }
}
