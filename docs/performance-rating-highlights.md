# 比赛 Rating 与高光规则 v1

实现位于 `packages/analytics/src/performance.ts`。函数为无状态纯函数，输入必须来自同场、同人；Renderer 只消费预计算结果。既有 ADR、KAST、Trade、Clutch 计算口径保持不变。

2026-10-25 更新：取消高光“最多 3 项”的截断，所有满足原门槛的高光全部输出；Rating 公式/算法标识、8 类标签门槛、覆盖门控与排序保持不变。

2026-10-25 展示补充：多杀高光 Tooltip 在概述下按 3 杀、4 杀、5 杀及以上逐行显示次数，0 次项目隐藏，不再使用括号。共用 Renderer 高光组件直接读取已保存的 `evidence` 格式化，并保留换行；旧比赛库记录无需重新分析。缺少完整多杀证据的历史项保留原说明，不猜测次数。评分、触发门槛与归档原文不变。

该展示补充通过 `app-shell` / `report-ux` 回归及 Desktop build（含类型检查）。真实 Electron 在已保存的 demo2 记录上悬浮验证：概述与「3 杀 3 次」独占两行，32px 总内容高度、16px 行高，无括号或零次项目；没有重新分析 DEM。截图位于 `%TEMP%/cs2-multi-tooltip-qa-R18f2h/demo2-multi-kill-tooltip.png`，未提交媒体文件。

## Rating

算法标识：`hltv-2.0-community-approx-v1`。输出包含 `value`、`algorithm`、`status`、`reason`；不可用时 `value=null`，不伪装为 0。保存未取整的数值，展示统一保留两位小数。

```text
KPR = kills / validRounds
DPR = deaths / validRounds
APR = assists / validRounds
ImpactApprox = 2.13*KPR + 0.42*APR - 0.41
RatingApprox = 0.0073*KASTPercent + 0.3591*KPR - 0.5329*DPR
             + 0.2372*ImpactApprox + 0.0032*ADR + 0.1587
```

`KASTPercent` 为 0–100 百分数。ADR 使用项目既有有效敌方 HP 损失口径，不能使用 reported ADR 替换。结果不做上下限截断。

