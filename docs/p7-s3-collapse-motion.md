# P7-S3 Collapse Motion

> **Status: PASS（仅 S3 范围）.** 本任务只收敛原生 `<details>`、回合时间线与侧栏的展开/收起动画；不表示 S4、S5 或整个 P7 已完成。
>
> - 基线：`origin/main` = `318350bab9123c7ffc475e353ef4b2ed5eafbfc1`
> - 分支：`feat/p7-s3-collapse-motion`
> - 实际运行环境：Windows x64，Electron `44.5.1`，Chromium `152.0.7977.130`，Node `26.3.0`
> - 共享计划文档 `docs/p7-final-hardening-plan.md` 未修改；`deep-review.tsx`、`analysis-views.tsx` 未修改。

## 1. 折叠入口清单

实施前逐项检查了 Renderer 中的真实展开入口：

| 入口 | 代码位置 | 原行为 | 本轮实现 |
| --- | --- | --- | --- |
| 比赛报告 Findings「查看证据（N）」 | `main.tsx` 原生 `<details>` | 瞬间开关 | 全局 `details` CSS 动画，不修改报告 JSX |
| 深度复盘「说明与限制」 | `deep-review.tsx` 原生 `<details>` | 瞬间开关 | 同一全局 `details` CSS 自然覆盖，组件零改动 |
| 回合时间线「查看详情 / 收起」 | `main.tsx` 条件渲染 | 瞬间挂载/卸载 | `TimelineCollapse`：0fr→1fr 高度过渡，结束后卸载 |
| 侧栏「收起导航 / 展开导航」 | `sidebar.tsx` | 160ms 宽度过渡 | 调整为 200ms ease-out，并受 reduced-motion 覆盖 |

仓库中没有其他产品级原生 `details` 入口（已用全仓搜索确认）。`analysis-views.tsx` 不属于本任务的折叠入口。

## 2. 实现

### 2.1 原生 details：`apps/desktop/renderer/src/collapse-motion.css`

- 通过 `@supports selector(::details-content)`、`@supports (interpolate-size: allow-keywords)` 渐进增强；不支持时保持原生瞬时行为。
- `details::details-content` 使用 `block-size: 0`、`overflow: clip`、`content-visibility: hidden`；`details[open]::details-content` 使用 `block-size: auto`。高度来自真实内容，不使用固定高度。
- 过渡为 `block-size 220ms`、`opacity 180ms`、`content-visibility 220ms allow-discrete`。`visibility` 同样以 220ms 过渡：关闭过程中内容仍被绘制，结束后立即退出焦点顺序；这修复了「关闭后内部按钮仍保留焦点」的问题。
- 关闭内容保留原生 DOM（原生 `details` 语义），但 `visibility: hidden` + `content-visibility: hidden` 使其不可见、不可聚焦、不可被 Tab 到达。
- 不修改 summary 的 marker、键盘 Enter/Space、焦点顺序或现有 Fluent 样式。

### 2.2 回合时间线：`main.tsx` 时间线区域

- 新增仅服务于时间线的 `TimelineCollapse`：
  - 关闭时内容立即标记 `inert`，不能继续接收键盘焦点；
  - 0fr→1fr 的 grid 行过渡，内部 `min-height: 0; overflow: clip`，高度随事件列表自适应；
  - 过渡结束后卸载内容；`prefers-reduced-motion: reduce` 时展开跳过 double-rAF、关闭直接卸载；
  - 用两帧 rAF 提交 0fr 起始态，避免新挂载内容跳过打开动画；
  - 关闭定时器、rAF 与 transitionend 均清理；快速连续点击、动画中途反向点击不会留下重复节点。
- 保留原 `aria-expanded`、按钮、回合顺序、事件 DTO、滚动与高亮联动；业务数据与跳转逻辑未动。

### 2.3 侧栏

- 原有 160ms 宽度过渡保留并调整为 `200ms cubic-bezier(0.2, 0, 0, 1)`。
- `collapse-motion.css` 在 reduced-motion 下把 `[data-app-sidebar]` 的 transition-duration 压到 `0.01ms`。
- 导航 Tab、`aria-controls`、选中视图、图标列与折叠态 Tooltip 均未改动。

