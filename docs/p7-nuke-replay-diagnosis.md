# P7-S0 — Nuke Replay 缺帧诊断

2026-10-18。**CONFIRMED ROOT CAUSE**。仅完成 S0；未修复生产行为，未实施 S1–S6 / L / P8，未修改版本、tag、release。

自动楼层把目标玩家的**插值位置可用性**当作整个地图的展示前提。目标临近死亡、死亡后或跨层时，其 Z 正确降级为未知，却连带清空所有玩家和底图。手动层在同一时间仍能显示其他有效玩家。这是已证明的显示上下文问题；另外确有原生同 tick 数据缺行，必须继续保守降级。

## 身份与方法

- 开始时本地 main/HEAD 为 `2641d600801beecdd58caf25624316733d6ee4e1`，工作区干净；旧 origin/main 为 `56cb31ec813362cb5fe7c021285ef6e44ee3101d`。fetch 后以 fast-forward 更新到指定 `a9ca7e8bed767e2087528bf40be3e6eb51e9034d`，作为全部本轮观察基线。
- 本地唯一 Nuke 输入：`.demo/nuke.dem`，471606780 B，**实际重新校验** SHA-256 `dea9382b9cc263fed9ee4ed7e71fa6be8c176cf888868f05b26d850af6f5cb3c`。未下载、替换、复制或提交 DEM。
- native 绑定 SHA-256 `132d664125b60542dc80dc8bc270e2c8e181a0a55433fdac5be285ef4d9b0de1`；Windows、Node v26.3.0、pnpm 10.0.0；真实 built Electron，1280×800，断网运行，21 回合、10 玩家、64 tick/s。
- 机器可读证据：[p7-nuke-replay-diagnosis.json](./p7-nuke-replay-diagnosis.json)。交付提交的最终 SHA 随 Git 提交生成，在交付消息与 `git log -1` 中记录，避免文档自引用自身提交哈希。
- 使用仓库已有 Electron/CDP、进程生命周期和真实导入流程；本会话无 Browser skill，未新增浏览器依赖。并非纯函数结果冒充 Electron。没有安装版或人工操作验收主张。

原始层通过生产 `parseWithReplay()` 及独立同计划 native 查询对照，再对五个窗口逐整数 tick 查询。开发查询只在 `dem-parser/dev` 内。生产 Replay → 独立 `ReplaySession` 全块逐字段检查，真实 worker → Main → preload IPC 全块核对 frames 的 FNV32 指纹和区间（指纹用于回归比较，不是密码学完整性证明）。Chunk guard 重复帧不计入原始有效率分母。

Canvas 每次实际 paint 后，按 `data-tick` MutationObserver 读取时钟、当前 React tree 中的 live 楼层/图片状态、只读缓存和样本；不调用会改变 LRU 的 `cache.get()`。包装原生 Canvas 方法并委托，核对真实玩家数字标记调用数与绘制计数。没有修改业务协议、生产源码或计算结果，没有高频主线程日志。

`Canvas.dataset.tick` 是实际 paint 的显示 tick；React UI tick 约 100ms 更新一次；玩家 tuple 的 actualTick 是原生观测 tick，插值时沿用左端证据，不冒充新的原生观测。倍速由真实控件与 `ReplayClock` 记录核对。

## 可稳定重现的五个窗口

下表相对时间均从正式 round.startTick 起算，包含冻结时间；区间为相邻样本的开放插值区间，两个端点保留原生精确状态。每窗均实际运行自动/主层/下层 × 1/1.5/4 倍速。

| 窗口 | 回合 / tick | 相对秒 | 目标 | 端点状态与归因 |
| --- | --- | --- | --- | --- |
| W1 | R1 / 4352–4356 | 52.125–52.1875 | rain / `76561197997351207` | 左存活、右死亡，原生 XYZ 两端及逐 tick 均有效；C→D |
| W2 | R2 / 18393–18395 | 149.375–149.40625 | karrigan / `76561197989430253` | 左存活、右死亡，原生 XYZ 两端及逐 tick 均有效；C→D |
| W3 | R1 / 4752–4760 | 58.375–58.5 | magixx / `76561199063238565` | 存活、同 segment，Z -492.53125→-542.515625，上→下；C→D |
| W4 | R2 / 16417–16425 | 118.5–118.625 | chopper / `76561198045898864` | 存活、同 segment，Z -488.734375→-523.375，上→下；C→D |
| W5 | R10 / 83106–83114 | 3.5–3.625 | karrigan / `76561197989430253` | 右端全体 native 行缺失；A→C，并触发 D |

