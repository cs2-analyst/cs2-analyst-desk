# CS2 Analyst Roadmap

**Supported platform: Windows x64 only.** CS2 Analyst 只面向 Windows x64 构建、验证与分发；macOS / Linux 不在路线图内，packaging 流程也不包含跨平台分支。

## P0 Foundation

- Electron desktop foundation
- Monorepo structure
- AI collaboration workflow

## P1 DEM Import

- Import CS2 demo files
- Parser adapter
- Match metadata extraction

## P2 Domain Model

- Match
- Player
- Round
- Event

P2.1 Combat Event Model 已完成：具体伤害、开火、投掷物生效、闪光受害者、炸弹事件，击杀助攻/阵营及回合起止证据。详见 [字段映射与 P3 前置缺口](./combat-event-evidence.md)。

P2.2 Round Participation & Player State 已完成：精确 start / freeze end / end 有界快照提供名单、阵营与存活状态，离散 spawn / disconnect / side_change 提供已验证的生命周期证据。详见 [P2.2 证据、覆盖限制与 P3 开工边界](./round-state-evidence.md)。P3 可按覆盖条件开工；重连和回合内重生仍需其他真实样本验证。

## P3 Analytics Engine

> **P3 Analytics Engine — FINAL PASS。** Analytics public contracts frozen for P4 Findings。跨指标一致性、coverage contract、API 稳定性与 demo1 golden 已通过 Final Acceptance；invariant tests 见 `packages/analytics/tests/acceptance.test.mjs`，完整定义见 [P3 核心指标、KAST / Trade / Clutch 与覆盖机制](./analytics-metrics.md)。

P3.1 Core Player Metrics & Coverage 已完成：K/D/A、K/D、HS%、rounds played、reported damage / effective damage、reported ADR / 标准 ADR、CT/T split、multi-kill、opening kill/death，配套统一 coverage/eligibility 与伤害 HP 轨迹确认机制。

P3.2 Combat Metrics（KAST / Trade / Clutch）已完成：基于 freeze_end 名单快照 + 正式回合窗口 + 死亡事件 + end 快照核验的统一存活时间线；KAST（K/A/S/T，缺证据退分母而不是猜 miss）；trade kill / traded death / tradeable death 与 5 秒 tick 窗口（tick rate 不可靠时抑制时间型结论，同 tick 记 ambiguous）；clutch opportunity / clutch win 与 lifecycle 异常整回合不输出。coverage issue 按 unavailable / ambiguous / degraded / informational 分类。

- Basic player statistics（P3.1 已完成第一批）
- Combat metrics（P3.2 KAST / Trade / Clutch 已完成）
- Utility metrics（P3.3 已完成）：release-only 投掷计数、HE/fire 敌方 HP loss、enemy/team/self flash 事件及原始 duration、death flag flash assist；重叠实际时间未获证实而返回 null。见 [Utility Analytics](./utility-analytics.md)。

## P4 Findings Engine

P4.1 Findings MVP — **PASS**。冻结 MatchAnalytics → 确定性规则 → Finding[]；实现 CT/T 伤害落差、补枪率偏低、首杀对决正负影响、伤害道具直接敌伤与明确闪光支援、队友受闪纪律、单次残局亮点六类。每名玩家默认最多 3 个问题 + 2 个亮点，不调用 AI、不修改 P3。

Schema、阈值、coverage 门控、priority、真实 twinkle 输出与 future gaps 见 [Findings Engine](./findings-engine.md)。Low-impact/consistency 因冻结 API 无逐玩家回合 combat evidence 跳过；实际 flash duration/战术位置价值仍需可靠 Analytics 证据。后续扩展需要独立明确需求，不建设大而全规则系统。

## P5 Desktop Report UI

> **P5 — COMPLETE. v0.1 Final Acceptance — FINAL PASS (2026-10-09).** Product Owner accepted the product and explicitly waived the remaining manual production walkthrough evidence that was interrupted to avoid interfering with unrelated work; waived checks are not represented as executed.

