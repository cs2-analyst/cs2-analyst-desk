# Renderer 释放后内存：Nuke 长循环排查

2026-10-25。起点 `a15b16a`，工作区干净。追踪[上一轮归档优化](./match-library-storage-optimization.md)中 Nuke 无指纹对照释放后 Renderer WS 多约 31.7 MB、heap 多约 25.3 MB 的单次观测。历史数据保持不变。本轮复用其真实 DEM 生成的 v1/v2 归档，只在新建的有所有权标记的临时库/profile 中测试；没有读取、复制、重命名或下载 DEM，没有访问用户比赛库。

## 方法与边界

排查基线的 Main、preload、Renderer、Utility 与上一轮最终 `a07174b` 构建相同；两组基线逐文件核对 98 个生产文件。随后修复的生产代码只涉及 Replay 图片/canvas 生命周期，分别记录新构建；没有调整缓存、IPC、Heatmap、解压或内存预算。`c25928d` 增加诊断入口 `$soak`，`3691a5a` 补强 UI 缓存释放探针。记录各组 QA 源码 SHA、完整生产构建摘要、版本及原始结果位置；每份库用同一个捆绑 Electron 可执行文件建立，runtime 版本由 `seed-v1/v2.json` 的 `process.versions` 留证：Electron 44.5.1 / Node 24.21.0。

每个新进程先复现原来的无指纹流程：打开 Nuke、按回合/块边界请求并立即重复、同比赛重开、切换 demo1、并发 seek 后释放、Main 导出/删除/导入、离线重开再释放。随后在**同一个 Renderer、同一 CDP 会话**中重复打开 → seek → 切换 → 释放；没有通过重载页面或重启 Renderer 清理轮次间的内存。GUI 进程只在整组结束后退出。格式试验串行执行，三轮顺序交替为 v1/v2、v2/v1、v1/v2。

引用探针仅保存 WeakRef、类别和出生轮次，目标包括直接 IPC 的 report、players 数组、Chunk、frames 数组。实际 UI 另从 `HostRoot.stateNode.current` 的当前 Fiber 树弱登记 report/players，并核对新比赛 ID，避免把 alternate 树当成当前结果；限定当前 Replay 组件，弱登记其真实缓存及最后一次成功 seek 后保留的 1–3 个 Chunk/frames。Fiber 遍历的 Set 仅为同步 job 局部变量，返回的是计数与 ID。探针从不保存目标到后续 job；它有少量自身分配，因此这组数据用于引用诊断和趋势，不能无标注地替换原无探针的绝对性能数据。

每轮记录刚释放及空闲后的 heap、DOM/监听器数、弱引用计数。Main 每 100 ms 记录 OS 工作集和业务 Utility 生命周期；Renderer 观察阶段每 100 ms 取 heap。终点先观察 30 秒，再停止 Renderer CDP 轮询 30 秒，之后仅取一次终末样本；Main 的 OS 观察继续。后者单列为 quiet 对照，避免把持续调试请求下的 idle 等同完全无 Renderer 调试流量。截图单独划阶段，不污染终末 idle 统计。

没有 `--expose-gc`、显式 GC、heap snapshot、`queryObjects`、内存压力信号、巨大填充数组或 OS 工作集清理。弱引用失效能证明相应对象已经回收；弱引用尚可解析而未经历自然 GC，不能证明存在强引用。WS、JS heap、embedder/backing storage 分别记录；工作集含共享页，不能当作 PSS 或精确 native allocator 分解。

实际 UI 循环先打开 demo1、再打开 Nuke，进入 Replay，使用可信 End/Home 键 seek，等待画布 tick 与目标 tick 一致、无错误且块缓存最多 3 项；进入 Heatmap 后等待实际 resolution 已应用且更新结束，再返回列表并确认组件卸载。若弱引用仍能解析缓存，直接检查其 entries 已为空；若缓存已经消失，则只声称它已回收，不声称观察到了 clear 调用。等待普通 passive effect 清理，避免把 DOM commit 前后短暂时序误判为泄漏。每轮释放及两个终末 idle 阶段均要求全部 Analysis/Verification Utility 已退出。

