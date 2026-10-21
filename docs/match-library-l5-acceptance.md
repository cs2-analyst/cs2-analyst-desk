# L5 · 本地比赛库最终验收记录

> **结论：技术矩阵通过；人工产品验收 NOT RUN。** 本文不宣告版本发布，也不把 L0–L4 证据替代 L5 人工确认。
>
> 产品构建 `63d6e12`；验收记录提交 `4fae411`。机器记录：[match-library-l5-acceptance.json](./match-library-l5-acceptance.json)；各阶段证据见 [执行台账](./match-library-execution.md)。

## 1. 技术矩阵

| # | 场景 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | 生产 NSIS 安装 → Nuke 导入 → 重启 → 卸载保留 | PASS | 安装包 `b92b21e6…68a5d19`；导入 15,266.0ms；冷目录 0.99ms；卸载后 manifest 保留 |
| 2 | test-seam 安装版导出/删除/导入/冷打开 | PASS | `.cs2a` 16,929,688B / 164 文件；删除后 archiveBytes=0；损坏包拒绝；`productRevision=63d6e12` |
| 3 | L1 构建 → 最终构建升级 | PASS | 旧安装包 `1d5960f2…79f75b9c`；升级后旧归档 report `e071bfa7…5771f748` 不变；卸载保留 |
| 4 | 回滚旧构建打开/渲染 | PASS | L1 可列出 ready 归档；L2 构建可打开最终库归档并渲染相同 report `e071bfa7…` |
| 5 | 损坏包（翻转/截断）；路径/UNC/预算 | PASS | 端到端：1 位翻转/截断拒绝、staging 为空、现有比赛可打开；遍历/绝对/UNC/重复/预算由 `library-portable.test.mjs` 单测覆盖，非安装版流程 |
| 6 | 删除单场/活动场/容量 | PASS | 活动场删除 179–250ms；archiveBytes 归零；孤儿恢复与部分失败单测 |
| 7 | 50+ 大库首屏 | PASS（合成） | 50 条合成归档：列表约 5ms、50 行渲染、首屏无 Replay 会话/Chunk；不是真实比赛样本 |
| 8 | 性能 | PARTIAL | 导入 15–20s；打开 2.5–3.1s（全量校验）；列表冷读 1.3ms；Replay 5131.302ms 债未解 |
| 9 | 隐私/网络 | PASS（代码审查） | 无自动上传；导出需用户选择；不保存 DEM |
| 10 | 键盘/高对比度/标题栏双击 | PARTIAL（模拟+原生指针） | CDP forced-colors 下导航仍可见；真实 Win32 双击标题栏最大化/还原 PASS；真实高对比度/Narrator NOT RUN |
| 11 | DPI 125%/150%、物理多屏 | PARTIAL（仅模拟） | CDP 1.25/1.5 DPR 下品牌 delta=0；物理 DPI/多屏 NOT RUN |
| 12 | 人工产品验收 | NOT RUN | 需产品负责人实际打开、导航、导出/导入并签收 |

## 2. 自动化结果

- 全量 Desktop：**285/285 PASS，0 skipped**。
- 类型检查：15/15 任务通过。
- `desktop-report-smoke`（真实 demo1、损坏 DEM、非 .dem）：3/3 场景 PASS，日志 `.tmp/l5/evidence/desktop-report-smoke.log`；共享 window-shell/report-ux 检查已适配 L4。
- 全量测试日志 `.tmp/l5/evidence/desktop-full-test.log`（285/285）、类型检查日志 `typecheck.log`（15/15）；生产安装基础证据已复制为 `.tmp/l5/evidence/production-foundation.json`。
- 集成导航 smoke：24 个几何状态 max delta = 0px；一次后退/前进语义通过。
- 集成数据操作 Dust2/Nuke：PASS；test-seam 安装版 Dust2：PASS。
- 生产安装版：PASS；升级：PASS；回滚：L1 列表/只读 + L2 打开/渲染 PASS。
- 50 条合成库首屏、模拟 1.25/1.5 DPR 与 forced-colors、真实 Win32 标题栏双击：PASS；结果在 `.tmp/l5/evidence/{large-library,accessibility,native-caption}.json`。

## 3. 人工验收清单（NOT RUN）

请产品负责人使用**生产安装包**在一个新的 Windows 用户配置下确认：

1. 首次启动进入「比赛数据」，空状态可选择/拖入 DEM；导入后自动进入比赛。
2. 六个比赛视图可切换；切换多次后单击标题栏「后退」一次回到比赛数据列表；「前进」回到该场最后视图。
3. 打开已保存比赛时源 DEM 不存在仍可用；关闭重启后仍在列表。
4. 删除确认、导出 `.cs2a`（隐私提示）、导入 `.cs2a`、重复导入提示、损坏包错误提示。
5. 1024×640 与 1920×1032 下标题栏品牌居中、按钮/Tooltip/键盘焦点可用；高对比度与 Narrator 走查（物理双击标题栏已由 Win32 真实鼠标测试 PASS）。
6. 卸载后用户比赛库仍在；重新安装后仍可打开。

以上任一项未确认，L5 只能保持“技术通过、人工待验”，不得宣称最终发布完成。

## 4. 保留风险

- Replay 独立查询历史 5131.302ms 超 5000ms 的技术债仍在；归档打开快不代表该债解决。
- 打开归档会完整解压校验全部组件（12–17MB 约 2.5–3.1s）；更大归档/低配机未压测。
- 删除先删索引再清目录；不可清理孤儿会让容量暂时计入，重启重试。
- 跨版本归档的 manifest 版本只做结构校验，未与当前构建逐项比对；升级测试仅覆盖 L1→最终。
- NSIS 仅当前 Windows x64 单用户；升级/回滚仍是同一 0.1.0 版本。
- test-seam 安装包仅用于 QA，不是发布产物。
