# 比赛列表默认窗口优化（2026-10-25）

目标：优先服务用户本人在默认 **1280×800**、侧栏展开时的日常使用体验。最小窗口 **1024×640** 保留为兼容下限。沿用 Fluent UI v9 和现有主题，不改变报告、Analytics、归档、SQLite 或 IPC 契约。

## 最终行为

| 用户要求 | 实现 |
| --- | --- |
| 默认窗口无需左右滑动 | 移除表格 1052px 最小宽度，10 列按比例分配可用空间；日期列缩短，操作列仅放三点按钮，所有统计列保留。长昵称在本单元格省略。 |
| SteamID 仅悬停补充 | 地图下方只显示昵称。地图/昵称 Tooltip 显示文件名、回合数、归档大小与完整 SteamID；昵称等于 SteamID 时显示“已选择玩家”。未选择、缺失玩家仍明确说明，不猜测身份。 |
| 去掉浏览器默认 tip | 移除列表及共享评分/报告文件名的原生 `title`，统一使用 Fluent Tooltip；日期、未知胜负、不可用评分同样提供 Tooltip。 |
| 移除“打开比赛”按钮 | 保留整行点击和行获得焦点后的 Enter/Space 打开。子元素的按键不会误触整行。 |
| 操作收敛为 more 菜单 | 三点按钮打开 Fluent Menu，包含“导出比赛归档”“删除比赛”。菜单事件不触发行打开；删除仍须经现有确认弹窗。忙碌时禁用菜单，不可读归档禁用导出并保留删除入口。 |
| 日期仅显示月日 | 列标题“导入日期”，行显示 MM-DD，Tooltip 显示本机时间 YYYY-MM-DD HH:mm:ss，继续说明这不是可信比赛日期。 |
| 地图固定 9 项 | 前端提供 dust2、mirage、inferno、anubis、ancient、nuke、overpass、train、cache，以及“全部地图”。IPC 值保留 de_ 前缀，不依赖当前页中出现哪些地图。 |
| 重排分页区 | 左侧为已保存比赛数与本机容量；右侧为当前记录范围、上一页箭头、当前页标记、下一页箭头。32px 控件、明确间距与顶部分隔线；分页区不再挤成一行说明文字。 |

分页继续使用后端实际 `limit` 和访问过的 offset 栈，而不是假设每页总有 25 条。显示“第 N 页”及记录范围，不按 `total / 25` 伪造总页数。筛选变化回到第一页；末页删除/数据减少后回退有效页，总数归零时回到 offset 0。空库、加载、操作繁忙时保持正确的翻页禁用状态。

## 验证

| 检查 | 结果 |
| --- | --- |
| `pnpm typecheck` | PASS，15/15 tasks |
| `pnpm --filter @cs2-analyst/desktop build` | PASS，含桌面类型检查、13/13 地图资源与 Main/preload/Renderer 构建 |
| `pnpm --filter @cs2-analyst/desktop test` | PASS，317/317，0 skipped |
| 相关 Renderer / 导航回归 | PASS，46/46，覆盖列顺序、三点入口、忙碌/坏行、无 title、仅月日、固定地图选项及既有身份/选择器逻辑 |
| 实际 TSX + Chromium 交互 | PASS，53 条合成展示数据；1280×800 的表格宽 1005px，表格/页面/页脚横向溢出均为 0，行高 50px，高光 20×20；1024×640 下操作可达 |
| 菜单与可访问交互 | PASS，菜单导出、删除确认/取消不打开行；整行点击与 Enter 打开；子元素 Enter 不误开；不可读记录禁用导出、忙碌时禁用菜单 |
| 分页与筛选 | PASS，实际页长 12/7/25 的前进/后退、地图切换及空态、末页失效回退与总数归零；空库仍有完整固定地图选项 |
| 真实 DEM 构建应用 | PASS，仅使用原 `.demo/demo1.dem`，选择 twinkle 后导入；列表 Rating 1.37，昵称不附加 SteamID，hover 显示完整 ID/日期；默认及最小窗口的表格/页面/页脚横向溢出为 0；菜单删除确认取消、地图筛选/恢复与整行重开通过 |

真实应用检查页面标题、非空内容、实际 DOM/布局、截图及交互，无未捕获异常或新增应用控制台错误。保留已知未打包 Electron CSP advisory，不隐藏、不将其当作本轮功能缺陷修复。没有 Browser skill/runtime，沿用仓库现有 Electron CDP 基础设施，无新增测试依赖。

组件多页检查使用合成目录响应来覆盖缩页、空页与操作事件，不作为真实比赛分析证据。真实 DEM 验证独立走磁盘 File → preload → IPC → worker → 归档 → 列表链路；profile 与 LOCALAPPDATA 均隔离，不访问用户原比赛库，不复制、下载、提交 DEM。

截图与临时脚本位于系统临时目录，未提交：

- 真实构建应用：`%TEMP%/cs2-library-real-qa-pR8hq6/`，包含 `real-library-default.png`、`real-library-minimum.png`、`real-more-menu.png`、`real-player-tooltip.png`、`real-date-tooltip.png`。
- 多页组件交互：`%TEMP%/cs2-library-ui-qa-Liu6UG/`，包含多行列表、分页第二页、菜单、Tooltip 和空态截图。临时入口直接编译仓库实际 TSX，桥接响应仅用于合成布局/分页检查。
- 临时验证入口：`%TEMP%/cs2-library-real-qa.mjs` 与 `%TEMP%/cs2-library-ui-qa.mjs`，使用 `scripts/smoke-runtime.mjs` 和进程生命周期工具。

本轮没有生产安装包、Explorer 原生拖放或跨显示器 DPI 验收，也不声明项目 Final Acceptance。

## 修改范围

- `library-page.tsx`：列宽、昵称、日期、Tooltip、Menu 与分页布局/空页回退。
- `library-query.ts`：固定地图选项、短日期和完整时间格式化。
- `icons.tsx`：沿用本地单色图标体系添加三点图标。
- `performance-display.tsx`、`main.tsx`：移除已有 Fluent Tooltip 对应的重复原生 title。
- `app-shell.test.mjs`：更新交互断言，补齐固定地图、短日期与无原生 title 回归。
