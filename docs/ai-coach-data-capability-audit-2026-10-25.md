# AI Coach 数据能力审计

日期：2026-10-25  
审计代码基线：`f44984e5464552c81737922c67df3d9f17c27c71`，`main`，源码版本 `0.2.0`。  
状态：**本轮审计完成；不构成 P8 开工、功能验收或发布授权。**

## 1. 结论与范围

当前仓库不是只有统计报告和 2D 回放，而是已经具备较完整的确定性事件、空间采样、交战、人数变化、团队接触、道具上下文、交火执行和证据型 Findings 链路。AI Coach 应复用这些资产，不能重新实现一套统计系统。

但现有产物主要回答“事后确认发生了什么”，尚不能直接回答“当时玩家凭已知信息应该选择什么”。主要缺口是玩家信息边界、因果时间截断、任务专属状态完整性、经过验证的地图查询，以及独立决策/教学评估。

| 目标 | 审计结论 |
| --- | --- |
| 复用现有事实和证据定位构建复盘材料 | 有明确源码基础 |
| 让模型解释已核实事实，并在缺证据时保留判断 | 可进入受限可行性验证；接口、输出校验和评测仍需实现 |
| 自动判断合理站位、可支援性、安全路线或更优残局选择 | 当前不能宣称具备；信息和几何门槛未满足 |
| 将现有全局 DTO 直接作为决策训练输入 | 不可直接使用，存在未来信息与观察者信息越界风险 |
| 批量职业 DEM 学习、专家标签训练及个性化教学闭环 | 当前未形成可验收的运行链路 |

本轮覆盖相关领域契约、解析适配器、Deep Review、归档写入/恢复、地图投影、既有 P8 路线和针对性测试。不是逐行全仓安全审计，不审计所有 UI 行为，也不重新判定 P7/L 阶段验收。

所有判断以代码和已读取的契约为边界。“当前未提取/未实现”不等于底层 native parser 永远不能提供，也不等于未来无法训练模型。

## 2. 必须纠正的前置认识

1. **不只有 8Hz。** `planReplay()` 使用 8Hz 网格，并补入事件、生命周期及回合边界 tick；`planSpatialSampling()` 单独对事件精确采样，默认增加交火事件前后各 0.125 秒的上下文。热力图默认 `all-valid`，`uniform-8hz` 是可选口径，击杀/死亡位置另用精确事件空间证据。
2. **不是从零建设证据型 Findings。** `DeepReviewFinding` 已有结构化引用、事实、证据质量、保留说明；分析结果已有规则抑制、分母、诊断与去重/数量限制。新增 Coach 应增加任务和信息语义，而不是重复造这些机制。
3. **离线归档不只是展示摘要。** `writeLibraryArchive()` 保存当前提取的 `Match`、`MatchReplay`、`MatchSpatialEvidence` 和报告；同时记录版本、源码 revision、压缩前后摘要。但它不保存原始 DEM，也没有保留尚未提取的原生字段。
4. **正式 P8 设计已有边界。** `docs/ai-coach-technical-route.md` 的首批范围是 Dust2 1v1 残局；内部知识管线与 AI 服务放在后端。不能用讨论中的“协同教练原型”或“客户端模型+私有案例库”擅自替换这个路线。现有设计也没有把参数训练作为首版前提。

对应证据：`packages/dem-parser/src/providers/{replay,spatial-evidence}.ts`、`apps/desktop/shared/heatmap.ts`、`packages/deep-review/src/{findings-contracts,findings-policy}.ts`、`apps/desktop/electron/library-archive.ts`。

## 3. 能力盘点