P5.1 End-to-End Desktop Report MVP — **PASS**。首次打通 `选择 .dem → Main 文件选择 → Utility Process 解析/分析 → Findings → Renderer 报告页`。Renderer 只在 sandbox + contextIsolation 下消费 JSON-only `@cs2-analyst/report-contract` DTO，不接触 Node/fs/demoparser2；原生解析与全部确定性计算在 Utility Process 中执行。report-contract `schemaVersion: 1` 为后续演进预留。实现、进程边界、IPC 契约、状态机、UI 结构与剩余缺口见 [桌面比赛报告](./desktop-report.md)。

P5.2 Windows Packaging & Installable MVP — **PASS**。使用 electron-builder + NSIS 产出 Windows x64 安装包（`CS2 Analyst`，版本沿用项目版本）。Utility Process 的 workspace 依赖全部打进 `report-worker.js`，原生 parser 以 asar-unpacked 形式随安装目录分发，安装版不再依赖 pnpm workspace symlink；仍不包含签名、自动更新或发布流程。安装版 E2E 覆盖安装/启动、Renderer 无 Node 暴露、真实 demo1.dem 报告、损坏 DEM 错误、分析中途关闭无残留 worker 与卸载。见 [Windows 打包与安装](./windows-packaging.md)。

P5.3 报告页可读性与说明优化 — **PASS**。纯展示层：Findings 证据不再默认显示原始 tick，改为按 `(eventTick - roundStartTick) / tickRate` 计算的“回合开始后 N 秒”；统一数字格式（秒/ADR 两位小数、百分比一位、整数计数零位）；Trade 文案改为“4 / 18 次死亡后队友完成补枪”；道具面板重做为逐行图标列表（投掷数量 + 道具效果）；8 张核心指标卡与道具面板统一增加 Fluent UI v9 `?` Tooltip。Analytics / Findings 语义、阈值、排序、evidence 数值与 ruleId 顺序全部不变。

P5.5 Round Timeline MVP — **PASS**。报告页底部新增独立“回合时间线” section：每回合一行摘要（`R24 / T / 成功 / 13 : 11`）可点击展开关键事件，展示目标玩家的击杀、死亡（含死后击杀）、已证实的残局形成点与炸弹安放 / 拆除 / 爆炸生命周期；时间统一为 `(eventTick - round.startTick) / tickRate` 的回合内秒数，证据不足显示 `—`。Timeline 是 Desktop presenter 层新增的只读 JSON DTO，只依赖现有 `Match / Round / MatchEvent` 与冻结 Analytics 的 clutch 结果，不修改 P3 语义、不重跑 Analytics、不在 Renderer 重新推导比赛事实。Findings 的 `relatedRounds` 提供“查看 R24 / 查看相关回合”联动（展开、滚动、短暂高亮）；切换目标玩家只切换 DTO 中对应玩家的 timeline，不重新解析 DEM。事件过滤只保留目标玩家击杀 / 死亡、clutch start 与炸弹生命周期，不展示 damage / weapon_fire / 道具效果 / 受闪 / snapshot。详见 [桌面比赛报告](./desktop-report.md)。

- P5.1 已完成：Match overview、玩家指标与 Findings 报告页。
- P5.2 已完成：可安装、可卸载、脱离 pnpm workspace 运行的 Windows 版本。
- P5.3 已完成：报告页时间显示、数字格式、Trade 文案、道具面板与指标说明。
- P5.4 已完成：深蓝灰视觉体系、彩色实心道具图标与卡片一致性。
- P5.5 已完成：回合时间线与 Findings → Timeline 联动。
- P5.5.1 已完成：名单与 Timeline 统一隐藏原始长数字玩家标识，保留 DTO 追溯 ID。
- P5.6 已完成：Analysis Views MVP（全场玩家指标对比、回合击杀趋势、CT/T 对比），基于冻结 Analytics 与 Timeline 的只读展示投影。
- 后续阶段：P6 2D地图回放已完成本机Dust2验收（见下文）；P7.1统计投影、P7.2会话与IPC、P7.3 Renderer与筛选已通过；额外Analytics算法未开始。不做3D回放；额外Analytics算法尚未排期。

P5.6.2 Report UX Polish — **PASS**。比赛报告 / 回合时间线 / 分析三个 mounted Tab；Findings 原生证据入口 hover/focus 与先切 Tab 的回合联动；当前玩家姓名和条图统一 #62abf5；Frozen multiKills counts 直接投影、零项隐藏；CT/T 独立内缩 divider；Timeline 单色自绘 SVG kill-feed、爆头/闪光助攻原样投影与未知武器 fallback。严格保持 P3/P4 与 Timeline 筛选、round time、nickname 原样规则；无新增算法或产品模块。

