# L0 — 容量与离线恢复实验

> 实验执行：2026-10-21 至 2026-10-22（Asia/Shanghai）。**阶段状态：PASS（2026-10-22 总线独立审核通过），允许 L1 READY。** 受审包 `481cf79ff88c025ac6edc58207001c1a01bb30bb`，集成提交 `b2f887706604de77b023b2b33ff80dd1130bc92a`。
>
> 机器数据：[match-library-size-benchmark.json](./match-library-size-benchmark.json)。需求依据：[阶段计划](./match-library-plan.md)、[存储设计](./match-library-storage.md)、[导航设计](./match-library-navigation.md)、[白名单](./demo-fixtures.md)。仅新增实验、测试与文档，未实现正式比赛库、修改生产解析/统计/六视图、版本号或启动 P8。

## 1. 结论及证据边界

候选 A（完整 `Match + MatchReplay + MatchSpatialEvidence`）足以重建现有热力图筛选；完整报告及全部独立压缩 Replay Chunk 可从本机快照恢复。两份真实 DEM 的六个原视图在原 DEM 移走、捕获进程退出、新 Electron/Utility 会话且网络禁用的条件下实际运行，通过报告指纹、原始 tick、道具窗口和热力图投影校验。

这一结论来自**实验 host 桥接原生产 Renderer/preload/HeatmapSession**。它证明数据保存方案的可行性，不代表正式 L1 持久事务、L2 生产 IPC 安全与生命周期、L3 `.cs2a`、L4 导航或 L5 安装包已完成。实验桥接不进入 `electron.vite.config.ts`，不随生产应用发布。

建议总线将 **A + 独立 gzip level 6 文件 + SQLite 轻索引**作为 L1 候选基线。B（精简规范源）没有完成等价证明，不能替代 A。Brotli quality 4 在本次观测中更小且编码更快，独立文件随机读也通过；完整冷恢复链路目前实际保存的是 gzip，若采用 Brotli，应在 L1 对完整 writer/reader 另做同等级 round-trip，不能将候选总字节当作已落盘完整 Brotli 归档。

## 2. 输入、版本与组织

| 本机白名单样本 | 字节 | SHA-256 |
|---|---:|---|
| `.demo/dust2.dem` | 557650967 | `db90fe85aab023a1d2c8a5996182e6120d98ef494f02a070b17982b235e4958c` |
| `.demo/nuke.dem` | 471606780 | `dea9382b9cc263fed9ee4ed7e71fa6be8c176cf888868f05b26d850af6f5cb3c` |

真实比赛数始终是 **2**。10 份隔离归档副本和 1000 行合成目录均为模拟规模。未下载、替换、复制或提交 DEM；实验仅在原 `.demo` 中同盘 rename 到本轮唯一目录，`finally` 原位恢复并再次核对 SHA。Train、`demo3.dem` 和比赛名 DEM 未运行；工具拒绝它们。

- 生产源码基线：`43bbd98fe42adafd501aca6e30af8c253e770e85`；首次数据测量时 Git HEAD 为 `9dae48b8c99df0d69b2c845a2b4d117d6c324f05`，当时测量工具尚未提交，生产代码未变化。
- Windows `10.0.26200` x64；i7-13620H，16 逻辑 CPU，34141691904B RAM。Node 数据实验 `26.3.0`；真实 Electron `44.5.1` / Node `24.21.0` / SQLite `3.53.4`，不能混用 Node26 自带 SQLite 的版本。
- Parser `0.42.0-backport.363.1`，固定 native binding SHA `132d664125b60542dc80dc8bc270e2c8e181a0a55433fdac5be285ef4d9b0de1`；报告 schema 2、Replay Chunk schema 1。
- L0 Lead 负责规范数据/编解码/冷恢复；执行子 Agent `/root/l0_lead/sqlite_executor` 负责 SQLite、实际 Electron 六视图和合成目录。完整上下文继承模型/思考强度，未指定不同配置；环境未公开精确模型标识/effort 数值。所有跨阶段事项经总线，解析与安装共享资源未并行争用。

## 3. 实测容量与编解码

所有数字为 UTF-8 JSON 或实际压缩文件字节，不是 DEM 大小推算。规范源中 Replay 与供 UI 消费的 Chunk 有冗余，A 有意保留完整证据以避免改变 P7 口径。

