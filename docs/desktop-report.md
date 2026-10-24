# UI / IPC 修复 — 2026-10-17

2026-10-25 的统一加载反馈、真实阶段与生命周期说明见 [桌面统一加载反馈](./loading-states.md)。

后续质量回归见 [质量验收记录](./ui-ipc-quality-acceptance.md)。Renderer store 的 `reportRevision` 仅在成功导入时递增，驱动默认报告 Tab 和 Report 本地状态重建；同一 DEM 的成功重导入也生效，解析/失败/取消不会递增。不改变报告 DTO 或分析业务语义。

本轮基线 `f143169a7c82dcdf811d27425344ab6fc784c1c1`，实现与自动验收见 [UI / IPC 验收记录](./ui-ipc-acceptance.md)。

- Renderer 只公开 `importDroppedFile(file: File)`；preload 用 Electron `webUtils.getPathForFile` 解析磁盘 File 后立即提交 `report:import-file`，不向 Renderer 返回路径，也不公开任意路径导入或通用 IPC。
- 无磁盘路径的合成 File 返回明确错误；Main 保留可信 sender/main frame、类型、非空绝对路径、扩展名和互斥校验。错误和取消保留已有报告；真正开始解析后旧回放会话失效。
- 雷达正方形尺寸使用父内容区（扣除 padding、border），无固定最小地图尺寸；ResizeObserver 与 DPR 变化监听更新 Canvas 并清理订阅。
- 导入按钮展开/折叠均有当前操作的可访问名称与 Fluent Tooltip。滚动验收检查实际可见面板及末项可达，并通过真实 DOM 裁切反向断言防止假通过。
- 当前代码的窗口最小尺寸为 **1024×640**。下方带日期的旧规格与验收仅为历史记录。

# Current Desktop addition — P6

原报告schema仍为v2，新增可选`replay`元数据，独立回放块schema v1。Utility以一次parseWithReplay
共享输入生成原Match/Spatial报告与回放，只保留≤64MiB序列化会话缓存；Main在报告返回后保留worker，
通过受信主frame/当前session/登记round-block读取≤1MiB块，取消/重导入/释放/关闭清理worker。
Renderer第五个mounted Tab为Canvas 2D+Fluent v9播放器，3块LRU，统一时钟，保守显示插值与文字入口。
Timeline/Findings可定位回合与精确tick，原数据/筛选/确定性算法不变。

地图来自维护阶段固定manifest提取的资源；按用户2026-10-16指令，仓库包含Dust2、Inferno、Mirage、Ancient、Overpass、Vertigo、Nuke、Anubis、Train、Cache十图的13张Valve PNG和10份原overview（Nuke/Vertigo/Train双层），来源/摘要见资源清单。
正常检出即可构建离线地图；`node scripts/prepare-replay-maps.mjs .tmp/p6-official`可从已验证提取目录重新准备图片，缺图时仍可构建/查看报告和事件。
Desktop构建缓存禁用，避免含图/缺图构建错误复用；build/pack校验所有现有图片摘要，不运行下载工具。
新接口、限制与本次实际验收以[Replay contract](./replay-contract.md)和[实施记录](./replay-implementation.md)为准。

# Historical Desktop contract — P5.7.8

**implementation complete / visual product acceptance pending**. 比赛报告 is the default of
four mounted tabs. The Utility Process invokes one shared-input `parseWithSpatial()` and the
existing five evidence analyzers once, then Findings V2 for every valid player. P3/V1/Timeline/
Analysis remain available on the same Match; V1 is titled 基础规则提示. Report schema is **v2**,
with JSON-only `deepReview` player DTOs; Renderer has no deep-review dependency. Evidence caveats
remain collapsed, context is neutral, and occurrence buttons reuse the existing Timeline linkage.
Implementation, tests, performance, screenshots and personal DEM debt: [Deep Review Desktop](./deep-review-desktop.md).
Final Acceptance **PAUSED**; Personal matchmaking / Perfect World **UNVERIFIED**.

---

# P5.1 桌面比赛报告 MVP

P5.1 打通了第一条可实际使用的桌面链路：

```text
选择 .dem
→ Electron Main（文件选择）
→ Utility Process（native parser → analytics → findings）
→ 可序列化 report DTO（IPC）
→ Renderer（Fluent UI v9 报告页）
```

不修改 P3 Analytics 语义与 P4 Findings 阈值，不在 Renderer 重算任何指标，不引入 AI/云端/历史库。

## 进程与数据边界

```text
Renderer (sandbox, contextIsolation, nodeIntegration=false)
  ↓ window.cs2Analyst.importDemo()          preload / contextBridge
  ↓ ipcRenderer.invoke('report:import')
Main (Electron)
  ↓ dialog.showOpenDialog（仅 .dem）
  ↓ utilityProcess.fork(dist/electron/report-worker.js)
Utility Process
  ↓ @cs2-analyst/dem-parser（native demoparser2）
  ↓ @cs2-analyst/analytics
  ↓ @cs2-analyst/findings
  ↓ { kind: 'success', report } | { kind: 'cancelled' } | { kind: 'error', message }
Main
  ↓ IPC resolve
Renderer（仅渲染 DTO，不访问 Node/fs/demoparser2）
```

- 原生解析与全部确定性计算都在 Utility Process（独立 OS 进程）中执行，200MB+ DEM 不会阻塞 Main 或 Renderer 线程。
- Main 负责文件选择、任务互斥、进度转发、超时（10 分钟）与受信窗口控制。
- Renderer 通过 preload 暴露的最小 API 访问能力；无 `require`、无 `fs`、无 parser 依赖。
- preload 暴露面：`version`、`importDemo()`、`onProgress(listener)` 与 `window` 的四个操作/查询及最大化状态订阅；`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`。