### 2.4 无障碍

- `prefers-reduced-motion: reduce`：details 过渡为 `none`；时间线跳过 double-rAF 直接提交展开、关闭即时卸载；侧栏宽度过渡关闭。
- Windows 高对比度（`forced-colors: active`）：details 内容 opacity 强制为 `1`，不依赖透明度表达状态；summary marker 保留；focus-visible 使用系统 `Highlight` 轮廓。
- 状态仍由原生 `open`、`aria-expanded`、可见的「查看证据 / 说明与限制 / 查看详情 / 收起」文本表达。
- 未引入动画库或新依赖；未使用固定高度、裁切或长延时。

## 3. 测试

在隔离 worktree `.tmp/s3-wt` 中执行（避免与并行任务共享工作树）：

| 检查 | 结果 |
| --- | --- |
| `pnpm typecheck` | **15/15 PASS** |
| `pnpm build` | **8/8 PASS** |
| `pnpm --filter @cs2-analyst/desktop test` | **170/170 PASS，0 FAIL，0 SKIP** |
| `node --test apps/desktop/tests/collapse-motion.test.mjs` | **6/6 PASS**（断言在剥离注释后的规则文本上，避免注释误报） |
| `node scripts/collapse-motion-smoke.mjs` | **PASS** |
| `node scripts/desktop-report-smoke.mjs`（真实 / 损坏 / 非 DEM） | **PASS** |
| `git diff --check` | **PASS** |
| `git ls-files '*.dem'` | 无输出（没有 DEM 进入 Git） |

`collapse-motion-smoke.mjs` 的真实 Electron 覆盖：

1. Findings 长证据：鼠标打开/关闭、Enter 打开、Space 关闭、7 次快速开关、关闭后内容不可聚焦。长证据从 28px 展开到 914px，关闭回到 28px。
2. 深度复盘「说明与限制」：长文本打开/关闭、键盘打开，无最后一行裁断。
3. 回合时间线 R24：键盘 Enter 打开 / Space 关闭（焦点保持在 summary）、0→283px 的中间高度、4 条 killfeed 事件、关闭时立即 inert、过渡后 DOM 卸载、快速奇偶点击、double-rAF 前连续点击、动画中途反向点击、两回合同时展开并分别关闭。
4. 切换玩家：展开身份保持（既有行为），但事件内容按新玩家重建；重新导入比赛后展开状态清零。
5. 侧栏：212↔56px 的中间宽度、`aria-label` 切换、200ms 过渡。
6. 真实窗口：`1024×640` 和 `1920×1032`（`BrowserWindow.setBounds`，实际 `innerWidth/innerHeight` 均精确匹配），两个尺寸都执行布局、滚动、裁断与截图检查。
7. reduced-motion：details 过渡时长计算值为 `0s`，时间线展开不经 double-rAF、关闭立即卸载，侧栏过渡 ≤ `0.001s`，关闭内容不可聚焦。
8. forced-colors：`matchMedia('(forced-colors: active)')` 为真，details 内容 opacity 为 `1`，summary marker 非 `none`，时间线状态仍显示「收起」。
9. 焦点：真实指针关闭时焦点落在 summary；程序化关闭时若焦点原本在证据按钮，visibility 过渡结束后也会释放；关闭后的内容不可程序化聚焦。
10. 时间线边界：double-rAF 之前连续两次点击、动画中途反向、两回合同时展开并分别关闭、关闭后立即切换玩家（300ms fallback 之前）均不残留 wrapper/detail。
11. 无页面级滚动、无水平溢出；报告/时间线/深度复盘仍在各自面板内滚动。未捕获 Renderer 异常。

### 3.1 截图（本地 ignored，不提交）

`.tmp/p7-s3-qa/`：

- `report-details-1024x640.png`、`report-details-1920x1032.png`
- `timeline-r24-1024x640.png`、`timeline-r24-1920x1032.png`
- `deep-review-caveats-1024x640.png`、`deep-review-caveats-1920x1032.png`
- `forced-colors-details.png`、`forced-colors-timeline.png`

