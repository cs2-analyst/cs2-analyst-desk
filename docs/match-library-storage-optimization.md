# 分析归档无损存储优化：v2 格式与验证

2026-10-25。实现基线为 `9318ed9` 后的当前生产代码；没有回退分析算法或修改现有用户档案。本文为实现与独立复审记录初稿，**真实 DEM 容量、延迟及三类桌面进程内存实测仍由主验收补充，当前没有据此宣布整体性能验收通过**。

关联：[容量调查](./match-library-compression-audit.md)、[本地存储](./match-library-storage.md)、[便携格式](./match-library-portable-format.md)、[重新分析](./match-library-reanalysis.md)、[回放契约](./replay-contract.md)、[机器可读复审记录](./match-library-storage-optimization-review.json)。

## 格式与职责

新导入与用户明确执行的重新分析写入 v2；报告 schema 仍为 2、领域 Replay 与 UI Chunk schema 仍为 1。存储编码只位于 Desktop Electron 层，没有进入 Parser、Analytics、Findings、Deep Review 或领域模型。

| 边界 | v1 | v2 |
| --- | --- | --- |
| `manifest.schemaVersion` / `versions.archive` | 1 / 1 | 2 / 2，必须一致 |
| 独立成员压缩 | gzip level 6 | Brotli quality 6 |
| 文件后缀 | `.json.gz` | `.json.br` |
| 压缩字节及摘要 | `gzipBytes` / `gzipSha256` | `compressedBytes` / `compressedSha256`，`codec: "brotli"` |
| 普通 JSON 编码 | 隐含旧编码 | `encoding: "json-v1"` |
| 规范 Replay 存储 | 完整对象 JSON | `encoding: "replay-tuples-v1"` |
| UI 回放持久化 | 每个 `replay/r<round>-b<block>.json.gz` | 每回合 `replay/r<round>.json.br`，`encoding: "replay-projection-v1"` |
| `.cs2a` 外层 schema | 1，`archiveSchemaVersion: 1` | 仍为 1，`archiveSchemaVersion: 2` |
| SQLite schema | 3 | 仍为 3 |

清单保留应用、报告、Replay、分析、Parser、native、采样、地图资源及源提交版本。v2 严格约束角色、路径、字段、编码及摘要，不接受混合 gzip/Brotli 字段或借其他编码名解释载荷。未知归档版本明确拒绝；未知成员编码也拒绝，不猜测解码方式。

v2 的四个必需成员为 `report.json.br`、`heatmap/match.json.br`、`heatmap/replay.json.br`、`heatmap/spatial.json.br`。报告及 Match/Spatial 是完整 JSON，Spatial 没有字典化、删字段或降采样。Replay 不可用时仍有明确的 null 编码；能力声明须与规范源一致。

每个成员的 `rawBytes` / `sha256` 校验的是**实际存储表达解压后的字节**；对 tuple 成员，这是 tuple envelope 的 JSON，而非还原后领域对象 JSON。压缩摘要另行校验压缩字节。还原后的规范数据在测试及真实样本验收中与原始完整 JSON 严格比较，不使用浮点容差。

### Replay tuple

`library-replay-codec.ts` 仅把 `rounds[].frames[].players[]` 对象替换为 `[schemaIndex, ...values]`。envelope 保存 `encoding`、按原始属性顺序登记的 `schemas` 和其余完整 `source`。每个不同属性集合或顺序都有独立 schema；缺失字段不会补 null，false、null、字符串 SteamID、全部 Number 及样本顺序原样保留。事件、生命周期、coverage、道具轨迹和其他规范字段不做语义变换。

解码先检查 envelope、schema 唯一性、安全键、引用及行宽、玩家/回合/帧/样本数、嵌套深度和展开后的完整 JSON 字节预算，再分配还原对象。展开上限仍为普通组件的 256 MiB，不能利用小 tuple 字典突破原有组件或总归档预算。普通 API 不修改输入；归档 reader 对自己刚解析且完整预检通过的树使用 `consume`，逐个替换 tuple，以减少同时存活的样本树。

### 每回合 projection

