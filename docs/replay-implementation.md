# P6 实施与验收记录

## 2026-10-19 — P7 死亡后的观战目标

新增整回合展示用死亡/生命周期上下文，按明确手动玩家身份重建确定性跟随链；普通击杀优先存活真实击杀者，
自杀/未知/已死攻击者使用稳定种子的存活替代目标。全员确认死亡仅保留实际可靠背景，不补玩家 XYZ。
真实 Nuke R2 tick18395 的原始死亡、基线故障、修复验收，以及其他真实边界和未覆盖项见
[死亡后跟随记录](./p7-replay-death-follow.md) 和 [机器摘要](./p7-replay-death-follow.json)。下文为历史阶段事实。

2026-10-15，起点 `31124ff`。仅实施 P6；P3/P4/Deep Review 算法、阈值、golden 不变。

用户明确选择 `.demo/dust2.dem` 作为本次真实验证样本：
SHA-256 `db90fe85aab023a1d2c8a5996182e6120d98ef494f02a070b17982b235e4958c`，557650967 字节。
缺少其他 DEM 不作为阻塞；未执行的其他地图/个人 DEM 验证不得称为通过。
初次验收时用户确认资源用于本机个人、非商业开发与安装验证；第三方公开分发许可保持未确认。
2026-10-16用户进一步明确将地图资源一并提交/推送：仓库纳入五张PNG与四份原overview，安装包仍留本机；见本文末尾补充记录。
随后同日按用户列出的十图扩展至13张PNG与10份原overview，并接入回放地图/楼层配置；各阶段原测量保留为历史记录。

## P6.0 — 本机个人非商业开发验证通过

新增 dem-parser 内部 `dev/replay-probe.mjs`，不进入生产导出或 Desktop：每候选独立 OS 进程，
读取一次 DEM，共享 bytes、基础 Match/事件查询，再执行三次独立采样以观察波动。
每个正式 round start/end 闭区间内，均匀采样与 freeze、完整事件、生命周期 tick 合并；
不可靠窗口不采集，超预算抛错，空计划不调用 native。
其 Match SHA 与现有 public `parse()` 独立结果相同。

实际数据见 [机器可读试验记录](./replay-feasibility.json)。Windows x64 / Ryzen 7 5700G / 32 GiB，
固定 Rust 1.90.0、MSVC 14.44.35207、SDK 10.0.26100.0 构建的生产 native，SHA
`64aa7e63117dbb1fc0c9c986bc32396bd58e6f5e42ffe6193621d82985065868`。
初始环境无 native；首次 verify 失败、默认 Rust 1.92.0 导致构建拒绝。补齐固定工具链后 3 个 Rust handle 测试与 native 校验通过。
未更改全局默认 Rust、未使用官方旧绑定回退。

| 候选 | 采样查询三次（秒） | 请求 tick / 返回玩家行 | 原始 JSON MiB | 试验进程峰值 MiB | 四个战斗窗位置误差 p95 / max（世界单位） |
| --- | --- | --- | --- | --- | --- |
| 8 Hz | 3.26 / 3.24 / 3.84 | 27466 / 274660 | 56.63 | 1485.35 | 1.85 / 12.40 |
| 16 Hz | 5.84 / 6.12 / 6.36 | 50302 / 503020 | 103.64 | 1980.47 | 0.58 / 9.68 |
| 32 Hz | 12.26 / 12.39 / 14.37 | 95888 / 958870 | 197.48 | 3134.62 | 0.20 / 5.84 |

8/16 Hz 无缺失请求 tick / 玩家行；32 Hz 有 1 个请求 tick、10 行玩家状态未返回，不能跨该缺失段插值。
这不构成其他 DEM 或 native 绝对 freshness 的保证。
四个分布回合的首杀前后各两秒，以真实逐 tick 状态为参考；剔除死亡、缺失、生命周期中断。
8 Hz 方向误差 p95 2.71°、max 21.69°。误差不是全场上限，采样方向也不表示视线/可见性。
20 秒原始 JSON 候选块最大 593918 / 911813 / 1554248 字节；查找并序列化 p95
与所有原始值保留在 JSON。这不是已实现的 DTO、IPC 或 UI seek 指标。
峰值是输入/native/重复查询/reference/JSON 的进程生命周期峰值，不是 Electron 峰值。

