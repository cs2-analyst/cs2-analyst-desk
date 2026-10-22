# 比赛记录自我身份与列表交互（2026-10-22）

范围：比赛数据列表、DEM 导入身份提示、每场首页「自己是谁」选择器。版本维持 0.2.0，无 Release/Tag。

## 行为

- 比赛数据列表移除「比赛记录玩家」选择器和「搜索文件名或地图」搜索框；SQLite 目录查询不再接受 `search`，仅保留独立的地图筛选、排序和分页。
- 列表行可直接点击进入比赛；行本身获得键盘焦点并支持 Enter/Space。打开、导出、删除按钮会阻止事件冒泡，不会误触行打开。
- 列表只展示本场「自己是谁」对应玩家的数据：胜/负、所属阵营在前的比分、K/D/A、ADR、Rating、KAST、高光。未选择自己或证据不足时统一显示 `-`，不会用 0 或猜测值填充。
- 地图列副标题显示所选玩家的游戏内昵称与 SteamID；玩家不在名单内或尚未选择时给出明确提示。
- DEM 导入在解析出玩家列表后，由 Main 通过 `report:import-players` 通知 Renderer 弹窗；用户可选择自己或点「稍后选择」，随后分析继续。选择结果通过 `report:select-player` 返回主进程，并在归档提交时写入目录。
- 每场比赛首页（比赛报告视图）新增「自己是谁」WinSelect，可随时修改或清空；修改会持久化到 SQLite，并通过 `libraryRevision` 刷新返回后的列表。

## 数据边界

- 归档 manifest 与 `report.json.gz` 保持不可变；身份选择是目录级的可变偏好，存放在 `matches.self_player_id`。
- SQLite `user_version` 从 1 升到 2；旧的 v1 目录在打开时通过 `ALTER TABLE` 补列，不删除已有比赛。
- `player_summary_cache` 版本升至 `.../adapter-v3`，因玩家摘要新增可证明的初始阵营 `team`（`initialCT` / `initialT` / `null`）。旧缓存按版本失效并可从原报告重建。
- 比分按所选玩家的稳定初始阵营排序：CT 开头玩家显示 `CT : T`，T 开头玩家显示 `T : CT`；没有可证明阵营或总比分时显示 `-`。
- 「稍后选择」不会在重复导入时清掉已有的身份选择；只有显式选择或首页清空才改变 `self_player_id`。

## 本地数据清理

按要求删除了本机现存比赛库：

```text
%LOCALAPPDATA%\CS2 Analyst\MatchLibrary\
```

删除前实际目录包含 2 条目录记录和 2 个比赛归档；执行时先停止本机开发版 Electron 进程，再删除整个 `MatchLibrary`（含 `library.db`、`matches`、`staging`）。源 DEM 与用户其他设置未删除。

## 验证

| 项目 | 结果 |
| --- | --- |
| `pnpm typecheck` | 15/15 通过 |
| `node --test apps/desktop/tests/*.test.mjs` | 313/313 通过，0 skipped |
| `pnpm --filter @cs2-analyst/desktop build` | 通过（含资源校验、Desktop typecheck、Electron/Vite 构建） |
| 新增回归 | 导入玩家提示与取消、身份 IPC 校验、self 列迁移、列表 `-` 填充、阵营在前的比分、首页选择器状态与持久化、行键盘可打开 |

## 已知限制

- 现存 `.cs2a` 导入没有 DEM 解析阶段的玩家提示，身份保持未选择，可在比赛首页补选。
- 旧归档的玩家身份与阵营证据仍受归档内报告限制；无法证明时继续显示 `-`。
- 本记录不重新分析历史 DEM，也不改变既有 Analytics / Findings 规则。