完整左右 tuple（actualTick、XYZ、yaw、health、alive、team、segment、ambiguity）、逐 tick 原生参考抽样、每种模式的已画人数/时长/图片与楼层状态见 JSON。目标指 Replay 自有的玩家选择，不是报告顶部的全局目标。W1 tick4354 的目标原生仍 alive=true、100 HP，自动模式整图空白，手动主层同 tick 画出9名有效玩家；因此问题也发生于死亡边界**之前**，不是只有死人本身正常隐藏。

W3/W4 同层有效玩家仍能在对应手动层出现。其他楼层的玩家隐藏、或所选下层确实无玩家，是正常过滤，不计为数据丢失。W5 在手动主层也有短空白，不能只靠固定楼层解决。死亡目标的坐标不应延续成存活位置；跨层坐标不应做平面插值。

## 根因与证据链

1. `packages/dem-parser/src/providers/replay.ts:365–390` 保留有限 XYZ；仅存活、状态可靠样本给连续 segment。死亡断点不是 Parser 丢坐标。
2. `apps/desktop/renderer/src/replay-state.ts:70–81` 精确采样直接返回；采样间先清位置，只有同层、同 segment、双方存活且 gap≤8 tick 才插值。因此死亡边界和跨层区间目标位置未知是预期行为。
3. `apps/desktop/renderer/src/replay-player.tsx:285–288` 用这个 presentation selected Z 决定自动 layerId。目标未知即整个视图 layerId=null，与其他9人的可用性无关。
4. 同文件 `:387` 在 layerId=null 时整个前景早退；`:495–506` 的 url 变化还清空底图。截图实际证明底图也会消失；不是所有场景都表现为“底图仍在”。
5. 同文件 `:487` 的 React tick 约100ms更新，但 `:486` 每 RAF 用当前 tick 画玩家，形成当前目标层与 live 层的短暂不同步。它会延长/错开层切换和图片就绪窗口；其观测数量见 JSON，不据源码单独宣称时长。
6. `.demo` 命令头独立扫描到 DEM_Stop：67个缺行 tick 全无同 tick 命令。逐 tick 参考 W5 仍缺4个 tick/40行。归 A（记录/原生同 tick 证据不足），不是预算裁剪，也不能推断文件损坏、持续实体状态不存在或据此补位置。

按五个刻意选择的异常窗口计算，多因素可重叠：A=1/5（20%）、C=5/5（100%）、D=5/5（100%）；B/E/G未复现，F不属于这五窗的根因。C包括正常的死亡/跨层保守拒绝，不意味着这些规则应放宽。另行跨回合观察到短 F 等待；不得将预取请求或普通 IPC 往返当播放等待。

**PARTIALLY CONFIRMED**：原生缺行的记录级证据、显示层更新滞后已量化，但未做 native 解码器替代实现或地图碰撞/拓扑验证。**UNREPRODUCED**：额外的 Parser 预算丢样、已就绪且具备全部绘制条件的 Canvas 漏画、已证明的楼层资源/阈值分类错误。未复现不等于证明不存在。

## 定量结果与分母

