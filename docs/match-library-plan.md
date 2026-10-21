# CS2 Analyst · 本地比赛库与历史持久化实施计划

> **当前状态：L0 PASS；L1 PASS；L2 RUNNING；L3–L5 HOLD。** 用户已于 2026-10-21 明确授权一次性实施 L0–L5；2026-10-22 L0、L1 独立审查及总线审核通过，按依赖自动放行 L2，无须逐阶段再次授权。量化证据见 [L0 报告](./match-library-l0-storage-evidence.md)、[L1 证据](./match-library-l1-foundation-evidence.md)，最新状态见 [执行台账](./match-library-execution.md)。不修改版本号/tag/release，不进入 P8。
>
> 设计文档：[导航与标题栏](./match-library-navigation.md) · [存储/容量/可移植档案](./match-library-storage.md)。总路线见 [Roadmap](./roadmap.md)。

## 0. 产品决策（优先级高于历史路线的旧设想）

1. **Windows x64 Local-first**：用户 DEM、解析结果、比赛历史库全部默认保存在本机。不建设历史比赛公共服务端、`apps/api`、账号或云同步；这与 P8 内部职业知识/AI Coach 规划互不影响。
2. **归档解析及分析结果，不留原 DEM**：一场完整历史记录需支持无 DEM、离线恢复比赛报告、深度复盘、回合时间线、分析、比赛回放、热力图及现有筛选。仅报告 JSON 不代表完整历史记录。
3. **用户掌控**：用户手动选择/拖入 DEM，管理比赛库；支持删除、单场导出和单场导入 `.cs2a`（暂定扩展名）。不自动扫描或上传。
4. **导航方案由用户指定（2026-10-18 明确修订）**：第一层**全局侧栏**显示「个人数据」「比赛数据」等一级功能；选中「比赛数据」显示本地比赛列表；点击某一场后，**侧栏整体切换**为已实现的六项比赛功能（不同时显示全局目录，不叠成二级导航树）。单击标题栏「后退」**直接退出该场并回到比赛列表**，比赛内切换 Tab 不逐项进入返回栈；「前进」可重新进入。标题栏左侧放后退/前进，App mark + “CS2 Analyst”整体以**整个窗口**几何中点绝对居中，不受左右按钮数量影响。这种 Shell 层菜单模式切换应尽量原样复用六个现有 Tab，减少迁移重构。
5. **容量先验后设计冻结**：一份 Dust2 DEM 约 558 MB，而旧实测 Replay 未压缩 JSON 约 34.80 MiB；预估 10–30 MB/场压缩归档仅为规划假设，必须 L0 实测报告/Replay/热力图证据，不能当作真实结果或确定配额。
6. **数据真实性与版本**：历史数据是已分析成果的快照，保留原证据、算法/报告版本及局部不可用状态；打开历史时不重新解析 DEM，不暗中以新算法覆盖旧比赛。
7. **不与 P8 混排**：本计划采用临时代号 **L0–L5（Local Match Library）**，不是 P8，也不擅自给它分配未来产品版本。本次用户已授权全部 L 阶段；P8 AI Coach 继续暂停。

## 1. 分阶段计划

| 阶段 | 任务 | 核心交付 | Gate / 结束条件 |
| --- | --- | --- | --- |
| **L0 — Storage Evidence Spike** | 只测量不实施功能 | 固定 Dust2 与至少一种可用白名单样本：完整 DTO、Replay、Heatmap 所需证据的原始/压缩大小、归档候选格式、随机读取/恢复实验、容量与风险报告 | 真实字节数据、压缩/解压耗时、无 DEM 的完整重开可行性与契约覆盖均可复核；无擅自删减热力图筛选 |
| **L1 — Local Library Foundation** | 建立本地索引及归档写入器 | SQLite 选型验证、LocalAppData 目录、entry/manifest/version、写入 staging 与事务/崩溃恢复、SHA 去重、库列表 IPC | 新 DEM 生成一条持久比赛记录；重启记录存在；失败/取消无半写/旧数据丢失 |
| **L2 — Fully Offline Restore** | 历史比赛完整可重开 | report、Replay 分块随机载入、Heatmap 规范数据重新筛选、临时 sessionId 重建与 release、无 DEM 回归 | 离线且原 DEM 移走：全部六视图、多个玩家/回合/楼层/网格、Replay 动画效果/seek 与基线等价；大库初屏不全量加载 |
| **L3 — User Data Operations** | 用户管理/便携性 | 删除/批量删除、实际占用容量、带安全校验的 `.cs2a` 导出与导入、重复归档与旧版本提示 | export → 删除 → import → 离线完整重开；损坏/恶意/超预算文件拒绝且不影响已存档 |
| **L4 — Desktop Navigation & Library UX** | 按已批准导航设计实现 UI | Shell 级**全局/比赛详情两种互斥侧栏模式**（「个人数据」「比赛数据」等一级菜单；点开比赛切为原有六项），标题栏后退/前进、品牌整窗绝对居中，比赛列表与空状态/筛选/Toast | 1024×640、1920×1032 真机 Electron 中心误差≤1 CSS px；**比赛内多次切 Tab 后一次后退即退出到比赛数据列表**、前进重入；六视图原组件不重构、拖拽/键盘/高对比度回归 |
| **L5 — Full Acceptance & Release Readiness** | 跨比赛、部署、恢复与安全验收 | 真实白名单矩阵、压力与故障注入、产物/安装版 smoke、版本升级/回滚策略、来源/隐私确认 | 用户人工验收且完整门槛达标后，才讨论版本发布；P8 不自动启动 |

