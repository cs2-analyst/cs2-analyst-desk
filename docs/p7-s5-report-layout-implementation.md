# P7-S5 比赛报告 Layout A 实施与验收记录

> **状态：IMPLEMENTED / REAL ELECTRON ACCEPTANCE PASS（2026-10-18）。**
> 分支：`feat/p7-s5-report-layout-a`；基线：`318350bab9123c7ffc475e353ef4b2ed5eafbfc1`（origin/main）。
> 方案：冻结的方案 A —— 顶部八项 KPI + 下方左 Findings / 右道具与残局，左右栏目各自独立纵向滚动；报告视图本身不产生纵向页面滚动。
> 设计依据：[比赛报告无页面滚动布局](./p7-report-layout-options.md)。

## 1. 范围

本工作单元只改比赛报告页的布局、必要的测试与文档：

- `apps/desktop/renderer/src/main.tsx` 的报告专用 `makeStyles`、`Stat`、`Findings` 标题外置与报告 JSX；
- `scripts/report-ux-checks.mjs` 的 `checkReportLayout` 共享断言与裁剪探针更新；
- 新增 `scripts/p7-report-layout-acceptance.mjs` 真实 Electron 验收；
- 本文件与设计文档状态更新。

没有修改 Analytics / Findings 规则 / DEM 解析 / report-contract / Replay IPC / 版本号 / 打包配置；没有修改 `analysis-views.tsx`、`deep-review.tsx`、`sidebar.tsx`、`collapse-motion.css`。

## 2. 实现结构

```text
reportFrame (flex column, min-height 0)
  viewHeader（共享比赛信息 / 目标玩家，保持现状）
  reportPanel (flex:1; min-height:0; overflow:hidden)
    coverage MessageBar（如有；flex-shrink:0，位于 KPI 上方）
    reportKpiGrid（4 列 × 2 行；flex-shrink:0）
    reportColumns（flex:1; min-height:0; grid 3fr/2fr; 行 minmax(0,1fr)）
      left  section[aria-labelledby=简要分析]
        header（可见标题 + 原 Findings 说明 Tooltip）
        [data-report-column=findings] role=region tabindex=0 overflow-y:auto
          Findings（heading 外置，规则/证据/相关回合/回放行为不变）
      right section[aria-labelledby=道具与残局]
        header（可见标题）
        [data-report-column=utility] role=region tabindex=0 overflow-y:auto
          UtilityPanel（投掷/伤害 Tab）
          残局 Card（回合 / 局面 / 结果）
```

关键约束：

- 报告外层 `flex:1; min-height:0; overflow:hidden`，不会出现报告级页面滚动。
- KPI 固定 4×2：即使 1024 宽度下卡片变窄，也只换行文字，不隐藏、不截断、不缩小到不可读；数值仍用 `Subtitle1` 20px，标签/提示沿用 `Caption1`。
- 两个栏目分别 `min-height:0; overflow-y:auto`，并设置 `overscroll-behavior:contain`，互不影响。
- 栏目具有可见标题、`role="region"`、`aria-labelledby`、`tabindex="0"` 与 `:focus-visible` 2px 轮廓。
- coverage warning 在 KPI 上方独立呈现并 `flex-shrink:0`，不会被固定高度遮掉。
- 长 DEM 文件名使用内联 `overflow-wrap:anywhere`，可换行且不产生横向裁切。
- `Findings` 保留全部业务行为，只把“简要分析”标题与说明 Tooltip 提到固定栏头，避免滚动区里重复标题；空结论文案仍在左栏内呈现。

## 3. 不可丢内容与数据

八项 KPI 全部保留，demo1 / twinkle 的真实值在实施后保持一致：

| 指标 | 值 | 说明 |
| --- | --- | --- |
| K / D / A | 25 / 20 / 4 | |
| ADR | 91.38 | 每回合平均有效伤害 |
| HS%（爆头率） | 36.0% | |
| KAST（回合贡献率） | 75% | 18 / 24 回合 |
| Trade rate | 22.2% | 4 / 18 次死亡后队友完成补枪 |
| Trade kills | 6 | |
| Opening | 4 首杀 / 0 首死 | 首杀对决胜率 100.0% |
| Clutch | 1 胜 / 3 次 | 已证明的 1vN 机会 |

Tooltip / hint / coverage、Findings 证据展开与“查看 R24”/“查看相关回合”、Timeline 展开/滚动/高亮、Replay 跳转、道具投掷/伤害 Tab、残局表均保持原行为。

## 4. 真实验收

### 4.1 方法

`node scripts/p7-report-layout-acceptance.mjs`：真实构建的 Electron + 真实本地 DEM；无产品测试钩子。使用：