| 指标 | 本轮实测 | 分母/解释 |
| --- | --- | --- |
| 原始位置有效率 | 237700 / 238370 = **99.7189%** | 23837个生产计划tick × 10人；含死亡原生XYZ，不是连续存活率或全tick统计 |
| Replay position有效率 | 237700 / 238370 = **99.7189%** | 同一计划机会；原生与Replay位置/actualTick对照0差异，存活有效位置两边同为198869 |
| 原生缺行 | 67个完整tick / 670行 | 每个缺tick十人均无行；所有67个tick都无同tick DEM命令 |
| 插值拒绝 | 40207 / 238160 玩家区间机会 | 23816对相邻采样，各取一个中点 × 10人；not-alive=38804、原生行缺失=1280、跨层/未知层=123；其余197953可插值。not-alive大部分是正常死人，不当作错误窗口 |
| 理论自动层未知 | 40207 / 238160 = **16.8823%** | 上述无权重中点，每人轮流作为假设目标；不是时间比例 |
| Electron自动层未知 | 9708 / 93017 = **10.4368%** | 仅实际自动模式paint；全部模式共105694条观察，不将手动层混入这个分母 |
| 完整1× R1/R2 | 86453条paint，7313层未知（8.4589%） | 默认Replay目标karrigan，从R1起点1016连续到R3 tick20409.208，正常完成R1/R2并观察到重新出现 |
| 已知层、原始XYZ有效但不显示 | 75325 / 861597 玩家机会 | 两端原生XYZ均在当前live层，含正常死人：74958为not-alive/state-unknown、190为死亡边界保守拒绝、177为image-not-ready。这里的坐标是**相邻原生端点**，不是分数tick的原生真值 |
| 上项限双方原生存活 | 171 / 786443 | 全部171为图片未就绪；不把它们计为G。自动层未知的机会不在该“已知层”分母内 |
| G类最终条件齐备仍漏画 | **0 / 92173** 可画帧 | 对应786272次玩家绘制机会；layer已知、chunk已到、imageReady、最终位置/存活/楼层/雷达边界全满足；真实数字标记调用数均与已画数一致 |
| Chunk播放等待 | **3次 / 合计31.0ms** | 4× R1→R2一次13.8ms，完整1×两次合计17.2ms；只计当前所需块未到，不计预取；观察中的等待tick推进均为0 |
| 最长连续零玩家画面 | **24394.8ms** | 完整1×从R2 tick18395.0352目标死亡延续至R3 tick20403.2688底图/10人恢复；观察墙钟，含直到下一非空帧的采样边界误差。全局空白指标也包含正常空楼层，不能直接当丢帧率 |
| 分块/传输 | 141块，29038916 B；全部frames/区间一致 | 独立源比较23957个含guard的帧副本；guard不重复计入采样有效率。141次显式IPC p50=8.4、p95=13.2、max=16.4ms，与播放等待不同口径 |

五窗1×自动模式的观测最长空白依次为 **1602.6 / 1628.8 / 212.5 / 103.7 / 360.2ms**；W1/W2短窗口在死亡后结束，时长受右端截断，不能当完整异常持续长度。相同窗口手动主层最长空白为 **0 / 0 / 0 / 0 / 250.3ms**。手动下层在W1/W5本就无玩家，空白是预期；W2同时存在主层7人与下层2人。完整1×记录中当前目标推导层与低频live层有24帧不一致，证实展示状态不同步；不据此推导地图分类本身错误。

主量化由两次Electron会话组成：初次45矩阵+2边界结果，以及分批收集的完整1×重跑；同一DEM、同一built产物，额外视觉序列会话不并入统计。观察器每paint读取React/10人状态会增加CPU和内存开销；这些数字用于定位因果和覆盖，不是无探针FPS/峰值内存承诺。用户未授权S1，本轮没有“修复后”数据。

## S1 最小修复设计（本轮未实施）

