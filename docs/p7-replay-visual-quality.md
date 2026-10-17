# P7 道具视觉质量与时间语义复核

后续 Round 2 已将火海改为附件提取的精灵帧、补充原生投掷事件并调整展示：
[当前 Round 2 记录](./p7-replay-ui-round-two.md)。下文保留本文件对应轮次的历史实现与证据。

用户观感反馈后的**当前火海实现**见文末“成组火苗重绘”；前文保留 `0ad3d89` 的首轮历史验收。

日期：2026-10-18。起点、fetch 后 `origin/main`、初始 HEAD 均为
`c247469102196e474e7162e2536ee815fd5c0abb`，初始工作区干净。
本轮仅 P7；不修改版本号、tag、release，不进入 P8。

## 实现

- `replay-effects.ts` 的 `paintReplayArea`：仅接收当前 Replay tick、原效果证据和投影坐标。
  9 个固定分布的烟簇，通过 eventIndex/tick/entityId 稳定种子决定角度和相位。
  灰白亮芯、灰蓝阴影、透明柔边；单簇中心 alpha 0.26–0.41，重叠形成浓密中心。
  基准展示半径从 144 调至 184 世界单位；局部漂移为半径的 4–4.5%，形变约 5.5%，
  各簇频率不同，按秒计算的 0.23–0.45 rad/s 量级运动，不对整团透明度作周期脉冲。
- 9 个火焰簇，展示半径 158 世界单位。暗红低透明热晕、橙红不规则轮廓、橙黄/亮黄内核，
  每簇 16 个动态轮廓顶点和短曲线火舌。局部位置约 2.3–2.5%、尺度约 4.5–6.5% 波动，
  不同相位/频率独立变化；稳定阶段不改变整体 alpha。保持俯视地面区域、玩家下方层序。
- 烟火沿用 0.35s 形成与末尾 1.4s 消散包络；`tick/endTick/endSource`、烟熄火、回合结束
  和 nominal 降级规则没有修改。展示形状/半径不是观测到的精确烟火几何，也不表示 LOS。
- 拖尾采用真实 3D projectile 段速度的有界平滑映射：
  `u=clamp((speed-100)/900,0,1)`，`seconds=0.30+0.48*u*u*(3-2*u)`，未知时钟回退 0.34s。
  时间窗内保留每个真实采样顶点，尾/头仅在原相邻采样间插值，不外推起点或当前位置。
  超过 `max(2,ceil(tickRate/8))` tick 的缺失跨度标断点；楼层与未知坐标继续保守断开。
  线宽从 0.9 向 6.2 地图 Canvas 单位渐增，alpha 从 0.10 向 0.90 渐增。
  静态分布常量复用，无随机逐帧状态、粒子列表、无限缓存或新图形依赖。

## 固定窗口与速度窗口比较

相同真实 DEM、同 tick、同地图比例的 before/after Electron 截图见下方目录。
以下长度是从相同真实投影采样重建的路径长度（世界单位），不是反推游戏飞行距离。

| 场景 | 回合 / tick | 速度（世界单位/s） | 0.34s 固定 | 0.65s 固定 | 速度窗口 |
| --- | --- | ---: | ---: | ---: | ---: |
| 高速，r2-u35 | R2 / 9402 | 960.38 | 328.10 | 626.35 | 745.65 |
| 低速，r1-u11 | R1 / 3822 | 51.94 | 17.11 | 36.82 | 14.40 |

选用速度窗口：高速约为原长度 2.27 倍，而低速保持短尾；固定 0.65s 会把低速尾巴也拉长。
两种方法都只回溯已有采样；当前实现额外保留窗口内每个弹跳/折返顶点，避免原等分重采样切弯。
`replayTrajectoryTrail(..., seconds)` 保留显式固定参数供复现比较。

## 时间语义

最终判断 **CONFIRMED BUG FIXED**：错误在“投掷了”的描述，原 utility tick 正确对应原生生效事件。
只按已有 `UtilityEvent.action` 改为“爆开 / 开始燃烧 / 开始生效”，不移动 tick、事件 ID、排序、
seek、chunk 或效果窗口。632 个真实效果的其余事件字段与不可变基线逐项一致。

完整实例表、原生字段、实体 run/owner、同 tick 多人、同人连续投掷和 inferno 不同实体关联证据：
[核验说明](./p7-utility-timing-audit.md)、[机器可读证据](./p7-utility-timing-evidence.json)。
本地 DEM 为 `.demo/dust2.dem`，SHA-256
`db90fe85aab023a1d2c8a5996182e6120d98ef494f02a070b17982b235e4958c`。
不需要游戏内人工时间语义核验；weapon_fire 不被声称为亚 tick 精确的动画离手帧。

## 真实 Electron 验证

`node scripts/p7-visual-acceptance.mjs` 实际启动已构建 Electron、经真实导入入口读取 Dust2。
通过主进程临时 inspector 调用 `BrowserWindow.setBounds`，断言原生窗口 bounds 与 renderer
inner size 均为 1024×640、1920×1032；没有用 Canvas 合成样例或仅 viewport 模拟代替。
inspector 仅在此验收进程命令行开启，退出时关闭，不加入产品设置。

