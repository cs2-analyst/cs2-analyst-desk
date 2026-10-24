# 比赛记录、近似 Rating 与高光交付记录

日期：2026-10-22（Asia/Shanghai）。范围为本轮功能验证，不代表整个项目 Final Acceptance。版本维持 0.2.0，无 Release/Tag。

> 后续列表视觉与交互以 [2026-10-25 默认窗口优化](./match-library-ui-polish.md) 为准。下文固定宽度横滚、独立打开按钮等为历史验收行为，已被新的自适应列宽与三点菜单替代。

## 调查与实现

- 原列表为卡片，目录仅含地图、比分、玩家名单、导入时间及存储元数据；完整报告已保存在 gzip 归档，SQLite 管理目录。原列表已有打开、导出、删除、搜索、地图筛选及排序，没有真实组排或收藏实现。
- 正常链路为 Renderer → Preload 命名 IPC → Main → Utility 单次解析/分析 → 报告与本地归档。列表仅从目录和按页派生缓存取数据。没有引入 Renderer Analytics 依赖或逐行 DEM 解析。
- 复用现有 K/D/A、有效 ADR、KAST、Opening、Trade、Clutch、Utility、HS%、MultiKill；公式与门控集中在 Analytics。Report contract 继续 schema v2，以可选字段兼容。
- 列顺序：日期（明确标记导入时间）、地图、胜/负、比分、K/D/A、ADR、Rating、KAST、高光、操作。缺少可信比赛日期与组排数据，不伪造。数值居中、低对比度分隔、50px 统一行高、Hover、20×20 方形标签和固定宽度横向滚动。
- 地图标题、比分、队伍与回合语义保持不变；文件名与 Rating 在同一独立次级行，文件名可省略并提供 Tooltip。报告正文布局未更改。
- 玩家偏好仅保存 SteamID；列表与报告均按同一玩家摘要选取。玩家不在当前比赛时列表显示未知，打开后使用该场有效玩家并同步偏好。

## 评分、高光与历史兼容

公式、来源、8 类门槛、覆盖门控、真实样本 SHA 与局限详见 [规则说明](./performance-rating-highlights.md)。算法为 `hltv-2.0-community-approx-v1`，并非 HLTV 未公开的官方精确公式；KAST 使用百分数，ADR 复用项目有效敌方 HP 损失。计算/保存不取整、不截断，列表和报告统一显示两位小数。

高光最多 3 项，固定优先级：残、神、突、补、准、闪、辅、助。条件分别为真实残局胜 ≥1；三杀及以上回合 ≥1；首杀 ≥3 且多于首死；真实补枪 ≥3 且覆盖完整；HS≥60% 且有效击杀≥15、爆头证据完整；事件确认闪光助攻≥3；HE+燃烧有效敌伤≥200；有效助攻≥6。没有 MVP 事件证据，不实现 MVP。

新报告保存预计算结果与轻量覆盖证明。旧报告仅在保存的输入和证明充分时补算；旧 `coverage.complete` 未保留未知 teamkill 信息，不能证明评分可靠，因此没有证明的旧记录显示 `—` 和中文原因。独立可证的高光仍可展示。不把未知数值写成 0，不自动删除或替换历史记录。原有同 SHA 重复导入继续重开已有归档，不承诺借此升级旧归档。

`player_summary_cache` 是 SQLite 独立派生表，绑定 manifest hash 与算法/adapter 版本；原归档、manifest、目录快照、导入时间均保持不变。读取只补当前页，热缓存不再读取报告。Renderer 请求 25 条，服务遇 512KiB 预算时缩小 SQL 页并返回实际 limit；前后页使用真实 offset，末页删除后回退有效页。

## 验证

| 项目 | 结果 |
| --- | --- |
| `pnpm --filter @cs2-analyst/analytics test` | 103/103，通过，0 skipped；新增 50 项评分/高光测试 |
| `pnpm --filter @cs2-analyst/desktop test` | 304/304，通过，0 skipped；含新增 13 项兼容/缓存测试与 4 项 Renderer 测试 |
| `pnpm typecheck` | 15 个任务通过 |
| `pnpm build` | 8 个任务通过；最终 UI 改动后 Desktop build 另行通过 |
| 独立审查 | 兼容回归 10/10、Renderer 13/13；修复预算、旧证明不足、稳定队伍判定、分页空态问题后无新阻断 |
| `node scripts/rating-library-acceptance.mjs` | 真实 Electron、demo1/demo2、隔离 profile 与 LOCALAPPDATA；见下方证据 |

100 场 × 10 玩家是合成归档规模测试，用来验证分页预算、无遗漏与无重复，不作为真实比赛表现证据。真实验收不复制、下载或修改 DEM，不访问用户原比赛库。

Electron 路径使用项目已有 CDP 测试设施；当前无面向本机 Electron 的 Browser skill/runtime，未引入 Playwright 或额外依赖。测试窗口为 1440×900 和 900×700（后者通过 CDP 压力测试，小于应用原生最小尺寸）。