首版固定 **8 Hz + 精确事件/生命周期/边界 tick**，兼顾地图尺度下的位置误差与开销。
以下为后续验收目标，尚不是实测 PASS：

- 同一 Dust2 / 开发机：新增回放查询 ≤5 秒；完整导入 ≤15 秒；进程峰值 ≤2.5 GiB。
- 每会话最多 60000 个请求 tick，先检查预算再 native 查询；超限只降级回放，原报告保持可用。
- 按回合、必要时 20 秒分块；单块 JSON ≤1 MiB，超限进一步拆分；会话缓存序列化总量 ≤64 MiB。
- Renderer 最多保留当前块及两个邻块；首帧 ≤1.5 秒，暖缓存 seek p95 ≤250 ms。
- 10 名玩家 Canvas 绘制 p95 ≤16.7 ms；显示插值最大间隔 1/8 秒，缺失/死亡/重生/断连/回合边界不得跨越。
- 多点配准：原始自然尺寸上的出生区与两个安包区都落入独立辨认的区域；未确认地图版本始终标示示意。
- Nuke 的 Z=-495 共享边界保留未知；缺 Z、越界和未知楼层不画成同层接触。

当前 Main 在报告成功/失败时立即 kill worker；worker 仅 `once(message)`，没有持久会话。
P6.2 必须显式扩展会话生命周期，不能直接假定现有导入支持回放块请求。

已验证：probe 边界测试 3/3、资源检查器边界测试 2/2；parser 38 PASS / 2 SKIP（缺历史路径）；
`pnpm typecheck` 15/15、`pnpm build` 8/8。构建前一次 typecheck 因 native 尚未生成而失败，生成后重跑通过。
独立只读复核无阻塞，建议的未知 tick rate 参考窗处理已修正。

可复现（不会下载 DEM/扫描游戏）：

```powershell
node --test packages/dem-parser/dev/replay-sampling.test.mjs scripts/replay-resource-audit.test.mjs
foreach ($rate in @(8,16,32)) {
  node --expose-gc packages/dem-parser/dev/replay-probe.mjs .demo/dust2.dem $rate ".tmp/p6-resources/replay-$rate.json"
}
```

资源调查已固定 DepotDownloader 3.4.0、Source2Viewer CLI 20.1；直接 Steam 匿名获取
app 730 / depot 2347770 / manifest 2312433566686574487 的 `pak01_dir.vpk` 成功，
仅据目录索引获取六个所需 VPK 分卷。未安装游戏、未扫描 Steam/CS2、未执行社区下载脚本。
资源获取现已完成：压缩传输约 574 MB，仅获取索引和 6 个分卷（解压后共 666849112 字节），
未获取地图/游戏可执行文件，不构成安装 CS2。工具、manifest、VPK、4 份原始 overview、5 张图片的尺寸/摘要
以及两社区来源交叉比对见 [资源记录](./replay-resources.json)。五张 PNG 均为 1024×1024，实际解码并视觉检查；
与 awpy 2000930 的图片逐字节相同，Murky 固定 commit 的 PNG 字节不同，未混用。
Steam 原始 manifest 成功验证下载可用性；社区元数据不被称为 Valve 官方 API。

[Dust2 配准记录](./replay-calibration.json)对从原始图片独立辨认的 T 出生区、CT 出生区、东西两个安包区域
作区域测试：5 个 T / 5 个 CT freeze-end 状态、7 个东侧与 5 个西侧精确 planted 玩家位置全部落在相应区域内。
覆盖顶部/底部、东西方向、比例与边缘；这是 4 区域一致性证据，不是像素精确地形或地图版本等价证明。
原始图片的 `rotate/zoom/inset` 是 overview 中保留的 HUD 配置，不机械应用到自然尺寸雷达；
实际区域对齐支持 X 正向右、Y 正向上、scale 4.4。朝向投影和多尺寸画布由 P6.1 纯函数测试。
Nuke 原始上下层范围分别为 [-495,10000] / [-10000,-495]，共享边界在 P6.1 保留未知。
Inferno/Mirage 只验证资源配套与装载，不声称真实 DEM 配准通过。

