# 分析归档无损存储优化：v2 格式与验证

后续内存排查：[Renderer 长循环与资源释放修复](./renderer-memory-lifecycle.md)、[完整机器证据](./renderer-memory-lifecycle-measurements.json)。原 31.7 MB 单点保留为历史观测；新长测未发现其为持续累积的 IPC 业务对象强根，并另外确认、修复了真实 UI 的图片/canvas 清理问题。工作集仍有波动，不能把后续修复表述成所有内存差额已消除。

2026-10-25。起始 HEAD 为 `9318ed9`、工作区干净；以当前代码实施，没有回退分析算法或修改用户比赛库。四份真实 DEM 的容量、严格字节比较、24 次真实 GUI 打开/seek/释放、最终便携路径与原 DEM 重新分析均已完成。体积与加载改善，部分瞬时总工作集和释放后 Renderer 内存增加；下文保留这些成本，不宣称全部内存降低。

关联：[容量调查](./match-library-compression-audit.md)、[本地存储](./match-library-storage.md)、[便携格式](./match-library-portable-format.md)、[重新分析](./match-library-reanalysis.md)、[回放契约](./replay-contract.md)、[机器可读测量](./match-library-storage-optimization-measurements.json)、[独立复审](./match-library-storage-optimization-review.json)。

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

新导入保留的上下文是序列化 JSON 字符串 Map，不常驻整棵解析模板树，并与 LRU 共用原 **64 MiB 序列化会话上限**。实际 LRU 上限为 `min(3 MiB, 64 MiB - contextBytes)`；剩余空间容不下单块时正常返回该块但不缓存，不能靠加大预算保住命中率。释放同时清空上下文和 LRU。离线恢复没有这份全场常驻上下文。3 MiB 只描述块缓存，不能当作 Utility 总内存；完整规范源、临时解码数据和进程原生内存须分别测量。

满校验仍逐成员核对压缩/原始摘要、规范源及能力，并逐块再生验证全部永久 Chunk 字节和总预算；这些校验 Chunk 不进入会话缓存。恢复用 `loadLibraryArchive` 接收同一次满校验已还原的源，避免重复解码。仅校验用途的 `verifyLibraryArchive` 不保留 Match/Spatial；v2 校验期间保留生成所需的 Replay，用完整预检字节计数核对总预算，避免为计数再创建整场 JSON 字符串。

便携导入/导出满校验在一次性 `archive-verifier.js` Utility 中执行，Main 不长期承受完整 Replay 解码堆。私有 job UUID、预期 manifest hash 和小型字节/hash receipt 绑定请求与进程；Main 前后再次严格读取清单、核对 receipt，并等待真实退出后才报告成功。仍保留 Main 提交时的压缩成员校验、流式逐文件摘要和路径/链接保护，不信任仅由任意 IPC 发来的“校验成功”。取消/超时返回受控结果，但若退出尚未证实，保留临时目录、busy 状态及库锁并延后清理；退出与晚到 spawn 均有回收路径，关闭应用等待这些清理。取消发生在 chooser 排队到实际显示之间也不会弹出迟到窗口。

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
| 校验峰值风险 | `7b1b6da` 减少规范源副本/保留及大字符串计数，`0fe5b29` 提前释放仅校验源；最终 Main/Utility 实测见后文 |
| 项目 typecheck 与完整相关回归 | 根 `pnpm typecheck` 15 个 Turbo 任务通过；归档、codec、portable、库/重新分析、Main/Worker、Replay/follow/effects/store 与 Heatmap 191/191 通过 |
| 一次性校验器及 Main 生命周期 | 96/96 相关回归；最终 `a07174b` chooser 修复后 broker/Main 56/56 通过，桌面生产构建通过；这些集合有重叠，不能相加声称独立测试总数 |

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

## 实际容量与完整性

