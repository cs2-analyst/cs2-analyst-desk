import React from 'react';

/**
 * Single-style icon set for the report page chrome: one 20px grid, monochrome
 * `currentColor` outlines, no mixed filled/outlined variants. Drawings are kept
 * local so the renderer never mixes unrelated icon sources.
 *
 * 道具面板的彩色实心图标是刻意区分的第二套风格，单独放在 `utility-icons.tsx`。
 */
export type IconProps = { size?: number; className?: string };

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.4,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

function Icon({ size = 20, className, children }: IconProps & { children: React.ReactNode }) {
  return <svg className={className} width={size} height={size} viewBox="0 0 20 20"
    aria-hidden="true" focusable="false" {...stroke}>{children}</svg>;
}

/** 帮助入口：问号。 */
export function QuestionCircleIcon(props: IconProps) {
  return <Icon {...props}>
    <circle cx="10" cy="10" r="7" />
    <path d="M8 7.9a2 2 0 1 1 2.8 1.85c-.6.28-.8.7-.8 1.35v.3" />
    <circle cx="10" cy="14" r=".55" fill="currentColor" stroke="none" />
  </Icon>;
}

/** 侧边栏导航：比赛报告（文档）。 */
export function ReportIcon(props: IconProps) {
  return <Icon {...props}>
    <rect x="4.5" y="3" width="11" height="14" rx="1.5" />
    <path d="M7.5 7h5M7.5 10h5M7.5 13h3" />
  </Icon>;
}

/** 侧边栏导航：深度复盘（放大镜）。 */
export function DeepReviewIcon(props: IconProps) {
  return <Icon {...props}>
    <circle cx="9" cy="9" r="5" />
    <path d="M12.8 12.8 16 16" />
    <path d="M7 9.4 8.6 7.8 10.4 10.2" />
  </Icon>;
}

/** 侧边栏导航：回合时间线（节点列表）。 */
export function TimelineIcon(props: IconProps) {
  return <Icon {...props}>
    <circle cx="5.5" cy="4.5" r="1.5" />
    <circle cx="5.5" cy="10" r="1.5" />
    <circle cx="5.5" cy="15.5" r="1.5" />
    <path d="M9.5 4.5H16M9.5 10H16M9.5 15.5H16" />
  </Icon>;
}

/** 道具伤害统计：交叉双刀（本地最小图形，不新增资源或依赖）。 */
export function CrossedSwordsIcon(props: IconProps) {
  return <Icon {...props}>
    <path d="M4.2 15.6 15.4 4.4M15.8 15.6 4.6 4.4" />
    <path d="M13.3 4.4h2.1v2.1M6.7 4.4H4.6v2.1" />
    <path d="m3.2 13.3 3.5 3.5M16.8 13.3l-3.5 3.5" />
  </Icon>;
}

/** 侧边栏导航：分析（柱状图）。 */
export function AnalysisIcon(props: IconProps) {
  return <Icon {...props}>
    <path d="M3.5 3.5v13h13" />
    <path d="M7.5 12.5v-3M11 12.5V8.5M14.5 12.5V6" />
  </Icon>;
}

/** 回放：播放（播放三角，单色线稿）。 */
export function PlayIcon(props: IconProps) {
  return <Icon {...props}>
    <path d="M7 4.6 15 10 7 15.4V4.6Z" />
  </Icon>;
}

/** 回放：暂停（两条竖线，与播放图标同网格）。 */
export function PauseIcon(props: IconProps) {
  return <Icon {...props}>
    <path d="M7.5 5v10M12.5 5v10" />
  </Icon>;
}

/** 回放控制：回合起止与相对跳转，保持本地图标的 20px 网格。 */
export function ReplayStartIcon(props: IconProps) {
  return <Icon {...props}><path d="M5 5v10M14.5 5 7.5 10l7 5V5Z" /></Icon>;
}

export function ReplayEndIcon(props: IconProps) {
  return <Icon {...props}><path d="M15 5v10M5.5 5l7 5-7 5V5Z" /></Icon>;
}

export function ReplayRewindIcon(props: IconProps) {
  return <Icon {...props}><path d="m8 4-4 3 4 3M4 7h7a5 5 0 1 1-4.5 7" /></Icon>;
}

export function ReplayForwardIcon(props: IconProps) {
  return <Icon {...props}><path d="m12 4 4 3-4 3M16 7H9a5 5 0 1 0 4.5 7" /></Icon>;
}

