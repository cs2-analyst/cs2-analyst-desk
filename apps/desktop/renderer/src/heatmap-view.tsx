import { useEffect, useRef, useState } from 'react';
import { Badge, Body1, Button, Caption1, Checkbox, Field, Title2, makeStyles, tokens } from '@fluentui/react-components';
import type { DesktopHeatmapMetadata, DesktopHeatmapScope, HeatmapLayer, HeatmapResolution, MapHeatmapProjection } from '@cs2-analyst/report-contract';
import { replayMapDefinitions } from '../../shared/replay-map-geometry.ts';
import { replayMapAssets } from './replay-map-assets';
import { defaultHeatmapLayers, defaultHeatmapScope, heatmapLayers, heatmapReason, heatmapScheduler } from './heatmap-state';
import type { HeatmapLayerState } from './heatmap-state';
import { mountHeatmapCanvas } from './heatmap-canvas';
import { useRoundMenu } from './round-menu';
import { WinSelect } from './winui-select';
import type { HeatmapPaintLayer } from './heatmap-canvas';
import { palette } from './theme';
import { LoadingRows, MapSkeleton } from './loading-ui';

const labels = { positions: '玩家位置密度', kills: '击杀位置', deaths: '死亡位置' };
const ratio = (value: number | null | undefined) => value === null || value === undefined ? '—' : `${(value * 100).toFixed(1)}%`;
const failureLabels: Record<string, string> = { worldActor: '世界伤害', unknownPlayer: '玩家未知', missingEvidence: '缺少证据',
  ambiguousEvidence: '证据歧义', participantMismatch: '参与者不匹配', missingAtEvent: '缺少事件位置', missingExactSample: '缺少精确采样',
  tickMismatch: 'tick 不匹配', invalidPosition: '无效位置', unknownSide: '阵营未知' };