P5.6.3 Official Kill-feed Assets — **PASS**。击杀播报改用71张官方SVG（69武器、官方爆头与闪光助攻），72武器identifier与独立刀型映射；删除自绘weapon shapes。HUD正确源目录panorama/images/hud/deathnotice/，仅定向补提缺失素材，修正旧提取路径。全部回归与两安装包/安装版E2E通过，Timeline与Analytics/Findings语义不变。见[官方资源提取](./cs2-killfeed-assets.md)。

P5.6.4 Custom Window Chrome — **PASS**。40px 全宽自绘窗口标题栏、原创 target mark、安全 preload/IPC、原生最大化状态同步与持久错误页壳层已完成；全部指定回归、两安装包和 installed smoke 通过，用户确认真实鼠标拖动正常。

P5.6.5 Branding & App Icon — **FINAL PASS**。正式产品名冻结为 CS2 Analyst；mark/lockup、七尺寸 Windows ICO、20px mark + CS2 Analyst 标题栏、EXE/NSIS/快捷方式/App ID 与全仓 `cs2-analyst` 命名迁移完成。构建、单测、报告、dev/preview smoke、两安装包以及生产图标/快捷方式/卸载注册项验证均已完成。此前未重跑的完整 installed regression 与部分任务栏/Alt+Tab/真实拖动视觉项，由 Product Owner 于 2026-10-08 明确批准不再作为 P5.6.5 的阻塞验收项；FINAL PASS 表示产品验收结论，不代表这些未执行检查被补跑。见 [Windows 打包记录](./windows-packaging.md)。

## v0.1 Final Acceptance

**Status: FINAL PASS — v0.1.0 accepted by Product Owner on 2026-10-09.** 此前 Resume 因 Product Owner 为避免 Computer Use 干扰其他工作而主动停止，剩余人工 walkthrough / 连续导入 / 错误恢复 / 最终截图证据由 Product Owner 明确 waiver；该 waiver 不表示这些检查已执行。

Current: **v0.1 Final Acceptance FINAL PASS; P5 COMPLETE; P5.7 FINAL PASS.** 验收记录见 [v0.1 Final Acceptance](./v0.1-final-acceptance.md)；parser 修复见 [14-bit handle integration](./demoparser-handle-fix.md)。

正式 [fixture matrix](./demo-fixtures.md)：Nuke + Inferno + Dust2 + Mirage 为核心 gate；Ancient / Anubis / Overpass 为 extended optional。Train **REMOVED / NOT REQUIRED**，不属于 P5.7 / Final Acceptance gate，不是 debt / blocker；仅本地保留，不运行。