| UI 检查 | 结果与证据 |
| --- | --- |
| 页面身份、非空、无框架错误遮罩 | Electron CS2 Analyst 正常渲染列表与报告 |
| 真实同人同场评分 | demo1 twinkle：存储 1.3742186666666667，列表/报告均为 1.37；demo2 均为 — |
| 身份切换 | 列表切换另一 SteamID → 报告 0.54；报告切回 twinkle → 列表 1.37；重启恢复 |
| 真实高光 | demo1：残/神/突；demo2：残/神；Tooltip 数字来自真实结果，方块几何为 20×20 |
| 响应式 | 窄窗口表格区域横滚，页面不横向溢出，滚到右侧可访问操作按钮 |
| 标题区与长文件名 | 两尺寸均无文件名/Rating 重叠；额外仅修改 DOM 展示文字做长名布局压力测试，不伪装 DEM 输入 |
| 交互 | 打开、双向身份切换、搜索、Tooltip、横向滚动实际执行；排序/地图查询、忙碌/坏行操作禁用由自动测试覆盖 |
| 控制台 | 无未捕获异常或新增应用错误；保留现有未打包 Electron CSP advisory，不将其隐藏或归为本轮修复 |

最终 Electron 验收 PASS：demo1 导入 17,014ms，demo2 导入 13,418ms；两场记录热缓存列表请求约 1.2ms。这是本机观测，不是跨机器性能保证。

最终本地截图与机器证据目录：`C:/Users/evanpatchouli/AppData/Local/Temp/cs2-analyst-rating-evidence-GRyyyC/`。

- `evidence.json`：实际时延、身份、数值、几何、异常及控制台警告。
- `demo1-library.png`、`demo2-library.png`：真实列表。
- `demo1-report.png`、`demo2-report.png`：报告顶部与原主体布局。
- `demo1-highlight-tooltip.png`、`demo2-highlight-tooltip.png`：真实高光证据。
- `*-narrow.png`、`*-narrow-actions.png`、`*-report-narrow.png`：窄窗口与右侧操作可达。
- `empty-library.png`、`filtered-library.png`：空态与搜索结果。

截图经智能体逐张视觉检查；这不是用户签字验收。未执行生产安装包/NSIS 回归、全部地图 UI 遍历，也没有声称项目 Final Acceptance PASS。真实样本没有触发闪/辅，不人为制造；旧报告证据不足、无真实比赛时间、既有未打包 CSP 提示均为已说明的限制。未做全面性能基准；列表缓存、响应字节预算及两场真实 warm-list 时延有实际证据，不能外推为所有库规模的性能承诺。

## 修改文件与用途

| 文件 | 用途 |
| --- | --- |
| `packages/analytics/src/performance.ts`、`src/index.ts` | 评分、规则、覆盖输入适配器与公开接口 |
| `packages/analytics/tests/performance.test.mjs` | 公式、输入边界、标签、隔离与真实 DEM 测试 |
| `packages/report-contract/src/performance.ts`、`src/index.ts`、`src/library.ts` | JSON 评分/高光、可选覆盖证明、列表玩家摘要 |
| `apps/desktop/electron/report.ts` | 新报告投射 Analytics 结果及证明 |
| `apps/desktop/electron/player-performance.ts` | 旧报告兼容、摘要校验、稳定队伍胜负 |
| `apps/desktop/electron/library-archive.ts` | 读取报告后的兼容入口 |
| `apps/desktop/electron/local-library.ts` | 独立 SQLite 派生缓存与字节有界分页 |
| `apps/desktop/electron/main.ts` | 异步列表 IPC 接入 |
| `apps/desktop/renderer/src/library-page.tsx` | 紧凑 Fluent 表格、身份选择、分页、操作与横滚 |
| `apps/desktop/renderer/src/performance-display.tsx` | 统一格式化、方块、Tooltip、文件名/Rating 次级行 |
| `apps/desktop/renderer/src/main.tsx` | 报告标题区接入，无正文重构 |
| `apps/desktop/renderer/src/store.ts`、`src/theme.ts` | SteamID 偏好与表现色彩 |
| `apps/desktop/tests/player-performance.test.mjs` | 旧报告、缓存、不可变归档、身份及规模回归 |
| `apps/desktop/tests/app-shell.test.mjs`、`library-main-fixture.mjs` | 列顺序、格式/禁用、身份、标题区及 Main 测试适配 |
| `scripts/rating-library-acceptance.mjs` | 可重复的真实 Electron 交互和截图验收 |
| `docs/performance-rating-highlights.md`、本文 | 公式、规则、兼容决定及交付证据 |

功能提交：`d86490d`、`194dd7a`、`8e9d878`、`6328051`、`3b484be`。最后的验收文档/脚本说明提交与推送状态以交付时 Git 结果为准。