## P5.6.4 Custom Window Chrome — PASS

- Windows x64 BrowserWindow 使用 `frame: false`、`resizable: true`，1280×800 / 最小 800×600 / `#111821`；移除原生菜单，不使用 titleBarOverlay。三个安全开关保持原值。
- Fluent UI v9 自绘标题栏独立占据顶部 40px，左侧仅原创 20px currentColor target mark 与中等字重 CS2 Analyst；右侧三个 46×40px 方形按钮，16px 本地 SVG，最大化/双矩形还原图标随真实状态切换。弱 hover 使用现有 cardHover，关闭 hover 为 #c42b1c + 白色。
- 窗口壳层在报告错误边界外持续挂载。仅下方内容区滚动，让纵向滚动条从标题栏下方开始；标题栏和关闭按钮横跨整个窗口，内容最大宽度 1120px 与原 padding/gap 保留。
- 标题栏为 `-webkit-app-region: drag`；Logo、按钮及按钮容器明确 `no-drag`。页面内容没有 drag。双击由 Chromium/Windows 原生 drag region 处理，无重复 React 双击绑定。
- `window.cs2Analyst.window` 提供 `minimize / toggleMaximize / close / isMaximized / onMaximizedChange`。四个 invoke 分别对应 `window:minimize / window:toggle-maximize / window:close / window:is-maximized`；和 report:import 共用 `trustedWindow`，校验当前窗口未销毁、sender webContents 与 senderFrame 主 frame。无效请求不操作窗口。
- Main 在 maximize/unmaximize 时发送 `window:maximized-changed`；Renderer 先订阅，再查询初值，忽略落后于通知的初值响应，卸载移除 exact listener。关闭调用 BrowserWindow.close()，沿用 closed worker kill，窗口按钮不调用 app.quit()。
- 新增 `window-shell.test.mjs`：实际 Main/preload 源码执行于模拟 Electron，覆盖 frameless/security/options、伪 sender/subframe/stale sender、原生事件通知、preload IPC 路由/订阅清理、分析中关闭清理。共享 `window-shell-checks.mjs` 在真实 built/installed Electron 覆盖 DOM、尺寸、drag/no-drag、实际最大化/还原与内容溢出；installed ASAR 同时核对窗口安全配置与菜单移除。

2026-10-07 验证记录（基线 b353b325b232334d4a01e75a25fc5853220dc017）：

- typecheck 11/11、build 6/6、desktop 17/17、analytics 53/53、findings 17/17、parser 28/28；demo1 golden、Finding ruleId 顺序、Timeline/Analysis 与官方 kill-feed 资源不变。
- 真实 Electron 原生双击最大化/还原、Win+↑/↓图标同步、最小化再激活恢复通过。最终 UI 的 1280×800 / 900×760 / 800×600 为真实 BrowserWindow.setSize，不是 viewport 模拟；标题栏高度 40、关闭右边等于窗口宽度、页面/内容横向溢出均为 false。三个 hover computed styles 与截图通过。
- Browser plugin 不可用，沿用仓库真实 Electron CDP smoke；Windows 输入使用 Computer Use。截图在系统临时目录 `cs2-analyst-p564-qa`，不提交。最大化遵循 Windows 原生 workArea；不做负 margin 或自定义 resize handles。
- 一次并行构建/验证时报告 smoke 在 caption close 后等待退出超时；原因未证实，保留诊断，无产品修补。停止重叠构建后原脚本与完整 `pnpm --filter @cs2-analyst/desktop test:report` 串行重跑三场景均通过。
- 最终两次 pack 均 107.5MB，production/test-seam installed smoke 全链路通过：安装、ASAR frame/security/no-overlay/no-menu 配置、真实窗口控制、无 Node、路径注入防护、demo1 golden、Tab/Dropdown/Timeline/Analysis、损坏 DEM、caption close 分析中途清理与卸载。ASAR 2.13MB / 81 条目 / 71 官方 SVG 字节不变。
- 在真实 QA Renderer 临时制造报告 render 错误（不改源码或文件），错误边界显示恢复提示，同时 titlebar 与三个窗口按钮仍存在；恢复按钮可回到导入页。额外截图 error-recovery-shell.png。
- 真实鼠标拖动 PASS：Computer Use drag 未取得窗口位移证据后，用户用鼠标实测并明确确认“可以，提交并重新汇报吧”。此项依据用户实际操作确认；所有本轮验收已完成。

### P5.6.4 追加：全局滚动条 polish

- `theme.ts` 集中维护 scrollbar palette；Fluent UI `makeStaticStyles` 在 `DesktopShell` 挂载全局 pseudo selectors，页面、Timeline、Analysis 及 portal 滚动容器共用。
- 纵横占位均为 10px；2px 透明 border + padding-box 留出约 6px 圆角 thumb。蓝灰透明度为默认 .28 / hover .46 / active .62；track/corner 透明，无箭头按钮，无新增滚动事件或布局宽度规则。
- Firefox `thin` / `.36 transparent` 标准属性只在不支持 WebKit scrollbar selector 的引擎生效，避免 Chromium 标准属性覆盖定制尺寸与交互状态（[MDN](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Selectors/::-webkit-scrollbar)）。
- 2026-10-07：desktop typecheck/build 通过；系统临时脚本复用现有 Electron CDP report smoke，真实 DEM / 损坏 DEM / 非 DEM 三场景通过，无未捕获 Renderer 异常。1280×800 / 800×600 为模拟 Renderer viewport；两尺寸纵向滚轮/拖拽通过，额外 650×600 触发 Analysis 横向溢出并验证横向滚轮/拖拽。三 Tab 无整页横向 overflow，原生最大化后 titlebar/content 右边缘贴合 viewport。
- 截图在系统临时目录 `cs2-analyst-scrollbar-qa`，不提交；两尺寸 thumb 默认 / hover / active 像素分别为 RGB(55,64,76) / (77,87,101) / (97,108,123)，无接近白色状态；透明 corner computed style 通过。Firefox 与实体触控板未实测；业务、IPC、窗口控制逻辑无改动。