const useStyles = makeStyles({
  root: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: '10px' },
  // First row mirrors the replay toolbar: title, layer switches, then the map-version badge.
  bar: { flexShrink: 0, display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '10px', padding: '8px 10px',
    backgroundColor: palette.card, border: `1px solid ${palette.border}`, borderRadius: tokens.borderRadiusLarge },
  barTitle: { display: 'flex', alignItems: 'baseline', gap: '8px' },
  layers: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px' },
  layer: { display: 'flex', alignItems: 'center', gap: '4px' },
  spacer: { flex: 1 },
  controls: { flexShrink: 0, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px', padding: '10px', backgroundColor: palette.card, borderRadius: tokens.borderRadiusLarge },
  field: { minWidth: '106px', maxWidth: '180px', flex: '1 1 106px' },
  dropdown: { width: '100%', minWidth: 0, '& button': { minWidth: 0, width: '100%' } },
  body: { flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 280px', gap: '12px' },
  map: { minWidth: 0, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: palette.replay.surface, overflow: 'hidden', position: 'relative' },
  canvas: { flexShrink: 0, maxWidth: '100%', maxHeight: '100%', ':focus-visible': { outline: `2px solid ${tokens.colorBrandStroke1}`, outlineOffset: '-2px' } },
  notice: { position: 'absolute', inset: 0, display: 'flex', justifyContent: 'center', alignItems: 'center', textAlign: 'center', padding: '24px', backgroundColor: palette.replay.surface },
  side: { overflowY: 'auto', minHeight: 0, display: 'flex', flexDirection: 'column', gap: '10px', paddingRight: '4px' },
  group: { flexShrink: 0, display: 'flex', flexDirection: 'column', gap: '6px', padding: '12px', backgroundColor: palette.card, borderRadius: tokens.borderRadiusLarge },
  muted: { color: tokens.colorNeutralForeground3 },
});

export function HeatmapView({ metadata, players, active, sessionActive }: {
  metadata?: DesktopHeatmapMetadata; players: { id: string; nickname: string }[]; active: boolean; sessionActive: boolean;
}) {
  const s = useStyles();
  const [scope, setScope] = useState<DesktopHeatmapScope>(() => ({ ...defaultHeatmapScope }));
  const [resolution, setResolution] = useState<HeatmapResolution>(32);
  const [enabled, setEnabled] = useState<HeatmapLayer[]>(() => defaultHeatmapLayers(metadata)), [retry, setRetry] = useState(0);
  const initializedSession = useRef<string | null>(null);
  const roundMenu = useRoundMenu();
  const [results, setResults] = useState<{ key: string; sessionId?: string | null; url?: string; resolution: HeatmapResolution;
    scope: DesktopHeatmapScope; enabled: HeatmapLayer[]; layers: Partial<Record<HeatmapLayer, HeatmapLayerState>> }>({ key: '', resolution: 32, scope: defaultHeatmapScope, enabled: [], layers: {} });
  const [imageState, setImageState] = useState('loading'), [cellIndex, setCellIndex] = useState<number | null>(null);
  const [imageRetry, setImageRetry] = useState(0);
  const host = useRef<HTMLDivElement>(null), canvas = useRef<HTMLCanvasElement>(null);
  const painter = useRef<ReturnType<typeof mountHeatmapCanvas> | null>(null);
  const map = replayMapDefinitions.find(map => map.id === metadata?.map.id && map.resourceId === metadata.map.resourceId);
  const floor = map?.layers.find(layer => layer.id === scope.floor) ?? map?.layers[0];
  const requestedUrl = metadata?.map.alignment !== 'unavailable' && floor ? replayMapAssets[floor.image] : undefined;
  const usable = Boolean(sessionActive && metadata?.available);
  const key = JSON.stringify([metadata, scope, resolution, enabled, usable, retry]);
  const hasResults = Boolean(results.key && results.sessionId === metadata?.sessionId);
  const updating = usable && results.key !== key;
  const states = hasResults ? results.layers : {};
  // A complete previous snapshot keeps its own floor image, grid size and enabled layers.
  const url = hasResults ? results.url : requestedUrl;
  const displayResolution = hasResults ? results.resolution : resolution;
  const displayEnabled = hasResults ? results.enabled : enabled;
  const paintLayers: HeatmapPaintLayer[] = [];
  for (const layer of heatmapLayers) {
    const state = states[layer];
    if (displayEnabled.includes(layer) && state?.status === 'ready') paintLayers.push({ layer, projection: state.projection, color: palette.heatmap[layer] });
  }
  const liveLayers = useRef(paintLayers); liveLayers.current = paintLayers;
  // A source that becomes unavailable is removed instead of requesting an impossible layer.
  // A source that later recovers stays off: the user's manual choice is never overridden.
  useEffect(() => {
    if (!metadata) { setEnabled([]); return; }
    if (initializedSession.current !== metadata.sessionId) {
      initializedSession.current = metadata.sessionId;
      setEnabled(defaultHeatmapLayers(metadata));
      return;
    }
    setEnabled(old => old.filter(layer => metadata.layers[layer].available));
  }, [metadata?.sessionId, metadata?.layers.positions.available, metadata?.layers.kills.available, metadata?.layers.deaths.available]);
  useEffect(() => {
    if (!usable || !metadata) return;
    const next: Partial<Record<HeatmapLayer, HeatmapLayerState>> = {};
    const publish = () => setResults({ key, sessionId: metadata.sessionId, url: requestedUrl, resolution, scope, enabled, layers: { ...next } });
    if (enabled.length === 0) { publish(); return; }
    return heatmapScheduler.update(metadata, resolution, scope, enabled,
      request => window.cs2Analyst.heatmap.getGrid(request),
      (layer, state) => {
        next[layer] = state;
        // Publish one coherent result, including per-layer errors, after the entire batch settles.
        if (enabled.every(item => next[item] && next[item]!.status !== 'loading')) publish();
      });
  }, [key]);
  useEffect(() => {
    if (!url || !host.current || !canvas.current) return;
    const mounted = mountHeatmapCanvas(host.current, canvas.current, url, () => liveLayers.current, setImageState);
    painter.current = mounted;
    return () => { mounted.dispose(); painter.current = null; };
  }, [url, imageRetry]);
  useEffect(() => { painter.current?.schedule(); }, [active, results, key]);
  const change = (patch: Partial<DesktopHeatmapScope>) => { setScope(old => ({ ...old, ...patch })); setCellIndex(null); };
  const currentCell = cellIndex !== null && cellIndex < displayResolution * displayResolution ? cellIndex : null;
  return <section className={s.root} aria-label="地图热力图" data-heatmap-session={metadata?.sessionId} data-heatmap-enabled={enabled.join(',')}
    data-heatmap-updating={updating ? 'true' : 'false'} data-heatmap-applied-side={hasResults ? results.scope.side : ''}
    data-heatmap-applied-resolution={hasResults ? results.resolution : ''}>
    <div className={s.bar} data-heatmap-bar>
      <div className={s.barTitle}><Title2>热力图</Title2></div>
      <div className={s.layers} aria-label="热力图图层">
        {heatmapLayers.map(layer => <div key={layer} className={s.layer}>
          <Button aria-pressed={enabled.includes(layer)} aria-label={labels[layer]} disabled={!usable || !metadata?.layers[layer].available}
            appearance={enabled.includes(layer) ? 'primary' : 'secondary'} onClick={() => setEnabled(old => old.includes(layer) ? old.filter(item => item !== layer) : [...old, layer])}>{labels[layer]}</Button>
          {!metadata?.layers[layer].available ? <Caption1>{heatmapReason(metadata?.layers[layer].unavailableReason)}</Caption1> : null}
        </div>)}
      </div>
      <span className={s.spacer} />
      <Badge appearance="tint" color="warning">{url ? '地图版本未确认' : '地图映射或资源不可用'}</Badge>
    </div>
    <div className={s.controls} aria-label="热力图筛选">
      <Field label="玩家" className={s.field}><WinSelect className={s.dropdown} aria-label="热力图玩家"
        value={scope.playerIds?.[0] ?? 'all'}
        items={[{ value: 'all', text: '全部玩家' }, ...(metadata?.playerIds ?? []).map(id => ({ value: id, text: players.find(player => player.id === id)?.nickname ?? '已登记玩家' }))]}
        onValueChange={value => change({ playerIds: value === 'all' ? null : [value] })} /></Field>
      <Field label="阵营" className={s.field}><WinSelect className={s.dropdown} aria-label="热力图阵营" value={scope.side}
        items={[{ value: 'all', text: '全部阵营' }, { value: 'CT', text: 'CT' }, { value: 'T', text: 'T' }]}
        onValueChange={value => change({ side: value as DesktopHeatmapScope['side'] })} /></Field>
      <Field label="回合" className={s.field}><WinSelect className={s.dropdown} ref={roundMenu.triggerRef} aria-label="热力图回合"
        value={scope.rounds?.[0] !== undefined ? String(scope.rounds[0]) : 'all'}
        items={[{ value: 'all', text: '全部回合' }, ...(metadata?.rounds ?? []).map(round => ({ value: String(round), text: `R${round}` }))]}
        listbox={{ className: roundMenu.listboxClassName }} positioning={roundMenu.positioning} onOpenChange={roundMenu.onOpenChange}
        onValueChange={value => change({ rounds: value === 'all' ? null : [Number(value)] })} /></Field>
      <Field label="楼层" className={s.field}><WinSelect className={s.dropdown} aria-label="热力图楼层" value={scope.floor ?? 'all'}
        items={[{ value: 'all', text: '全部楼层' }, ...(map?.layers.filter(layer => metadata?.floors.includes(layer.id)) ?? []).map(layer => ({ value: layer.id, text: layer.label }))]}
        onValueChange={value => change({ floor: value === 'all' ? null : value })} /></Field>
      <Field label="网格" className={s.field}><WinSelect className={s.dropdown} aria-label="热力图分辨率" value={String(resolution)}
        items={[16, 32, 64].map(n => ({ value: String(n), text: `${n}×${n}` }))}
        onValueChange={value => { setResolution(Number(value) as HeatmapResolution); setCellIndex(null); }} /></Field>
      <Field label="采样集" className={s.field}><WinSelect className={s.dropdown} aria-label="热力图采样集" value={scope.samplingSet}
        items={[{ value: 'all-valid', text: 'all-valid' }, { value: 'uniform-8hz', text: 'uniform-8hz' }]}
        onValueChange={value => change({ samplingSet: value as DesktopHeatmapScope['samplingSet'] })} /></Field>
      <Checkbox label="包含冻结时间" checked={scope.includeFreezeTime} onChange={(_, data) => change({ includeFreezeTime: data.checked === true })} />
    </div>
    <div className={s.body} aria-busy={updating}>
      <div ref={host} className={s.map} data-heatmap-map>
        <canvas ref={canvas} width={1} height={1} className={s.canvas} role="img" tabIndex={0} aria-label="热力图雷达；方向键选择网格，右侧查看计数与强度"
          onPointerMove={event => { const rect = event.currentTarget.getBoundingClientRect(); const x = Math.floor((event.clientX - rect.left) / rect.width * displayResolution), y = Math.floor((event.clientY - rect.top) / rect.height * displayResolution); if (x >= 0 && y >= 0 && x < displayResolution && y < displayResolution) setCellIndex(y * displayResolution + x); }}
          onFocus={() => setCellIndex(old => old ?? 0)} onKeyDown={event => { const delta = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -displayResolution, ArrowDown: displayResolution }[event.key]; if (delta !== undefined) { event.preventDefault(); setCellIndex(old => Math.max(0, Math.min(displayResolution * displayResolution - 1, (old ?? 0) + delta))); } }} />
        {usable && url && imageState === 'loading' ? <MapSkeleton label="正在加载雷达底图" /> : !url || imageState !== 'ready' || !usable ? <div className={s.notice} role={imageState === 'error' ? 'alert' : 'status'}><div>
          <Body1>{!usable ? heatmapReason(metadata?.unavailableReason) : !url ? '地图映射或底图不可用；仍可查看右侧统计。' : '地图图片加载失败；仍可查看右侧统计。'}</Body1>
          {url && imageState === 'error' && usable ? <div><Button onClick={() => setImageRetry(n => n + 1)}>重新加载雷达底图</Button></div> : null}
        </div></div> : null}
      </div>
      <aside className={s.side} aria-label="热力图统计与图例">
        <div className={s.group}><Body1>图例 · 当前筛选的相对强度</Body1><Caption1>强度 = 单元格计数 / 当前图层最大单元格计数。不同图层的强度不能直接比较数量；透明度从 0 到 80%。叠加顺序：位置 → 击杀 → 死亡。</Caption1>
          {heatmapLayers.map(layer => <Caption1 key={layer} style={{ color: palette.heatmap[layer] }}>{labels[layer]} · {displayEnabled.includes(layer) ? '已开启' : '未开启'}</Caption1>)}
          <Caption1>{currentCell === null ? '将指针移到地图，或聚焦地图用方向键查看单元格。' : `网格 (${currentCell % displayResolution}, ${Math.floor(currentCell / displayResolution)})`}</Caption1>
        </div>
        {usable && !hasResults ? <div className={s.group}><LoadingRows rows={3} label="正在加载热力图数据…" /></div> : null}
        {displayEnabled.map(layer => {
          const state = states[layer];
          if (!usable) return null;
          if (!state || state.status === 'loading') return null;
          if (state.status === 'error') return <div className={s.group} key={layer} role="status"><Body1>{labels[layer]}：{state.message}</Body1><Button onClick={() => setRetry(old => old + 1)}>重试</Button></div>;
          return <HeatmapLayerDetails key={layer} layer={layer} projection={state.projection} cellIndex={currentCell} />;
        })}
        <div className={s.group}><Caption1 className={s.muted}>展示 DEM 记录中的采样位置或精确事件位置分布，不代表连续停留时间、视线、掩体、可见性或战术收益。地图版本未确认，不能宣称与当前游戏地图精确配准。</Caption1>
          {map && map.layers.length > 1 && (hasResults ? results.scope : scope).floor === null ? <Caption1>全部楼层合并统计，底图为主层；请选单层查看。未知 Z 和边界歧义保留原统计语义。</Caption1> : null}
        </div>
      </aside>
    </div>
  </section>;
}

