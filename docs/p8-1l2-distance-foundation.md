# P8.1-L2.1：资源身份门控与距离基础设施

日期：2026-10-25（Asia/Shanghai），应用版本保持 **0.2.0**。本单元只交付可审计资源记录、拒绝门控与同 tick 原生 XYZ 距离。不是地图几何系统、AI Coach 功能或 P8.1 整体验收；不放行 P8.1C/D、P8.2。

## 基线与开始前审计

- 开始分支 `codex/p8-1l2-map-geometry-feasibility`，HEAD `babcdd8cdff444dad86ff78e0f3e1f4499c54ddb`，工作区干净。实际 `git fetch origin` 后 `origin/main` 仍为 `f44984e5464552c81737922c67df3d9f17c27c71`。研究分支远端存在；GitHub PR 搜索未返回该研究 head 的 PR，不将其视为已合并。
- [范围决策 PR #4](https://github.com/cs2-analyst/cs2-analyst-desk/pull/4) 实查 `open / draft / merged=false`，head `8f61854793f3d9230d1cd160b3fd01dedaafcadd`。通过 `git show origin/docs/p8-scope-l1-l2-20261025:<path>` 读取范围决策、技术路线与 P8.1A 草案（尤其第 12 节）；未合并或复制这些草案。
- 阅读全局/项目 AGENTS、`.agents/workflows.md`、domain-model-change、demo-analysis-development、model-routing、reviewer/tester 角色、架构、fixture 白名单、空间证据文档、P8.1B-R 报告/能力矩阵和地图研究 MD/JSON。基线没有 `.agents/workflows/feature-development.md` 或独立 testing workflow；使用现有 implementation 流程和 tester 角色。
- 当前生产 `packages/`、`apps/`、`scripts/` 与最新 main 无差异。现有 `EventPosition`、`SpatialSample`、`MatchSpatialEvidence` 只有旧语义，不能假定它们已经包含 DEM 摘要/坐标规范化身份。现有 overview/PNG manifest 未发生变化。
- 在审计后先报告实施计划，再创建 `codex/p8-1l2-distance-foundation`。本次用户请求授权此单元，未扩大到其他 P8 工作。

## 所有权、消费者和兼容性

领域类型在 `packages/match-model/src/distance.ts`、`map-resource.ts`，只从原 index **新增 type export**。纯计算在 `packages/analytics/src/distance.ts`、`map-resource.ts`，由 analytics index 显式导出。只有 `match-model` 类型依赖；没有 I/O、游戏目录访问、模型调用或新依赖。

旧 `Match`、`SpatialSample`、`MatchSpatialEvidence`、Replay、Analytics、Findings、Deep Review、report-contract 和归档 DTO 均不增加字段。新结果必须由未来消费者显式请求；不会自动进入旧报告/归档。独立 schema 字符串与应用版本无关。

调用审计发现：

| 位置 | 既有行为与本轮处理 |
| --- | --- |
| `apps/desktop/shared/replay-map-geometry.ts`、renderer replay-map、replay draw、heatmap | `worldToRadar()` 只做 overview 算术，`resolveMapLayer()` 使用现有高度段；所有调用与测试语义保留 |
| `packages/deep-review/src/execution.ts` | 私有 `distanceJoin` 先检查 exact tick/参与者/coverage，再计算 XY、绝对 ΔZ、nested hypot；保留 |
| `packages/deep-review/src/teamplay-evidence.ts` | 私有队友端点距离/排序；保留，不推导支援 |
| `packages/deep-review/src/utility-context.ts` | 私有道具原点与玩家端点距离；保留，不推导遮挡 |
| `docs/experiments/p8-1b-r-server.mjs` | 非生产距离实验；不导入生产包 |

全仓搜索 `Math.hypot / Math.sqrt / worldToRadar / distance / Distance`，同时检查上述测试。现有三个计算点的数值定义复用为 **XY hypot + 绝对 ΔZ 的 nested hypot**。它们是 Deep Review 私有 join，而非可复用的来源验证 API；从 analytics 导入会反向依赖 Deep Review，从 Deep Review 导入 analytics 会修改既有包图。本轮不搬迁旧逻辑或增加重复私有 join，仅新增本任务必需的独立、带来源校验入口。后续共享旧计算应独立审查消费者与数值兼容性。

## 距离契约与使用

```ts
import { calculateDemDistance } from '@cs2-analyst/analytics';
// a/b: DemPositionEvidenceV1，来自调用方已核实的原生 exact rows。
const xy = calculateDemDistance(a, b, 'horizontal');
const xyz = calculateDemDistance(a, b, 'three-dimensional');
if (!xyz.valid) { /* 保留 xyz.reason；不得补造位置或解释 */ }
```

输入 `dem-position-v1` 要求：非空 matchId/mapName/parserVersion/playerId/evidenceRef、规范小写 64 位十六进制 DEM SHA-256、非负 safe integer actualTick、完整有限 X/Y/Z。坐标系仅接受 `dem-server-xyz / DEM-world-unit / native-unmodified-v1`。这是调用方对可信原生记录的声明，不是数据认证：必须把 `evidenceRef` 保存在本地原始行定位表，以 DEM SHA、解析器版本、playerId、actual tick 还原。不要把显示插值、未来位置、nearest tick 或旧 SpatialSample 直接断言成这种证据。

两端必须拥有相同 DEM 摘要、matchId、地图名、坐标规范和解析版本，并处在同一个 actual tick。不同比赛、不同 tick、不同解析/规范化、未知坐标系/单位或缺失地图均拒绝。exact tick 0 合法；null、NaN、Infinity、小数和不安全整数 tick 无效。

- 水平：`hypot(dx, dy)`，忽略 Z 的差值，但仍要求输入是完整有效 XYZ 证据。
- 三维：`hypot(hypot(dx, dy), abs(dz))`，保留既有数值定义。使用缩放 hypot，避免先平方造成 `1e200` 级输入的中间溢出；极小 subnormal 值同样不经平方。
- 不将字符串、null、缺失值转成零；不补点、不寻找邻近 tick。有限端点相减或最终范数若超出 Number 可表示范围，返回 `numeric-overflow`；水平计算不会因没有使用的 Z 差值溢出而失败。
- 输出单位始终为 **DEM world units**；没有米、导航长度、到达时间、楼层类别或额外精度保证。浮点数值不是地理真值。

结果 `dem-distance-v1` / `scaled-hypot-xy-xyz-v1` 为 discriminated union：成功给出 value/actualTick；失败给出 `valid=false / value=null / actualTick=null / reason`。两端引用、坐标和坐标系以白名单生成脱离原输入对象的快照。非法输入不会被包装为成功；无效输入的原始非有限值仅是失败诊断，JSON 序列化会将这些诊断数值变成 null，不能反序列化为有效证据。

所有结果固定 `informationScope=server-global`，没有 `playerKnown`、availableTick 或玩家感知认证。额外顶层/坐标/坐标系字段不透传。API 不接收事件、回合胜负或未来轨迹；已冻结的合法端点不会因未来事件或未来 metadata 改变结果。它不能修复上游全局预算采样造成的历史覆盖变化，也不证明任意 DEM decoder 因果性。

## 资源身份与能力门控

`map-resource-identity-v1` 记录 resourceId、地图名、来源类型/引用、资源自身版本（允许 null）、内容或受控 manifest 的 SHA-256、坐标规范、匹配状态、目标 DEM 摘要/匹配证据、scope、limitations、producerVersion。完整记录 `map-resource-record-v1` 逐项记录能力的 `validated / blocked / not-run`、methodVersion、evidenceRefs 和 boundIdentity。

资源摘要仅证明被审计的资源或受控 manifest 身份；**摘要格式合法不证明字节已校验，更不证明 DEM 地图版本匹配**。本地维护流程先运行资源审计、验证内容摘要、记录证据，再调用门控。此 API 接受可信本地审计记录，不是对任意客户端 JSON 的签名或来源认证器，不进行隐式文件读取。

`mapResourceIdentitySnapshot(identity)` 以固定字段顺序序列化整个身份（含状态、来源版本、摘要、目标 DEM、范围、限制）。boundIdentity 是字符串，避免同一个可变对象被身份和授权同时引用。逐次调用 `gateMapResourceCapability(record, target, capability)` 检查：schema、地图冲突、摘要格式、坐标/单位、mismatched、目标 DEM 冲突和匹配证据；再检查当前能力与身份绑定。

matched 至少必须声明目标 DEM 摘要和非空依据引用；本版本 **不提供 matched 认证工具或真实地图匹配门槛**，也不会把 unconfirmed 升级。即使调用方伪造 matched/validated，版本映射和所有高级能力仍固定拒绝。更改身份或 unconfirmed→matched 后，旧能力证据失效，必须重新验证、重新绑定；消费者不可跨身份变化缓存 allowed=true。重新生成 snapshot 本身不算重新验证。

| 能力 | 本版本的实际行为 |
| --- | --- |
| overview 投影算术 | 只允许完整可信身份和绑定的 validated 证据；unconfirmed 可以用于纯算术，不证明地图位置准确 |
| 同源水平／三维距离 | **独立走 calculateDemDistance**，无需任何地图资源；资源门控返回 `coordinate-distance-separate` |
| 地图版本匹配的世界坐标映射 | 固定拒绝 `not-implemented`；无独立地标/误差验收 |
| NAV 可达性 | 固定拒绝 `not-implemented`，记录 blocked；未实现/未实测 |
| 静态 LOS | 固定拒绝 `not-implemented`，记录 blocked；未实现/未实测 |
| 动态遮挡 | 固定拒绝 `not-implemented`，记录 blocked；未实现/未实测 |

配套 [机器记录](p8-1l2-distance-validation-2026-10-25.json) 包含基于**现有** `docs/replay-resources.json` 原始字节摘要的 Dust2 受控 manifest 身份记录。source version 使用 manifest 自身编号；不等于当前游戏 build/VPK 或 DEM build。原 manifest、overview 和 PNG 摘要均未改动，所有 `versionMatch=unconfirmed` 保留。此记录只在文档验证中使用；未接入现有回放生产路径。

资源 mismatched 会拒绝资源能力；它不会影响同一 DEM 的合法 XYZ 距离，因为距离 API 不接收资源状态。未匹配时保留原示意回放和纯数字距离，拒绝资源依赖的几何/战术结论。不得从距离推断可通行、支援、交叉火力、LOS、安全位置、动作因果或胜率收益；这些需要通路、遮挡、时间和交战条件的联合证据，语言模型不得补齐。

## 验证与变更清单

最终 **470/470 项唯一运行时测试通过，0 失败、0 跳过**：analytics 195（含新增 78）、Deep Review 192、Findings 16、Desktop/资源兼容 66、新增 Dust2 集成 1。全仓 `pnpm typecheck --force`、`pnpm build --force` 及 match-model/analytics 契约编译通过。实际命令、退出码、日志摘要与未执行项以 [JSON](p8-1l2-distance-validation-2026-10-25.json) 为准。编译契约断言不冒充运行时测试；重复运行不累计唯一测试数。新增测试覆盖数值/溢出/缺失、跨来源拒绝、未知嵌套 metadata、资源状态与身份失效、未验证能力及高级能力伪授权。

真实输入只使用本地 `.demo/dust2.dem`，校验 SHA-256 `db90fe85aab023a1d2c8a5996182e6120d98ef494f02a070b17982b235e4958c`，不复制或写入 DEM。[显式集成测试](experiments/p8-1l2-distance-real.test.mjs) 在 92395、185100、194101、201348 四个 historical anchors 重新查询 native 原生 XYZ，选择各 tick 两个存活端点，比较新 API 与既有数值定义。四对／八次 kind 比较属于 **1 项测试**，不证明训练机会、路线或全场地图精度。测试不输出玩家身份或原坐标。

生产改动：match-model 新增 `distance.ts / map-resource.ts` 和 index type exports；analytics 新增 `distance.ts / map-resource.ts / spatial-validation.ts` 和 index exports。

测试改动：`packages/match-model/tests/distance-contracts.test.ts`、`packages/analytics/tests/distance-foundation.test.mjs`、`docs/experiments/p8-1l2-distance-real.test.mjs`。

文档改动：本文和 `docs/p8-1l2-distance-validation-2026-10-25.json`。没有修改 apps、资源 manifest、依赖、版本号、阈值、Findings、统计逻辑或旧归档读取路径。

独立 reviewer 发现嵌套对象展开会透传 future/playerKnown metadata；已改为白名单复制并增加非空扰动回归，复审独立重跑新增测试 78/78。首次 77 项测试中的 1 项失败源于测试 helper 的默认参数将 undefined position 填为 origin；修正测试构造后 77/77。修复与广泛验证并行时，旧缓存 dist 使新 metadata 回归实际失败（194/195）；随后强制重建并重跑全部声明的组。早期失败、runner 的空日志诊断及最终成功均保留在 JSON，不仅记录最终通过。

未执行的 GUI/安装版、完整跨地图/全仓全测试、NAV/physics/LOS、模型/服务与 P8.1C/D 等项目详见 JSON。后续需要独立授权：可信 DEM→地图构建绑定、独立空间真值基准、NAV/碰撞/动态资源处理、旧调用路径迁移、持久化或 UI 集成以及 P8.1 其余阶段。不得因本单元通过自动启动这些工作。
