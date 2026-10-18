# P7-S2 — Spatial Semantics Audit

2026-10-19。**S2 审计完成；两项有复现依据的语义歧义已最小修复。** 未发现已复现的空间计算错误；这不是证明所有潜在错误不存在。Nuke 的观测、投影与本次 UI 验证通过；**真实 Vertigo NOT RUN**。地图版本配准、实体 freshness、源 feed 完整性以及 LOS/可达路径/战术价值仍不能由 XYZ 证明。停止在 S2。

结构化逐项记录见 [JSON](./p7-s2-spatial-semantics-audit.json)：27 项审计（25 CORRECTLY CONSERVATIVE、2 SEMANTIC AMBIGUITY / FIXED），另列 3 项 NOT VERIFIED；CONFIRMED BUG 为 0。JSON 逐项保留输入、源码/规则、实际/预期、复现种类、影响、严重度、修复与验证，不将合成输入冒充真实地图验收。

## 1. Git 基线、前置阶段与工作树

- 开始时原工作区 `E:/cs2-analyst` 干净，HEAD/main/origin/main 均为 **f1a05b8e73a1c2e7953449ab7c288d4dc58317eb**。实际执行 `git fetch origin` 后仍一致。
- 从该 origin/main 创建独立托管工作树 `C:/Users/evanpatchouli/.codex/worktrees/p7-s2-spatial-semantics-audit/cs2-analyst`，分支 **feat/p7-s2-spatial-semantics-audit**；没有切换或覆盖原工作树及已有 S3/S4 工作树。
- **最终被审计的实现提交 SHA：357b2aa89f7204087c08f244be4427ccf7d6f522**（两处文案、两项回归、两个定向审计脚本）。随后的提交仅记录本报告/JSON和阶段状态。包含这些文档的最终交付 SHA 在交付消息和 `git rev-parse feat/p7-s2-spatial-semantics-audit` 中记录；提交不能在自身文件中嵌入自己的 SHA，不把实现 SHA 冒充文档提交 SHA。
- `git merge-base --is-ancestor <commit> origin/main` 实际均 exit 0：S1 `318350b`；S3 `e412c35`；S4 `73e4d49`；S5 `daf5196`；热力图全关闭 `c1f3630` 与验收加固 `f1a05b8`。同时核对了生产代码及各阶段报告。S4/S5 的专项验收与统一人工集成验收不是同一件事。
- 仅校正 `p7-final-hardening-plan.md` 过时阶段状态；S0/S1 的历史报告和 JSON 不变。版本、tag、release 不变，不创建 PR、不合并/推送 main，不进入 S6/L/P8。

## 2. 输入、证据复用与实际运行边界

| 输入 | 字节 / SHA-256 | 本轮角色与状态 |
| --- | --- | --- |
| 原始 `.demo/nuke.dem` | 471606780；`dea9382b9cc263fed9ee4ed7e71fa6be8c176cf888868f05b26d850af6f5cb3c` | 重新计算并核对 S0/S1，一致；生产投影 + 真实 built Electron PASS（下述范围） |
| `.demo/vertigo.dem` | 不存在；无 SHA | 真实 NOT RUN；demo1/demo2 的既有清单均为 Dust2，demo.dem 不存在；不下载/替换样本 |
| `.demo/dust2.dem` | 557650967；`db90fe85aab023a1d2c8a5996182e6120d98ef494f02a070b17982b235e4958c` | 重新校验，Desktop 既有单层真实回归；不用于推定多楼层通过 |
| `.demo/demo1.dem` | 267275583；`f3c3173eae0cd100d15c81c3b734be792f9212256a9c99703b358d3434000852` | 重新校验，既有 golden 回归；本报告不保存个人比赛内容 |