- P5.7.0 Evidence Feasibility Spike：**PASS — GOTV and three confirmed Personal DEMs verified with v0.42.0 + #363 production MSVC binding**。此前 PARTIAL PASS / Gate FAIL 保留为历史记录。
- P5.7.1 Spatial Evidence Foundation：**PASS**，正式领域contract、事件引用、core优先稀疏采样、coverage与共享输入实现，GOTV验证完成；见 [Deep Review](./deep-review-evidence.md) / [Spatial contract](./spatial-evidence.md)。
- P5.7.2 Engagement Engine：**PASS**；独立deep-review包、敌对direct contacts、共享participant/time-gap连通分组、空间exact join与分离coverage，默认3s与2/3/4/5s sensitivity；见 [Engagement analysis](./engagement-analysis.md)。
- P5.7.3 Kill / Multi-kill Impact：**PASS**；独立alive-state resolver、same-tick atomic groups、敌对KillImpact与round MultiKill、exact Engagement join、最终round result，三层coverage；21回合142death、29多杀（19×2K/9×3K/1×4K），自动抽样；见 [Kill impact analysis](./kill-impact-analysis.md)。
- P5.7.4 Teamplay / Decision Evidence：**PASS**；独立TeamplayAnalysis、direct-contact角色/atomic tiers、双向死亡响应、posthumous/same-tick保守门控、exact-event XY/Z/XYZ facts、四层coverage；284contexts、568teammate pairs、142player deaths，结构自动抽样。无评分/coaching或距离支援推断；见 [Teamplay evidence](./teamplay-evidence.md)。
- P5.7.5 Utility Context：**PASS**；逐UtilityEvent effect、exact at-event spatial、deterministic alive/bomb context、严格HE/flash linkage、fire attribution unavailable、六层coverage。404effects、15 HE damage refs、144 flash victim refs；见 [Utility context](./utility-context.md)。
- P5.7.6 Combat Execution Evidence：**PASS**；独立contract/analysis、shooter-only weapon_fire唯一inside/默认1s lead-in linkage、tick-only firstContactRole、同opponent return contact、reported damage/精确XY/Z/XYZ facts、五层coverage。三地图同一生产管线、结构invariants和自动抽样；无Aim评分/target/miss/reaction推断，View Alignment UNVERIFIED；见 [Combat Execution](./combat-execution-evidence.md)。
- P5.7.7 Findings V2：**PASS after P5.7.7.1 Calibration / Semantic Repair**。原实现 technically valid，product calibration exposed overbroad/misaligned rules；exact received-only denominator、occurrence-only refs/rounds、same-Engagement no-follow context、lone context、teamflash context、priority/caps/dedup/source gates 修复。七图 calibration、33 synthetic 与全回归/独立复审 PASS。个人 DEM 来源已确认，当前 compatibility gate PASS；见 [Findings V2](./deep-review-findings-v2.md) 和 [calibration](./deep-review-findings-calibration.json)。P4 Findings V1 冻结。
- P5.7.8 Deep Review Desktop UX：**PASS**。共享 parseWithSpatial、schema v2、默认比赛报告、深度复盘独立进阶入口与 V1/P3 共存、occurrence → Timeline、全玩家预计算已接入；见 [Desktop Deep Review](./deep-review-desktop.md)。
- Personal DEM compatibility gate = **PASS**：三份真实 Personal DEM 均通过固定 native binding 验收。demo2 Pawn2927 全 tick 恢复，R18 lifecycle-anomaly 与 optional weapon unavailable 保留。P5.7 FINAL **PASS**；v0.1 Final Acceptance **FINAL PASS**。见 [personal acceptance](./deep-review-personal-acceptance.md)。峰内存UNKNOWN。
- P5.7.7 算法保持 PASS；P5.7.8 已完成 Renderer/Electron/report-contract 集成，P3/P4 算法与 Timeline filter 冻结。Train **REMOVED / NOT REQUIRED**；v0.1 Final Acceptance 已由 Product Owner 最终验收通过。
- GitHub repository：`Evanpatchouli/cs2-analyst`（已正式改名）。

- P5 Desktop MVP / P5.7已封板；P6按独立授权实施并完成本机验收，不追加P7/P8或其他功能。
- `demo1` 继续作为 deterministic golden，现有 K/D/A、ADR、KAST、Trade、CT/T、Multi-kill、R24 clutch、R22 posthumous HE 与 Findings ruleId 顺序不得回归。
- Final Acceptance 的核心目标从“继续开发功能”切换为“验证不同真实比赛上的泛化可靠性”。
- 目标样本约 3～5 场真实玩家 DEM，尽量覆盖不同地图、比分、发挥水平与特殊情况；拿到第 2 份 DEM 即可开始逐场验收，不必等待全部样本收齐。
- 每场重点抽查最终比分、K/D/A、ADR、KAST、CT/T split、最高多杀、Opening/Trade、Clutch（如有）以及随机 3～5 个 Timeline 回合，并核对 Findings 是否有充分证据。
- DEM 仍由用户主动选择；本轮不引入自动目录扫描、登录、历史库、AI Coach、热力图或 2D 地图回放。
- v0.1 已完成；后续阶段顺序为 P6 2D 地图回放 → P7 地图热力图 → P8 AI Coach（原 P6）。本次仅调整路线图，不自动开始实现。

## P6 2D 地图回放（本机验收完成）