| 建议 | 已证明根因/窗口 | 最小文件范围 | 正确行为与边界 | 验证与影响 |
| --- | --- | --- | --- | --- |
| 展示楼层上下文与目标坐标解耦 | D；W1/W2死亡边界和死亡后，W3/W4跨层，W5缺行；位置如上 | `replay-player.tsx`、`replay-state.ts` 及对应测试 | 自动目标未知时明确提示；可保留**上一个可靠确认的楼层作为底图展示状态**并画该层其他有效玩家，不能称其为目标当前层。历史楼层须按 session/回合/目标/seek 规则失效。cold seek无可用历史时明确未知/手动选层，不能猜层或承诺任意seek都有底图。死人不画，未知位置不补 | 新增死亡前后、跨层、缺行、断连、精确/分数tick、冷/暖seek、切目标/session/回合测试；真实Electron同五窗重放。常数状态，零新增native/IPC，不保留坐标轨迹 |
| 同一显示 tick 决定 floor/players，减少图片清空抖动 | C→D和低频React live层滞后；W3/W4、W1复现前后 | 同上；图片生命周期限 `replay-player.tsx` | RAF内使用同一个frame解析展示上下文；React控件低频更新可继续。图片缺失仍诚实降级；层未知不应反复卸载可靠展示底图。若预解码双层图片，要限制为当前地图资源身份，禁止把保留底图变成位置证据 | 假定1024² RGBA每层约4MiB，预解码两层最多额外约4MiB相对当前单层，属于估计，S1实测；IPC零增加。测试首帧、image error/ready、快速切层、DPR/resize、seek跨块与连续跨回合 |
| 原始证据不足继续降级，说明不同缺失原因 | A+C；W5/67缺tick，以及正常断点 | 优先复用上述纯显示状态；必要提示仍在 `replay-player.tsx`，不改DTO | 未取得新证据前不改采样计划/预算、maxGap、segment、actualTick和native行；缺行/跨层区间保持无位置。只解释正在等数据/目标层未知/其他层被隐藏 | 保留native/Replay parity及source availability；缺行测试不得期待补点。无需新依赖、无数据猜测、无新增IPC |

兼容性：Dust2单层的楼层函数本就可确定，不应改变其位置、时钟和事件表现；Nuke/Vertigo共享双层上下文状态策略，但保留各自高度边界（-495 / 11700）与未知语义，不能共用Nuke数值。S1必须重跑Dust2真实smoke、Nuke五窗/完整回合/三个倍速/手动层/暂停seek/跨块；本地无真实Vertigo则只做合成边界且明确真实NOT RUN。不得据Dust2推定多层通过。

S1不应修改 Match/Spatial/Analytics/Findings/Deep Review、热力图统计、事件tick、连续segment、Chunk协议和缓存预算。不生成坐标、不跨层插值、不无限延续旧位置。安全可修的是展示上下文与提示；A类证据不足本轮无法安全恢复玩家轨迹。

## 与缺帧直接相关的空间边界

- 真实XYZ与native逐点一致，Nuke两层按现有overview范围稳定分类；Z=-495重叠边界继续未知。W3/W4原生Z穿越阈值，拒绝插值合理。该证据不等同雷达与本录像版本精确配准；版本仍unconfirmed，E未被证明。
- 自动跟随正常同层存活目标可用；死亡/跨层/缺行时出现上述D，不能宣称双层自动跟随已通过验收。
- `apps/desktop/shared/heatmap.ts:47–59` 单层筛选排除未知层/其他层；floor=null会在同XY格合并不同Z，当前UI声明“全部楼层/合并统计”。这是误读风险，非本轮证明的单层桶错误，不展开S2。
- Deep Review `execution.ts:64–67`、`teamplay-evidence.ts:157–164`、`utility-context.ts:108–116` 保留水平距离、垂直差和三维直线距离。XYZ或直线近都不证明隔板可穿、路线可达、LOS、可支援/补枪。本轮没有证明某条真实结论误判，不扩大成完整跨地图语义审计。

## 复现命令与本地产物

从仓库根目录执行，依赖本机已有native和白名单DEM，无下载：

```powershell
pnpm typecheck
pnpm build
node scripts/replay-nuke-source.mjs
node scripts/replay-nuke-electron.mjs
node scripts/replay-nuke-electron.mjs --sequences
node scripts/replay-nuke-report.mjs
node --test packages/dem-parser/dev/replay-diagnosis.test.mjs apps/desktop/tests/replay-diagnosis.test.mjs
pnpm --filter @cs2-analyst/desktop test
node scripts/replay-smoke.mjs
git diff --check
git ls-files '*.dem'
```

`--quick`仅跳过完整R1/R2长播，不能拿它声称完整回合验收。`--sequences`重放1×三层五窗并在实际播放中截图，读像素/CDP截图会扰动时序；它只用于连续图像证据，不进入主运行定量时长。主运行的截图在暂停seek后采集，定量仍有只读探针开销，不是无探针FPS、性能或内存承诺。

