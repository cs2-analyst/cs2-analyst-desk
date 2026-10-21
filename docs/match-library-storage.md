# CS2 Analyst · 本地比赛存储与可移植档案设计（规划）

> **状态：L0–L5 Gate 与人工验收均已通过。** 完整热力图规范源 A、独立 gzip-6 分块及 Electron 内置 SQLite 已由 L1 冻结；L2 验证无 DEM 离线重开，L3 验证 `.cs2a` 导出/导入与删除，L4 验证导航与库 UI。实测见 [L0 报告](./match-library-l0-storage-evidence.md)、[L1](./match-library-l1-foundation-evidence.md)、[L2](./match-library-l2-offline-restore-evidence.md)、[L3](./match-library-l3-data-operations-evidence.md)、[L4](./match-library-l4-navigation-evidence.md) 与 [JSON](./match-library-size-benchmark.json)。与 [比赛库计划](./match-library-plan.md)、[导航设计](./match-library-navigation.md) 配套。
>
> 核心决定：默认把用户主动导入的 DEM **解析后、分析后的完整可复用结果保存在 Windows 本机**；**不保存 DEM 原文件**、不建设个人比赛历史公共服务端、不要求账号、不上传个人 DEM。用户可删除、导出及导入单场归档。P8 职业知识管线/AI Coach 服务是另外一条独立路线，不与本地比赛库混淆。

## 1. 现有代码事实与容量基线

检查范围：`apps/desktop/renderer/src/store.ts`、`apps/desktop/electron/report-worker.ts`、`apps/desktop/electron/replay-session.ts`、`apps/desktop/electron/heatmap-session.ts`、`apps/desktop/shared/heatmap.ts`、`packages/report-contract`。

| 数据对象 | 当前持有者 | 已证实事实 | 历史化要求 |
| --- | --- | --- | --- |
| `DesktopMatchReport` (schema v2) | Renderer/导入成功 IPC | 统计、Findings、全玩家时间线、Deep Review、展示分析等已预计算 | 持久化全部报告 DTO；重开不用 DEM/重新跑 Analytics |
| `DesktopReplayMetadata` | `report.replay` | 仅有元数据、回合/Chunk 目录和临时 sessionId | 会话 ID 是临时句柄，不能原样当永久存储身份 |
| `ReplaySession.chunks` | Utility Process 内存 | 20s 内按需切分/≤1MiB 单块、≤64MiB 会话预算，内容为 JSON | 保存每块数据，历史浏览时按需解压、读取，保持 IPC 边界 |
| `HeatmapSession` | Utility Process 内存 | 默认投影可缓存≤512KiB，其余筛选通过 `Match + MatchReplay + MatchSpatialEvidence` 动态计算 | 保存**足够重建所有现有过滤条件**的规范证据，不能只保存默认网格 PNG |
| 地图 PNG、overview、官方道具 SVG、火苗图集 | 安装包静态资源 | 公共渲染资产，与比赛无关 | 每场不重复保存资源，只记录必要资源/坐标版本 |
| DEM 文件 | 用户选择路径 | 当前 Parser 一次读取并计算 SHA-256 得到 `match.id` | 仅导入时使用，归档不复制 DEM，也不保留用户绝对路径 |

**Dust2 实测基准：**现有白名单 `.demo/dust2.dem` 原文件 557,650,967 bytes（约 532 MiB；十进制约 558 MB），SHA-256 `db90fe85aab023a1d2c8a5996182e6120d98ef494f02a070b17982b235e4958c`。此前单场 Replay JSON 缓存实测 36,495,839 bytes（约 34.80 MiB），159 个 Chunk。这是**某次基线会话未压缩 Replay 缓存**，并非当前全部归档大小或压缩后实测。

**容量假设而非结论：**报告可能为 KB～数 MB；完整报告+Replay+热力图证据在压缩后暂以 **10–30 MB/场**作初步磁盘预算规划（不是已验证区间）。算法版本、回合长度、轨迹密度和额外证据都可使其超出。500 场假设约 5–15 GB、1000 场约 10–30 GB；必须先执行 §2 基准测量才能固化默认方案/配额。