原始 DEM header patch_version=14055，资源当前 manifest 的 client/build version 没有可验证等价关系；
所有四图 DEM 版本匹配均为 unconfirmed。后续 UI 明示“地图版本未确认，仅示意”，不按地图名声称匹配。
P6.0时个人本机开发/安装验证范围由用户明确确认，公开/商业分发许可 UNKNOWN；当时未push或发布素材。
本阶段通过仅针对上述本机技术前置验证，不表示取得公开分发许可。

复现官方资源提取：固定工具包地址与摘要见资源 JSON；两个工具均不放入运行时/安装包。

```powershell
# 第一份 filelist 只包含 game/csgo/pak01_dir.vpk；随后按索引固定六个分卷：022/137/157/339/409/433。
dotnet .tmp/p6-resources/depotdownloader/DepotDownloader.dll -app 730 -depot 2347770 -manifest 2312433566686574487 -filelist .tmp/p6-resources/map-filelist.txt -dir .tmp/p6-depot -max-downloads 2
# 使用 replay-resources.json 中精确的图片/overview 筛选范围，保留原始路径。
.tmp/p6-resources/vrf/Source2Viewer-CLI.exe -i .tmp/p6-depot/game/csgo/pak01_dir.vpk -o '.tmp/p6-official/' -d -f '<exact filters from replay-resources.json>'
node scripts/replay-resource-audit.mjs .tmp/p6-official .tmp/p6-resources/official-audit.json
node scripts/replay-calibration.mjs
```

提取 Inferno overview 曾因分卷尚在下载而锁定失败，CLI 错误时仍返回 0；等待下载完成后重试成功，
最终通过独立目录检查器确认全部九份文件，未把退出码 0 单独当作成功证据。

## P6.1 — 地图基础通过

`replay-map.ts` 的纯数值投影统一处理1024参考平面与自然图像尺寸、Canvas Y反向与记录 yaw；
Nuke根据版本元数据判层，-495/缺Z/越界保留未知。4个测试覆盖独立Dust2区域、倍尺寸、四向朝向、
Nuke层级边界、未知地图/缺图回退；desktop typecheck通过，独立复核无阻塞。

`node scripts/prepare-replay-maps.mjs .tmp/p6-official` 先核验全部原始overview/PNG摘要及参数，再准备5张本地图片。
远端仓库已核实为PUBLIC，P6.1时用户要求完成后push代码，当时PNG/raw overview不提交或推送。
图片当时位于受Git忽略的renderer assets目录（2026-10-16已按用户要求纳入版本管理），Vite按相对URL打包；缺图检出允许降级事件浏览，
不会热链或下载。归一数值元数据/摘要、准备工具及验证记录提交；公开素材分发许可仍未确认。

UI/真实离线装载在P6.3/P6.4验证。

## P6.2A — 独立领域/采样通过

新增match-model独立Replay契约及显式parseWithReplay()，同一次readInput/基础Match与事件查询复用，
独立8Hz+正式边界/精确事件/生命周期计划，60000唯一tick上限；旧parseWithSpatial仍保持原三字段与稀疏证据。
真实Dust2自动比较Match/Spatial完整内容hash相同，27466请求tick、无缺失玩家行；首轮采样归一化4.01秒，
全parser套件另一次2.95秒，进程生命周期峰值约1.49GiB（包含测试比较，不是app峰值）。

逐玩家segment保留缺失、生命期与跨回合断点；断连跨回合/未采样post-round间隙持续未知，仅本人spawn解除；
死亡后陈旧Pawn存活行记歧义，不能自行复活；same-tick冲突无顺序推断。未知时钟保留事件tick且tickRate=null。
6个新合成边界与1个指定真实DEM验证通过，parser全套45 PASS/2 SKIP，typecheck15/15、build8/8通过。
独立复核发现并已修复跨回合断连状态重置，回归覆盖；不更改旧golden或算法。

