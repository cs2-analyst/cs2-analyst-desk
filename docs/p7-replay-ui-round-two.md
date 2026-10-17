# P7 比赛回放增强：UI / 视觉优化 Round 2

日期：2026-10-18。基线 `ceb463eca609078ba2e6e310cde827fc91d92e90`。
开始时 main / fetch 后 origin/main / HEAD 一致，工作区干净；使用 fast-forward 同步。
本轮止于 P7，不修改版本号、tag、release，不重写历史。

## 八项结果

| 需求 | 实现与边界 |
| --- | --- |
| 拖尾继续加长 | 速度响应系数 0.48 → 0.80，窗口上限 0.78s → 1.10s（中途按用户反馈从 1.05 / 1.35s 下调）；低速 0.30s、未知时钟 0.34s 不变。只回溯真实样本，起点截断；保留每个折返、弹跳、缺失跨度和楼层过滤。 |
| 火苗精灵动画 | 附件可访问，直接提取上半部无棋盘区域的 7 个红橙火苗；本地透明 560×112 PNG，约 77KB。三个错相实例，位置、尺度略不同，12fps ping-pong 序列；每实例相差 4 个序列步。 |
| HE 破片 | 白黄亮芯、不规则短促 flare、橙色光晕和双冲击环，叠加 9 枚更亮破片；中心出发、快速飞散与衰减，展示窗口按最新用户反馈压缩为 0.5s；为纯视觉，不表示伤害方向或弹道。 |
| 官方图标 | 直接静态引用原有 killfeed/weapons 的 smokegrenade、flashbang、hegrenade、molotov、incgrenade、decoy SVG。未知 fire 使用已有 inferno SVG。深色圆底保障清晰；原 SVG 与来源 manifest 没有修改。事件按钮原来没有图标位，本轮保持其文本布局。 |
| 玩家半径翻倍 | T 普通/选中半径 7/9 → 14/18；CT 半边长 7 → 14，保留原形状、颜色及高亮。朝向与状态图标随之移出点位。 |
| 显示昵称 | 连续播放右侧 Fluent Switch，默认关闭。仅 ReplayPlayer 本地状态，session 身份防止新导入串用，Tab 返回保留本视图状态。开启绘制所有当前可见且有真实位置的存活玩家昵称；关闭只保留原选中昵称。最小 10 CSS px，暗底，四个邻近候选位置作简单避让。 |
| 投掷事件 | 六类全部支持真实 weapon_fire。只在 Replay DTO 投影中将精确道具 weapon_fire 标记为 utility_throw 并纳入可见列表，复用原 ID/tick/shooter；不从效果/实体/距离反推。原 632 个生效事件完整保留。 |
| 中文名称 | 统一使用 shared/replay-presentation.ts 展示映射；不修改原生 weapon、领域 utility/variant 或其他业务字段。 |

HE 的 0.5s 是展示窗口：`min(原 endTick-tick, tickRate×0.5)`，在结束 tick 不再入帧；未知时钟沿用 64 tick/s 的视觉回退。
原领域/DTO 的 HE endTick 仍保留，未篡改原生事件时间；所有核心、环、flare 与破片共享同一半秒 progress。

所有新动画仅依赖当前 Replay tick、事件稳定种子和本地已解码图片。没有墙钟动画、累积粒子、动画库或运行时网络资源。
烟雾绘制未修改；火焰保留 0.35s 形成/1.4s 消散包络和真实 endTick，inferno_expire、烟熄火与回合结束逻辑不变。
图层仍为地图 → 区域 → 轨迹 → 飞行图标/爆炸 → 玩家 → 状态 → 标签。

## 拖尾参数对比

`u=clamp((speed-100)/900,0,1)`；旧 `seconds=0.30+0.48*u*u*(3-2*u)`，
最终 `seconds=0.30+0.80*u*u*(3-2*u)`。相对基线响应系数增幅 66.7%，最大时间窗增幅约 41.0%。
用户反馈首版过长后，从 1.05 系数 / 1.35s 上限收至当前值；没有改变低速与未知时钟回退。
线宽 0.9→6.2、alpha 0.10→0.90 的头亮尾淡样式不变，局部暗色衬线不变。
缺失跨度仍以 `max(2,ceil(tickRate/8))` 标记断点，没有均匀重采样切弯。