| 能力 | 已有实现 | AI Coach 复用边界 |
| --- | --- | --- |
| 事件与生命周期 | 伤害、击杀、开火、道具、受闪、炸弹；回合边界名单和生命周期事件 | 事件索引用于定位，不是同 tick 内的动作先后证明 |
| 稀疏空间事实 | 精确 tick 的 XYZ、yaw/pitch、HP、存活、阵营、可选武器名称；逐字段覆盖和缺失原因 | 全局实体状态，不是玩家可知状态；不是连续运动轨迹 |
| 回放采样 | 8Hz 网格加事件等额外 tick；缺失/歧义、segment 与实际 tick 保留 | 显示插值不得成为事实；稠密程度随事件而变化 |
| 交战与人数 | hostile damage/kill 分组；存活状态、同 tick 原子死亡组、人数变化 | 完整 Engagement 与整回合 resolver 是事后产物，不能整体当作决策前输入 |
| 团队配合证据 | 接触角色、后续伤害/击杀、时间窗、最近存活队友几何距离 | 明确不证明视线、路线、可支援性、错误站位或强制响应期限 |
| 道具与执行 | 效果原点、轨迹/结束来源、受闪事件；开火关联与反向接触 | 烟火视觉区域不是已验证遮挡体；事件间隔不是反应时间；开火计数不是空枪数 |
| Findings | typed refs、facts、caveats、coverage、suppression、分母、静态策略及数量限制 | 产品启发式，不是职业标准、专家真值或概率置信度 |
| 本机归档 | 当前领域产物、摘要、schema/解析器/native/源码/采样/地图资源版本 | 有较好可追溯基础，但不是原 DEM 数据湖或职业训练集登记册 |
| 地图 | 雷达转换、Z 楼层区间、资源标识 | `versionMatch: 'unconfirmed'`；不是导航网格、碰撞查询或动态可见性模型 |
| AI 服务 | 已有技术路线文档 | 审计基线 `apps/` 只有 `desktop`，规划的两个后端应用尚未创建 |

## 4. 主要审计发现

以下 B0/B1 是**未来 Coach 能力的前置门槛**，不是现有 v0.2.0 的线上故障等级，不撤销既有阶段签收。

### AC-01 / B0：全局事实与玩家信息状态尚未实现隔离

**证据：** `buildSpatialEvidence()` 为事件 actor/target 之外的所有比赛玩家追加 `relevant` 样本；契约的 provenance 是 `demo-entity-state`，没有 observer、信息获取渠道、last-known 或知识有效期。桌面回放元数据也使用 `perspective: 'global'`。

**影响：** 即使去掉所有未来时间，隐藏敌人的真实位置仍可能进入模型。精确坐标和完整样本不代表玩家当时知晓。

**要求：** 独立定义 `InformationState`，明确 observer、cutTick、信息来源、已知/未知、最后观察时间与时序歧义；全局事实只用于审计和结果标签。当前无法恢复的语音、报点、注意力、听觉等不能自动补齐。具体可见性须经独立验证，几何 LOS 本身也不等于实际感知。

**验收建议：** 固定可观察历史，改变隐藏敌人的真实状态时，合法决策输入应保持不变。必须先有真正的信息构造器，不能用空字段或提示词免责声明替代。

### AC-02 / B0：直接复用事后数据会引入未来信息，且不只来自 after-event 字段

**证据：**

- 空间采样明确包含 `after-event`。
- `analyzeEngagements()` 根据整个接触连通分组生成参与者、结束时间和击杀数量。
- `resolveRoundAliveState()` 检查整回合生命周期、死亡记录及 end snapshot；`deathTick` 和部分 coverage 是事后可得信息。
- `planSpatialSampling()` 的可选预算为 `max(0, tickBudget - coreTicks.length)`，其中 coreTicks 来自整场比赛；可选 ticks 按时间排序截取。

**本轮已实际复现的合成例子：** 固定预算 5，核心 ticks 为 `[10,20,100,400]` 时，早期上下文 tick 92 被采样；仅新增未来 tick 300 的事件后，核心 ticks 占满预算，tick 92 被标为 `sample-budget-truncated`。因此，过去样本的可用性也可能依赖未来事件。

这不是当前离线复盘采样器的错误；它说明该采样器和它的缺失模式不能未经处理就成为因果决策输入。删除未来值后保留未来决定的 coverage，仍可能越界。

