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
| L0 | `/root/l0_lead` | 无 | RUNNING | 独立分支 `codex/l0-storage-spike`；实验进行中 | 真实容量、冷恢复和全筛选证据未齐，不放行 L1 |
| L1 | `/root/l1_lead` | L0 PASS | HOLD | 只读调查已开展；无产品实现 | SQLite 安装 ABI、持久化故障一致性待验证 |
| L2 | L2 Lead（按槽位启动） | L1 PASS | HOLD | 无产品实现 | 完整热力图源、按需 Chunk、会话生命周期待冻结 |
| L3 | L3 Lead（按槽位启动） | L2 PASS | HOLD | 无产品实现 | 不可信归档边界与删除恢复待验证 |
| L4 | `/root/l4_lead` | L2 PASS | HOLD | 只读调查已开展；无产品实现 | 互斥侧栏、历史栈与整窗品牌中心均须真实 Electron 检查 |
| L5 | L5 Lead（按槽位启动） | L3/L4 PASS | HOLD | 无最终集成验收 | 人工无法执行项记 NOT RUN，不以早期证据替代最终验收 |

## 文件所有权与契约

- 总线：本台账、跨阶段集成及最终汇总；不替 Lead 完成全部编码。
- L0：新增实验脚本/测试、容量 benchmark JSON、可行性报告；不实施完整比赛库。
- L1：待 L0 PASS 后拥有本地服务、归档编码、索引、公共目录契约和 Main/Worker/Preload 基础接入。
- L2：待 L1 PASS 后接管完整离线恢复和 Main/Worker/Preload 会话接入。
- L3：待 L2 PASS 后接管数据操作服务及其受信 IPC；与 L4 通过总线冻结的接口协作。
- L4：待 L2 PASS 后拥有 Renderer Shell/Store/Sidebar/Titlebar/Library UI 及窗口断言适配，复用已有六视图。
- L5：最终集成后的 QA 和交付文档；重型任务与安装测试受总线串行锁控制。

所有接口目前均为候选，尚未冻结。Gate 流程：Lead 自验包 → 独立 Review → 总线核查/集成 → PASS → 总线 UNBLOCK。发现问题退回 FIX_REQUIRED。

## 不得遗失的历史边界

- P7 Final Acceptance 已获产品签收；不改写其原始验收 JSON 或追认未执行项。
- Replay 独立查询历史 5131.302ms 超 5000ms，仍为已有技术债；归档快开不能证明该债已解决。
- 地图与 DEM 版本匹配 unconfirmed；真实 Vertigo、Explorer chooser、Narrator/NVDA、物理跨屏 DPI 等历史未覆盖项保持原分类。
- DEM 仅使用本机白名单，不复制、不下载、不提交。样本数与隔离副本模拟规模分别记录。
