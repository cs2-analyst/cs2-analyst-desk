# L4 · 桌面导航与本地比赛库 UI 证据

> 状态：**实现完成，待 L3 数据操作接入后的真实删除/导出/导入回归。** 本阶段不改后端/Electron 服务、归档编解码或 `packages/report-contract`；不复制 DEM；不修改用户现有比赛库。
>
> 分支：`codex/l4-library-navigation`；实现 HEAD：`153e1d2`（父提交 `c17bcf5`，工作树从 `41926f5` 基线创建）。几何/历史证据 JSON：`.tmp/l4-library-navigation-evidence.json`（本地未跟踪）。

## 1. 交付范围

- **两套互斥侧栏模式**
  - 全局：一级入口「个人数据」「比赛数据」，默认「比赛数据」。个人数据是明确占位页，没有伪造统计。
  - 比赛：整栏替换为原有六项（比赛报告、深度复盘、回合时间线、分析、比赛回放、热力图），复用原组件、顺序、名称、id、选中样式和折叠行为；没有全局+比赛嵌套树。
- **比赛数据页**：已保存比赛列表、打开、删除（Fluent Dialog 二次确认）、导出、导入 `.cs2a`、搜索/地图筛选/排序/方向、存储占用、加载/错误/不可读/空状态。列表只调用 `library.list`/`library.storage`，不读取 Replay Chunk。
- **标题栏**：左侧后退/前进，mark+「CS2 Analyst」品牌组 `position:absolute; left:50%; translateX(-50%)` 以整个窗口宽度居中，右侧保留最小化/最大化/关闭；`data-app-titlebar` 拖拽区、按钮 `no-drag`、Tooltip/aria-label/disabled 状态、最大化状态订阅保持。
- **历史语义**：节点只有 `global(section)` 与 `match(matchId)`；六视图切换写入 `matchViews[matchId]`，不压栈。一次后退从任意 Tab 直接回比赛数据列表；前进重新调用 `library.open` 创建新会话并恢复该场最后 Tab。新导航清理前进分支；目标比赛被删除/不可用/缺失时降级到列表并显示消息。
- **会话生命周期**：退出比赛时清空当前报告并调用 `window.cs2Analyst.session.release(sessionId)`（存在 sessionId 时）；失败打开/删除/导出/导入保留原报告。`sessionActive` 是显式信号，不再由 `status==='error'` 推断，因此失败操作后旧 Replay/Heatmap 控件仍可交互。
- **导入**：成功后进入新比赛；取消/失败保留当前页面/报告/列表与导航栈。打开与导入共用一个互斥 busy 状态，删除/导出/归档导入也参与互斥。

## 2. 变更文件（三个实现提交）

```text
apps/desktop/renderer/src/app-titlebar.tsx       标题栏历史按钮与品牌绝对居中
apps/desktop/renderer/src/home.tsx              删除（由比赛数据页替代）
apps/desktop/renderer/src/icons.tsx             个人/比赛库/后退/前进本地图标
apps/desktop/renderer/src/library-page.tsx      比赛数据页 + 可测试列表
apps/desktop/renderer/src/library-query.ts      筛选→catalogue query、字节/时间格式化
apps/desktop/renderer/src/main.tsx              Shell 两种模式、全局页、会话可用信号
apps/desktop/renderer/src/navigation.ts         纯 typed 导航 reducer（global/match）
apps/desktop/renderer/src/sidebar.tsx           GlobalSidebar / MatchSidebar
apps/desktop/renderer/src/store.ts              导航、库操作、sessionActive、busy/error
apps/desktop/renderer/src/titlebar-geometry.ts  品牌中心误差纯函数
apps/desktop/tests/app-shell.test.mjs           sidebar/list/titlebar/geometry DOM 测试
apps/desktop/tests/library-navigation.test.mjs  历史、失败保留、busy、会话控件测试
apps/desktop/tests/import-ipc.test.mjs          store.ts 显式 .ts 导航模块解析
scripts/library-navigation-smoke.mjs            真实 Electron CDP L4 smoke
scripts/window-shell-checks.mjs                 双模式侧栏/品牌/后退前进适配
scripts/report-ux-checks.mjs                    导入后历史按钮断言
```

## 3. 验证结果

| 命令 | 结果 |
| --- | --- |
| `pnpm typecheck`（apps/desktop，先构建 workspace domain packages） | PASS，0 error |
| `pnpm build`（apps/desktop） | PASS，main/preload/renderer 产物构建成功 |
| `CS2_ANALYST_FIXTURE_ROOT=E:\cs2-analyst\.demo pnpm test` | **259 / 259 PASS，0 skipped** |
| 新增聚焦测试（app-shell 9 + library-navigation 8） | **17 / 17 PASS** |
| `node scripts/desktop-smoke.mjs`（dev + preview） | PASS，页面/preload/资源/关闭窗口 |
| `CS2_ANALYST_DUST2_DEM=E:\cs2-analyst\.demo\dust2.dem node scripts/library-navigation-smoke.mjs` | **PASS**，真实 Electron CDP |