契约兼容性/进程方案见[Replay contract](./replay-contract.md)。

## P6.2B — 会话/分块传输通过

report-contract additive可选replay元数据、schema v1分块DTO与命名preload API已接入，原报告schema仍为2。
Utility一次共享输入生成原报告和回放，再只保留有界JSON块；Main报告返回后保留worker，
新文件实际导入/解析取消/会话释放/窗口关闭清理worker与pending，取消文件选择保留旧会话。
当前窗口主frame+当前随机sessionId+登记round/block校验，最多4个在途请求，旧返回不能污染新会话。
回放采样/缓存失败仅降级回放，成功报告保留。

真实Dust2缓存34757998字节（33.15MiB）、159块、最大371621字节（≤1MiB），低于64MiB预算。
逐块JSON与所有相邻guard frames比较、随机读取状态/炸弹基线一致，检查/投影合计1.55秒；
此项仍不是实际IPC/UI seek耗时。真实cache测试进程峰值约1.46GiB。
9个IPC/生命周期/缓存/worker合成测试通过，desktop typecheck/build通过，独立复核无阻塞。

完整desktop测试首次因旧Nuke硬性fixture要求失败（本机无`nuke.dem`），另有新测试mock缺方法已修正。
按用户只要求Dust2的范围，未修改旧测试：`node --test --test-skip-pattern='Nuke Desktop' apps/desktop/tests/*.test.mjs`
执行38 PASS/1 SKIP（demo1缺失），Nuke case显式过滤；随后新增在途请求限额测试另通过。
P6.3播放器与P6.4安装验收继续如下。

## P6.3 — Canvas播放器与联动通过

新增第五个mounted Tab「地图回放」，React/Fluent UI v9控件与双层Canvas；播放/暂停、0.25–4倍速、
进度seek、回合/玩家/楼层选择、键盘操作、文字玩家状态/事件浏览、全局观察与地图未确认说明。
时钟按performance锚点计算，隐藏Tab/后台暂停；Renderer最多3块缓存/单在途请求，旧session返回忽略。
位置与朝向仅在同segment/两端有效/有界间隔插值，离散状态来自完整frame，不进入分析。
炸弹位置标明事件关联/携带者采样，道具仅精确tick生效点，不画烟火区域、抛物线或LOS。

Timeline逐事件tick、基础Finding证据、Deep Review回合均可进入回放；正式窗口外证据明确回退回合起点，
无可靠窗口显示不可用，不静默定位其他事件。既有报告/Timeline/Analysis/Deep Review仍保留。
实际导入启动会退休旧回放元数据；取消文件对话框保留旧会话，解析取消后原报告保持可读。

6个显示时钟/插值/LRU测试、2个store生命周期测试与6个既有SSR回归测试通过，desktop build/typecheck通过。
独立复核发现并修复小数tick块缝及插值携带炸弹消失，新增边界回归；同tick/生命期仍保守处理。
真实Electron（离线网络）执行：播放/暂停、2倍速、Slider seek、跨真实块、换回合/玩家、键盘、
Timeline精确事件与Finding证据联动、原报告与旧公开入口完整hash相同、会话释放后OS worker退出。
首个全通过运行：导入8.99秒、首帧172.5ms、12次IPC p95=10.1ms、Canvas绘制p95=0.4ms；
worker OS峰值1498742784字节，低于2.5GiB目标。最终P6.4会另测安装版。

真实应用截图已检查1280×900、900×760、800×600，无整页横向溢出；这些是CDP viewport模拟，
不是声称原生窗口逐尺寸拖动。P6.3测试脚本曾因未重建采样仪表、首帧等待条件过早、
CDP进程类型/不支持的Browser窗口命令而失败，已修正测试并完整重跑通过；失败未计PASS。
截图/原始metrics在本机`.tmp/p6-qa/`，不提交。脚本：`node scripts/replay-smoke.mjs`。