**禁止混淆三种指标**：原 DEM 磁盘大小 ≠ 分析 Utility Process 峰值内存 ≠ 归档大小。此前 Utility 进程峰值约 1.7GB 不能据此得出单场持久化必为 1.7GB。

## 2. L0：持久化体积与恢复能力 Gate（必须先完成）

**首次实施应先做这个无产品行为变更的证据工作单元。** 只使用 [白名单 DEM](./demo-fixtures.md)，严禁下载、仓库跟踪或复制 DEM。

对至少 `.demo/dust2.dem` 用**当前生产 Parser、Analytics、Deep Review、Findings 与 Replay/Heatmap 会话路径**生成：
1. `DesktopMatchReport` 去除或替换临时 sessionId 后的 UTF-8 JSON 字节数。
2. 全部 Replay Chunk（包括道具真实轨迹、effect/blind/burn、玩家状态和 event），逐块字节数、总和、最大块、Chunk 数、gzip/Brotli 压缩后大小。以原有小块边界为单位压缩，评估独立随机读取而非必须解压整个比赛。
3. `Match`、`MatchReplay`、`MatchSpatialEvidence`（仅用于热力图重算的候选持久化源）分别单独及合计序列化字节数、压缩后大小，统计字段冗余。评估精简的**规范性热力图源数据**替代全量领域对象的可能性，必须证明所有现有筛选完全同值。
4. 一个默认 32×32 热力图投影及 16/32/64、玩家/阵营/回合/楼层/冻结时间等实际请求的结果大小；**单个网格不代表全部热力图可恢复**。
5. 每场最终归档总大小（容器开销、索引、摘要/校验和）、压缩/解压耗时、打开历史首屏时间、随机 Replay Chunk 读取 p95、按需热力图请求时间及加载峰值。
6. 开发独立验证用的 round-trip：关闭 Electron/杀 Utility → 删除/临时移走 DEM → 重新打开归档 → 全六视图关键数据与当前基线 hash 一致；切换玩家和热力图全部过滤；真实 Replay seek、道具视觉窗口与抽样准确；损坏/版本不兼容档案降级而非白屏。
7. 至少一次长比赛或其他白名单样本作规模交叉校验；样本不足就把“仅 Dust2 容量校准”明确保留，不擅自当成全地图普适估计。

输出机器可读 `docs/match-library-size-benchmark.json`（未来实施时才创建）和短报告，逐项记录源 SHA、版本、Windows/Node/Electron、原始/压缩字节、算法及 CPU/内存/时延。**不得现在编造这些结果。** 先冻结完整性/随机读取/存储预算，再正式选择归档载荷和压缩方法。

压缩候选：Node 内建 gzip/Brotli 等已有可用实现，优先易离线维护、可跨版本读取；需按实际安装版验证 CPU/压缩比，再决定 `.cs2a` 容器用 ZIP/deflate 或分块压缩。不可因压缩率牺牲数据完整性、随机关卡访问或启动速度。

## 3. 本机物理结构与模块边界

推荐结构（**目标架构，不是已创建的文件/包**）：

```text
Windows 当前用户的 LocalAppData / CS2 Analyst / MatchLibrary /
├── library.db                # SQLite 小数据：比赛目录、状态、版本、磁盘大小、摘要、偏好
├── matches/
│   └── <matchId>/
│       ├── manifest.json     # 不可变清单：格式、版本、内容摘要、功能可用性
│       ├── report.json       # 预计算的可读报告（可压缩，视基准）
│       ├── replay/           # 索引 + 单个独立压缩 Chunk，按需读取
│       └── heatmap/          # 足以重投影所有筛选的规范证据（格式由 L0 证明）
└── staging/                  # 临时原子写入区，失败后可清理
```

