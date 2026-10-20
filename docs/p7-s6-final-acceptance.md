# P7-S6 最终统一验收

日期：2026-10-20（Asia/Shanghai）。本报告只判定 P7-S6 自动化门禁是否可进入人工验收，不代表整个 P7 FINAL PASS。L0–L5 / P8 未启动，版本号、tag 和 GitHub release 未修改。

> **P7-S6 AUTOMATED ACCEPTANCE PASS / READY FOR HUMAN ACCEPTANCE**

## Git、隔离与输入

开始时执行 `git fetch origin`，实际 `origin/main` 与参考基线一致：`7825e90047e857d5c06efe304dc68979afa7cf3b`。原 `E:/cs2-analyst` 的 main 干净。从实际远端基线创建 `E:/cs2-analyst-s6`、`acceptance/p7-s6-final`，没有切换或覆盖其他工作树。

读取仓库/全局 AGENTS、模型路由、DEM 工作流、最终补强计划、fixture 规范及 S0–S5、Heatmap、Replay/道具/死亡跟随历史报告。历史记录只用于确定预期与对照，所有门禁、样本扫描及截图均在本轮重新执行。

DEM 通过 ignored `.demo` junction 指向原有本地目录；native 绑定也通过 ignored junction 复用，并重新验证 provenance/SHA。依赖执行 frozen install，不以旧 node_modules 替代。没有下载、修改、复制或提交 DEM，没有使用 demo3、match-named DEM 或 train。长文件名仅是 Renderer 内存展示输入，真正解析仍使用 `.demo/demo2.dem`。九个实际输入的大小与 SHA 见 JSON；demo.dem、vertigo.dem 不存在。

执行与脚本修正由主代理和定向执行代理负责；独立 reviewer 全程只读。UI/性能命令串行运行，复用仓库 Electron/CDP，不以浏览器页面或纯函数冒充 Electron。Node v26.3.0、pnpm 10.0.0、Electron 44.5.1 / Chromium 152.0.7977.130，Windows x64；native SHA `132d664125b60542dc80dc8bc270e2c8e181a0a55433fdac5be285ef4d9b0de1`。

## 证据分类与验收范围

| 范围 | 本轮证据 | 边界 |
|---|---|---|
| P7.1 统计 | Desktop/领域回归、真实 Dust2 三层统计与纯投影对照、真实 Nuke 两采样集与逐楼层网格审计 | 楼层前覆盖率与当前层网格数量分开；不从 XY 推定 LOS/可达性 |
| P7.2 IPC | Heatmap 30 次直接 IPC、UI/IPC/投影对照、两请求并发/第三请求拒绝、失效会话与取消/释放 | 与 Replay Chunk 的 IPC 指标分别记录 |
| P7.3 Renderer | 默认仅位置层；全部关闭后干净完整底图；重新打开恢复；导航保持、新会话重置；缺源/资源/图片错误降级 | 错误分支包含明确标识的受控 metadata/image 输入 |
| S0/S1 | 重新采集 Nuke 源与 141 块指纹；五窗自动/主/下层×1/1.5/4；跨块、跨回合、完整1×R1/R2与生命周期 | 旧“死亡后保持死者”预期被最新跟随需求取代；没有改原位置/楼层/窗口预算 |
| S2 | 真实 Nuke 投影与 Electron 9 组 UI、全关闭纹理/alpha 对照、Deep Review 保守文案；领域跨地图回归 | 14 个几何边界为合成；真实 Vertigo NOT RUN；不证明地图配准、实体 freshness、拓扑或战术价值 |
| S3 | 真实 Electron details/Timeline/侧栏开关、动态高度、焦点、快速反向、Reduced Motion、forced-colors、双原生尺寸 | 受控长内容用于压力分支；媒体模拟不等于系统辅助技术人工验证 |
| S4 | 分析与深度复盘各三 Tab、键盘/鼠标、Tooltip、空/不可用、内部滚动、玩家与重新导入状态、Timeline/Replay 跳转 | 真实内容与受控 DTO 的空/错误/长列表分开归类 |
| S5 | 8 KPI、左右独立滚动、证据/回合联动、警告、空状态、长显示名、双尺寸与错误恢复 | 1920 右栏压力滚动含受控追加行，不称为真实比赛内容 |
| Replay 增强 | Dust2 原生633次投掷/632效果归属；真实烟雾/闪光/火焰/HE/诱饵、拖尾/昵称/状态、Seek/回合/速度与视觉；Nuke真实跟随 | 视觉粒子不表示物理/伤害方向；没有补死亡玩家坐标、楼层或 LOS |
| 死亡替代 | Nuke真实击杀者；Ancient自杀与未知攻击者；demo1已死亡HE击杀者；重复/反向/冷定位与实际跨块播放 | demo1目标块可已被邻块预取，不声称该一场景未缓存；冷定位在其他真实场景独立验证 |
| 全员阵亡 | 九个真实DEM源扫描；受控 DTO + 原 ReplayPlayer/真实Electron 6场景×2尺寸；合成单元测试 | 真实DEM正式Replay窗口内全死 UI **NOT RUN**，不以受控结果补成真实PASS |
| Windows | 两种 NSIS 包的完整 `pnpm test:installed`，真实导入、六视图、状态/恢复、注入拒绝、退出、卸载与ASAR审计 | 只有完整套件退出0才通过；生产磁盘File由CDP驱动，Explorer原生chooser人工选择未执行 |

