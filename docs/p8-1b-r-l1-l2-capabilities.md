# P8.1B-R：L1/L2 能力矩阵

日期：2026-10-25（Asia/Shanghai）。范围依据是 [PR #4 的范围决策草案](https://github.com/cs2-analyst/cs2-analyst-desk/blob/8f61854793f3d9230d1cd160b3fd01dedaafcadd/docs/p8-scope-decision-l1-l2-2026-10-25.md)，不是已合并的生产 API。实测与命令见 [复核报告](p8-1b-dust2-data-validation.md) 和 [JSON](p8-1b-validation-2026-10-25.json) 的 `currentRun`；旧结果在 `historical.record`。

`PASS` 仅表示已在声明边界内实测；`BLOCKED` 表示有明确前置缺口；`NOT RUN` 表示本轮未执行；`UNSUPPORTED` 表示产品范围排除。不能将所有 L2 能力合并成一个布尔值。

| 能力 | 必须验证的证据 | 当前状态与范围 |
| --- | --- | --- |
| L1 服务器快照事实 | 原 DEM 身份、pinned native、精确 tick、合法身份/阵营、XYZ/HP/alive/朝向/活动武器及引用 | **PASS（局部）**：Dust2 四个形成点、八个存活者、48/48 规范化字段；不代表逐 tick、跨地图或全部 native 字段 |
| L1 1v1 形成事实 | freeze 5v5 基线、截至 g 的原子死亡组、无生命周期歧义、exact alive 集合交叉核验 | **PASS（局部）**：4/4；只说明服务器人数变化，0 个已认证教练决策案例 |
| 固定前缀输入隔离 | 转换前裁剪、固定 tick/玩家/字段、引用/coverage/selection/schema/metadata 全比较 | **PASS（局部）**：40 次真实历史上的 native-output 未来扰动 + 8 个正对照；不表示改写 DEM 二进制后的 decoder 因果证明 |
| 现有全场 optional 采样作为前缀输入 | 未来事件不能决定历史采样 | **BLOCKED**：仍丢失 3,452 个历史 optional tick；新实验不消费该计划或 coverage，生产采样器未修改 |
| 本地雷达资源与数字映射 | 原 overview/PNG 摘要、尺寸、变换参数、真实 XYZ 算术映射 | **PASS（算术子能力）**：资源与固定 manifest 一致，8/8 点可映射且在图内；逆变换误差不是地图精度 |
| 经版本匹配的世界坐标→地图位置 | DEM map build 与资源版本对应、独立真实地标及转换误差 | **BLOCKED**：`unconfirmed`；无本轮独立地理误差，不能宣布“地图位置准确” |
| 玩家间空间距离 | 同一 native 世界 XYZ 坐标、合法有限数值、异常/缺失/溢出处理 | **PASS（数值子能力）**：四对同 tick 端点的 XY/XYZ 距离，以 DEM world units 表示；不换算米，不推导路线长度/时间 |
| 一段时间内位置变化 | 固定前缀窗口、各 actual tick、缺帧与采样独立性 | **NOT RUN**：本轮单 tick，没有轨迹或移动过程验收 |
| 导航可达性 | 匹配版本的导航拓扑或可通行几何 | **BLOCKED**：无已验证数据及基准案例；几何实测 NOT RUN |
| 静态视线与遮挡 | 匹配版本碰撞/遮挡数据和真值案例 | **BLOCKED**：无；雷达图、直线距离和理论 LOS 均不能证明玩家实际看见 |
| 多楼层空间关系 | 高度区间、楼层边界、对应版本真实案例 | **BLOCKED**：Dust2 配置只有无界 default 层；数值 ΔZ 不等于楼层分类。本轮没有重跑 Nuke/Vertigo |
| 烟雾及动态遮挡 | 验证过的空间体积、生命周期、动态状态 | **BLOCKED**：已有效果原点或结束事件不足以证明遮挡体积/效果；几何实测 NOT RUN |
| 协同与可支援性 | 时间、位置、通路和交战条件联合证据 | **BLOCKED**：通路、遮挡与行动条件未验证；距离不能替代 |
| 可评价战术选择、路线安全/选位优劣 | 机会定义、行动窗口、资源/动作与地图条件、独立评审 | **BLOCKED**：四个形成点不是四个决策机会；没有胜率/因果或专家真值 |
| POV、实际注意力/视觉感知、心理或意图 | 产品决定不实现 | **UNSUPPORTED** |
| PlayerKnowledge 恢复 | 经验证的玩家可获知渠道/时间 | **UNSUPPORTED（本轮目标）**：没有恢复或宣称该能力；缺少 availableTick 不再整体阻断 L1 |

`ServerStateAtTick` 与 `SpatialActionContext` 仍只是建议职责名。新脚本使用 `p8-1b-r-server-facts-experiment-v1`，仅位于 `docs/experiments/`，未创建生产类型、服务或模型调用。

**P8.1B-R 整体 BLOCKED / NOT PASS；L1 可以在上述边界内单独签收，L2 仅有数值子能力通过。** P8.1C/D 未自动放行；P8.2 继续禁止。下一步须另行决定并授权匹配地图数据与几何验证，以及部署/安全、来源/评测协议工作。
