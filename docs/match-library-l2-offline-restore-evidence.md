# L2 · 无 DEM 离线恢复实现与 Gate 证据

> 状态：L2 通过（产品构建 `5875e92`，真实验收与独立复核完成）。本文只证明 L2，不构成 L3–L5 或最终发布验收。
>
> 基线 `8e18abc`（L1 PASS），产品构建 `5875e92`；测试收尾 `01f0413`。机器证据保存在 `.tmp/l2/evidence/`（已忽略，不进仓库），其中 `productRevision` 为 `5875e92`。

## 1. 交付范围

- 新增受信 `library:open`：Renderer 只提交 64 位十六进制 `matchId`，Main 从本地目录取 `ready` 记录并派生归档目录；不接受路径、SQL 或任意目录。
- 每次打开生成新的临时 `sessionId`，由新的 Utility Worker 完整校验归档、重建 Replay 分块访问与 Heatmap 会话。
- 打开成功前旧 Worker、旧 Replay/Heatmap 会话保持可用；失败、超时、进程退出或报告身份不符时保留旧会话。
- 导入与打开互斥；打开期间不会启动第二次导入。
- 恢复 Worker 在成功后继续处理 `heatmap:grid` 与 `replay:chunk`，响应仍受 session、回合、块号、1 MiB 和超时约束。
- Renderer 增加最小 `opening` 状态与首页「本地比赛」入口；最终导航/列表/标题栏历史归 L4，本阶段不冒充完成。

## 2. 恢复路径与失败语义

1. Main 校验 `matchId`、调用方 frame、`entry.state==='ready'`，再向库请求 `archiveDirectory`。
2. 启动独立 Utility，发送 `{kind:'restore', archiveDirectory, sessionId}`；60 秒独立超时。
3. Worker 执行完整 `verifyLibraryArchive`（清单、report、Heatmap 源、全部 Replay Chunk），再读取 report/规范源并创建 HeatmapSession；任何失败都只影响候选 Worker。
4. Main 只在收到 `restored` 且校验 `schemaVersion=2`、`match.id`、Replay/Heatmap `sessionId` 后，才停止旧 Worker、切换活动会话并返回报告。
5. 失败路径终止候选 Worker；旧活动会话不变。成功后旧 Worker 被释放，新会话接管回放/热力图请求。
6. `session:release` 仍只结束当前会话；迟到的旧会话回包不能命中新会话。

## 3. 验证矩阵

| 层级 | 命令 / 场景 | 结果 |
| --- | --- | --- |
| 聚焦测试 | `node --test apps/desktop/tests/library-{archive,contract,main,store}.test.mjs apps/desktop/tests/local-library.test.mjs` | 51/51 通过，0 跳过 |
| 全量 Desktop | `CS2_ANALYST_FIXTURE_ROOT=E:\cs2-analyst\.demo pnpm --filter @cs2-analyst/desktop test` | 246/246 通过，0 跳过 |
| 类型检查 | `pnpm --filter @cs2-analyst/desktop typecheck` | 通过 |
| 真实 Electron | `node scripts/library-restore-acceptance.mjs .demo/dust2.dem` | PASS |
| 真实 Electron | `node scripts/library-restore-acceptance.mjs .demo/nuke.dem` | PASS |

验收将本地 fixture 复制到归属明确的临时目录后导入，关闭应用并删除该副本；第二次启动时源 DEM 已不存在。原始 `.demo/dust2.dem`、`.demo/nuke.dem` 未被修改、移动或复制进仓库。

## 4. 真实数据证据

| 项目 | Dust2 | Nuke |
| --- | --- | --- |
| 源 SHA-256 | `db90fe85…b235e4958c` | `dea9382b…af6f5cb3c` |
| 首次导入到 `ready` | 19,268.0 ms | 15,987.9 ms |
| 源 DEM 删除后冷打开 | 3,047.4 ms | 2,553.7 ms |
| 报告指纹（去 sessionId） | `e071bfa7…5771f748` | `be4cf411…9e7f643d8` |
| 热力图筛选对照 | 3 组哈希一致 | 3 组哈希一致 |
| Replay Chunk 对照 | 2 块哈希一致 | 2 块哈希一致 |
| 六视图 | 全部渲染 | 全部渲染 |

热力图对照覆盖：32×32 全范围、16×16 单回合/单玩家/CT/含冻结时间、64×64 指定楼层。Replay 对照取首回合与末回合的独立 Chunk，均去掉新临时 sessionId 后比对。报告指纹与 L1 导入证据一致，说明归档没有重写已分析结论。

`restore.json` 结构化记录 `sourceAbsent`、`freshReplaySession`、`catalogueTotal`、`sixViewsRendered`、首次/恢复后的 report 与 Replay sessionId、两组完整哈希及 `productRevision`；六视图检查还实际执行“跳到回合末 → 回到最初 → 播放 → tick 前进 → 暂停”，不再只断言面板可见。

## 5. 审查驱动修复

- 首次真实恢复验收复现热力图超时：Main 在打开成功后移除了 Worker 的消息监听器，导致后续 `heatmap-grid`/`replay-chunk` 回包无人接收。
- 修复：把两类回包路由抽为 `routeHeatmapReply`/`routeReplayReply`，导入与恢复共用；成功切换后为恢复 Worker 重新挂载该路由。
- 回归测试在打开成功后真实发送 Chunk 请求并注入 Worker 回包，缺失路由会一直 pending，测试会失败；仅断言“请求已发送”不足以覆盖此缺陷。
- 独立复核又发现：恢复 Worker 在成功后崩溃时，活动会话指针不会释放，后续请求只能等超时。已让 `exit` 在 `activeWorker===worker` 时执行 `stopAnalysisWorker()`，并补测试证明 Worker 死亡后 `replay:chunk` 立即报错、旧会话不残留。
- 同时补上导入/打开互斥、恢复 Worker 热力图回包、失败打开后旧 Worker 仍能真正回包、以及 Renderer opening/失败保留旧报告的测试。

## 6. 明确未证明 / 保留风险

- 当前打开会完整解压校验全部组件；16–20 MB 归档实测 2.55–3.05 s。大归档的首屏成本尚未优化为“只校验压缩摘要 + 按需解压”，需在 L5 压力矩阵中继续测量。
- 六视图覆盖面板渲染、Replay UI seek/播放；完整视觉、DPI/高对比度、L4 导航与标题栏历史仍归 L4/L5。
- 仅两份真实比赛；损坏归档、Worker 崩溃、重复打开等由单元/集成测试覆盖，但未在真实 Electron 中逐一注入。
- 不覆盖 L3 删除/导出/导入，不覆盖 L5 安装版全矩阵；Replay 历史 5131.302 ms 性能债不变。
- 首页的比赛列表是 L2 的最小打开入口，不是 L4 已批准的全局/比赛详情互斥侧栏。
