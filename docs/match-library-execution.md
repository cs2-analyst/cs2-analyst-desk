# L0–L5 执行与 Gate 台账

用户于 2026-10-21 明确授权一次性实施 L0–L5、独立审查、集成及最终验收后的 main 推送；取代旧规划逐阶段再次授权要求。技术 Gate、人工验收真实性、P7 封板边界不变；P8 未授权、未启动，不修改版本号或创建 Release。

## 基线与资源

- 初始分支 `main`，基线 `43bbd98fe42adafd501aca6e30af8c253e770e85`；fetch 后与 origin/main 双向差异 0，工作区干净。
- 主代理运行身份为 GPT-6 系列 Codex；运行环境未公开精确模型 ID 或 reasoning effort 数值。协作工具明确保证完整上下文 fork 继承父代理的模型和 effort；所有代理采用此方式，不传不同配置。不能将此描述为已读取精确模型标识。
- 并发上限 4（含总线）。所有 Lead 逻辑角色先登记，按依赖和槽位启动/唤醒，不为占满槽位而轮询。三级执行角色与独立 Reviewer 按资源轮换。
- 全局仅一个真实 DEM 重型工作负载；安装/卸载 E2E 串行。每阶段独立 worktree 与测试输出目录。跨阶段仅接受总线审核发布的契约和集成基线。
- `.agents/workflows/feature-development.md` 在当前基线不存在；采用 `.agents/workflows.md` 和现存 DEM 工作流。历史 `.agents/current-task.md` 不能取代已封板的 P7 S6 文档。

## DAG 与阶段记录

`L0 → L1 → L2 → (L3 ∥ L4) → L5`

| 阶段 | 负责人 | 前置 | 状态 | 实现提交 / 测试证据 | 风险与审核决定 |
|---|---|---|---|---|---|
| L0 | `/root/l0_lead` | 无 | PASS | Gate 包 `481cf79`；集成 `b2f8877`；[报告](./match-library-l0-storage-evidence.md) / [JSON](./match-library-size-benchmark.json)，5/5 纯测试及真实实验 | L3 Lead 独立复核 PASS，总线复核/集成通过，限制保留 |
| L1 | `/root/l1_lead` | L0 PASS | PASS | 产品构建 `9809f39`；QA 收尾 `7de1347`；[证据](./match-library-l1-foundation-evidence.md)，45/45 聚焦、240/240 全量、Dust2/Nuke 真实 Electron、NSIS 安装/卸载 | 独立复审无 P1；唯一 P2 为证据早于最终基线，已按 `9809f39` 重建并重跑；P3 记录在证据文档 |
| L2 | `/root/l2_lead` | L1 PASS | PASS | 产品构建 `5875e92`；测试收尾 `825637b`；[证据](./match-library-l2-offline-restore-evidence.md)，51/51 聚焦、246/246 全量、Dust2/Nuke 无 DEM 重开 | 独立复核 PASS，无 P1/P2；P3：失败打开后 UI 旧会话不可交互、跨版本恢复未比对、重建/证据可追溯性 |
| L3 | `/root/l3_lead` | L2 PASS | PASS | 产品构建 `1b812ae`；[证据](./match-library-l3-data-operations-evidence.md)，57/57 聚焦、270/270 全量、Dust2/Nuke 导出→删除→导入→无 DEM 重开 | 独立复核 PASS；P2 已修（孤儿恢复、瞬时 I/O 不降级）；P3 记录在文档 |
| L4 | `/root/l4_lead` | L2 PASS | PASS | 产品构建 `70dbece`；[证据](./match-library-l4-navigation-evidence.md)，24/24 聚焦、261/261 全量、24 个几何状态 0px | 独立复核 PASS；P2 修复（会话泄漏、筛选丢失、禁用可辨识性、共享检查）；P3 记录 |
| L5 | `/root/l5_lead` | L3/L4 PASS | TECHNICAL PASS / HUMAN NOT RUN | 产品构建 `63d6e12`；[验收记录](./match-library-l5-acceptance.md) / [JSON](./match-library-l5-acceptance.json)；285/285 全量、生产 NSIS（Nuke）、test-seam 数据操作、L1→最终升级、回滚列表/只读 PASS | 旧版打开/渲染、50+ 大库、DPI/高对比度/Narrator、物理双击、人工签收 NOT RUN；不得宣称最终发布完成 |

## L1 收尾与证据

- L1 产品构建 `9809f39` 已通过真实 Electron Dust2/Nuke 导入、取消保留、重复快照、重启冷目录及生产 NSIS 安装/卸载验证；证据的 `versions.sourceRevision` 均为该构建。
- 全量 Desktop 240/240、聚焦库测试 45/45、类型检查通过；全量测试通过 `CS2_ANALYST_FIXTURE_ROOT` 只读引用白名单 DEM，未复制、未提交。
- 审查驱动修复：重复导入钉住旧索引摘要；损坏行隔离并暴露 `unreadableCount`；归档与目录元数据上限统一；64×1024 昵称会生成 67,981 字节目录行，已改为 512 并加 65,536 字节重命名前守卫；NSIS 归属改由 `UninstallString` 证明。
- 最终 NSIS 复跑暴露测试脚本的注册表枚举竞态（键在枚举间隙消失）与失败路径兜底缺口，已在 QA 脚本 `7de1347` 修复；该提交不进入安装包，产品证据仍对应 `9809f39`。
- 保留风险：仅两份真实比赛；Replay 5131.302ms 历史债未解；NSIS 仅当前 x64 单用户路径；不覆盖 L2–L5。
- 执行细节与真实字节/指纹见 [L1 证据文档](./match-library-l1-foundation-evidence.md)。