实查结果：长证据列表完整显示、时间线 R24 事件行完整、深度复盘说明文字完整、forced-colors 下 marker 与文本清晰；未发现文本裁断或多余横向滚动。

### 3.2 独立复审处理

独立复审未发现 P0；指出的可改进项已处理并重新冻结验证：

- **复审期间工作树变动**：P1 指出的问题是复审快照期间测试脚本被继续编辑。最终提交前已冻结全部 7 个文件，重新执行 typecheck、build、170 项 Desktop 测试、S3 Electron 验收与既有 report smoke；本文件的测试结果均来自冻结后的最终运行。
- **打开时 inert 窗口**：`inert={!open || !visible}`，在 0fr 起始帧也不会让不可见内容获得 Tab 焦点。
- **reduced-motion 的 double-rAF**：reduced-motion 下跳过 double-rAF，直接提交展开态。
- **键盘覆盖**：时间线 summary 的 Enter/Space 打开/关闭已恢复并通过（此前实验性的按键序列不正确，已改为 rawKeyDown + char + keyUp）。
- **程序化关闭焦点**：新增「焦点原本在证据按钮、不经指针移动直接关闭」的测试；visibility 过渡结束后焦点释放，关闭内容不可再聚焦。
- **单元测试质量**：断言前剥离 CSS 注释，避免注释文本让源文本测试误通过。
- **边界覆盖**：新增 double-rAF 前连续点击、两回合同时展开、关闭后立即切玩家、reopen 清除 inert 并恢复交互。
- **保留项**：原生 details 在 220ms 关闭动画期间仍被绘制，焦点在过渡结束后释放（真实指针/键盘关闭会先把焦点移到 summary）；展开态保留 `overflow: clip` 以防止过渡溢出，未观察到 focus ring 裁切，但未做像素级测量。

## 4. 未执行 / 剩余风险

- **NOT RUN**：安装包 `pack:win` / `test:installed`，以及人工产品视觉签收。本任务为 Renderer 交互改动，不涉及打包/版本/tag/release。
- **NOT RUN**：S4、S5 的验收；本轮不宣称它们或整个 P7 完成。
- CSS 依赖 Chromium 152 的 `::details-content`、`interpolate-size`、`allow-discrete`。若未来回退到不支持这些能力的运行时，`@supports` 会保留原生瞬时开关，不会出现错误高度或内容丢失。
- 原生 details 在关闭的 220ms 动画期间仍处于可绘制状态；若焦点正好在内部按钮上，浏览器在 `visibility` 过渡结束后释放焦点。时间线额外使用 `inert`，关闭瞬间即不可聚焦。
- 快速反向动画在真实 Electron 下已验证；极端低帧率环境未单独测量。
- 展开态内容仍使用 `overflow: clip` 防止过渡期间溢出；现有按钮的 focus outline 位于内边距内，截图未发现裁切，但未做像素级焦点环测量。

## 5. 文件所有权与工作树隔离

允许修改的文件全部遵守；未改动 `deep-review.tsx`、`analysis-views.tsx`、`main.tsx` 的 `makeStyles` 与比赛报告 JSX、共享 P7 计划文档、分析/Findings/DEM/Replay/IPC/版本号。

实施期间共享检出被并行任务切换到 `feat/p7-s5-report-layout-a` 并出现其 staged/unstaged 改动。为不覆盖其他任务，S3 的最终构建、测试、提交与推送改在独立 worktree `.tmp/s3-wt` 完成；共享检出中只移除了属于 S3 的未提交 hunk 与三个新增文件，未触碰 S5 的改动。S3 提交不包含 S4/S5 文件。

## 6. 结论

S3 Collapse Motion 在真实 Electron 中达到：平滑的 180–240ms 展开/收起、动态高度、关闭后无焦点残留、快速切换稳定、reduced-motion/forced-colors 可访问、真实窗口尺寸无裁断。**S3 PASS；等待统一集成与人工验收。**