IPC 组每轮最后释放 demo1；UI 组每轮最后释放 Nuke，终末 idle 之前不再打开其他比赛。两组 QA 源码及末态协议不同，分别留证；跨组末值不能直接解释为“UI 增量”。每组内部 v1/v2 使用完全相同的业务操作和 QA 源码，生产构建在两组间逐文件一致。

## 可复现命令

在已有四份真实样本的 benchmark/GUI 配置上运行；工具会建立新临时库、profile、观察版应用副本和结果，不修改输入证据。先构建应用；一组比较期间保持同一生产构建和 QA 脚本，避免并行运行构建、测试或另一个测量进程。

```powershell
node scripts/library-storage-electron-qa.mjs '$soak' '<已有 gui-run.json>' nuke.dem 3 8 5000 60000 0
node scripts/library-storage-electron-qa.mjs '$soak' '<已有 gui-run.json>' nuke.dem 1 8 5000 60000 1 1
node scripts/renderer-image-lifetime-diagnostic.mjs '<已有 gui-run.json>'
node scripts/library-renderer-memory-summary.mjs '<IPC results.json>' '<UI基线.json>' '<新的摘要.json>' '<原生探针基线.json>' '<首次释放尝试.json>' '<清理方式对照.json>' '<最终修复.json>'
```

摘要拒绝错建构、错 QA 源码、重复 trial、错误 IPC/UI 模式、未退出 Utility、未清空测试 report 根等混用。完整原始时间线、归档与截图留在临时目录；提交的 JSON 只包含统计、对象计数与溯源，不包含玩家数据或归档载荷。

## IPC 长循环：原 31.7 MB 单点的解释范围

3 个独立新进程/格式，每进程同一个 Renderer 连续 8 轮，共 **48 轮**，单进程约 175–222 秒。每轮目标至少 40 块，实际因首尾/回合边界覆盖为 45 个 Nuke 块，再切换 demo1 请求一块后释放。此前原无指纹流程还请求 91 次完整 Chunk。每进程登记 958 条弱引用；这不是用 heap 快照推算的存活对象总数。

| 格式 / trial | 原流程释放 heap，MB | 8 轮后 quiet heap，MB | quiet Renderer WS，MB | 初始 190 条登记存活 | 全部 958 条登记存活 |
| --- | ---: | ---: | ---: | ---: | ---: |
| v1 / 0 | 8.30 | 39.72 | 180.70 | 0 | 212 |
| v1 / 1 | 8.18 | 38.84 | 174.49 | 0 | 208 |
| v1 / 2 | 8.15 | 39.55 | 181.31 | 0 | 212 |
| v2 / 0 | 35.33 | 7.75 | 118.30 | 0 | 0 |
| v2 / 1 | 35.18 | 7.61 | 118.20 | 0 | 0 |
| v2 / 2 | 35.18 | 17.50 | 142.65 | 0 | 66 |

这些端点不能用来反过来声称“v2 永远更省 Renderer 内存”。完整波形更能说明问题：例如 v1 trial 0 各轮空闲 heap 为 **16.34 / 24.01 / 38.31 / 15.42 / 13.39 / 17.19 / 24.89 / 39.22 MB**，v2 trial 0 为 **24.83 / 16.85 / 11.37 / 13.58 / 16.96 / 24.43 / 38.42 / 15.43 MB**。同量操作的临时分配在自然回收前后形成波形，固定时点可能落在不同相位。