- 使用**LocalAppData 非漫游目录**作为大体积历史存储；Electron 默认 `app.getPath('userData')` 在 Windows 常可能位于 Roaming，不能不经检查把 GB 级档案放进去。实施时使用 Electron 安全路径 API 和已验证的 LocalAppData 解析策略，显式防目录穿越/符号链接逃逸；不修改当前用户设置目录而丢失既有“上次 DEM 文件夹”偏好。
- SQLite 只管**小索引、版本、状态、档案目录引用与事务**；大数组/Replay Chunk/轨迹/热力图证据保存为独立按需载入的压缩文件，不把整场数据塞进 SQLite 单行 BLOB。
- 具体 SQLite 驱动及 Electron 原生打包 ABI 在 L1 验证后冻结；不能假定 `node:sqlite` / 第三方 native package 在当前 Electron/NSIS 下天然可用。单机单写者和 WAL/事务策略需实测。
- Renderer 仅经受信、范围受限的 preload/IPC 做列表、打开、删除、导入/导出；不接触文件系统路径、数据库句柄、Node API 或任意用户 SQL。持久化在 Main 的服务边界；CPU 重活与读压缩大文件在合适的 Utility 后台流程，不阻塞 UI。
- “打开历史”不能调用 `parseWithReplay()` 读取不存在的 DEM；保存的是预计算结果，不能偷偷再次分析并得出不同版本的数据。
- 当前 Replay `sessionId` 是瞬时 UUID，按打开档案时重新生成。持久键采用来自原文件 SHA-256 的 `match.id` + 档案格式版本；所有 IPC 保留既有可信会话/请求与 1MiB Chunk 等约束。
- 资源引用只允许应用随附的官方地图/道具素材，记录相应资源版本与不一致降级。**不**将同一份官方资产复制至每一场归档。

## 4. 最小持久化契约（待 L0 后冻结）

`MatchLibraryEntry` 建议字段：
- `matchId`：本机不可变主键（当前 SHA-256 DEM 内容摘要）；`fileName`：只保存 basename，不保存原绝对路径；
- `map`、`rounds`、`score`（可能 null）、`importedAt`、可证实的比赛时间（如存在；否则 null）、`playerSummaries`；
- `archiveSchemaVersion`、`reportSchemaVersion`、`replaySchemaVersion`、`analysisVersion`、`parserVersion`、`samplingVersion`、`mapResourceVersion`、`capabilities` 与 coverage 状态；
- `storedBytes`、清单摘要、状态 `ready|importing|invalid|unsupported`；可选最后打开视图/目标玩家偏好。
- 结构演化遵循显式 migration 版本，不把旧 archived metrics 默默换成新 Analytics 算法结果。

`capabilities` 对**报告、Deep Review、Timeline、Analysis、Replay、Heatmap**逐项标记 `available / partial / unavailable` 与客观原因。某场热力图没有可重建证据时绝不展示成全功能可用。

`archiveSchema` 与现有 `report.schemaVersion=2`、`DesktopReplayChunk.schemaVersion=1` **独立**；可识别旧数据并可给出只读降级、显式迁移或重新由用户提供 DEM 的提示，不能随意改动已接受的统计结论。

**选型约束**：必须二选一验证完整热力图恢复：
- A：持久保存 `Match + MatchReplay + MatchSpatialEvidence` 的必要规范证据（可较大，能力完整）。
- B：在对所有现有过滤与 coverage 的实测 hash 完全等价后，定义专用、最小可重投影热力图证据格式（推荐长期方向）。
- 禁止仅保存默认 32×32 图片/网格而失去玩家、回合、楼层及采样集的切换能力。不要为实现本地库增加第二套 DEM Parser 或重跑基础分析。

## 5. 写入、去重、删除与崩溃恢复

**导入：**用户选 DEM → 现有单次本地解析/分析 → 生成规范 DTO/Chunk/热力图证据 → staging 完整压缩、校验 → 写入数据库事务及原子提交/重命名 → 标记 ready → 打开该场。错误、取消、断电不出现“列表可见却数据缺损”的半成品；重启可清理或恢复中间 staging 记录。不能以输入 DEM 已解析即提前声称已保存成功。

**去重：**相同 `match.id`（DEM SHA-256）视为相同原录像，提示“已导入，打开已有比赛”或由用户显式选择替换/重新分析；不默认生成重复占空间副本。不同 DEM 即使同文件名/地图也不得合并。不同算法版本重分析须有明确策略，不能覆盖不可复现证据而无提示。

