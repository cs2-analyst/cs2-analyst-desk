import { Demoparser2Provider } from '@cs2-analyst/dem-parser';
import { buildDesktopReport } from './report.js';
import { ReplaySession } from './replay-session.ts';
import { DerivedReplaySession, createReplayProjections } from './library-derived-replay.ts';
import { replayResourceId } from '../shared/replay-resource.ts';
import { createHeatmapSession, type HeatmapSession } from './heatmap-session.ts';
import { displayPlayerName } from './player-name.ts';
import { buildDesktopSpatialFacts, unavailableDesktopSpatialFacts } from './spatial-facts.ts';
import { isDesktopSpatialFacts } from '@cs2-analyst/report-contract';
import type { ArchiveVersions, DesktopReplayMetadata, DesktopReplayRequest, DesktopSpatialFactsV1, ImportPlayerChoice } from '@cs2-analyst/report-contract';

declare const __CS2_ANALYST_ARCHIVE_VERSIONS__: Omit<ArchiveVersions, 'sampling' | 'mapResource'>;

// Owns input and bounded replay chunks. No file path crosses back to Renderer.
let initialized = false;
let session: { metadata: DesktopReplayMetadata; get(request: DesktopReplayRequest): unknown; clear(): void } | null = null;
let heatmapSession: HeatmapSession | null = null;
let disposed = false;
let pendingPlayerSelection: ((playerId: string | null) => void) | null = null;
let offeredPlayerIds = new Set<string>();
function waitForPlayerSelection(): Promise<string | null> {
  return new Promise(resolve => { pendingPlayerSelection = resolve; });
}
function clearSessions() {
  session?.clear();session=null;
  heatmapSession?.clear();heatmapSession=null;
}
process.on('exit',clearSessions);
async function restoreArchived(directory: string, sessionId: string) {
  clearSessions();
  const archive = await import('./library-archive.ts');
  // Full verification decompresses every component; historical open never trusts a summary.
  const loaded = await archive.loadLibraryArchive(directory);
  const { manifest, sources } = loaded;
  if (!loaded.report || !sources) throw new Error('Missing verified archive sources');
  // Hydrate verified bytes once; full verification already decoded the canonical sources.
  const report = loaded.report;
  if (report.replay) report.replay.sessionId = report.replay.available ? sessionId : null;
  if (report.heatmap) report.heatmap.sessionId = sessionId;
  const { upgradeReportPerformance } = await import('./player-performance.ts');
  upgradeReportPerformance(report);
  if (disposed) throw new Error('Worker disposed during restore');
  const heatmap = createHeatmapSession(sources.match, sources.replay, sources.spatial, sessionId);
  heatmapSession = heatmap.session;
  // Preserve archived capability limitations; never turn unavailable data into a new analysis.
  if (report.heatmap?.available) report.heatmap = heatmap.metadata;
  else { heatmapSession?.clear(); heatmapSession = null; }
  if (report.replay?.available) {
    session = manifest.schemaVersion === 2 && sources.replay
      ? new DerivedReplaySession(sources.replay, report.replay, round => archive.readArchiveProjection(directory, manifest, round))
      : { metadata: report.replay, get: request => archive.readArchiveChunk(directory, manifest, request), clear() {} };
  }
  return report;
}
process.parentPort?.on('message', async ({ data }: { data: { kind?: string; filePath?: string; sessionId?: string; requestId?: number; request?: unknown; archiveDirectory?: string; playerId?: string | null; expectedMatchId?: string; selfPlayerId?: string | null; createdAt?: string } }) => {
  if(!data||typeof data!=='object')return;
  if (data.kind === 'player-selection' && pendingPlayerSelection) {
    const resolve = pendingPlayerSelection;
    pendingPlayerSelection = null;
    const playerId = typeof data.playerId === 'string' && offeredPlayerIds.has(data.playerId) ? data.playerId : null;
    offeredPlayerIds = new Set();
    resolve(playerId);
    return;
  }
  if(data.kind==='session-release'){disposed=true;clearSessions();pendingPlayerSelection?.(null);pendingPlayerSelection=null;return;}
  if(data.kind==='heatmap-grid'){
    let result;
    try {result=heatmapSession?.get(data.request)??{kind:'error',message:'热力图会话或图层不可用。'};}
    catch {result={kind:'error',message:'热力图请求失败；比赛报告与回放仍可用。'};}
    process.parentPort?.postMessage({kind:'heatmap-grid',requestId:data.requestId,result});return;
  }
  if (data.kind === 'replay-chunk' && initialized) {
    const activeSession = session;
    let chunk: unknown = null;
    try {
      const value = data.request ? activeSession?.get(data.request as DesktopReplayRequest) : null;
      chunk = value && typeof (value as Promise<unknown>).then === 'function' ? await value : value;
    } catch { /* Corrupt archived chunks fail within this request, without crashing the worker. */ }
    if (disposed || session !== activeSession) return;
    process.parentPort?.postMessage({ kind:'replay-chunk',requestId:data.requestId,
      result:chunk?{kind:'success',chunk}:{kind:'error',message:'回放会话或数据块已失效。'} });
    return;
  }
  // Duplicate recovery reuses the just-analysed worker; public open starts from a fresh worker.
  const restoreKind = data.kind === 'restore-duplicate' ? (initialized ? 'restored-duplicate' : null)
    : data.kind === 'restore' && !initialized ? 'restored' : null;
  if (restoreKind && !disposed && typeof data.archiveDirectory === 'string' && typeof data.sessionId === 'string') {
    if (restoreKind === 'restored') initialized = true;
    try {
      const report = await restoreArchived(data.archiveDirectory, data.sessionId);
      process.parentPort?.postMessage({ kind: restoreKind, report });
    } catch { clearSessions(); process.parentPort?.postMessage({ kind: 'error', message: '已保存的比赛无法恢复，请检查比赛库档案完整性。' }); }
    return;
  }
  if (disposed || initialized || typeof data.filePath !== 'string' || typeof data.sessionId !== 'string') return;
  initialized = true;
  try {
    let spatialFacts: DesktopSpatialFactsV1 | null = null;
    const parsed = await new Demoparser2Provider().parseWithReplay(data.filePath, undefined,
      async access => { spatialFacts = await buildDesktopSpatialFacts(access); });
    if(disposed)return;
    if (data.expectedMatchId !== undefined && parsed.match.id !== data.expectedMatchId) {
      process.parentPort?.postMessage({ kind: 'error', message: '所选 DEM 与这条比赛记录不匹配，请选择原始录像；原报告保持不变。' }); return;
    }
    const offered: ImportPlayerChoice[] = [];
    const seen = new Set<string>();
    for (const player of Array.isArray(parsed.match.players) ? parsed.match.players : []) {
      if (!player.steamId || seen.has(player.steamId)) continue;
      seen.add(player.steamId);
      offered.push({ id: player.steamId, nickname: displayPlayerName(player.steamId, player.nickname) });
    }
    let selfPlayerId: string | null = null;
    if (data.expectedMatchId !== undefined) {
      selfPlayerId = data.selfPlayerId ?? null;
      if (selfPlayerId !== null && !seen.has(selfPlayerId)) {
        process.parentPort?.postMessage({ kind: 'error', message: '新解析结果缺少已选择的玩家，无法保留身份；原报告保持不变。' }); return;
      }
    } else if (typeof data.archiveDirectory === 'string') {
      // The user is asked only for the real import path. Direct harnesses keep the
      // original non-interactive worker protocol.
      offeredPlayerIds = new Set(offered.map(player => player.id));
      process.parentPort?.postMessage({ kind:'players', players: offered });
      selfPlayerId = await waitForPlayerSelection();
      if (disposed) return;
      offeredPlayerIds = new Set();
    }
    process.parentPort?.postMessage({ kind:'progress',phase:'analyzing' });
    const report = buildDesktopReport(parsed.match,data.filePath,parsed.spatial,undefined,selfPlayerId);
    report.analysis.spatialFacts = isDesktopSpatialFacts(spatialFacts, parsed.match.id,
      report.players.map(player => player.id)) ? spatialFacts : unavailableDesktopSpatialFacts(parsed.match.id);
    const validSelfPlayerId = selfPlayerId && report.players.some(player => player.id === selfPlayerId) ? selfPlayerId : null;
    let metadata:DesktopReplayMetadata={schemaVersion:1,available:false,unavailableReason:parsed.replayUnavailableReason??'回放不可用。',
      sessionId:null,matchId:parsed.match.id,map:parsed.match.map,resourceId:replayResourceId,samplingVersion:parsed.replay?.samplingVersion??'unavailable',
      tickRate:parsed.replay?.tickRate??null,maxInterpolationTicks:parsed.replay?.maxInterpolationTicks??null,perspective:'global',players:[],rounds:[],excludedRounds:[]};
    let replaySession: ReplaySession | null = null;
    try { if(parsed.replay){replaySession=new ReplaySession(parsed.match,parsed.replay,data.sessionId);session=replaySession;metadata=session.metadata;} }
    catch { session?.clear();session=null;metadata.unavailableReason='回放超出本机会话缓存预算；比赛报告仍可用。'; }
    report.replay=metadata;
    // Independent guarded initialization: heatmap failure never rejects a usable report/replay.
    const heatmap=createHeatmapSession(parsed.match,parsed.replay,parsed.spatial,data.sessionId);
    heatmapSession=heatmap.session;report.heatmap=heatmap.metadata;
    if (typeof data.archiveDirectory === 'string') {
      const archive = await import('./library-archive.ts');
      process.parentPort?.postMessage({ kind: 'progress', phase: 'saving' });
      const versions: ArchiveVersions = { ...__CS2_ANALYST_ARCHIVE_VERSIONS__, sampling: metadata.samplingVersion, mapResource: replayResourceId };
      const written = await archive.writeLibraryArchive(data.archiveDirectory, { report, chunks: replaySession?.chunks ?? new Map(),
        match: parsed.match, replay: parsed.replay, spatial: parsed.spatial, versions,
        ...(data.expectedMatchId !== undefined ? { createdAt: data.createdAt } : {}) });
      if (disposed) return;
      if (written.manifest.schemaVersion === 2 && parsed.replay && replaySession) {
        // Staging is renamed on commit. Retain only small immutable projection context,
        // never a loader pointing at the old staging path or the eager full-match cache.
        const projections = createReplayProjections(replaySession.chunks);
        const context = new Map<number, string>();
        let contextBytes = 0;
        for (const [round, projection] of projections) {
          const json = JSON.stringify(projection, (key, value) => key === 'sessionId' ? undefined : value);
          context.set(round, json); contextBytes += Buffer.byteLength(json);
        }
        // Keep source context in the same serialized form that is charged to the
        // session budget; discard the much larger parsed template trees.
        projections.clear();
        session = new DerivedReplaySession(parsed.replay, metadata, async round => {
          const json = context.get(round);
          if (!json) throw new Error('Missing replay projection');
          return JSON.parse(json);
        }, { retainedContextBytes: contextBytes });
        replaySession.clear(); replaySession = null;
      }
      // Verify every decompressed component in Utility before Main can publish its small catalogue entry.
      const verified = await archive.verifyLibraryArchive(data.archiveDirectory);
      if (disposed) return;
      if (written.manifestHash !== verified.manifestHash || written.storedBytes !== verified.storedBytes) throw new Error('Archive write verification mismatch');
      process.parentPort?.postMessage({ kind: 'prepared', report, receipt: { manifestHash: verified.manifestHash, storedBytes: verified.storedBytes }, selfPlayerId: validSelfPlayerId });
    } else {
      // Direct worker harnesses keep testing the original independent report/replay/heatmap degradation.
      // Main never publishes this response: real imports always require a verified staging receipt.
      process.parentPort?.postMessage({kind:'success',report,selfPlayerId:validSelfPlayerId});
    }
  } catch {
    clearSessions();
    process.parentPort?.postMessage({kind:'error',message:'无法分析此 DEM。请确认它是完整的 CS2 录像，然后重新选择。'});
  }
});