每进程最初的 4 report、4 players 数组、91 Chunk、91 frames 数组登记均已自然失效。两份 v2 甚至全部 958 条登记失效；第三份只余最近对象。IPC 组的 DOM/监听器在各自进程内逐轮完全不变，所有释放阶段业务 Utility 末值均为零。该路径没有发现持续累积的报告/Chunk 强引用证据。结论限于受测对象和协议，与“GC 相位解释”一致；没有借此断言所有闭包/引擎内部路径均无泄漏，也不把仍可解析的近期对象一概说成强引用。

## 实际 UI 与明确的资源清理缺口

原生产构建另做每格式 1 个进程、8 轮实际页面循环，共 16 轮、32 次比赛页面打开/退出。每轮实际 Replay 缓存均通过“活实例 entries 为空，或实例已回收”检查。旧格式终点为 heap 10.71 MB / WS 184.15 MB，所有 1102 条登记失效；新格式为 21.17 / 275.96 MB，所有更早轮次与原流程对象均失效，仅最后一轮的 report/players、一个空缓存及 3 Chunk/frames 共 9 条登记仍可解析。没有把这约 92 MB 的 WS 差额直接归为已解决的 GC 问题。

进一步增加原生资源弱探针，每格式 2 轮，核实以下实际行为：每次 Replay 捕获 8 张效果 Image（7 SVG、1 PNG）和两层 canvas。退出后 v1 两轮即时/1 秒空闲仍有 **8 个非空源、2 个大尺寸 canvas**；v2 首轮相同，第二轮即时为 **16 / 4**，随后才自然回收为零。代码也确认：效果图仅清回调/React ref，未主动解除源；Replay canvas 未缩小 backing 尺寸。Heatmap 原来已经清源/缩小 canvas，没有扩散修改。

`137defd` 首先补了图片 owner 失效、清回调/发布器/自有数组、移除 src 及 setup 捕获旧 canvas 缩为 1×1。其 8 轮复测绑定/尺寸均为零，但发现两个格式都累积了 **128 个仍可解析的效果 Image 包装对象**。这一尝试作为中间结果完整保留，没有仅凭“绑定为零”宣布通过。

随后在同一实际 Electron 中，使用同样 8 个打包图片 URL，分别比较当前 helper、保留已 dispose 回调、完全不经过 helper 三种所有权路径及三种清理方式；每组 8 个目标，共 56 个，之后执行普通真实归档操作使自然回收有机会发生。该实验仅作清理行为诊断，不作 RAM 性能基准。两种归档格式终点完全相同：

| 清理组 | 可解析 / 已失效 |
| --- | ---: |
| helper + removeAttribute(src) | 8 / 0 |
| helper + removeAttribute，另保留已 dispose 回调 | 8 / 0 |
| 直接创建 + removeAttribute | 8 / 0 |
| helper + 空 src | 0 / 8 |
| 直接创建 + 空 src | 0 / 8 |
| helper 或直接创建 + 仅清 handler | 各 0 / 8 |

因此不是 helper 独有闭包才能复现的现象。`debc6a0` 将效果图和既有 `ReplayMapImages` 的清理改为 **`image.src = ''`**，与已有 Heatmap 一致；保持清 handler、失效发布器、清自有引用和旧 canvas 缩小。这里依赖同运行时的实测差异，没有声称定位到了精确 Blink 内部保留链。

探针 v2 明确定义 `boundEffectImages` 为**非空 src URL 数**，另保留 `effectImageSourceAttributes` 记录属性存在（包括空值）。这保留了“移除属性”与“保留空属性”的区别；属性为空并不代表仍绑定原 SVG/PNG。最终验收还要求最早轮次的图片弱引用自然失效，避免再次仅靠绑定计数为零掩盖包装对象保留。

## 最终验收与实际限制

最终修复构建为 `fa7cc93`（生产修正 `debc6a0`），每格式一个全新进程、同 Renderer 8 轮真实 UI 循环，分别运行约 **311 / 221 秒**。固定协议仍是 5 秒逐轮空闲、30 秒观测尾部及 30 秒无 Renderer CDP 请求的 quiet；没有强制 GC、重载 Renderer 或调整预算。

