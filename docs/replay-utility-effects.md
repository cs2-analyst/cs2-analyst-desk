# P7 回放增强：道具轨迹与效果

2026-10-18，基线 `fe9ec36`。本轮只增强比赛回放，不进入 P8；未修改版本号、tag、release，
未改动 Replay 原始玩家采样、时钟、seek、回合窗口或分块协议语义。

## 数据来源

全部效果字段来自本机 `.demo/dust2.dem` 的真实回放数据，不使用起点到终点的直线或距离推断：

| 证据 | 原生来源 | 用途 |
| --- | --- | --- |
| projectile 逐 tick 位置 | `parseGrenades(bytes, [], false)` | 飞行图标、垂直投影轨迹、拖尾 |
| 投掷瞬间 | `weapon_fire`（smokegrenade / flashbang / hegrenade / molotov / incgrenade / decoy） | 投掷起点锚点、molotov/incendiary 变体 |
| 爆开/生效 | `smokegrenade_detonate`、`hegrenade_detonate`、`flashbang_detonate`、`inferno_startburn`、`decoy_started` | 效果起点、真实爆点 |
| 烟雾结束 | `smokegrenade_expired` | 烟雾真实窗口 |
| 火焰结束 | `inferno_expire` | 火焰真实窗口；被烟雾提前扑灭时该 tick 自然提前 |
| 致盲窗口 | `player_blind.blind_duration` | 被闪玩家状态图标 |
| 灼烧窗口 | `player_hurt` 且 weapon 为 inferno/molotov/incgrenade | 被烧玩家状态图标；不使用爆点距离推断 |

projectile 行的 `grenade_entity_id` 是 demo 局部实体索引，会跨投掷复用。解析器按
“entity id + projectile 类别 + 连续 tick run（间隔 >2 tick 或类别变化即新 run）” 分段；
smoke/flash/HE/decoy 用该 run 与 detonate 事件 entity id 匹配。
`inferno_startburn.entityid` 是火焰效果实体而不是 molotov projectile 实体，因此 fire 用
“真实投掷者 + `weapon_fire` 时间窗 + projectile run 结束 tick 最接近爆开 tick” 匹配。

轨迹点来自原生逐 tick 位置，按约 16 Hz 抽样并保留真实投掷 tick、爆开 tick 与爆点；
投掷 tick 的位置使用该 tick 的玩家真实采样作为起点锚点（仅在可用时）。无法关联 projectile run
时 `flight=null`，只显示效果，不生成假路径。

## 契约（additive）

`ReplayRound` 与 `DesktopReplayChunk` 追加可选字段；旧字段、旧消费者和旧 chunk 不变，
没有效果时数组省略：

```ts
interface ReplayUtilityEffect {
  eventIndex: number;
  kind: 'smoke' | 'flashbang' | 'hegrenade' | 'fire' | 'decoy';
  variant: 'molotov' | 'incendiary' | null;
  throwerId: string | null;
  entityId: number | null;
  tick: number;                 // detonate / start_burn / decoy_started
  endTick: number;              // 真实结束、回合结束或短促展示窗口
  endSource: 'observed' | 'round-end' | 'nominal';
  position: [number, number, number] | null;
  flight: { startTick: number; endTick: number; points: [tick, x, y, z][] } | null;
}
interface ReplayBlindWindow { victimId: string; attackerId: string | null; startTick: number; endTick: number }
interface ReplayBurnWindow { victimId: string; startTick: number; endTick: number }
```

Desktop DTO 使用 `utilities? / blinds? / burns?`，与领域字段一一对应。每个 chunk 只携带与该块
tick 窗口相交的 effect；相邻块可重复携带同一个长效果，保证随机 seek 不依赖前一块。

## 效果与窗口

