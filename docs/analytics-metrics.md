# P3 核心指标、KAST / Trade / Clutch 与覆盖机制

```text
P3 Analytics Engine — FINAL PASS
Analytics public contracts frozen for P4 Findings
```

本文记录 P3 确定性指标的**计算口径**、统一的 **coverage / eligibility** 规则，以及真实 `demo1.dem` 的 golden 结果与人工复盘对比。实现位于 `packages/analytics`，只依赖 `match-model` 领域类型，不引用 demoparser2 原始类型。

范围（P3.1）：K / D / A、K/D、HS%、rounds played、reported damage / reported ADR、effective damage / 标准 ADR、CT/T split、multi-kill、opening kill / opening death。

范围（P3.2）：统一存活/时序上下文、KAST（K/A/S/T）、trade kill / traded death / tradeable death、clutch opportunity / clutch win。

范围（P3.3）：release 投掷统计、HE/fire 有效敌伤、enemy/team/self flash 受害者事件与原始 duration、事件证明的 flash assist。

完整 P3.3 指标定义、lifecycle/overlap/assist 策略、coverage 门控与 twinkle golden：[Utility Analytics](./utility-analytics.md)。

非目标：Findings、AI、UI、trajectory/lineup、位置热力图、utility CT/T split。

证据文件：`.demo/demo1.dem`，SHA-256 `f3c3173eae0cd100d15c81c3b734be792f9212256a9c99703b358d3434000852`，64 tick，`de_dust2`，10 名玩家，24 个正式回合。

复算命令：

```powershell
pnpm --filter @cs2-analyst/analytics test
```

测试在缺少 DEM 时跳过真实样本，仅保留合成回归。

## 指标定义与计算口径

所有事件先经过统一回合窗口过滤：只有 `round_start` 与 `round_end` 都存在（`eventEligible`）的回合才参与事件类指标，且仅统计 `startTick <= tick <= endTick` 的事件。post-round 事件（parser 会保留到下一回合 start）因此被排除。

| 指标 | 口径 |
| --- | --- |
| `kills` | 有效窗口内 `killer === player` 且 `teamkill !== true` 的击杀。确认的 teamkill 不计；teamkill 状态未知仍计入并记录 coverage。 |
| `deaths` | 有效窗口内 `victim === player` 的死亡，包含被击杀、自杀与世界/环境死亡。teamkill 造成的死亡仍算死亡。 |
| `assists` | `assister === player`，且击杀是**可识别敌方击杀**（killer 非 `world`、killer/victim 双方 side 已知且敌对），并且 `assisterSide === killerSide`、`assister !== killer`。 |
| `kdRatio` | `kills / deaths`；`deaths === 0` 时为 `null`，不虚构数值。 |
| `headshotKills` / `headshotPercentage` | HS kills / 已知 headshot 状态的计入击杀 × 100；无已知状态时为 `null`。 |
| `roundsPlayed` | 有效窗口且所选快照 `participant === true` 的回合数，同时作为 ADR 分母。 |
| `reportedDamage` | 计入回合内 `DamageEvent` 中 `attacker === player` 且双方 side 已知且敌对的 `healthDamage` 之和。**原始上报证据**，保留 overkill。 |
| `reportedAdr` | `reportedDamage / roundsPlayed`；`roundsPlayed === 0` 时为 `null`。基于上报伤害，**不是**标准 ADR。 |
| `effectiveDamage` | 同一批计入伤害行的**实际敌方 HP 损失**之和；单次伤害被受害者受击前剩余 HP 截断。见下节。**可能是“已确认有效伤害部分”**：当 `coverage.effectiveDamageUnresolved > 0` 时只包含可解出的伤害行。 |
| `adr` | **标准 ADR**：`effectiveDamage / roundsPlayed`。`roundsPlayed === 0`，或 `coverage.effectiveDamageUnresolved > 0` 时为 `null`：后者是因为分子只覆盖部分计入伤害、分母覆盖全部计入回合；宁可不给标准 ADR，也不输出部分口径的误导数值。`reportedAdr` 不受此门控影响。 |
| CT/T split | 每个计入回合按**该回合所选快照的 side**把 kill/death/assist/reportedDamage/effectiveDamage/unresolved/round 归入 CT 或 T；绝不使用全局 `Player.team`。每侧输出 `reportedAdr`、标准 `adr` 与逐侧 `effectiveDamageUnresolved`；某侧存在 unresolved 时该侧 `adr = null`，另一侧不受影响。 |
| `multiKills` | 每个有效回合内该玩家的计入击杀数；`counts[2..5]` 为对应击杀数的回合数，key `5` 表示 5 杀及以上；`maxKillsInRound` 为最大单回合击杀。 |
| `opening` | 每个有效回合最早 tick 的击杀为该回合 opening duel。唯一最早击杀且为可识别敌方击杀时，killer 记 opening kill、victim 记 opening death；同一最早 tick 出现多杀记为 contested，不应归属玩家；最早击杀为 world/teamkill/side 未知记为 unattributed；回合内无击杀记为 absent。 |

