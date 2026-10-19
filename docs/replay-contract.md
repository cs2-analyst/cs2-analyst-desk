# P6.2 回放契约与兼容性

## 2026-10-19 — P7 死亡后跟随

schema-v1 Chunk 新增可选 `follow`：整回合精确死亡归属、原子同 tick 存活/死亡集合变化、可靠观测的楼层 ID 变化。
每块包含相同上下文，冷/重复/反向 Seek 与连续播放从明确的手动玩家身份重建同一跟随链。
只有明确的自归属死亡是自杀；未知攻击者、缺行或断连不作为自杀/全员死亡。已死/同 tick 死亡攻击者不能成为新目标。
全员确认死亡时只保留实际观察过的楼层 ID 或同会话真正显示过的背景，不恢复 XYZ，不宣称死者当前位置/楼层。
既有 frame/event/utility 数值、8Hz/插值/Chunk/IPC 限额和分析合同不变。
完整行为、根因、验收与限制见 [死亡后跟随](./p7-replay-death-follow.md)。下文历史阶段事实保留。

独立连续采样是新增需求，不能改写Match或稀疏Spatial语义。影响match-model、dem-parser、
report-contract和Desktop；Analytics/Findings/Deep Review仅继续使用原Match+Spatial。
原parse()/parseWithSpatial()及报告schema v2保持，新增显式parseWithReplay()入口与独立schema v1。
report-contract新增可选replay会话描述，不修改原报告字段/旧消费者。

领域Replay包含内容身份、schema/采样版本、精确requested/actual tick状态、逐玩家连续segment、
回合窗口、精确事件引用与coverage。只有dem-parser内部adapter查询native，单次读取与基础查询共享，
独立8 Hz回放预算不裁剪稀疏证据。Unknown clock仅保留事件tick，不编造秒数或倍速。
native查询前检查1–64个已识别玩家、最多60000个唯一tick/600000个玩家样本，并显式只请求这些SteamID；
超限独立降级回放，不在查询后才限制结果大小。

显示插值不进入领域/Analytics。sample仅表示native该tick最终状态；same-tick生命周期冲突明确歧义。
缺失位置/状态、死亡、spawn、disconnect、side_change、回合和超间隔均切断segment。
Utility仅保留已验证生效点；不表示轨迹或区域。Bomb事件在Utility Process投影，未知位置保持null。
Renderer对跨楼层/未知楼层的相邻样本保留过渡未知，不从插值Z推断楼层。整数块使用floor(displayTick)
归属，guard仅支持有依据的块边界显示，不在末尾外推。
十图资源包含Nuke、Vertigo、Train双层：共享高度边界分别为-495、11700、-50；
边界重叠、缺Z和越界均保持未知，楼层区间与原始overview逐项核对。其余七图按单层底图显示，
不据此推断地图内没有立体结构或层间可见性。

Utility会话缓存按内容SHA/schema/解析器采样版本/地图资源身份隔离；最多64MiB序列化内容，
固定请求tick≤60000。按回合、最长20秒分块，超过1MiB继续拆分。每块含边界frame，
各frame是完整独立状态（含炸弹基线），随机seek不从比赛开头重播。Renderer最多缓存3块。
只有当前窗口主frame、当前会话和该会话登记的回合/块可请求；旧会话/过期返回被拒绝。
重新导入实际开始、取消解析、释放和窗口关闭终止旧worker并清空会话；取消文件对话框保留原会话。
成功报告后worker持久保留至会话结束；回放错误独立降级，报告仍可用。

本契约为additive变更，不迁移历史缓存（仅会话缓存）。安装版必须同时构建同一版本Main/preload/Renderer。
## P7 回放增强：道具轨迹与效果（additive）

本轮不改变既有采样、时钟、seek、回合窗口或分块语义，只追加可选的 utility 证据：

- `ReplayRound.utilities?` / `DesktopReplayChunk.utilities?`：`kind`、`variant`（仅 fire 的
  molotov/incendiary）、`throwerId`、`entityId`、`tick`、`endTick`、`endSource`、`position`、
  `flight: { startTick, endTick, points:[tick,x,y,z][] } | null`。
- `ReplayRound.blinds?` / chunk `blinds?`：来自 `player_blind.blind_duration` 的真实致盲窗口。
- `ReplayRound.burns?` / chunk `burns?`：只由真实 inferno damage tick 聚合的灼烧窗口。
- 每个 chunk 只携带与自身 tick 窗口相交的效果；没有效果时数组省略，旧 chunk/旧消费者保持可用。

轨迹来自 `parseGrenades(bytes, [], false)` 的逐 tick projectile 位置，按实体 id/类别/连续 run 分段并与
detonate 事件匹配；fire 按真实投掷者与 `weapon_fire` 时间窗匹配。无法可靠匹配时 `flight=null`，
绝不生成起点到终点直线。烟雾/火焰结束优先使用 `smokegrenade_expired` / `inferno_expire`，
缺失时才回退 `round-end` 或文档化 nominal，并在 `endSource` 标记。

Renderer 层序固定为 map → areas → trajectories → projectiles → players → status → selection；
烟雾/火焰为半透明区域并绘制在玩家点之前，被闪/被烧图标绘制在玩家点之后。

详细数据来源、降级、验收与性能权衡见 [P7 回放增强：道具轨迹与效果](./replay-utility-effects.md)。

## P7-S1 展示楼层上下文

自动楼层与目标当前坐标分离：同一会话、比赛、地图资源、回合、目标和连续正向时钟中，
仅将目标存活、非歧义、segment 有效且 XYZ 可靠时确认的楼层保存为背景上下文。
目标位置暂时不可用时显示“目标楼层未知 · 沿用上一确认层”，其他有效玩家仍按真实位置和楼层过滤；
不保存、恢复或外推目标 XYZ。新的可靠位置立即决定新层。单层地图保持原有行为。

每次显式 Seek（含同 tick、暖缓存、反向和大幅前向）清历史；切目标、回合、DEM、ReplaySession、
地图资源或手动模式亦失效。冷 Seek 无可靠位置时不猜层，允许手动选层。
暂停、恢复、倍速和连续 Chunk 不重置同一时钟上下文；自然跨回合仍清历史。
位置插值的采样间隔约束不用于判断 RAF 时钟是否连续。

同一 RAF 的展示帧决定底图、玩家、炸弹和道具层；React 只订阅有意义的楼层/图片状态变化。
当前地图的有限楼层图片按会话预加载并等待解码，切层复用；未就绪不以旧图冒充新层。
切会话释放图片引用和回调。没有新增 DTO、native 查询或放宽任何 Chunk/IPC/位置约束。
真实对照与限制见 [S1 验收](./p7-nuke-replay-fix.md)。
