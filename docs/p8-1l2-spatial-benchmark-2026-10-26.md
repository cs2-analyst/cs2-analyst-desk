# P8.1-L2.2C：Dust2 独立空间基准与局部几何兼容性验证

日期：2026-10-26，Asia/Shanghai。产品版本 **0.2.0**。本轮仅新增本文、[机器记录](p8-1l2-spatial-benchmark-2026-10-26.json)、[独立验证脚本](experiments/p8-1l2-spatial-benchmark.mjs)和[测试](experiments/p8-1l2-spatial-benchmark.test.mjs)。

**投影算术 PASS；独立空间精度 BLOCKED；全图坐标一致性 BLOCKED；局部兼容等级仍为 unconfirmed。** 已实际重查白名单 DEM 的 13 个 tick，选取 22 个去身份服务器坐标快照执行原有 `worldToRadar()`。22/22 落在历史四区域框内，但有效的独立地标配对为 **0**；不能把框内距离下界 0 当作真实定位误差 0。本轮不要求恢复历史游戏构建号，也没有以构建号缺失作为局部投影验证的唯一阻塞。

## 1. 基线、远端与实施边界

| 项目 | 本轮实查 |
| --- | --- |
| 仓库 / 本地目录 | cs2-analyst/cs2-analyst-desk / E:\cs2-analyst |
| 开始分支 / HEAD | codex/p8-1l2-demo-map-binding-research / d58de2f156e08836c719bf72225c200287f4c196 |
| 开始工作区 | 干净；未暂存或覆盖已有改动 |
| fetch 与 ls-remote 后 origin/main | f44984e5464552c81737922c67df3d9f17c27c71 |
| 最新资源盘点分支 | codex/p8-1l2-resource-inventory / b50bc7ac5cb079e86bc64e9f107ba1501aa34e60 |
| 最新绑定研究分支 | codex/p8-1l2-demo-map-binding-research / d58de2f156e08836c719bf72225c200287f4c196 |
| 前置提交 | 几何研究 babcdd8cdff444dad86ff78e0f3e1f4499c54ddb；距离基础 623caaccbbd479e538c6b1166b8890170ab4c8f1；均已在本分支历史中 |
| [范围决策 PR #4](https://github.com/cs2-analyst/cs2-analyst-desk/pull/4) | open、draft=true、merged=false；head 8f61854793f3d9230d1cd160b3fd01dedaafcadd |
| 本轮独立分支 | codex/p8-1l2-spatial-benchmark，从上述干净 HEAD 创建 |
| 本轮差异基线 | d58de2f；继承的 L2.1 生产实现与旧研究不计为本轮改动；没有合并 main 或 PR #4 |

已核对项目/全局 AGENTS、`.agents/workflows.md`、DEM workflow、model-routing、reviewer/tester 角色、[fixture 白名单](demo-fixtures.md)、[几何研究](p8-1l2-map-geometry-feasibility-2026-10-25.md)、[距离基础](p8-1l2-distance-foundation.md)、[资源盘点](p8-1l2-resource-inventory-2026-10-26.md)及 JSON、[绑定研究](p8-1l2-demo-map-binding-research-2026-10-26.md)及 JSON、overview/PNG、[manifest](replay-resources.json)、现有投影和 DEM 提取路径。范围文档不在当前 checkout，通过 `git show` 阅读[PR 固定 head 的决策](https://github.com/cs2-analyst/cs2-analyst-desk/blob/8f61854793f3d9230d1cd160b3fd01dedaafcadd/docs/p8-scope-decision-l1-l2-2026-10-25.md)。全局 AGENTS 实际只有自身路径文字；feature-development.md 与最初尝试的 `.agents/roles/` 不存在，随后使用实际工作流及 `.agents/agents/`。

预检后先向用户报告实施计划，再创建分支、冻结协议、执行验证。按项目规则完成独立只读 reviewer 复审。没有下载/解包/读取 VPK 成员、NAV、碰撞或其他游戏资源，没有安装依赖、编译 native helper、运行地图解析器、启动游戏或修改生产/公共契约/UI/统计/manifest/旧报告/旧测试。所有新代码均在 docs/experiments 下。

## 2. 输入身份与阈值冻结

| 输入 | bytes / 参数 | 本轮 SHA-256 |
| --- | --- | --- |
| .demo/dust2.dem | 557650967；map_name=de_dust2 | db90fe85aab023a1d2c8a5996182e6120d98ef494f02a070b17982b235e4958c |
| 原始 Dust2 overview | 541；posX=-2476，posY=3239，scale=4.4 | 97947e99bc7930fc06dc15af3dcf942dbca5ca1c6f36119a089615fd4b383620 |
| Dust2 PNG | 175761；1024×1024 | 0828297130ce26db25a299806ff743df9104de634a3e64b52b358f6f4399354d |
| replay-resources.json | 21974 | a055ce462c1c8f464f54493b0bd7287fc16f5171bf29d2a3e1120de0a6e9f543 |
| 历史 replay-calibration.json | 12136；只读 | be8142476361896360cde49f88849e8c0449c3907723437b0446e46ae153d99b |
| 被测 replay-map-geometry.ts | 3190；直接 import 当前源码 | a242bf59f92af958d094a997b26a89d2f954dc06ca30edcf46c3da2a458c9c33 |

native 为 `0.42.0-backport.363.1`，Windows x64，加载时校验 source/provenance 和二进制 SHA `132d664125b60542dc80dc8bc270e2c8e181a0a55433fdac5be285ef4d9b0de1`。使用本机现有 Node v26.3.0，无新依赖。DEM 只读入内存，不复制；输入大小/mtime 在读取和查询前后稳定，非整套资源的原子快照。

resourceId 为 `valve-730-2347770-2312433566686574487-vrf20.1`。overview 和 PNG 字节与 manifest 一致，只确认显示资源身份。`versionMatch`、`demVersionMatch` 均保持 **unconfirmed**；未重查当前安装 VPK，未把历史安装记录当作本轮新测结果。

协议冻结于 **2026-10-26 02:47:40.951 +08:00**；SHA `f0141108ec03a5a2dc25eed61b4e778e9da7fcda8e6daeb193bf083c20b6c3d0`（对脚本导出的 protocol 按 JSON.stringify 计算）。首次真实查询开始于 02:47:46.914，完成于 02:47:48.673。冻结快照、脚本摘要和运行时间见 JSON。历史框与既有通过结果在冻结前已经阅读，故其重跑永远标为探索性，不能称盲测或保留集。

冻结的研究门槛如下，均非引擎精度标准，也非生产枚举/API：

| 对象 | 事前规则 |
| --- | --- |
| 算术案例 | 绝对残差 ≤1e-9 px；实际查询结果必须有限。实测只覆盖列出的样例和 DEM 输入，不宣称穷尽整个连续数值区间 |
| 独立点资格 | 同一固定地物的可信世界 XYZ、独立图像位置、目标 DEM 关联、采集方法和有依据的径向不确定性；参考误差 ≤2 px；不用被测转换/逆变换制造对应 |
| 局部近似投影 | 至少 6 个不同、非共线的独立保留地标；冻结区域多边形与高度范围；覆盖中心/边缘/双轴，地标凸包覆盖所声明区域至少 50%；只在获得支持的范围内讨论 |
| 局部误差 | 每点保守误差 e+u 的最大值 ≤8 px，中位数 ≤4 px；e 是像素残差，u 是有根据的参考不确定性上界 |
| 全图研究门槛 | 至少 24 个不同独立地标，至少 6 个分散区域，每区至少 4 个；覆盖中心、边缘、长距离方向和高度变化；同样的误差门槛。这不替代各区域 6 点的局部等级门槛 |
| P95 | 至少 20 个不同独立地标，nearest-rank 描述统计；数量不足为 insufficient-sample；重复玩家/重复 tick 不当作独立样本 |

8 px 与 4 px 是本轮事前提出的保守显示研究预算，不是从本次误差拟合而来。对应 1024 正方图归一化误差为 0.0078125、0.00390625。参考不确定性必须同时覆盖图像标注误差及世界坐标测量误差传播到像素后的分量，不能只计算标注误差。任何后续调参必须另存校准集，并重新冻结独立验证集。本轮无合格点，阈值未被用于签收空间准确性。

## 3. 基准来源、独立性与图像候选记录

现有本地资料可提供两类互不等价的观测：PNG 中可视觉定位的图形、DEM 中的服务器玩家 XYZ。尚无可信材料把某个玩家在某 tick 的位置严格绑定到 PNG 上某一固定地物坐标。出生区域有面积，玩家位置不必等于出生图标中心；plant actor 是玩家原点，不是炸弹区几何中心或已标注角点，植包事件本身也不提供参考像素。

### 3.1 八个图像候选

以原始 1024×1024 图像左上角为原点，X 向右、Y 向下，记录连续像素坐标；由 agent 直接查看原 PNG 后估读，**不是人工测绘或盲标**，没有投影叠加、反算世界坐标或利用 overview 图标位置。误差半径为启发式视觉歧义范围，未经独立标注者校准，不能充当已知置信区间。

| referenceId | 区域与图像特征 | 图像 (x,y) | 估计半径 px | 世界坐标 / 用途 |
| --- | --- | --- | ---: | --- |
| IMG01 | 西侧炸弹区橙色框西北角 | (171,82) | 4 | null / exploration-only |
| IMG02 | 东侧炸弹区橙色框西北角 | (780,139) | 4 | null / exploration-only |
| IMG03 | 南侧 T 出生绿色框西南角 | (295,957) | 4 | null / exploration-only |
| IMG04 | CT 出生实线绿色框西北角 | (574,155) | 4 | null / exploration-only |
| IMG05 | 中路斜向双门缺口中心 | (458,371) | 8 | null / exploration-only |
| IMG06 | 东侧长通道蓝色长方形东南角 | (921,698) | 6 | null / exploration-only |
| IMG07 | 西侧隧道弧形楼梯图示中心 | (282,475) | 10 | null / exploration-only |
| IMG08 | CT 附近斜线重叠层图示中心 | (648,212) | 12 | null / exploration-only |

每点的 sourceEvidence、annotationMethod、referenceUncertainty、missingEvidence、训练/验证资格均在 JSON `execution.imageReferences` 中。全部 `trainingEligible=false / validationEligible=false`。这些图像点可指导下一次取证；图形角点并不必然对应可采集的世界实体角点，后续必须先确认语义，不能强行配对。

### 3.2 旧资料为什么不能提供独立点真值

[历史配准脚本](../scripts/replay-calibration.mjs)确实说明矩形来自视觉框选，而非逆投影；这可作粗配准线索。但它的每个 `point.pixel` 都是由同一 overview 参数算出，不是独立像素标注，不能再与 `worldToRadar()` 比较后报告接近零的空间误差。

更具体地说：

- T/CT 出生依据 team 与 freeze tick 选择；可识别的是区域类别，无法指定区域中的唯一像素点。
- 东/西炸弹区依据 `planter && x > 0` / `x < 0` 选择。该分组使用待验证的世界轴，不能独立证明世界轴与图像东西方向对应；本轮保持为历史探索诊断，未把 native site index 直接推断成 A/B。
- overview 的 `CTSpawn_x/y`、`TSpawn_x/y`、`bombA/B_x/y` 是同一显示资源的图标元数据，没有与某个 DEM 世界实体原点的可信对应或误差保证，不作为独立地标。
- DEM 有 XYZ 和事件事实，却没有这些图像地物的已核验世界 XYZ。PNG 有图形，没有三维高度真值、碰撞边界或 NAV 拓扑。把两者通过反变换拼在一起属于循环论证。

因此 **独立配对数=0**。没有有效基准点可计算真实 residual；其 mean/median/max/P95 均为 null，不能写成 0。并非发现了明确错配，也不能判定 mismatched。

## 4. A：投影算术的实际验证

直接调用[当前生产源码](../apps/desktop/shared/replay-map-geometry.ts)，没有另写替代投影器：

```text
u = (x - posX) / scale * width / 1024
v = (posY - y) / scale * height / 1024
e_px = hypot(u - reference_u, v - reference_v)
e_normalized = hypot((u-reference_u)/width, (v-reference_v)/height)
```

| 合成公式案例 | 世界 XY 输入 | 期望图像 XY |
| --- | --- | --- |
| 原点 | (-2476,3239) | (0,0) |
| X 增大 440 | (-2036,3239) | (100,0) |
| Y 增大 440 | (-2476,3679) | (0,-100) |
| 中心 | (-223.2,986.2) | (512,512) |
| 右下边界 | (2029.6,-1266.6) | (1024,1024) |
| 左侧越界 | (-2916,3239) | (-100,0) |
| 下侧越界 | (-2476,-1706.6) | (0,1124) |

这 7 项是明确的 **synthetic-formula-only**，逐项输入、期望、实际结果和 residual 保存在 JSON `execution.arithmetic`，最大算术残差为 **1.4210854715202004e-14 px**。它们验证原点/轴向/尺度的公式实现，不是 Dust2 地理真值。

另测非正方形 2048×512 缩放、非有限/null/string 输入拒绝、非正尺寸/比例尺拒绝、HUD rotate/zoom/inset 不应用于原始未旋转图、Z 不影响 XY 投影及 Dust2 单 default 层。边界结果不钳制：连续边缘坐标 1024 不代表有效栅格索引 1024，调用方如用于像素索引须另行处理。

数值限制：现有函数只检查输入有限，极端有限值相减可溢出，已用测试刻画 `Infinity` 输出。没有修改生产代码，也不宣称任意有限 Number 都安全。PASS 仅适用于上述实测样例和本轮真实 DEM 的有限投影结果；不是整个连续输入区间的形式化证明，更不是几何准确性。

## 5. B：真实 DEM 投影与区域诊断

真实运行使用已有 native `parseEvents` 和 `parseTicks`。只请求 X/Y/Z/is_alive/team_num，固定实际 tick：

```text
2712, 21621, 43991, 61675, 70450, 91257, 101668,
114041, 124988, 144817, 161643, 183400, 199980
```

13/13 tick 返回，共 130 行；选取 tick 2712 的 10 个存活 T/CT 端点，以及其余 12 个 tick 的唯一 `bomb_planted` actor 原生行，共 **22 个去身份孤立快照**。逐个断言实际 tick、唯一事件/actor join、存活与完整有限 XYZ；没有 nearest/interpolation 或连续轨迹采样。事件只用于离线回顾性诊断，历史 tick 选择不是未来隔离的在线 coaching 输入实验。过滤 `is_warmup_period !== true` 包含未知 warmup 值，不声称严格的正式回合分类验证。

玩家身份仅在内存中用于 join，不保存或打印。实际快照输入 XYZ、输出 UV 和每点区域距离范围只保存在当前 chat 的本地 `work/spatial-benchmark-run.json`，不进入 Git；该文件没有姓名、SteamID、稳定跨 tick alias 或原始事件内容。JSON 记录其摘要和可复现脚本，提交内容只有聚合诊断。由于有效独立配对为零，没有需提交的逐点真实地标残差；新图像地标的世界坐标保持 null。

### 5.1 条件距离范围，不能当定位误差

对投影点 p 与矩形 R 计算 `d_min = min(q∈R)|p-q|` 和 `d_max = max(q∈R)|p-q|`。只有额外假设“未知参考点在 R 内”成立时，它们才约束点间距离；本轮并未证明这一逐点语义对应。框内 d_min=0 不意味着 e=0，矩形中心距离也不能冒充真实误差。归一化范围使用各值 /1024。

| 历史区域 / bounds [左,上,右,下] | 样本 / 框内 | d_min 均值/中位/最大 px | d_max 均值/中位/最大 px | 独立点 / P95 |
| --- | --- | --- | --- | --- |
| T spawn [295,875,490,960] | 5 / 5 | 0 / 0 / 0 | 152.819 / 164.177 / 179.727 | 0 / insufficient-sample |
| CT spawn [570,150,685,265] | 5 / 5 | 0 / 0 / 0 | 108.210 / 109.187 / 116.003 | 0 / insufficient-sample |
| east bomb area [775,135,855,215] | 7 / 7 | 0 / 0 / 0 | 78.832 / 79.052 / 91.765 | 0 / insufficient-sample |
| west bomb area [165,78,260,180] | 5 / 5 | 0 / 0 / 0 | 105.809 / 110.726 / 114.933 | 0 / insufficient-sample |

区域上界最大值的归一化值分别约 0.175514、0.113284、0.089614、0.112239；精确值见 JSON。本表是探索性包含/条件区间统计，不能据此说真实误差很大或很小。没有聚合 22 个非独立观测计算伪装的准确性 P95。

### 5.2 覆盖与不足

四矩形互不重叠，总面积 45890 px²，仅占整幅 1024² 图像 **4.3764%**；这是图像矩形占比，不是可玩地图面积或已验证几何覆盖率。实际快照 XYZ 总范围为 X [-1696.284,1235.968]、Y [-843,2642.252]、Z [-121.077,119.884] DEM world units，仅描述观测分布，不证明覆盖凸包内部/高度段。

| 区域/维度 | 本轮证据 | 缺口 |
| --- | --- | --- |
| 南侧出生、北侧两个炸弹区、CT 出生 | 22 个快照，四个粗框 | 零独立固定地标配对；不能建立局部等级 |
| 中路中心、A 大道长距离段 | IMG05/06 仅图像 | 没有相应 DEM 固定地标坐标，不被四框复核覆盖 |
| 西侧隧道楼梯、CT 重叠层 | IMG07/08 仅图像 | 无独立 Z、楼层对应、斜坡或高度真值 |
| 极端地图边缘、双轴跨度、区域连接处 | 只有图像候选分布 | 无完整保留集；跨度不等于区域覆盖 |

不得将图像颜色/斜线、不同 Z 或 Dust2 的单层返回值解释成已经验证的上/下层或碰撞高度；不得将 DEM world units 换成米。

## 6. C：局部兼容性研究模型

建议为 **目标 DEM 摘要 × 资源摘要 × 区域/高度范围 × 声明能力 × 方法/阈值版本** 建研究记录，包含独立依据、校准/验证用途、输入输出、样本数、误差与不确定性、覆盖多边形、未覆盖范围和状态。此模型不新增生产类型、枚举、manifest 状态或缓存授权。

| 候选等级 | 仅对所声明能力和范围的含义 |
| --- | --- |
| exactly-validated | 资源身份关系及所声明能力均通过相应独立验证；本轮没有这种记录 |
| regionally-compatible | 在明确区域/高度与能力内，可信配对、冻结阈值、独立保留集和覆盖均通过；可不依赖恢复历史构建号，但必须直接关联目标 DEM 与受测区域证据 |
| unconfirmed | 缺来源、对应、精度、范围或能力证据；本轮所有局部能力均为此级 |
| mismatched | 有可信反例证明资源不适用于声明能力/范围，例如排除错误配对/测量后，合格独立点误差下界 max(0,e−u) 仍超过预设最大误差门槛；只能否定该声明，不能扩大成全图所有能力均错 |

仅误差上界 e+u 超标不构成错配证据；误差区间跨过门槛时仍为 unconfirmed。误差越界还必须区分配对/测量错误与实际资源不一致；候选图像估读失败不能直接给 mismatched。资源或 DEM 摘要、范围、方法、阈值发生变化，旧验证不得自动复用；未知区域不能沿凸包外推，聚合标签不能覆盖能力差异。

| 独立能力 | 当前等级 / 测试状态 | 不允许自动升级的原因 |
| --- | --- | --- |
| overview 局部投影一致性 | unconfirmed / BLOCKED | 有算术和粗框线索，无合格逐点残差 |
| 世界坐标局部一致性（DEM→资源） | unconfirmed / BLOCKED | 原生 XYZ 存在不等于固定地物对应或高度配准 |
| 静态碰撞局部一致性 | unconfirmed / NOT RUN | 雷达图不提供墙体体积、碰撞 mesh、材质/过滤或高度真值 |
| NAV 局部可达性 | unconfirmed / NOT RUN | 未读取 NAV、hull、连接、通行条件或正反例 |
| LOS 局部一致性 | unconfirmed / NOT RUN | 没有独立射线/遮挡真值；投影误差小也不能证明墙体一致 |
| 动态遮挡 | unconfirmed / NOT RUN | 无烟雾/门/火焰等时变模型和验证 |

即使未来 A 大道投影通过，也只证明该区域该误差预算下的映射；不证明墙体碰撞、NAV、静态 LOS，更不证明实际看见敌人、注意力或意图。本轮没有通用 `geometry: PASS`，没有确认地图整体匹配。

## 7. 能力验收与 L2.1 独立性

| 能力 | 本轮目标与结果 | 通过条件/未通过原因 |
| --- | --- | --- |
| 投影算术 | PASS | 11 项新增测试、7 个公式案例及 22 个真实有限投影；限制见第 4 节 |
| 独立地标误差 | BLOCKED | 0 个合格配对；真实 mean/median/max/P95 均 null |
| 全图坐标一致性 | BLOCKED | 无独立覆盖与高度真值，不能由四框通过外推 |
| 局部兼容性 | BLOCKED；研究等级 unconfirmed | 四区域均无足量合格独立基准与实际精度残差 |
| 静态碰撞 | NOT RUN | 不在授权实施范围，无真值 |
| NAV 可达性 | NOT RUN | 不在本轮实施 |
| 静态 LOS | NOT RUN | 不在本轮实施 |
| 动态遮挡 | NOT RUN | 不在本轮实施 |

L2.1 距离能力保持独立：同一 DEM、同一 actual tick、来源与规范一致、完整有限 XYZ 可计算水平/三维距离，不依赖地图资源匹配。重新运行现有真实距离测试，4 对端点 / 8 次 kind 比较通过（计为 1 项测试），未改 API 或代码。地图身份未知不阻断合法距离和独立服务器事实；距离仍不能推出路线、LOS、动态遮挡、到达时间或可支援性。未推断玩家知道、看见、心理或意图。

## 8. 命令、测试、文档验证与复审

所有 shell 批次及实际退出码见 JSON `commands`；连接器/图像查看/编辑工具单列 `toolCalls`，无 shell exitCode。早期读取不存在路径与输出截断被保留说明，批次末尾 exit 0 不代表每条中间读取成功；已定向恢复必要内容，没有把未读资源当证据。

| 实际验证命令 | 退出码 | 结果 |
| --- | ---: | --- |
| node --test docs/experiments/p8-1l2-spatial-benchmark.test.mjs | 0 | 11/11 PASS，0 skip；独立 reviewer 重跑不重复计数 |
| node docs/experiments/p8-1l2-spatial-benchmark.mjs &lt;绝对本地 work 输出路径&gt; | 0 | 13 个 exact tick，130 返回行，22 选取快照；结果如上 |
| node --test apps/desktop/tests/replay-map.test.mjs scripts/replay-resource-audit.test.mjs docs/experiments/p8-1l2-distance-real.test.mjs | 0 | 9/9 PASS，0 skip；含 13 张旧图片/overview 身份审计及 1 项真实距离测试 |

唯一运行时测试共 **20/20 PASS**；真实 benchmark CLI 另算一次实验，不冒充新增测试个数。旧测试标题含“independent landmarks”，本报告仅接受它实际执行的历史区域回归含义。

交付检查覆盖 JSON 可解析、必备章节与状态矩阵、MD 本地链接、资源摘要、协议冻结一致性、记录不含玩家身份/原始快照、四文件新增白名单，以及 `git diff --check`。主检查 11 组 PASS；独立 reviewer 最终 11 组静态检查 PASS、0 个未解决阻塞项，复核了算术与空间准确性分离、阈值/覆盖、actual tick、去身份输出和范围。11 个本地 MD 链接与 11 个本地来源路径有效；详细结果保存在 JSON `validation`。自引用提交 SHA 在交付消息提供，不写入提交自身。

未执行全仓 typecheck/build/full tests、GUI/安装版、其他 DEM、在线服务/AI Coach、外部地标采集、重新构建 native、VPK/NAV/碰撞/LOS/动态模型。没有生产变更，针对本次文档/独立脚本执行上述验证；旧大规模测试记录不计为本轮通过数。

## 9. 后续最小证据与停止条件

最小缺口是 **固定地物对应与有依据的不确定性**，无需先强行恢复历史游戏 build：

1. 先选择一个明确小区域与能力（如 A 大道的 overview XY 映射），冻结区域边界、Z 范围和阈值。取得至少 6 个不同非共线固定地物的可信世界 XYZ，并证明这些坐标与目标 DEM 的该区域有关；可来自录制环境的受控测量日志、已有独立测绘资料、或可验证的固定实体原点。新安装地图的坐标不能在没有关系证据时直接代替目标 DEM 真值。
2. 对同一组确切地物单独标注图像像素，不看投影输出；记录 PNG 摘要、标注者/方法、角点语义、重复标注差异与误差上界。图标中心、plant actor、从 overview 反推的世界坐标都不能代替它。
3. 校准点与验证点分离，保留不调参的独立验证集；在支持范围内计算每点真实误差、均值/中位/最大/P95（样本足够时）及空间覆盖。6 点只能启动局部验证，不够稳定 P95；全图与高度能力另取足量独立证据。

如果现有材料仍不能形成可靠配对，继续 BLOCKED；不以更宽框或事后放宽阈值制造通过。若未来研究碰撞/NAV/LOS，需各自独立几何真值与授权，不能继承本轮投影结论。

本轮结束后停止。仅本地独立分支提交；不 push main、不创建或合并 PR、不修改版本、不建 tag/Release，不自动进入 L2.2D、NAV、LOS 或 P8.2。
