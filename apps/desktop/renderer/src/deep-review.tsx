import { useState } from 'react';
import { Badge, Body1, Button, Card, Caption1, Subtitle1, Tab, TabList, Title2, Tooltip, makeStyles, tokens } from '@fluentui/react-components';
import type { DesktopDeepReviewPlayer } from '@cs2-analyst/report-contract';
import { QuestionCircleIcon } from './icons';
import { palette } from './theme';
import { DismissibleMessageBar } from './dismissible-message-bar';

export const DEEP_REVIEW_HELP = '根据 DEM 中能够明确记录的交火、人数变化、队友跟进和道具效果生成。';
export const DEEP_REVIEW_PARTIAL_HELP = '这场录像中有部分记录无法完整判断，具体限制可在每张卡片的「说明与限制」中查看。';
const DEEP_REVIEW_UNAVAILABLE = '本场录像无法用于深度复盘，基础比赛报告仍可查看。';

const useStyles = makeStyles({
  section: { display: 'flex', flexDirection: 'column', gap: '12px', height: '100%', minHeight: 0, overflow: 'hidden' },
  header: { flexShrink: 0, display: 'flex', flexDirection: 'column', gap: '8px' },
  titleRow: { display: 'flex', alignItems: 'center', gap: '2px' },
  help: {
    color: tokens.colorNeutralForeground3, flexShrink: 0, minWidth: 0,
    ':hover': { color: tokens.colorNeutralForeground1 },
    ':focus-visible': { color: tokens.colorNeutralForeground1 },
  },
  partialHelp: {
    color: tokens.colorPaletteYellowForeground1, flexShrink: 0, minWidth: 0,
    ':hover': { color: tokens.colorPaletteYellowForeground2 },
    ':focus-visible': { color: tokens.colorPaletteYellowForeground2 },
  },
  tabs: { flexShrink: 0 },
  tabViewport: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' },
  tabPanel: {
    flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column',
    overflowY: 'auto', overflowX: 'hidden', paddingRight: '4px',
    '&[hidden]': { display: 'none' },
  },
  cards: { display: 'flex', flexDirection: 'column', gap: '12px', paddingBottom: '4px' },
  card: { flexShrink: 0, backgroundColor: palette.card, border: `1px solid ${palette.border}`, borderRadius: tokens.borderRadiusLarge,
    boxShadow: 'none', padding: '20px', display: 'flex', flexDirection: 'column', gap: '12px', overflowWrap: 'anywhere' },
  badges: { display: 'flex', flexWrap: 'wrap', gap: '8px' },
  muted: { color: tokens.colorNeutralForeground3 },
  summary: { cursor: 'pointer', padding: '4px', borderRadius: tokens.borderRadiusMedium,
    ':hover': { backgroundColor: palette.cardHover },
    ':focus-visible': { outline: `2px solid ${tokens.colorBrandStroke1}`, outlineOffset: '2px' } },
  caveats: { display: 'flex', flexDirection: 'column', gap: '8px', paddingTop: '8px' },
  empty: {
    flex: 1, minHeight: '180px', display: 'flex', flexDirection: 'column', alignItems: 'center',
    justifyContent: 'center', gap: '8px', padding: '32px 16px', textAlign: 'center',
  },
  emptyGlyph: { color: tokens.colorNeutralForeground3 },
});

const groups = [
  { key: 'reviews', title: '优先复盘', label: '复盘重点', color: 'warning' },
  { key: 'highlights', title: '亮点', label: '亮点', color: 'success' },
  { key: 'contexts', title: '补充观察', label: '补充观察', color: 'informative' },
] as const;
type DeepTabKey = typeof groups[number]['key'];

const emptyCopy: Record<DeepTabKey, string> = {
  reviews: '这场暂时没有需要重点复盘的地方，先把好状态保持住。',
  highlights: '高光可能在路上，这场还没有足够证据点亮它。',
  contexts: '观察哨今天很安静，没有额外值得补充的记录。',
};

/** Small local line icons keep the empty states in the same 20px visual language as the app chrome. */
function EmptyGlyph({ kind }: { kind: DeepTabKey }) {
  const s = useStyles();
  return <svg className={s.emptyGlyph} width="28" height="28" viewBox="0 0 20 20" aria-hidden="true" focusable="false"
    fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round">
    {kind === 'reviews' ? <>
      <circle cx="8.6" cy="8.6" r="4.9" />
      <path d="m12.2 12.2 3.2 3.2M6.4 8.6h4.4M8.6 6.4v4.4" />
    </> : kind === 'highlights' ? <>
      <path d="M10 3.2 11.6 8l4.8 1.6-4.8 1.6L10 16l-1.6-4.8L3.6 9.6 8.4 8 10 3.2Z" />
      <path d="M15.5 3.2v2.2M16.6 4.3h-2.2M4.5 14.6v2.2M5.6 15.7H3.4" />
    </> : <>
      <path d="M2.6 10s2.7-4.4 7.4-4.4 7.4 4.4 7.4 4.4-2.7 4.4-7.4 4.4S2.6 10 2.6 10Z" />
      <circle cx="10" cy="10" r="1.9" />
    </>}
  </svg>;
}