## P6.4 — 最终本机自动化验收通过

仅对用户指定Dust2与本机个人非商业使用范围作PASS结论；不表示其他录制模式、历史地图版本、个人DEM或公开素材分发许可已获验证。
完整数据见[验收JSON](./replay-acceptance.json)，没有通过修改P3/P4/Deep Review算法、阈值、golden或旧fixture断言逃避回归。

最终预算实测（同一Windows x64 / 5700G / 32GiB）：

| 指标 | Built Electron | 源码目录外安装版 | 预算 |
| --- | --- | --- | --- |
| 完整导入 | 8.03秒 | 8.30秒 | ≤15秒 |
| 打开回放首帧 | 244.8ms | 94.7ms | ≤1500ms |
| 12次分块IPC往返p95 | 9.4ms | 8.3ms | ≤250ms |
| Canvas动态绘制p95 | 0.6ms | 0.3ms | ≤16.7ms |
| 解析Utility OS生命周期峰值 | 1505501184字节 | 1509363712字节 | ≤2.5GiB |

最终parser真实测试回放额外耗时4.36秒（≤5秒）、27466请求tick、无缺失玩家行；完整Match/Spatial hash与旧入口一致。
真实会话缓存34757998字节/159块，全部块最大371621字节（≤1MiB），Renderer最多3块。
IPC表为12次实际Renderer往返；缓存全量最大值另由逐块集成测试验证，不能把12次抽样最大值当成全量。
峰值为各OS进程生命周期峰值，不是同时发生的整应用总峰值；Canvas指标只覆盖动态绘制函数，不宣称全应用恒定60fps。

最终新增/相关验证：

- parser：46 PASS / 2 SKIP；包含指定Dust2、7个回放边界与原有契约回归。
- Desktop：48 PASS / 1 SKIP；另明确过滤缺`nuke.dem`的旧Nuke集成case，未改其断言。
- Analytics：48 PASS / 5 SKIP；Findings V1：16 PASS / 1 SKIP。
- Deep Review：195 PASS / 11 SKIP；明确过滤缺原core aliases的Findings calibration gate，未伪称跨图通过。
- `pnpm typecheck` 15/15、`pnpm build` 8/8、`pnpm test:smoke` dev/preview通过。
- 独立复核的最终小集15/15通过，无剩余阻塞发现；最终真实/安装结果由主Agent执行并复查。

真实Electron/安装版执行：离线五图解码、无Node暴露、正常报告与旧入口完整hash相等、播放/暂停/2倍速、
Slider/键盘seek、真实跨块、回合/玩家切换、Timeline精确tick与Finding证据联动、后台最小化后恢复保持暂停且不跳进、
导入取消后恢复旧报告、重导入新session、旧session拒绝、显式释放worker、仍在解析时关闭窗口无残留worker。
同tick/缺失/跨死亡与spawn/断连跨回合/层级过渡以合成边界另验，不拿合成样本冒充第二份真实比赛。
Nuke未知或跨层的相邻样本不从插值Z推断楼层；无层时清除旧底图。

安装检查实际使用OS临时目录`cs2-analyst-p6-installed`（源码仓库之外）并清空`NODE_PATH`，验证包内workspace依赖已内联、
唯一native `.node`正确unpacked且SHA一致，五PNG与固定来源摘要一致，Renderer只从安装ASAR相对URL离线装载。
生产包检查启动/沙箱/无测试seam及资产；完整真实DEM交互使用单独test-seam安装包。两包均实际NSIS安装并卸载，
不覆盖既有用户安装：前置检查HKCU/HKLM两个注册表视图，既有任务路径必须有`.p6-owned`标记。

产物（仅本机，不发布/不push）：

- `release/0.1.0/CS2-Analyst-Setup-0.1.0.exe`：115906552字节，SHA-256 `91d0a32cf6d15be50c606a13b28b2dbef7e8c227b9eed4ff63f075c61c3e7302`。
- `.tmp/test-output/0.1.0/CS2-Analyst-TestSeam-Setup-0.1.0.exe`：115906561字节，SHA-256 `4e0226722a412ff4e9a38b19c8398ec9eedacb76312f8d49829d9ba7c9d9bd8d`。