## 本轮缺陷与失败记录

本轮没有修改产品生产源码、领域契约或冻结统计口径。修复的是验收覆盖与前置条件，所有初次失败保留。

1. **QA-01 / gate blocker，已修复：S1过时死亡预期。** 当前产品会切换到真实存活击杀者，旧脚本却强制死者 retained/冷Seek unknown。新脚本核对整回合来源归属、exact存活候选与同tick死者，按手选 anchor 检查实际跟随，并保留原矩阵、源指纹、可绘遗漏与独立楼层审计。跟随预期复用了产品 resolver，是集成一致性检查；不能称为独立算法实现证明。死亡专项另外使用独立 native 证据核对归属/候选。
2. **QA-02 / gate blocker，已修复：安装套件覆盖缺口。** 完整套件内部补两包真实 Analysis/Deep Review/Timeline/Replay 交互、3+3 Tab与双尺寸截图；损坏重导恢复后再执行真实专项。受控 Deep Review 与 Heatmap 故障输入另记。加强所有DEM后缀、测试目录及已知fixture标记的ASAR拒绝和卸载目录最终状态。
3. **QA-03 / gate blocker，已修复：冷缓存前置条件竞态。** 全死首跑 exit1，1920未知攻击者场景中，远跳block7及预取6后，三块LRU仍可合法保留3；500ms不能证明逐出。完整原日志/JSON/截图在 `.tmp/p7-all-dead/initial-cold-cache-attempt/` 和 `all-dead-electron.log`。改为通过真实Seek访问block6，正常预取5，再等待/断言3已逐出且缓存≤3后定位3，不清空/改写缓存。随后12组从头重跑，使用新日志 `all-dead-electron-final.log`。首跑输出由 `fixed` 整体改名为 `initial-cold-cache-attempt`；原始JSON内绝对路径保留运行时值，初跑文件应按最终catalog的initial路径定位，不能沿旧绝对路径读取当前final产物。
4. **QA-04 / input safety，已修复：长名输入。** S5不再创建/删除长名DEM硬链接，解析原白名单demo2，再只修改运行中展示文件名，保留换行和裁切检查。
5. **记录补强：** 道具审计追加本进程 `sessionId='audit'` 的序列化缓存大小及原预算断言；与真实IPC会话、Utility驻留内存分开。

初次 `pnpm typecheck/build` 虽 exit0，但命中共享工作树Turbo缓存，不作为本轮实际编译证据；已以 `TURBO_FORCE=true` 重跑，分别15/15与8/8、0 cached。两个初次日志保留，不把旧缓存输出写成本轮执行。受控损坏DEM、资源失败、下一回合失败等是预期错误分支，不计为未处理产品失败。