## IPC 契约（`@cs2-analyst/report-contract`）

`report-contract` 是 Electron 与 Renderer 共享的 JSON-only 展示契约，只依赖 `findings` 的类型。

```ts
interface DesktopMatchReport {
  schemaVersion: 2;
  match: { id: string; fileName: string; map: string; rounds: number;
           score: { initialCT: number; initialT: number } | null };
  selectedPlayer: string;                       // 默认 twinkle，否则第一名有效玩家
  players: { id: string; nickname: string }[];
  analytics: DesktopPlayerAnalytics[];
  findings: DesktopFinding[];
  timeline: DesktopPlayerTimeline[];            // 每名有效玩家一份回合时间线（只读投影）
  analysis: DesktopAnalysisViews;              // 冻结指标投影 + Timeline 回合事实
  deepReview: { available: boolean; players: DesktopDeepReviewPlayer[] };
}

type ImportPhase = 'selecting' | 'parsing' | 'analyzing';
type ImportResult =
  | { kind: 'success'; report: DesktopMatchReport }
  | { kind: 'cancelled' }
  | { kind: 'error'; message: string };
```

`DesktopPlayerAnalytics` 覆盖报告页展示的所有确定性结果：K/D/A、roundsPlayed、ADR、HS%、KAST、Trade、Opening、Utility（投掷计数、HE/fire 敌伤、flash 效果与助攻）与 Clutch list，另附 `coverage`。

`findings` 为 `DesktopFinding[]`：只在冻结的 Finding 证据上附加展示层字段 `evidence[].roundTimeSeconds`（回合内秒数），`metric/value/unit/round/tick` 与 Findings 语义完全不变。`roundTimeSeconds` 由 presenter 用真实数据计算 —— `(eventTick - roundStartTick) / tickRate` —— 缺少回合起点、事件 tick 或可靠 tick rate 时该字段缺省，UI 不猜测时间；原始 `tick` 仍保留在契约中供调试。

- `schemaVersion` 支持未来 DTO 演进。
- 不传匹配事件、`stateSnapshots`、`playerLifecycle` 或任何 native 对象；整份 DTO 可 `JSON.stringify`。
- 比分按“开局 CT 队 / 开局 T 队”归属：只有每个回合的胜方都能唯一映射回固定队伍时才输出，否则为 null（半场换边不改变队伍归属）。
- `findings` 携带全部玩家的 Findings；Renderer 按 `playerId` 过滤。每名玩家的 3 问题 + 2 亮点限额由 Findings Engine 决定，UI 不重新排序。

## 状态与错误处理

```text
idle → selecting → parsing → analyzing → success
                                     ↘ error
```

- `selecting / parsing / analyzing` 期间按钮禁用并显示 Spinner 与阶段文案。
- 取消选择回到 `idle`（已有报告时回到 `success`，保留上一次报告）。
- 损坏 DEM、缺失文件、解析异常：Utility Process 捕获后返回结构化错误，Main 透传给 Renderer，页面显示 `MessageBar` 错误并保留“重新选择 DEM”入口，不白屏。
- 同一时间只允许一个导入任务；重复请求返回“已有分析任务正在运行”。
- 导入期间关闭窗口会终止 Utility Process。
- Renderer 侧有 React Error Boundary；渲染异常时降级为错误提示与重新选择入口。

## UI 页面结构

统一使用 Fluent UI v9：主题在 `webDarkTheme` 之上覆盖中性色 token（`apps/desktop/renderer/src/theme.ts`），形成深蓝灰体系；组件只读取 token 或 `palette`，不散落固定色值。

