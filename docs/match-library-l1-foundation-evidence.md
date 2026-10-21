# L1 · 本地比赛库基础实现与 Gate 证据

> 状态：L1 通过（产品构建 `9809f39`，真实验收与独立复核完成）。本文只证明 L1，不构成 L2–L5 或 L5 最终验收。
>
> 基线 `1af57c8`，实现分支 `codex/l1-library-foundation`，产品构建 `9809f39`。完整机器证据保存在工作树 `.tmp/l1/evidence/`（已被 `.gitignore` 排除）；所有证据的 `versions.sourceRevision` 均为该构建。关键摘要如下。

## 1. 交付范围

- 有界、带版本的 gzip-6 分块归档：`manifest.json`、`report.json.gz`、`heatmap/{match,replay,spatial}.json.gz`、独立 `replay/r<round>-b<block>.json.gz`。
- 只保留分析结果与规范热力图源，不保存 DEM、用户绝对路径或临时 `sessionId`。
- Windows 当前用户 `LocalAppData/CS2 Analyst/MatchLibrary` 下的内置 SQLite 轻索引、`matches/` 与 `staging/`。
- 导入先写 staging、完整解压校验、原子重命名、SQLite `BEGIN IMMEDIATE` 提交；只有 `ready` 索引提交后才允许 Main 发布成功。
- 取消、进程被杀、磁盘写失败、重复导入、损坏索引行、重启恢复均有确定性路径；候选失败不替换已有比赛或活动会话。
- Renderer 只获得列表/容量 DTO；路径、SQL、归档句柄均留在 Main/Utility。

## 2. 关键实现选择

- 归档清单严格限定键集合与规范 JSON（不允许空白漂移），每个成员记录原始/压缩 SHA-256 与字节数；解压前先限制输出。
- 路径安全使用逐级 `lstat` + `realpath`：拒绝 junction/symlink 重定向、网络/设备根、非常规文件；Windows 8.3 别名在非原生检查后展开。
- SQLite 使用 `WAL` + `synchronous=FULL` + 单写者 `locking_mode=EXCLUSIVE`；打开时只接受版本 0/1，并在提交前统一重建小索引。
- 归档与目录共享同一组元数据上限（`LIBRARY_METADATA_LIMITS`），避免“写入成功但列表校验失败”。目录行在重命名前按 UTF-8 字节数再次设界（≤65536），最大合法阵容实测为 57,864 字节。
- 重复导入先完整校验已有归档的清单摘要与索引快照，再丢弃新 staging；不会把损坏旧档静默替换。

## 3. 验证矩阵

| 层级 | 命令 / 场景 | 结果 |
| --- | --- | --- |
| 聚焦测试 | `node --test apps/desktop/tests/library-{archive,contract,main}.test.mjs apps/desktop/tests/local-library.test.mjs` | 45/45 通过，0 跳过 |
| 全量 Desktop | `CS2_ANALYST_FIXTURE_ROOT=E:\cs2-analyst\.demo pnpm --filter @cs2-analyst/desktop test` | 240/240 通过，0 跳过（仅只读引用白名单 DEM，不复制） |
| 类型检查 | `pnpm typecheck` | 15/15 任务成功 |
| 真实 Electron | `node scripts/library-foundation-acceptance.mjs .demo/dust2.dem` | PASS |
| 真实 Electron | `node scripts/library-foundation-acceptance.mjs .demo/nuke.dem` | PASS |
| 生产 NSIS | `pnpm --filter @cs2-analyst/desktop pack:win` 后运行 `scripts/library-installed-foundation.mjs .demo/nuke.dem` | 安装、导入、重启、卸载 PASS；卸载后归档清单保留 |

真实 Electron 验收使用归属明确的临时 `LOCALAPPDATA`，关闭应用后由新进程重开目录；卸载验证只针对自建安装目录，不触碰用户已有安装/比赛库。

## 4. 真实数据证据