**要求：** 分离 `input / chosenAction / outcome / retrospectiveQuality`，明确同 tick 事件不能靠数组排序伪造动作前状态。为训练任务单独设计前缀稳定的采样与特征投影；离线质检可用于筛选，但要记录它带来的样本选择偏差，不冒充在线可得特征。

**验收建议：** 修改 cutTick 之后的事件、回合结果和结束快照，不应改变合法输入，包括缺失标记、采样选择及可见 metadata。不能直接要求现有事后 resolver 满足该条件，也不应为此破坏原有复盘语义。

### AC-03 / B0：现有地图几何不能支持战术可达性与可见性判定

**证据：** `ReplayMapDefinition` 存储雷达图片、缩放、原点及楼层区间；`worldToRadar()` 是投影转换，`resolveMapLayer()` 是高度区间选择。所有地图版本匹配标记为 `unconfirmed`。`NearestTeammateSpatialFact` 明确不作 LOS、路线、掩体或支援判断。

**影响：** 不能以距离阈值或雷达图片判定“可以补枪”“这条路线安全”“这里不会暴露”。真实投掷轨迹、烟雾结束事件与显示效果，也没有自动补齐烟雾体积、遮挡或对手可感知状态。

**要求：** 依任务分别建立地图版本匹配、区域/通行拓扑、静态碰撞与动态状态能力门槛。未满足时输出限定事实或 abstain，不让语言模型补造查询结果。不要将雷达资源 manifest 当作该 DEM 地图版本已核实的证明。

### AC-04 / B0（按任务）：当前状态字段不足以统一评价动作可行性

**证据：** 当前空间查询字段仅为 `X/Y/Z/yaw/pitch/health/is_alive/team_num/active_weapon_name`；回放查询没有 pitch 或武器。事件中确有受伤时护甲信息和部分拆包器信息，不能笼统说“完全没有护甲/装备数据”；但持续弹药、库存、经济、姿态、速度和相应完整性尚未形成决策状态契约。

空间 `coverage.status = complete` 允许 `activeWeapon = null`，这是现有契约的明确设计，不是验证漏洞。

**影响：** “空间采样完整”不等于“有足够证据建议投掷、交火、撤退或拆包”，也不是经过概率校准的置信度。

**要求：** 建立每项建议的 required-evidence 矩阵。例如建议投烟需要已核实持有量和可执行条件；评价急停需要可靠动作/速度/时间证据；拆包建议需要足够的炸弹与时间/装备信息。缺失字段按具体任务禁用结论。扩展解析前先做 native 字段实证，不能假定支持，也不能假定永远不可获取。

### AC-05 / B1：Engagement 可复用，但不能直接充当 DecisionEpisode

**证据：** `analyzeEngagements()` 以敌对 damage/kill 为接触，默认按共享参与者及 3 秒间隔建立连通组。无伤害的观察、等待、避战、转移和很多道具决策不会天然形成相同样本。

**影响：** 只从交火/死亡片段学习，会偏向已经发生接触的局面。没有发生击杀的好决策可能缺席；整段参与者又可能含决策后才进入战斗的人。

**要求：** 以独立的决策锚点和任务窗口构造 Episode，保留没有交火及没有错误的对照样本。Dust2 1v1 可以复用 `RoundAliveState` 的存活事实及原子死亡组发现候选起点，但仍需新建受信息边界约束的输入投影，不能直接序列化整回合 resolver。

### AC-06 / B1：已有溯源基础，但尚无训练语料登记与隔离机制

**已有：** match.id 来自原 DEM SHA-256；归档记录应用、分析、解析器、native、采样、地图资源、sourceRevision，以及组件压缩前后摘要。

**尚缺于当前契约：** 实际赛事/比赛日期、来源和允许用途、语料授权记录、游戏 build、经匹配的地图几何 revision、比赛/系列去重分组、数据 split、标注协议及版本、知识/模型实验登记。

`importedAt/createdAt` 不是比赛发生时间；内容哈希只能识别完全相同的文件，不能单独解决同一场比赛不同录制/不同包装的分组泄漏。未记录授权不等于已确认侵权，本轮不作法律结论。