测试 fixture 仅通过只读 `CS2_ANALYST_FIXTURE_ROOT` 引用，未复制/提交 DEM。全量测试中 Nuke 真实管线与 demo1 真实报告在 fixture 根存在时均执行，无 skip。

## 4. 几何证据（真实 Electron CDP）

公式：`abs(brand.left + brand.width/2 - (titlebar.left + titlebar.width/2)) <= 1 CSS px`。

- 24 个测量状态（全局/比赛 × 1024×640 / 1920×1032 × 展开/收起 × 普通/最大化/恢复）**全部 delta = 0.000 px**。
- 真实原生窗口（无 Emulation）：
  - 普通：1280×800，delta 0；
  - 最大化：1920×1032，delta 0，`isMaximized() === true`；
  - 恢复：1280×800，delta 0，`isMaximized() === false`。
- 1024×640 与 1920×1032 的精确视口由 CDP Emulation 固定；在此视口下通过真实 preload `toggleMaximize` 切换原生最大化状态，`nativeMaximized` 同步为 true/false，delta 仍为 0。
- 1024×640 展开/收起、1920×1032 展开/收起、最大化/恢复均有记录；截图见 `.tmp/l4-navigation-shots/`。

## 5. 历史与六视图证据

- 导入 Dust2（注入 `CS2_ANALYST_DEM_PATH`，owned 临时 profile）耗时约 19.8 s。
- 导入成功自动进入比赛；`[data-app-sidebar] data-sidebar-mode="match"`，六个 Tab 全部 enabled。
- 连续切换 7 次 Tab 后，单击一次 `[data-nav-action="back"]` 直接回到比赛数据列表，列表含 1 条记录。
- 单击 `forward` 重新打开同一场，选中 Tab 恢复为 `heatmap-tab`，六视图面板逐一 `visible=true / aria-selected=true / disabled=false`。
- 1920×1032 下再次执行一次后退→前进，仍恢复 `heatmap-tab`。
- 测试期间 renderer 未捕获异常；owned `LOCALAPPDATA` 与 `--user-data-dir` 临时目录在结束后删除。

## 6. 保留风险 / 未验证项

1. **L3 数据操作尚未合并**：当前基线没有 `library:remove`/`library:export`/`library:import` IPC handler。UI 已按冻结 preload API 实现，单元/DOM 测试用 mock 覆盖成功、取消、失败和 busy；真实删除→导出→导入→离线重开需在 L3 合并后补跑。
2. **DPI**：本轮 devicePixelRatio = 1；125%/150% 物理 DPI 未实测，不能声称 PASS。
3. **高对比度 / Narrator**：未做真实 Windows 高对比度或屏幕阅读器走查；aria-label、Tooltip、disabled 与焦点样式已在 DOM/真实 Electron 结构断言。
4. **双击最大化**：标题栏与品牌组计算样式为 `-webkit-app-region: drag`，按钮/窗口控制为 `no-drag`；合成 CDP 鼠标事件不能替代 Windows 原生 caption 命中测试，因此本轮只验证拖拽区域与原生最大化按钮，不把双击单独标为真实 PASS。
5. **精确尺寸测量方法**：Electron 44 CDP 不提供 `Browser.setWindowBounds`；1024×640 / 1920×1032 的精确视口用 Emulation 固定，原生最大化/恢复用真实 `BrowserWindow` 状态核对；原生窗口尺寸记录为 1280×800 / 1920×1032。
6. **会话释放**：store 测试断言 `session.release(exactSessionId)` 被调用；真实 Main 侧 worker 退出未在 Renderer smoke 中直接读取进程表。
7. **列表查询**：搜索/筛选/排序走 `library.list` 服务端查询，输入变化即时请求、无防抖；本地 SQLite 下可接受，超大库仍建议后续观察。
8. **现有 P7 重型验收脚本**（`desktop-report-smoke` / `p7-*`）未在本次 L4 全量重跑；共享 `window-shell-checks` / `report-ux-checks` 已适配，但仍需 L5 集成时在完整 fixture 下复跑。

## 7. 复现命令

```powershell
# 一次构建 workspace domain packages（新 worktree 无 dist 时）
pnpm --filter @cs2-analyst/match-model build
pnpm --filter @cs2-analyst/dem-parser build
pnpm --filter @cs2-analyst/analytics build
pnpm --filter @cs2-analyst/findings build
pnpm --filter @cs2-analyst/deep-review build
pnpm --filter @cs2-analyst/report-contract build

cd apps/desktop
pnpm typecheck
pnpm build

$env:CS2_ANALYST_FIXTURE_ROOT='E:\cs2-analyst\.demo'
pnpm test

cd ../..
$env:CS2_ANALYST_DUST2_DEM='E:\cs2-analyst\.demo\dust2.dem'
node scripts/library-navigation-smoke.mjs
```