### reported damage 与 standard effective damage 的区别

`player_hurt` 的 `dmg_health` 是**上报伤害**，不是实际扣血量。样本 tick 2287 对满血 100 HP 的目标上报 `dmg_health: 109`、`health: 0`：按 reported 计入 109，按 effective 只能计入 100。因此 reported ADR 会在高伤害武器（AWP / AK 爆头）与收尾补枪上系统性偏高。

`effectiveDamage` 只统计受害者 HP 的**实际减少量**：

- 单次命中 `loss = preHurtHP - healthRemaining`，天然被 `preHurtHP` 截断，不超过受害者受击前剩余 HP。
- 只统计**敌方**伤害行；自伤（`attacker === victim` / `world`）与友伤（同 side）经 `isEligibleDamage` 剔除，但它们**仍然参与受害者 HP 轨迹**，因为它们改变剩余 HP。
- warmup 由 parser 以 `is_warmup_period` 过滤；post-round 由统一回合窗口 `[startTick, endTick]` 剔除。
- 每个 victim 每回合的 HP 轨迹从 competitive 出生满血 100 开始。每个有效回合的**第一个**命中都会用 100 校验，因此“回合开始时已经受伤/补满”会被记为链条断裂，而不是静默接受一个更低或更高的起点。
- 上报 `dmg_health` 只用于**校验**，不直接进入 effective。demo 的 `dmg_health` 是整数，而上报的 `health` 是截断后的余量，因此单发实测损失可能恰好比上报伤害多 1。实测损失落在 `[min(dmg_health, preHurtHP) - 1, min(dmg_health, preHurtHP) + 1]` 内视为一致；超出该区间说明 HP 轨迹缺少证据（治疗、回合内重生、漏记伤害），该命中不计入 effective 并记 coverage——**不猜**。
- 无法从 `healthDamage + healthRemaining` 推出可信损失时，通过 coverage 标记而不估计数值；被跳过的命中仍保留在 `reportedDamage` 中，并由逐玩家 `coverage.effectiveDamageUnresolved` 计数。

因此 `effectiveDamage` 有两种可能语义：**完整口径**（`effectiveDamageUnresolved === 0`，所有计入敌方伤害行都已解出）与**已确认部分**（仍有未解行）。`adr` 只在完整口径下输出数值：

- 部分口径下分子 `effectiveDamage` 只含已解出的伤害行，而分母 `roundsPlayed` 覆盖全部计入回合，两者口径不一致，会让标准 ADR 系统性偏低；
- 因此 unresolved 存在时 `adr = null`；消费者应改用不受门控的 `reportedAdr`（原始上报口径），或显式展示 coverage；
- CT/T split 用同一规则，并通过逐侧 `effectiveDamageUnresolved` 指明是哪一侧覆盖不足。若 unresolved 发生在 side 未知的回合，它只出现在 `player.coverage.effectiveDamageUnresolved`，不归入任何一侧。

### assist 口径（与复盘对齐的关键证据）

`player_death.assister_steamid` 在本样本中会记录“最后一名伤害过 victim 的队友”，**即使该玩家与 victim 同阵营**（友伤）。样本中 twinkle 有 2 个这样的记录：

| 回合 | tick | killer（阵营） | victim（阵营） | assister（阵营） | 说明 |
| --- | --- | --- | --- | --- | --- |
| 6 | 28614 | Makoto Nijima（T） | 菠萝抽风（CT） | twinkle（CT） | assister 与 victim 同侧，友伤 |
| 9 | 51859 | tarkz（T） | 用户0001（CT） | twinkle（CT） | twinkle 在 tick 51854 对队友造成 43 友伤后敌人收尾 |

因此 assist 必须要求 `assisterSide === killerSide`。原始 `assister` 字段在该样本给出 twinkle 6 次助攻，符合验收口径的为 **4** 次，与人工复盘一致。其余 9 名玩家两者相同，说明这不是系统性偏差，而是友伤助攻的特例。

### 同 tick 策略