| 项目 | Dust2 | Nuke |
| --- | --- | --- |
| 源文件名 | `dust2.dem` | `nuke.dem` |
| 源 SHA-256 | `db90fe85…b235e4958c` | `dea9382b…af6f5cb3c` |
| 导入到 `ready` | 19,509.1 ms | 15,118.8 ms |
| 冷进程目录列表 | 68.7 ms | 72.4 ms |
| 归档 payload（gzip 合计） | 16,864,431 B | 12,025,419 B |
| 含 manifest 的 `storedBytes` | 16,909,376 B | 12,065,513 B |
| 报告指纹（去临时 sessionId） | `e071bfa7…5771f748` | `be4cf411…9e7f643d8` |
| manifest SHA-256 | `fcb9f1f2…2d7aa5e0` | `e50ad4d1…02718f9a` |
| 库状态 | `ready`，24 回合 | `ready`，21 回合 |

生产安装包 SHA-256：`1d5960f26e3478510c6bba85ffe30022c8e516affd75499b7f176b0279f75b9c`。安装版内部再次完成 Nuke 导入（16,244.0 ms）、重启目录（79.4 ms），并在卸载后保留同一 manifest（`cc5865d1…6b8d08`；不同导入时刻会改变 `createdAt`，故与独立运行清单不同）。

每份证据同时验证：

1. 成功返回前已存在 `ready` 索引与完整磁盘归档；
2. 取消候选后旧 `ready` 记录和旧 Replay 会话仍可用；
3. 相同 SHA 重复导入保留原报告指纹与 manifest 原始字节，只返回一次目录记录；
4. 新 Electron 进程只读小索引即可列出比赛；
5. Renderer 无 Node `require`，库 DTO 不含归档路径。

`storage.archiveBytes` 统计 `matches/` 下全部文件（含 manifest），验收脚本的 `archiveBytes` 只累计各 gzip payload；两者差值即 manifest 字节，不能混用。

## 5. 审查驱动修复

- 首次独立早审复现：重复导入未钉住旧索引摘要；一条损坏摘要会阻断整页列表。已分别修复为“旧档完整校验 + 目录行隔离并暴露 `unreadableCount`”。
- 总线复核要求：取消时确认 Utility 已退出再清理 staging；重复恢复独立超时；Worker 启动失败清理；同库双实例争用。均已落实并测试。
- 独立复审发现元数据长度不一致：清单允许版本字符串 1024 字符，目录只允许 256，导致已保存记录在列表阶段被隐藏。`406d0ad` 统一为共享上限并补边界测试。
- 同一轮补强：64 名玩家 × 1024 字符昵称的合法清单会生成 67,981 字节目录行，超过 SQLite 65,536 检查。`64162c7` 将昵称上限统一为 512（真实 CS2 名称远短于此），并在重命名前按字节设界；最大合法行实测 57,864 字节。
- NSIS 验收最初错误假设注册表 `InstallLocation` 非空；实际 electron-builder 该值为空、`UninstallString` 才指向受控目录。`8bf7784` 改为校验卸载路径，仍能证明安装归属，未放宽为任意注册项。
- 最终验证又修复两处只在测试脚本出现的竞态：卸载后注册表键可能在枚举间隙消失（空 `$taskKey`），以及失败路径此前只在 `installed` 标志为真时兜底卸载。产品代码未因此变化；脚本属于 QA 基础设施，不进入安装包。
- 复核提出的低价 P3 已处理：阶段取消清理 `cancelActiveImport`；重复恢复的 `archiveDirectory` 读取失败立即返回错误而不是等待 30 秒；验收脚本直接断言目录 DTO 不含盘符/`MatchLibrary`/`matches`/`staging` 路径。

## 6. 明确未证明 / 保留风险

- 仅覆盖两份真实本地比赛（Dust2、Nuke），不推论所有地图、所有回合长度或超大阵容。
- Replay 历史独立查询 5131.302 ms 超 5000 ms 的技术债 **未** 因归档快开而解决；本阶段冷启动只证明小索引列表。
- NSIS 只验证当前 Windows x64 单用户安装/卸载；不覆盖升级、回滚、多用户或安装到非默认盘符。
- 不覆盖 L2 的“无 DEM 打开历史比赛、六视图与全部热力图筛选”，不覆盖 L3 导出/导入，不覆盖 L4 导航/标题栏，不构成 L5 最终验收。
- `docs/match-library-l1-foundation-evidence.md` 不替代机器证据；机器证据含完整命令输出、时间戳、报告/清单哈希与库目录状态。