本次初次长播到达R3后，一次性 `Runtime.evaluate(window.__s0.frames)` 取回累计trace时CDP连接关闭；没有取得这段可审计trace，不把它称为通过或业务播放崩溃。已保存此前45组矩阵与2组边界结果；诊断器改为每150ms最多排空256条QA记录，并以 `node scripts/replay-nuke-electron.mjs --full-only` 在新Electron会话重跑完整R1/R2。该参数只续补已有审计，需保留此前 `electron.json` 与各帧文件；常规从头复现仍使用不带参数命令。失败日志保留在 `.tmp/p7-s0-electron-run.log`，重跑另存 `.tmp/p7-s0-electron-retry.log`。

大体积原始数据、每次paint状态、连续截图、Electron日志均在Git忽略的 `.tmp/p7-nuke-s0/`，不提交。`wN-跟随玩家-1-frames.json`等是实际paint trace，`sequences/*-sequence0/1/2.png`是连续播放图像，主目录 `w1-跟随玩家-tick4354.png` 与 `w1-主层-tick4354.png` 为同tick对照。JSON保留文件名、截图时状态和少量原生行，便于本机核对。

连续播放截图附带的tick是在请求CDP截图前读取，随后播放仍推进，不将该标注称为像素级同步tick；精确对照使用暂停seek图和原生参考。底图空白另由全Canvas alpha读取核验，不仅依靠DOM属性。

## 验证、复审与交付

| 命令/范围 | 结果 |
| --- | --- |
| `pnpm typecheck` | PASS，15/15 tasks |
| `pnpm build` | PASS，8/8 tasks，含地图资源摘要检查 |
| `pnpm --filter @cs2-analyst/desktop test` | PASS，153 passed / 0 failed / 0 skipped，包含本轮3项S0重现/统计测试 |
| 专用诊断测试（上方node --test命令） | PASS，5/5；其中3项与Desktop重叠，新增native命令头scanner 2项；不重复累计覆盖 |
| `node scripts/replay-smoke.mjs` | PASS，真实Dust2；导入7602.1ms、首帧80.4ms、drawP95 0.3ms、12次IPC p95 6.4ms，reportUnchanged=true；未放宽既有预算 |
| 真实Nuke source / Electron矩阵 / 完整1×重跑 / 连续截图 | DIAGNOSED，五窗稳定复现；141实际IPC块与源一致；完整R1/R2从头播放、进入R3，暂停/反复seek/跨块/跨回合/换Replay目标均实际执行 |
| `git diff --check`（含staged） | PASS |
| `git ls-files '*.dem'` | PASS，空输出 |
| 独立只读复审 | 通过，无剩余阻断；已审查源码因果、诊断工具、最终JSON/trace总数与S1边界，并独立执行18项Replay/几何/诊断测试及2项scanner测试；发现的live层/target层统计混用已修正，sequence截图开销独立标注 |

**NOT RUN**：完整dem-parser/Analytics/Findings/Deep Review全套（本轮未改这些生产模块）；真实Vertigo、全21回合逐显示帧播放、所有回合所有玩家目标组合、真实断连故障、安装包验收、物理跨屏DPI、独立人工walkthrough。source审计覆盖全21回合采样，但不等于Electron逐帧覆盖全场。主运行异常诊断不是产品验收PASS或已修复声明。

变更仅9个新增文件：本报告和结构化JSON；`packages/dem-parser/dev/replay-diagnosis{,.test}.mjs`；`scripts/replay-diagnosis-core.mjs`、`replay-nuke-source.mjs`、`replay-nuke-electron.mjs`、`replay-nuke-report.mjs`；`apps/desktop/tests/replay-diagnosis.test.mjs`。域包生产依赖方向未改变，Desktop没有直接native依赖，未改任何生产Replay/热力图/报告/深度复盘/Collapse代码。

截图/trace/临时日志不在提交范围；仅保留可按需重跑的S0工具，没有临时生产调试代码或无条件日志。按用户要求将这一个S0工作单元提交并推送origin/main，交付后应为工作区干净、HEAD与origin/main一致；具体最终SHA与实际推送状态以交付消息和Git为准。**停止在S0，等待S1单独授权。**