6. **QA-05 / gate blocker，已修复：控件等待探针。** `p7-transport` 首跑 exit1（30s超时），原始输出在本轮独立TEMP的 `cs2-p7-transport-evidence/` 和 `p7-transport.log`。+2s再前进30s会落入已预取的block1；此外缺块绘制会清空前景后提前返回，`dataset.playerCount/tick`仍可能是旧值，不能用players=0识别等待。改为从metadata推导仍在block0但+30s进入block2的起点，先证明目标块未缓存；委托真实clearRect/fillText后逐paint读取时钟/所需块/只读cache，要求≥2缺块绘制、透明RGBA/零数字标记/真实时钟冻结及响应后的玩家绘制恢复。Main记录真实payload响应持有≥650ms，这是受控IPC故障测试，不用于自然IPC p95。进程归属起点也移到spawn前。全部交互与布局断言保留，完整重跑另记新输出目录与日志。

## 真实全员阵亡与未覆盖项

本轮 native 扫描9个SCANNED样本，1284/1284不同死亡tick具有完整生死记录。找到7个全死tick，全部超出既有正式回合终点：Nuke51114、Dust2 104292/202604、Ancient150889、Overpass100477、demo1 141061、demo2 107030。正式窗口内数量0。没有扩大Replay窗口/采样/查询预算，因此真实全死Electron明确 **NOT RUN**。

受控场景包括C4同tick全死、已死投掷者HE、自杀、未知攻击者、末次位置缺失、从无楼层历史；所有实际Canvas纹理/数字标记、死亡侧栏、参考提示、同tick/反向/冷定位、暂停/恢复/跨块及效果到期分别验证。受控坐标来自本轮Nuke native快照或null，生命周期为测试输入，不声称真实比赛中发生过。

人工产品签收、Explorer文件选择、Narrator/NVDA/系统高对比度、物理跨显示器DPI、全21回合所有目标/速度穷举未执行。地图与DEM版本仍unconfirmed；LOS/碰撞/nav/路线可达及支援能力不在已验证能力内。真实Vertigo样本不存在，不下载替代。以上与必需自动化门禁、已知查询技术债分别记录。

## 实际 SHA 与分支快照

- 最终受测产品代码：`7825e90047e857d5c06efe304dc68979afa7cf3b`（本轮产品源码零改动）。
- 最终受测 QA 实现提交：`88ea99d6618ba356b912b0803ce1cb9d53ef5c3f`，7 个 QA 文件，独立工作单元已验证并提交。
- 本报告生成前分支：`acceptance/p7-s6-final`，相对已 fetch 的 `origin/main` ahead 1、工作树干净。
- 报告交付提交是包含本 MD/JSON 的 Git commit；为避免 SHA 自引用，提交后在最终交付消息给出准确 SHA。合并使用 fast-forward，原 main 只有在独立复核通过后更新并推送。最新 fetch 的 origin/main 仍为原基线。

## 实际命令、退出码与计数

时间取各真实启动/结束时间，均见 JSON；下表秒数含 shell/pnpm 开销。Node tests 与 Turbo tasks 分开，`—` 表示脚本没有 Node runner 测试计数，不能伪造为0项测试。初次失败与缓存运行不隐藏。