四份原白名单 DEM 各真实解析一次，相同报告、规范源和能力写入旧 v1 与新 v2，各格式三次串行保存；不是直接引用历史容量。十进制 MB，每份总数包含 manifest、tuple schema 和全部 projection。不同提交标识/分析版本说明使本次 v1 清单比旧调查略有不同，不影响同源对照。

| DEM | 回合 / 块 | v1 bytes | v2 bytes | 净减少 |
| --- | ---: | ---: | ---: | ---: |
| demo1 | 24 / 114 | 13,265,063 | 7,241,816 | 45.41% |
| demo2 | 18 / 85 | 8,949,130 | 4,766,736 | 46.74% |
| Dust2 | 24 / 159 | 16,910,149 | 8,899,575 | 47.37% |
| Nuke | 21 / 141 | 12,066,258 | 6,247,584 | 48.22% |
| **合计** | **87 / 499** | **51,190,600** | **27,155,711** | **46.95%** |

逐项 MB（v1 → v2）：

| 成员 | demo1 | demo2 | Dust2 | Nuke |
| --- | ---: | ---: | ---: | ---: |
| 完整报告 | .027617 → .021271 | .020834 → .015448 | .029593 → .022905 | .023034 → .017607 |
| Match | .080430 → .061359 | .049940 → .039143 | .089179 → .070205 | .064075 → .049220 |
| 完整规范 Replay | 4.356242 → 3.473760 | 3.120065 → 2.483962 | 6.225825 → 5.009892 | 4.394723 → 3.469670 |
| 完整 Spatial | 4.413486 → 3.356166 | 2.626081 → 2.038240 | 4.319038 → 3.342890 | 3.096581 → 2.394514 |
| UI Chunk → projection | 4.354338 → .318840 | 3.107015 → .181452 | 6.201607 → .443321 | 4.447789 → .307187 |
| manifest | .032950 → .010420 | .025195 → .008491 | .044907 → .010362 | .040056 → .009386 |

Projection 规范 JSON 分别为 2,321,282 / 1,391,989 / 2,888,304 / 2,140,996 bytes，压缩后即上表 .319 / .181 / .443 / .307 MB。它们是保留历史展示语义所需的实际档案内容，已计总数。额外持久化再生 Chunk 缓存为 **0 bytes**；SQLite/WAL 为共享目录索引，另外统计，不混入单场档案或称作压缩收益。

因此实际收益为 **45.41%–48.22%**，没有强凑调查的 47.6%–50.5%。理论假设没有为已投影文案/follow/效果/原切块目录及逐块摘要支付最终持久化成本；本实现选择显式保存这些小型上下文，换取未来版本的精确恢复。没有把取消持久化 Chunk 与 follow 去重重复计账。

真实样本验证：四份全部能力保持可用，499 块、1389 种 Heatmap 请求覆盖 16/32/64、全部玩家/回合、阵营、楼层、冻结时间、采样集和关键组合。报告、完整规范源、metadata 与全部块核对完整 JSON 长度/SHA；额外独立 Electron 进程逐项 **`Buffer.equals`** 直接比较 v1 解压字节与 v2 还原字节，四份 4 类数据、双 metadata、499 块全通过，只排除临时 sessionId，无浮点容差。每份两种 `.cs2a` 都完整导出/导入并离线重开，再核对全部块及筛选。

## 工具性能（辅助数据）

Electron **44.5.1 / Node 24.21.0**，Windows x64；同一台机器串行、每格式三轮。未清 OS 文件缓存、无显式 GC。以下是实际捆绑 Electron 的 **run-as-node 工具进程**，不能冒充 Main/Utility/Renderer；v1/v2 使用当前共同 reader，原 `9318ed9` worker 的重复源解码不作为历史速度对照。打开计时不包含完整 JSON/SHA 校验，校验另在独立流程执行。

