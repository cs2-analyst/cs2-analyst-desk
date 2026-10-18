# P7-S1 — Multi-floor Replay Fix

2026-10-18，**PASS，停止在 S1**。未实施 S2–S6、L0–L5 或 P8；版本号、tag、release 未变。

基线：`f44141a5aaa01d140efd8486f8f99fee288fd027`；开始时已 fetch 并确认 HEAD=origin/main、工作区干净。
最终 SHA 见本次交付消息及 `git log -1`，避免文档自引用自身提交哈希。
机器证据：[p7-nuke-replay-fix.json](./p7-nuke-replay-fix.json)。
S0 原始 [报告](./p7-nuke-replay-diagnosis.md) 与 [JSON](./p7-nuke-replay-diagnosis.json) 保持逐字节不变。

## 修复与边界

S0 已确认位置有效率 99.7189%、可画条件具备时漏画为 0；本次不重新探索 Parser 架构。
修复的是目标插值 Z 未知时，整张地图失去展示上下文，以及 React 低频层状态与 RAF 当前 tick 不一致。

- `replay-floor.ts` 保存一个楼层 ID 和上下文，**不保存 XYZ**。目标存活、segment 有效、非歧义、有限 XYZ 且可唯一归层时立即确认；未知时沿用此前可靠层，并显示“目标楼层未知 · 沿用上一确认层”。
- 冷 Seek 没有可靠目标位置时保持未知，显示“目标楼层未知 · 请手动选层”；不猜主层或按人数选层。手动层继续显示该层中真实可用玩家。
- RAF 从同一 `replayDisplayFrame(at)` 决定层、底图、玩家、炸弹、轨迹与烟火。React 仅在层/提示/图片就绪等状态变化时更新；低频时间控件保留。
- 当前会话只预加载当前地图有限楼层并等待解码。Nuke 两张图片切层复用；未知/恢复、暂停和隐藏 Tab 不反复构造图片。新层没就绪时清除旧底图并停止该层前景，不能把旧图标成新层。图片失败保留明确错误提示。
- 原 `replayDisplayFrame`、alive/XYZ/segment/maxInterpolationTicks、采样预算、事件和道具起止窗口、ReplayClock、Chunk/IPC 限额都未改。没有新的生产 native 查询，没有修改领域包、Heatmap、Analytics、Findings、Deep Review 业务逻辑或新增依赖。

| 动作 | 历史楼层规则 |
| --- | --- |
| 换玩家、换回合（含自然连续跨回合）、换 DEM / Match / Session / 地图资源 | 上下文失效 |
| 手动选层、手动切回自动 | 清除自动历史；当前可靠位置可立即重新确认 |
| 显式 Seek：冷/暖、同 tick、前向、反向、大幅跳进、事件/键盘/相对跳转、回合末重播 | `seekRevision` 递增并清历史，暖 Chunk 不代表展示历史可靠 |
| 暂停/恢复、1×/1.5×/4×切换、连续跨 Chunk、隐藏 Tab 后恢复 | 同一单调正向时钟上下文可保留；不保存目标坐标 |
| 普通慢 RAF | 保留背景；不拿 8 tick 的位置插值门槛限制绘制频率 |
| 释放/重新导入 | 图片回调与 src 清理、Map 引用清空；晚到 decode 不恢复旧缓存 |

独立复审首次发现并已修正：4× 慢帧错误触发历史失效，以及冻结徽标覆盖未知层提示。
前者现有 >8 tick 自然时钟推进的纯函数测试和真实 4×/60ms 主线程停顿检查；后者已分开定位并检查 W5 截图。

## 真实 Nuke 对照

实际输入 `.demo/nuke.dem`，471606780 B；使用前重新校验 SHA-256：
`dea9382b9cc263fed9ee4ed7e71fa6be8c176cf888868f05b26d850af6f5cb3c`。
本机 built Electron、断网、1280×800；复用仓库 Electron/CDP 流程。会话未提供 Browser skill，未安装浏览器依赖。
不是安装版或独立人工 walkthrough。

五窗实际完成自动/主层/下层 × 1×/1.5×/4×，另完成跨 Chunk、4× 自然跨回合，以及 **1× 完整 R1/R2 到 R3**。
总计 48 段、106101 次实际 paint；完整连播 86615 次 paint、743245 次可绘玩家机会。
完整连播可绘遗漏 0、底图与前景层不一致 0；2 次当前 Chunk 等待合计 13.5ms，等待时钟不前进。

下表是**错误整图空白累计墙钟 ms**，不是所有零玩家画面的时长。相同独立 oracle 分别读取原 S0 trace 与新 S1 trace，
按每段播放中此前真实可靠目标位置重建楼层；不信任产品自己的 retained/unknown 标签。
手动空楼层、原生无行和冷 Seek 无历史均不算错误。