`library-derived-replay.ts` 是固定的存储解码器。`replay-projection-v1` 保存每回合 follow，以及每块的完整展示 template、原始永久 Chunk 字节数及 SHA-256。template 保留事件及其历史文案、昵称结果、道具窗口/轨迹、盲时、燃烧、所有其他展示字段、原块编号和 start/end tick；只有 frames 与可共享的 follow 用占位表达。

frames 由完整规范 Replay 精确重建，炸弹基线及 guard 选择算法固定在此编码中。解码器不调用未来的 `ReplaySession`，不重新格式化昵称/事件文案、不重新判定楼层或重新切块。原版本的 follow、地图/资源身份和切块结果都是保存的数据；修改固定 frame/bomb 算法需要新增编码分支，不能静默改变 v1 语义。每次生成的永久 Chunk 必须先通过其原始字节数及 SHA-256，之后才添加新临时 sessionId。

因此未来打开仍可验证既有 Chunk 的精确内容，不依赖源 DEM、网络或重新执行基础分析。没有把不持久化 Chunk 的收益再与 follow 去重另算一遍。

## 随机读取与内存

规范 Replay 目前仍是每场独立压缩成员，冷打开时完整恢复一次，与 Heatmap 共用规范源；这不是按源帧做磁盘范围读取。projection 则按回合独立压缩。每次 miss 只读目标回合 projection，用保存的块目录选择目标块及 guard 帧，转换这些玩家帧，并从本回合 bomb 事件恢复所需基线；不会为一次 seek 创建全场 ReplaySession 或全部 UI Chunk。

存储成员粒度与 UI IPC 块粒度分开：一个回合 projection 可以对应多块 UI Chunk，响应仍须满足单块 1 MiB。原 Replay 总序列化预算 64 MiB、归档总 raw 512 MiB、压缩总 256 MiB、Heatmap 响应/缓存 512 KiB、Heatmap heap 准入 512 MiB 均未放宽。

`DerivedReplaySession` 使用按实际序列化 UTF-8 字节计费的 3 MiB LRU；没有永久磁盘 Chunk 缓存。连续请求最多串行执行一个 miss，新请求淘汰过期排队生成，释放递增序列并清空 LRU、规范源及 loader 引用。异步读完成后重新检查序列/释放状态；Worker 在 await 后再次核验当前会话，Main 的 worker/session/request 及 Renderer 的会话保护继续生效。串行队列只保留 undefined 结果，避免在 LRU 之外强引用最后一个解析 Chunk。

首次解析仍使用既有 ReplaySession 生成完整 metadata 与临时 Chunk，以维持原能力准入及原切块结果；保存 projection 后清掉其全场 Chunk Map，切换到有界派生会话。刚导入会话保留小型 projection 上下文，避免提交重命名后继续引用 staging 路径；离线重开按需读取目标回合文件。

满校验仍逐成员核对压缩/原始摘要、规范源及能力，并逐块再生验证全部永久 Chunk 字节和总预算；这些校验 Chunk 不进入会话缓存。恢复用 `loadLibraryArchive` 接收同一次满校验已还原的源，避免重复解码。仅校验用途的 `verifyLibraryArchive` 不保留 Match/Spatial；v2 校验期间保留生成所需的 Replay，用完整预检字节计数核对总预算，避免为计数再创建整场 JSON 字符串。

## 兼容、便携与比赛库操作

- 旧 v1 gzip 目录与旧 `.cs2a` 继续按原路径和摘要字段读取。普通打开、重复导入和导出不迁移、不重压缩、不重新分析旧档案，也不修改其不可变字节。
- `.cs2a` 的 magic、header 长度、流式 payload 布局及外层 schema 1 不变；`archiveSchemaVersion` 选择严格的 v1/v2 文件白名单。内外层版本、逐文件大小/压缩摘要与精确 inventory 必须一致。v2 导出保留已有压缩字节，导入解包到独占 staging 后执行完整校验。
- 新旧格式可以共存在 SQLite v3 比赛库。容量统计使用统一压缩字节访问器，包含 manifest 与全部新 projection/schema 开销；没有把 `.br` 大小登记到 `gzipBytes`。
- 普通重复导入保留原档及既有去重语义。仅用户明确重新分析才新建不可变归档代，并安全切换 `archive_key`。比赛 ID、原导入时间和“自己是谁”（包括 null）保留；报告、Replay、Heatmap 规范源及派生摘要更新。
- 提交前取消、错源、解析/I/O/事务失败保留旧记录与可用会话；提交后激活失败准确表示已保存但暂未打开。启动先确认可信指针，再清理孤儿；损坏指针不会误删该比赛的完好归档代。
- 目录/符号链接/硬链接防护、大小上限、原子写入、摘要校验、受信 IPC 与损坏隔离继续使用原存储服务。实验不接触用户真实比赛库。