先阅读全部指定八份文档、fixture/workflow/routing 和其对应源码/测试。历史 Spatial/Teamplay/Utility 的 Nuke 报告只作为已标识的复用证据，不冒充新测试。S0 本地 source/chunks 缺少热力图所需的完整 Match roster 与精确 Spatial 事件证据，因此补一次生产 `parseWithReplay` 路径调查；当前没有 `parseWithHeatmap` API。为验证改动后的产品界面，再进行一次定向真实 Electron 导入。没有 Replay 长播、安装或性能专项。

环境为 Windows x64、Node v26.3.0、pnpm 10.0.0；native 二进制/来源验证 SHA `132d664125b60542dc80dc8bc270e2c8e181a0a55433fdac5be285ef4d9b0de1`。忽略的目录 junction 复用原仓库相同 lockfile 的依赖与原始 DEM 目录，DEM 未复制。原生绑定及 provenance 仅作本地工作树准备，不跟踪。

本机私有产物位于 `E:/cs2-analyst/.tmp/p7-s2/`：`real-spatial-heatmap.json`、`real-spatial-heatmap-final.log`、`p7-s2-electron.json`、`electron-output.log` 和四张截图。提交的 JSON 只保留有限投影摘要、计数/哈希与少量定位事实，省略玩家标识，不包含完整 Match/Spatial/Replay、DEM 或大 trace。

## 3. XYZ、Z、时刻与展示楼层的证据链

1. 原生 entity row → `spatial-evidence.ts` 精确 tick + SteamID → 独立 requestedTick/actualTick/relation/coverage。XYZ 为原子组；找不到精确行时 actualTick=null，不用邻点补。before/at/after 是各自独立请求时刻；死亡 at-event 不是死亡前视角、轨迹或进攻路线。
2. 原生最终 tick 观测 → `providers/replay.ts` 的 MatchReplay：仅可靠存活/阵营/非歧义/完整位置拥有有效 segment。Heatmap 读取这些精确离散观测，不调用 Renderer 插值。
3. 击杀/死亡位置读取同一 kill ref 的 actor/target exact at-event XYZ。身份、角色、eventIndex 和 requested=actual=event tick 全部需一致。精确时间不证明实体恰在该 tick 刷新，也不证明 subtick 顺序。
4. Nuke 主/下层范围在 **-495** 共边；Vertigo 在 **11700** 共边。共享边界、缺 Z、非有限值及范围外不唯一归层；完整 XYZ 的未知归层和缺位置不同。14 项边界断言为 **SYNTHETIC ONLY**；本次 Nuke 实样本没有 unknownLayer，不把它写成真实边界场景已发生。
5. S1 的 `replayFloorAt` 只保留展示层 ID 和上下文，不保存/回填 XYZ；未知目标不变成当前层证据。Heatmap 只读原 XYZ 与纯 geometry，不读取 S1 历史展示层。已有跨层/死亡/缺行/冷 Seek/Vertigo边界测试本轮均在 Desktop 回归中执行，相关保守门槛没有放宽。
6. 分层成功只是在既定 overview 数值下分类；地图与录像版本仍 `unconfirmed`。LOS、掩体、拓扑、路线、支援能力和战术意图均不在该契约内。

本次 Nuke 4799 个 Spatial refs；core=3757、optional=5574、返回9303 ticks / 93030行，未裁 optional；Spatial hash 与历史 `a6b17927aa4cc534e1b9db48b87816e9b348404cb19c66c319dc44b5a7c874c0` 一致。原始 Replay 23837 计划帧与后述排冻结热力图窗口/机会是不同分母。

## 4. 热力图统计、过滤与真实混层例

范围：21 个正式回合、可靠回合名单全部玩家、全部阵营、**排除冻结时间**，每回合窗口为有效 freezeEndTick 至 endTick（边界不可靠时保持既有降级），32×32；三图层、all/default/lower 两套采样集。All-valid 还含事件/生命周期补采，不是均匀时间密度。

| 采样集 | 机会 | 有效位置 | 确认死亡 | 不可用 / 缺位置 | 主层有效 / 下层有效 |
| --- | ---: | ---: | ---: | ---: | ---: |
| all-valid | 178570 | 139119 | 38831 | 0 / 620 | 123189 / 15930 |
| uniform-8hz | 146680 | 113233 | 32827 | 0 / 620 | 99692 / 13541 |