- 事件窗口对 `startTick` / `endTick` **闭区间**，同 tick 的 `round_start` 事件属于新回合（沿用 P2.1 约定）。
- multi-kill 统计同一回合内同 tick 的每个击杀，因为每个 `player_death` 是独立的击杀证据；不声称 tick 内的 subtick 先后。
- opening 在同一最早 tick 有多个击杀时不任选一个，而是标记 contested 并降低覆盖。
- effective damage 在同一 tick 对同一 victim 有多发伤害时，要求上报余量**严格递减且逐发一致**，才接受 demo 数组顺序；否则整组不归属并记 `damage-effective-same-tick-ambiguous`。

## P3.2 统一存活上下文、KAST、Trade、Clutch

### 统一时序与存活上下文

所有 P3.2 指标共用 `buildRoundTimeline(round)`（`packages/analytics/src/timeline.ts`）产出的逐回合上下文，不各自判断状态：

- 起点是统一 coverage 选出的**名单快照**（`freeze_end` 优先，缺失时退化到 `start` 并标记 degraded），记录每个玩家的 side 与 `alive`。
- 只用正式回合窗口 `[startTick, endTick]`（闭区间）内的死亡事件推进状态；post-round 死亡被排除。
- 终点用 `end` 边界快照核验。`survived` 只有在“起点 alive、窗口内无死亡、end 快照该玩家 alive=true”三者同时成立时才为 `true`；**没有死亡事件本身不等于存活**。
- baseline 之后、窗口内的 lifecycle `disconnect` / `spawn` / `side_change`，以及不一致死亡（baseline 非存活者的死亡、同一玩家多次死亡）都记为 anomaly，使该回合的时间线不再被 KAST/Trade/Clutch 采信。2026-10-25 修正：身份明确、baseline 确认存活、该回合仅有一次死亡，且 `baselineTick < deathTick < disconnectTick` 时，死亡后的退出不改变存活集合，不再单独构成 anomaly；原始退出事件仍保留。同 tick 无法确定先后、无死亡证明、未知身份/名单、重生、换边、多次死亡及期末状态冲突继续受原保护。
- 死亡与 end 快照冲突（有死亡但 end 显示存活，或无死亡但 end 显示已死）记 `survival-end-state-conflict`，并使 `timeline.endStateSuspect = true`。KAST 保持不完整覆盖；Trade / Clutch 不再采信该回合的存活时间线。

### KAST

对每名玩家、每个**确认参与**（`playsIn`）的回合判定：

| 分量 | 条件 |
| --- | --- |
| K | 窗口内存在 `isEligibleKill(kill, player)` |
| A | 窗口内存在 `isEligibleAssist(kill, player)` |
| S | `timeline.survived === true`（起点存活 + 无死亡 + end 快照确认存活） |
| T | 该玩家的死亡在 trade window 内被存活队友有效 trade |

判定规则：

- 只要 K、A 或已证明的 T 成立，该回合即 KAST，S 是否可证不影响结论。
- 否则只有 S 被证明为 false（死亡已证）且 T 已被证明为 false 时，才判为 KAST 未达成。
- S 或 T 无法证明时，该回合**退出分母**（unavailable / ambiguous），而不是猜成 miss。
- 输出 `rounds`（KAST 回合）、`eligibleRounds`（分母）、`playedRounds`、`percentage = rounds / eligibleRounds × 100`，以及 K/A/S/T 各自命中的回合数（分量可重叠）。`complete` 仅在 `eligibleRounds === playedRounds` 且无 unavailable / ambiguous / degraded 时为 `true`；有降级时 `percentage` 仍按可证回合给出，但不得当作完整覆盖。

### Trade

