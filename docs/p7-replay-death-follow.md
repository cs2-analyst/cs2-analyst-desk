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
- 全员确认死亡时，保留跟随链中最后实际可靠观测的楼层 ID；若链没有楼层证据，可保留同一 session/match/map/resource 中最后真正绘制过的背景（包括手动选择的背景）。2026-10-20 补验后，提示统一为“全员阵亡 · 底图仅作参考，不代表当前楼层”，无历史背景的全死会话可显示地图首张参考纹理。这些状态不包含 XYZ，不把背景当作死者当前楼层，不恢复死者坐标。新会话/资源不继承背景；存活或未知生命状态在没有可靠楼层时仍显示未知，允许手动选层。
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

**真实 DEM 全死 Electron 仍 NOT RUN（受控 Electron 补验 PASS 见下文）**：已找到的真实 C4 全死事件都在现有正式 Replay 回合终点之外，
本轮没有扩大窗口，不能将这些 native 事实当作 UI PASS。全员死亡（C4/HE/自杀/未知）、死亡 tick 缺行、
同 tick 冲突、复活/断连、无最终目标楼层及 stale true 等在合成测试中通过；不冒充真实 DEM 证据。
安装包、独立人工 walkthrough、物理多屏 DPI、所有回合/目标/倍速组合、各领域包独立全套和 native 查询预算没有专项重跑。
存活或未知生命状态缺少可靠楼层时保持未知；确认全死且无历史背景时可显示明确标注的参考纹理，不将其视为当前楼层。地图与 DEM 版本配准仍未确认。

历史 S0/S1 原始报告和证据保持不变；本轮不以旧 `--s1` 脚本中“死亡后必须仍跟随死者”等已被新需求取代的断言作为验收标准。

## 2026-10-20：全员阵亡专项补验

继续现有 `codex/p7-replay-death-follow`，基线 `b7002ff58048496965148e8c0fb599464224c64a`。
结构化补验索引：[p7-replay-all-dead.json](./p7-replay-all-dead.json)。最终提交 SHA 见交付消息和 Git 历史。

### 真实 DEM 检查与证据分类

先执行 `node --expose-gc scripts/replay-all-dead-scan.mjs`，逐个校验本地文件 SHA-256，
读取 native 非热身死亡事件，在全部 1284 个不同死亡 tick 查询完整 10 人 `is_alive`，与未修改的
`convertToMatch → planReplay` 默认正式窗口比较。1284/1284 查询具有完整明确的生死状态。
扫描 Nuke、Dust2、Inferno、Mirage、Ancient、Anubis、Overpass、demo1、demo2 共 9 个适用输入；
`demo.dem` 不存在；`train.dem` 按 `docs/demo-fixtures.md` 明确的 “do not run it or add tests” 排除，demo3 不在本轮白名单。
没有修改、复制或下载 DEM，没有扩大正式窗口或采样预算。

| 已确认全死的 native tick | 正式回合终点 | 超出 tick |
| --- | --- | --- |
| Nuke R6，51114 | 50844 | 270 |
| Dust2 R12，104292 | 103058 | 1234 |
| Dust2 R24，202604 | 201562 | 1042 |
| Ancient R19，150889 | 150403 | 486 |
| Overpass R12，100477 | 99778 | 699 |
| demo1 R24，141061 | 140769 | 292 |
| demo2 R18，107030 | 106551 | 479 |

正式窗口内确认全死事件为 **0**。因此本专项的 **真实 DEM + 真实 Electron：NOT RUN**。
上述扫描是 native 源事实，不能计为 UI PASS。文件身份、所有正式窗口、全死 tick 原始行见
`.tmp/p7-all-dead/native-inventory.json`；提交的补验 JSON 保存摘要和哈希。

### 受控 DTO + 真实 Electron

命令：`node scripts/replay-all-dead-acceptance.mjs`。
测试专用 `scripts/fixtures/replay-all-dead/` 有独立 Electron main/preload/HTML/renderer，
通过测试 IPC 返回 DTO/Chunk，直接导入**现有 ReplayPlayer、Fluent UI、图片资源、Canvas 绘制代码**。
实际执行组件加载、三块缓存、时钟、Seek、跟随、楼层、道具和绘制流程，没有直接调用纯函数代替 UI。
Browser skill 不可用；按用户明确要求复用仓库 Electron/CDP 验收方式，没有引入浏览器依赖。
测试 Electron 保持 sandbox、contextIsolation，关闭 nodeIntegration；没有更改生产注入边界。

坐标值来自本轮重新查询的 Nuke tick18000 native 快照，逐值复用或设为 null；没有为死者补坐标。
测试时间线、生死归属、重复快照帧及道具窗口为**受控 presentation 输入**，均不宣称是 DEM 中实际发生的事件。
C4 组是同 tick 爆炸事件与剩余两人阵亡；HE 组有已死 thrower 的测试 HE burst；所有组另用测试 smoke 验证到期清理。
不声称验收了 C4/HE 的游戏物理或 native 致死解析。

| 受控场景 | 1024×640 | 1920×1032 |
| --- | --- | --- |
| C4 爆炸，同 tick 剩余玩家全部阵亡 | PASS | PASS |
| 最后存活者被已死亡对手 HE 击杀 | PASS | PASS |
| 最后一名玩家自杀 | PASS | PASS |
| 最后一名玩家被未知攻击者击杀 | PASS | PASS |
| 最后目标死亡前缺位置，仍有可靠历史楼层 | PASS | PASS |
| 最后目标从未有位置/楼层：冷定位、手选参考和自动参考 | PASS | PASS |
| 上述各组重复/同 tick/反向/冷 Seek、暂停恢复、自然跨 Chunk | PASS | PASS |