| ID / 命令 | exit | 秒 | Node passed/failed/skipped | 说明 |
|---|---:|---:|---|---|
| install: `pnpm install --frozen-lockfile` | 0 | 13.969 | — | PASS |
| parser-verify: `pnpm parser:verify` | 0 | 1.172 | — | PASS |
| typecheck: `pnpm typecheck` | 0 | 3.855 | — | Exit 0 but shared cache used; superseded by fresh execution; tasks 15/15 |
| build: `pnpm build` | 0 | 7.770 | — | Exit 0 but shared cache used; superseded by fresh execution; tasks 8/8 |
| desktop-test: `pnpm --filter @cs2-analyst/desktop test` | 0 | 26.532 | 194/0/0 | PASS |
| smoke: `pnpm test:smoke` | 0 | 20.458 | — | PASS; tasks 1/1 |
| analytics-test: `pnpm --filter @cs2-analyst/analytics test` | 0 | 8.323 | 53/0/0 | PASS |
| findings-test: `pnpm --filter @cs2-analyst/findings test` | 0 | 4.612 | 17/0/0 | PASS |
| deep-review-test: `pnpm --filter @cs2-analyst/deep-review test` | 0 | 52.566 | 210/0/0 | PASS |
| dem-parser-test: `pnpm --filter @cs2-analyst/dem-parser test` | 0 | 18.705 | 49/0/0 | PASS |
| match-model-test: `pnpm --filter @cs2-analyst/match-model test` | 0 | 0.771 | — | PASS |
| typecheck-fresh: `pnpm typecheck` | 0 | 6.149 | — | PASS; tasks 15/15 |
| build-fresh: `pnpm build` | 0 | 10.439 | — | PASS; tasks 8/8 |
| replay-smoke: `node scripts/replay-smoke.mjs` | 0 | 47.312 | — | PASS |
| heatmap-smoke: `node scripts/heatmap-smoke.mjs` | 0 | 94.237 | — | PASS |
| collapse: `pnpm --filter @cs2-analyst/desktop test:collapse` | 0 | 42.802 | — | PASS |
| report: `pnpm --filter @cs2-analyst/desktop test:report` | 0 | 85.645 | — | PASS |
| report-layout: `node scripts/p7-report-layout-acceptance.mjs` | 0 | 30.795 | — | PASS |
| p7-ui: `node scripts/p7-ui-acceptance.mjs` | 0 | 27.356 | — | PASS |
| death-follow-nuke: `node scripts/replay-death-follow-acceptance.mjs` | 0 | 20.360 | — | PASS |
| death-follow-suicide: `node scripts/replay-death-follow-acceptance.mjs --scenario=suicide` | 0 | 14.961 | — | PASS |
| death-follow-unknown: `node scripts/replay-death-follow-acceptance.mjs --scenario=unknown` | 0 | 13.317 | — | PASS |
| death-follow-posthumous: `node scripts/replay-death-follow-acceptance.mjs --scenario=posthumous` | 0 | 16.496 | — | PASS |
| all-dead-scan: `node --expose-gc scripts/replay-all-dead-scan.mjs` | 0 | 16.958 | — | PASS |
| all-dead-electron: `node scripts/replay-all-dead-acceptance.mjs` | 1 | 84.187 | — | FAIL preserved: invalid assumption about LRU eviction; superseded by full rerun |
| spatial-audit: `node scripts/p7-s2-spatial-audit.mjs .demo/nuke.dem .tmp/p7-s2` | 0 | 8.699 | — | PASS |
| spatial-electron: `node scripts/p7-s2-spatial-electron.mjs` | 0 | 17.224 | — | PASS |
| throw-audit: `node scripts/p7-throw-audit.mjs` | 0 | 13.813 | — | PASS |
| p7-visual: `node scripts/p7-visual-acceptance.mjs` | 0 | 48.412 | — | PASS |
| all-dead-electron-final: `node scripts/replay-all-dead-acceptance.mjs` | 0 | 98.561 | — | PASS |
| nuke-source: `node scripts/replay-nuke-source.mjs` | 0 | 13.190 | — | PASS |
| nuke-s1: `node scripts/replay-nuke-electron.mjs --s1` | 0 | 412.756 | — | PASS |
| package-isolation: `node scripts/replay-all-dead-package-audit.mjs` | 0 | 0.250 | — | PASS |
| p7-transport: `node scripts/p7-transport-acceptance.mjs` | 1 | 47.542 | — | FAIL preserved: cached target and stale dataset used to detect buffering; superseded by full rerun |
| pack-win: `pnpm --filter @cs2-analyst/desktop pack:win` | 0 | 39.119 | — | PASS |
| pack-win-test: `pnpm --filter @cs2-analyst/desktop pack:win:test` | 0 | 37.516 | — | PASS |
| installed: `pnpm test:installed` | 0 | 353.698 | — | PASS; tasks 1/1 |
| build-restored: `pnpm build` | 0 | 10.521 | — | PASS; tasks 8/8 |
| p7-transport-final: `node scripts/p7-transport-acceptance.mjs` | 0 | 34.303 | — | PASS |
| git-diff-check: `git diff --check` | 0 | 0.286 | — | PASS |
| git-dem-files: `git ls-files "*.dem"` | 0 | 0.213 | — | PASS |
| git-status: `git status --short --branch` | 0 | 0.207 | — | PASS |