相同真实 DEM、同 tick、同投影路径的实际长度（世界单位）：

| 场景 | 回合 / tick | 速度 | 基线长度 | 新长度 |
| --- | --- | ---: | ---: | ---: |
| 高速 r2-u35 | R2 / 9402 | 960.38 | 745.65 | 917.87 |
| 低速 r1-u11 | R1 / 3822 | 51.94 | 14.40 | 14.40 |

用户要求收短后的另一高速真实例子：R1 / tick 4688 / r1-u27，速度 940.85；
基线 680.76 → 中途 1.05 系数 1170.91 → 最终 0.80 系数 **953.05**，相较过长版缩短约 18.6%。
对应 `trail-trimmed-{1024,1920}.png`。上表 r2-u35 的两个新系数都受起点限制，因此长度相同；不将它冒充收短效果证据。

高速实际增加约 23.1%，小于时间窗增幅，因为这颗道具可回溯的真实飞行历史较短；不会补画投掷前路径。
1.10s 有界窗口防止污染整张地图。开始更新中曾将理论速度×时间估算误报为约 1292，已纠正；本表为逐段真实路径求和。

## 投掷调查：SUPPORTED（六类）

仅使用 `.demo/dust2.dem`，557650967 B，SHA-256：
`db90fe85aab023a1d2c8a5996182e6120d98ef494f02a070b17982b235e4958c`。
未下载、复制或提交 DEM。

`node scripts/p7-throw-audit.mjs` 重新读取 native weapon_fire / grenade_thrown、逐 tick projectile，
并执行当前 Parser 和不可变基线 ReplaySession 投影作逐字段比较。

| 道具 | 原生投掷记录 | 原生生效记录 | 唯一投掷/轨迹关联 |
| --- | ---: | ---: | ---: |
| smoke | 182 | 182 | 182 |
| flashbang | 229 | 229 | 229 |
| hegrenade | 82 | 82 | 82 |
| molotov | 58 | 57 | 57 |
| incendiary | 81 | 81 | 81 |
| decoy | 1 | 1 | 1 |
| 总计 | 633 | 632 | 632 |

- 633 条均逐项匹配唯一 native weapon_fire 的 tick/weapon/user_steamid，且 owner 在 roster。
- grenade_thrown 在此 DEM 为 0，未用它替代可靠的 weapon_fire。
- 632 个效果各有唯一原生 projectile run + owner + 类别 + 创建前 64 tick 内的唯一 release；
  其 release tick 与现有真实 flight.startTick 相同。fire 不把 inferno entity 当作 projectile entity。
- R3 tick 16163 的两名玩家同 tick 投闪光；R18 tick 152029 的多人不同道具投掷，均保留各自源记录。
- 同玩家短间隔连续闪光按独立原生 eventIndex/tick 保留；597 个效果涉及被复用的 effect entity 索引，
  projectile 关联仍以连续 run 区分。产品投掷条目本身不依赖 entity 关联。
- R18 tick 152274 有一次 molotov weapon_fire，没有匹配的生效效果；仍显示真实投掷，不生成假生效事件。
- 与基线逐项比较：全部事件 ID、tick、actor、target、position 不变；仅道具投掷的展示 type/文案、
  效果文案不同。其余事件文案保持。领域事件、效果窗口和 DTO schema 不变。
- 合成边界测试覆盖六类、未知 weapon、缺少 flight/effect、多人同 tick、同玩家同类连续投掷、
  跨 chunk、事件去重、提前隐藏和随机访问。真实专项也检查投掷条目点击 seek 与倒退清除。

支持结论限定于真实 native 证据；未声称亚 tick 动画离手精度，也未声称每个未来 DEM 都一定有完整事件。
原始 weapon_fire 缺失时不会补造投掷，无法识别的武器保持原隐藏开火事件。