**要求：** 内部知识管线建立受控 corpus manifest 和 split registry。原始职业 DEM 在授权研究存储中独立管理；桌面不自动保存/上传个人 DEM。不要为审计下载替代样本，也不要把训练语料提交进 Git。

### AC-07 / B1：规则校准不是决策质量或教学效果验证

**证据：** `FINDINGS_POLICY` 明确标注 product heuristics，不是职业标准或统计显著性。现有 calibration 测试核对分母、引用、确定性、阈值和语义限制，也明确不是 skill truth。

**影响：** 现有 Findings 可帮助筛选待复盘片段，但不能未经专家审核就变成“错误动作”训练标签。胜负、未补枪、孤立接触和队友受闪均不能单独证明决策错误。

**要求：** 决策评价先隐藏结果，由评审检查当时信息、替代动作可行性与合理性；允许争议和多个合理选择。开发集、检索知识、独立保留集按比赛/系列隔离；跨队伍/时间/地图版本外推另测。最终验证应观察类似机会下目标行为是否改善，不只统计胜率或点赞。

### AC-08 / B1：P8 的服务、隐私与解释校验目前是设计，不是实现

**证据：** 路线要求内部知识管线和 Coach API 独立部署、只读发布快照、最小结构化个人证据、模型适配和双端校验；基线目录只有 `apps/desktop`。当前 native parser 的后端部署兼容性亦需要单独验证。

**要求：** 后续必须实际验证鉴权、输入大小/预算、伪名化与字段最小化、引用与数值校验、信息越界、输出语义限制、失败降级及知识版本回滚。schema 合法或引用存在都不证明一句建议成立。不要把个人 SteamID/昵称/整场轨迹默认发给模型服务，也不要把私有知识和供应商密钥下发 Desktop。

这不是对当前离线应用宣告服务漏洞，而是尚未实现服务的验收清单。

## 5. 推荐的下一工作单元

保持既有路线，不自动启动实施。建议产品批准后的第一单元为：

> **P8.1：Dust2 1v1 决策证据契约与可行性验证。**

复用 `Match`、原子存活事实、精确事件引用、Spatial coverage、现有回放及归档。只对新增 Coach 层设计以下职责，名称是建议，不代表仓库已有类型：

| 建议职责 | 核心边界 |
| --- | --- |
| CorpusManifest | 原始内容摘要、实际来源/用途、版本与比赛分组 |
| DecisionEpisode | 决策锚点、历史窗口、行为和结果分离 |
| InformationState | observer、cutTick、信息来源与未知项 |
| TaskEvidenceGate | 当前任务必需字段、几何能力及拒绝判断原因 |
| CoachEvidenceBundle | 可引用事实、限制、候选解释，不含整场全局轨迹 |
| CoachAssessment | 条件性建议、证据引用、未知因素、适用要求及校验版本 |

第一轮应证明“能否构造合法输入、列出能评价与不能评价的内容”，不是先训练通用 CS2 模型。不能承诺安全路线、最优胜率或枪法诊断；范围内没有足够证据时，明确不评价。

建议门禁：

- 原始事实和现有 P3/P4/Deep Review/Replay 行为不回归。
- 隐藏敌情扰动、未来事件扰动和同 tick 歧义测试通过。
- 未匹配地图、缺少 required evidence、引用失效时禁止相关强结论。
- 合法白名单真实 DEM 的提取与覆盖实证单独记录；合成测试不能替代。
- 先冻结去重、分组、保留集及评审协议，再归纳职业规律。
- native 后端可部署性和最小请求/输出校验得到实测；服务不可用不破坏本地报告。

## 6. 本轮实际验证与限制

仓库通过 GitHub 连接按固定 SHA 读取。容器直接 clone 因 DNS 解析失败，未获得完整工作区；因此本轮采用隔离模块验证，不伪装为完整工程验收。

运行环境：Node.js `v22.16.0`。从固定 SHA 取回以下两个完整文件，按 Git blob 算法校验内容后，仅用 `node:module.stripTypeScriptTypes` 去除类型，运行仓库原有测试。