| 道具 | 飞行 | 爆开/生效后 | 窗口 |
| --- | --- | --- | --- |
| smoke | 有真实轨迹 | 半透明中半径烟雾团 | `smokegrenade_expired`；缺失时 20s nominal / 回合结束 |
| flashbang | 有真实轨迹 | 短促白色扩散光晕 | 0.5s 展示窗口；受害者致盲用真实 blind_duration |
| hegrenade | 有真实轨迹 | 1s 小半径爆炸 | 1s（按 tickRate 换算） |
| fire (molotov/incendiary) | 有真实轨迹 | 小半径动态火焰 | `inferno_expire`；缺失时 7s nominal / 回合结束 |
| decoy | 有真实轨迹 | 无持续区域 | 生效 tick 即时结束 |

被闪/被烧状态图标只在真实窗口内显示；玩家点位和状态图标始终绘制在烟雾/火焰/轨迹/瞬时效果之上。
渲染层序固定为：地图底图 → 持续区域 → 轨迹 → 飞行图标/爆炸/闪光 → 玩家点位 → 状态图标 → 选中玩家框/标签。

视觉半径为展示值（smoke 144、fire 150、HE 170–225、flash 120–740 世界单位），不是逐像素地形范围，
也不表示 LOS。

## 降级

- `parseGrenades` 失败或无匹配 run：`flight=null`，只显示爆开/生效效果，不画轨迹。
- 没有 `smokegrenade_expired` / `inferno_expire`：使用文档化 nominal 或回合结束，并在 endSource 标记。
- 未知 tickRate：不生成 blind 窗口（秒数无法可靠换算）；HE/flash 展示窗口按 64 tick 兜底。
- 投掷者不在比赛 roster / 无 projectile owner：文案使用“未知玩家”，不编造昵称。
- 跨楼层或未知 Z：不把相邻轨迹段/效果画到当前层；边界保持未知。

## 实际验证

- 真实 Dust2：632 个 utility 效果（182 smoke / 82 HE / 229 flash / 138 fire / 1 decoy），
  632 条轨迹全部来自 projectile run；500 个真实 blind 窗口；15 个由 67 条 inferno damage 聚合的 burn 窗口。
- 效果结束来源：299 observed / 310 nominal / 23 round-end；烟雾 expiry 匹配 175/182，火焰 expiry 匹配 138/138。
- 会话 159 块，效果块最大 380403 字节（≤1 MiB），缓存 36495839 字节（约 34.8 MiB，≤64 MiB）。
- 真实 Electron：完整导入 9.5–10.3s（≤15s），首帧 130.9–133.2ms，12 次 chunk IPC p95 8.7–12.1ms，
  Canvas 动态绘制 p95 0.2–0.3ms，Utility 进程峰值 1685307392 字节（≤2.5 GiB），原报告 fingerprint 不变。
- 真实回放按钮、进度 seek、跨块播放、回合切换、事件点击 seek、1024×640、1920×1032 均通过；
  截图见 `.tmp/p6-qa/p7-utility-*.png`（本地验收产物，不提交）。

## 已知缺口 / 性能权衡

- 新增一次 `parseGrenades` 原生查询，真实 Dust2 回放解析从基线 3.29s 升至 6.46–6.88s，
  超过 P6 的“新增回放查询 ≤5s”探测预算；完整导入仍为 9.5–10.3s，低于 15s 导入预算，
  首帧和播放绘制没有明显回归。若必须保留 5s 探测预算，需要 native 侧 tick 过滤或异步/按需加载。
- fire 的 molotov/incendiary 区分依赖可关联的 `weapon_fire`；无法关联时显示为中性 `fire`。
- burn 窗口由真实 inferno damage tick 聚合，尾部最多补 0.2s；不表示逐帧燃烧状态。
- 未实现 3D 抛物线、烟雾/火焰 LOS、地形遮挡或精确粒子；只绘制垂直投影和视觉半径。
- 未对 Nuke 等双层地图做真实道具层级专项截图；跨层轨迹段按未知层保守跳过。
