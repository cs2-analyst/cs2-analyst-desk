# P7 投掷事件时间语义核验

本机真实 `.demo/dust2.dem`，SHA-256
`db90fe85aab023a1d2c8a5996182e6120d98ef494f02a070b17982b235e4958c`，64 tick/s。
初次审计代码基线 `c247469102196e474e7162e2536ee815fd5c0abb`。
未下载、替换或复制 DEM；没有使用 `demo3.dem`。详细原生字段与代表实例见
[证据 JSON](./p7-utility-timing-evidence.json)。

## 判断与最小修复

最终判断：**CONFIRMED BUG FIXED**（只修复展示文案，全部时间保留）。
真实证据确认基线存在 **展示文案语义错误**：关键事件列表的 utility 条目使用生效 tick，
却标为“投掷了”。原生事件、Match、ReplayUtilityEffect 与 DesktopReplayEvent 的时间传递本身一致。
已在 ReplaySession 展示层按既有 `UtilityEvent.action` 写“爆开 / 开始燃烧 / 开始生效”；
保持所有 tick、effect window、轨迹、事件 ID、排序、seek 与 chunk 归属。
例如相同的 R1 `+44.42 秒` 现在显示 `karrigan 的 smoke 爆开`。
没有足够理由把现有业务 utility 生效事件移动到 `weapon_fire`。

本调查能够自主确定该文案问题，不需要用户打开游戏才能作出判断。
实际手离动画的精确帧没有被声称已验证：此 DEM 的 grenade `weapon_fire` 比首次 projectile 记录
早 6 / 7 / 13 / 14 tick（0.09375–0.21875s）。它是可证实的原生道具使用/投掷事件时间，
不是亚 tick 物理出手或游戏动画的测量结果。即使只使用首次 projectile 观察作为保守证据，
列表事件仍明显位于后续的爆开/生效阶段，足以确定文案语义错误。

## 时间来源检查

| 层 | 实际来源与语义 |
| --- | --- |
| demoparser2 native | `second_pass/game_events.rs::parse_event` 从 DEM 的 game-event descriptor 解出实际字段，tick 为 `self.tick`；没有根据事件名称回推投掷时间 |
| inferno / decoy | `ENTITIES_FIRST_EVENTS` 延迟到同 packet 的实体解析之后补齐人物字段，`resolve_wrong_order_event` 保留当前 packet tick；不把 inferno_startburn 改为 weapon_fire |
| projectile | `collect_data.rs::collect_projectiles` 输出实体 index、真实 class、逐 tick x/y/z；owner 来自 grenade owner handle → player entity metadata → SteamID，不是昵称或空间最近者 |
| Parser → MatchEvent | `providers/converters.ts` 将 smoke/flash/HE `*_detonate` 映为 `utility.action=detonate`，inferno_startburn 为 start_burn，decoy_started 为 start_decoy，tick 原样保留；weapon_fire 为独立事件 |
| ReplayUtilityEffect | `providers/replay.ts::buildUtilityEffects` 使用 utility tick 作为生效 tick，并通过 owner/entity/连续 run 关联 flight；weapon_fire 只辅助 flight 起点锚点和 fire variant |
| DesktopReplayEvent | `electron/replay-session.ts` 基线把 utility 的原 tick 写入列表，文案统一“投掷了”；用户看到的 +秒数为 `(event.tick-round.startTick)/64`，含冻结阶段 |

native 本地源码在 `vendor/demoparser/.build/work/src/parser/src/second_pass/`；
`e2e_test.rs` 的 weapon_fire、smokegrenade_detonate、inferno_startburn 测试也分别保留 weapon、
entityid、坐标、user_steamid 和事件 tick。审计依据实际 Dust2 原生记录交叉验证，没有仅凭测试名判断。
查询 `grenade_thrown` 在此 fixture 中返回 0 条，未用它编造缺失的出手事件。

## 真实实例

“投掷事件 tick”指同 owner、同类 grenade 的唯一 `weapon_fire`；最后一列为列表生效 tick 相对该事件的差。
所有行的 Match / Replay / Desktop tick 都等于原生生效 tick；关联可信度均为高（限此样本）。

| 回合 | 玩家 / SteamID | 道具 | 投掷事件 tick | projectile 首 tick | 生效 / 列表 tick | 列表回合相对秒 | 差（秒） |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| 1 | karrigan / 76561197989430253 | smoke | 3514 | 3527 | 3859 | 44.421875 | 5.390625 |
| 1 | karrigan / 76561197989430253 | flashbang | 4584 | 4591 | 4695 | 57.484375 | 1.734375 |
| 1 | sh1ro / 76561198081484775 | HE | 3998 | 4004 | 4108 | 48.312500 | 1.718750 |
| 2 | zont1x / 76561198995880877 | incendiary | 8877 | 8884 | 9013 | 28.078125 | 2.125000 |
| 3 | ropz / 76561197991272318 | molotov | 16306 | 16313 | 16435 | 29.843750 | 2.015625 |
| 2 | donk / 76561198386265483 | decoy | 8591 | 8597 | 8738 | 23.781250 | 2.296875 |