截图均为真实 Electron compositor 输出，位于本地、不提交：

- `.tmp/p7-visual-before/`：原构建基线，同名场景。
- `.tmp/p7-visual-after/smoke-{early,middle,fade}-{1024,1920}.png`：R1 烟雾形成、中期与末期。
- `.tmp/p7-visual-after/fire-{0,1,2,3,4}-{1024,1920}.png`：R2 tick 9077、9088、9099、9110、9121，
  间隔 11 tick（0.171875s），多簇轮廓局部变化。
- `.tmp/p7-visual-after/trail-{fast,slow}-{1024,1920}.png`：同地图比例高速与低速。
- `.tmp/p7-visual-after/multiple-smoke-1920.png`：R2 tick 10467，3 颗烟同时存在；
  `fire-4-1920.png` 还包含两处不同阶段火区。
- `.tmp/p7-visual-{before,after}/metrics.json`：窗口、具体 effect、全部截图路径、行为断言与性能原始值。

针对性自动化通过：加载完成后比较实际合成地图截图，暂停不变、同 tick 重复 seek 完全一致；
不同 tick 的烟/火画面变化；倒退不暴露未来效果、真实窗口结束无残留、跨 chunk 倒退一致、
跨回合清空；1×/2×/4× 时钟实测比例 0.996/1.996/3.992，暂停后均保持截图一致。
Canvas `toDataURL` 读回曾出现栅格后端差异，因此像素一致性断言使用 compositor 地图截图，
另以绘制命令单测验证纯 tick 确定性。早期验收脚本失败和修正不被作为产品 PASS 证据。

独立聚焦复审未发现阻塞性产品问题，11/11 轻量测试通过；复审同时检查了 5 组前后截图。
随后补充旧 chunk / 无轨迹降级测试，最终相关轻量测试为 12/12。
**最终动画观感仍待用户人工验收**：火焰为较紧凑、圆润的多个热点簇，是否充分达到期望的
铺地火海观感，不能仅凭绘制存在或截图变化宣称人工验收通过。

## 性能与回归

固定相同 R2 场景的稳定绘制 p95（每次暂停约 2.2s、覆盖原 instrumentation 最近 120 帧）：

| 指标 | before | after |
| --- | ---: | ---: |
| 1× 后稳定场景 p95 | 0.30ms | 0.40ms |
| 2× 后稳定场景 p95 | 0.30ms | 0.50ms |
| 4× 后稳定场景 p95 | 0.40ms | 0.40ms |
| 经 UI 完整导入 | 8.656s | 8.846s |
| Analysis Utility peak working set | 1,689,268,224 B | 1,689,825,280 B |

这些是同场景稳定 Canvas 绘制采样，与动态播放统计分别报告；不是 GPU 整帧耗时。
增加约 0.1–0.2ms 的局部绘制成本，仍远低于原 16.7ms 绘制预算。
完整 `replay-smoke` 动态播放测量：绘制 p95 从 0.30ms 到 0.20ms；完整导入从 9.682s 到
8.303s；首帧从 129.2ms 到 74.1ms；最终 IPC p95 6.5ms。
该脚本的动态片段与上表定点场景不同，不能把动态 p95 的降低当作新效果绘制更快的证明。
Utility 进程峰值从 1,685,295,104 到 1,690,615,808 字节；原报告 fingerprint 相同。
解析链没有更改，导入差异包含运行环境与缓存波动，不声称解析性能已优化。

已运行且通过：

| 命令 | 实际结果 |
| --- | --- |
| `pnpm typecheck` | 15/15 |
| `pnpm build` | 8/8 |
| `pnpm --filter @cs2-analyst/desktop test` | 最终 142/142，相关轻量测试 12/12 |
| `pnpm --filter @cs2-analyst/dem-parser test` | 49/49 |
| `node scripts/replay-smoke.mjs` | PASS，原报告指纹不变 |
| `node scripts/p7-ui-acceptance.mjs` | PASS，10 项检查、20 张截图 |
| `node scripts/p7-visual-acceptance.mjs` | PASS，21 张专项截图、两种原生窗口尺寸 |
| `node scripts/p7-utility-timing-audit.mjs` | CONFIRMED BUG FIXED，632/632 |
| `git diff --check` | PASS |
| `git ls-files '*.dem'` | 空，无跟踪 DEM |

测试无跳过。Parser 测试实测一次 Replay 查询为 4.990s，峰值 RSS 1,670,716 KiB。
其后独立执行 3 次 `parseWithReplay`（同进程、每次前 GC，无其他解析/Electron 验收并行），
Replay 查询为 **4.547 / 4.468 / 4.431s**，完整 parser 为 7.860 / 7.733 / 7.687s；
进程生命周期 maxRSS 为 1,657,356 / 1,965,668 / 2,054,968 KiB（非 Electron worker 峰值）。
原始值保留在 `.tmp/p7-replay-performance.json`。
原 P7 的 6.46–6.88s / P6 5s 查询预算问题仍保留；本机本次暖态低于 5s 不代表已修复或豁免，
本轮没有修改解析器，也不以完整导入低于 15s 代替独立 Replay 查询预算。