唯一运行时测试总计 **523 passed / 0 failed / 0 skipped**：Desktop194、Analytics53、Findings17、Deep Review210、DEM Parser49。领域运行时子计329；Match Model另为tsc契约编译。重复执行的聚焦/集成覆盖不再加到这个数。UI assertion脚本按场景组记账，不与Node测试数混加。

## 本轮专项结果与截图

- Nuke：48组、74984次实际paint；完整1×R1/R2为61129次paint / 524317次可绘玩家机会；遗漏、层不一致及独立oracle错误空白均0；141块真实IPC、11项生命周期检查通过。
- 全死受控Electron：12/12、8051次实际paint、40张PNG；首跑失败独立保留。
- Visual：43张完整窗口图（21张1024×640、22张1920×1032）与16张200×160播放局部帧，合计59PNG，不能把59全部称为双尺寸完整窗口图。
- S2真实Electron：9组UI/IPC、全关闭纹理与alpha对照、相关保守说明，退出0且进程清理为空。
- 安装版真实专项：生产、test-seam、test-seam损坏恢复后三组，各13组case与22张截图（每尺寸11张）；两包Heatmap各55组case。
- JSON逐张记录383个PNG的路径、大小、尺寸及SHA-256，其中351个属于最终验收输出，32个属于保留的初次失败；不代表383张都做过人工目视检查。原始JSON/trace日志和安装器索引另有SHA。

S3、Replay visual/transport以及受控全死专项通过原生BrowserWindow尺寸检查；S5与安装版截图中的1024×640/1920×1032为真实Electron的CDP viewport，不能冒充物理跨屏DPI或全部原生窗口拖动。目视抽检未见阻断裁断、重叠或错误空白。

代表截图（本机 ignored 证据，不提交图片/trace/DEM）：

| 图 | 路径 |
|---|---|
| 报告1024×640 | [.tmp/p7-s5-qa/report-default-1024x640.png](E:/cs2-analyst-s6/.tmp/p7-s5-qa/report-default-1024x640.png) |
| 报告1920×1032 | [.tmp/p7-s5-qa/report-default-1920x1032.png](E:/cs2-analyst-s6/.tmp/p7-s5-qa/report-default-1920x1032.png) |
| Replay原生1024 | [.tmp/p7-visual-s-six-final/nicknames-on-1024.png](E:/cs2-analyst-s6/.tmp/p7-visual-s-six-final/nicknames-on-1024.png) |
| Replay原生1920 | [.tmp/p7-visual-s-six-final/throw-chinese-1920.png](E:/cs2-analyst-s6/.tmp/p7-visual-s-six-final/throw-chinese-1920.png) |
| 受控全死1024 | [.tmp/p7-all-dead/fixed/1024x640-c4-death.png](E:/cs2-analyst-s6/.tmp/p7-all-dead/fixed/1024x640-c4-death.png) |
| 受控全死1920 | [.tmp/p7-all-dead/fixed/1920x1032-c4-death.png](E:/cs2-analyst-s6/.tmp/p7-all-dead/fixed/1920x1032-c4-death.png) |

## Windows 实际安装与卸载

两次打包 exit0，生产39.119s、test-seam37.516s，各约111.8MB。安装器SHA/字节大小见JSON。staging在本轮新建的独立TEMP下，运行前验证目标不存在且位于该边界，没有清理历史staging。

完整 `pnpm test:installed` **exit0，353.698s**（Turbo1/1、0cached）。本轮 owned run 为 `E:/cs2-analyst-s6/.tmp/installed-smoke-runs/run-do8KsC`。

生产/测试各安装和卸载，共4次NSIS操作全exit0。两包ASAR实际审计均99条目、约5.57MB，只有固定native绑定unpacked且SHA匹配，Renderer无Node。没有任何DEM、测试fixture入口或生产测试seam标记意外打包。生产同时注入两种DEM环境变量后保持原生选择阶段，15s持续检查未导入；随后通过真实磁盘File导入及错误恢复。两包真实报告、分析、深度复盘、Timeline、Replay、Heatmap均在完整套件内验收；受控错误输入有独立证据目录。