- 定义：`trader` 在窗口内击杀 `tradedKiller`，为队友 `tradedVictim`（更早被同一 `tradedKiller` 击杀、且当时仍有存活队友）复仇。一次 trade kill 恰好对应一次 traded death（全场 `tradeKills === tradedDeaths`）。
- 双方事件都必须是**可识别敌方击杀**（killer 非 `world`、双方 side 已知且敌对、非确认 teamkill）；trader 与 victim 同侧且 `trader !== victim`；trader 在复仇击杀时仍存活（因此也在 victim 死亡时存活）。
- 默认 `tradeWindowSeconds = 5`，`windowTicks = round(tradeWindowSeconds × match.tickRate)`。`match.tickRate` 缺失或不可靠时一律**不输出**时间型 trade 结论：`windowTicks = null`、`available = false`、`tradeKills / tradedDeaths` 保持 0、`tradeRate = null`，并记 `trade-tick-rate-unknown`；`tradeableDeaths` 不依赖时钟，仍然输出。
- 同一 `tradedKiller` 在窗口内多次击杀队友时，取**最晚**的一次；最晚 tick 有并列候选时记 `trade-candidate-ambiguous`，不归属。
- 死亡与复仇击杀同 tick 时不声称 subtick 先后，记 `trade-same-tick-ambiguous`，不归属（沿用 opening / 同 tick 伤害策略）。
- `tradeableDeaths`：死亡是可识别敌方击杀，且死亡发生时至少有 1 名队友仍存活。
- `tradeRate = tradedDeaths / tradeableDeaths × 100`；仅在 tick rate 可用、回合上下文完整（未降级）、且该玩家没有被 ambiguous 命中的候选时为数值，否则为 `null`。
- 排除：teamkill、`world` 死亡、任一方 side 未知。
- **参与范围一致性（1:1 的结构保证）**：trade 是两个确认参与者之间的关系。`resolveRoundTrades()` 要求 trader 与 `tradedVictim` 都在该回合 `playsIn()`（正式窗口且 `participant === true`）才生成 trade；`tradeableDeaths` 同样只登记确认参与的死亡。由于 `summarizeTrade()` 按玩家 `playsIn` 过滤，若只对一方加门槛，参与状态不一致的回合会让 trader 记 trade kill 而 victim 不记 traded death（或相反），破坏全场 1:1；两端同时要求即从结构上保证 `Σ tradeKills === Σ tradedDeaths`。
- `timeline.endStateSuspect === true` 时整个回合返回 `resolved = false`，不生成 trade kill / traded death，也不计入 `tradeableDeaths`。`summarizeTrade()` 对确认参与者增加 `unavailableRounds`，令 `complete = false`、`tradeRate = null`；原因复用 `survival-end-state-conflict`。`available` 仍表示 trade 时钟可用性，回合可靠性由 `unavailableRounds` / `degradedRounds` / `complete` 表达。
- **降级名单（start 回退）**：`timeline.degraded === true` 时 `RoundTradeResolution.degraded = true`。trade 计数仍作为可观测证据输出，但 `summarizeTrade()` 增加逐玩家 `degradedRounds`，令 `complete = false`、`tradeRate = null`（`degradedRounds` 与 KAST 的同名字段语义一致）；不允许用降级名单发布完整 trade rate。名单含 unidentified 时回合已在更早的分支返回 `resolved = false`。
- `AnalyzeOptions.tradeWindowSeconds` 必须是有限正数；否则 `analyzeMatch` 抛 `RangeError`。（此前 `NaN` / `Infinity` 会得到无法比较的窗口并静默取消时间上界。）

### Clutch

- 从可靠起始名单（`freeze_end` 快照、无 unidentified、全部 side/alive 已知、无 lifecycle anomaly、无不一致死亡）出发，按 tick 推进存活人数（应用窗口内**所有**死亡，含 teamkill/world）。
- 当某队恰好只剩 1 名存活者且敌方仍有 ≥1 人时形成 clutch opportunity，记录该玩家、对手人数与形成 tick；对手数取形成瞬间的值，之后敌方减少不改变该 1vN。
- 对手数分桶 1v1 / 1v2 / 1v3 / 1v4 / 1v5（5 表示 ≥5）。
- 赢下回合（`round.winner === 该玩家阵营`）才计 clutch win；winner 未知时 opportunity 仍记录但 `won = null` 并记 `clutch-winner-unknown`。
- 无法解释的 disconnect / respawn / side change、unidentified 玩家、名单回退或不可用、`timeline.endStateSuspect === true` 都会让该回合 clutch **整体不输出**（`ineligible = true`、无任何 1vN opportunity，并记现有 `clutch-round-ineligible`），禁止猜测。end 冲突原因仍由 `survival-end-state-conflict` 表达，不增加重复 issue。

### P3.2 同 tick 与窗口策略小结

- 事件窗口沿用 P3.1 的闭区间 `[startTick, endTick]`。
- trade window 用 `Math.round(seconds × tickRate)`，边界含端点（恰好等于窗口 tick 数算入）。
- 同一 tick 的多名玩家死亡视为同时发生：存活人数一次性推进；但“谁先死”不用于 trade / opening 归属，无法证明即 ambiguous。

## 统一 coverage / eligibility 机制

所有指标共用 `buildCoverage(match)` 产出的资格上下文，不各自重复判断：

