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
| L1 | `/root/l1_lead` | L0 PASS | READY | 环境已准备；待采用最新集成基线 | SQLite 安装 ABI、持久化故障一致性必须实际验证 |
| L2 | `/root/l2_lead` | L1 PASS | HOLD | 只读调查完成；无产品实现 | 完整热力图源、按需 Chunk、会话生命周期待冻结 |
| L3 | `/root/l3_lead` | L2 PASS | HOLD | 只读调查完成；兼任独立 L0 Reviewer，未实现 L0 | 不可信归档边界与删除恢复待验证 |
| L4 | `/root/l4_lead` | L2 PASS | HOLD | 只读调查已开展；无产品实现 | 互斥侧栏、历史栈与整窗品牌中心均须真实 Electron 检查 |
| L5 | `/root/l5_lead` | L3/L4 PASS | HOLD | 只读调查完成；无最终集成验收 | 人工无法执行项记 NOT RUN，不以早期证据替代最终验收 |

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

## 不得遗失的历史边界

- P7 Final Acceptance 已获产品签收；不改写其原始验收 JSON 或追认未执行项。
- Replay 独立查询历史 5131.302ms 超 5000ms，仍为已有技术债；归档快开不能证明该债已解决。
- 地图与 DEM 版本匹配 unconfirmed；真实 Vertigo、Explorer chooser、Narrator/NVDA、物理跨屏 DPI 等历史未覆盖项保持原分类。
- DEM 仅使用本机白名单，不复制、不下载、不提交。样本数与隔离副本模拟规模分别记录。