| 样本 / 组成 | JSON bytes | gzip-6 bytes | Brotli-4 bytes |
|---|---:|---:|---:|
| Dust2 完整报告 | 366092 | 28782 | 26868 |
| Dust2 Match | 1027422 | 89179 | 84497 |
| Dust2 MatchReplay | 62157994 | 6225825 | 5580897 |
| Dust2 Spatial | 74993725 | 4319038 | 3601515 |
| Dust2 全部 159 Chunk | 37158066 | 6201607 | 5889869 |
| **Dust2 载荷合计** | **175703299** | **16864431** | **15183646** |
| Nuke 完整报告 | 264661 | 22251 | 21348 |
| Nuke Match | 800270 | 64075 | 60097 |
| Nuke MatchReplay | 51500063 | 4394723 | 3919084 |
| Nuke Spatial | 60748853 | 3096581 | 2599649 |
| Nuke 全部 141 Chunk | 29826961 | 4447789 | 4245259 |
| **Nuke 载荷合计** | **143140808** | **12025419** | **10845437** |

实验 manifest 含大量 oracle/sample 描述，Dust2 766033B、Nuke 727235B。计入它的**实际 gzip 目录快照逻辑字节**分别为 **17630464B / 12752654B**，共 164 / 146 文件。日志、恢复结果 JSON、NTFS 目录/簇分配开销不在此数中；没有便携容器，故没有虚构 `.cs2a` 容器开销或真实物理簇占用。Brotli 只有候选载荷总量，不能加上 gzip manifest 宣称完整可用 Brotli 档案。

两份样本的编码耗时逐组件求和：gzip **1159.185 / 909.117ms**，Brotli **826.890 / 621.880ms**。这不是包含序列化、校验、fsync 和目录提交的生产写入时延。原实验同时比较两 codec、解压核对并写 gzip 文件的增量合计为 **3543.000 / 2806.440ms**；每文件 CPU 字段包含该 codec 的编码与验证解码。

另一个单 codec 实验实际写入所有 Chunk：Dust2 gzip 编码/文件写入 **397.366 / 43.279ms**，Brotli **256.628 / 42.417ms**；Nuke 分别 **301.451 / 39.621ms** 和 **196.135 / 35.137ms**。这只是 Replay Chunk 写入，不是完整归档、fsync/断电持久性或 Electron 首次导入指标。

每块均独立压缩并逐字节 round-trip；最大无临时 sessionId Chunk 为 Dust2 **384305B**、Nuke **369522B**。原 production Replay 缓存（含当次 UUID）为 **37166175B / 29834152B**，仍小于既有 64MiB，单块不超 1MiB。临时 UUID 使原 production 缓存与移除 sessionId 的存储字节略有不同，不能混成 schema 回归。

这些是两份样本的观测，**不是所有比赛的 10–30MB 保证或固定配额**。

## 4. 冷恢复、随机读与完整性

捕获进程完全退出后，两个原 DEM 路径物理不存在；独立 Node 恢复进程只接收原位置和快照路径，不知道移走后的 DEM 路径。报告完整 hash（剔除瞬时 sessionId）分别为：

- Dust2：`e071bfa72302b05b955018158614dc90494ca9d769b3873497efc8bb5771f748`
- Nuke：`be4cf411262e7380d0890bb1fbc314636f072e0a30f5a2554b1007e6f9f643d8`

| 指标 | Dust2 | Nuke |
|---|---:|---:|
| 原始快照冷进程随机 Chunk 读数 | 128 | 128 |
| 读文件+摘要+解压+JSON p95 | 2.538ms | 2.405ms |
| 报告读取含模块初始化 | 76.732ms | 77.297ms |
| 全规范热力图源加载 | 716.845ms | 574.867ms |
| 全筛选维度组合 hash 等价 | 327 | 426 |
| 单次热力图投影 p95 | 26.658ms | 23.717ms |
| 最大实测单层响应 | 353901B | 309561B |

筛选矩阵覆盖三图层、16/32/64、all-valid/uniform-8hz、CT/T/all、冻结时间开关、所有现有楼层、每名玩家、每回合、空选择及组合选择；保留 coverage、未知观测与楼层等整个响应的 hash。不是默认 32×32 网格存档；也不声称穷举所有玩家/回合集合的数学幂集。

10 份隔离快照目录（两场各 5 份）逐个新进程重开，共额外 **1280 次随机读、3765 次投影 hash**；加原始两场共 **1536 次随机读、4518 次投影 hash**。每次随机读含原始 tick/player tuple 对照；随机抽样有放回，不声称 1536 个不同 Chunk。10 次完整实验矩阵耗时 3736.859–4850.839ms，其中包含数百次投影，不是历史报告首屏耗时。