1. **页头**：产品名 + “选择 DEM / 重新选择 DEM”主按钮。
2. **进行中**：Spinner + 阶段文案（提示大型录像可能需要数十秒）。
3. **错误**：`MessageBar`（intent=error）。
4. **空状态**：引导选择 DEM；文件只在本机处理。
5. **报告页**
   - 比赛头：地图、比分（开局 CT 队 / 开局 T 队）、回合数、文件名，以及目标玩家 `Dropdown`。
   - 玩家指标网格：K / D / A、ADR（每回合平均有效伤害）、HS%（爆头率）、KAST（回合贡献率）、Trade rate（死亡后队友补枪率）、Trade kills（补枪击杀）、Opening（首杀对决）、Clutch（残局）。Trade 卡片显示“4 / 18 次死亡后队友完成补枪”，KAST 与 Trade 附证据完整性提示。
   - 指标帮助：8 张核心卡片与道具面板标题统一提供低调的 `?` 入口（Fluent UI v9 `Tooltip`，`relationship="description"`）。触发元素是真实的 `Button`，因此 hover、点击聚焦与键盘 Tab 都能打开说明；每张卡的入口都有中文 `aria-label`（如“ADR说明”）。文案只解释既有指标含义，不改变任何口径。
   - 数字格式（仅展示层）：秒数与 ADR 两位小数、百分比一位小数（KAST 保持整数）、整数计数零位；`—` 表示证据不足。底层 evidence 数值不截断。
   - 证据告警：仅当展示的数值受不完整证据影响时显示（参与、伤害归属、回合贡献率 / 补枪 / 残局、道具计数/伤害/助攻）。
   - Findings（视觉重点，左侧宽栏）：最多 3 个问题 + 2 个亮点，显示中文严重度徽章、标题、summary 与可展开的逐条证据。证据行只做展示层中文化（中文指标名与中文单位），数据仍然是契约里的 metric / value / unit；带 `round` 的证据显示 `R4 · 回合开始后 26.63 秒`（由 `roundTimeSeconds` 计算），原始 `tick` 只在 `title` 次级提示中保留，默认不展示。
   - 回合时间线（独立一级 Tab）：每回合一行摘要（回合号 / 目标玩家阵营 / 胜负 Badge / 回合结束比分 / 查看详情），点击展开该回合关键事件，默认全部收起；Findings 的 `relatedRounds` 提供“查看 R24 / 查看相关回合”联动（先切 Timeline Tab + 展开 + 滚动 + 短暂高亮）。详见下节。
   - 布局约束（P7 人工验收第 2 轮）：比赛回放底部进度条 / 时间 / 阶段标签只占左侧地图列并与地图容器左右对齐，右侧“玩家状态 + 关键事件”独立成列，关键事件卡片填满剩余高度且列表内部滚动；回合时间线取消视图级滚动，主卡片占满剩余高度，24 回合只在卡片内部滚动；热力图首行与回放工具栏一致（左标题 / 中部三图层切换 / 右地图版本标签）；Findings 区块标题改为“简要分析”，原副标题迁入标题旁 `?` Tooltip。
   - 道具与残局（右侧）：道具卡片标题为“道具”，使用 Fluent `TabList` 两个选项卡。“投掷统计”（默认，图表统计图标）逐行显示闪光弹 / 烟雾弹 / 高爆手雷 / 燃烧弹 / 诱饵弹（每行统一风格图标 + 中文名称 + 右对齐计数；燃烧弹与燃烧瓶合并显示为“燃烧弹”，投掷量求和）；“伤害统计”（本地交叉双刀图标）保留同一行名称与图标，只把右侧数字替换为伤害 / 效果值：闪光弹按“致盲敌人/队友受闪/闪光助攻”显示（如 `30/13/2`，数字可 hover / focus 查看顺序），高爆手雷显示对敌伤害，燃烧弹显示燃烧伤害，烟雾弹 / 诱饵弹显示 `-`；合法零值保留 `0`，`—` 仍表示证据不足。道具图标来自渲染层本地彩色实心图标集 `renderer/src/utility-icons.tsx`（24px 网格、统一 22px 显示尺寸，颜色登记在 `theme.ts` 的 `palette.utility`），与界面自身的单色线性图标 `renderer/src/icons.tsx` 分开存放，道具列表不混用两套风格；图标 `aria-hidden`，含义由同一行的中文名称承担，不依赖颜色表达数据含义。卡片底部不再重复口径说明，完整统计口径与不完整证据提示位于标题旁 `?` Tooltip。残局面板与道具面板同样逐行对齐：`回合 / 局面 / 结果` 三列（`R24`、`1v3`），结果用 `Badge` 标签展示（成功 / 失败 / 结果未知，成功为绿色、失败为红色、未知为琥珀色，颜色只强化标签文本），不新增任何结果推断。

## 视觉体系（P5.4）

纯展示层：只改 Renderer 的主题、颜色、图标与排版，不改 Analytics / Findings / report DTO 语义。

- 主题集中在 `apps/desktop/renderer/src/theme.ts`：在 `webDarkTheme` 之上覆盖 Fluent UI 中性色 token，页面与所有 Fluent 组件（Card / Divider / Badge / Dropdown / Tooltip / MessageBar）共用同一套深蓝灰；组件只读取 token 或 `palette`，不散落固定色值。
- 背景层级：页面 `linear-gradient(180deg, #161d26 0%, #111821 100%)`，卡片 `#1d242e`，弱边框 `rgba(148, 163, 184, 0.12)`，行分隔 `rgba(148, 163, 184, 0.08)`，文字 `#e8eef6` / `#c5cfdc` / `#8f9db0`。主进程窗口底色同步为 `#111821`，启动时不再闪出黑灰底色。
- 卡片：统一 6px 圆角（`tokens.borderRadiusLarge`）、1px 弱边框、无阴影（关闭 Fluent Card 默认投影）。
- 列表节奏：道具两个选项卡 / 残局共用同一行高（34px）与分隔线；标题层级固定为 Title1（地图）→ Title2（区块）→ Subtitle1（面板）→ Caption1（说明）；正文以中性灰为主，数值右对齐并使用等宽数字。
- 颜色只做视觉锚点：6 个道具图标（闪光弹 `#4DB6FF`、烟雾弹 `#B9C7D9`、高爆手雷 `#FF5A36`、燃烧弹 `#FF8A1F`、燃烧瓶 `#FFB13B`、诱饵弹 `#57D68D`）、Findings severity 徽章、残局成功 / 失败徽章，以及主按钮等少量交互态。核心数值、卡片标题与正文保持白色 / 中性灰。
- 状态语义色（MessageBar、状态徽章）继续使用 Fluent 的状态 ramp，保证错误与告警的对比度，不参与中性色重映射。
- 选择器统一使用 `apps/desktop/renderer/src/winui-select.tsx` 的 `WinSelect`（Fluent `Dropdown` + 共享 `WinOption`）：比赛库筛选、热力图筛选、目标玩家、对比指标、回放楼层 / 倍速 / 回合都打开同一套应用内列表，不再使用 Fluent 原生 `Select` 的系统菜单样式。列表项输出 `data-value`，供 Electron 验收脚本按选项值定位。

## 回合时间线（P5.5）

独立一级“回合时间线” Tab 内提供 section（`renderer/src/main.tsx` 的 `RoundTimeline`）：

- 每回合一行摘要：`R24 · T · 成功 · 13 : 11 · 查看详情`。点击该行展开 / 收起该回合关键事件，默认全部收起，不会一次展开 24 回合。
- 展开后击杀 / 死亡逐行显示 kill-feed：`+122.20 秒　twinkle　[AK-47 图标]　tarkz`：时间为回合开始后的秒数，武器按展示名映射，昵称来自玩家映射；不显示 SteamID，也不显示原始 tick。
- 颜色只用于成功 / 失败 / 结果未知 Badge 与联动时的短暂高亮，正文保持中性色。

