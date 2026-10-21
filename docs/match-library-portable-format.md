# `.cs2a` 便携比赛归档格式（L3 冻结候选）

> 状态：L3 实施前的总线冻结候选。L2 已证明本地目录归档可离线恢复；本格式只把同一目录无损打包为单文件，不改变内部组件、不重新分析、不携带 DEM。
>
> 关联：[存储设计](./match-library-storage.md) · [阶段计划](./match-library-plan.md) · [执行台账](./match-library-execution.md)。

## 1. 目标与非目标

目标：单文件、可跨电脑、可校验、可随机读取内部 gzip 组件；导出/导入不依赖 DEM；未知/损坏/超限输入在有界内存内失败。

非目标：标准 ZIP 兼容、通用压缩容器、云同步、携带地图/道具静态资源、携带原 DEM 或绝对路径。

## 2. 字节布局（schemaVersion 1）

```text
offset 0            8 bytes   magic = "CS2A\r\n\x1a\n"
offset 8            4 bytes   headerLength, big-endian uint32
offset 12           N bytes   header JSON (UTF-8, canonical JSON)
offset 12+N         M bytes   payload bytes, concatenated in header.files order
EOF                          exactly 12+N+M bytes; trailing bytes are invalid
```

Header：

```json
{
  "format": "cs2-analyst-portable",
  "schemaVersion": 1,
  "archiveSchemaVersion": 1,
  "matchId": "<64 lowercase hex>",
  "createdAt": "<ISO-8601 with milliseconds and Z>",
  "files": [
    { "path": "manifest.json", "bytes": 44945, "sha256": "<64 hex>" },
    { "path": "report.json.gz", "bytes": 123, "sha256": "<64 hex>" }
  ]
}
```

约束：

- header 为规范 JSON（无多余空白、无未知键），上限 1 MiB；文件数上限 4096；payload 总量上限 256 MiB（与现有 gzip 总预算一致），单文件上限 256 MiB。
- `files` 必须与源归档的精确 inventory 一致：`manifest.json`、`report.json.gz`、`heatmap/{match,replay,spatial}.json.gz`、以及全部 `replay/r<round>-b<block>.json.gz`；不得缺项、重复或附加。
- `path` 只允许上述相对路径；禁止 `..`、反斜杠、盘符、UNC、绝对路径、空段。
- 每个 `bytes`/`sha256` 对应 payload 原始压缩字节；导入时边写边校验，任何不符立即失败。
- 内层 `manifest.json` 仍由 L1 的严格清单校验；外层 header 不替代内层摘要。

## 3. 导出

1. Renderer 只提交 `matchId`；Main 校验 `ready` 并通过 `LocalMatchLibrary.archiveDirectory` 取得目录。
2. 对目录做完整 `verifyLibraryArchive`（L1 全量校验）；任何损坏都拒绝导出，不生成“看似成功”的文件。
3. 计算源文件 inventory 与逐文件 SHA-256，构造 header；再写 header + payload 到目标目录内的临时文件（`wx`），`fsync` 后原子重命名。
4. 对话框只由 Main 调用；Renderer 不获得目标路径。取消或失败删除临时文件，不覆盖原文件。
5. 导出前 UI 明确提示包含 SteamID、昵称、轨迹与比赛记录；不包含 DEM、绝对路径、临时 sessionId。

## 4. 导入

1. Main 选择文件后，先读 magic/header；拒绝错误 magic、非规范 JSON、未知键、版本不支持、超限。
2. 校验 `matchId`、文件路径白名单、无重复、总字节与文件实际大小完全相等；拒绝截断与尾随字节。
3. 在归属明确的 staging 目录内逐文件写入并校验 SHA-256；任何失败删除 staging，不触碰现有比赛。
4. 对 staging 执行 L1 全量 `verifyLibraryArchive`，再 `commitStaging`（内部仍校验压缩摘要）；仅提交成功后才返回入口。
5. 相同 `matchId` 已存在时：先校验旧归档；状态 `ready` 则返回已有记录并标注 duplicate，不覆盖；旧记录损坏则拒绝并要求显式处理。
6. 不支持的新版本显示“该比赛由更新版本导出”，不静默丢弃或重算。

## 5. 安全边界

- 不执行归档内任何脚本/SQL；不访问归档声明的外部 URL/路径。
- 不把整个文件读入内存：header 有界读取，payload 按文件范围流式写入并计算摘要。
- 不在项目目录、临时目录之外写文件；staging 使用 UUID v4，导入完成或失败后清理。
- 测试注入路径（若需要）只在非打包构建/测试 seam 生效，生产安装包忽略。

## 6. L3 验收矩阵（最低）

1. 真实 Dust2：导入 → 导出 `.cs2a` → 删除本地比赛 → 导入文件 → 无 DEM 冷打开；report/热力图/Replay 哈希与首次一致。
2. 真实 Nuke 作为第二样本，至少完成一次导出/导入 round-trip。
3. 拒绝：错误 magic、截断 header/payload、尾随字节、路径穿越、重复 path、未知键、超限、SHA 不符、内层 manifest 被篡改、未知 schemaVersion；失败后现有比赛仍可打开。
4. 重复导入不覆盖旧归档；删除活动比赛先释放 Replay/Heatmap 会话；批量删除中单条失败可报告且不影响其他条。
5. 导出取消/磁盘失败不留下成功文件；导入取消不留下 staging。
6. 容量统计与删除后实际占用一致。