| DEM | 保存 p50（v1 → v2，ms） | 新进程首开 p50（ms） | 同进程重开 p50（ms） | miss p95（ms） | v2 hit p50 / p95（ms） |
| --- | ---: | ---: | ---: | ---: | ---: |
| demo1 | 11,662 → 10,669 | 1,971 → 1,640 | 7,883 → 5,470 | 57.50 → 48.91 | .79 / 3.42 |
| demo2 | 8,187 → 7,242 | 1,419 → 1,135 | 5,539 → 3,822 | 52.63 → 11.97 | .62 / 1.12 |
| Dust2 | 14,810 → 12,622 | 2,777 → 1,870 | 9,783 → 6,460 | 56.15 → 51.25 | 1.39 / 4.22 |
| Nuke | 11,595 → 10,109 | 2,226 → 1,568 | 8,167 → 5,411 | 52.39 → 47.06 | .73 / 3.26 |

表中 seek 是**三轮各自分位数的中位数**，不是混合请求 pooled p95。保存/打开各仅 n=3，p95 就是三值最大值；完整 min/max/各轮数值见机器证据。v1 没有应用 Chunk LRU，立即重复仍读文件/解压，不能称为应用缓存命中。v2 实测块缓存峰都低于 3,145,728 bytes。

共同原 DEM 读取/身份检查/解析/报告阶段分别为约 18.3 / 6.6 / 25.4 / 19.1 秒，只执行一次，不伪称三次独立 DEM 导入；保存时间不包含人工选择身份，也不是含 UI/IPC 的端到端首次导入 SLA。原 Heatmap 512 MiB 准入均在指纹分配之前通过。

初版 v2 miss 曾有稳定尾延迟上升。独立 342 次完整块对照定位到 generic JSON replacer 和重复序列化；`2fcc707` 复用单次已验证字节后，恢复/摘要阶段 p95 从 20.28 降到 8.29 ms，正式四样本 miss 分布收敛，不增加缓存层或放宽防护。目录/链接/摘要检查保留，仍是部分 miss 的主要成本。JS heap 与 RSS/Buffer 变化方向不同，完整桌面内存按下节单列，不能只选其中一个指标宣称降低。

## 实际桌面打开、随机读取与内存

每 DEM、每格式 **3 次全新 GUI 进程**，共 24 次，全部 PASS。使用相同捆绑 Electron 44.5.1，完整 Main → Utility → Renderer IPC；时间在 Renderer 内包围真实 API 测量，不包含 CDP 传输和之后的完整 JSON/摘要分配。第一组数据来自内存/格式修复后的生产代码；最终仅便携路径变更为 `a07174b` 的一次性校验器，便携数据使用下面独立最终样本。各组源码 revision 与构建指纹分别保存在机器证据中，不能把不同构建标成同一次运行。

| DEM | 新进程打开 p50 / p95，ms（v1 → v2） | 同 Main 进程重开 p50 / p95，ms | 唯一块请求 p50 / p95，ms | 立即重复 p50 / p95，ms |
| --- | ---: | ---: | ---: | ---: |
| demo1 | 2716.6 / 3189.3 → 1926.1 / 1927.1 | 3243.4 / 3325.2 → 2480.9 / 2990.0 | 66.3 / 91.1 → 60.9 / 89.2 | 67.4 / 92.0 → 19.7 / 35.6 |
| demo2 | 1952.9 / 2135.8 → 1529.9 / 1690.5 | 2505.8 / 2565.1 → 2002.1 / 2013.2 | 62.5 / 91.7 → 34.4 / 77.9 | 61.3 / 88.1 → 18.8 / 26.5 |
| Dust2 | 4290.2 / 4291.9 → 2208.8 / 2210.7 | 5247.8 / 5941.5 → 2692.2 / 2799.5 | 71.3 / 93.2 → 66.5 / 93.1 | 71.4 / 87.4 → 20.6 / 35.2 |
| Nuke | 2919.6 / 3098.1 → 1859.5 / 1924.5 | 3350.3 / 3436.7 → 2448.4 / 2735.3 | 67.5 / 89.0 → 40.4 / 88.8 | 69.2 / 94.3 → 17.0 / 29.3 |