复审后新增的只读 `library-spike-verify-snapshots.mjs` 又实际读取并有界解压全部 **308 个载荷文件**，核对压缩/raw SHA；**159+141=300 个 Replay Chunk**逐块比对身份、完整 JSON hash 及原始 tick 样本全部通过（614.766 / 468.230ms）。这项不访问 DEM，独立于先前的冷随机矩阵。`fdfe921` 在原 restore 工具追加的全块计数和序列化/写耗时分项未重新跑，未补写旧测量结果或冒充新增指标已执行。

独立磁盘 codec 对照每场每 codec 128 次读，gzip/Brotli p95 分别为 Dust2 **2.755 / 2.603ms**、Nuke **2.040 / 2.354ms**。OS 缓存未清空，以上是新进程/文件独立访问测量，**不是冷物理磁盘 p95**，不同探针的分位数不作硬性能趋势结论。

## 5. 真正 Electron 六视图实验

最终有效记录为 `.tmp/l0/offline-electron-final-4/acceptance.json`。新 Electron 与 Utility 从 gzip 快照恢复，使用原生产 Renderer、原 preload 和原 HeatmapSession；无强制 GC，网络禁用，没有调用 Parser。六视图不重新计算 Analytics/Findings。

| 项目 | Dust2 | Nuke |
|---|---:|---:|
| 点击实验导入至报告成功 | 863.969ms | 683.358ms |
| 原六视图渲染 | 6/6 | 6/6 |
| 切换其他玩家并遍历六视图 | 2 名 | 2 名 |
| Replay 原 tick seek / 必需 effect | 3 / 7 | 3 / 7 |
| Heatmap preload 请求及完整 hash | 12 | 12 |
| UI 筛选响应完整 hash | 3 | 3 |
| Utility 准入前 heapUsed | 100177372B | 84403220B |
| Utility 准入后 heapUsed | 106205836B | 113961488B |
| 退出前观察到的 Utility OS peak working set | 493551616B | 438042624B |

七类 effect 强制要求真实非空来源和实际可见窗口：smoke、fire、flashbang、hegrenade、飞行轨迹、blind、burn；空循环不能通过。还验证真实动画时钟推进。UI 分辨率 64、CT、uniform-8hz 依次等待原组件的**实际投影返回**，再与原矩阵响应 hash 对照，不只比较控件 value。每场使用新 UUID，应用实际退出且 owned 进程清理通过。最终 12 张 PNG 的路径、尺寸、字节和 SHA 已列入机器摘要；截图未全部人工逐像素检查。

Node26 数据实验首次在压缩前、严格 `parse → report → ReplaySession → HeatmapSession` 顺序下触发生产 512MiB 总 heap 准入失败，原 stderr 386B 保存于 `.tmp/l0/initial-capture-memory-admission.log`。没有记录当时具体 heap 数，不能倒填。第二跑在该点显式 GC，前/后内存已记录；这是一项测量器对照，不是修改生产准入。捕获实验生命周期 peak RSS 为 Dust2 **1677612KiB**、Nuke **1360548KiB**，包含 native parse、序列化、两 codec 及全矩阵，不能称生产 Utility 峰值。真正 Electron 恢复无 GC 即通过，仍不能由此保证所有未来比赛不会超预算。

Node 实验 parse/report/session 路径耗时 8398.543 / 7568.897ms（含实验 GC），旧原始字段曾命名 `existingProductionImportMs`，摘要明确改为 `experimentalPipelineMs`。**没有将它当作实际 Electron 新 DEM 首导、安装版或生产归档写入目标达成证据。**

## 6. SQLite、目录及失败行为

真实 Electron Main 与 Utility 的文件 DB、WAL、`synchronous=FULL`、显式 commit/rollback、主键拒绝、关闭重开均通过。终止持有未提交事务的 Utility 后，重开 `integrity_check=ok`，仅已提交行保留。第一次即时重开出现 Windows `disk I/O error`；成功复验中也曾重现，约 **52.34ms** 有界重试后恢复。总线独立复验再次约 **52.86ms** 重现。最终一轮无竞态并不否定先前失败。

因此 L1 必须关闭失败连接、在明确上限内重开并保留诊断，不能把 Utility 的 exit 事件当作所有文件句柄已释放，也不能无限重试或吞掉真实损坏。1ms 强制超时的预期失败测试已保存 `resultMissing`、stdout/stderr、timedOut、退出码及 `remainingOwnedProcesses=[]`，不会用 ENOENT 掩盖原启动错误。这里只是进程终止，未做物理断电或 NSIS 安装验证。