- `RoundWindow`：`startTick` / `endTick` / `freezeEndTick`、`eventEligible`、`excludedEventCount`、`includes(tick)`。`startTick` 或 `endTick` 缺失时该回合 `eventEligible === false`，不猜测事件归属。
- `RoundRoster`：优先取 `freeze_end` 且 `availability === "observed"` 的快照，缺失时退化到 `start`（`degraded: true`），两者都不可用时 `available === false`。名单缺失不视为空名单。
- `PlayerRoundState` / `RoundRosterEntry`：`inRoster` / `side` / `participant` / `alive`；`Unknown` side 归一为 `null`，不用事件或 `Player.team` 回填。`RoundRoster.entries` 与 `tick` 让 P3.2 时间线拿到完整名单与 baseline tick。
- `RoundEndState`：`end` 边界的 observed 快照，提供 `alive(steamId)` / `hasRow` / `tick`，是 KAST 存活证明的唯一终点证据来源。
- `RoundCoverage.winner` / `lifecycleEvents`：分别提供 clutch win 判定与回合内生命周期异常检测。
- `buildDamageLedger(round)`：把回合内伤害事件还原成受害者 HP 轨迹，为每个事件给出可解的实际损失或 `null`，并回报未解原因计数。指标不自己重算 HP。
- 两层资格：事件总量（K/D/A、HS%、multi-kill、opening）只需完整窗口；参与类（rounds played、damage、ADR、CT/T split）额外要求 `participant === true`，保证 ADR 分子与分母覆盖同一批回合。
- ADR 另有一道 effective-damage 完整性门槛：只有 `effectiveDamageUnresolved === 0` 才输出标准 `adr`，否则为 `null`（玩家级与逐侧各自判定）。
- 共享判定函数 `isEligibleKill` / `isEligibleAssist` / `isEligibleDamage` / `isIdentifiedEnemyKill`，指标只调用，不重新实现覆盖判断。

`CoverageSummary` 输出全局 issue 计数和逐回合摘要；`PlayerMetrics.coverage` 输出逐玩家降级信息。每个 issue 还通过 `coverageIssueSeverity` 归入一个严重度类别，`CoverageSummary.severity` 给出各类别合计：

- `unavailable`：所需证据缺失，数值不得产出（例如 roster 不可用、tick rate 不可靠）。
- `ambiguous`：证据存在但无法证明唯一结果，数值不得猜测（例如同 tick trade、end 状态与死亡时间线冲突）。
- `degraded`：可用文档化的弱信号产出数值，但不构成完整覆盖（例如 start 边界回退、unidentified 行）。
- `informational`：已解释的排除，不是覆盖缺陷（post-round 事件、无击杀回合的 opening）。

| Coverage issue | 含义 |
| --- | --- |
| `round-start-missing` / `round-end-missing` | 回合缺少 start / end 边界，事件类指标不可用 |
| `freeze-end-missing` | 缺少 freeze end 边界 |
| `roster-snapshot-unavailable` | start 与 freeze_end 都无 observed 快照，参与与阵营未知 |
| `roster-snapshot-fallback-start` | freeze_end 不可用，退化使用 start 快照 |
| `roster-unidentified-players` | 快照含无法用唯一 SteamID 表示的行（bot/缺失身份） |
| `player-not-in-roster` | 观察到的快照中没有该玩家行（未知参与，不等于断连） |
| `player-side-unknown` | 该玩家该回合 side 为 Unknown |
| `player-participation-unknown` | participant 未知（非 true/false） |
| `player-alive-unknown` | 该回合 alive 未知；KAST 的存活证明与 Clutch 的存活推进会因此不可用 |
| `post-round-events-excluded` | 被有效窗口排除的事件数 |
| `kill-teamkill-status-unknown` | 计入击杀但 teamkill 状态未知的数量 |
| `kill-headshot-status-unknown` | 计入击杀但 headshot 状态未知的数量 |
| `damage-side-unknown` | 因 side 未知而弃用的伤害行数量 |
| `damage-effective-chain-broken` | 伤害行无法从 `healthDamage + healthRemaining` 推出可信的实际 HP 损失（HP 轨迹断裂，含治疗/重生/漏记）；不计入 effective |
| `damage-effective-same-tick-ambiguous` | 同一 tick 对同一 victim 的多次命中顺序无法由余量证据证明；整组不计入 effective |
| `assist-side-mismatch` | 因 assister 不在 killer 侧而抑制的助攻数 |
| `opening-duel-contested` | 同最早 tick 多杀，opening 不归属 |
| `opening-duel-unattributed` | 最早击杀为 world/teamkill/side 未知 |
| `opening-duel-absent` | 回合窗口内无击杀 |
| `survival-context-unavailable` | 回合窗口或名单不可用，存活时间线无法建立（unavailable） |
| `survival-context-degraded` | KAST/Trade 使用 start 边界回退名单，或名单快照含 unidentified 行（degraded） |
| `survival-end-state-unavailable` | 无死亡证据但 end 快照缺失或无该玩家行，存活无法证明（unavailable） |
| `survival-end-state-conflict` | end 快照与死亡时间线矛盾（ambiguous） |
| `survival-timeline-anomaly` | baseline 之后出现无法解释的 disconnect / respawn / side change，或死亡时间线不一致（unavailable） |
| `trade-tick-rate-unknown` | `match.tickRate` 不可靠，抑制全部时间型 trade 结论（unavailable） |
| `trade-same-tick-ambiguous` | 死亡与复仇击杀同 tick，先后不可证（ambiguous） |
| `trade-candidate-ambiguous` | 同一最晚 tick 有多个可交易候选（ambiguous） |
| `clutch-round-ineligible` | 名单或时间线不可靠，该回合 clutch 不输出（unavailable） |
| `clutch-winner-unknown` | 有 clutch opportunity 但回合 winner 未知（degraded） |