打开 n=3 的 p95 是最大值；GUI seek 是三轮原始请求合并后的经验分位数，区别于前节工具的“每轮分位数中位数”。每轮以独特目标逐个请求，再立即重复；v2 重复是应用 LRU 命中，v1 只有可能的 OS 文件缓存。块边界、反向/随机次序、回合切换、所有玩家与楼层、冻结及跨块道具窗口通过完整块字节比较和真实 Renderer API/metadata 状态检查。六个实际渲染视图的页面断言及截图覆盖 demo1 两种格式；其他样本的筛选/块组合主要通过真实 API 与完整数据核验。另测快速连续 seek、重开/切换后的旧 session 请求拒绝、释放后 Utility 实际消失，没有发布过期结果；24 次均通过。切换保留旧可用会话直至新会话就绪，会短暂同时有两个 Analysis Utility，必须计入总量。

下表是**本场首次打开、串行 seek、同进程重开**三个阶段、三轮的各角色最大观测值，十进制 MB；不包含另一场比赛或旧版便携实验的峰值。`RSS / heap` 的两个最大值未必来自同一时刻。Renderer 使用工作集与 CDP heap，Main/Utility 使用 Node RSS 与 heapUsed。

| DEM | Main RSS / heap，v1 → v2 | Analysis Utility RSS / heap，v1 → v2 | Utility external，v1 → v2 | Renderer WS / heap，v1 → v2 |
| --- | ---: | ---: | ---: | ---: |
| demo1 | 124.9 / 13.0 → 126.8 / 13.2 | 575.7 / 126.7 → 602.5 / 159.2 | 306.8 → 258.7 | 205.0 / 60.2 → 202.0 / 60.8 |
| demo2 | 122.2 / 8.7 → 119.1 / 8.5 | 435.3 / 94.6 → 440.7 / 122.6 | 199.2 → 155.0 | 184.7 / 44.6 → 183.6 / 44.3 |
| Dust2 | 117.4 / 8.9 → 117.4 / 8.8 | 579.2 / 133.3 → 432.3 / 175.2 | 300.6 → 156.0 | 183.5 / 47.6 → 184.6 / 47.5 |
| Nuke | 120.5 / 11.6 → 118.3 / 8.7 | 500.7 / 115.8 → 392.5 / 153.7 | 241.6 → 126.6 | 173.2 / 40.6 → 176.7 / 40.7 |

v2 源对象解码分配会提高 JS heap，Brotli/tuple 减少的 Buffer 可降低 external；demo1/demo2 的 Utility RSS 仍分别增加约 26.8/5.4 MB，不掩饰这种差异。Electron 本次 `memoryUsage().arrayBuffers` 观测为 0，不能据此断言没有 Buffer 或原生内存；external 含运行时外部分配，ArrayBuffer 也是其子集，不能相加。没有做完整 native allocator 归因，不能将 RSS 减 heap 直接称为精确原生用量。

按共同时间戳相加的 Main + Renderer + 全部 Analysis/Verification Utility 工作集峰值与释放情况如下。切换列涉及另一场比赛，不能标为本场规范数据独占成本。单位 MB，数值为三轮最高观测；释放列是释放后短空闲观测，Utility 已全部退出。

| DEM | 首开总 WS，v1 → v2 | seek 总 WS，v1 → v2 | 切换总 WS，v1 → v2 | 释放总 WS，v1 → v2 |
| --- | ---: | ---: | ---: | ---: |
| demo1 | 840.8 → 814.1 | 901.3 → 927.8 | 1309.7 → 1279.3 | 332.8 → 332.4 |
| demo2 | 663.1 → 609.4 | 733.2 → 690.6 | 1301.9 → 1311.9 | 298.2 → 304.6 |
| Dust2 | 861.1 → 719.1 | 873.7 → 724.3 | 1442.2 → 1289.4 | 298.2 → 300.4 |
| Nuke | 772.1 → 671.7 | 790.7 → 677.6 | 1365.4 → 1245.2 | 293.2 → 293.9 |

