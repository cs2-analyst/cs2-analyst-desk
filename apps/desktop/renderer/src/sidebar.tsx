import React from 'react';
import { TabList, Tab, Tooltip, makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { palette } from './theme';
import {
  AnalysisIcon, CollapseNavIcon, DeepReviewIcon, ExpandNavIcon, ImportIcon, ReplayIcon, ReportIcon, TimelineIcon,
} from './icons';
import type { IconProps } from './icons';

export type ViewId = 'report' | 'deep-review' | 'timeline' | 'analysis' | 'replay' | 'heatmap';

/** Sidebar geometry: the icon column stays on one vertical line in both states. */
const SIDEBAR_WIDTH = 212;
const SIDEBAR_COLLAPSED_WIDTH = 56;
const ICON_GUTTER = 18; // 18 + 20/2 = 28px icon centre in both expanded and collapsed states.

const useStyles = makeStyles({
  sidebar: {
    flexShrink: 0, width: `${SIDEBAR_WIDTH}px`, boxSizing: 'border-box',
    display: 'flex', flexDirection: 'column', minHeight: 0,
    backgroundColor: palette.pageTop, borderRight: `1px solid ${palette.rowDivider}`,
    transitionProperty: 'width', transitionDuration: '200ms', transitionTimingFunction: 'cubic-bezier(0.2, 0, 0, 1)',
    overflowX: 'hidden',
  },
  sidebarCollapsed: { width: `${SIDEBAR_COLLAPSED_WIDTH}px` },
  nav: { flex: 1, minHeight: 0, paddingTop: '8px', display: 'flex', flexDirection: 'column', gap: '2px' },
  tab: {
    width: '100%', justifyContent: 'flex-start',
    paddingLeft: `${ICON_GUTTER}px`, paddingRight: '12px', columnGap: '10px',
    height: '38px', flexShrink: 0,
  },
  tabCollapsed: {
    paddingRight: `${ICON_GUTTER}px`,
    '& .fui-Tab__content': { display: 'none' },
  },
  footer: {
    flexShrink: 0, display: 'flex', flexDirection: 'column', gap: '2px',
    padding: '8px 0 10px', borderTop: `1px solid ${palette.rowDivider}`,
  },
  footerButton: {
    appearance: 'none', background: 'transparent', border: 'none', margin: 0, font: 'inherit',
    boxSizing: 'border-box', width: '100%', minWidth: 0, height: '38px', cursor: 'pointer',
    display: 'flex', alignItems: 'center', columnGap: '10px',
    paddingLeft: `${ICON_GUTTER}px`, paddingRight: `${ICON_GUTTER}px`,
    color: tokens.colorNeutralForeground2, borderRadius: 0,
    ':hover': { backgroundColor: palette.cardHover, color: tokens.colorNeutralForeground1 },
    ':focus-visible': { outline: `1px solid ${palette.borderStrong}`, outlineOffset: '-2px' },
    ':disabled': { color: tokens.colorNeutralForegroundDisabled, cursor: 'default', backgroundColor: 'transparent' },
  },
  label: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
});

const items: { value: ViewId; label: string; icon: (props: IconProps) => React.ReactElement }[] = [
  { value: 'report', label: '比赛报告', icon: ReportIcon },
  { value: 'deep-review', label: '深度复盘', icon: DeepReviewIcon },
  { value: 'timeline', label: '回合时间线', icon: TimelineIcon },
  { value: 'analysis', label: '分析', icon: AnalysisIcon },
  { value: 'replay', label: '比赛回放', icon: ReplayIcon },
  { value: 'heatmap', label: '热力图', icon: AnalysisIcon },
];

/**
 * Desktop navigation rail. Report views are real Fluent Tabs (role="tab") so the
 * existing tab keyboard semantics and QA hooks (id / aria-selected / .fui-Tab__content)
 * are preserved; only the presentation moves from a horizontal bar to the rail.
 */
export function Sidebar({ reportReady, busy, collapsed, activeView, importLabel, onSelectView, onToggleCollapsed, onImport }: {
  reportReady: boolean;
  busy: boolean;
  collapsed: boolean;
  activeView: ViewId;
  importLabel: string;
  onSelectView: (view: ViewId) => void;
  onToggleCollapsed: () => void;
  onImport: () => void;
}) {
  const s = useStyles();
  return <nav className={mergeClasses(s.sidebar, collapsed && s.sidebarCollapsed)} aria-label="主导航"
    data-app-sidebar data-collapsed={collapsed ? 'true' : 'false'}>
    <TabList vertical appearance="subtle" className={s.nav} selectedValue={reportReady ? activeView : ''}
      onTabSelect={(_, data) => onSelectView(String(data.value) as ViewId)}>
      {items.map(item => {
        const tab = <Tab key={item.value} id={`${item.value}-tab`} value={item.value} aria-controls={`${item.value}-panel`}
          icon={<item.icon size={20} />} disabled={!reportReady}
          className={mergeClasses(s.tab, collapsed && s.tabCollapsed)}>{item.label}</Tab>;
        return collapsed
          ? <Tooltip key={item.value} content={item.label} relationship="label" positioning="after">{tab}</Tooltip>
          : tab;
      })}
    </TabList>
    <div className={s.footer}>
      <Tooltip content={importLabel} relationship="description" positioning="after">
      <button type="button" className={s.footerButton} data-sidebar-import aria-label={importLabel} disabled={busy} onClick={onImport}>
        <ImportIcon size={20} />
        {collapsed ? null : <span className={s.label}>{importLabel}</span>}
      </button>
      </Tooltip>
      <button type="button" className={s.footerButton} data-sidebar-toggle onClick={onToggleCollapsed}
        aria-label={collapsed ? '展开导航' : '收起导航'} aria-expanded={!collapsed}>
        {collapsed ? <ExpandNavIcon size={20} /> : <CollapseNavIcon size={20} />}
        {collapsed ? null : <span className={s.label}>收起导航</span>}
      </button>
    </div>
  </nav>;
}