来源：[HLTV 官方说明](https://www.hltv.org/news/20695/introducing-rating-20)、[Dave 社区逆向拟合](https://dave.xn--tckwe/posts/reverse-engineering-hltv-rating/)。HLTV 并非 Valve；HLTV 未公布完整 Rating 2.0 公式。本实现使用任务指定的社区拟合系数和近似 Impact，不等于 HLTV 官方评分，未复刻其 CT/T 分侧、单次击杀权重等完整方法，也没有实现 Rating 3.0。

`summarizePlayerPerformance(PlayerMetrics)` 门控：

- 有效窗口内事件总量与确认参与回合相同：`coverage.eligibleRounds=countedRounds=roundsPlayed`，没有未确认参与回合。
- KAST complete 且 `eligibleRounds=roundsPlayed`，避免混用回合集合；冲突或降级的 KAST 不计算 Rating。
- 没有未知 teamkill 状态或伤害阵营；ADR 不为 null。未知 headshot、Utility 或 Clutch 数据不会独自阻止 Rating。
- 分母大于零；计数为非负安全整数，ADR 为非负有限数，KAST 为 0–100 有限数。缺失、非法输入和非有限结果均返回中文不可用原因。
- 正式窗口缺失的回合由既有 Analytics 统一排除；只有剩余指标的回合集合相同才评分，不自行补零。

`computePlayerPerformance(PlayerPerformanceInput)` 是旧报告轻量兼容入口。调用方只能将有保存证据支持的 coverage 标为完整，缺失证据必须保守降级；不重新解析 DEM。

`playerPerformanceInput(PlayerMetrics)` 暴露同一适配器的轻量输入，供报告保存必要覆盖证明，后续替换算法时可重用。旧版 `coverage.complete` 未保留未知 teamkill/headshot 数量，单靠该布尔值不足以证明完整，不能据此猜测 Rating 或精准标签。

## 报告、列表与旧档案兼容

报告仍使用 schema v2，逐玩家新增可选 `performance` 和 `performanceCoverage`，后者保存 Analytics 的事件归属、回合集合及爆头样本完整性证明。新报告与列表消费同一份未取整的结果。已有结果通过原归档完整性验证读取；从保存的 DTO 补算此前截断的其他达标标签，不调用 DEM Parser。已通过校验的原评分与原高光证据保持不变，只合入额外可证明的标签，去重后按原优先级排序。没有原评分且缺少必要覆盖证明时 Rating 显示不可用；独立可证的补枪、残局、闪光、道具仍可用于高光。不从缺失覆盖证明猜测额外的事件类高光。

列表按页读取小索引，并将对应玩家摘要保存在独立 SQLite `player_summary_cache` 表，绑定比赛 ID、不可变 manifest 摘要及派生规则版本。冷缓存只解压当前页的报告组件，不读取回放、热力图源或 DEM；热缓存直接使用持久摘要。原档案字节、manifest、导入时间和目录快照保持不变。损坏派生缓存可丢弃重建；临时读失败仅显示缺失摘要，不自动改写健康归档状态。超过 512 KiB IPC 预算时缩小 SQL 页并返回实际 `limit`，分页不会跳过记录。

当前派生缓存版本为 `hltv-2.0-community-approx-v1/highlights-v2-all/adapter-v4`；旧版最多 3 项的缓存自动失效，按页从原归档的保存证据重建。校验允许现有 8 种高光全部出现，并拒绝重复类别、未知类别和非法证据；8 是当前规则类别数，不是展示截断上限。

胜负通过完整逐玩家时间线与每回合稳定队伍比分增量核实；缺失比分、未知回合结果或玩家跨稳定队伍时显示未知。当前源模型没有可证实的比赛日期，列表明确使用导入时间，不冒充比赛发生时间。

## 高光

所有门槛集中于 `highlightRules`，展示全部达标项，每类最多一项；固定优先级为 **残、神、突、补、准、闪、辅、助**，不依赖对象或数组输入顺序。每项包含语义颜色、单字、Tooltip 和原始数值证据。颜色与尺寸由 Fluent UI 消费者渲染。

| 标签 | 条件 | 证据 |
| --- | --- | --- |
| 残 | 至少 1 次有明确获胜结果的残局 | `clutch.wins` 与按回合唯一的 `won=true` list 数量一致；展示获胜次数和最高敌人数 |
| 神 | 至少 1 个三杀及以上回合 | 已有 multi-kill 的 triple、quad、fivePlus 回合数；双杀不触发 |
| 突 | 首杀 ≥3，且首杀 > 首死 | 已有 opening kills/deaths |
| 补 | 真实补枪 ≥3，Trade complete | 已有 `trade.tradeKills`，普通击杀不作补枪 |
| 准 | 已知爆头率 ≥60%，有效击杀 ≥15，全部击杀的 headshot 状态已知 | 既有 HS%，不使用极小样本 |
| 闪 | 事件确认的闪光助攻 ≥3 | `utility.flash.assists`，未知为 null；不使用盲时推算 |
| 辅 | 完整 HE + fire 有效敌伤 ≥200 | 两类 `enemyDamage` 均非 null；不计 reported overkill 或致盲时长 |
| 助 | 有效助攻 ≥6 | 既有经阵营确认的 assists |

事件计数类标签（神、突、准、助）要求事件归属与参与回合集合可靠。Trade 用自身 complete；闪光、道具用自身 nullable 完整结果。残局仅使用可靠回合产生的明确获胜证据；不将机会次数或未知 winner 当获胜。不存在可靠 MVP 事件，本轮不实现 MVP。

## 验证与实际样本

原阶段 `pnpm --filter @cs2-analyst/analytics test`：103/103 通过，0 skipped；其中 performance 测试 50 项。2026-10-25 已将原最大数量断言替换为全部 8 类输出、稳定优先级及无重复断言，保留门槛与覆盖边界用例。

真实 `demo1.dem`（SHA-256 `f3c3173eae0cd100d15c81c3b734be792f9212256a9c99703b358d3434000852`，de_dust2，24 回合）10 名玩家均可计算 Rating。twinkle 为 `1.3742186666666667`，展示 `1.37`，前三项为残、神、突：1 次 1v3 残局获胜；1 个三杀、1 个四杀回合；首杀 4、首死 0。取消截断后的真实 Electron 验证显示第 4 项“补”，Rating 仍为 1.37。该样本实际出现残、神、突、补、准、助；没有达到闪/辅门槛，不用合成标签冒充真实验收。

最初交叉调查 `demo2.dem`（SHA-256 `253e5b719ac418b092ff3cdd1b5928bb0dfc8ccbf06cb9398963ea1e9fa44a25`，de_dust2，18 回合）时，旧生命周期判定将 R18 死亡后的退出也视为整回合异常，KAST 仅覆盖 17 回合，10 名玩家 Rating 均不可用。2026-10-25 已按下节修复，Rating 完整性门槛保持不变。

这些是本模块验证与样本调查，不代表整个项目 Final Acceptance。

既有同 SHA 导入继续使用去重重开语义，不因新增评分覆盖已有归档。缺少覆盖证明的历史记录不会仅靠重复导入自动替换；本轮保留明确不可用状态，不要求删除用户数据。

## 2026-10-25：死亡后退出的覆盖判定修复

修复位于 Analytics 的共享 `buildRoundTimeline`，不在 Renderer 或 Rating 公式中补数值。只有身份已知、baseline 确认存活、恰好一次死亡且 `baselineTick < deathTick < disconnectTick` 时，退出才不再构成时间线 anomaly。所有原始事件仍保留；存活中/死亡前/同 tick 退出、未知身份或 baseline、重生、换边、多次死亡、期末状态冲突继续阻止不可靠评分。共享时间线的 KAST / Trade / Clutch 使用同一证明，不各自绕过保护。

本地原字节 `demo2.dem` 的 R18 证据：

| 玩家 | 死亡 tick | 退出 tick |
| --- | ---: | ---: |
| 老彩笔123 | 105798 | 106202 |
| 清华北大落榜生灰太狼 | 102576 | 106209 |
| 图丶图 | 105707 | 106475 |

三人均有 freeze-end 存活与期末死亡快照，原先唯一的问题是退出发生在死亡之后。修复后 10 名玩家 KAST 均完整覆盖 18/18 回合，Rating 均 available；元屠 K/D/A 仍为 18/9/3，ADR 仍为 `1990/18`，KAST 为 `14/18 = 77.78%`，Rating 为 `1.5974935555555556`，显示 **1.60**。没有修改 DEM、Parser、领域模型、评分系数或评分完整性门槛。

回归：新增合成用例证明死亡后的退出与无退出控制组的 KAST/Trade/Clutch/Rating 完全一致、输入不变；危险生命周期和冲突仍 unavailable。真实 demo2 测试锁定 SHA，并核对三条退出证明及全体玩家评分，真实 demo1 原 golden 不变。`pnpm --filter @cs2-analyst/analytics test`：117/117；`pnpm typecheck`：15/15；`pnpm build`：8/8；`pnpm --filter @cs2-analyst/desktop test`：325/325，均 0 fail / 0 skip。独立只读复审 PASS。

真实 Electron/Chromium（已构建应用、1280×800）验证：磁盘 File 经 preload/IPC/Utility 导入原 demo2，身份选择为元屠；依次切换全部 10 名玩家，界面评分均与报告未取整数值的两位小数一致。比赛库列表显示元屠 **1.60**，从该记录重开后全部 10 人评分与首次导入精确一致。页面身份、非空内容、无框架错误遮罩、无应用控制台错误/警告及无未捕获异常通过；既有未打包 Electron CSP 提示单独记录。会话没有 Browser skill，沿用仓库 Electron CDP 设施。证据位于本机 `%TEMP%/cs2-demo2-rating-qa-wLZtbW/`，包括 `demo2-report-rating.png`、`demo2-library-rating.png` 和 `evidence.json`；临时脚本 `cs2-demo2-rating-qa.mjs` 不提交。首次 QA 启动未先进入比赛库，因 Home drop target unavailable 在导入前停止；修正临时脚本的导航和等待后完整通过，未改动产品代码。未执行安装版或多显示器 DPI 验收。

已有归档保存旧版 KAST，不会通过此修复或派生缓存自动重算；同 SHA 普通重复导入仍重开旧归档。2026-10-25 后续新增的[比赛库「重新分析」](./match-library-reanalysis.md)可重选原 DEM 更新已有报告并保留「自己是谁」，不再要求先删除记录。上述覆盖判定验证仅操作隔离临时比赛库，不删除或改写用户归档。