100 ms 被动观察可能遗漏阻塞期间的短 heap 峰值，另保留进程 lifetime maxRSS/工作集高水位。上述总和包括共享页，**不是 PSS/物理独占内存**，未把 GPU/network 等所有 Electron 辅助进程算作这三个业务角色。完整逐轮/逐阶段峰值及最后一次观测在机器证据中；没有显式 GC，未清理 OS 文件缓存，没有为测量放宽生产预算。

## 最终便携路径、重新分析与故障保护

真实 Main 的导出 → 删除 → 导入 → 离线重开逐场成功，混合 v1/v2 库、普通重复导入、保留 ID 与偏好、归档删除及目录恢复均有相关回归。为定位早期 Main 残留，保留了失败/旧构建原始实验，但**最终便携内存表只取 `a07174b` 构建**：前三场各格式 1 次、Nuke 各 3 次。不能把前三场单次数据称作三轮便携分布。Nuke 重复试验用于确认修复和波动；24 次打开/seek 是每场三轮，另行统计。

| DEM | Main 导出 p50，ms（v1 → v2） | Main 导入 p50，ms | 导入 Main RSS 峰，MB | 导入同刻总 WS，MB |
| --- | ---: | ---: | ---: | ---: |
| demo1（n=1/格式） | 5080.9 → 3087.3 | 10657.8 → 5515.8 | 118.0 → 115.6 | 887.1 → 926.9 |
| demo2（n=1/格式） | 3564.5 → 2446.5 | 8589.2 → 4020.2 | 114.4 → 112.0 | 694.6 → 748.1 |
| Dust2（n=1/格式） | 7681.3 → 3098.8 | 15720.2 → 5345.6 | 118.1 → 112.4 | 859.0 → 926.9 |
| Nuke（n=3/格式） | 5008.7 → 2794.9 | 13298.0 → 4732.5 | 115.5 → 112.9 | 812.5 → 848.2 |

Nuke Main RSS 列取三轮最大，其他列取各轮观测的中位数；其导出 p95 为 5301.1 → 2920.3 ms，导入 p95 为 13591.6 → 4907.6 ms。最终 Main 释放后为约 110.7–115.2 MB，Verifier 实际退出且 WS=0，修复了早期同样路径数百 MB 滞留。一次性 Utility 的峰值并未消失：Nuke 导入 Verification Utility 工作集三轮分别为 v1 535.1/539.2/524.6 MB、v2 557.9/571.9/561.6 MB，已经计入同刻总量。

最终导入总 WS 中位数 v2 增加约 **4.4%–7.9%**。三轮 Nuke 释放后的 Renderer 为 v1 121.9–123.1 MB（heap 约 8.6 MB），v2 176.9–179.5 MB（heap 37.8–44.2 MB）。QA 的完整 JSON/TextEncoder/crypto 指纹也会分配 Renderer heap，所以增加各格式一次**不计算这些指纹**的独立 Nuke 对照；原完整性/性能样本仍保留。该对照 seek Renderer WS 为 165.9 → 148.6 MB，便携流程释放后为 **125.9 → 157.6 MB**（heap **7.9 → 33.2 MB**）。因此 QA 分配能解释一部分，却不能解释全部约 **31.7 MB** 的释放后差异；没有通过强制 GC 或内存压力测试把它抹掉。已核对生命周期与强引用边界，业务 Utility 均已退出，当前证据不足以将这部分全部归为泄漏或全部归为可回收内存；将其记录为剩余内存成本，长期压力/自然 GC 回落尚未验证。

共享 SQLite/WAL 索引在四场完整库初始化时约 102,600 bytes，便携删除/恢复后约 172,640 bytes；这是整个隔离库的索引开销，不是单场持久缓存。再生 Chunk 磁盘缓存始终为 0 bytes。测量从未修改用户真实比赛库。

