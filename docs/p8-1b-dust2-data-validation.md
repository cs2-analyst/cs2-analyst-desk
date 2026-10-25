# P8.1B-R：按 L1/L2 范围重新复核 Dust2 数据适配

日期：2026-10-25（Asia/Shanghai）。**L1 子能力局部 PASS；L2 仅数值子能力 PASS；P8.1B-R 整体 BLOCKED / NOT PASS。** P8.1 尚未完成，P8.1C/D 不自动放行，P8.2 继续禁止进入。

本轮使用真实 DEM 重新验证了非空服务器事实输入；`availableTick` 缺失不再整体阻断 L1。单 tick 状态、服务器人数变化及原始 XYZ 距离可以描述；玩家当时知道/看到什么、战术优劣和未经验证的几何结论仍不成立。原 P8.1B 的 **BLOCKED / NOT PASS** 未被追认或改写，其完整报告原文保留在本文后半部。

## R1. 基线、范围与历史核验

- 开始时工作区干净，HEAD 和远端原验证分支均为 [3c09ee7944ee82aa2ad12703477fe1c006aa8fe3](https://github.com/cs2-analyst/cs2-analyst-desk/commit/3c09ee7944ee82aa2ad12703477fe1c006aa8fe3)，main / origin/main 为 `f44984e5464552c81737922c67df3d9f17c27c71`；已实际 `git fetch origin --prune`。
- [范围决策 PR #4](https://github.com/cs2-analyst/cs2-analyst-desk/pull/4) 核对结果为 **open、draft、merged=false**，head `8f61854793f3d9230d1cd160b3fd01dedaafcadd`。通过已 fetch 的对应提交读取 [范围决策](https://github.com/cs2-analyst/cs2-analyst-desk/blob/8f61854793f3d9230d1cd160b3fd01dedaafcadd/docs/p8-scope-decision-l1-l2-2026-10-25.md)、[技术路线](https://github.com/cs2-analyst/cs2-analyst-desk/blob/8f61854793f3d9230d1cd160b3fd01dedaafcadd/docs/ai-coach-technical-route.md)、[P8.1A 契约第 12 节](https://github.com/cs2-analyst/cs2-analyst-desk/blob/8f61854793f3d9230d1cd160b3fd01dedaafcadd/docs/p8-1a-decision-evidence-contract.md)。这些仍是未合并文档；依据本任务明确的用户范围决策开展实验，没有将草案导入为正式 API。
- 独立分支 `codex/p8-1b-r-l1-l2` 从原 P8.1B 提交创建；生产代码与当前 main 相同。版本保持 0.2.0。未合并其他分支，未修改生产代码/公共契约/依赖/阈值/回放/归档/统计，未创建服务、模型调用、tag 或 Release。
- 已读全局/项目 AGENTS、fixture 白名单、DEM/domain 工作流、模型路由、架构和 roadmap。按仓库要求安排独立 reviewer，只读复审；所有新增可执行逻辑都位于 `docs/experiments/`。
- 原 JSON 与 `git show 3c09ee7:docs/p8-1b-validation-2026-10-25.json` **字节一致**，SHA-256 为 `df147dda80b00400130956cf29f03705ebe5d2a47ac15767ee14dff4ed7dc699`。原记录的 14 项命令日志均存在，全部摘要吻合。由此核实历史：24 回合、4 形成点/8 观察者切片、72 次比较、21/21 边界、48/48 parser、192/192 deep-review、typecheck/build 通过、3452 个历史 optional tick 消失，以及 availableTick 缺口与未通过结论。

[机器证据](p8-1b-validation-2026-10-25.json) 采用新 envelope：`historical.record` 完整保留原 JSON 对象，`historical.audit` 保存这次核对结果；`currentRun` 单独记录本轮命令、实测、摘要、复审及未执行项。历史复跑次数不累计为本轮唯一测试。

## R2. 新的 L1 验收口径与实际数据

只接纳可信本地 pinned native 查询链上的服务器记录；本实验不是接收任意客户端 JSON 的认证机制。`ServerStateAtTick`、`SpatialActionContext` 是建议职责名；本轮没有生产类型。实验 body 版本为 `p8-1b-r-server-facts-experiment-v1`，显式标注 `L1-server-facts; NOT PlayerKnowledge`、whole-tick 终态和 map geometry `unconfirmed`。

| 本轮重新实测 | 结果 |
| --- | --- |
| 文件 / 大小 | `.demo/dust2.dem` / 557650967 bytes；原文件未移动、复制或修改 |
| SHA-256 | `db90fe85aab023a1d2c8a5996182e6120d98ef494f02a070b17982b235e4958c` |
| 地图 / tick rate / 回合 / 玩家 | `de_dust2` / 64 / 24 / 10；64 为全场解析审计值，不带入前缀输入 |
| header patch | `14055`；不证明地图几何版本 |
| parser / native | dem-parser 0.2.0；`0.42.0-backport.363.1` / Windows MSVC；完整 source/fix/patch provenance 见 JSON |
| native binary SHA-256 | `132d664125b60542dc80dc8bc270e2c8e181a0a55433fdac5be285ef4d9b0de1` |
| 精确查询 | 每个锚点 1 tick × 2 个前缀存活者 × 9 个 native 字段，共 8 行；实际返回 tick 全部等于请求 tick |
| 规范化字段 | 每行 position/view/health/side/alive/weapon 六项，共 **48/48** 有效；0 缺失；不代表 native 全字段完整性 |
| 同源交叉检查 | 与 4702 core tick 查询中的对应行完全相等；每点全体 alive 集合一致；4 次独立 freeze 查询共 40 行与原 adapter 基线一致 |

每项 snapshot 事实带 actual tick、局部引用；本地引用通过 DEM SHA、native/source 版本、tick、唯一存活阵营身份和规范化行摘要复现。人数变化另有 freeze 基线 tick/摘要及逐条死亡 tick/内容摘要。原 `round.events` 的 eventIndex 放在本地报告，不用于排列同 tick 动作，不进入模型可见 body，也不因未来行数产生别名偏移。私有 SteamID、昵称、原始坐标行与完整轨迹不写入提交。

| 回合 | g / cutTick | freeze tick | 形成事件索引 | 服务器人数 CT:T | 同 tick XYZ 距离（world units） |
| --- | --- | ---: | ---: | --- | ---: |
| 11 | 92395 / 92396 | 85208 | 255 | 1:2 → 1:1 | 247.927151 |
| 22 | 185100 / 185101 | 178895 | 280 | 2:1 → 1:1 | 628.007403 |
| 23 | 194101 / 194102 | 187245 | 260 | 2:1 → 1:1 | 798.938374 |
| 24 | 201348 / 201349 | 195874 | 287 | 2:1 → 1:1 | 465.430808 |

上述每个 g 的原子死亡组均只有 1 次死亡；多个同 tick 死亡的原子处理、互相击杀、冲突死亡、缺失身份、baseline 冲突与生命周期中断由合成边界测试覆盖，不能冒称该 fixture 覆盖了所有异常场景。所有 native 行都是 g 结束时的服务器状态，`cutTick=g+1` 只接纳 `<cutTick`；没有 g 内的 subtick 顺序。

四个形成点可以支持“此 tick 后双方各存活一人”“服务器记录 HP/位置/朝向/活动武器为何”“同 tick 两端点相距多少”等事实复盘。它们**不是四个合格教练案例**：未建立行动机会、替代动作可行性、移动窗口、匹配几何或专家标签。距最终结束 39/416/44/213 tick 仅在离线审计中保留，既不进入输入，也不用于确定战术机会。合格战术决策案例仍为 **0**。

## R3. 固定 tick 查询与未来信息隔离

[独立构造器](experiments/p8-1b-r-server.mjs) 在转换前裁剪事件/边界状态，仅使用前缀重建基线、原子死亡和存活者。输入顺序稳定化，对完全相同的投影记录去重；不相同的同键 snapshot/baseline 或同 victim 死亡保持冲突并拒绝。无法定位 tick 或死亡身份不能静默丢弃；本轮复审发现 converter 会忽略未知 victim，已在实验层转换前加守卫及回归。原生产 converter 不变。

固定计划 `p8-1b-r-exact-final-tick-v1` 只查 `g=cutTick-1`、前缀确定的两个存活者和九个指定字段。没有 optional 预算、旧值填充、插值、全场 coverage、最终 winner、game_time、全量 roster 或最终片段长度。缺失字段、冲突与无效值保持 unknown；缺乏玩家接收时间不伪造 availableTick。L2 距离仅在双方 XYZ 均有效时计算，非法/溢出拒绝，不把异常坐标转为 0。

**候选枚举与输入隔离须区分：**本轮离线枚举仍读取完整 Match 的正式回合窗口来重新定位历史四个锚点；其结果用于本地核对，不宣称全量候选枚举具有前缀稳定性。扰动测试锁定这些 round/cutTick 参数，再独立比较前缀 `selection`、query plan 和完整 body。未来 round end/restart 不参与固定锚点的接纳判定。未来若要在线/窗口化候选发现，需单独设计和验收，不能复用离线选择结果作为模型质量标记。

[真实实测程序](experiments/p8-1b-r-dust2.mjs) 对 4 个双人输入分别执行下列 10 类变化，共 **40 次完整比较**：

1. 未来实体 XYZ、HP、yaw/pitch、武器变化（含对手）；明确检查未来行存在。
2. 新增未来伤害/击杀/开火/道具事件。
3. 移除未来上述战斗/道具事件。
4. 改写最终胜负和结束快照。
5. 未来名单、spawn/disconnect/team、同号 round restart，额外 effect/离线 coverage/finalScore metadata。
6. 追加 30000 条未来事件，测试全场预算压力。
7. 移除所有事件、effect expiry、边界及实体行的未来后缀，清除全场 roster。
8. 改写未来 game_time、header playback/tick-rate metadata。
9. 倒置行顺序并加入完全相同重复行。
10. 另加 513 条未来事件改变密度。

每次深比较整个返回值：非空字段、规范化缺失标记、truncated、coverage、局部引用及本地映射、schema、模型可见 metadata、采样选择、玩家选择与 formation eligibility。没有只比较 HP，也没有沿用旧版全 unknown 的稳定性结论。另有 **8 个正对照**：每锚点修改历史 HP/XYZ 必须改变相关状态/距离；移除形成死亡必须改变 selection。40/8 是循环内比较次数，不计作 48 项唯一运行时测试。

同一未改写 DEM 的稀疏精确请求与密集查询、基线重查提供 native 实测支撑；受控变化在 **native-output 边界**进行。没有重写、截断 DEM 二进制重新解码，因此不宣称证明任意 native decoder 的全因果性。L1 PASS 仅限此固定 fixture、pinned native、四锚点与已测字段。单 tick 不能证明移动轨迹、完整决策过程或历史窗口。

现有 `planSpatialSampling()` 风险仍在：真实前缀保留、未来增加开火后，core 4702→78362，optional 6835→0，3452 个截断前 optional tick 消失。旧边界测试 L01 还保留 budget=5、仅增加 `weapon_fire@300` 即删除历史 tick 92 的最小复现。**风险有效隔离于本实验输入路径，未修复原采样器，也未为产品上线验收。**该路径使用自己的明确请求，既不消费旧 sampler 选择也不输出其 coverage。

## R4. L2 的真实边界

完整门控见 [L1/L2 能力矩阵](p8-1b-r-l1-l2-capabilities.md)。本轮读取本地原始 overview 和 PNG，核实与固定 manifest 的 SHA、1024×1024 尺寸及 `posX=-2476,posY=3239,scale=4.4` 一致。八个真实端点算术投影均有效且在图内；最大逆变换浮点误差约 `2.27e-13` world units。**这是算术一致性，不是独立地图地标误差。**已有历史 P6 地域校准未被重新计作本轮验证。

| L2 能力 | 本轮结论 |
| --- | --- |
| 世界坐标→雷达算术及本地资源身份 | PASS，限定数字投影子能力 |
| DEM 与地图版本匹配、真实地图位置精度 | BLOCKED，versionMatch 仍 unconfirmed，独立地理误差未知 |
| 同 tick 玩家间 XY/XYZ 距离 | PASS，4 对端点、原生世界单位；不等同路线/到达时间/支援性 |
| 某段时间位置变化 | NOT RUN，单 tick 不构成时间序列 |
| 导航可达性、静态 LOS/遮挡 | BLOCKED；缺版本匹配数据与基准，几何实测 NOT RUN |
| 多楼层关系 | BLOCKED；Dust2 只有无界 default 层，ΔZ 不代表楼层 |
| 烟雾/动态遮挡、协同/支援 | BLOCKED；缺空间体积/通路/时间/交战条件的联合验证 |
| POV、实际注意力/心理推断 | UNSUPPORTED，产品范围排除 |

没有下载替代地图或 DEM。没有将雷达资源、工具声称的功能或“能计算距离”当作已验证碰撞几何。

## R5. 实际检查、复审与门禁

复现入口（仓库根目录，Windows）：

```powershell
node docs/experiments/p8-1b-r-checks.mjs
```

| 本轮检查 | 结果 | 退出码 |
| --- | --- | ---: |
| 四个新增 mjs 语法检查 | PASS | 各 0 |
| 新 L1/L2 边界与前缀测试 | 26/26（10 前缀扰动测试 + 16 边界/正对照）；0 fail/skip | 0 |
| 原 P8.1B 实验回归（本轮重跑） | 21/21；0 fail/skip，含旧 sampler 限制见证 | 0 |
| 选定 parser 回归，固定 Dust2 | 48/48；0 fail/skip，含真实 provider/replay | 0 |
| 选定 deep-review 回归 | 192/192；0 fail/skip | 0 |
| match-model 编译式测试、parser/deep-review 类型契约 | PASS；没有虚构运行时测试数 | 各 0 |
| 强制 typecheck / build | 15/15 / 8/8 Turbo 任务，PASS | 各 0 |
| 新真实 DEM 程序 | 实验断言 PASS；L1 局部 PASS；阶段 BLOCKED | 0 |
| 地图几何真值实测 | NOT RUN，前置匹配资源/基准缺失 | 不适用 |

本轮唯一运行时测试 **287 项**（26+21+48+192），0 失败、0 跳过。编译任务、真实脚本内断言、40 次比较和 8 正对照不叠加为测试项。独立 reviewer 的重复执行与修订后的针对性复跑也不重复累计。准确命令、退出码、起止时间、摘要、日志 SHA 以及最终脚本 SHA 均保存在 JSON `currentRun`；原始日志仅留 `.tmp/p8-1b-r/`，不提交私有日志。

独立复审促成三项修订：无效死亡身份必须在转换前拒绝；“移除完整后缀”覆盖 effect expiry；明确离线全量候选枚举仍使用完整回合边界。均仅修改实验/证据，针对最终源再执行语法、新边界和真实程序。详见 JSON 复审记录。

其余 NOT RUN：改写 DEM 二进制的 native 因果实验、连续/窗口轨迹、其他地图/个人 fixture、全 Electron/安装版/交互回归、地图几何真值、客户端接收/感知、部署/native/SQLite 服务兼容、鉴权/配额/保留、模型输出、专家教练标注、来源许可/去重分组/隔离保留集/评测协议与 P8.2。原因分别是本轮单 tick 限定、必要证据缺失或未获后续阶段授权。

六项最终要求中，真实来源、L1 字段时间边界、限定前缀稳定、服务器事实不冒充认知、L2 逐项状态和命令交付均有证据。但完整 L2 未通过，故按本任务最终门禁，**不得将 P8.1B-R 整体标 PASS**。L1 局部通过不解除 P8.1C/D 和 P8.2 的门禁。

Git 交付为本独立分支上的聚焦提交；最终 SHA 用 `git log -1 --format=%H -- docs/p8-1b-dust2-data-validation.md` 读取，避免自引用。本轮不直接推送 main、不合并 PR。没有需要修改生产代码才能完成本轮局部 L1 验证的阻塞；剩余 L2 与后续 P8.1 工作需另行作产品决定。

## R6. 变更记录与历史记录边界

2026-10-25：新增本节 R1–R6、独立服务器事实实验/测试/运行器和能力矩阵；JSON 将原对象完整移至 `historical.record`，新增 `currentRun`。原四个 P8.1B 实验文件未改。以下是提交 `3c09ee7` 的报告原文字节内容；其中“本轮”“当前”等均指原 P8.1B，不是上面的 P8.1B-R。

---

# P8.1B：Dust2 1v1 决策证据真实数据适配验证

日期：2026-10-25（Asia/Shanghai）。**P8.1B：BLOCKED / NOT PASS。**

真实 Dust2 已完成解析、字段检查、候选发现和前缀实验：4 个 1v1 形成点、8 个观察者切片可恢复服务器历史事实。但 native 实体行不能证明 P8.1A 所要求的玩家可获知时间 `availableTick`；严格玩家信息输入没有获准的游戏事实。不能以解析成功、空输入稳定或本地自身事实完整宣告阶段通过。

## 1. 基线、远端和变更边界

- 开始前执行 `git fetch origin --prune`；本地 main、HEAD、origin/main 均为 `f44984e5464552c81737922c67df3d9f17c27c71`，工作区干净，版本 0.2.0。
- [审计 PR #1](https://github.com/cs2-analyst/cs2-analyst-desk/pull/1)：open、未合并、非 draft，head `ad80128c227188b267eb5f978ae1b962713e2aa7`。
- [P8.1A PR #2](https://github.com/cs2-analyst/cs2-analyst-desk/pull/2)：open、未合并、draft，head `a289d8d92881b1431a3d530d6f92663909d7dfb4`。
- 通过已 fetch 的两个远端分支读取审计文档、P8.1A 契约和 JSON，没有合并、cherry-pick 或导入 P8.1A 原型。
- 独立分支：`codex/p8-1b-dust2-data-validation`，从最新 origin/main 创建。验证完成时 HEAD 为 `f44984e5464552c81737922c67df3d9f17c27c71`，当时因门禁 BLOCKED 暂未提交。用户随后明确授权“先提交并推送”；本轮据此交付聚焦证据提交，推送到同名独立分支，不合并 main。Git 交付不改变阶段结论。
- 交付最终 HEAD 是承载本报告的提交，使用 `git log -1 --format=%H -- docs/p8-1b-dust2-data-validation.md` 解析；远端使用 `git ls-remote --heads origin refs/heads/codex/p8-1b-dust2-data-validation` 核对。避免在提交内容中写入无法自引用的自身哈希，实际提交 SHA 与推送结果在交付汇报中记录。
- 已读 AGENTS、全局 AGENTS（仅自引用路径，无新增规则）、roadmap、AI Coach 技术路线、fixture 规范、DEM/domain 工作流及模型路由；按仓库独立 reviewer 要求进行复审。
- 本次用户授权仅覆盖 P8.1B，优先于 AGENTS 的默认“不启动 P8”。不扩展至 P8.2。

新增文件仅六个：

1. 本报告。
2. [机器证据记录](p8-1b-validation-2026-10-25.json)。
3. [隔离前缀与白名单实验](experiments/p8-1b-prefix.mjs)。
4. [真实 Dust2 验证程序](experiments/p8-1b-dust2.mjs)。
5. [边界测试](experiments/p8-1b-prefix.test.mjs)。
6. [可复现检查入口](experiments/p8-1b-checks.mjs)。

生产 packages/apps、公开领域结构、Findings 规则、回放/热力图/归档/统计、依赖和版本均未修改。未创建后端应用、tag、Release、模型调用或训练任务。所有 raw rows 仅在进程内存；没有保存/提交 DEM、玩家昵称、SteamID、坐标轨迹或库存明细。提交候选材料仅包含聚合数量、摘要及定位 tick/事件索引。

## 2. 契约兼容性与实质缺口

P8.1A 是草案，不是生产 API；Match/Round/Replay/Spatial 的现有结构与其分层建议兼容。仍有以下语义边界：

1. **服务器采样 tick 不等于 availableTick。** P8.1A 第 4 节要求 `observedTick < cutTick` 且 `availableTick < cutTick`，后者指观察者可获得信息的时间。当前自身实体行只能验证前者；网络接收、HUD 呈现、实际感知时刻没有可靠适配器。不能静默令两者相等。
2. 本地 `auditedSelf` 使用 `status: observed-server-fact`、真实 observedTick、`availableTick:null`，保留可审计的非空自身事实。它不是 InformationState，不进入模型。
3. 严格模型投影将这些字段标为 `unknown: player-availability-time-unverified`，能力门槛为 abstain。无伪造的 known 字段，无假定 tick 延迟，无静默改写 P8.1A。
4. 双方人数在服务器前缀可核验，但 HUD/击杀提示的公开渠道及可获知时间未验证，所以模型中的 `publicAliveCounts` 仍 unknown。候选身份、形成原因及全局 QC 不进入模型，也不影响自身样本是否缺失。
5. 本实验只接受本机 pinned native 的输出；不是外部客户端来源认证机制。伪造 `audience/self/verified` 字符串不授予事实可信度。

早期本地实验曾将自身采样 tick 当 availableTick，独立复审指出冲突后已撤销。最初 harness 输出的 PASS 属于被否定的中间判定，不是阶段证据；最终程序与本报告均为 BLOCKED。复核同时发现并修正全局 QC 影响自身缺失标记、无效 tick 静默丢弃及 core 统计命名问题。

## 3. 真实输入与解析身份

| 项目 | 本轮实测 |
| --- | --- |
| 文件 | `.demo/dust2.dem`，已有本地白名单文件 |
| SHA-256 | `db90fe85aab023a1d2c8a5996182e6120d98ef494f02a070b17982b235e4958c` |
| 大小 | 557650967 字节 |
| 地图 | header 与 Match 均为 `de_dust2` |
| tick rate | Match 实测 64；8 个候选前缀单独重算也为 64 |
| 正式回合 / 玩家 | 24 / 10 |
| header patch_version | `14055`；不证明地图几何版本匹配 |
| 运行环境 | Windows x64，Node v26.3.0，pnpm 10.0.0 |
| native 包 | `0.42.0-backport.363.1`，MSVC |
| base / fix | `d3767705dc5846d73ed29db50eaeda58778dc934` / `451321a517ec9c0c6be7f0103dd07e7a805c3345` |
| native 二进制 SHA-256 | `132d664125b60542dc80dc8bc270e2c8e181a0a55433fdac5be285ef4d9b0de1` |

完整 source/patch/binary provenance 在 JSON。文件没有移动、替换、下载或复制。脚本固定该文件与摘要，拒绝替代输入；缺文件输出 BLOCKED，身份/地图/解析不符输出 FAIL，不回退合成数据。

路径：原 adapter `parse()` → converter `convertToMatch()`，并与公共 provider `parseWithReplay()` 的 Match 深比较一致。额外查询只位于 docs 下的实验，调用现有 native API；正式解析器未新增查询。

## 4. 字段来源与覆盖

以下“有效”仅代表实际返回且通过指定类型/范围/身份校验，不是地图精度、客户端可见性、业务语义完整性或战术置信度。JSON 的 present/valid/total 为准确分母；事件字段键采用各类型全部行的并集，字段键存在不等于每行完整。

| 字段 | 已声明 / 生产查询 | native / 此 DEM 实测 | 限制 |
| --- | --- | --- | --- |
| round start/freeze/end | Round；parseEvents + 边界 parseTicks | raw start/freeze 各 25、end 24；正式 24 回合均有 3 边界，共 720 玩家状态行，身份/side/alive/tick 720/720 合法 | raw 多出的开始/冻结不能冒作正式回合；完整 round_end 仅作离线核验 |
| 身份/阵营/生命周期 | parsePlayerInfo、事件 extra、边界快照 | 10 玩家；spawn 240、team 10、disconnect 1；251 行身份/阵营/tick 校验通过 | 不等于连通性/重连完整证明；本轮无回合内异常实证，仅边界测试 |
| XYZ、yaw/pitch、HP、alive、side | Spatial 的 9 字段查询；Replay 无 pitch/weapon | 4702 个 core tick、47020 行，上述字段各 47020/47020 有效；4 锚点 40 行亦全有效 | **并非每个 tick**；不能从稀疏行恢复连续速度/动作/感知 |
| 活动武器名称 | Spatial 可选 active_weapon_name | core 37948/47020；4 锚点 8/40，存活行 8/8 | 死者缺武器；名称不是稳定武器 ID，也不是完整库存 |
| 伤害 / 护甲 | DamageEvent；player_hurt | 629 行 dmg_health/dmg_armor/remaining HP/armor 全有效；attacker ID 618/629 | 11 行无玩家攻击者；事件护甲不是持续装备快照；reported damage 不是有效扣血或决策价值 |
| 击杀 | KillEvent；player_death | 166 victim ID/side/tick 全有效；attacker ID/side 161/166；4 行在正式回合结束后 | world/无归属不编造攻击者；同 tick 数组索引不是先后 |
| 开火 | weapon_fire | raw 3991，身份/side/weapon/tick 3991/3991；domain 3989 | 含投掷释放/刀等；不能等同枪弹、命中、输入动作或反应时间 |
| 道具效果 / 受闪 | UtilityEvent/FlashEvent | 632 效果原点 XYZ/tick 全有效；500 受闪事件 | 效果原点不等于玩家观察/遮挡；受闪数不是可靠注意力或实际失明区间验证 |
| 炸弹 | BombEvent；7 类 native 事件 | raw 168，关联身份/side/tick 全有效；domain 167；begindefuse haskit 4/4 | siteIndex 非 A/B；不能把全局炸弹事件直接当玩家听到/知道 |
| 护甲/弹药/库存/钱/拆包器/头盔 | 现有正式空间契约不持久化；native 名称先核对 pinned maps.rs | 实验在 4 锚点查询 7 字段：护甲/库存/balance/kit/helmet 40/40；弹夹/余弹 8/40；存活者所有字段 8/8；库存 26 元素均为非空字符串 | **仅增量能力探针**，非正式支持；未证明库存完整性/数量语义、可执行动作或模型可获知时间 |
| 敌方最后已知位置、雷达、声音、报点 | 没有已验证观察适配器 | NOT RUN / unavailable | 保持 unknown；不由 relevant、LOS、距离或目标被击中推断 |

增量查询的依据：现有 9 字段没有弹药/库存/经济，pinned native source `maps.rs` 已声明对应名字，故在已有候选 tick 上用同一 DEM 做有界 API 能力探针。没有依这些结果扩大生产契约。

现有 Spatial 共请求 11537 tick（4702 core + 6835 optional），返回 115370 行，未发生实际预算截断。唯一 core 玩家行 47020/47020 精确返回且 core 字段 complete；整体 coverage 是 partial，含未知参与者、死者武器缺失、回合外上下文等。JSON 中 representativeUnique* 只是按 tick/player 保留最后 binding 的诊断统计，含被省略的回合外上下文，不能当严格覆盖率分母。

Replay 实测 24 回合、27466 帧、274660 玩家样本、missingPlayerSamples=0；是 8Hz 网格加事件/边界，不是完整逐 tick 轨迹。Spatial 含 138860 个 relevant binding；它们明确是全局实体状态，**没有任何一个仅因 relevant 标签而获得玩家已知信息资格**。

## 5. 候选发现与前缀存活核验

离线候选索引与输入分离。既有 `resolveRoundAliveState()` 用于离线对照；隔离 reducer 复用其身份/side/tick 校验原语和原子死亡组语义，但先从 native 输出移除 `tick >= cutTick`，再调用现有 converter。这样未来 round restart、玩家总名单及全场 clock 不会先污染历史转换。

规则：

- 只接受正式窗口内的死亡组，g 是完整原子组 tick，`cutTick = g + 1`、before-tick。`cutTick >= endTick` 的离线候选不采纳；不猜同 tick 内顺序。
- 精确 freeze_end 快照必须唯一、observed、没有未知身份；本实验进一步限定标准 5v5、两边各 5 人已存活。没有 start fallback，没有 roster 猜补。
- 从 baseline 到截断的 spawn/disconnect/side_change、重复死亡、side 冲突、缺失身份、无法定位 tick、baseline 冲突都拒绝。未来生命周期/最终 snapshot 不决定前缀有效性。
- 一组死亡全部验证后原子应用；前后状态从非 1v1 变成两边各 1，才作为形成候选。不给数组排序制造中间局面。
- 四个候选的 g 合并成一次独立有界 `parseTicks(bytes, spatialFields, ticks)` 查询，逐锚点核对全体 alive 集合必须等于前缀 survivors。对照依然只属于本地审计。

实测：24/24 正式回合可审计；162 个窗口内死亡组，17 个 at/after end 排除、141 个非 1v1、4 个形成候选；另有 4 个 post-round 死亡先排除。未知身份、前缀生命周期、重复死亡及 boundary 缺失造成的候选拒绝本 fixture 均为 0，不能据此认为这些场景已由真实数据覆盖。

| 回合 | g | cutTick | 形成事件 round.events 索引 | 两边观察者 | 距最终回合结束 tick（仅离线） |
| --- | ---: | ---: | ---: | ---: | ---: |
| 11 | 92395 | 92396 | 255 | 2 | 39 |
| 22 | 185100 | 185101 | 280 | 2 | 416 |
| 23 | 194101 | 194102 | 260 | 2 | 44 |
| 24 | 201348 | 201349 | 287 | 2 | 213 |

候选涉及 4/24 回合（16.67%）、4/162 窗口内原子组（2.47%），4/4 与既有离线 resolver 一致，8/8 自身服务器快照字段有效。此覆盖率仅针对“死亡组后形成”的发现策略，没有证明召回所有等待/避战/路线决策机会。

“有一对存活者”不等于“存在可评价的选择”。短暂 1v1、已有动作执行、意图、炸弹时限、可达路径和实际观察仍无证据；不按最终胜负筛选正确选择，不以存续 tick 设未经验证的机会阈值。**本轮可签收的战术决策机会为 0；严格玩家已知事实输入为 0/8。**

定位采用原 DEM SHA、源码/native 版本、round、g、eventIndex 及 `parseTicks: tick+steamid` 本地行键。报告用 CT/T 单一存活者定位替代原 SteamID。整回合状态、survivors、deathTick、结局与选择理由均不序列化到模型。

## 6. 输入来源分类和白名单

| 类别 | 来源 | 允许范围 |
| --- | --- | --- |
| 自身状态 | exact native own row | 非空本地 auditedSelf；availableTick 未证实，模型 unknown |
| 可验证公开信息 | 当前缺少已验证 HUD/公开观察渠道 | 双方人数/炸弹知识 unknown；全局事实不替代公开观察 |
| 过去实际观察 | 当前无 observation adapter | last-known unknown，不填坐标/0，不前向填充 |
| 全局 DEM 事实 | roster、其他玩家位置/装备、relevant、原子死亡组 | 仅本地发现/交叉验证；不得决定自身 missingness |
| 未来结果 | winner、end snapshot、后续死亡/伤害、整段 Engagement | 仅离线质量材料；不可输入/检索/metadata |
| 未知/歧义 | 缺帧、冲突、非法值、无接收时间 | 明确 unknown / abstain |

严格 model 字段白名单：固定 schema、observer=`self`、cut tick/phase、self 的 position/view/health/side/alive **状态标记**、publicAliveCounts/enemyLastKnownPosition/inventory/bombKnowledge 的 unknown、固定计划和自身返回/缺失标记、固定能力门槛、空 evidenceRefs、固定时间语义说明。没有 DEM hash、文件路径、SteamID、昵称、round outcome、全场 coverage、future count、地图推断或全局状态展开。

若未来取得合法观察渠道，必须另行冻结每字段来源、观察/可获知时刻及 freshness 规则；本轮不以设置 `verified:true`、添加字段或提示词获得授权。unknown 输入的相等性只验证拒绝逻辑，不作为非空合法 InformationState 的证明。

## 7. 前缀稳定性及泄漏见证

### 7.1 真实 native 查询范围

同一未修改 DEM，分别请求 4 个锚点和包含它们的 4702 个全场 core tick，比较 40 行的 tick/identity/9 个原始字段，完全一致。证明本 fixture 的这些返回行不受查询未来 tick 数量影响；未修改 DEM 二进制，不声称已证明任意 native 解码器的全因果性。

### 7.2 真实历史 + 受控 native-output 扰动

8 个观察者分别进行 9 类扰动，共 72 次完整比较：其他玩家（含敌方）XYZ/HP/weapon、非观察者的 roster/lifecycle、未来伤害/击杀/开火、winner、未来死亡与 end state、4096 条未来事件密度、移除完整 suffix、未来 game_time、未来同号 round restart。roster/lifecycle 变体取首个非观察者，可能是队友或对手；该测试名中的 enemy 不代表所有切片都挑中对手，验证的是全局 QC 不得影响自身输入。

每次比较整个 model body（包括字段、unknown、样本选择、missing/truncated、别名、metadata），同时比较**非空本地 auditedSelf**；自身 HP 改变的正对照必须改变 audit 结果，防止所有验证仅靠空对象相等。全局 prefix QC 可以改变本地候选审计，但不能改变自身采样/模型缺失标记。

结果 PASS（验证程序行为），scope 明确是 native 输出后的受控扰动，不是另一份真实比赛或改写后重新解码的 DEM。native 实测与这一层组合构成限定的数据通路证据；**严格 DEM→玩家 InformationState 的端到端门禁仍 BLOCKED**。

### 7.3 既有离线采样器不适合作因果输入

边界测试 L01 是可执行最小复现：budget=5，core `[10,20,100,400]` 可保留历史 optional tick 92；只加未来 `weapon_fire@300`，core 占满预算，92 被截断。L01 的 PASS 代表问题成功复现，不代表修复。

真实输入保留首个候选以前的完整历史，仅向未来正式回合内逐 tick 加开火事件：默认 budget=24000，core 从 4702 增至 78362；optional 从 6835 变成 0；截断前 3452 个 optional tick 消失（最早 2719、2735、2744 等）。原始 DEM 本身没有 budget 截断；扰动结果不能说成实际比赛发生过。

影响包括历史行是否存在、覆盖/缺失标记和可引用样本，删除 after-event 不能修复。它是全局离线预算的正常行为，但 **decisionSuitability=FAIL**。另发现正式 Match.tickRate 取全场首尾 game_time，完整 converter 的未来 round restart 可能替换历史回合，所以切断必须发生在转换之前。

最小隔离方案：独立固定 `g = cutTick-1` 的一次 exact 查询；不共用离线 optional 预算，不输出全场 sampling/coverage，不使用 replay 插值，不让隐藏敌方 QC 控制自身样本。当前脚本只实证这一点方案；未来多 tick 历史窗口要另定与未来无关的预算/排序。现有离线采样器与统计语义完全保留。

## 8. 任务证据门槛

| 分析任务 | 必需字段 | 实际可用性 | 当前能否评价 | 缺失时处理 |
| --- | --- | --- | --- | --- |
| 描述自身状态 | 位置、HP、side、时刻、合法来源/availableTick | 8/8 服务器自身行；玩家可获知时间无 | 可本地描述过去服务器自身事实；严格玩家信息描述不通过 | abstain |
| 判断双方存活状态 | freeze 名单、原子死亡、精确 tick、公开渠道 | 4/4 前缀与 native alive 集合一致；公开渠道/可获知时间无 | 本地候选事实可确认；玩家当时已知人数不通过 | abstain |
| 敌方最后已知位置 | 观察来源、时效与失效规则 | 无可靠 visibility/radar/sound/comms 适配 | 不能 | unknown |
| 路线安全 | 地图版本、通行、静动态遮挡、敌情条件 | 地图只支持示意投影，versionMatch=unconfirmed | 不能 | abstain |
| 建议具体道具 | 库存数量、动作条件、效果空间 | 增量字段实测存在，正式状态契约/观察/动作可行性未验证 | 不能 | abstain |
| 急停/反应时间 | 动作、速度、输入、细时间语义 | 本轮未查询/验证；服务器 tick 与事件间隔不足 | 不能 | abstain |
| 替代动作胜率增益 | 已验证反事实方法与校准 | 无 | 不能 | abstain |

coverage complete 不是上述任务的置信度。单一 Dust2 记录的字段存在性不能外推到其他版本、地图、录制源或比赛。

## 9. 执行、复审与未执行项

从仓库根目录运行：

```powershell
node docs/experiments/p8-1b-checks.mjs
```

它顺序执行语法、强制无缓存 typecheck/build、match-model 测试、parser/deep-review 类型契约、边界、选定 parser/deep-review 回归及 Dust2 实测；各条准确命令、退出码、起止 UTC、日志摘要和计数见 JSON `commands`。实际日志留在忽略目录 `.tmp/p8-1b/`，没有 raw DEM 行。脚本 exit 0 仅表示检查完成，阶段状态必须看 real.json/report 的 BLOCKED。

| 实际检查 | 结果 | 退出码 |
| --- | --- | ---: |
| 4 个新增 mjs 语法 | PASS | 各 0 |
| 强制无缓存 typecheck | PASS，15/15 Turbo 任务 | 0 |
| 强制无缓存 build | PASS，8/8 Turbo 任务 | 0 |
| match-model test / parser、deep-review 类型契约 | PASS，编译式测试，不伪造运行时测试数量 | 各 0 |
| 新边界测试 | PASS，21/21，0 skipped | 0 |
| 选定 parser 回归（含真实 Dust2 provider/replay） | PASS，48/48，0 skipped | 0 |
| 选定 deep-review 回归 | PASS，192/192，0 skipped | 0 |
| 最终真实 Dust2 程序 | 验证执行 PASS；阶段 BLOCKED | 0 |

复现入口显式固定 DEM_TEST_FILE 与 REPLAY_TEST_FILE 为 Dust2，避免继承外部环境的样本选择。复审后对该入口环境固定作针对性 parser 回归复跑；重复通过不累计测试数量。

独立 reviewer 只读审查后自行运行 21/21 边界测试，退出 0（20 行为 + 1 限制见证），不累计为 42 个唯一测试。review 没有冒充第二个 native/真实 DEM 复测。

NOT RUN：逐 tick 全场提取；其它 DEM/跨图/个人黄金回归；Nuke-only 与 cross-map/calibration 套件；全部 Desktop/Electron/安装/归档交互回归；实际客户端接收/HUD/可见性/雷达/声音验证；Dust2 几何；native/SQLite 后端部署；鉴权/配额/数据保留；模型调用、专家评审、反事实/教学效果、职业语料和 P8.2。原因：均超出当前只读数据可行性范围或缺必要证据。原 P8.1A 合成脚本仅审阅，未重跑，也不计入本轮测试数。

## 10. 门禁与下一步

| 最低条件 | 结果 |
| --- | --- |
| 真实 Dust2 解析与字段覆盖 | PASS |
| 候选实际覆盖率和排除原因 | PASS，4 个形成点；不能认定可评价机会 |
| 合法字段白名单 / 隐藏状态隔离 | 拒绝白名单与隔离验证 PASS；非空已知游戏事实仍 BLOCKED |
| 可复现前缀测试与隔离策略 | 服务器事实通路 PASS；既有离线 sampler decisionSuitability FAIL；严格玩家输入 BLOCKED |
| 无证据战术任务拒绝 | PASS |
| 生产代码/版本/原有行为保留 | 源码无改动，适用回归见 JSON |
| 证据/命令/未执行项交付 | 按用户后续明确授权提交并推送独立分支；不改变 BLOCKED 判定 |

**P8.1B 不通过，P8.1 整体未完成。** 阻塞不是 DEM 缺失，也不是必须修改旧解析器；是服务器事实与玩家信息可获知语义尚未接通。

最小后续方案：先明确是否另行批准“服务器自身事实描述”作为独立且明确命名的能力，不宣称恢复玩家感知；若坚持 P8.1A 的严格 InformationState，则需要真实观察渠道及可获知时刻证据，之后重新跑 B 门禁。两种选择都不得静默更改草案，不能靠填一个 availableTick 字段解决。

P8.1C/D **不自动放行**：C 的部署、几何、服务安全及 D 的来源许可、去重分组、隔离保留集、盲评和发布门槛均未完成；依赖合法决策输入的工作须等 B 缺口关闭或正式批准范围调整。独立规划可在另行授权后进行，本轮没有启动。**P8.2 仍禁止进入。**