目录轻摘要实验单独生成 **10 / 1000 行合成 SQLite**，每档 20 个新 Electron Main 进程，索引排序并 `LIMIT 50`，所有场景不存在任何 archive/payload/DEM 文件仍成功。

| 合成行数 | DB bytes | 返回行 / JSON bytes | SQL 首屏 p95 | open→首屏 p95 | 进程启动→退出 p95 |
|---|---:|---:|---:|---:|---:|
| 10 | 16384 | 10 / 3376 | 0.0935ms | 1.3407ms | 164.6396ms |
| 1000 | 487424 | 50 / 16976 | 0.1432ms | 1.3544ms | 162.2142ms |

分位采用 nearest-rank empirical p95。OS 缓存未清空，只有合成目录查询，没有正式 L1 IPC/Renderer 首屏；不称 1000 场真实比赛性能验收。最终记录 `.tmp/l0/catalogue-probe-final.json`。

实际 Windows 文件锁实验还验证：中断 staging 文件被校验拒绝；删除锁定文件为 `EBUSY`、替换为 `EPERM`，释放锁后原有效快照与源摘要均保持。这不代替 L1 的索引/目录事务崩溃一致性和 ENOSPC/EACCES/取消测试。

## 7. 初次失败与复审修复

原始证据保留，不将修复后的成功覆盖成“从未失败”：

| 记录 | 实际情况 / 修复 |
|---|---|
| `initial-capture-memory-admission.log` | Node26 生产 heap 准入失败；后续显式 GC 仅实验对照，真正 Electron 无 GC 另证 |
| `sqlite-run-bmXGQY/result.json` | 即时重开 `disk I/O error`；关闭失败连接、有界重试，失败与延迟均保留 |
| `offline-electron/acceptance.json` | 隐藏窗口没有 compositor 截图，CDP 超时；使用不激活窗口的 showInactive |
| `offline-electron-final/acceptance.json` | 测试探针昵称空格不匹配；仅探针双侧 trim |
| `offline-electron-final-3/acceptance.json` | 增强探针误读 projection 根级 resolution；改读实际 grid resolution |
| `sqlite-probe-forced-timeout.json` | 受控 1ms 超时，预期 exit1；故障证据完整、进程零残留 |

独立复审早审还修复了 `flash/he` 错误枚举（实际 `flashbang/hegrenade`），并要求七类必需 effect 集合非空；工具拒绝 Train，显式 GC 必须真实可用，否则立即失败；重跑输出目录不允许覆盖历史证据。最终 Electron 全套重新执行后通过。摘要编制曾因 desktop 不是 native 包直接依赖而模块解析失败，已改为明确包路径；未改写任何源测量，最终摘要两次生成字节相同。

## 8. 候选契约与 L1 约束

1. SQLite 仅保存轻摘要、版本、状态、路径引用和事务；列表不得读取报告、Replay 或热力图大源。Electron 内置 `node:sqlite` 已在真实 Main/Utility 可用，第三方 native SQLite 目前无必要；生产/NSIS 仍需 L1/L5 实测。
2. Windows `LOCALAPPDATA / CS2 Analyst / MatchLibrary` 为目标；L0 不创建用户真实比赛库、不改变现有 `userData` 和上次目录偏好。L1 必须核验路径来源、realpath、目录边界与 symlink，不能直接相信 Renderer/manifest 的路径或 SQL。
3. 归档保留已分析报告、全部独立 Chunk 和候选 A 规范源，移除临时 sessionId、绝对 DEM 路径和公共图片；记录组件/算法/Parser/采样/资源版本，打开时新建可信 UUID。不得暗中重跑基础分析覆盖历史结论。
4. 实验大小不是普遍最大值。L1 需确定压缩/解压/文件数及总量边界，超预算明确失败或保留原能力的降级语义；不能放宽既有 1MiB Chunk、64MiB Replay、512KiB Heatmap 响应与 512MiB heap 准入。不要同时保留所有 codec 缓冲或批量解压全库。
5. staging 完整写入、校验、目录提交和 SQLite 事务必须由 L1 证明；失败/取消不得报告导入成功或污染旧记录。SHA 去重，不能按 basename 合并。进程终止后的 Windows 句柄释放窗口必须有界处理。
6. 当前候选快照不是生产安全归档格式，不允许将实验 JSON reader 接到不受信文件。`.cs2a` 路径/压缩炸弹/版本/摘要防御与隐私提示留在 L3 正式实现。

## 9. 验证命令与可复现入口