四份**原始路径 DEM** 经实际原生解析器和 UI 重新分析：demo1/demo2 从 v1 更新到 v2，Dust2/Nuke 从 v2 更新到新 v2 代；两场 self=null、两场保留选定玩家。所有 ID、importedAt、self 不变，archive_key 更新，旧代安全清理；源文件前后 SHA-256 一致。新报告/完整规范源/双 metadata 字节等价，重开后 499 块、1389 过滤请求再次一致。

| DEM | 端到端重新分析，s | Main RSS / heap，MB | Analysis Utility 单进程 RSS / heap，MB | Renderer WS / heap，MB | 同刻总 WS 峰，MB |
| --- | ---: | ---: | ---: | ---: | ---: |
| demo1 | 51.62 | 119.0 / 9.0 | 1159.7 / 457.9 | 140.2 / 21.1 | 1904.3 |
| demo2 | 31.97 | 118.8 / 8.9 | 659.8 / 195.5 | 152.9 / 27.4 | 1298.8 |
| Dust2 | 56.76 | 120.2 / 8.7 | 1548.0 / 524.9 | 137.0 / 22.2 | 2326.7 |
| Nuke | 44.35 | 117.7 / 8.5 | 1201.0 / 369.7 | 152.0 / 22.9 | 1973.3 |

重新分析含真实解析、保存和激活；为提交前失败仍能继续看旧比赛，峰值包括保留旧可用会话。Dust2 heap 524.9 十进制 MB 低于原 512 MiB（536.9 MB）准入，没有强制 GC。每份只重新解析一次，不能作为多轮尾延迟 SLA；Utility external 分别约 537.0/261.8/850.5/573.6 MB，详细样本与阶段见机器记录。

损坏/截断/解压与展开超限、路径/链接/摘要篡改、未知/混合编码、取消、错误 DEM、I/O/事务失败、提交后激活失败、进程退出/中断及损坏指针的回归均通过。测试同时检查提交前旧记录/可用会话与提交后“已保存但暂未打开”语义。一次性 Verifier 的错 receipt/重复 receipt/崩溃/晚 spawn/未确认退出/超时取消均有专门测试，不以误删临时目录或提前解锁规避。

## 复现工具与未验证边界

工具入口均在 `scripts/`，只写带所有权标记的隔离临时目录：

- `library-storage-optimization-benchmark.mjs`：四份同源格式对照、串行保存/工具打开/seek、全部块/Heatmap 与 `.cs2a`；
- `library-storage-byte-equivalence.mjs`：额外直接 `Buffer.equals`，不只对摘要；
- `library-storage-electron-qa.mjs`：真实 GUI API、会话/快速 seek/页面状态及进程观察；
- `library-storage-reanalysis-qa.mjs`：现有白名单源 DEM 的真实原生重新分析与离线验证；
- `library-storage-optimization-summary.mjs`：只读取已完成证据，生成可提交的机器摘要；要求提供最终 one-shot portable 数据，防止误用旧实验。完整原始日志/截图/档案不提交，原始输入路径、revision、构建摘要和统计口径保留在摘要。

脚本实际名称/参数以文件内 usage 为准。原生 chooser 由隔离测试 shim 注入既定本地路径，没有手工点击安装版选择器；未测试打包 NSIS 安装界面。磁盘硬件掉电、跨显示器 DPI、未知未来应用完整互操作、完全清空 OS 文件缓存的冷盘性能及长时间内存压力/自然 GC 回落不在本次范围。进程中断不等于硬件断电；未来变更固定存储解码器必须保留旧分支及逐字节回归，不能只更新编码标签。

本次不创建 release、不修改应用版本、不启动 P8、不推送。具体实现提交及后续证据/复审提交可从 `9318ed9..HEAD` 的聚焦提交查看；生产最终修复为 `a07174b`，测量工具后续提交不修改生产构建。