逐玩家 coverage 另有 `effectiveDamageUnresolved`：该玩家被计入的敌方伤害行中，实际 HP 损失无法解出的数量。`side.CT` / `side.T` 各自也有同名计数，用于判断某一侧的标准 `adr` 是否可用。

## demo1.dem golden 结果

### twinkle

| 指标 | 结果 |
| --- | --- |
| K / D / A | **25 / 20 / 4** |
| K/D | 1.25 |
| HS kills / HS% | **9** / 36% |
| rounds played | 24 |
| reported damage | 2644 |
| reported ADR | 110.17（2644 / 24） |
| effective damage | **2193** |
| ADR（标准） | **91.38**（2193 / 24） |
| CT（12 回合） | 10 kills / 10 deaths / 3 assists / reported 1106（reportedAdr 92.17）/ effective 819（adr 68.25） |
| T（12 回合） | 15 kills / 10 deaths / 1 assist / reported 1538（reportedAdr 128.17）/ effective 1374（adr 114.50） |
| multi-kill | 8 个多杀回合：2 杀 ×6、3 杀 ×1、4 杀 ×1、5 杀 ×0；单回合最多 4 |
| opening | 4 opening kills / 0 opening deaths / 4 duels / winRate 1.00 |

### 全局一致性

| 项 | 结果 |
| --- | --- |
| parser 原始击杀（含 post-round） | 182 |
| 有效窗口内击杀（= 全部 death 数） | **180** |
| 计入助攻 | 57（原始 59，抑制 2 个友伤助攻） |
| 敌方 reported damage 合计 | 24600 |
| 敌方 effective damage 合计 | **19351** |
| opening duel | 24 kills / 24 deaths（24 回合各 1 次） |
| 被排除 post-round 事件 | 117 |
| damage-effective-chain-broken / same-tick-ambiguous | 0 / 0 |
| effectiveDamageUnresolved（全体玩家，含逐侧） | 0；因此本样本 `adr` 全部为数值，标准 ADR 与 `reportedAdr` 同时可用，golden 不受 ADR 门控影响 |
| 覆盖不足 | 无：24/24 回合有完整窗口与 freeze_end 名单，无 unidentified / unknown side / unknown participation / 不可解 HP 轨迹 |

被排除的 2 个 post-round 击杀：tick 101061（正常击杀）与 tick 141061（twinkle 的 post-round world 自伤），均在 `round_end` 之后。

### 与人工复盘对比

| 复核项 | 人工复盘 | 本实现 | 结论 |
| --- | --- | --- | --- |
| K / D / A | 25 / 20 / 4 | 25 / 20 / 4 | 一致（需排除 post-round 与友伤助攻） |
| HS kills | 9 | 9 | 一致 |
| CT/T kills/deaths/reported damage | — | 10/10/1106 与 15/10/1538 | 需按逐回合快照 side 才能得到 |
| reported ADR / 分母 | — | 110.17 / 24 | 基于上报伤害，保留 overkill |
| effective damage | ~2195 | **2193** | 相差 2（0.09%），见下 |
| ADR（标准） | ~91.5 | **91.38** | 差 0.125，同源于 2 点伤害 |
| opening | — | 4 / 0 | 4 次首杀、0 次首死 |
| multi-kill | — | 8 个多杀回合 | 2×6、3×1、4×1 |

K/D/A 的差异来源不是硬编码，而是两项可复现证据决策：post-round 排除（21 → 20 deaths；26 → 25 kills）与友伤助攻抑制（6 → 4 assists）。HS、CT/T、reported/effective damage、ADR、opening、multi-kill 直接由统一口径复算，无逐数值特判。

**2 点伤害差异的归因**：本实现与人工复盘采用同一口径（实际 HP 损失 = 受击前剩余 HP − 命中后剩余 HP），差异来自整数舍入。demo 的 `dmg_health` 是整数、`health` 是截断余量，逐发最多相差 1 点；人工复盘在个别命中的取整方向不同即累计出 2 点。作为对照：