**顺序规则**：L0 必须先于 L1–L5；L1 先于 L2；L2 先于 L3/L4；L3 与 L4 的实现顺序可在数据契约冻结后再微调。每一阶段独立设计、提交、测量、验收，不允许把 L0 直接扩张为全功能开发。

## 2. 技术职责与避免重复

现有系统：
- `packages/dem-parser` 在 import 时读取 DEM、生成 SHA-256 Match ID；`report-worker.ts` 一次性生成报告、`ReplaySession` 和 `HeatmapSession`。
- `report-contract` 当前 report v2、Replay Chunk v1；`renderer/src/store.ts` 一次仅持有一个 report，下一次 import 会替换它。
- `ReplaySession` 当前至多 64MiB 内存 JSON Chunk；历史读取不可每次无界加载几百场。
- `HeatmapSession` 默认 32×32 投影仅为缓存，其余筛选要求 Match/Replay/Spatial 来源，必须保留等价可投影证据。
- `app-titlebar.tsx` 当前 mark+名称靠左，窗口按钮靠右；L4 按整窗几何约束调整。

未来分层建议：
- `apps/desktop/electron` 或明确的桌面本地服务层：SQLite catalogue、归档管理、受信 IPC 访问。
- 独立的归档契约/编解码纯模块（可落在 `packages/` 或 desktop shared，依据是否有跨端消费实需选择，避免无需求抽象）。
- 现有解析与 Analytics packages 不直接依赖数据库/UI。Renderer 不拿 fs/SQLite/native 模块。
- 现有媒体资产从 App bundle 引用，每场文件只保存数据和可追溯版本。

L0 已验证完整规范源 A 与独立 gzip-6 分块、内置 SQLite 轻索引的可行性；生产 manifest/API 由 L1 实现、审查后冻结。当前业务实现授权来自用户的 L0–L5 一次性交付任务，不以规划文档替代技术 Gate。

## 3. L0 的不可妥协验收

1. 使用本地白名单 `.demo/dust2.dem` 且校验既有 SHA；禁止下载、替换、提交 DEM。
2. 真实重新计算并记录 report、Replay 全 Chunk、默认及动态 Heatmap 源、所需 Match/Spatial 的字节数；对每类数据报告未压缩、gzip/Brotli 或实验性候选格式压缩后的体积，记录命令、机器、源码 SHA、文件 SHA。
3. 数据恢复 Gate：关闭应用和 Utility，移走 DEM，再以实验性本机快照复原报告、Replay 和热力图全部现有筛选；比较 summary hashes 和随机样本原始 tick，失效功能不能虚报 PASS。
4. 测试按需随机读取 100+ Chunk、重复打开 10+ 场（可用同一 fixture 的**隔离测试副本**进行性能模拟，但不能虚报拥有多个真实比赛）及删除/重写失败；不能因为某场 35MiB JSON 就默认每场都小于某固定上限。
5. 给出是否采用压缩分块、热力图规范源选型 A/B、SQLite 绑定、LocalAppData 目录策略的**推荐及证据**。
6. 报告峰值内存、导入总耗时、归档写入增量耗时、冷启动库展示与随机打开延迟；不得把 Replay 的既有 ≤5 秒性能债“算作已解决”。

## 4. 后续功能验收要点

- **一致性**：P3 Analytics、Findings、Deep Review、Timeline 报告指纹不变；Replay 轨迹/火烟闪 HE 效果/事件时间与同 tick 索引保持；热力图三层及 all-valid/uniform-8hz、玩家/阵营/回合/楼层/冻结时间等请求复现。
- **完整性**：失败、取消、杀进程/重启、磁盘满、权限错误、版本损坏、重复导入、同名不同文件、删除活动比赛无污染。
- **安全**：无任意文件路径暴露给 Renderer，导入归档防 zip bomb/路径穿越/越权读取；无后台个人 DEM 上传；导出会提示包含玩家数据。
- **可用性**：Windows 自绘标题栏真实拖动/双击/窗口控制保留；品牌整窗精确居中且不遮挡左右按钮；全局侧栏「个人数据/比赛数据」与比赛详情六项为**互斥菜单集**；标题栏历史只记录全局页面/比赛工作区进出，不记录比赛内 Tab、Replay tick。一次后退可从任意比赛 Tab 退出到来源比赛列表；前进可重新进入。
- **安装版**：生产/测试 seam 编译、NSIS 安装/卸载和用户档案保留策略有真实验证，不因“本机 dev 能用”就判定发布通过。

## 5. 已知非阻断问题与保留边界

- Replay 原有 ≤5s 查询/解析性能预算有历史 6.137s 记录，另设专项任务；不能被新归档功能默认豁免。
- 地图雷达版本匹配仍 unconfirmed，跨层/多地图真实轨迹与热力图验收必须有真实数据；数据存档不提高空间证据准确性。
- Valve 官方图片/素材可能涉及分发授权，导出包不得携带公共资源，不表示许可证问题已自动解决。
- 默认仅支持 Windows x64；未来有平台需求再评估 SQLite/本机路径格式，不将迁移到移动端作为当前任务。
- 当前明确没有公共历史云服务端、用户账号及自动扫描。以后只有用户提出并授权时才重新规划。

## 6. 文档与工程协作规则

- 路线图主索引：`docs/roadmap.md`；交互权威：`docs/match-library-navigation.md`；存储权威：`docs/match-library-storage.md`。
- 每阶段仅在用户授权后创建对应 implementation/spec/test，完成后更新状态和量化证据，不能将 `PLANNED` 误报为 `PASS`。
- `AGENTS.md` 维持短 map 原则，新 Agent 依据 Roadmap 入口找到本组文档。
- P8 AI Coach `docs/ai-coach-technical-route.md` 仍为独立技术规划，未启动；本地比赛库不迁移职业知识资产。