另实际移开Git忽略的本机图片、重新构建并运行Dust2：空源码资源模式仍可导入报告/浏览事件与玩家状态，不画虚构底图；
测试后恢复全部5张原始图片并再次完成正常build/真实Electron验证。构建/打包增加摘要预检；Desktop构建禁缓存，
防止Git忽略的可选素材导致含图/缺图构建误用同一缓存。查询前新增600000玩家样本上限并只查询已识别SteamID。
Fluent Slider的密集逐tick刻度会覆盖轨道，已仅隐藏刻度伪元素，保留原生Fluent结构与逐tick操作，并实测轨道尺寸/拇指对齐。

失败历史：首次安装总体脚本在损坏DEM场景已打印场景通过后仍被父进程超时终止，原因是测试CDP客户端在窗口关闭时遗留120秒RPC计时器；
修正客户端关闭时清理所有pending后，对最终两包完整重跑通过。安装保护、后台恢复、解析中关闭断言由独立复核补强并实际重跑。

未执行：其他地图/个人DEM真实验收与demo1历史golden；独立完整生产原生选文件walkthrough；多显示器DPI切换。
三种截图尺寸属于CDP viewport模拟，人工视觉复查与自动布局检查不替代这些未执行项。
所有地图版本均标记未确认，只做示意；无LOS、3D、道具轨迹/烟火区域、热力图、AI、登录或历史库。

复现最终命令：

```powershell
pnpm --filter @cs2-analyst/dem-parser test
node --test --test-skip-pattern='Nuke Desktop' apps/desktop/tests/*.test.mjs
pnpm --filter @cs2-analyst/analytics test
pnpm --filter @cs2-analyst/findings test
pnpm --filter @cs2-analyst/deep-review exec tsc -p tests/tsconfig.json
node --test --test-skip-pattern='^Findings calibration:' packages/deep-review/tests/*.test.mjs
pnpm typecheck
pnpm build
pnpm test:smoke
node scripts/replay-smoke.mjs
pnpm --filter @cs2-analyst/desktop pack:win
pnpm --filter @cs2-analyst/desktop pack:win:test
node scripts/replay-installed-smoke.mjs
```

## 2026-10-16 — 地图资源纳入仓库

用户明确要求将地图资源一并提交并推送，覆盖此前仅本机保存素材的约定。
五张原始1024×1024雷达PNG位于`apps/desktop/renderer/src/assets/replay-maps/`，
四份配套原始overview位于`apps/desktop/renderer/src/assets/replay-overviews/`，共652183字节。
移除图片目录的Git忽略规则；overview目录用`.gitattributes`保留原始字节，避免换行转换改变来源摘要。
来源、固定manifest、文件SHA-256与第三方分发许可未确认的记录保留在`replay-resources.json`。
正常检出即可构建含图回放，不需要重新提取素材；DEM、VPK、提取工具、截图与安装包仍不提交。

九份资源均与固定来源清单摘要一致；资源/地图投影/楼层边界相关测试7/7通过，
`pnpm --filter @cs2-analyst/desktop build`（含typecheck和资源摘要预检）通过，产物包含全部五张PNG。
本次未改变回放逻辑或重新执行完整DEM/安装验收；P6.4测量仍为2026-10-15的实际记录。

## 2026-10-16 — 补齐用户指定的十张地图

最初P6范围为Dust2、Inferno、Mirage、Nuke四图，Nuke分上下层，因此原来是五张图片。
用户随后明确要求Dust2、Inferno、Mirage、Ancient、Overpass、Vertigo、Nuke、Anubis、Train、Cache十图。
现在共13张1024×1024雷达PNG、10份原始overview，合计1851037字节，全部随仓库保存。