### DTO

`report-contract` 新增只读展示类型（additive，`schemaVersion` 仍为 1）：

```ts
interface DesktopTimelineEvent {
  id: string;
  type: 'kill' | 'death' | 'bomb-plant-start' | 'bomb-planted'
      | 'bomb-defuse-start' | 'bomb-defused' | 'bomb-exploded' | 'clutch-start';
  tick: number;                 // 原始 tick 仅用于追溯，UI 不展示
  roundTimeSeconds?: number;    // (tick - round.startTick) / tickRate，证据不足时缺省
  actorId?: string; actorName?: string;
  targetId?: string; targetName?: string;
  weapon?: string;
  headshot?: boolean; assistedFlash?: boolean; // KillEvent 原样投影，缺失不猜测
  opponents?: number;
  description: string;
}
interface DesktopRoundTimeline {
  round: number;
  side: 'CT' | 'T' | 'Unknown';
  result: 'win' | 'loss' | 'unknown';
  scoreAfter: { initialCT: number; initialT: number } | null;
  startTick: number | null;
  events: DesktopTimelineEvent[];
}
interface DesktopPlayerTimeline { playerId: string; rounds: DesktopRoundTimeline[]; }
```

`DesktopMatchReport` 增加 `timeline: DesktopPlayerTimeline[]`：每个有效玩家一份 24 回合时间线，JSON-only。切换目标玩家时 Renderer 只按 `playerId` 选用对应数组，不重新解析 DEM、不重跑 Analytics。

### 计算方式（全部为展示层投影）

- `side`：目标玩家在该回合 `freeze_end`（缺失时回退 `start`）快照中的 side，要求 `participant === true` 且已知；否则 `Unknown`。
- `result`：`round.winner` 与目标玩家 side 都已知时为 `win` / `loss`，否则 `unknown`。
- `scoreAfter`：用第 1 回合 `freeze_end` 名单把每回合胜方唯一映射回固定队伍后的累计比分；一旦某回合无法唯一映射，该回合及以后都为 `null`（与页头比分同一口径，半场换边不改变队伍归属）。
- `roundTimeSeconds`：`(eventTick - round.startTick) / tickRate`；缺 tick rate、回合起点、事件 tick 或得到负值时不输出该字段，UI 显示 `—`。
- 事件只在正式回合窗口 `[startTick, endTick]` 内取用；窗口不完整时该回合不输出事件，避免把回合结束后的事件算进来。

### 事件过滤

只展示高价值事件：目标玩家击杀、目标玩家死亡（死后击杀同样保留，不因击杀者已死亡而删除）、已证实的 clutch 形成点（直接复用 Analytics 已解析的 clutch tick 与对手数，不重写算法）与炸弹生命周期（`plant_start / planted / defuse_start / defused / exploded`）。`pickup / drop`、damage、weapon_fire、utility effect、flash victim、snapshot 一律不进入 Timeline。

### Findings → Timeline 联动

带 `relatedRounds` 的 Finding 显示“查看 R24”（单回合）或“查看相关回合”（多回合）。点击后切换到回合时间线 Tab，展开对应回合，在 React 提交可见 panel 后平滑滚动到第一个相关回合并短暂高亮（约 2.4 秒）。没有 `relatedRounds` 的 Finding 不显示按钮；`relatedRounds` 与 Findings 排序仍由 Findings Engine 决定，UI 不重算。

## 验证

- 真实 `demo1.dem`（267MB）经完整 Electron 链路：twinkle 25/20/4、ADR 91.375、KAST 75%、Trade 22.2%、R24 1v3 残局获胜。
- Findings 默认输出（ruleId 顺序不变）：`side-impact.ct-gap` 中文化标题“CT 方 ADR 明显低于 T 方”、`trade.low-rate`“死亡后队友补枪偏少”、`team-flash.frequent-effects`“本场多次闪到队友”、`clutch.win.r24`“R24 1v3 残局获胜”、`opening.positive`“本场首杀对决贡献突出”。
- P5.3 展示层验收：demo1 的 R4 受闪队友证据（`tick 17120`，R4 `startTick 15416`，tickRate 64）显示为“回合开始后 26.63 秒”；同一证据的原始受闪时长 4.866097927093506 秒显示为“4.87 秒”；证据行不再出现 `tick <n>`；Renderer 未新增任何 Analytics 重算。
- P5.5 展示层验收：桌面端到端 smoke 断言 24 个回合摘要、R24 摘要为 `T / 成功 / 13 : 11` 且默认收起、Finding `查看 R24` 联动展开 R24 并高亮、R24 展开包含 `进入 1v3 残局` 与炸弹安放事件且时间形如 `+109.81 秒`、展开内容不含原始 tick；手动展开 R7 为 twinkle 3K + 成功拆弹；切换到 tarkz 后 R24 变为 `CT / 失败` 且比分仍为 `13 : 11`；损坏 DEM 不渲染时间线。Node 集成测试另覆盖 DTO JSON 可序列化、昵称映射、`(tick - startTick) / tickRate`、缺 tick rate 不显示时间、窗口不完整不输出事件、未知 side/result/score 不猜测与同输入确定性。
- Tooltip 覆盖：核心 8 张指标卡 + 道具面板共 9 个 `?` 入口，桌面端到端 smoke 通过 DOM 断言其数量。
- 损坏 DEM：错误提示 + 可重新选择，不白屏。
- 测试：桌面 Node 集成测试 7/7；桌面 Electron 端到端 smoke（真实 DEM + 损坏 DEM + 非 .dem）通过；analytics、findings、dem-parser 全量通过；`pnpm typecheck`、`pnpm build`、现有 UI `test:smoke` 通过。
- 命令：`pnpm --filter @cs2-analyst/desktop test`（Node 集成）、`pnpm --filter @cs2-analyst/desktop test:report`（Electron 端到端）、`pnpm test:smoke`（UI/preload/构建）。
- 安装版：`pnpm --filter @cs2-analyst/desktop pack:win` 产出安装包，`pnpm --filter @cs2-analyst/desktop test:installed` 对安装后的应用重跑真实 demo1 与损坏 DEM 场景。