| 文件 | bytes | Git blob SHA-1 |
| --- | ---: | --- |
| `packages/dem-parser/src/providers/spatial-evidence.ts` | 10942 | `a9860dba81ce827a03a78c12fdcfe323e50bde90` |
| `packages/dem-parser/tests/spatial.test.mjs` | 9561 | `18590b7a570c81df078c4fa04e85052f187f9d6d` |

| 验证 | 本轮结果 | 说明 |
| --- | --- | --- |
| 两份原文件与 GitHub blob 一致性 | PASS | 校验 `sha1('blob ' + bytes.length + NUL + bytes)` |
| 仓库原有空间证据测试 | **10/10 PASS** | 0 fail、0 skipped；隔离执行，非 native/DEM 测试 |
| 新增本地审计探针 | **4/4 PASS** | 合成数据；验证 A01–A04 当前行为，不是 Coach 验收 |
| 全仓 typecheck/build/test | **NOT RUN** | 去除类型不是 TypeScript 类型检查 |
| native parser / 真实 DEM / Windows Electron / 安装版 | **NOT RUN** | 无本地合规真实夹具及完整 Windows 环境 |
| 模型训练、专家评价和教学效果实验 | **NOT RUN** | 本轮没有实现或训练模型 |
| 独立第二审阅者复核 | **NOT RUN** | 不将单次自审包装为独立复审 |

四项探针：

- **A01**：anchor=100、rate=64 时存在 after-event tick=108，三个玩家的未来样本均保留。
- **A02**：actor/target 之外的第三位玩家坐标被作为 relevant 返回；没有 observer 信息过滤。未声称该玩家在真实比赛中不可见。
- **A03**：预算 5 下仅新增 tick=300 的事件，使先前 tick=92 的 before-event 样本从可用变为截断，证明全局预算的前缀依赖。
- **A04**：activeWeapon=null、武器覆盖 unavailable 且无 inventory/ammo 字段时，空间 core coverage 仍可为 complete，符合现有契约。

原有 10 项测试覆盖核心 tick 保留、可选预算、精确行缺失、玩家行缺失、未知字段/零值、可选武器、前后关系及引用、未知 tick rate、重复行/确定性和非法参数。真实比赛覆盖率、性能及旧文档 PASS 没有被重算，也没有充作本轮执行结果。

### 6.1 最小复现：前缀采样依赖

以下代码使用当前模块的真实函数和合成事件，不读取 DEM。应在已构建的固定基线工作区执行；构建本身不是本轮已执行项目。

```js
import assert from 'node:assert/strict';
import { planSpatialSampling } from './packages/dem-parser/dist/providers/spatial-evidence.js';
const A = '76561198000000001', B = '76561198000000002';
const match = {
  id: 'synthetic-only', map: 'de_dust2', tickRate: 64,
  players: [A, B].map(steamId => ({ steamId, nickname: '', team: 'Unknown' })),
  rounds: [{ number: 1, winner: null, startTick: 10, freezeEndTick: 20, endTick: 400,
    events: [{ type: 'kill', tick: 100, killer: A, victim: B }] }],
};
const before = planSpatialSampling(match, { tickBudget: 5 });
const changed = structuredClone(match);
changed.rounds[0].events.push({ type: 'weapon_fire', tick: 300, shooter: A, weapon: 'ak47' });
const after = planSpatialSampling(changed, { tickBudget: 5 });
assert.deepEqual(before.optionalTicks, [92]);
assert.deepEqual(after.optionalTicks, []);
assert.ok(after.omittedOptionalTicks.includes(92));
```

此片段是等价的最小复现说明；本轮实际运行的 A03 使用未来 kill 事件，完整探针执行记录与文件哈希随审计交付物保留。对两种事件，核心预算占用机制相同。

## 7. 主要源码索引

下列路径均以本文顶部 SHA 为准。审计文档分支从该 SHA 创建，没有修改对应生产源码。