检查真实 Canvas RGBA 彩色像素、底图纹理指纹、实际数字玩家标记绘制调用、前景像素、楼层状态、
侧栏、跟随身份和 smoke 到期；不是仅检查 DOM 或 `imageReady`。每组自然播放跨测试块 2→3→4，
冷 Seek 前确认块 3 已由正常缓存策略逐出。全死后玩家绘制数和标记调用均为 0，跟随身份保持不变；
同 tick 重复定位的底图、前景指纹及状态一致；到期前景完全透明。
Canvas 每 RAF 绘制，侧栏/提示沿用产品原有提交节奏：逐帧检查像素/绘制状态，稳定定位另严格检查全部侧栏阵亡和提示。

新会话无楼层历史时，**全死之前**仍是 unknown，不伪造当前楼层；首次直接定位到确认全死 tick 后，
允许显示明确的参考纹理，`floorStatus=retained`，不是 known。反向定位回无位置的存活阶段恢复 unknown、
底图透明，证明参考纹理没有被当成活人当前层。可靠历史楼层始终优先，保留实际对应纹理。

截图及原始逐帧 JSON 在 `.tmp/p7-all-dead/fixed/`。每组每尺寸有 `*-before.png`、`*-death.png`、
`*-after.png`；无楼层组另有 `*-cold-all-dead.png`、`*-manual-reference-death.png`。
共 40 张 PNG，逐张记录路径、尺寸和 SHA-256；`electron.json` 保存状态和索引，`*-frames.json` 保存实际绘制采样。
已目视检查两尺寸的 C4 前/中/后，以及缺位置、HE、无楼层手动/自动参考图；地图和提示可见、未被占位遮盖。

### 最小产品修复与隔离

修复前先记录复现、根因与范围：

- `.tmp/p7-all-dead/product-defect-before-fix.json`：无空间证据的手选参考被称为“最后可靠底图”，手动模式又缺少提示；原始证据在 `baseline-reference/` 的 1024×640 手动/自动截图和 JSON。
- `.tmp/p7-all-dead/cold-background-defect-before-fix.json`：全新无历史会话直接定位全死 tick 仍空图；双尺寸真实 Electron 证据在 `baseline-empty-reference/`。这是提示修复后的中间版本、参考回退修复前的复现，不冒充原始基线全套 PASS。

产品只改 `replay-player.tsx` 两处：确认全死且没有历史/已绘制背景时，使用地图首张纹理作参考；
全死的自动和手动模式统一提示“全员阵亡 · 底图仅作参考，不代表当前楼层”。
没有更改 follow/floor 解析函数、坐标、死亡链、Parser、ReplaySession、IPC 或领域包。

`node scripts/replay-all-dead-package-audit.mjs` 检查生产构建输出和现有安装器 `dist/**` 白名单，
未发现测试入口/夹具标记。测试编译到 `.tmp/`，不进入生产 `dist/`。本轮没有制作安装包；
不能把构建输出审计写为已安装包验收。未改版本、tag、release，没有进入 P8 或合并 main。

初次探针失败记录单独保留在 `.tmp/p7-all-dead/initial-*-attempt/`：误识别图片缓存、把 RAF 与 UI 提交当成同一时刻，
以及测试窗口原生装饰栏使 1920 宽视口被系统钳为 1904。修正测试后实际双尺寸重跑，不计初次结果为 PASS。
`before-cold-reference-fix/` 是补齐 fresh 无历史场景之前的中间测试集，同样不作为最终完整专项结果。

### 回归与剩余范围

最终命令、结果、日志、独立复审结论见补验 JSON。必须将三类证据分开：
真实 DEM 全死 Electron NOT RUN；受控 DTO 全死 Electron PASS；纯函数/合成单元测试 PASS。
Desktop 194 项（含相关 Replay/Heatmap 集成）与聚焦 29 项不能重复相加为测试总数。
产品修改后重新执行 typecheck、build、Replay smoke、Heatmap smoke，以及真实 Nuke 死亡跟随 Electron 回归；
真实 Nuke 回归只证明原有真实死亡场景没有回退，**不能补成真实 DEM 全死 PASS**。

| 最终验证 | 结果 |
| --- | --- |
| 全员阵亡受控 Electron 专项 | PASS，12/12；40 张 PNG；9482 次实际绘制采样 |
| Replay Follow / Floor / Session | PASS，29/29 |
| `pnpm --filter @cs2-analyst/desktop test` | PASS，194/194，0 skipped |
| `pnpm typecheck` | PASS，15/15 Turbo tasks |
| `pnpm build` | PASS，8/8，含雷达资源校验 |
| `node scripts/replay-smoke.mjs` | PASS，真实 Dust2，`reportUnchanged=true` |
| `node scripts/heatmap-smoke.mjs` | PASS，真实 Dust2，30 次 IPC 与缓存重复 |
| `node scripts/replay-death-follow-acceptance.mjs` | PASS，真实 Nuke，141 块、普通死亡跟随及自然跨回合 |
| `node scripts/replay-all-dead-package-audit.mjs` | PASS，93 个生产输出文件，测试夹具未进入输出白名单 |

独立 reviewer 只读复审 **PASS，无剩余 P1/P2**；独立核对 native/fixture/产品与原始证据 SHA、
12 个 PASS run、40 张 PNG 的实际尺寸及哈希、12 份 trace 共 9482 次采样，以及全部命令日志和证据分类。
源 diff 及 `git diff --check` 通过。

仍未覆盖真实 DEM 正式窗口内的全死 UI、安装包/人工 walkthrough、物理多屏 DPI 和所有回合/目标/倍速组合。
地图与 DEM 版本配准未确认；受控样本不证明 native C4/HE 物理/解析。完成提交推送后停止，等待人工验收。