用户提到的 `+44.42 秒 · karrigan 投掷了 smoke` 正是 R1 tick 3859：
对应 `smokegrenade_detonate.entityid=141`。原生 CSmokeGrenadeProjectile 141 首次出现于 3527，
owner 同为 `76561197989430253`，此前唯一同类 weapon_fire 为 3514。R1 startTick=1016。
因此当前列表时间表示烟雾爆开，不能把“投掷了”作为对该 tick 的准确描述。

## 关联与边界

扫描 367840 行原生 projectile，按 **实体 index + 类别 + 连续 tick run** 分为 633 段。
只关联正式 Replay 回合内 632 个效果（182 smoke、229 flashbang、82 HE、138 fire、1 decoy）；
632 个效果均有唯一 run、唯一同 owner grenade weapon_fire，三个领域/展示 tick 与原生生效 tick 全部相同。
其余 1 段 projectile 不被强行配给现有效果。
独立执行不可变基线 ReplaySession 与当前 ReplaySession，632 个 utility 的 ID、tick、type、actorId、
targetId、position 逐字段相等，只有 description 变为按 action 校验的准确文案。

- smoke / flash / HE / decoy：效果 entityid、projectile class、run 时间覆盖、原生 owner 四项交叉核对。
  smoke projectile 可留存到烟雾结束，run 不必止于 detonate；flash 等则常在生效前 1 tick 最后出现。
- ID 复用：例如 R1 smoke entity 141 在全 DEM 有 2 段，R1 HE entity 143 有 3 段；
  按 run 而非裸 ID 查询，排除其他回合或后续投掷。
- inferno：R2 zont1x 的 inferno entity=100、molotov projectile entity=199；R3 ropz 分别为 216 与 300。
  不假设二者 ID 相同；依原生 owner、CMolotovProjectile、爆开前唯一末段（≤2 tick）关联。
  JSON 同时保留末段实际坐标和生效点，可审查空间一致性；这种关联没有共享序列化 entity handle 的强保证，
  不能对其他 DEM 的多候选情况宣称必然可靠。
- 同 tick 多人：R3 tick 16163 同时有 magixx 与 karrigan 使用闪光弹，owner 与 entity run 分开关联。
- 同人连续：R3 karrigan 在 16060、16163 使用两颗闪光弹；第一颗生效 16178，
  因此按“生效前最近 weapon_fire”会错误选到第二颗。本审计以各 run 的首次观察去查唯一前置 weapon_fire，
  不以生效 tick 直接查最近投掷。
- 火焰 molotov / incendiary variant 来自该 run 关联 weapon_fire.weapon；不从 inferno 名称或阵营猜测。

## 复现与验证

先构建仓库包，然后运行 `node scripts/p7-utility-timing-audit.mjs`。
脚本直接查询本地 native `parseEvents`、`parseGrenades`，再独立调用当前 `parseWithReplay` 和真实
ReplaySession，断言所有列表/领域 tick 与原生生效时间一致；不修改任何产品数据。
输出 `docs/p7-utility-timing-evidence.json` 及本地 `.tmp/p7-timing-audit/all-observations.json`。
JSON 的 verdict 表示运行时实际文案状态；最终集成后应重新运行，要求 `CONFIRMED BUG FIXED`。
审计过程额外执行原生查询，不把其耗时计入 App 性能指标。

本轮实际运行两次审计，首次确认基线 `CONFIRMED BUG`，文案修复后重跑得到
`CONFIRMED BUG FIXED`、632/632 高可信关联、0 歧义、9 个代表实例；
脚本通过 `git show` 读取不可变基线投影器，在同一真实 MatchReplay 上重现 beforeDescription，
不用手写模板充当前版本的实测数据。证据 sourceSha 是审计时 HEAD，测试工作区的源码另记 SHA-256。
`node --test apps/desktop/tests/replay-session.test.mjs`：5/5 通过；新增测试覆盖同 tick 顺序、
160 tick chunk 边界、事件不在 flight 提前出现、按效果 tick seek、倒退重建无未来条目、重复 chunk 无重复。

本结论只适用于该 fixture 及当前 native 版本。视觉动画的人工观感验收与本时间语义判断分开记录。