## 测试专用路径注入

Electron 端到端测试需要绕过原生文件对话框。Main 在**非打包构建**下读取 `CS2_ANALYST_DEM_PATH` 作为导入路径；打包应用始终使用原生对话框。Renderer 与 preload 不感知该变量。

## 打包与安装

P5.2 已把该链路做成可安装的 Windows 版本（electron-builder + NSIS，Utility Process 依赖全部打进 bundle，原生 parser 以 asar-unpacked 分发）。方案、安装包内容、路径兼容、测试 seam 与安装版 E2E 见 [Windows 打包与安装](./windows-packaging.md)。

## 剩余缺口（v0.1 日常使用之前）

- GUI 文件选择之外的便利性：无最近文件、历史比赛库、CS2 demo 目录自动扫描。
- 报告深度：无完整播放器 / 地图热力图；比分只按开局阵营展示，未关联队伍名。
- 大规模 DEM 的进度反馈仍是阶段级（selecting/parsing/analyzing），无百分比。
- Utility 实际致盲时长、战术价值与低影响回合仍未在 Analytics 中证实，报告如实标注而不猜测。
- Analytics/Findings 语义保持冻结；未来扩展需独立需求与迭代。

## 玩家名称展示（P5.6.1）

统一由桌面 presenter 的 `displayPlayerName` 处理 report.players、Timeline actorName / targetName 与 Analysis Views 名称，Dropdown 复用 report.players：nickname 有值且 trim 后非空时原样展示（包括首尾空白、长数字、与 playerId 相同的昵称）；仅缺失、null、空白昵称显示“未知玩家”。过长内容只用 CSS 省略并由 Fluent Tooltip 展示全文。原始 playerId / actorId / targetId 保留在 DTO，仅用于身份关联，正文不回退到 ID。

## 分析视图（P5.6）

共享比赛头、目标玩家 Dropdown 与重新选择 DEM 按钮下方新增 Fluent UI v9 `TabList / Tab`：默认“比赛报告”，另有“回合时间线”和“分析”。核心数据、Findings、道具、残局在比赛报告中；完整 Timeline 在回合时间线中。三个 Tab panel 保持挂载，通过 hidden 切换；不触发导入、解析或 Analytics，保留目标玩家、Findings 展开与 Timeline 展开状态、分析指标选择。

`DesktopMatchReport.analysis` 是 additive JSON-only presentation DTO，schemaVersion 仍为 1：

- `players: DesktopPlayerComparison[]`：直接投影冻结 PlayerMetrics 的 K/D/A、kdRatio、ADR、HS%、KAST percentage/complete、opening winRate、tradeRate/complete/tradeKills；名称统一使用 displayPlayerName。Opening winRate 保留 0～1 fraction，其余 percentage/rate 保留 Analytics 的 0～100 单位；只有显示时格式化。
- `perPlayer: DesktopPlayerAnalysis[]`：每人 roundTrend、sideSplit 与 multiKills。multiKills 直接投影 frozen `PlayerMetrics.multiKills.counts[2/3/4/5]` 为 double/triple/quad/fivePlus，最后一项是单回合 5 次及以上击杀。CT/T 只投影 `p.side.CT/T` 的 roundsPlayed、K/D/A、ADR，不遍历事件重算。roundTrend 只计数既有 Timeline 中的 kill/death，复用 side/result；不加入伤害、ADR、KAST、rating 或任何新算法。`complete` 表示正式回合窗口存在；窗口缺失时 UI 显示 — 和证据不足，不把空事件当成已证实的零击杀/未阵亡。

分析页三块：

1. 全场玩家对比：完整名单的横向条形图，默认 ADR，支持 K/D、KAST、HS%、首杀对决胜率、死亡后队友补枪率、补枪击杀。当前指标降序、null 排最后；null 无柱且显示 —，零值保留 0。当前玩家名称与柱统一使用 `palette.currentPlayer = #62abf5` 并标“· 当前”，其余中性蓝灰。每行精确值和 Fluent Tooltip 支持 hover/键盘聚焦。KAST/Trade 不完整时显示“部分证据”与提示，tradeKills 同样标记不完整。
2. 回合表现趋势：当前玩家每回合击杀数离散柱图，不连线、不堆叠 death、无双 Y 轴。回合号、胜负与存/亡标签以及 Tooltip 的阵营、结果、击杀数、死亡状态保留全部事实；窄窗口仅图表内部横向滚动。
3. CT / T 表现对比：两列展示回合数、K/D/A、ADR；ADR null 显示 — 与证据不足说明。不同单位不共享坐标轴。

简单柱图使用 CSS 布局和 Fluent UI v9 Tooltip/Badge/Card/Dropdown，无新增图表依赖。ADR/KD 两位、各百分比一位、tradeKills 整数；底层 DTO 精度不截断。

Golden：demo1 twinkle R7 = CT/成功/3K，R24 = T/成功/4K/未阵亡，R22 = T/失败/1K/阵亡，保留死后击杀事实；CT = 12 回合、10/10/3、68.25 ADR，T = 12 回合、15/10/1、114.50 ADR。集成测试覆盖指标原值/单位、null、incomplete、排序、格式、窗口缺失与 JSON 序列化；桌面 smoke 覆盖七项指标、10 名玩家、Tooltip、golden、Tab 状态保留与换玩家联动。