全部在 L0 独立 worktree 执行，DEM 使用主 worktree 的绝对原路径。依赖 `pnpm install --frozen-lockfile`，native 复用同一个已验证本机 binding，不复制 DEM。首次 `pnpm build` 8/8（其中 6 cached）仅用于准备；`TURBO_FORCE=true pnpm typecheck` **15/15，0 cached**。L0 生产源码零差异，不以该准备构建冒充 L5 全量生产构建。

```powershell
node --test scripts/library-spike.test.mjs
# 5 passed / 0 failed / 0 skipped；还验证无 --expose-gc 和覆盖旧证据均被拒绝。

# 数据实验：新空目录，内部串行真实解析、finally 还原 DEM。
node --expose-gc scripts/library-storage-spike.mjs run E:/cs2-analyst/.demo .tmp/l0/new-storage-run

node scripts/library-sqlite-probe.mjs .tmp/l0/new-sqlite.json
node scripts/library-catalogue-probe.mjs .tmp/l0/new-catalogue.json
node scripts/library-spike-codec-reads.mjs .tmp/l0/evidence .tmp/l0/new-codec-run
node scripts/library-spike-faults.mjs .tmp/l0/evidence/dust2
node scripts/library-spike-verify-snapshots.mjs .tmp/l0/evidence .tmp/l0/new-full-verification.json
node scripts/library-offline-electron.mjs .tmp/l0/evidence E:/cs2-analyst/.demo .tmp/l0/new-offline-electron

# 从已完成的本机证据生成公开摘要，不重新解析 DEM：
node scripts/library-spike-summary.mjs .tmp/l0/evidence/benchmark.json .tmp/l0/sqlite-probe-lifecycle-verified.json .tmp/l0/offline-electron-final-4/acceptance.json .tmp/l0/codec-reads-1792597077256/result.json .tmp/l0/faults-9Wg9bY/result.json .tmp/l0/full-snapshot-verification.json .tmp/l0/catalogue-probe-final.json docs/match-library-size-benchmark.json
```

首次捕获脚本的旧测量有效保留；当前工具比当时多了守卫和探针，摘要 `provenance` 明确标记差异。完整快照、日志、截图和失败文件只在 ignored `.tmp/l0`；机器摘要记录其字节/SHA，不提交原始玩家证据/SteamID。摘要重生成到独立文件后字节比较通过，5 项纯测试、脚本语法与 `git diff --check` 通过。实际 Electron 场景组、SQLite 场景和 Node 5 项测试分别计数，不混成虚假测试总数。

实现提交：`9dae48b` SQLite；`7d1352c` 数据实验；`5651c16` 守卫测试；`952103a` Electron 六视图及 probe 修复；`fdfe921` 后续全块/写成本探针；`6b6eb1b` 合成目录。摘要与本报告所在提交由 Gate Package 给出，避免自引用 SHA。

## 10. 未执行及保留风险

- 正式 catalogue/归档事务、取消/重复导入/磁盘满/权限错误、symlink 安全、`.cs2a` 及全部 L1–L5 产品路径尚未执行，不能拿实验文件锁或 codec 损坏测试替代。
- 实际生产大库 Renderer 首屏、安装后冷启动、NSIS SQLite ABI/资源隔离、安装/重启/卸载/用户档案保留均 **NOT RUN**。LocalAppData 策略是建议，未更改用户目录。
- 真实 Electron 首次 DEM 导入及正式归档增量 fsync 写入耗时未测；只有上列严格归类的实验指标。10 隔离副本和 1000 合成目录不是多场真实比赛基准。
- P7 独立 Replay 查询 **5131.302ms > 5000ms** 的既有债务原样保留；本次归档重开快不表示首次查询债已解决。
- 地图/DEM 版本匹配仍 `unconfirmed`；真实 Vertigo、正式窗口内真实全员阵亡 UI、原生 chooser、Narrator/NVDA、系统高对比度、物理跨屏 DPI 等 P7 未覆盖项未被追认 PASS。素材分发许可也未因归档解决。
- 人工 walkthrough、标题栏几何/导航、生产系统安装验证均留待各阶段；P8 没有启动。

**Gate 决定：PASS。** 未参与 L0 实现的独立 Reviewer `/root/l3_lead` 核对 45 个 artifact 的字节/SHA、12 PNG 尺寸及原始场景；复核 308 个载荷、300 Replay 块与 1540 个隔离副本文件。总线另检查源码、原始报告/截图、实际复跑 SQLite 探针和集成后 5/5 纯测试；未发现剩余阻断。所有上述证据限制和 P7 债务保留。总线放行 L1，正式事务、路径安全、取消/故障及 NSIS 兼容性必须由后续阶段实际证明。