两采样集的击杀位置、死亡位置均为：楼层前 scope=142、locatable=142、coverage=100%；窗外各3，不把原始145条直接当当前窗口分母。主层网格119、otherFloor23；下层网格23、otherFloor119。真实三图层的 unknownLayer/outOfBounds/invalidMapping 均为0。事件位置覆盖率不随采样集或楼层变；它不是当前层事件占比。

逐格核对 `sum(cellSampleCount)=aggregatedSamples` 与 `grid.valid=aggregated+outOfBounds+invalidMapping`；独立从 Match 重建窗口/名单及观测类别，以固定 Nuke 数值重算 XY 和 Z 分类。源机会=有效+确认死亡+不可用+缺位；事件 scope=locatable+所有首拒绝原因。**事件拒绝原因只核算守恒，不声称已逐原因独立 oracle 重判**。共享的原生/领域观测不独立证明 DEM 完整性、实体 freshness 或地图配准。

真实跨 Z 合并证据（cell 是半开 row-major 0基索引）：

| 图层 | 真实观测 ref / XYZ 或 Z | 全楼层格数 = 主层 + 下层 | 限制 |
| --- | --- | --- | --- |
| positions cell501 | R17 tick145035：主 `[1322.424072265625,-478.70654296875,-127.96875]`；下 `[1268.141357421875,-661.7438354492188,-639.96875]` | all-valid `1293=1121+172`；uniform `1105=967+138` | 该二人确为同 tick，XY 同格而非同一个 XY 坐标；格计数为整个范围累计 |
| kills cell626 | R1 t5247 e81 actor Z=-415.96875；R6 t46095 e136 actor Z=-607.96875 | `3=2+1` | 两个不同事件时刻，不能称同 tick |
| deaths cell467 | R1 t5350 e104 target Z=-127.96875；R3 t28135 e198 target Z=-639.96875 | `8=7+1` | 两个不同事件时刻，不证明攻击路径 |

All-valid 主/下层共用格数量为 positions56 / kills11 / deaths13。既有 UI 已说明“全部楼层合并统计，底图为主层；请选单层查看”，且保留版本与非 LOS/战术价值限制，判为 **CORRECTLY CONSERVATIVE**，未为理论风险额外改生产行为。

**B03 · SEMANTIC AMBIGUITY / medium / FIXED。** 实算正确，但原 UI 的“成功定位 / 当前事件”“事件位置覆盖率”没有指出楼层前口径。合成 Nuke/Vertigo 其他层或共享边界唯一事件：单主层网格0仍显示1/1、100%；真实 Nuke 主层则显示142/142而网格119、其他层23。已只补“楼层筛选前”标签及网格/排除计数说明。新增 SSR 覆盖两地图×两事件图层×其他层/边界共8组合，验证统计保持不变。真实 Electron 三层切换亦验证新说明与 DTO 一致。未更改任何分子、分母或过滤规则。

## 5. 空间相关规则与用户结论逐项清单

表中正确保守项的预期行为等同实际行为，严重度 none、修复建议为保留规则；输入、复现类型和验证证据索引在 JSON 逐项展开。未发现基于 XYZ/距离升级为 LOS、可达路线、必可补枪/支援、道具质量或战术意图的生产结论。