## Report UX Polish（P5.6.2）

仅扩展 presentation DTO 和 Renderer：不改 Analytics / Findings 公有契约、算法、阈值、排名、Timeline 事件筛选、回合时间或 nickname 原样规则。schemaVersion 仍为 1，Windows x64 only，版本 0.1.0。

- 三个一级 Tab：比赛报告 / 回合时间线 / 分析。所有 panel mounted，通过 hidden 切换；目标玩家、Timeline 展开、Findings details 与 Analysis 指标选择保留，不重新解析或重跑 Analytics。Finding 查看回合入口切换 Timeline，展开后由提交后 effect + requestAnimationFrame 滚动，保留约 2.4 秒高亮。
- 原生 evidence summary 使用 pointer、轻量 hover 背景和 2px focus-visible outline；仍支持原生键盘展开。
- 玩家对比当前名称（含“· 当前”）与 bar 都读 currentPlayer token；其他玩家保留中性色。
- 趋势底部用 flex / 48px column gap / wrap 分隔存亡说明与多杀统计。稳定按双杀、三杀、四杀、五杀+ 排序；0 项完全省略，全 0 不渲染整组。demo1 twinkle 原始 counts 投影为 6 / 1 / 1 / 0，展示“双杀 6 三杀 1 四杀 1”。R7 3K、R24 4K 与原有趋势事实一致。
- CT/T 使用中间独立 1px divider（palette.rowDivider），上下各留 16px；≤650px 改为上下排列并隐藏竖线。
- Timeline kill/death 使用独立 KillFeedEvent 四列：时间 / attacker / icon cluster / victim。原有 bomb/clutch 事件继续文字展示。新增 headshot、assistedFlash 可选字段只从 KillEvent 投影，true 才展示对应图标；无攻击者以世界伤害 / 无已知攻击者降级，不伪造名字。
- killfeed-icons.tsx 自绘单色 currentColor 简化 SVG（22px），与彩色 utility-icons.tsx 分离。覆盖当前 weaponLabels 武器和 knife_* variants，允许同类武器共用 silhouette；未知 identifier 使用 generic，Tooltip 和整行 aria-label 保留真实文本。图标 aria-hidden；整行可聚焦且可读，姓名省略 + 全名 Tooltip，时间 tabular-nums，图标不被长昵称挤掉。
- R24 twinkle 使用 AK-47 击杀 tarkz（+122.20 秒），以及 R22 tarkz 死后 HE 击杀 twinkle（+32.78 秒）通过实际 Renderer / installed 断言；长数字昵称保持原样。

验证增加共享 Electron CDP `scripts/report-ux-checks.mjs`，开发构建与安装版使用同一组断言。无 Browser 插件，沿用仓库现有 Electron E2E。Node synthetic 测试覆盖 flag 缺失/false/true、未知武器、world fallback、武器覆盖、全零/部分零 multi-kill 与 fivePlus 文案；真实 DEM 的 DTO 与独立 Frozen Analytics 原值比较。截图输出在系统临时目录 `cs2-analyst-p562-qa`，涵盖 1280×900 / 900×760 / 800×600，另测 650px breakpoint。截图、安装包和临时 profile 不提交。

P5.6.2 验证全 PASS：pnpm typecheck（11/11）、pnpm build（6/6）、desktop test（14/14）、test:report（三场景）、analytics（53/53）、findings（17/17）、dem-parser（28/28）、dev/preview test:smoke、pack:win、pack:win:test、test:installed。两轮独立审查无阻塞；安装版重跑共享 UX 断言，生产 seam 防护、原生绑定 unpacked、损坏 DEM、中途关闭无残留 worker、两版卸载均通过。安装包约107.3MB，ASAR 1.41MB / 10条目。


## Official Kill-feed Assets（P5.6.3 PASS）

基线 f3ddfd89c2d86f32b112706f720b41f4193dff82。只替换 Renderer 资源、asset mapping 与验证；Parser、Analytics、Findings、Timeline DTO / tick / round time / 事件排序均未修改。