**删除：**用户选择后确认，删除 SQLite 索引与对应归档，释放磁盘；支持批量删除和磁盘使用统计。若删除活动比赛，先释放 Replay/Heatmap 会话并回到库；失败显式告知、可重试清理，不出现孤儿文件/悬空索引。用户要求删除意味着实际清理档案，不能只隐藏列表。

**资源保护：**归档读取大小、文件数、解压总量、分块大小、路径层级、内容类型均必须有界；磁盘写失败、空间不足、权限只读、杀进程、旧版本与校验损坏必须有确定性状态/恢复机制。

## 6. 便携归档（导出、导入）

用户可从比赛库选择“导出比赛”为**单文件** `.cs2a`（扩展名暂定，格式本阶段只设计）。一个归档至少包含：

```text
manifest.json       # archiveVersion, matchId, hashes/sizes, component versions, capabilities
report/...          # 全部已分析 DTO 与摘要
replay/...          # 全部可独立解码的回放 Chunk（包括现有道具效果）
heatmap/...         # 支持全部已实现筛选的必需证据
```

- 原始 DEM、完整源文件路径、临时 IPC sessionId、分析缓存/日志、重复静态地图图标**不得**进入归档。
- 导出前验证档案完整性，临时输出 + 原子重命名；取消/失败不产生看似成功的残缺包。对话框显示实际文件大小，用户可选择保存到任意可写路径。
- 导入包先在受限临时区域进行**版本/文件数/单文件及总解压预算、SHA-256、manifest 关联、路径穿越、symlink/zip bomb、重复 Match ID**验证，确认后原子入库。禁止运行档案内任意脚本/SQL、禁止访问归档声明的外部 URL/路径。
- 导出包内可能包含 SteamID、玩家昵称、轨迹与完整比赛记录；用户主动导出/分享前明确隐私提示。默认全离线，禁止未经选择上传到后台。
- 允许跨电脑恢复同一份归档；应用版本无法读取时显示“该比赛由更新版本保存”，提供可理解的恢复操作，不能静默丢弃。
- 导出/import round-trip 必须在**原 DEM 不在电脑**的条件下正常使用全部六个已有视图，且关键统计、Replay/Heatmap hashes 与原场一致。

## 7. 验收阈值与阶段 Gate

| Gate | 合格标准 |
| --- | --- |
| 容量（L0） | 真实记录未压缩/压缩字节和负载构成；对多份真实白名单 DEM 只声明实际覆盖范围 |
| 持久化（L1–L2） | 新开应用、移走 DEM 后仍能打开全部已保存数据，报告指纹、回放采样、热力图重投影不变 |
| 性能 | 比赛库初屏不读取全部比赛 Chunk；随机读取有界，记录 p95/峰值；不得明显破坏当前播放流畅度及 15s 导入目标 |
| 稳定性 | 重复导入、取消、崩溃、中断写、磁盘满、损坏与版本不匹配，均无半写污染及丢失已有比赛 |
| 归档（L3） | export → remove local → import `.cs2a` → 六视图重开通过；无 DEM；未知包受限失败 |
| 安全 | 无任意路径/API、无遍历、无任意解压、无 DEM/个人证据自动网络上传 |
| Windows 安装版 | 验证 Electron Native SQLite 选择、只读资源引用、NSIS 安装/卸载、用户数据保留策略；不要靠开发环境测通就算通过 |

历史 Replay 解析 `≤5s` 预算仍是已知独立性能债：历史归档应避免重复 DEM 解析，但不能用“打开历史快”反推首次导入的 Replay 解析预算已解决。

## 8. 本设计明确排除

- 公共个人比赛存储服务端、`apps/api`、账号/Session、云同步和自动上传；
- 自动扫描/抓取 DEM、源 DEM 长期保留、云原始录像备份；
- 把职业知识库/后端 AI 模型资料放进用户归档；
- AI Coach/P8 开发、地图精确 LOS 证明、重算旧场 Analytics、跨场战力排名/推荐算法；
- 未经产品确认的自动清理、容量限额及静默历史删改。

用户已授权 L0–L5；L0–L5 Gate 与人工验收均已通过。按 [执行台账](./match-library-execution.md) 与 [L5 验收记录](./match-library-l5-acceptance.md) 记录；发布仍需单独产品决定。