| ID | 模块 / 规则 | 源码定位 | 实际行为与预期边界 | 分类 / 修复状态 |
| --- | --- | --- | --- | --- |
| A01 | XYZ 精确事件来源 / `exact-only; requestedTick/actualTick/relation` | `packages/dem-parser/src/providers/spatial-evidence.ts:100` | 只接受精确玩家行；无行 actualTick=null；XYZ 原子组，before/at/after 分开，死亡位置只称 at-death-event。 | CORRECTLY CONSERVATIVE |
| A02 | Nuke / Vertigo 楼层边界 / `resolveMapLayer` | `apps/desktop/shared/replay-map-geometry.ts:32` | 共享闭区间边界双匹配返回 null；唯一层才确认。 | CORRECTLY CONSERVATIVE |
| A03 | 缺位置 / 未知层 / 其他层 / `classifyHeatmapObservation; addPoint` | `apps/desktop/shared/heatmap.ts:16` | 缺 Z 为位置缺失/事件 invalidPosition；完整 XYZ 的歧义或范围外 Z 为 unknownLayer；已知其他层为 otherFloor。 | CORRECTLY CONSERVATIVE |
| A04 | Replay 展示状态隔离 / `replayFloorAt; replayDisplayFrame` | `apps/desktop/renderer/src/replay-floor.ts:27` | S1 仅保存楼层 ID，不保存 XYZ；插值仍需同层/同段/双方存活/合法 gap；Heatmap 不读取展示层历史。 | CORRECTLY CONSERVATIVE |
| B01 | 全部楼层的 XY 合并 / `addPoint; row-major 32x32` | `apps/desktop/shared/heatmap.ts:47` | 全部楼层仅按 XY 分格，可能合并不同 Z；UI 已明示合并统计、主层底图、请选单层。 | CORRECTLY CONSERVATIVE |
| B02 | 单层筛选与守恒 / `floor filter; finishGrid` | `apps/desktop/shared/heatmap.ts:48` | 单层只改变 grid population；未知和其他层分别排除；网格、源机会和事件拒绝计数守恒。 | CORRECTLY CONSERVATIVE |
| B03 | 事件覆盖率的楼层范围 / `HeatmapLayerDetails` | `apps/desktop/renderer/src/heatmap-view.tsx:156` | 原文成功定位/当前事件可能被读成当前楼层；计算实际为楼层筛选前范围。 | SEMANTIC AMBIGUITY · FIXED |
| B04 | 热度与地图限制 / `alignment=unconfirmed; scope-relative-linear` | `apps/desktop/renderer/src/heatmap-view.tsx:102` | 版本警告始终可见；图例不承诺连续时间、LOS、掩体、可见性或战术收益；强度不能跨图层比较数量。 | CORRECTLY CONSERVATIVE |
| B05 | 全部图层关闭 / `paintHeatmap empty layers` | `apps/desktop/renderer/src/heatmap-canvas.ts:5` | 空图层仍画底图，Tab 返回保留关闭状态。 | CORRECTLY CONSERVATIVE |
| C01 | Engagement 空间 enrichment / `shared participant + temporal grouping` | `packages/deep-review/src/engagements.ts:12` | 分组由时间与共享参与者决定；Spatial 精确四键 join，只作附加事实，不是同一可达空间或 LOS。 | CORRECTLY CONSERVATIVE |
| C02 | 水平 / 垂直 / 三维距离 / `horizontalDistance / verticalDelta / directDistance` | `packages/deep-review/src/execution.ts:64` | 同时保留 hypot(dx,dy)、abs(dz)、hypot(dx,dy,dz)，合成结果 5/12/13；不创建可见或可命中结论。 | CORRECTLY CONSERVATIVE |
| C03 | 最近存活队友与死亡上下文 / `nearestConfirmedAliveTeammate` | `packages/deep-review/src/teamplay-evidence.ts:116` | 按 XYZ 直线距离排序，保留 XY/abs Z；同 tick 死亡排除并记歧义；缺候选位置记 partial，最近仅指完整观测子集。 | CORRECTLY CONSERVATIVE |
| C04 | 最近敌人 / 道具队友 / `nearestEnemy / nearestTeammate` | `packages/deep-review/src/utility-context.ts:87` | 按 XYZ 距离排序，保留 XY/Z；起点缺失不以投掷者补齐；missingPositionPlayerIds 与 partial 保留。 | CORRECTLY CONSERVATIVE |
| C05 | 冻结 P3 Trade 与 Finding / `trade.low-rate` | `packages/analytics/src/trade.ts:73` | 按已冻结时间/击杀事实计数，存活队友构成分母；Finding 明示存活不代表有补枪位置。 | CORRECTLY CONSERVATIVE |
| C06 | Teamplay 后续响应 / `follow-up window; sameEngagement` | `packages/deep-review/src/teamplay.ts:103` | none-observed 需足够完整 feed；same tick 不排序；同组仅比较真实 Engagement ID；不用距离判失败。 | CORRECTLY CONSERVATIVE |
| C07 | 仅本人参与的死亡 / `deep.teamplay.lone-contact-death-pattern` | `packages/deep-review/src/findings.ts:127` | 输出确认参与事实；UI 明示不代表孤立、看得到、来得及或具备支援条件。 | CORRECTLY CONSERVATIVE |
| C08 | 后续跟进的资格文案 / `deep.teamplay.no-followup-pattern` | `apps/desktop/electron/deep-review-copy.ts:93` | 领域仍正确输出 5/5；原翻译遗漏参与时间限制，伤害或击杀记录也可能被理解为主动输出。 | SEMANTIC AMBIGUITY · FIXED |
| C09 | HE 直接效果 / `unique same-round/actor/tick linkage` | `packages/deep-review/src/utility-outcomes.ts:27` | 仅唯一精确关联；缺 weapon、未知 actor、多候选降级；partial 数值只是观察子集。 | CORRECTLY CONSERVATIVE |
| C10 | 火焰效果 / `fire linkage unavailable` | `packages/deep-review/src/utility-outcomes.ts:25` | effect-level reportedEnemyDamage=null/unavailable；即使同 actor 后续伤害也不硬关联。 | CORRECTLY CONSERVATIVE |
| C11 | 闪光效果 / `unique entityId + actor linkage` | `packages/deep-review/src/utility-outcomes.ts:53` | reuse/missing/mismatch 降级，保留零时长与敌友自身；原始时长不等于连续致盲；官方助攻不猜单颗归属。 | CORRECTLY CONSERVATIVE |
| C12 | 烟雾 / 诱饵与 C4 阶段 / `not-applicable directOutcome` | `packages/deep-review/src/utility-outcomes.ts:26` | 仅保留上下文；没有 blockedEnemy/cutSightline/goodSmoke 等结论；planted 不等于守包意图。 | CORRECTLY CONSERVATIVE |
| C13 | V1 道具伤害 Finding / `utility.damage-high / utility.damage-low` | `packages/findings/src/index.ts:93` | 只比较直接敌伤，低值明确不衡量封路拖延；无空间依赖。 | CORRECTLY CONSERVATIVE |
| C14 | V1 官方闪光助攻 / 队友受闪 / `utility.flash-high / team-flash.frequent-effects` | `packages/findings/src/index.ts:108` | 官方助攻支持已记录击杀支援；受闪次数不等于有效闪光或持续时长；不从坐标推导损失。 | CORRECTLY CONSERVATIVE |
| C15 | Execution 两条结论 / `deep.execution.no-confirmed-return-pattern / return-contact-consistent` | `packages/deep-review/src/findings.ts:104` | 只述是否记录到反向伤害/击杀；空间不参与规则资格；UI 明示不是反应速度/枪法评价。 | CORRECTLY CONSERVATIVE |
| C16 | Impact 三条结论 / `deep.impact.multikill-swing / sole-survivor-sequence / multikill-unconverted` | `packages/deep-review/src/findings.ts:58` | 只述多杀/人数/结果，无空间输入；caveat 不把单杀归因为回合胜负。 | CORRECTLY CONSERVATIVE |
| C17 | Deep Review 队友闪光 / `deep.utility.teamflash-repeated` | `packages/deep-review/src/findings.ts:159` | 统计颗数与受闪行；位置 coverage 不参与资格；不判断闪光质量/持续时间。 | CORRECTLY CONSERVATIVE |
| C18 | 最终 UI 投影 / `adaptDeepReviewFinding -> Desktop DTO -> renderer cards` | `apps/desktop/electron/report.ts:279` | 原始 nearest/XYZ 不被投影成隐藏战术判断；卡片保留说明与限制；两个修复仅在 presenter。 | CORRECTLY CONSERVATIVE |