- 仅实现 2D 地图回放，不做 3D 回放。
- 采样与地图版本/坐标映射需独立验证；现有事件稀疏空间证据不能直接充当完整回放轨迹。
- 技术路线：官方雷达底图/overview 优先 + 本地独立回放采样/精确事件 + 按回合分块 + Canvas 2D；运行时不依赖 CS2 安装或 P8 后端。
- 子阶段：P6.0 资源与可行性验证 → P6.1 地图资源基础 → P6.2 回放采样与传输 → P6.3 播放器与证据联动 → P6.4 回归与安装验收。P6.0 已完成 Dust2 四区域配准与采样预算验证；这不代表 DEM 与底图版本一致或像素级配准已确认。
- P6.0–P6.4已按用户指定的单一Dust2 fixture与本机个人非商业使用范围通过自动化验收：固定Valve manifest定向提取与区域配准、独立8Hz采样、生命周期断点、有界会话/受信分块IPC、Canvas播放器、Timeline/Findings联动、源码外安装与离线资源检查。
- `pnpm typecheck` / `pnpm build`、相关回归、真实Electron与生产/测试seam安装检查通过；原报告与旧公开入口完整hash相同。其他地图/个人DEM及缺少的demo1 golden未重跑，不冒充PASS。Nuke仅资源/楼层边界合成验证。
- 地图版本匹配仍未确认，所有地图明确标示示意。按用户2026-10-16扩图指令，Dust2、Inferno、Mirage、Ancient、Overpass、Vertigo、Nuke、Anubis、Train、Cache十图的13张Valve PNG与10份原overview随仓库提交/推送；Nuke/Vertigo/Train双层。新增地图资源/坐标/楼层验证不代表新增真实DEM已验收；保留来源摘要与第三方分发许可未确认记录。缺图时仍可构建并浏览报告/事件。
- 技术机制见 [P6 回放技术路线](./replay-technical-route.md)，实际范围、命令、失败历史、预算实测和限制见 [实施记录](./replay-implementation.md) / [验收JSON](./replay-acceptance.json)。P7.1/P7.2/P7.3 PASS见下文；P8未开始。

## P7 地图热力图（P7.1 / P7.2 / P7.3 PASS）

- P7 及后续研发阶段的真实 DEM 输入遵循 [DEM 样本白名单](./demo-fixtures.md)：纯地图名文件（如 `dust2.dem`）及 `demo1.dem`、`demo2.dem`、`demo.dem`；不使用带比赛名称的文件名或历史 `demo3.dem` 样本。

- 地图热力图展示；热力图不等于视线、掩体或战术收益证据。
- **P7.0 地图热力图可行性与统计口径审查 — PASS / CONDITIONAL GO**（实际基线 `aae55e849ec8da35e4d946d2d883f25e7a88a58a`）。确认候选 A 玩家位置采样密度、候选 B 击杀位置、候选 C 死亡位置三层都可**完全复用现有 `parseWithReplay()` 已共享生成的 `Match` + `MatchReplay` + `MatchSpatialEvidence`**，无需新增 native 查询、第三方依赖，且不修改 P3/P4/Deep Review/Timeline；停留时间、投掷物区域/烟雾/火焰、LOS/掩体/可见性/战术收益明确排除。统计口径、公式、分母、筛选语义、空间聚合、Dust2 实测与架构建议见 [地图热力图可行性与统计口径](./map-heatmap-feasibility.md)。
  - CONDITION：结论只支持“示意图上的位置分布”；DEM 与雷达版本匹配仍 `unconfirmed`，真实 DEM 验证仅有 Dust2；位置采样密度不等于停留时间。
  - P7.0 真实 DEM 复核：`.demo/dust2.dem` SHA-256 `db90fe85…4958c` 与 557650967 字节一致；全回放窗口原始有效位置行 235604，默认实战窗口有效位置 178514，`positionCoverage=0.8205`、`positionCompleteness=1.0`；窗口内击杀 161/162 与死亡 162/162 有精确 at-event 位置。