- `pre - healthRemaining` 逐发累加（本实现）：**2193**。
- `min(dmg_health, preFromRemaining)` 逐发累加：2162。
- `min(dmg_health, preFromReported)` 逐发累加：2187。

只有本实现落在 ~2195 的 0.1% 内，说明人工复盘确实使用了 HP 损失口径，而 scoreboard 风格的 `min(dmg, hp)` 会明显偏低。该差异不影响任何结论。

### P3.2 golden（twinkle）

| 指标 | 结果 |
| --- | --- |
| KAST | **18 / 24 = 75.0%**（K 14 回合 / A 3 / S 4 / T 4，分量可重叠） |
| KAST coverage | eligible 24/24、unavailable 0、ambiguous 0、degraded 0，`complete = true` |
| trade kills | **6** |
| traded deaths | **4** |
| tradeable deaths | **18** |
| trade rate | **22.2%（4 / 18）** |
| window | 5s → **320 ticks**（64 tick，`MatchAnalytics.tradeWindow`） |
| clutch | 3 次 opportunity（R1 1v3、R17 1v2、R24 1v3），1 次 win（R24 1v3） |

全局：trade kills = traded deaths = **34**（1:1 关系）；tradeable deaths 合计 **158**；clutch opportunity 合计 **31**、win **7**；全部 P3.2 新增 issue 计数为 0，`severity.unavailable = 0`、`severity.ambiguous = 0`、`severity.degraded = 2`（仅 assist-side-mismatch）、`severity.informational = 117`。

### P3.2 与人工复盘对比

| 复核项 | 人工复盘 | 本实现 | 结论 |
| --- | --- | --- | --- |
| twinkle KAST | ~75% | **75.0%（18/24）** | 一致 |
| twinkle trade kills | ~6 | **6** | 一致 |
| twinkle traded deaths | ~4 | **4** | 一致 |
| tradeable deaths / rate | 18 / ~22% | **18 / 22.2%** | 一致 |
| R24 clutch | 1v3 | **1v3，won = true** | 一致 |

对账中发现并解释的真实时序特例：

- R22 tick 121075 twinkle 击杀 tarkz，随后 tarkz 在 tick 121153 以 HE 手雷（死后生效的投掷物）击杀 twinkle。死亡时间线因此出现“已死亡玩家仍有击杀”。实现不去除这种合法的 posthumous kill：它不把 tarkz 当作可复仇的 trade（trader 已死），也不把 tarkz 复活进存活计数。
- R13 的复仇击杀距死亡 395 ticks、R23 为 359 ticks，都略超 5s（320 ticks）窗口，因此**不算** trade。若把窗口放宽到 ~6.2s，twinkle 的 traded deaths 会变成 6，与人工复盘的 4 不一致；320 ticks 与人工复盘一致。
- R18 的 trade 只隔 9 ticks（tick 98850 死亡 → 98859 复仇），是典型的“补枪换人”，完全落在窗口内，属正常 trade。

R13 / R18 / R22 / R23 说明 trade 结论对窗口定义高度敏感，因此窗口参数显式暴露在 `MatchAnalytics.tradeWindow`，且 tick rate 不可靠时整类结论被抑制。

## 降级与跳过

本轮该样本覆盖完整，没有指标被降级或跳过：24 个回合全部 `eventEligible`，全部有 freeze_end 快照，0 个 unidentified、unknown side、unknown participation、teamkill 状态未知、headshot 状态未知，`damage-effective-chain-broken` 与 `damage-effective-same-tick-ambiguous` 均为 0。

机制上会被降级/跳过的情形已由合成测试覆盖：

- 缺 start/end：回合从事件类指标剔除，K/D 少计，coverage 记 `round-*-missing`。
- 无 observed 快照：参与未知，ADR 分母不含该回合，伤害不计入分子，记 `roster-snapshot-unavailable`。
- freeze_end 不可用：退化到 start，记 `roster-snapshot-fallback-start`。
- participant 非 true：rounds played 与伤害不计入，记 `player-participation-unknown` / 逐玩家 `skippedUnconfirmedParticipation`。
- side 未知：damage 弃用并记 `damage-side-unknown`。
- HP 轨迹断裂（如 HP 回升）或同 tick 顺序不可证：对应伤害行不计入 effective，由 `effectiveDamageUnresolved` 与 coverage 记数；reported damage 与 `reportedAdr` 仍保留，但 `adr` 变为 `null`（存在 unresolved 的 CT/T 侧同理）。
- opening 同 tick 多杀 / 首杀为 world、teamkill：不归属玩家。

P3.2 新增的降级/跳过路径（合成测试覆盖）：