## 验证与复现

以下是**代码级独立复审**结果，运行于本机 Node 26.3.0；不能冒充捆绑 Electron 的生产性能或真实 DEM 完整验收。

| 验证 | 结果与范围 |
| --- | --- |
| archive v1/v2、tuple、portable v1/v2、Main、Worker、重新分析及进程中断 | 104/104 通过；独立复审第一轮 |
| tuple/optimization 内存修复后的回归 | 15/15 通过；截至 `a691553` |
| 额外固定构造对抗检查 | 40 组炸弹动作/同 tick 冲突/不规则事件 tick，9–28.5 KB 主动递归切块；逆序逐块比较，610/610 完整 Chunk JSON 字节一致 |
| 未计费解析 Chunk 强引用 | 复现后由 `a691553` 修复，独立确认清理前后串行队列结果均为 undefined |
| 校验峰值风险 | `7b1b6da` 减少规范源副本/保留及大字符串计数；实际进程峰值仍须实测 |

独立复审没有发现遗留阻断项。机器记录只保存结论与范围，不包含 DEM、原始 payload 或大体积实验日志。40 组对抗检查属于额外的一次性合成验证，生产回归以已提交测试为准。

```powershell
# 相关回归；不运行真实 DEM 性能测量。
node --test apps/desktop/tests/library-replay-codec.test.mjs apps/desktop/tests/library-optimization.test.mjs apps/desktop/tests/library-archive.test.mjs apps/desktop/tests/library-portable-v2.test.mjs apps/desktop/tests/library-portable.test.mjs apps/desktop/tests/local-library-reanalysis.test.mjs apps/desktop/tests/replay-worker.test.mjs apps/desktop/tests/library-main.test.mjs

pnpm --filter @cs2-analyst/desktop typecheck

# 串行真实样本工具，内部查找并启动实际捆绑 Electron runtime。
node scripts/library-storage-optimization-benchmark.mjs run demo1.dem demo2.dem dust2.dem nuke.dem
```

benchmark 使用同一次生产解析结果与能力生成两种格式，每格式至少三次串行保存和多次新进程打开/重开，逐块及 Heatmap 筛选结果严格比对。只允许上述四份本地白名单文件；不下载、不复制或提交 DEM。工具建立有所有权标记的隔离临时目录，使用独占结果文件，不写真实比赛库。不得通过 `--expose-gc` 或显式 GC 规避生产准入。

工具进程为捆绑 Electron 的 run-as-node；报告必须将其 RSS/JS heap/external/ArrayBuffer 与真正 GUI 的 Main、Utility、Renderer 测量区分。没有清理 OS 文件缓存：“新进程首次打开”不等于冷磁盘；严格等价比较本身的 JSON/SHA 时间也不能算进生产打开延迟。首次 DEM 解析/报告时间与多次保存时间分别记录，不能把一次解析声称为多次独立导入。

## 待补充实测及未验证边界

**性能结果表待主任务完成实测后填写。** 当前不引用历史容量作为本次基线，不将约 47.6%–50.5% 的调查理论节省写为实际收益。

每份 DEM 需要补充新旧实际总字节/分项字节、零持久 Chunk 缓存、保存耗时、新进程/重复打开、hit/miss seek p50/p95、实际三类桌面进程的工作集/RSS、heap、原生/Buffer 说明、连续 seek/切换/释放峰值及回落，并解释相对理论估计的差异。明显延迟或内存退化需要先诊断修复。

独立代码复审没有执行安装版 UI、四份真实 DEM 的全部性能与功能矩阵、磁盘硬件掉电、跨显示器 DPI 或未来未知应用版本的完整互操作测试；不能从已通过的合成/进程中断测试推断这些边界已通过。未来变更固定存储解码器时必须保留旧分支与逐字节回归，不能只更新编码标签。

本次不创建 release、不修改应用版本、不启动 P8、不推送。
