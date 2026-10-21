# 比赛 Rating 与高光规则 v1

实现位于 `packages/analytics/src/performance.ts`。函数为无状态纯函数，输入必须来自同场、同人；Renderer 只消费预计算结果。既有 ADR、KAST、Trade、Clutch 计算口径保持不变。

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

## 高光

所有门槛集中于 `highlightRules`，最多展示 3 项；固定优先级为 **残、神、突、补、准、闪、辅、助**，不依赖对象或数组输入顺序。每项包含语义颜色、单字、Tooltip 和原始数值证据。颜色与尺寸由 Fluent UI 消费者渲染。

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

`pnpm --filter @cs2-analyst/analytics test`：103/103 通过，0 skipped；其中新增 performance 测试 50 项，覆盖公式、单位、低/中/高表现、负值不截断、零回合、缺失/非法/非有限输入、版本、纯函数数据隔离、8 类标签正反例/边界、小样本、Trade/Clutch 区分、Tooltip 数值、稳定优先级及最大数量。

真实 `demo1.dem`（SHA-256 `f3c3173eae0cd100d15c81c3b734be792f9212256a9c99703b358d3434000852`，de_dust2，24 回合）10 名玩家均可计算 Rating。twinkle 为 `1.3742186666666667`，展示 `1.37`，前三项为残、神、突：1 次 1v3 残局获胜；1 个三杀、1 个四杀回合；首杀 4、首死 0。该样本实际出现残、神、突、补、准、助；没有达到闪/辅门槛，不用合成标签冒充真实验收。

交叉调查 `demo2.dem`（SHA-256 `253e5b719ac418b092ff3cdd1b5928bb0dfc8ccbf06cb9398963ea1e9fa44a25`，de_dust2，18 回合）：既有 KAST 覆盖不完整，10 名玩家 Rating 均不可用；已确认的残局、多杀等高光仍可独立展示。没有为提高可用率绕过覆盖门控。

这些是本模块验证与样本调查，不代表整个项目 Final Acceptance。