- 无死亡事件但 end 快照缺失或无该玩家行：存活不可证，该回合退出 KAST 分母，记 `survival-end-state-unavailable`。
- end 快照与死亡时间线冲突：记 `survival-end-state-conflict`（ambiguous）；KAST 保持 degraded / incomplete，Trade 该回合 unresolved、不贡献任何 trade / tradeable death，Clutch 整回合 ineligible、不输出 opportunity。两种冲突均有合成 regression，包含正常对照及 trade 时钟未知的组合。
- baseline 之后出现 disconnect / spawn / side change 或不一致死亡：时间线不可用，KAST/Trade 该回合退出，clutch 整体不输出，记 `survival-timeline-anomaly` 与 `clutch-round-ineligible`。
- 名单回退到 start 或含 unidentified：KAST/Trade 以 degraded 计数（`survival-context-degraded`），clutch 不输出。
- `match.tickRate` 不可靠：时间型 trade 全部抑制，记 `trade-tick-rate-unknown`；`tradeableDeaths` 仍输出。
- 同 tick trade 或并列候选：不归属并记 `trade-same-tick-ambiguous` / `trade-candidate-ambiguous`，受影响玩家的 `tradeRate` 为 `null`。
- winner 未知：clutch opportunity 仍记录，`won = null`，记 `clutch-winner-unknown`。

## P3 已知边界与后续样本需求

- **Utility（P3.3 已完成）**：已实现投掷类型归一、release-only 计数、独立 lifecycle evidence、HE/fire effective HP loss、闪光 victim effects 与事件确认 assist。实际连续致盲时间和 overlap 归属仍未获证实；entity index 可复用，不作全局 ID。详见 [Utility Analytics](./utility-analytics.md)。
- **生存/连接状态**：`participant` 不是连接标志；断连/重连枚举语义仍未验证，跨回合连接状态机需要更多真实样本。本样本的 disconnect 全部在末回合 end 之后，回合内断连路径只有合成测试覆盖。
- **Bot / 部分录制**：无法用唯一 SteamID 表示的行只计入 unidentified，指标需按覆盖门控。
- **治疗/回合内重生**：本样本没有出现，机制上会记 `damage-effective-chain-broken`；P3.2 的 KAST/Trade/Clutch 也会因回合内 spawn 记 `survival-timeline-anomaly` 并整回合退出，待真实样本验证。
- **Posthumous kill**：样本 R22 出现死后手雷击杀。当前实现把它当作合法击杀（不复活、不作为 trade），但没有专门的证据字段区分投掷物延迟；更多样本可能需要更细的归因。
- **CT/T 分桶的 KAST / Trade / Clutch**：当前只输出玩家级总量，未做逐侧拆分；P3 契约已冻结，若未来需要应作为独立 Analytics 迭代设计，Findings 不自行扩展或重算。

## 验证

```powershell
pnpm --filter @cs2-analyst/analytics test   # 合成 + P3.2 战斗覆盖 + 真实 DEM golden
pnpm --filter @cs2-analyst/dem-parser test  # parser 回归
pnpm typecheck
pnpm build
```

analytics 测试当前 **53/53 PASS**（P3.1 合成 19、P3.2 combat 15、P3.3 utility 9、Final Acceptance 5 合成 + 1 真实 DEM 跨模块 invariant、真实 DEM golden 4；真实 DEM 全部执行，0 skipped），dem-parser **28/28 PASS** 无回归，`pnpm typecheck` 与 `pnpm build` 全 PASS。`model-contracts.test.ts` 额外对 KAST / Trade / Clutch / Utility 类型契约做编译期断言。

Final Acceptance（`tests/acceptance.test.mjs`）只增加跨模块 invariant，不重复既有单元测试：

- trade kill 与 traded death 在参与状态不一致的回合仍保持全场 1:1（含正常对照与修复前必失败的 regression）；
- 降级名单 never 发布 `complete` 的 trade rate；
- 非正 / 非有限 `tradeWindowSeconds` 抛错而不是静默取消窗口；
- `PlayerCoverage` 与回合总数闭合（`eligibleRounds = countedRounds + skippedUnconfirmedParticipation`，`eligibleRounds + skippedMissingWindow = totalRounds`），且 `kast.playedRounds === roundsPlayed`；
- utility HE/fire 有效伤害是玩家 `effectiveDamage` 的子集，并可由逐发 evidence 完全解释；
- 真实 demo1.dem 的全场跨指标 invariant（trade 1:1、逐玩家 side 分区等于玩家总计、CT/T 击杀-死亡交叉恒等、utility 子集、无 unexpected unavailable/ambiguous、deterministic）。

```text
P3 Analytics Engine — FINAL PASS
Analytics public contracts frozen for P4 Findings
```