## 边界与未验证项

- 本轮真实视觉验收只用 Dust2；Nuke 等多层地图的道具专项视觉没有重做，楼层断点单测保留。
- 缺失轨迹/位置/时钟、旧 chunk、真实结束缺失时仍使用已有保守降级；原始 nominal 数据缺口未消除。
- 地图版本、精确烟火形状、LOS/地形遮挡仍未确认，不扩展 Heatmap、Analytics、Findings、
  Deep Review 或 Timeline 的业务逻辑。
- 本轮完成后停止，等待用户实际动画观感反馈，不进入 P8。

## 成组火苗重绘（用户反馈后）

用户接受烟雾效果，但明确不接受圆润热点式火海，希望由“一组组火苗”构成。
本次基线 `0ad3d895e7a8cf348b13c2dc94ac3963b7070394`，fetch 后 origin/main 与 HEAD 一致，
初始工作区干净。只修改 `replay-effects.ts` 的火焰绘制、相关单测和验收采集；不修改烟雾、
拖尾、Parser、时间文案、DTO、业务窗口、版本号或其他模块。

当前火海为 **7 组 × 每组 3 支火苗，共 21 支**。每支使用带侧边缺口的曲线尖头轮廓，
橙红主体采用竖向线性渐变，内嵌较窄的亮黄火芯；取消火焰径向渐变与圆形热点。
同组中间火苗较高，两侧较矮，组与组按地面位置从后向前错开铺开；底部低透明燃烧斑块连接。
各火苗分别按 Replay 秒数与稳定种子进行约 9% 加 3.5% 的双频高度变化及小角度偏摆，
尖端方向独立变化。整个区域不旋转、不使用整体明暗脉冲，保持短小的战术地图符号尺度。
每效果固定 21 个线性渐变和有界曲线路径，无累积粒子或新依赖。

沿用原 158 世界单位基准展示半径、0.35s 形成、1.4s 消散、真实 endTick，且继续绘制在玩家下方。
烟雾绘制分支不变；实际前后截图比较：1920 三阶段完整截图一致，1024 三阶段地图区域像素一致
（窗口其他 UI 的滚动/控件过渡可能不同）。

实际真实 `.demo/dust2.dem` / Electron 原生 1024×640、1920×1032 专项验收通过，
包含连续火焰、烟雾三阶段、拖尾、多效果、暂停像素一致、相同 tick seek 一致、1×/2×/4×、
倒退/跨 chunk/跨回合/效果结束清理。文件位于：

- `.tmp/p7-visual-fire-before/`：本次修改前基线。
- `.tmp/p7-visual-fire-after/fire-{0..4}-{1024,1920}.png`：新的火苗组。
- `.tmp/p7-visual-fire-after/fire-play-{00..15}.png`：真实 1× 播放的局部连续采集，
  R2 约 tick 9051.46–9171.14，约 1.87s，不是合成动画或重新推演轨迹。
- `.tmp/p7-visual-fire-after/fire-playback-3x.gif`：上述原始 200×160 截图以邻近像素放大至
  600×480 的循环预览，约 8.02fps；仅用于放大查看，不表示 App 内地图或火苗放大了三倍。
  可用 `P7_CAPTURE_FIRE=1` 配合 `P7_VISUAL_LABEL=fire-after` 重跑验收脚本采集 PNG。
- `.tmp/p7-visual-fire-after/metrics.json`：原始测量及具体截图/播放采集 tick。

相同场景的稳定绘制 p95：修改前 0.40 / 0.50 / 0.40ms，修改后
0.40 / 0.50 / 0.60ms（分别为 1×/2×/4× 后暂停采样，最近 120 帧）。
经 UI 导入 8.962s → 8.881s；Analysis Utility peak working set 1,693,925,376 B（after）。
增加的局部绘制开销约 0–0.2ms，仍低于原 16.7ms 预算；导入波动不归因为解析优化。
历史 Replay 查询 5s 预算问题继续保留，本次不改 Parser，不重复进行时间语义审计。

独立聚焦复审无阻塞问题，并检查两种尺寸下的真实截图。`pnpm typecheck` 15/15、
`pnpm build` 8/8、Desktop tests 142/142、相关效果单测 7/7 通过；单测同时验证无圆形火焰主体、
不同 tick rate 的同秒动画一致、无整体 alpha 脉冲、暂停/seek 确定性和 Canvas 状态平衡。
`node scripts/replay-smoke.mjs`、`node scripts/p7-ui-acceptance.mjs` 均重跑 PASS；前者
完整导入 8.312s、首帧 127.2ms、动态绘制 p95 0.30ms、IPC p95 5.7ms，原报告指纹保持相同。
`git diff --check` 通过，`git ls-files '*.dem'` 为空。本次未涉及 Parser 或事件语义，未重跑 Parser 测试。
最终动态观感仍等待用户确认，不将自动化 PASS 当作人工视觉验收通过，不进入 P8。