function WarningIcon() {
  return <svg width="16" height="16" viewBox="0 0 20 20" aria-hidden="true" focusable="false"
    fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
    <path d="M10 3.2 17.2 16H2.8L10 3.2Z" />
    <path d="M10 7.4v4.2" />
    <circle cx="10" cy="14.1" r=".55" fill="currentColor" stroke="none" />
  </svg>;
}

/** All copy/counts/rounds are supplied by the presenter. No evidence inference here. */
export function DeepReview({ player, onShowRounds, onReplayRound, active = true }: {
  player: DesktopDeepReviewPlayer; onShowRounds: (rounds: number[]) => void;
  active?: boolean;
  onReplayRound?: (round:number)=>void;
}) {
  const s = useStyles();
  const [activeTab, setActiveTab] = useState<DeepTabKey>('reviews');
  const unavailable = player.coverage.status === 'unavailable';
  const partial = player.coverage.status === 'partial';
  return <section className={s.section} aria-label="深度复盘" data-deep-player={player.playerId}>
    <div className={s.header}>
      <div className={s.titleRow}>
        <Title2>深度复盘</Title2>
        <Tooltip content={DEEP_REVIEW_HELP} relationship="description" withArrow>
          <Button appearance="transparent" size="small" className={s.help} icon={<QuestionCircleIcon size={16} />}
            aria-label="深度复盘说明" data-deep-help />
        </Tooltip>
        {partial ? <Tooltip content={DEEP_REVIEW_PARTIAL_HELP} relationship="description" withArrow>
          <Button appearance="transparent" size="small" className={s.partialHelp} icon={<WarningIcon />}
            aria-label="部分记录限制说明" data-deep-partial-help />
        </Tooltip> : null}
      </div>
      {unavailable && active ? <DismissibleMessageBar intent="error" data-deep-unavailable>{DEEP_REVIEW_UNAVAILABLE}</DismissibleMessageBar> : null}
    </div>
    <TabList className={s.tabs} aria-label="深度复盘分区" selectedValue={activeTab}
      onTabSelect={(_, data) => setActiveTab(data.value as DeepTabKey)}>
      {groups.map(group => <Tab key={group.key} value={group.key} id={`deep-review-group-tab-${group.key}`}
        aria-controls={`deep-review-group-panel-${group.key}`} data-deep-tab={group.key}>{group.title}</Tab>)}
    </TabList>
    <div className={s.tabViewport}>
      {groups.map(group => {
        const findings = player[group.key];
        return <div key={group.key} id={`deep-review-group-panel-${group.key}`} role="tabpanel"
          aria-labelledby={`deep-review-group-tab-${group.key}`} className={s.tabPanel}
          hidden={activeTab !== group.key} data-deep-panel={group.key}>
          {unavailable
            ? <div className={s.empty} data-deep-unavailable-panel={group.key}>
              <WarningIcon />
              <Body1>深度复盘数据不可用，暂时无法生成这类结论。</Body1>
              <Caption1 className={s.muted}>基础比赛报告仍可查看。</Caption1>
            </div>
            : findings.length
              ? <div className={s.cards}>
                {findings.map(f => <Card key={f.id} className={s.card} data-deep-kind={f.kind} data-deep-rule={f.ruleId}>
                  <div className={s.badges}>
                    <Badge appearance="tint" color={group.color} data-deep-label={f.kind}>{group.label}</Badge>
                  </div>
                  <Subtitle1>{f.title}</Subtitle1>
                  <Body1>{f.summary}</Body1>
                  {f.occurrenceLabel !== null ? <Caption1 className={s.muted}>{f.occurrenceLabel}</Caption1> : null}
                  {f.relatedRounds.length ? <div><Button appearance="subtle" size="small" data-deep-rounds={f.relatedRounds.join(',')}
                    onClick={() => onShowRounds(f.relatedRounds)}>
                    {f.relatedRounds.length === 1 ? `查看 R${f.relatedRounds[0]}` : `查看 ${f.relatedRounds.length} 个相关回合`}
                  </Button></div> : null}
                  {onReplayRound&&f.relatedRounds.length?<div><Button appearance="subtle" size="small" onClick={()=>onReplayRound(f.relatedRounds[0])}>比赛回放 R{f.relatedRounds[0]}</Button></div>:null}
                  {f.caveats.length ? <details><summary className={s.summary}>说明与限制</summary>
                    <div className={s.caveats}>{f.caveats.map((caveat, i) => <Body1 key={i} className={s.muted}>{caveat}</Body1>)}</div>
                  </details> : null}
                </Card>)}
              </div>
              : <div className={s.empty} data-deep-empty={group.key}>
                <EmptyGlyph kind={group.key} />
                <Body1>{emptyCopy[group.key]}</Body1>
              </div>}
        </div>;
      })}
    </div>
  </section>;
}
