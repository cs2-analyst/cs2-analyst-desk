import { Fragment, useState } from 'react';
import { Badge, Body1, Card, Caption1, Subtitle1, Tab, TabList, Tooltip, makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import type { DesktopAnalysisViews, DesktopPlayerAnalysis } from '@cs2-analyst/report-contract';
import { comparisonMetrics, comparisonValue, comparisonIncomplete, sortedComparison } from './analysis-metrics';
import type { ComparisonMetricKey } from './analysis-metrics';
import { palette } from './theme';
import { WinSelect } from './winui-select';

const useStyles = makeStyles({
  section: { display: 'flex', flexDirection: 'column', gap: '12px', height: '100%', minHeight: 0, overflow: 'hidden' },
  tabs: { flexShrink: 0 },
  tabViewport: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' },
  tabPanel: {
    flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: '16px',
    overflowY: 'auto', overflowX: 'hidden', paddingRight: '4px',
    '&[hidden]': { display: 'none' },
  },
  panel: { flexShrink: 0, backgroundColor: palette.card, border: `1px solid ${palette.border}`, borderRadius: tokens.borderRadiusLarge, boxShadow: 'none', padding: '20px', gap: '16px' },
  heading: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '16px', flexWrap: 'wrap' },
  column: { display: 'flex', flexDirection: 'column', gap: '6px' },
  muted: { color: tokens.colorNeutralForeground3 },
  rows: { display: 'flex', flexDirection: 'column', gap: '6px' },
  row: { display: 'grid', gridTemplateColumns: 'minmax(100px, 200px) minmax(40px, 1fr) 132px', alignItems: 'center', gap: '16px', minHeight: '34px', borderRadius: tokens.borderRadiusMedium, ':focus-visible': { outline: `2px solid ${tokens.colorBrandStroke1}` }, '@media (max-width: 650px)': { gridTemplateColumns: 'minmax(85px, 120px) minmax(20px, 1fr) 100px', gap: '8px' } },
  name: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  track: { height: '12px', backgroundColor: palette.pageTop, borderRadius: '2px', overflow: 'hidden' },
  bar: { height: '100%', backgroundColor: palette.textMuted, borderRadius: '2px' },
  currentBar: { backgroundColor: palette.currentPlayer },
  currentName: { color: palette.currentPlayer },
  trendFooter: { display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', columnGap: '48px', rowGap: '12px' },
  multiKills: { display: 'flex', flexWrap: 'wrap', gap: '16px', fontVariantNumeric: 'tabular-nums' },
  number: { textAlign: 'right', fontVariantNumeric: 'tabular-nums' },
  scroll: { overflowX: 'auto' },
  trend: { display: 'flex', gap: '6px', alignItems: 'stretch', minWidth: '680px', paddingTop: '8px' },
  round: { flex: '1 0 22px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px', borderRadius: tokens.borderRadiusMedium, ':focus-visible': { outline: `2px solid ${tokens.colorBrandStroke1}` } },
  roundTrack: { height: '144px', width: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', alignItems: 'center', borderBottom: `1px solid ${palette.borderStrong}`, backgroundColor: palette.pageTop },
  roundBar: { width: '68%', backgroundColor: tokens.colorBrandBackground, borderTopLeftRadius: '2px', borderTopRightRadius: '2px' },
  sides: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 1px minmax(0, 1fr)', gap: '20px', '@media (max-width: 650px)': { gridTemplateColumns: '1fr' } },
  sideDivider: { backgroundColor: palette.rowDivider, marginTop: '16px', marginBottom: '16px', '@media (max-width: 650px)': { display: 'none' } },
  side: { display: 'flex', flexDirection: 'column', gap: '12px' },
  stat: { display: 'flex', justifyContent: 'space-between', gap: '16px', padding: '8px 0', borderBottom: `1px solid ${palette.rowDivider}` },
  empty: { flex: 1, minHeight: '180px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '8px', padding: '32px 16px', textAlign: 'center' },
});

const resultLabel = { win: '成功', loss: '失败', unknown: '结果未知' } as const;
const resultColor = { win: 'success', loss: 'danger', unknown: 'warning' } as const;
const partialEvidence = '当前 DEM 的相关证据不完整，该数值可能不代表完整比赛。';

const analysisTabs = [
  { value: 'comparison', label: '全场玩家对比' },
  { value: 'trend', label: '回合表现趋势' },
  { value: 'sides', label: 'CT / T 表现对比' },
] as const;
type AnalysisTabKey = typeof analysisTabs[number]['value'];

function NoPlayerData({ title }: { title: string }) {
  const s = useStyles();
  return <div className={s.empty}>
    <Body1>{title}</Body1>
    <Caption1 className={s.muted}>仍可切换其他选项卡，或从右上角选择另一名玩家。</Caption1>
  </div>;
}

function RoundTrend({ player }: { player: DesktopPlayerAnalysis }) {
  const s = useStyles();
  const maxKills = Math.max(1, ...player.roundTrend.filter(r => r.complete).map(r => r.kills));
  const multiKills = ([['double', '双杀'], ['triple', '三杀'], ['quad', '四杀'], ['fivePlus', '五杀+']] as const)
    .filter(([key]) => player.multiKills[key] > 0);
  return <Card className={s.panel} aria-label="回合表现趋势">
    <Caption1 className={s.muted}>每回合击杀数 · 独立回合，柱高按击杀数缩放 · 阵亡与胜负见标签或提示</Caption1>
    <div className={s.scroll}><div className={s.trend} role="list" aria-label="每回合击杀数">
      {player.roundTrend.map(r => {
        const side = r.side === 'Unknown' ? '阵营未知' : r.side;
        const detail = `R${r.round} · ${side} · ${resultLabel[r.result]} · ${r.complete ? `${r.kills} 击杀 · ${r.died ? '阵亡' : '未阵亡'}` : '回合窗口证据不足，击杀与死亡不可用'}`;
        return <Tooltip key={r.round} content={detail} relationship="description">
          <div role="listitem" tabIndex={0} className={s.round} aria-label={detail} data-trend-round={r.round}>
            <div className={s.roundTrack} aria-hidden="true">
              <Caption1>{r.complete ? r.kills : '—'}</Caption1>
              {r.complete ? <div className={s.roundBar} style={{ height: `${r.kills / maxKills * 112}px` }} /> : null}
            </div>
            <Caption1>R{r.round}</Caption1>
            <Badge size="small" appearance="tint" color={resultColor[r.result]}>{r.result === 'win' ? '胜' : r.result === 'loss' ? '负' : '?'}</Badge>
            <Caption1 className={s.muted}>{r.complete ? r.died ? '亡' : '存' : '—'}</Caption1>
          </div>
        </Tooltip>;
      })}
    </div></div>
    <div className={s.trendFooter}>
      <Caption1 className={s.muted}>亡：阵亡 · 存：未阵亡 · —：回合窗口证据不足</Caption1>
      {multiKills.length ? <div className={s.multiKills} aria-label="多杀回合统计">{multiKills.map(([key, label]) =>
        <Caption1 key={key} data-multi-kill={key}>{label} {player.multiKills[key]}</Caption1>)}</div> : null}
    </div>
  </Card>;
}

function SideComparison({ player }: { player: DesktopPlayerAnalysis }) {
  const s = useStyles();
  return <Card className={s.panel} aria-label="CT / T 表现对比">
    <Caption1 className={s.muted}>当前目标玩家 · ADR 为每回合平均有效伤害</Caption1>
    <div className={s.sides}>{(['CT', 'T'] as const).map(side => {
      const p = player.sideSplit[side];
      return <Fragment key={side}>{side === 'T' ? <div className={s.sideDivider} data-side-divider aria-hidden="true" /> : null}<div className={s.side} data-analysis-side={side}>
        <Subtitle1>{side}</Subtitle1>
        <div className={s.stat}><Body1>回合</Body1><Body1 className={s.number}>{p.roundsPlayed}</Body1></div>
        <div className={s.stat}><Body1>K / D / A</Body1><Body1 className={s.number}>{p.kills} / {p.deaths} / {p.assists}</Body1></div>
        <div className={s.stat}><Body1>ADR</Body1><Body1 className={s.number}>{p.adr === null ? '—' : p.adr.toFixed(2)}</Body1></div>
        {p.adr === null ? <Caption1 className={s.muted}>ADR 证据不足或该阵营无已确认参与回合。</Caption1> : null}
      </div></Fragment>;
    })}</div>
  </Card>;
}

export function AnalysisViews({ analysis, playerId }: { analysis: DesktopAnalysisViews; playerId: string }) {
  const s = useStyles();
  const [activeTab, setActiveTab] = useState<AnalysisTabKey>('comparison');
  const [metricKey, setMetricKey] = useState<ComparisonMetricKey>('adr');
  const metric = comparisonMetrics.find(m => m.key === metricKey)!;
  const players = sortedComparison(analysis.players, metricKey);
  const max = Math.max(1, ...players.map(p => p[metricKey] ?? 0));
  const player = analysis.perPlayer.find(p => p.playerId === playerId);
  return <section className={s.section} aria-label="分析视图" data-analysis-view>
    <TabList className={s.tabs} aria-label="分析视图分区" selectedValue={activeTab}
      onTabSelect={(_, data) => setActiveTab(data.value as AnalysisTabKey)}>
      {analysisTabs.map(tab => <Tab key={tab.value} value={tab.value} id={`analysis-view-tab-${tab.value}`} aria-controls={`analysis-view-panel-${tab.value}`} data-analysis-tab={tab.value}>{tab.label}</Tab>)}
    </TabList>
    <div className={s.tabViewport}>
      <div id="analysis-view-panel-comparison" role="tabpanel" aria-labelledby="analysis-view-tab-comparison"
        className={s.tabPanel} hidden={activeTab !== 'comparison'} data-analysis-panel="comparison">
        <Card className={s.panel} aria-label="全场玩家对比">
          <div className={s.heading}>
            <Caption1 className={s.muted}>比较本场 {players.length} 名玩家的确定性指标</Caption1>
            <div className={s.column}><Caption1>指标</Caption1><WinSelect aria-label="对比指标" value={metricKey}
              items={comparisonMetrics.map(m => ({ value: m.key, text: m.label }))}
              onValueChange={value => setMetricKey(value as ComparisonMetricKey)} /></div>
          </div>
          {players.length ? <>
            <div className={s.rows} role="list" aria-label={`${metric.label} 玩家对比`}>
              {players.map(p => {
                const value = p[metricKey];
                const incomplete = comparisonIncomplete(p, metricKey);
                const name = `${p.playerName}${p.playerId === playerId ? ' · 当前' : ''}`;
                const formatted = comparisonValue(p, metric);
                const detail = `${name} · ${metric.label} ${formatted}${value === null ? ' · 证据不足或无适用样本' : ''}${incomplete ? ` · 部分证据：${partialEvidence}` : ''}`;
                return <Tooltip key={p.playerId} content={detail} relationship="description">
                  <div role="listitem" tabIndex={0} className={s.row} aria-label={detail} data-comparison-player={p.playerId} data-metric-value={value === null ? 'null' : value}>
                    <Body1 className={mergeClasses(s.name, p.playerId === playerId && s.currentName)}>{name}</Body1>
                    <div className={s.track} aria-hidden="true">{value !== null ? <div className={mergeClasses(s.bar, p.playerId === playerId && s.currentBar)} style={{ width: `${value / max * 100}%` }} /> : null}</div>
                    <div className={s.number}><Body1>{formatted}</Body1>{incomplete ? <div><Caption1 className={s.muted}>部分证据</Caption1></div> : null}</div>
                  </div>
                </Tooltip>;
              })}
            </div>
            <Caption1 className={s.muted}>按所选指标降序 · — 表示证据不足或无适用样本 · 悬停或键盘聚焦查看详情</Caption1>
          </> : <NoPlayerData title="这场没有可用的玩家对比数据。" />}
        </Card>
      </div>
      <div id="analysis-view-panel-trend" role="tabpanel" aria-labelledby="analysis-view-tab-trend"
        className={s.tabPanel} hidden={activeTab !== 'trend'} data-analysis-panel="trend">
        {player ? <RoundTrend player={player} /> : <NoPlayerData title="当前玩家没有可用的回合趋势数据。" />}
      </div>
      <div id="analysis-view-panel-sides" role="tabpanel" aria-labelledby="analysis-view-tab-sides"
        className={s.tabPanel} hidden={activeTab !== 'sides'} data-analysis-panel="sides">
        {player ? <SideComparison player={player} /> : <NoPlayerData title="当前玩家没有可用的 CT / T 对比数据。" />}
      </div>
    </div>
  </section>;
}