中文映射：smoke→烟雾弹、flashbang→闪光弹、hegrenade→手雷、molotov→燃烧瓶、
incendiary→燃烧弹、decoy→诱饵弹、fire→火焰。投掷与生效共用映射。

## 真实 Electron 证据

使用已构建 Electron、本机 Dust2 和原生 BrowserWindow.setBounds，断言原生窗口及 inner size 同时为
1024×640 / 1920×1032。未用合成 Canvas 或浏览器 viewport 模拟代替此专项。
无 Browser skill/runtime，沿用仓库本机 Electron CDP 验收；UI 综合脚本另作 viewport 回归。

```powershell
$env:P7_VISUAL_LABEL='round-two-final'
$env:P7_CAPTURE_FIRE='1'
$env:P7_ROUND_TWO='1'
node scripts/p7-visual-acceptance.mjs
```

真实本地截图目录（不提交）：`E:/cs2-analyst/.tmp/p7-visual-round-two-final/`。

- `trail-{fast,slow}-{1024,1920}.png`：同场景高速/低速与官方飞行道具图标。
- `trail-trimmed-{1024,1920}.png`：额外高速真实轨迹，比较用户反馈前 1.05 系数与最终 0.80 系数，具体长度在 metrics.json。
- `fire-{0..4}-{1024,1920}.png`：连续 tick 9077、9088、9099、9110、9121 的火焰。
- `fire-play-{00..15}.png`：真实 1× 播放局部 compositor 采集；原始 tick/time 在 metrics.json。
- `fire-playback.gif`：上述 200×160 原始帧，按采集时间合成；`fire-playback-3x.gif` 为邻近像素 3 倍预览，
  没有插帧或新增火焰，不能当作应用中火焰尺寸。
- `he-{0,4,8,16,24,33}-{1024,1920}.png`：爆炸开始、飞散、衰减与窗口结束。
- `he-ticks.gif` / `he-ticks-3x.gif`：上述真实固定 tick 截图的 200×160 局部序列（及 3 倍预览），
  按 64 tick/s 排列时间，结束后留短暂停顿；这是 seek 截图序列，不冒充连续录屏，也没有插帧。
- `nicknames-{off,on}-{1024,1920}.png`：翻倍玩家标记及昵称开关对比。
- `throw-chinese-{1024,1920}.png` / `effect-chinese-{1024,1920}.png`：原生投掷条目、原有生效条目的中文。
- `smoke-{early,middle,fade}-{1024,1920}.png` 与 `multiple-smoke-1920.png`：烟雾回归。
- `metrics.json`：完整场景、tick、原生窗口与检查/性能。before 在相邻 `p7-visual-round-two-before/`。

最终专项 43 张全窗口截图 + 16 张播放局部帧。暂停像素相同、同 tick 重复 seek 相同、火焰/HE 随 tick 变化、
倒退、真实结束、跨 chunk、跨回合、1×/2×/4×、Tab 状态隔离与重新导入重置均通过。
独立复审检查源码及以上两种尺寸截图/连续帧，无新增阻塞缺陷；最新 HE / 事件轻量测试 15/15，另有 SSR 11/11。

## 性能

同场景稳定 Canvas 绘制 p95：每次播放后暂停约 2.2s，使用最近 120 帧，单位 ms。

| 指标 | 基线 | 本轮 |
| --- | ---: | ---: |
| 1× 后稳定场景 | 0.40 | 0.70 |
| 2× 后稳定场景 | 0.70 | 0.50 |
| 4× 后稳定场景 | 0.50 | 0.60 |
| 经真实 UI 完整导入 | 10.136s | 13.493s |

最终专项导入与 Desktop 回归并行，13.493s 含测试争用，不作为隔离性能对比；
独立 replay-smoke 的最终数值见下。新反馈前专项导入为 10.782s，保留于 round-two-after 历史目录。