**C08 · SEMANTIC AMBIGUITY / low / FIXED。** 五个明确标识的合成回合各有 `kill(t100,敌人,队友)`、`damage(t140,敌人,玩家)`：玩家首次参与晚于队友阵亡，只有受击、无主动伤害/击杀；生产领域链仍正确形成 no-followup 5/5。领域原 caveat 已限制“整个 Engagement，不证明阵亡前已参与”，Desktop 翻译遗漏该条件。仅补 UI caveat，说明参与包含受击/被击杀且可能晚于队友阵亡，并保留“非补枪失败、无法判断视线/来得及/支援”。回归实际调用完整分析链，再断言文案限制；没有改资格、阈值或 ruleId。真实 Nuke 的该规则卡片为5/10，已选择实际目标、切补充观察、展开限制确认可见；不把合成5/5案例称为该玩家的真实行为。

## 6. 定向真实 Electron UI 验证

路径：本地 built Electron → 导入原始 Nuke → 热力图三开关 → 全部/主/下层 → 全关闭与 Tab 返回 → 实际 Deep Review 卡片展开。使用仓库现有 Electron/CDP runner；没有 browser skill 列表项，未使用 Browser connector，也不声明 deferred connector 不可用；没有新增浏览器依赖。只读 React current tree 对照生产 DTO；Main 观察器委托原 handler，结束恢复；Canvas 观察器委托原绘制方法。没有合成报告注入。

