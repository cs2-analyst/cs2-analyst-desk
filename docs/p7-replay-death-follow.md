# P7 Replay：死亡后的观战目标

2026-10-19。基于最新 `origin/main` `91e4284`，独立分支 `codex/p7-replay-death-follow`。
本轮仅修复 Replay 展示状态；没有修改版本号、tag、release、Parser、Match、Analytics、Findings 或 Deep Review 生产逻辑。
最终提交 SHA 见交付消息及 Git 历史，避免在提交内自引用。

## 根因与实际复现

真实输入 `.demo/nuke.dem`，471606780 B，重新校验 SHA-256：
`dea9382b9cc263fed9ee4ed7e71fa6be8c176cf888868f05b26d850af6f5cb3c`。
R2 起点 tick8833；karrigan 在 tick18395，即 +149.40625s，被 donk（`76561198386265483`）的 deagle 爆头击杀。
原始 `player_death` 附带 `user_is_alive=true`，但相同 tick 的最终 native 状态明确为 false；donk 和另外八人存活。
不能将事件附带的旧 Pawn 属性当作最终生命周期状态。

原 Replay 没有死亡后切换目标的逻辑，单个块的事件又不足以重建此前的死亡链。
显式 Seek 清空自动楼层历史后，已死目标没有可靠展示位置，底图同时被清空。
本轮真实 built Electron 基线在 tick18395 重现：侧栏仍选中阵亡 karrigan，底图像素为空，绘制玩家数为 0。
基线不是根据旧报告推断；实际截图和 JSON 保存在 `.tmp/p7-death-follow/baseline/`。

## 实现与边界

- `ReplaySession` 只投影已有领域证据，给各块加入相同的整回合 `follow` 上下文：准确死亡归属、存活/死亡集合变化、可靠观测的楼层 ID 变化。已有帧、事件和道具内容不变；1MiB/块、64MiB/会话、Renderer 三块缓存上限不变。
- 死亡及生命周期在同 tick 原子处理。死者、同 tick 阵亡攻击者、已死手雷投掷者、断连或未知状态者不能成为新目标。真实死亡或可靠死亡观测保持死亡，只有明确的有效 spawn 才允许恢复。断连不等于阵亡，缺行不等于全员死亡；矛盾 spawn/death 保持未知，重复矛盾归属降级为未知攻击者。
- Renderer 从用户最后一次明确选择的玩家身份开始，按时间重建跟随链。确认存活的真实击杀者优先；只有 killerId===victimId 才是自杀，null/world 始终是未知。替代目标从排序后的真实存活集合中，用 matchId、回合和稳定死亡 ID 做种子选择，不依赖 `Math.random`、帧率或缓存顺序。
- 死亡 tick 缺少候选时等待第一个可靠存活集合，并重建这一次选择，后续集合改变不会重新抽取同一事件。可靠死亡观测没有击杀事件时只做未知归属切换，不伪造击杀事件。权威死亡集合同时约束侧栏、地图标记和楼层确认，防止 stale true Pawn 行复活尸体或改写背景。
- 自动切换不覆盖用户选择的起始身份；手动选人更新该身份。重复、同 tick、正向、反向、冷 Seek、跨块和自然播放使用同一纯函数。自然进入下一回合从该手动身份重新计算，与定位下一回合一致。
- 全员确认死亡时，保留跟随链中最后实际可靠观测的楼层 ID；若链没有楼层证据，可保留同一 session/match/map/resource 中最后真正绘制过的背景（包括手动选择的背景）。提示明确为“全员阵亡 · 保留最后可靠底图”。这些状态不包含 XYZ，不把背景当作死者当前楼层，不恢复死者坐标。新会话/资源不继承背景；从未有过可靠观测或已绘制背景时仍诚实显示未知，允许手动选层。
- 冷块加载期间保留上一底图、清空前景，待该块证据就绪再提交新展示状态。缺行、跨层、最大插值间隔等原有坐标约束未放宽。

`report-contract` 为可选字段的兼容扩展；旧无 `follow` 的块保持原有展示行为。
数据方向仍为 `dem-parser → match-model → Desktop presenter → report-contract → Renderer`，没有让 Renderer 调用 Parser 或重算分析指标。

## 验证证据

机器摘要：[p7-replay-death-follow.json](./p7-replay-death-follow.json)。
截图、native 原始证据、每块摘要、Electron 轨迹、运行日志保留在 Git 忽略的 `.tmp/p7-death-follow/`，没有提交 DEM 或大体积产物。
测试/验收脚本为 `scripts/replay-death-follow-acceptance.mjs`；`--baseline` 仅用于旧构建复现，修复后不应通过基线断言。

真实 built Electron/CDP，1280×800；未提供 Browser skill，使用仓库既有 Electron 验收流程，没有新增浏览器依赖。
四个最终运行均核对页面身份、非空页面、无框架错误、Canvas 真实底图像素、侧栏与地图目标一致、截图和交互。
没有应用异常或相关控制台错误；各有一个未打包 Electron 既有 CSP 开发环境提示。