| 地图 | 图片数 | 层级 |
| --- | --- | --- |
| Dust2 / Inferno / Mirage / Ancient / Overpass / Anubis / Cache | 各1 | 配套单层底图 |
| Nuke | 2 | 共享边界Z=-495 |
| Vertigo | 2 | 共享边界Z=11700 |
| Train | 2 | 共享边界Z=-50 |

全部资源直接提取自同一Valve分发版本：app730 / depot2347770 / manifest2312433566686574487，
使用已固定的DepotDownloader3.4.0和Source2Viewer CLI20.1。根据既有VPK索引追加获取8个分卷，
实际压缩传输685997344字节、未压缩820394862字节；未安装CS2或扫描游戏目录。
Cache使用该manifest中的`de_cache_radar_psd`及其配套overview，未采用另一个`radar_tga`版本。
13张PNG均与固定[awpy-data 2000930](https://github.com/pnxenopoulos/awpy-data/releases/tag/2000930)逐字节相同，
社区包仅作交叉核对。具体来源、提取路径、工具/VPK/文件摘要与坐标参数见[资源清单](./replay-resources.json)。

Renderer新增六图定义，Train/Vertigo按配套overview分层；共享边界、未知/越界Z仍不自动归层。
准备器同时校验并复制图片与原始overview；审计与Electron smoke按清单覆盖全部资源，移除四图正则/五图数量假设。

实际验证：资源/投影/楼层/插值小集16/16，独立复核再次16/16；Desktop回归49 PASS / 1 SKIP，
仍明确过滤缺`nuke.dem`的旧真实Nuke case。`pnpm typecheck`15/15、`pnpm build`8/8通过。
构建后的13张PNG摘要与清单逐一相同；真实Electron断网条件下全部13张图片解码通过。
指定Dust2的完整播放/seek/跨块/证据联动、取消重导入、后台暂停、关闭清理与原报告hash一致性smoke通过：
导入7.62秒、首帧103.4ms、12次分块IPC p95=7.6ms、Canvas动态绘制p95=0.3ms。
新增八张图片已实际查看；23份资源与直接提取文件、8新增VPK摘要另经独立复核。

本次没有新增地图的真实DEM配准，也未重跑NSIS安装验收。所有地图/DEM版本匹配保持未确认、仅示意；
不能据Cache或Train名称认定匹配某一历史/Workshop地图构建。P6.4的五图安装数据仍是当时实际结果。

```powershell
node scripts/prepare-replay-maps.mjs .tmp/p6-official
node scripts/check-replay-map-assets.mjs
node --test scripts/replay-resource-audit.test.mjs scripts/check-replay-map-assets.test.mjs apps/desktop/tests/replay-map.test.mjs apps/desktop/tests/replay-state.test.mjs
node --test --test-skip-pattern='Nuke Desktop' apps/desktop/tests/*.test.mjs
pnpm typecheck
pnpm build
node scripts/replay-smoke.mjs
```
## 2026-10-18 — P7 回放增强：投掷文案、真实轨迹与道具效果

基线 `fe9ec36`。本轮只增强比赛回放，不进入 P8；版本号、tag、release 未变。详细数据契约见
[P7 回放增强：道具轨迹与效果](./replay-utility-effects.md)，additive 契约摘要同步在
[Replay contract](./replay-contract.md)。

实现：

- 关键事件列表中的 utility 行改为 `[昵称] 投掷了 [道具类型]`；昵称依次取自事件 thrower、projectile owner，
  不在 roster 时显示“未知玩家”。击杀、炸弹、拆除等非投掷文案保持原样。
- 新增一次 `parseGrenades(bytes, [], false)`，按 entity id + projectile 类别 + 连续 run 分段；
  smoke/flash/HE/decoy 用 detonate entity id 匹配，fire 用真实投掷者 + `weapon_fire` 时间窗匹配。
  轨迹保留真实投掷/爆开锚点，按约 16 Hz 抽样，不画直线。
- 烟雾/火焰结束使用 `smokegrenade_expired` / `inferno_expire`；被烟雾扑灭的火焰自然提前结束。
  致盲窗口来自 `player_blind.blind_duration`，灼烧窗口只由 inferno damage tick 聚合，不使用距离推断。
- Renderer 使用现有双层 Canvas，层序 map → areas → trajectories → projectiles → players → status → selection；
  烟雾/火焰半透明且在玩家点之前，被闪/被烧图标在玩家点之后；HE 1s、flash 0.5s 展示窗口、decoy 无持续区域。
- `DesktopReplayChunk` 只携带与自身 tick 窗口相交的效果；旧字段、旧 chunk、seek/时钟/回合窗口语义不变。

真实 Dust2 数据与实测：

| 指标 | 结果 |
| --- | --- |
| utility 效果 | 632（smoke 182 / HE 82 / flash 229 / fire 138 / decoy 1） |
| 真实 projectile 轨迹 | 632 / 632 |
| 致盲窗口 / 灼烧窗口 | 500 / 15（来自 67 条 inferno damage） |
| 效果结束来源 | observed 299 / nominal 310 / round-end 23 |
| 会话块 / 最大块 / 缓存 | 159 / 380403 字节 / 36495839 字节 |
| 回放解析（Node，含新增 native 查询） | 6.46–6.88s；基线 3.29s |
| 完整导入（真实 Electron） | 9.5–10.3s（≤15s） |
| 首帧 / 12 次 IPC p95 / Canvas p95 | 130.9–133.2ms / 8.7–12.1ms / 0.2–0.3ms |
| Utility 进程峰值 | 1685307392 字节（≤2.5 GiB） |
| 原报告 fingerprint | 不变 |

P7 验收脚本的 `seek` 辅助函数补了受控 Slider 同值 input 的桥接（先写相邻值再写目标值），
仅修复自动化竞态，产品 Slider/时钟/seek 行为未改；`node scripts/p7-ui-acceptance.mjs` 随后 PASS。

真实 Electron 截图（本机 `.tmp/p6-qa/`，不提交）：`p7-utility-trajectory.png`、`p7-utility-smoke.png`、
`p7-utility-flash-blind.png`、`p7-utility-fire.png`、`p7-utility-he.png`，以及带烟雾的
`built-electron-1024x640.png` / `built-electron-1920x1032.png`。实际验证了飞行图标、拖尾、烟雾持续区、
闪光光晕 + 真实被闪图标、火焰区 + 真实被烧图标、HE 1s 爆炸、回合切换清空、向前/向后 seek、
事件点击 seek、跨块播放和两种目标分辨率；`reportUnchanged=true`。

验证命令：

```powershell
node --test packages/dem-parser/tests/replay.test.mjs
node --test apps/desktop/tests/replay-effects.test.mjs apps/desktop/tests/replay-session.test.mjs
pnpm --filter @cs2-analyst/dem-parser test
pnpm --filter @cs2-analyst/desktop test
pnpm typecheck
pnpm build
node scripts/replay-smoke.mjs
node scripts/p7-ui-acceptance.mjs
git diff --check
git ls-files '*.dem'
```

已知缺口：新增 native projectile 查询使回放解析超过 P6 的“≤5s”探测预算（完整导入仍 ≤15s）；
fire 的 molotov/incendiary 区分依赖可关联的 `weapon_fire`；burn 窗口由真实伤害 tick 聚合而非逐帧状态；
未实现 3D 抛物线、LOS、地形遮挡或双层地图道具专项截图。以上不改变既有 Replay/Heatmap/Analytics/
Findings/Deep Review 结论。

## 2026-10-18 — P7-S1 多楼层展示上下文修复

目标坐标与底图上下文分离；同一 RAF 决定全部绘制层，按会话复用有限解码底图。
真实 Nuke 五窗/三模式/三倍速、完整1× R1/R2及生命周期、Dust2回归通过；没有补坐标或改领域统计。
详细失效规则、性能口径、截图、失败重跑和未执行项见 [S1验收](./p7-nuke-replay-fix.md) 与
[机器证据](./p7-nuke-replay-fix.json)。原S0证据不变；停在S1，不进入其他P7工作包、L或P8。