/** 侧边栏导航：比赛回放（折叠地图）。 */
export function ReplayIcon(props: IconProps) {
  return <Icon {...props}>
    <path d="M7 4.2 3.2 5.6v9.8L7 14l6 1.4 3.8-1.4V4.2L13 5.6 7 4.2Z" />
    <path d="M7 4.2V14M13 5.6v9.8" />
  </Icon>;
}

/** 比赛记录：打开（外链箭头）。 */
export function OpenIcon(props: IconProps) {
  return <Icon {...props}>
    <path d="M4 6.5v8A1.5 1.5 0 0 0 5.5 16h8a1.5 1.5 0 0 0 1.5-1.5V10" />
    <path d="M9.5 4H16v6.5M15.8 4.2 8.5 11.5" />
  </Icon>;
}

/** 比赛记录：导出（箭头离开托盘）。 */
export function ExportIcon(props: IconProps) {
  return <Icon {...props}>
    <path d="M10 12.5V3.8M6.9 6.9 10 3.8l3.1 3.1" />
    <path d="M4 12.8v2.2a1.5 1.5 0 0 0 1.5 1.5h9a1.5 1.5 0 0 0 1.5-1.5v-2.2" />
  </Icon>;
}

/** 比赛记录：删除（垃圾桶）。 */
export function DeleteIcon(props: IconProps) {
  return <Icon {...props}>
    <path d="M4.5 6h11M8 6V4.6h4V6" />
    <path d="m6.1 6 .7 9.1a1.5 1.5 0 0 0 1.5 1.4h3.4a1.5 1.5 0 0 0 1.5-1.4L14 6" />
    <path d="M8.6 9v4.6M11.4 9v4.6" />
  </Icon>;
}

/** 首页与侧边栏底栏：导入 DEM（箭头落入托盘）。 */
export function ImportIcon(props: IconProps) {
  return <Icon {...props}>
    <path d="M10 3.5v7.4M6.9 8.3 10 11.4l3.1-3.1" />
    <path d="M4 12.8v2.2a1.5 1.5 0 0 0 1.5 1.5h9a1.5 1.5 0 0 0 1.5-1.5v-2.2" />
  </Icon>;
}

/** 侧边栏：收起（双尖括号向左）。 */
export function CollapseNavIcon(props: IconProps) {
  return <Icon {...props}>
    <path d="M9.2 5 4.7 10l4.5 5" />
    <path d="M14.8 5l-4.5 5 4.5 5" />
  </Icon>;
}

/** 侧边栏：展开（双尖括号向右）。 */
export function ExpandNavIcon(props: IconProps) {
  return <Icon {...props}>
    <path d="M5.2 5l4.5 5-4.5 5" />
    <path d="M10.8 5l4.5 5-4.5 5" />
  </Icon>;
}
/** 全局侧栏：个人数据（单人）。 */
export function PersonalIcon(props: IconProps) {
  return <Icon {...props}>
    <circle cx="10" cy="6.4" r="2.9" />
    <path d="M4.4 16.2c.4-3 2.6-4.6 5.6-4.6s5.2 1.6 5.6 4.6" />
  </Icon>;
}

/** 全局侧栏：比赛数据（本地比赛库）。 */
export function LibraryIcon(props: IconProps) {
  return <Icon {...props}>
    <path d="M4 5.4h12v10.2H4z" />
    <path d="M4 8.4h12M7.2 5.4v10.2" />
  </Icon>;
}

/** 标题栏：后退。 */
export function BackIcon(props: IconProps) {
  return <Icon {...props}><path d="M15.5 10h-11M9 4.8 3.8 10 9 15.2" /></Icon>;
}

/** 标题栏：首页（比赛数据），沿用本地单色线稿。 */
export function HomeIcon(props: IconProps) {
  return <Icon {...props}>
    <path d="M3.2 9.4 10 3.8l6.8 5.6M5 8.2v8h10v-8M8 16.2v-5.2h4v5.2" />
  </Icon>;
}

/** 标题栏：前进。 */
export function ForwardIcon(props: IconProps) {
  return <Icon {...props}><path d="M4.5 10h11M11 4.8l5.2 5.2-5.2 5.2" /></Icon>;
}

/** 列表行：更多操作。 */
export function MoreIcon(props: IconProps) {
  return <Icon {...props}>{[4.5, 10, 15.5].map(cx =>
    <circle key={cx} cx={cx} cy="10" r="1.2" fill="currentColor" stroke="none" />)}</Icon>;
}