| 真实场景 | 确认事实与结果 | 连播观测 / Chunk |
| --- | --- | --- |
| Nuke R2 tick18395，+149.40625s | karrigan→存活 donk；重复/同 tick/反向/冷 Seek 一致，另核对三回合普通击杀、自然进入 R3 恢复手动身份 | 798 帧 / 6→7 |
| Ancient R19 tick150403，+88s | magixx 自伤 HE；当时仅 karrigan/frozen 存活，稳定选择 karrigan；重复/反向/冷 Seek 一致 | 658 帧 / 3→4 |
| demo1 R22 tick121153，+32.78125s | twinkle 被已死亡 tarkz 的 HE 击杀；在 7 名真实存活玩家中稳定选中虎嗅蔷薇，排除已死攻击者 | 842 帧 / 0→1 |
| Ancient R7 tick57874，+141.1875s | ropz 被 planted_c4 杀死，攻击者 null；保持 unknown，选择唯一存活 zont1x，未归为自杀 | 142 帧 / 6→7 |

Ancient SHA-256：`ca7b6b7cefdde927d654ac101ea1bee4fd996efc9b86ac89dac33874a0115f4e`（403039766 B）。
demo1 SHA-256：`f3c3173eae0cd100d15c81c3b734be792f9212256a9c99703b358d3434000852`（267275583 B）。
上述帧为有只读诊断探针的实际 paint 观测，不是独立 native tick，也不作为无探针 FPS 承诺。
Ancient 自杀正好在正式回合终点，检查该终点时关闭连续进入下一回合；Nuke 独立验证自然跨回合。
demo1 目标块被邻块预取保留，因此该事件只证明直接定位，**不声称该事件的未缓存冷 Seek PASS**；冷 Seek 在 Nuke/Ancient 另有实际证据。

Nuke 141 个真实 IPC 块逐块核对整回合 follow 一致性，142 次 native 死亡的真实归属和存活候选全部核对。
既有 frame/event/utility/blind/burn 内容与同 SHA 的保留源逐块 FNV32 指纹一致；这是非密码学回归比对，不能替代完整性证明。
实际 IPC 最大块 369573 B、会话 29834152 B，均低于原限制；follow 重复序列化文本共 790019 字符。
独立 public parse→ReplaySession 核验另记在 transport-evidence.json，字节口径/会话 ID 不同，不混作同一测量。

| 命令 | 最终结果 |
| --- | --- |
| `pnpm typecheck` | PASS，15/15 Turbo tasks |
| `pnpm build` | PASS，8/8，含雷达资源摘要校验 |
| `pnpm --filter @cs2-analyst/desktop test` | PASS，194/194，0 skipped |
| `node --test apps/desktop/tests/replay-follow.test.mjs apps/desktop/tests/replay-session.test.mjs apps/desktop/tests/replay-floor.test.mjs` | PASS，29/29，已包含在 Desktop 总数 |
| `node scripts/replay-death-follow-acceptance.mjs`，及 `--scenario=suicide` / `posthumous` / `unknown` | 上表四类真实场景 PASS |
| `node scripts/replay-smoke.mjs` | 真实 Dust2 PASS，`reportUnchanged=true`；原 Replay、utility、布局、播放/Seek/清理回归 |
| `node scripts/heatmap-smoke.mjs` | 真实 Dust2 PASS，30 次 IPC、缓存重复、Heatmap/Report 回归 |
| `node scripts/p7-report-layout-acceptance.mjs` | demo1/demo2 PASS，1024×640 / 1920×1032、警告/空/错误状态 |

Dust2 SHA-256：`db90fe85aab023a1d2c8a5996182e6120d98ef494f02a070b17982b235e4958c`。
报告与热力图截图/机器结果分别在 `.tmp/p7-s5-qa/`、`.tmp/p73-qa/`；本轮执行日志在 `.tmp/p7-death-follow/`。
独立复审发现的背景链、stale alive、尸体断连、冲突归属、Renderer 状态一致性问题均已修正，并通过 29 项聚焦测试。
另有审查者的 500 条生成时间线 / 20994 次检查通过，作为补充审查，不计入仓库测试数量。

失败记录保留，未计入 PASS：旧 Replay smoke 手动选择已死 ropz 后强制要求保持选中的断言与新需求冲突；
改为选择实际存活玩家并严格核对侧栏和 Canvas，随后完整重跑通过。Ancient 初轮验收脚本定位超过回合终点、
demo1 初轮错误假设目标块未缓存，均在修正验收条件后重跑；JSON/日志保留对应 initial-*-attempt 文件。

**NOT RUN / 剩余限制**：全员死亡真实 Electron 回放；已找到的真实 C4 全死事件都在现有正式 Replay 回合终点之外，
本轮没有扩大窗口，不能将这些 native 事实当作 UI PASS。全员死亡（C4/HE/自杀/未知）、死亡 tick 缺行、
同 tick 冲突、复活/断连、无最终目标楼层及 stale true 等在合成测试中通过；不冒充真实 DEM 证据。
安装包、独立人工 walkthrough、物理多屏 DPI、所有回合/目标/倍速组合、各领域包独立全套和 native 查询预算没有专项重跑。
从未有可靠楼层或已绘制背景时保持未知，不伪造底图归层；地图与 DEM 版本配准仍未确认。

历史 S0/S1 原始报告和证据保持不变；本轮不以旧 `--s1` 脚本中“死亡后必须仍跟随死者”等已被新需求取代的断言作为验收标准。