## L2 收尾与证据

- L2 产品构建 `5875e92` 通过真实 Electron Dust2/Nuke：首次导入后删除源 DEM 副本，新进程从本地归档重开；报告指纹、3 组热力图筛选、2 个 Replay Chunk 与首次一致，六视图渲染并完成 Replay 跳到末回合/回起点/播放/暂停。
- 全量 Desktop 246/246、聚焦库测试 51/51、类型检查通过；验收用临时目录模拟源文件缺失，原始 `.demo` 文件未被修改或复制进仓库。
- 审查驱动修复：恢复 Worker 的回包路由必须在成功后继续挂载；无效/错配 Replay 回包立即结束；恢复 Worker 崩溃时释放活动会话；补齐导入/打开互斥、失败保留旧会话、Renderer opening 状态测试。
- 已知 P3：失败打开后 Main 会话仍存活但 Renderer 因 `status='error'` 将旧会话置为不可交互（L4 处理）；跨版本清单未比对当前构建（L5 矩阵）；打开仍完整解压校验（2.55–3.05s）。
- 细节与机器证据见 [L2 证据文档](./match-library-l2-offline-restore-evidence.md)。

## L3 收尾与证据

- L3 产品构建 `1b812ae` 通过真实 Electron Dust2/Nuke：导入 → 导出 `.cs2a` → 删除活动比赛 → 导入归档 → 无 DEM 冷打开；报告、3 组热力图筛选、2 个 Replay Chunk 哈希一致，六视图渲染。
- 包大小/文件数：Dust2 16,929,688 B / 164；Nuke 12,083,594 B / 146。损坏包（1 位翻转、截断 1 字节）被拒绝，staging 为空，现有比赛仍可打开且哈希一致。
- 复核 P2 已修：不可清理孤儿不再让整库打不开；重复导入的瞬时 I/O 错误不再把健康行降级。导出/删除/打开/导入互斥；便携文件上限 4097（含 manifest）。
- 保留风险：Main 全量校验 2–4 s 无进度事件（由 L4 busy 呈现）；删除目录失败时容量可能暂时计入孤儿；生产安装版原生对话框路径留 L5。
- 细节见 [L3 证据文档](./match-library-l3-data-operations-evidence.md) 与 [.cs2a 格式](./match-library-portable-format.md)。

## L4 收尾与证据

- L4 产品构建 `70dbece`：全局/比赛两套互斥侧栏、六视图复用、比赛数据列表/打开/删除确认/导出/导入、标题栏后退/前进与整窗品牌居中。
- 真实 Electron 24 个几何状态全部 delta 0px（原生 3 状态 + Emulation 精确视口）；六 Tab 可用；切换 7 次 Tab 后一次后退回列表，forward 恢复 `heatmap-tab`。
- 复核 P2 修复：报告异常回退释放会话并替换历史；列表筛选进 store；禁用后退/前进保留可辨识低亮与可聚焦 Tooltip；共享验收改读 `aria-disabled`。
- 保留风险：DPI 125/150、高对比度/Narrator、物理 caption 双击未测（NOT RUN）；列表最多一次 100 条；L3 数据操作的真实 UI 回归已在集成后补跑。
- 细节见 [L4 证据文档](./match-library-l4-navigation-evidence.md)。

## L3/L4 集成

- main 合并 L3 `a0ed197` 与 L4 `2e8ae99`，集成提交 `5abf90b`；全量 Desktop 285/285、类型检查 15/15 任务通过。
- 集成后真实 Electron 数据操作 Dust2/Nuke 再次 PASS（productRevision `5abf90b`）：导入/导出/活动删除/归档导入/冷打开与损坏拒绝全部复现；导航 smoke 24 状态 0px、历史语义通过。
- 集成验证同时修正 L3 验收脚本对 L2 首页选择器的依赖，使其等待 `[data-library-page]` 或空状态。

## L5 技术验收与人工待验