- 原始武器来源 <repo>\output\equipment，继续复用之前的本机 CS2 提取结果。定向补充来源 output/targeted-deathnotice：使用已有 ValveResourceFormat 从 pak01_dir.vpk 提取10张 HUD SVG与equipment flash assist，不重提equipment、不下载工具。
- 正确HUD目录是 panorama/images/hud/deathnotice/，爆头文件为 icon_headshot.vsvg_c。旧 panorama/images/icons/death_notice/ 是错误源路径；项目death-notice目录仅为本地组织。闪光助攻来自 panorama/images/icons/equipment/flashbang_assist.vsvg_c。提取器本机README、筛选路径与映射文件名均已修正；可复现命令与完整来源见 [官方kill-feed资源](./cs2-killfeed-assets.md)。
- 复制71 SVG / 0 PNG：69武器 + 2 death notice。原图字节未修改，provenance.json保存精确VPK路径与SHA-256。只将当前UI所需素材纳入仓库；其余9张HUD图标留在本地output备用，不打包或新增判定。
- killfeed-assets.ts 静态 import + 显式72 identifier映射，含knife_bayonet → bayonet、kukri → knife_kukri、p2000 → hkp2000；补齐CZ75、R8、消音器关闭标识。24张官方刀图覆盖26刀标识，各variant使用实际文件，不猜路径。
- HeadshotIcon / FlashAssistIcon 均使用官方img，仅当原DTO flag === true时显示；没有自绘回退。未知weapon / 未知刀型与空world.svg使用简单圆环neutral fallback；Tooltip和整行aria-label保留原有完整事实。自绘weapon shapes全部删除，无双套实现。
- img高22px、自然宽度、object-fit contain，武器最大96px、notice最大24px；alt空且aria-hidden。无白底、背景框、阴影、拉伸、图形编辑或新依赖；四列kill-feed与nickname原值/ellipsis/Tooltip保持既有规则。
- Vite assetsInlineLimit=0、base='./'，静态图片进入dist/renderer/assets与ASAR，运行时不读取CS2安装目录或提取目录。dev/preview解码全部图片，安装版核对ASAR内源资源字节并实际解码生产图片URL。
- demo1 R24官方AK-47与inferno、R22死后HE（+32.78秒）与flash assist均通过；R24没有headshot flag，另用R23 M4A1-S爆头死亡验证官方headshot，未修改DTO构造事件。Golden 25/20/4、ADR91.375、KAST75%、Trade22.2%、R24 1v3与Findings ruleId顺序不变。
- 截图系统临时cs2-analyst-p563-qa，1280×900 / 900×760 / 800×600 / 650×760；实查R24/R22/R23无白底、拉伸、broken image或整页溢出，昵称与图标居中。Browser plugin not available，使用项目已有Electron CDP E2E。
- 当前通过typecheck11/11、build6/6、desktop15/15、test:report三场景、analytics53/53、findings17/17、parser28/28、dev/preview test:smoke。pack:win / pack:win:test / test:installed最终全通过：两安装包均107.5MB；ASAR2.13MB/81条目/71官方SVG，逐图与源码字节一致，生产图片URL全部可解码。生产启动/路径注入防护/卸载、测试seam真实demo共享UX/损坏DEM/中途关闭无worker/卸载通过。独立审查无阻塞；71个资源均与实际提取字节一致，独立Renderer测试4/4。

安装测试记录：补齐headshot后的首次installed run在生产防注入断言处出现demo报告而失败；生产ASAR seam缺省检查与资源检查已通过。未修改产品代码或安装包，随后重跑test:installed全通过。用户随后确认：测试期间其手动在原生文件对话框选择了DEM，正常导入产生报告，导致自动化“不得出现报告”断言失败。生产路径注入防护正常，此次失败由测试期间的人工操作造成，不是资源改动、路径注入或产品缺陷。

## 2026-10-08 — P5.6.5 Branding & App Icon — FINAL PASS

- 正式产品名：CS2 Analyst；mark 为不带文字的 A/准星透明 PNG；lockup 为带 CS2-ANALYST 文字版。源文件来自用户 Downloads/cs2-analyst/logo.png 与 logo_with_appname.png，原图字节保留，项目路径为 apps/desktop/resources/branding/cs2-analyst-mark.png 与 cs2-analyst-logo.png。
- Windows icon 为真正 multi-resolution ICO：16/24/32/48/64/128/256；alpha 保留，原始画布完整保留，增加对称 4% safe area，独立 Lanczos 缩放。16/24/32 小尺寸图实查可辨，无重绘/改色/背景填充。
- titlebar：20px PNG mark + CS2 Analyst，object-fit:contain，40px 高度与 logo no-drag 保留；临时 target SVG 已删除。Renderer/favicon 使用 PNG，BrowserWindow dev/preview 使用相对 bundle 路径，安装版使用 extraResources runtime PNG；Windows/NSIS 使用同源 ICO。
- productName/executableName/shortcutName/uninstallDisplayName：CS2 Analyst。生产 App ID：com.evanpatchouli.cs2analyst；test seam：com.evanpatchouli.cs2analyst.testseam；Main AppUserModelId 同步。
- 用户追加要求全仓 rename：workspace 包统一 @cs2-analyst/*，bridge 为 window.cs2Analyst，环境变量/编译宏为 CS2_ANALYST_*；lockfile、脚本、测试、文档同步。物理 checkout 路径未搬迁。业务文件仅 import 标识替换，无 DEM/Analytics/Findings/Timeline/Analysis 算法修改，官方 kill-feed SVG 字节不变；provenance 提取目录改为项目相对 output 路径。
- PASS：pnpm typecheck 11/11、pnpm build 6/6、desktop 17/17、analytics 53/53、findings 17/17、dem-parser 28/28；test:report 真实/损坏/非 DEM 三场景；test:smoke dev/preview；pack:win、pack:win:test。真实 DEM golden 与 Findings 顺序未变。
- 产物：release/0.1.0/CS2-Analyst-Setup-0.1.0.exe（115186098 字节，109.9 MiB）；test seam .tmp/test-output/0.1.0/CS2-Analyst-TestSeam-Setup-0.1.0.exe（115186071 字节，109.8 MiB）。版本保持 0.1.0。ASAR 3.26 MiB / 82 条目 / 71 官方 SVG；runtime mark 与原图字节一致。
- 已实际验证：生产 EXE、installer、uninstaller 内嵌七尺寸图标 payload 与项目 ICO 一致；桌面/开始菜单快捷方式图标目标及 AppUserModelId；Programs/Apps DisplayName、DisplayIcon、卸载名称；DisplayIcon 指向 NSIS 安装的 uninstallerIcon.ico，字节与项目 ICO 相同。
- 历史验收说明：完整 test:installed 首次因 DisplayIcon 路径断言口径错误而失败，断言已修正且另一次生产安装验证通过；完整生产/测试 seam installed regression 未再次整套重跑，任务栏/Alt+Tab/真实拖动的部分视觉项也未补齐。
- Product Owner 于 2026-10-08 明确决定上述未执行项不再作为 P5.6.5 阻塞条件，并亲自批准 **FINAL PASS**。该结论不等价于声称这些检查已经执行通过；保留此记录用于事实追溯。实现提交为 `dbdd710529a7cb2ed021dd2a4d09325ed196abf9`。