| 路径 | 核对内容 |
| --- | --- |
| [`AGENTS.md`](../AGENTS.md) | 边界、证据原则、真实 DEM 政策 |
| [`docs/ai-coach-technical-route.md`](ai-coach-technical-route.md) | 既有 Dust2 1v1、后端知识与服务设计 |
| [`docs/roadmap.md`](roadmap.md) | P8 未开始、P7/L 历史签收及版本边界 |
| [`match-model/src/event.ts`](../packages/match-model/src/event.ts) | tick、伤害、护甲、开火、道具、炸弹语义 |
| [`match-model/src/spatial.ts`](../packages/match-model/src/spatial.ts) | 精确空间样本、关系与覆盖 |
| [`match-model/src/replay.ts`](../packages/match-model/src/replay.ts) | 原始观察、效果来源、回放隔离 |
| [`match-model/src/match.ts`](../packages/match-model/src/match.ts) | 当前比赛级元数据 |
| [`match-model/src/round.ts`](../packages/match-model/src/round.ts) | 边界快照、生命周期 |
| [`demoparser2-adapter.ts`](../packages/dem-parser/src/providers/demoparser2-adapter.ts) | 原 DEM 摘要、查询、解析共享、失败降级 |
| [`spatial-evidence.ts`](../packages/dem-parser/src/providers/spatial-evidence.ts) | 全局名单、精确采样、预算与完整性 |
| [`parser replay.ts`](../packages/dem-parser/src/providers/replay.ts) | 网格加事件 tick、回放字段、效果来源 |
| [`engagements.ts`](../packages/deep-review/src/engagements.ts) | direct-contact 分组 |
| [`alive-state.ts`](../packages/deep-review/src/alive-state.ts) | 整回合存活解析和事后核验 |
| [`impact-contracts.ts`](../packages/deep-review/src/impact-contracts.ts) | 原子死亡组、人数与未来结果 |
| [`teamplay-contracts.ts`](../packages/deep-review/src/teamplay-contracts.ts) | 几何距离与支援判断的边界 |
| [`execution-contracts.ts`](../packages/deep-review/src/execution-contracts.ts) | 反向接触、开火与反应时间的边界 |
| [`findings-contracts.ts`](../packages/deep-review/src/findings-contracts.ts) | 证据引用、质量、抑制、分母 |
| [`findings-policy.ts`](../packages/deep-review/src/findings-policy.ts) | 启发式阈值、数量和优先级 |
| [`findings.ts`](../packages/deep-review/src/findings.ts) | 必需层门控、事后事实与限制文案 |
| [`report-worker.ts`](../apps/desktop/electron/report-worker.ts) | 共享解析、global 回放、归档入口 |
| [`library-archive.ts`](../apps/desktop/electron/library-archive.ts) | 全量已提取领域源、组件摘要与版本验证 |
| [`library.ts`](../packages/report-contract/src/library.ts) | 归档/目录版本与 importedAt |
| [`replay-map-geometry.ts`](../apps/desktop/shared/replay-map-geometry.ts) | 投影、楼层、版本匹配未确认 |
| [`heatmap.ts`](../apps/desktop/shared/heatmap.ts) | 默认 all-valid、uniform-8hz 与事件定位 |
| [`spatial.test.mjs`](../packages/dem-parser/tests/spatial.test.mjs) | 本轮隔离实际执行的 10 项原测试 |
| [`findings-calibration.test.mjs`](../packages/deep-review/tests/findings-calibration.test.mjs) | 仅阅读；结构/分母校准不等于教学真值 |

## 8. 本轮变更边界

仅新增本审计文档。未修改生产代码、依赖、版本号、AGENTS、主路线图或既有 P8 技术路线；未创建运行时 Coach 应用，未下载/上传 DEM，未训练模型，未创建 release/tag，也未将文档分支自动合并到 main。

最终判断：**优先把现有可靠的事后证据转换成信息受限、任务明确、可拒绝判断的决策证据，再考虑扩大职业知识或模型训练。缺口主要是证据语义与验证，不是先换一个更大的语言模型。**