- `.demo/demo1.dem`：1024×640 与 1920×1032 的完整报告、KPI、双列滚动、联动、Tooltip、AX、强制色/减弱动效；
- `.demo/demo2.dem` 的本地硬链接长文件名：coverage warning、长 DEM 文件名、无 Findings 玩家；
- 临时损坏 `.dem`：报告错误状态。

截图写入 `.tmp/p7-s5-qa/`（gitignored，不提交）。

### 4.2 结果

| 检查 | 结果 |
| --- | --- |
| 报告外层 `scrollHeight <= clientHeight`；document/body/main 无纵向滚动 | PASS（两种尺寸） |
| 八项 KPI 同时可见、4 列 × 2 行、文本不裁切 | PASS |
| 左栏 Findings 独立滚动，可到达最后一条证据 | PASS（1024 与 1920） |
| 右栏道具/残局独立滚动，可到达最后一条 | PASS（1024 真实溢出；1920 用 QA-only 合成残局行制造溢出后验证） |
| 滚动一侧不影响另一侧（赋值、鼠标滚轮、PageDown） | PASS |
| Tooltip（KPI、道具）、证据展开、查看 R24、Timeline 高亮、Replay 跳转 | PASS |
| 投掷/伤害切换与五类道具行 | PASS |
| coverage warning 可见且不与 KPI 重叠 | PASS（demo2） |
| 长 DEM 文件名换行、不横向裁切 | PASS（140 字符本地硬链接） |
| 无 Findings 的玩家显示空状态且左栏可聚焦 | PASS（demo2） |
| 损坏 DEM 错误状态、保留重新选择入口、无页面滚动 | PASS |
| 无障碍树包含“简要分析”“道具与残局”区域与 8 个 KPI 说明按钮 | PASS |
| 键盘焦点轮廓、Tab/PageDown、滚轮 | PASS |
| `forced-colors: active` + `prefers-reduced-motion: reduce` 下 KPI/双列仍可见、无页面滚动 | PASS（CDP 媒体模拟） |

实测几何（demo1，无 warning）：

- 1024×640：报告面板 812×479；KPI 4 列 × 2 行，约 780×200；左右栏各约 199px 高；左栏内容约 1036px、右栏约 534px，均独立滚动。
- 1920×1032：报告面板 1708×871；KPI 约 1676×200；左栏 996×599（内容溢出），右栏 664×599（自然内容不溢出，验收时注入 QA-only 行验证）。

### 4.3 自动化

- `node scripts/p7-report-layout-acceptance.mjs`：**PASS**（exit 0）。
- `pnpm --filter @cs2-analyst/desktop typecheck`：PASS。
- `pnpm --filter @cs2-analyst/desktop build`：PASS。
- 共享 `checkReportLayout` 已接入 `scripts/report-ux-checks.mjs` 的报告视口检查；`test:report` / installed smoke 复用该断言。

## 5. 未执行 / 限制

- **NOT RUN**：Windows 系统级高对比度配置与真实 Narrator/NVDA 朗读。已用 Chromium `forced-colors` 模拟与 CDP Accessibility tree 验证，但不等同于系统辅助技术人工验收。
- **NOT RUN**：真实本地 fixture 中没有“0 次残局机会”或“道具全部不可用”的玩家样本；无残局/无道具空分支只做了源码审查，未用真实数据触发。
- 800×600 / 650×760 不是本轮冻结的验收尺寸。在这些更窄宽度下，右侧道具/残局卡片允许卡片内部横向滚动作为兜底（卡片 `overflow-x:auto`，内容可达而非被 hidden 裁掉）；1024×640 与 1920×1032 已确认无横向溢出。
- 未运行 installer / 安装版全链路；本工作单元不涉及打包、版本或发布。
- 屏幕截图与 QA profile 均不提交。

## 6. 复审

独立代码复审针对布局、可访问性、测试真实性与回归风险进行。复审结论：**无 blocker**；已修复以下确定性问题：

- 窄宽度下右侧卡片曾被 `overflow-x:hidden` 裁切：改为卡片内部横向滚动兜底，并增加共享断言防止 hidden 裁切。
- 共享 `checkReportLayout` 不应强制左栏必须溢出（内容少的报告也应通过）：移除该内容耦合断言。
- KPI 网格补充 `role="group"`；KPI 增加横向边界与裁切断言。
- 去掉重复的三层“简要分析”region：外层栏目改为普通 div，`Findings` 在 `heading={false}` 时渲染为普通 div，仅保留一个带名字的滚动 region。
- 修正实施记录中“集成时复用”的过时措辞。