独立 replay-smoke：完整导入 10.128s，首帧 131.8ms，12 次 chunk IPC p95 7.6ms，
Canvas 动态绘制 p95 0.40ms；原报告 fingerprint 不变，chunk 保持低于 1 MiB。
Analysis Utility peak working set 1693642752 B（约 1.58 GiB），renderer 峰值 116133888 B。
这些指标含环境/缓存波动，不把绘制小幅下降宣称为解析优化，也不把 CPU 绘制时间当 GPU 整帧耗时。

投掷审计测得 Replay 查询 6.137s；Parser+Spatial 3.718s。解析器查询路径未改。
**历史 Replay 新增查询 ≤5s 预算仍未解决**；完整导入低于 15s 不替代独立查询预算。
火焰图集约 77KB、8 张图片解码一次（其中 7 张为已有官方 SVG），无逐帧图像分配或粒子缓存增长。

## 验证与失败修正

| 命令 | 最终结果 |
| --- | --- |
| `pnpm typecheck` | PASS，15/15 |
| `pnpm build` | PASS，8/8 |
| `pnpm --filter @cs2-analyst/desktop test` | PASS，145/145，0 skip |
| `pnpm --filter @cs2-analyst/dem-parser test` | PASS，49/49，0 skip |
| `node scripts/replay-smoke.mjs` | PASS，原报告 fingerprint 不变 |
| `node scripts/p7-ui-acceptance.mjs` | PASS，10 组检查、20 张截图 |
| `P7_ROUND_TWO=1 node scripts/p7-visual-acceptance.mjs`（完整环境见上） | PASS，43 张截图、16 张局部播放帧、两种原生尺寸 |
| `node scripts/p7-throw-audit.mjs` | PASS，633 条 native release / 632 个原生效果；与基线投影比较通过 |
| `git diff --check` | PASS |
| `git ls-files '*.dem'` | 空，无跟踪 DEM |

原始命令日志在 `.tmp/p7-round-two/`，专项指标在上面的 metrics.json；截图、GIF、DEM、构建产物均不提交。

首次 Desktop 回归暴露 SSR 测试 loader 不认识 PNG，已补齐静态资源加载支持；report-ux 11/11 复跑通过。
首次截图检查发现开关过渡/Canvas 提交尚未稳定，截图前补充 UI settle 与双 rAF；
随后实际发现 1024 昵称过小，增加最小 CSS 字号和轻量避让，重新构建并重跑专项，独立截图复审通过。
P7 UI 综合验收首次在同 tick 截图定位上失败：新增可见投掷使正常自动平滑滚动更长，
原几何 settle 不等待该列表滚动。脚本现明确等待追加滚动结束，再 instant 定位截图；
原有同 tick 两行必须完整可见的断言保留，完整重跑通过。

## 改动范围与剩余问题

产品：`apps/desktop/electron/replay-session.ts`、`renderer/src/replay-effects.ts`、`renderer/src/replay-player.tsx`、
`renderer/src/replay-effect-assets.ts`、`shared/replay-presentation.ts`、
`renderer/src/assets/replay-effects/{fire-atlas.png,provenance.json}`。
回归：`apps/desktop/tests/{replay-effects,replay-session,report-ux}.test.mjs`。
脚本：`scripts/replay-smoke.mjs`、`scripts/p7-{visual-acceptance,ui-acceptance,utility-timing-audit,throw-audit}.mjs`、`scripts/p7-extract-fire-frames.py`。
文档：本文件及 replay-utility-effects.md 的索引链接。

不修改 Parser、领域模型、Analytics、Findings、Heatmap、Timeline、Report、Deep Review 产品逻辑。
真实视觉专项仅 Dust2；多楼层地图本轮未新增真实道具截图，既有楼层/缺失轨迹降级测试保留。
地图版本匹配、精确火区/LOS、nominal 缺失结束来源、第三方资源分发许可等原有限制不由本轮宣称解决。
附件是用户提供的视觉素材，provenance 保留摘要与裁剪参数，不将其声称为 Valve 官方火焰资源。
真实窗口内的火苗观感已改为附件风格精灵，但最终偏好仍由用户实际播放判断。
