import React from 'react';
import { Caption1, Tooltip, makeStyles, tokens } from '@fluentui/react-components';
import type { DesktopPlayerHighlight, DesktopPlayerRating } from '@cs2-analyst/report-contract';
import { palette } from './theme';

const useStyles = makeStyles({
  rating: { fontWeight: 700, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', ':focus-visible': { outline: `1px solid ${tokens.colorBrandStroke1}` } },
  tags: { display: 'flex', flexWrap: 'wrap', gap: '4px', alignItems: 'center', justifyContent: 'center', padding: '4px 0' },
  tag: { width: '20px', height: '20px', flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: '2px', fontSize: '12px', fontWeight: 800, lineHeight: '20px', color: '#101821' },
  meta: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px', minWidth: 0 },
  file: { display: 'block', minWidth: 0, flex: '1 1 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: tokens.colorNeutralForeground3 },
  prominent: { flexShrink: 0, fontSize: '16px', lineHeight: '22px' },
});

export const formatMetric = (value: number | null | undefined, digits: number): string =>
  typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '—';
export const formatKast = (value: number | null | undefined): string =>
  typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(1)}%` : '—';
export function formatRating(rating?: DesktopPlayerRating): string {
  return rating?.status === 'available' ? formatMetric(rating.value, 2) : '—';
}

/** Display bands only; these never alter the stored number or award a highlight. */
export function RatingValue({ rating, prefix = false }: { rating?: DesktopPlayerRating; prefix?: boolean }) {
  const s = useStyles();
  const text = formatRating(rating);
  const value = text === '—' ? null : rating!.value;
  const color = value === null ? palette.textMuted : value >= 1.1 ? palette.performance.strong : value < 0.9 ? palette.performance.weak : palette.text;
  const tip = value === null ? `评分不可用：${rating?.reason || '缺少该玩家的必要分析输入。'}`
    : 'HLTV Rating 2.0 社区近似评分，非官方精确结果。';
  return <Tooltip content={tip} relationship="description"><span className={s.rating} style={{ color }} tabIndex={0}
    data-rating-value={text} data-rating-algorithm={rating?.algorithm}>{prefix ? 'Rating: ' : ''}{text}</span></Tooltip>;
}

const tagColors: Record<DesktopPlayerHighlight['color'], string> = {
  gold: '#e2b751', cyan: '#49c9cf', blue: '#76a7ee', pink: '#ed80bd',
  green: '#a7d58b', yellow: '#e3d65c', purple: '#b29bea', orange: '#eaa76b',
};
export function HighlightTags({ highlights }: { highlights?: DesktopPlayerHighlight[] }) {
  const s = useStyles();
  return highlights?.length ? <div className={s.tags} data-highlight-tags>{highlights.map(tag =>
    <Tooltip key={tag.type} content={tag.tooltip} relationship="description"><span className={s.tag} tabIndex={0}
      data-highlight={tag.type} aria-label={tag.tooltip} style={{ backgroundColor: tagColors[tag.color] }}>{tag.label}</span></Tooltip>)}</div> : <span data-highlight-empty>—</span>;
}

/** Optional filename and rating share the same bounded row at every window width. */
export function ReportSecondaryLine({ fileName, rating }: { fileName?: string; rating?: DesktopPlayerRating }) {
  const s = useStyles();
  return <div className={s.meta} data-report-secondary>
    {fileName ? <Tooltip content={fileName} relationship="description"><Caption1 className={s.file} tabIndex={0} data-report-filename>{fileName}</Caption1></Tooltip> : null}
    <span className={s.prominent}><RatingValue rating={rating} prefix /></span>
  </div>;
}