- 子阶段：
  - **P7.1 统计投影与契约 — PASS（2026-10-17，基线 `b6d572d9e9f08d08fb74e5545288b7e30b6fb58d`）**：独立纯 presenter `projectMapHeatmap()` + JSON-only `MapHeatmapProjection` schema v1；三层独立统计与筛选，16/32/64 网格，all-valid / 经 tick 对齐核验的 uniform-8hz。修正未知 alive 误算死亡的歧义，源四分类、筛选后网格人口/覆盖、映射拒绝与事件定位原因明确分开。13/13 合成 + 1/1 白名单 Dust2 真实测试通过；217570 = 178514 有效 + 39056 确认死亡 + 0 不可用 + 0 缺失；击杀 161/162、死亡 162/162、1 world、4 窗外事件排除；32×32 完整 DTO 两次 SHA-256 一致。P3 53/53、P4 17/17、Deep Review 210/210、Parser 48/48、Desktop 72 项既有测试及全仓 typecheck/build 通过，独立复审无阻塞。完整契约与命令见 [§12 实施验收](./map-heatmap-feasibility.md#12-p71-实施与验收2026-10-17) / [Dust2 实测 JSON](./map-heatmap-p71-dust2.json)。未接入 UI / IPC / 会话，未执行安装版热力图验收；其他地图不据此获得真实热力图验收。
  - **P7.2 会话与 IPC 集成 — PASS（2026-10-17，基线 `1d03dd5463f980764dac61fba256b584f8602bb8`，实现提交 `bc3a84ea64444fac8791db705477e10c131549de`）**：共享几何提取、Worker持有现有解析引用、默认32×32三层有界缓存、JSON-only元数据与单图层请求、Main/Worker双重运行时校验已完成。请求16KiB、响应/默认缓存各512KiB、最多2在途/15秒、总Worker JS堆512MiB初始化准入；Replay64MiB原上限不变。三层独立降级，热力图单独可用时保留原Worker，重导入/取消/release/关窗清理；真实Electron发现并修复spawn前取消残留。Dust2默认hash与P7.1一致，178514有效位置、击杀161/162、死亡162/162；30组真实IPC筛选/16/32/64/三层一致。最大实测响应352194B、缓存238029B、源引用相关堆差126568496B；实际Utility峰值1499947008B，不能由小DTO推断内存安全。最终各包443项＋辅助9项全过，0失败/跳过；报告/回放/新增热力图真实smoke通过，独立复审无剩余阻断。完整协议、性能、内存、失败修复与未执行项见 [§13 P7.2验收](./map-heatmap-feasibility.md#13-p72-会话与-ipc-实施验收2026-10-17)。
  - **P7.3 Renderer 与筛选 — PASS（2026-10-17，基线 `614350988033166b575c141a834f6b0af1d0b8d8`，实现提交 `8cb39393bb63e3a599155be0e7d4ae924c59e3f4`）**：第六个「热力图」Tab、单个高DPI Canvas的三独立图层、七项筛选、两路有界请求/合并/过期保护、覆盖率/图例/缺源与图片降级已完成。真实Dust2：178514有效位置、击杀161/162、死亡162/162；54个UI DTO与实际IPC及纯函数投影一致，168请求峰值2，180个绘制样本；16/32/64绘制p95 0.5/0.8/1.4ms，DPR1/2四组尺寸181476–6656400B且始终一个Canvas。Desktop 122、唯一覆盖450、辅助9、typecheck 15/15、build 8/8、报告smoke 3场景、heatmap与replay真实smoke通过（导入13009.7ms≤15000）；生产与test-seam安装包各54案例、生命周期与卸载通过。导入耗时本机波动（P7.2 6.6s、QA 15.65s、最终13.0s）保留为性能余量风险；其他地图/个人DEM热力图与物理跨屏DPI未实测，地图版本仍unconfirmed。详见[实施与验收](./map-heatmap-feasibility.md)。
- 验收矩阵（统计正确性 S1–S10、数据覆盖 D1–D8、回归保护 R1–R5）、风险与进入下一阶段的前置条件见该文档 §9–§11。

## P8 AI Coach（原 P6，未开始）

- 模型可替换的 AI 解释与训练建议；职业 DEM 经验沉淀为后端私有规则、案例与评测资产，不依赖特定模型记忆。
- 首批范围：Dust2 的 1v1 残局，研究个人操作与决策；手动补充已知信息后续再做。
- 应用划分：同一 monorepo 内规划独立构建部署的 `apps/knowledge-pipeline`（内部知识管线）与 `apps/coach-api`（AI 分析服务）；目录与服务尚未创建。
- 技术路线：Desktop 本地个人 DEM/确定性分析 → 最小结构化证据请求 → 后端私有知识快照/模型编排 → 校验后的教练结果；职业知识库、系统 Prompt 与模型凭据不下发客户端。
- 内部知识管线可复用领域包解析职业 DEM；后端 SQLite、native 部署、鉴权和只读快照发布需在 P8.1 验证。个人 DEM 不上传；P8 不包含独立规划的客户端本地比赛库与历史归档。
- 职业案例库作为 P8 的一部分；候选规律须经人工审核与验证后发布，不能仅凭职业比赛结果认定正确。
- 子阶段：P8.1 基础与可行性验证 → P8.2 知识积累 → P8.3 独立评测 → P8.4 教练复盘 → P8.5 持续积累。
- 完整设计及空间能力门槛见 [P8 AI Coach 技术路线](./ai-coach-technical-route.md)。当前仅完成路线设计，未开始实现。

## Future — Local Match Library & History（独立规划，未开始）

> **2026-10-18 决策更新：旧的“账号 + apps/api + 服务端比赛摘要”路径已废止，不作为后续实施依据。** 产品已明确选择 **Windows 客户端 Local-first**：保存解析/分析完成的本机比赛归档，原 DEM 不保存、个人比赛不上传服务器。**不做账号/公共比赛历史后端**；这与 P8 内部职业知识管线及 AI Coach 后端是不同能力，不冲突。

- 现有单份 `report` + 临时 Replay/Heatmap Session 不具备历史恢复能力；新增比赛库必须在不依赖原 DEM、不依赖旧 Utility Process 的情况下离线打开已有六个功能。
- **导航已确定（2026-10-18 修订）**：全局第一层侧栏显示「个人数据」「比赛数据」等入口；选择「比赛数据」展示历史比赛列表；点击一场比赛，**同一侧栏整体切换**为现有六项比赛功能。标题栏后退**一次退出比赛**返回列表、前进可重入（六项 Tab 切换不入历史栈），不将两套菜单同时展开成树。参考 Codex 桌面端在 40px 标题栏左侧放后退/前进，**现有 mark + CS2 Analyst 名称严格以整个窗口几何中心居中**。仅 Shell 层切换菜单模式，尽量复用现有六视图不迁移重构。
- 数据建议：LocalAppData 专用目录；SQLite 维护轻量索引，压缩归档保存 report、所有 Replay Chunk，以及可重新投影任意现有 Heatmap 筛选的规范性证据。重开时创建新的临时 sessionId，不复用已结束的会话；严格保留 IPC/内存约束。
- 数据规模：真实 Dust2 `557,650,967` 字节 DEM 对应过一次 `36,495,839` 字节 Replay 未压缩 JSON 缓存；“单场归档 10–30 MB”**只是待验证压缩容量假设**。必须先实测 report + replay + heatmap 证据及冷启动/随机读取/压缩成本，不能凭 DEM 大小判断云端不可行，也不能将估计当结论。
- 用户可删除/批量删除本地比赛，查询占用空间，以单文件 `.cs2a`（暂定）导出/导入；内容不含 DEM、绝对文件路径、临时 sessionId 或重复静态资源。导入必须限制解压大小、验证版本、摘要、防 zip bomb/路径穿越，支持重复记录识别。
- **阶段采用独立代号 L0–L5，并非 P8 或自动确认的新版本**：L0 容量/完整恢复可行性 → L1 本地库索引/原子写入 → L2 六视图无 DEM 恢复 → L3 删除/导出/导入 → L4 标题栏导航/库 UI → L5 安装版/多样本最终验收。**所有阶段均未启动，须用户另行授权**。
- DEM 始终由用户主动选择；不做自动目录扫描、自动云上传、客户端账号或公共服务端。
- 详细实施门槛：[本地比赛库阶段计划](./match-library-plan.md)；UI 权威规范：[窗口标题栏与历史导航](./match-library-navigation.md)；存储权威规范：[容量、SQLite 与可移植归档](./match-library-storage.md)。
- P8 AI Coach 技术路线仍独立保留且**未开始**。历史 Replay 查询/解析 ≤5s 性能技术债继续独立跟踪，不作为本次文档规划的已解决事项。