| 最终格式 | quiet heap，MB | quiet Renderer WS，MB | 循环内 Renderer WS 峰，MB | 0–6 轮效果图可解析 / 已失效 | 最后一轮效果图可解析 / 已失效 |
| --- | ---: | ---: | ---: | ---: | ---: |
| v1 | 21.22 | 146.11 | 287.44 | 0 / 112 | 8 / 8 |
| v2 | 21.58 | 265.85 | 314.35 | 0 / 112 | 8 / 8 |

两个格式均不再出现 0–7 轮共 128 个 Image 包装对象全部存活的累积现象。最后一场 Nuke 的近期 report/空缓存/3 块及 frames、8 个空源 Image、2 个已缩小 canvas 等共 19 条弱登记仍可解析，完整出生轮次计数保存在[机器证据](./renderer-memory-lifecycle-measurements.json)。没有把近期仍存活对象称为已经全部回收。

16 轮、32 次真实页面打开/退出均通过数据加载、可信 seek、实际缓存释放与 Utility 退出检查。逐轮即时/空闲及两个尾部阶段的 **46 个资源样本**中，非空图片源与大 canvas 数均为 **0**。存在的 8 个 src 属性均为空字符串；新探针同时保留这个属性计数，未隐藏它们。清理不依赖包装对象已经被 GC。

**工作集差异仍然存在**。最后两进程的 JS heap/DOM/登记对象相近，但 WS 并未一致；本次没有做完整浏览器/GPU/native allocator 归因，不能把 WS 差额全说成 JS 泄漏，也不能宣称所有驻留差额均已消除。不同 probe、不同轮数及不同自然 GC 相位的数据不计算因果 RAM 改善百分比。修复的可验证结果是：旧资源显式解除，旧 Image 包装对象可在正常业务下回收，且未再按全部轮次累积。

| 验证 | 结果 |
| --- | --- |
| 根 `pnpm typecheck` | 15/15 Turbo 任务通过 |
| Replay/Map/资源 owner、Heatmap renderer、导航/store、QA 后处理相关回归 | 47/47 通过，含新增迟到 load 与旧/新 canvas owner 隔离测试 |
| 桌面生产构建 | 通过；最终测量在干净构建副本中执行 |
| 实际页面健康 | 有内容、玩家画布/目标 tick/已应用 Heatmap 可用，无未处理异常或业务 console 错误；仅保留已知 unpackaged Electron CSP 开发警告 |
| 独立复审 | 生命周期修复、矩阵、统计与因果范围已由独立 reviewer 核对；详细范围见[复审记录](./renderer-memory-lifecycle-review.json) |

实际 UI 使用项目原生 Electron/CDP 测试入口，测试已有桌面进程及受信 preload/IPC；普通网页 Browser 代理不能替代这些进程内存。前台调度沿用 QA 的禁止后台降速标志。未清 OS 文件缓存，未验证最小化长期空闲、跨显示器 DPI、24 小时平台、所有显卡驱动或所有未来版本。此结论覆盖有限次数的普通真实业务活动及受测资源，不等于证明不存在任何可能泄漏。

生产改动只在 Renderer 资源生命周期，Parser、Analytics、Findings、Deep Review、归档编码和采样均未改；本轮复用真实归档，没有重新分析 DEM。旧容量/完整性记录保持原样。原始档案、截图、完整观察日志、矩阵 controller 精确源码留在带所有权标记的临时目录，未提交大体积原始生成物；新的机器摘要保留所有阶段，包括失败的 `removeAttribute` 尝试。

主要提交：`c25928d` / `3691a5a` / `8b8c274` 增加长期与真实资源探针；`137defd` 增加显式资源 owner/旧 canvas 释放；`debc6a0` 依据同引擎矩阵修正空 src 清理；`fa7cc93` 保存诊断和 QA 源码以便溯源。未推送、发布、改版本或启动 P8。