卸载验证的实际值：两app目录 `exists=false`，注册项 `[]`、相关进程 `[]`；补充只读查询再次一致。脚本虽允许空目录，**本轮实际目录已移除**。run下owner、profile、截图和JSON留作本轮证据，不把整个证据目录说成已删除。只终止本轮归属PID/创建时间匹配的进程，未处理无关进程或已有用户安装。

## 性能与历史对照

以下均为单次观测，不声称统计显著改善。参考值来自 `docs/p7-replay-ui-round-two.md` 的相同Dust2 SHA与既有replay-smoke/throw-audit路径；p95场景或探针有差异时只判断预算。受控650ms延迟不参与自然IPC p95，Nuke新探针的FPS/p95也不与旧版本硬比。

| 指标 | 本轮 | 历史参考 | 原预算 / 分类 |
|---|---:|---:|---|
| 完整Dust2导入，replay-smoke | 9427ms | 10128ms | ≤15000ms，满足；不宣称优化 |
| Parser + Spatial，throw-audit | 3477.941ms | 3718ms | 单列测量，不替代Replay查询或总导入 |
| 独立Replay查询 | 5131.302ms | 6137ms | ≤5000ms，**已知技术债仍未解决**；没有新增查询路径修改，未证实新增回归 |
| 首帧 | 131.4ms | 131.8ms | ≤1500ms，满足 |
| 12次Chunk IPC p95 | 9.6ms | 7.6ms | ≤250ms，满足；不与Heatmap或注入延迟混比 |
| Canvas绘制p95 | 0.6ms | 0.4ms | ≤16.7ms，满足；目标/场景差异不支持趋势结论 |
| Utility OS生命周期峰值 | 1685254144B | 1693642752B | ≤2.5GiB，满足；不是整应用同时RSS |
| Dust2序列化audit会话 | 37161246B、159块、最大384325B | 早期pre-follow为34757998B/371621B | ≤64MiB/块≤1MiB，满足；schema不同不作同体积趋势 |
| Nuke实际IPC会话 | 29834152B、141块、最大369573B | 最新死亡跟随相同值 | 满足；与source sessionId的29830345B分开 |
| Renderer缓存 | ≤3块 | ≤3块契约 | 满足 |
| Nuke探针FPS/p95趋势、底图OS/GPU增量 | 数据不足 | 不同观察开销 | **无法判定**，没有宣称改善 |

本轮未发现需要产品修复的新增性能回归；这不是所有场景无回归的证明。历史Replay查询预算明确保留，不放宽为“总导入15s就算通过”。

## 独立复审与最终判定

独立reviewer `/root/independent_review` 已完成只读源码、测试覆盖、全部失败记录及本MD/JSON交叉复核，结论 **PASS，无剩余P0/P1/P2阻断**。

独立核对42条命令的启动/结束、耗时、退出码与42份日志哈希；383张PNG的字节数/SHA/IHDR尺寸；29项证据、2个安装器与7个QA源文件哈希，全部零不匹配。S1完整trace计数与摘要一致。控件重跑实际观察204个独立缺块paint，真实clock固定17213.49920000005，均暂停/完整清屏/零数字标记/透明前景；3个真实恢复paint重新绘制玩家，目标block2的success响应实际持有650ms，应用意外console为空。

复审同时确认完整安装套件退出0、两次QA失败保留与完整重跑、真实全死/Vertigo/人工NOT RUN、原5秒查询债及不可比p95限制均分类准确。源码零产品差异，tracked DEM为空，diff-check通过。复核后的最终化仅更新结论、复审记录和上述初跑路径映射，没有改动原始证据或测试结果。

**P7-S6 AUTOMATED ACCEPTANCE PASS / READY FOR HUMAN ACCEPTANCE**

人工产品验收仍待进行；不自行标记整个P7 FINAL PASS，不进入L0–L5或P8。报告提交后按授权fast-forward合并并推送main，准确交付SHA见最终回复及包含本报告的Git提交。