| 检查 | 实际结果 |
| --- | --- |
| 页面身份 / 非空 / 框架错误界面 | 正确 file URL、标题 CS2 Analyst，main=success，有内容，无错误 overlay |
| 9组 UI/preload IPC DTO | 三图层×三楼层完全一致，楼层前 source不变，网格/排除随实际楼层改变 |
| 两个 viewport | 1024×640、1920×1032（CDP模拟），DPR1；Canvas257²/689²，无页面溢出；侧栏内部auto滚动 |
| 全图层关闭 | 新 IPC=0、overlay fillRect=0；与独立本地 Nuke PNG的覆盖、alpha轮廓、稳定内部颜色匹配均1.0 |
| Tab返回 | 空图层保持，底图上述三指标均1.0；不重复实现既有修复 |
| 深度复盘 | 真实 no-followup 卡片限制已展开，新增资格说明和原支援限制完整可见 |
| Console / Runtime / 生命周期 | error数组与exception数组均空；正常exit0，受管进程remaining=[] |

截图为本地 `heatmap-1024x640.png`、`heatmap-1920x1032.png`、`heatmap-all-off.png`、`real-no-followup-caveat.png`。root及独立复审读取了关键截图。1024侧栏部分统计需内部滚动，是既有布局；没有把所有文案首屏可见作为主张。不是物理窗口/DPI、安装包或独立人工 walkthrough 验收。

## 7. 实际命令、退出码与失败记录