| 窗口 | 回合 / tick | 目标 | S0 1× 自动 | S1 1× 自动 |
| --- | --- | --- | ---: | ---: |
| W1 | R1 / 4352–4356 | rain | 1602.6 | 0.0 |
| W2 | R2 / 18393–18395 |  karrigan | 1628.8 | 0.0 |
| W3 | R1 / 4752–4760 | magixx | 115.1 | 0.0 |
| W4 | R2 / 16417–16425 | chopper | 22.5 | 0.0 |
| W5 | R10 / 83106–83114 |  karrigan | 0.0 | 0.0 |

- 48 段总计：S0 105694 次 paint 中错误空白 **9205 帧 / 13 段 / 30770.6ms / 最长 24374.1ms**；S1 106101 次 paint 中全部为 **0**。总计包含刻意重复场景，不代表全比赛发生率；帧率、段末轮询截断不同，不能当逐帧配对。
- 目标真实楼层未知仍存在：同一 oracle 下 S0 9730 次、S1 9738 次；没有通过补位置减少未知。展示层未知与目标层未知是不同指标。
- W1 精确 tick4354 的纯函数回归用实际同型死亡边界证明目标 XYZ 为空、其余 9 人可画。真实正向 paint 最接近 tick4354 的记录为 **4353.9328**：目标 XYZ=null、主层 retained、数字标记/绘制均为 9。该记录不是宣称原生 tick4354 的坐标，也不是冷 Seek 结果。
- W3 在目标可靠 Z 重新出现后立即切下层；新层无人时仍可零玩家（本次 1× 最长 127.0ms），不计错误整图空白。W4 同理，不生成跨层 XY 插值。
- W5 原生缺行保留：自动模式 1× 仍有约 250.2ms 合理零玩家画面；该窗错误空白本就不应计数为可恢复位置。全 67 个 native 缺 tick 没有伪造补齐。
- 主运行 141 个真实 preload/Main/worker 块的 frames 指纹和区间与 S0 独立源相同；补充生命周期运行再次核验全部 141 块的 frames、events、utilities、blinds、burns 内容指纹。指纹为 FNV32 回归比较，不是密码学完整性保证。

实际生命周期 PASS：冷/暖/反向 Seek、手动/自动、暂停/恢复、倍速、快速切玩家、慢帧4×、隐藏 Tab 图片复用、重新导入旧图片释放、旧历史不污染新 Session。
S0 故障解释测试保留；新增 S1 回归明确证明其他玩家可画，不删除旧测试或放宽位置断言。

## 截图与环境

实际截图、每次 paint trace、进程记录和日志在 Git 忽略的 `.tmp/p7-nuke-s1/`；未提交大体积本地产物。

- `w1-跟随玩家-played.png`、`lifecycle-w1-retained.png`：自然播放后目标阵亡，底图/其余9人/未知提示并存。
- `w1-跟随玩家-tick4354.png`、`lifecycle-cold-death-unknown.png`：冷 Seek 保持未知并提供手动选择。
- `w3-跟随玩家-played.png`、`w4-跟随玩家-played.png`：新可靠层恢复；各手动层截图另存同目录。
- `w5-跟随玩家-tick83110.png`：楼层未知和冻结阶段提示各自可见。
- `.tmp/p7-ui-qa/`：Dust2 1024×640、1920×1032 的真实 Electron CDP viewport 检查；不冒充物理窗口拖动或多显示器 DPI 测试。

页面身份/非空内容/无框架错误界面/运行时异常/交互/截图均检查；Nuke 主及补充运行异常数组为空，Dust2 两套验收 PASS。
Canvas 原生数字标记调用与计数相符；诊断器在 paint 后只读当前 React refs 和缓存，不改 LRU，不保存位置到产品。

## 跨地图与性能

Dust2 使用实际 `.demo/dust2.dem`，SHA-256 `db90fe85aab023a1d2c8a5996182e6120d98ef494f02a070b17982b235e4958c`。
单层、事件、时间轴、播放/暂停/连续回合、玩家位置、utility效果、旧会话清理通过，`reportUnchanged=true`，fingerprint 保存在 JSON。
Vertigo 本地没有真实 DEM，仅验证现有几何/合成位置和 Z=11700 共享边界、11701 主层、11699 下层；**真实 Vertigo NOT RUN**。

