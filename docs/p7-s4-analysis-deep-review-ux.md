# P7-S4 分析页与深度复盘 UX 验收

> 状态：**实现完成 / 真实 Electron 验收通过 / 待统一集成与人工验收**。  
> 分支：`feat/p7-s4-analysis-deep-review-ux`  
> 基线：`318350bab9123c7ffc475e353ef4b2ed5eafbfc1`（`origin/main`）  
> 本工作单元只修改 Desktop Renderer 的两个视图及其专项测试；未修改 `main.tsx`、`sidebar.tsx`、`collapse-motion.css`、比赛报告 JSX/CSS、领域算法、Findings 规则、DTO、DEM 解析或 Replay IPC。

## 1. 分析视图

- `analysis-views.tsx` 使用受控 Fluent UI v9 `TabList`，固定三个选项卡：**全场玩家对比 / 回合表现趋势 / CT / T 表现对比**，默认选中第一项。
- 三个 panel 全部保持挂载，非当前项使用 `hidden`；指标选择、玩家排序、趋势交互和 CT/T 内容不会因切换选项卡而丢失。
- 分析根节点使用 `height: 100%`、`min-height: 0`、`overflow: hidden`；当前 panel 使用 `flex: 1`、`min-height: 0`、`overflow-y: auto`。因此长玩家列表只在当前选项卡内部滚动。
- 原有指标数值、降序/null 末尾排序、Tooltip、横向趋势滚动、窄屏 CT/T 单列布局均保留；没有新增或重算领域数据。
- 空数据仍保留三个选项卡：玩家对比、当前玩家趋势、当前玩家 CT/T 分别显示明确空状态。

## 2. 深度复盘

### 标题与 Tooltip

- 标题旁增加问号按钮 + Fluent Tooltip，完整保留原说明：  
  「根据 DEM 中能够明确记录的交火、人数变化、队友跟进和道具效果生成。」
- `coverage.status === 'partial'` 时增加黄色警告图标 Tooltip：  
  「这场录像中有部分记录无法完整判断，具体限制可在每张卡片的「说明与限制」中查看。」
- 问号与警告入口均为可聚焦按钮，鼠标悬停和键盘焦点都能打开 Tooltip。

### 三个固定选项卡

- 固定显示 **优先复盘 / 亮点 / 补充观察**，默认选中优先复盘。
- 三个 panel 全部挂载；切换只改变 `hidden`，当前 panel 独立纵向滚动。复盘卡片、证据入口、覆盖率、相关回合、比赛回放和「说明与限制」全部保留。
- 切换玩家会重新挂载 Deep Review 并回到「优先复盘」；重新导入比赛会重新挂载整个报告，分析页与深度复盘都恢复默认选项卡/默认指标。
- 当前 tab panel 使用 `flex: 1`、`min-height: 0`、`overflow-y: auto`；工作区根节点 `height: 100%`、`overflow: hidden`，外层视图不产生纵向滚动。

### 空状态与不可用

- 三个 tab 始终存在。无结论时显示轻量线条图标与指定文案：
  - 优先复盘：「这场暂时没有需要重点复盘的地方，先把好状态保持住。」
  - 亮点：「高光可能在路上，这场还没有足够证据点亮它。」
  - 补充观察：「观察哨今天很安静，没有额外值得补充的记录。」
- `coverage.status === 'unavailable'` 时保留可见红色 MessageBar：「本场录像无法用于深度复盘，基础比赛报告仍可查看。」每个 tab 内容区同时显示「深度复盘数据不可用，暂时无法生成这类结论。」，不使用普通空状态掩盖错误。

## 3. 验证

### 自动化

| 命令 | 结果 |
| --- | --- |
| `pnpm typecheck` | PASS — 15/15 |
| `pnpm build` | PASS — 8/8 |
| `pnpm --filter @cs2-analyst/desktop test` | PASS — 170/170，0 FAIL / 0 SKIP |
| `node scripts/desktop-report-smoke.mjs`（真实 Electron，demo1） | PASS — 真实报告、损坏 DEM、非 .dem 三个场景 |
| `git diff --check` | PASS |

专项 SSR 测试覆盖：三选项卡结构、默认选中、panel 挂载/hidden、分析缺数据空状态、Tooltip 文案常量、partial 警告、三类空状态、unavailable 可见错误。

### 真实 Electron

真实 `demo1.dem` 下使用 CDP 操作真实窗口，验证：

- 分析三个选项卡的鼠标点击、方向键移动焦点 + Enter 切换、指标选择往返保留。
- 深度复盘三个选项卡始终存在；鼠标和键盘切换；切换玩家后回到优先复盘。
- 1024×640、1920×1032 下分析/深度复盘均无外层纵向滚动，当前内容区可独立滚动，内容末端可达；无横向溢出。
- 问号与 partial 警告 Tooltip 的 hover 和 focus。
- 空状态、partial、unavailable 三种状态。
- 相关回合：展开 R7/R24、Timeline 高亮并滚动到目标回合。
- 比赛回放：从复盘卡片的「比赛回放 R7」进入 Replay 并定位到第 7 回合。
- 重新导入比赛后回到比赛报告；分析和深度复盘均恢复默认选项卡/默认 ADR 指标。
- 既有指标、Findings 与报告结果：真实报告 smoke 的数值、排序、Tooltip、Timeline、回放与文案断言全部保持通过。

本地 QA 截图（不提交，位于隔离 worktree 的 `.tmp/p7-s4-shots`）：

- `1024-analysis-comparison.png` / `1024-analysis-trend.png` / `1024-analysis-sides.png`
- `1024-deep-reviews.png` / `1024-deep-highlights.png` / `1024-deep-contexts.png`
- `1024-deep-partial.png` / `1024-deep-partial-tooltip.png` / `1024-deep-empty.png` / `1024-deep-unavailable.png`
- `1920-analysis-comparison.png` / `1920-analysis-trend.png` / `1920-analysis-sides.png`
- `1920-deep-reviews.png` / `1920-deep-highlights.png` / `1920-deep-contexts.png`

### 未执行 / NOT RUN

- `pack:win`、`pack:win:test`、`test:installed`：本轮未重新打安装包，未做安装版回归。
- Windows 100% 缩放之外的高 DPI、系统高对比度、屏幕阅读器逐项人工走查：NOT RUN。
- 其他地图/其他玩家的真实数据组合：只使用 `.demo/demo1.dem` 做真实 Electron 验收；空/partial/unavailable 状态通过运行期 DTO 合成覆盖。

## 4. 变更文件

- `apps/desktop/renderer/src/analysis-views.tsx`
- `apps/desktop/renderer/src/deep-review.tsx`
- `apps/desktop/tests/analysis-deep-review-ux.test.mjs`（新增）
- `apps/desktop/tests/report-ux.test.mjs`（空状态断言同步）
- `scripts/deep-review-ux-checks.mjs`、`scripts/desktop-report-smoke.mjs`、`scripts/report-ux-checks.mjs`、`scripts/window-shell-checks.mjs`（仅 UI 验收脚本适配嵌套选项卡与尺寸）
- 本文件

## 5. 剩余风险

- Tooltip 由 Fluent 自动定位，窄窗口下会覆盖标题下方少量内容；未做自定义定位，不影响可用性。
- 所有 panel 保持挂载意味着隐藏 tab 的 DOM 仍然存在；当前数据量为单场单玩家规模，没有观察到性能问题。
- 共享 UI 验收脚本增加了嵌套 tabpanel 的滚动检查；这些是测试基础设施变更，不进入产品运行路径。