/** Read-only DTO presentation, also exercised with empty and partial evidence fixtures. */
export function HeatmapLayerDetails({ layer, projection: p, cellIndex }: { layer: HeatmapLayer; projection: MapHeatmapProjection; cellIndex: number | null }) {
  const s = useStyles(), grid = p[layer]!.grid, cell = cellIndex === null ? null : grid.cells[cellIndex];
  return <div className={s.group} data-heatmap-stats={layer}>
            <Body1 style={{ color: palette.heatmap[layer] }}>{labels[layer]}</Body1>
            {layer === 'positions' && p.positions ? <>
              {!p.positions.available ? <Caption1>{heatmapReason(p.positions.unavailableReason)}</Caption1> : null}
              <Caption1>当前所选有效位置采样：{grid.validPositionSamples}</Caption1>
              <Caption1>阵营与楼层筛选前有效采样：{p.positions.observations.validPositionSamples}</Caption1>
              <Caption1>位置覆盖率：{ratio(p.positions.observations.positionCoverage)}</Caption1>
              <Caption1>位置完整度：{ratio(p.positions.observations.positionCompleteness)}</Caption1>
              <Caption1>筛选后位置覆盖率：{ratio(p.positions.selectedPositionCoverage)}</Caption1>
              <Caption1>采样机会分母：{p.positions.observations.expectedOpportunities}；已确认死亡 {p.positions.observations.confirmedDeadObservations}；观测但不可用 {p.positions.observations.observedButUnusable}；缺位置 {p.positions.observations.missingPositionObservations}；未知阵营 {p.positions.sideUnknownObservations}；其他阵营 {p.positions.otherSideValidSamples}</Caption1>
              <Caption1>覆盖率 = 有效位置 / 采样机会；完整度 = 已观测 / 采样机会；筛选后覆盖率沿用同一机会分母。位置覆盖率表示获得有效位置的采样机会比例，不代表玩家在场上的时间比例。</Caption1>
            </> : (() => { const events = layer === 'kills' ? p.kills! : p.deaths!; return <>
              <Caption1>成功定位 / 楼层筛选前事件：{events.locatableEvents} / {events.scopeEvents}</Caption1><Caption1>事件位置覆盖率（楼层筛选前）：{ratio(events.eventPositionCoverage)}</Caption1>
              <Caption1>楼层只筛选网格，以上事件数与覆盖率保留楼层筛选前范围。所选楼层的聚合结果见网格计数及楼层排除计数。</Caption1>
              {events.scopeEvents === 0 ? <Caption1>当前筛选范围内没有可统计事件</Caption1> : null}
              {Object.entries(events.unlocatableReasons).filter(([, n]) => n > 0).map(([reason, n]) => <Caption1 key={reason}>{failureLabels[reason]}：{n}</Caption1>)}
              <Caption1>窗口外 {events.outsideWindowEvents}；未知阵营 {events.unknownSideEvents}；其他阵营 {events.otherSideEvents}；玩家筛选排除未知主体 {events.unknownSubjectExcludedByPlayerFilter}</Caption1>
            </>; })()}
            <Caption1>网格计数：{grid.aggregatedSamples}；最高单元格：{grid.maxCellSampleCount}</Caption1>
            <Caption1>当前单元格计数：{cell?.cellSampleCount ?? '—'}；相对强度：{ratio(cell?.intensity)}</Caption1>
            {grid.status === 'empty' ? <Caption1>无可聚合数据</Caption1> : null}
            <Caption1>地图越界 {grid.outOfBounds}；映射无效 {grid.invalidMapping}；未知或歧义楼层 {grid.unknownLayer}；其他楼层 {grid.otherFloor}</Caption1>
            {p.excludedRounds.length || p.rosterApproximateRounds.length || p.freezeBoundaryUnknownRounds.length ? <Caption1>排除回合：{p.excludedRounds.join(', ') || '无'}；近似名单回合：{p.rosterApproximateRounds.join(', ') || '无'}；冻结边界未知回合：{p.freezeBoundaryUnknownRounds.join(', ') || '无'}</Caption1> : null}
          </div>;
}
