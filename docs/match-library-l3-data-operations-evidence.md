# L3 · 本地比赛数据操作实现与 Gate 证据

> 状态：实现、真实 Dust2/Nuke 验收与独立复核修复完成；待最终 delta 确认。本文只证明 L3，不构成 L4/L5 验收。
>
> 基线 `c17bcf5`（L2 PASS），产品构建 `1b812ae`。机器证据：`.tmp/l3/evidence/{dust2,nuke}-data-operations.json`（已忽略）。格式规范：[.cs2a 便携格式](./match-library-portable-format.md)。

## 1. 交付范围

- **删除**：`LocalMatchLibrary.remove` 串行删除 1–100 个唯一 64 位 matchId；每个索引行独立事务，随后清理所属归档目录；单条失败逐项返回；活动比赛先让 Utility 真正退出（3 秒上限）再删，失败则保留该 ID 的归档。
- **导出**：Main 独占保存对话框；只接受 `ready` 记录；先全量校验源归档，再写目标目录内临时文件（`wx` + fsync + 大小核对），最后原子重命名；失败/取消清理临时文件；Renderer 只收到 basename 与字节数，不获得路径。
- **导入**：Main 独占打开对话框；`.cs2a` 先流式解包到 UUID staging，逐文件校验字节/SHA-256，再执行 L1 全量校验，最后 `commitStaging`；任何失败清理 staging 且不触碰现有比赛；重复 matchId 返回已有 `ready` 记录并标记 duplicate，不覆盖。
- **互斥**：open/import/remove/export 共用 Main 门闩；导出期间不能删除或打开同一归档。
- **便携容器**：magic + 32 位 header 长度 + 规范 JSON header + 顺序 payload；header ≤1 MiB、4097 文件（含 manifest）、256 MiB payload/单文件；路径白名单、精确 inventory、无尾随字节、拒绝截断/重复/未知键/路径穿越/UNC/绝对路径/版本不支持/摘要不符。

## 2. 验证矩阵

| 层级 | 命令/场景 | 结果 |
| --- | --- | --- |
| 聚焦测试 | `node --test apps/desktop/tests/library-{portable,main}.test.mjs apps/desktop/tests/local-library.test.mjs apps/desktop/tests/library-contract.test.mjs` | 57/57 通过，0 跳过 |
| 全量 Desktop | `CS2_ANALYST_FIXTURE_ROOT=E:\cs2-analyst\.demo pnpm --filter @cs2-analyst/desktop test` | 270/270 通过，0 跳过 |
| 类型检查/构建 | `pnpm --filter @cs2-analyst/desktop typecheck` / `build` | 通过 |
| 真实 Electron Dust2 | 导入 → 导出 → 删除 → 导入 `.cs2a` → 无 DEM 打开 | PASS，见 `3 |
| 真实 Electron Nuke | 同上 | PASS，见 `3 |
| 损坏包 | 1 位翻转 + 截断 1 字节 | 两者拒绝；staging 为空；现有比赛仍可打开且报告哈希一致 |

## 3. 真实数据证据

| 项目 | Dust2 | Nuke |
| --- | --- | --- |
| 源 SHA-256 | `db90fe85…b235e4958c` | `dea9382b…af6f5cb3c` |
| 导入到 ready | 15,329.8 ms | 14,592.5 ms |
| 导出 `.cs2a` | 3,655.1 ms | 1,957.8 ms |
| 活动比赛删除 | 229.5 ms | 179.2 ms |
| 导入 `.cs2a` | 3,213.0 ms | 2,406.2 ms |
| 无 DEM 冷打开 | 2,946.8 ms | 2,664.3 ms |
| 包大小 / 文件数 | 16,929,688 B / 164 | 12,083,594 B / 146 |
| 包 SHA-256 | `287d2fd5…128b04f1` | `9bd8d8f5…d7fae9ba` |
| 报告指纹 | `e071bfa7…5771f748` | `be4cf411…9e7f643d8` |
| 热力图/Chunk 对照 | 3 组 + 2 块一致 | 3 组 + 2 块一致 |
| 删除后 archiveBytes | 16,909,376 → 0 | 12,065,513 → 0 |

导入 `.cs2a` 后的报告中 Replay sessionId 为新 UUID；六视图渲染；`sourceAbsent=true`；`catalogues` 在删除后为 0 条、导入后为 1 条；损坏包导入不改变该记录。

## 4. 审查驱动修复

- 独立复核 P2-1：删除目录失败会先删索引；若遗留目录含 junction/ACL 等不可删除项，旧 `recover()` 会让整库打不开。已改为按孤儿诊断并保留、继续打开其余比赛；删除失败文案不再承诺重启必然清理。
- 独立复核 P2-2：重复导入时，旧档校验的瞬时 `EBUSY/EACCES/ENOENT` 会把健康记录标为 `invalid`。已只在 `Invalid match archive`/`ARCHIVE_UNSUPPORTED` 等确定性损坏时降级；瞬时 I/O 保留 `ready`。
- 导出与删除/打开/导入互斥；便携文件上限改为 4097（含 manifest），与 L1 的 4096 组件上限对齐。
- 已知 P3：导入/导出在 Main 内全量校验（2–4 s）没有进度事件，L4 以 busy 状态呈现；删除目录失败时该行已删除，容量可能暂时计入孤儿直到重启清理；仅验证 Dust2/Nuke，未跑 NSIS/跨机器。

## 5. 明确未证明

- 生产安装版下的原生对话框路径未验证（L5）；开发 seam 在打包/测试安装版被刻意忽略。
- 真实 ACL/EBUSY 故障仅用 junction 场景覆盖；跨机器、不同 Windows 版本、导出覆盖已有文件未逐一验证。
- 不覆盖 L4 导航/UI 与 L5 最终人工验收；Replay 5131.302 ms 历史债不变。