| 命令 / 范围 | exit | passed / failed / skipped |
| --- | ---: | --- |
| `pnpm typecheck` | 0 | 15/15 tasks；12缓存；非测试计数 |
| `pnpm build` | 0 | 8/8 tasks；6缓存；含地图资源摘要 |
| `node --test` parser spatial + deep-review engagements/execution/teamplay/utility/findings（JSON保留完整参数） | 0 | 176 / 0 / 0 |
| `pnpm --filter @cs2-analyst/desktop test` | 0 | 178 / 0 / 0；含geometry/unknown、Replay保守状态、Heatmap/SSR、copy、真实现有回归 |
| `pnpm --filter @cs2-analyst/analytics test` | 0 | 53 / 0 / 0 |
| `pnpm --filter @cs2-analyst/findings test` | 0 | 17 / 0 / 0 |
| `node scripts/p7-s2-spatial-audit.mjs E:/cs2-analyst/.demo/nuke.dem E:/cs2-analyst/.tmp/p7-s2` 最终行为版本 | 0 | 实 DEM 投影通过；14 geometry边界断言为合成，单列不算Node tests |
| `$env:P7_S2_QA_DIR='E:/cs2-analyst/.tmp/p7-s2'; node scripts/p7-s2-spatial-electron.mjs` | 0 | 上述9组真实UI及底图/卡片检查通过；不虚构Node test数量 |
| 两脚本 `node --check` / `git diff --check`（含staged） | 0 | 语法/空白通过 |
| `git ls-files '*.dem'` | 0 | 空输出，跟踪DEM=0 |

唯一 Node 测试合计 **424 passed / 0 failed / 0 skipped / 0 cancelled**。复审另在原始干净基线运行36项 Heatmap/geometry/SSR（exit0），以及新copy8项（exit0），属于上述覆盖的子集，不重复累计。日志在本工作树 `.tmp/p7-s2-{typecheck,build,domain-tests,desktop-tests,analytics-tests,findings-tests}.log`。

实际遇到并保留的失败/中断，均不计为通过：

1. 离线依赖安装 exit1，缺turbo tarball；冻结lockfile在线安装停在429/430后终止所属安装进程，exit1。改为junction复用现有同lockfile依赖，不改manifest或lockfile。
2. 依赖链接前的report-ux入口 exit1，0 passed / 1 failed / 0 skipped，原因React ERR_MODULE_NOT_FOUND，尚未执行断言；链接后Desktop完整178项通过。
3. Collector第一轮查找少量边界样本时用了二次复杂度去重；核对PID/完整命令后停止，exit=-1，无产品断言失败。改Set及早停，最终行为脚本重新运行exit0，执行时source SHA在私有executionHistory保留。
4. 复审后仅纠正collector独立性与Electron路由两处元数据/注释；同步私有证据时去除更正字段前后deepEqual，所有观测完全相同。明确记录metadataCorrection，不伪称更正后重新解析或测量。

## 8. 独立复审与剩余边界

独立复审检查了生产差异、真实领域回归、Collector oracle、9组Electron证据/截图、声明与数据的对应及最终报告。Heatmap改动由另一审计者复核，no-followup作者以外的审计者另行复核该改动。结论：**PASS，无剩余阻断项**；初次发现的“独立oracle”过宽描述与“Browser不可用”路由表述已收窄。事件拒绝只声明守恒，不假称每个拒绝原因独立重判。

| ID | 分类 | 仍未验证及边界 |
| --- | --- | --- |
| U01 | NOT VERIFIED / NOT RUN | 真实 Vertigo；只有合成边界/SSR，不能写真实比赛PASS。未来只使用现有白名单真样本。 |
| U02 | NOT VERIFIED | 雷达/DEM版本配准、实体freshness、源feed完整性；地图版本警告保留，不能由位置归层或exact tick证成。 |
| U03 | NOT VERIFIED / NOT IMPLEMENTED | LOS、碰撞、掩体、nav/topology、路线可达、支援能力、道具质量/战术意图；超出S2，未新增算法。 |

本次未执行安装包验收（仅两处presenter文案，无安装/打包配置改动）、无关Replay长播/性能、全场逐显示帧/所有目标穷举、物理多屏DPI或S6统一人工集成验收。没有改P3/P4契约、统计阈值、ruleId、领域DTO、采样/插值预算、segment或Chunk/IPC协议；Domain→Analytics→Findings→UI方向不变。

交付文件为两处生产文案、两项现有测试扩展、两个定向开发QA脚本、本MD/JSON及必要的阶段计划状态更新，共9文件。S0/S1历史证据不变；不提交DEM、私有比赛明细、截图/trace或安装包。按授权仅推送该S2分支，无PR。后续工作须另行明确授权。