- 生产 NSIS（`d8c6b8c4…8880dec`）在自有目录完成安装、Nuke 导入、重启与卸载保留；test-seam 安装版完成导出→删除→导入→冷打开及损坏包拒绝；L1 安装包→最终包升级后旧归档 report 指纹不变；L1 构建回滚可列出 ready 归档（旧版无 open API，旧版渲染未验证）。
- 全量 Desktop 285/285、类型检查 15/15、`desktop-report-smoke` 3/3、导航 24 状态 0px、集成 Dust2/Nuke 数据操作 PASS；日志与生产基础证据在 `.tmp/l5/evidence/`。
- **人工 NOT RUN**：旧版打开/渲染回滚、50+ 大库、DPI 125%/150%、Windows 高对比度/Narrator、物理 caption 双击、真实产品签收。不得用自动化结果替代人工确认。
- 保留风险：Replay 5131.302ms 历史债；打开全量校验 2.5–3.1s；删除孤儿容量；跨版本版本比对；NSIS 单用户 x64。
- 详见 [L5 验收记录](./match-library-l5-acceptance.md)。

## 文件所有权与契约

- 总线：本台账、跨阶段集成及最终汇总；不替 Lead 完成全部编码。
- L0：新增实验脚本/测试、容量 benchmark JSON、可行性报告；不实施完整比赛库。
- L1：待 L0 PASS 后拥有本地服务、归档编码、索引、公共目录契约和 Main/Worker/Preload 基础接入。
- L2：待 L1 PASS 后接管完整离线恢复和 Main/Worker/Preload 会话接入。
- L3：待 L2 PASS 后接管数据操作服务及其受信 IPC；与 L4 通过总线冻结的接口协作。
- L4：待 L2 PASS 后拥有 Renderer Shell/Store/Sidebar/Titlebar/Library UI 及窗口断言适配，复用已有六视图。
- L5：最终集成后的 QA 和交付文档；重型任务与安装测试受总线串行锁控制。

L0 已审核候选约束：完整热力图源 A、独立 gzip-6 Chunk、内置 SQLite 轻索引；生产格式/API 由 L1 审核后冻结。Gate 流程：Lead 自验包 → 独立 Review → 总线核查/集成 → PASS → 总线 UNBLOCK。发现问题退回 FIX_REQUIRED。

## 恢复执行与早期审查

- 2026-10-22 用户明确要求继续；前次额度中断后复用原工作树、上下文和有效证据，没有重新启动阶段或丢弃已有结果。
- L0 执行角色 `/root/l0_lead/sqlite_executor` 已实现真实 Electron SQLite 及实验六视图恢复验证器；Lead 负责容量工具、源数据实验与报告，总线和未参与 L0 实现的 L3 Lead 独立核查。
- 早审发现并已修复：闪光/HE 枚举导致的验证漏测、空效果集合可能误判、实验耗时命名、GC 调用真实性、SQLite 缺结果/超时诊断与归属进程清理。首轮失败保留，不改写为已通过。
- Node 26 容量实验需要显式 GC 的结果与真实 Electron Node 24 无显式 GC 的恢复结果分开记录；生产 Heatmap 512 MiB 准入保持不变。
- L1 独立工作树 `E:/cs2-analyst-l1` 已准备依赖和固定 native 绑定；未链接或复制 DEM，尚未获得产品实现放行。
- QA 使用归属明确的 `LOCALAPPDATA` 子进程环境隔离本地库；默认生产路径不跟随 `--user-data-dir` 迁移，现有 userData 偏好不变。
- L5 独立预备单元已审核提前集成：`63b8e7e` owned QA helper，`ea6a8c6` 唯一打包 staging；总线集成后 6/6 纯测试及脚本语法通过。此项不依赖归档契约，不构成 L5 正式验收或 NSIS 通过。
- L0 独立审查最终 PASS：45 个 artifact 摘要/字节、12 PNG 尺寸一致；300 个全部 Chunk 和 10 隔离副本已核。总线复跑 SQLite 探针再现约 53ms 句柄释放窗口，集成后 5/5 核心测试通过，2026-10-22 正式 UNBLOCK L1。
- L1 执行角色为 `/root/l1_lead/archive_executor` 与 `/root/l1_lead/catalogue_executor`。基础模块并行提交的依赖顺序与历史顺序不同；最终集成按公共契约→归档→目录→Main/QA，保留原提交，不宣称中间分支历史可独立 checkout 验证。
- 未实现 L1 的 L0 Lead 担任独立 Reviewer：专用 32/32 通过后仍以额外合成库复现上述两个 P2，已退回原 catalogue 执行者修复并补测试。总线另要求候选进程真实退出确认、重复恢复有限超时、fork 失败清理；L1 Gate 尚未提交通过申请。
- L2/L3/L4 工作树已从 `1af57c8` 独立准备并完成 frozen 依赖安装；仅链接固定 native 目录，不复制/链接 DEM，也未越过 HOLD 写产品实现。

## 不得遗失的历史边界

- P7 Final Acceptance 已获产品签收；不改写其原始验收 JSON 或追认未执行项。
- Replay 独立查询历史 5131.302ms 超 5000ms，仍为已有技术债；归档快开不能证明该债已解决。
- 地图与 DEM 版本匹配 unconfirmed；真实 Vertigo、Explorer chooser、Narrator/NVDA、物理跨屏 DPI 等历史未覆盖项保持原分类。
- DEM 仅使用本机白名单，不复制、不下载、不提交。样本数与隔离副本模拟规模分别记录。