| 指标 | Nuke S1 | Dust2 回归 |
| --- | ---: | ---: |
| 完整 UI 导入 | 6391ms | 7905.8ms |
| 首个可画回放帧 | 126ms | 132.5ms |
| 实际 Chunk IPC p95 | 8.2ms / 141块 | 5.4ms / 12次抽样 |
| Canvas 绘制 p95 | 120次滚动p95快照的95分位 0.4ms，最高0.6ms | 0.3ms |
| Utility OS 历史峰值 | 1361367040 B（主运行及补充生命周期最大） | 导入结束历史峰值1702916096 B |
| 有限底图资源 | 2×1024²，PNG 193482 B | 单层图片 |

Nuke 主运行导入结束历史峰值 1358856192 B，后半完整连播到释放的13次只读OS观察未上升；
补充运行在导入、生命周期前与重导入后再采峰值，最大为上表值。记录的是各进程已报告的历史峰值，非同时整应用总内存。
Nuke 解码 RGBA 估算共 8388608 B（8MiB），相对旧单图片多约4MiB；这不是实测 OS/GPU 增量，浏览器额外开销未单独测得。
已验证同一两张图片跨模式/未知/Tab/Seek复用，并在 Session 清理；没有引入全局多地图缓存。
绘制与空白指标有只读诊断探针开销，不宣称无探针 FPS 或全应用恒定帧率。
历史 Replay 查询 ≤5s 预算仍独立跟踪，**本轮 native 查询独立计时 NOT RUN**；没有顺手优化 Parser。

## 验证、失败记录与交付

| 命令/范围 | 结果 |
| --- | --- |
| `pnpm typecheck` | PASS，15/15 |
| `pnpm build` | PASS，8/8，含资源摘要 |
| `pnpm --filter @cs2-analyst/desktop test` | PASS，164/164，0 skipped |
| `node --test apps/desktop/tests/replay-floor*.test.mjs apps/desktop/tests/replay-map-images.test.mjs` | PASS，11/11（已包含 Desktop，不重复计数） |
| `node scripts/replay-nuke-electron.mjs --s1` | PASS，45矩阵+2边界+完整R1/R2+生命周期 |
| `node scripts/replay-nuke-electron.mjs --s1 --lifecycle-only` | PASS，补充生命周期与141块全部内容对照 |
| `node scripts/replay-nuke-fix-report.mjs` | PASS，独立重新审计S0/S1原始trace |
| `node scripts/replay-smoke.mjs` | PASS，真实Dust2，fingerprint不变 |
| `node scripts/p7-ui-acceptance.mjs` | PASS，真实Dust2及两分辨率 |
| `git diff --check` / `git ls-files '*.dem'` | PASS / 空输出，无DEM进入Git |
| 独立聚焦复审 | 初审两项已修复；生产复审与最终证据复核见交付记录 |

失败记录没有计入 PASS：初轮完整脚本对 W5 错误要求“沿用层时一定有玩家可画”，
已纠正为该原生全员缺行场景可零玩家，再从头重跑正式矩阵及完整R1/R2。
Dust2 UI 两次在旧合成行截图辅助函数失败，诊断 row.top=604/list.top=606，贴边滚动裁2px；
仅将测试滚动定位改为容器内居中，保留原“整行可见”严格断言，并补诊断及失败截图作用域修复，随后完整 PASS。
没有通过改事件列表/CSS或放宽断言通过。各失败日志保留 `.tmp/p7-s1-*-failed.log`。

修改文件：Renderer `replay-player.tsx`、新增 `replay-floor.ts` / `replay-map-images.ts`；
新增 `replay-floor.test.mjs` / `replay-map-images.test.mjs` / `replay-floor-audit.test.mjs`；
扩展 `scripts/replay-nuke-electron.mjs` 与测试截图辅助 `scripts/p7-ui-acceptance.mjs`，
新增 `scripts/replay-floor-audit.mjs` / `scripts/replay-nuke-fix-report.mjs`；
本报告/JSON、`docs/replay-contract.md`、`docs/replay-implementation.md`、`docs/p7-final-hardening-plan.md`。
依赖方向与领域契约未改变；Parser、Match、Analytics、Findings、Deep Review 生产源码未改。

**NOT RUN / 剩余限制**：真实 Vertigo、全21回合每显示帧播放、所有目标组合、真实断连、安装包、独立人工walkthrough、物理多屏DPI；
dem-parser/Analytics/Findings/Deep Review独立全套（Desktop所需构建和相关真实测试已执行）；
底图新增 OS/GPU 内存增量专项测量。地图与 DEM 版本配准仍未确认，不证明拓扑、LOS 或穿层可见性。
正常空楼层、原生缺行、冷 Seek 无历史继续诚实降级。按授权提交并推送 `origin/main`，最终工作区/远端状态见交付消息。
