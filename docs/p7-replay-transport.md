# P7 Windows 播放器式控制栏验收

日期：2026-10-18。基线：`5b837c780dca0f4765d8b9d975186f01533c3009`。
开始时 HEAD / main / fetch 后 origin/main 相同，工作区干净；提交前再次 fetch，远端基线未变。
本轮止于 P7，未改版本号、tag、release。

## 完成范围

- 地图左列底栏第一行：当前回合经过时间、原 tick 精度 Slider、当前回合总时长。
  时间由 `(tick-startTick)/tickRate` 计算，使用 `mm:ss` / `h:mm:ss`；不可靠速率显示原始 tick，ARIA 同步降级。
- 第二行：只读 `report.match.fileName` prop、五个纯图标控制、倍速及回合 Dropdown。
  文件名去除路径部分、单行省略，Fluent Tooltip 提供完整文件名。
- 两侧使用相同宽度的 Grid 轨道，中央按钮组相对整条地图控制栏居中。
  主按钮 44px 圆形，四个侧按钮 28px；1024 宽度下压缩间距和 Dropdown。
- 回到最初 / 直达最后均暂停并精确定位本回合起止；倒退 10 秒 / 前进 30 秒按实际速率换算，
  所有跳转限制在当前回合，播放中的相对跳转在目标 Chunk 可用后恢复。
  手动到终点不会触发下一回合，正常连续播放仍自然跨回合。
- 倍速支持 `0.25 / 0.5 / 1 / 1.5 / 2 / 4`，使用现有 ReplayClock.setSpeed 重设时间锚点，保持 tick 连续。
  回合菜单仍使用 useRoundMenu，保留 320px 内部滚动与键盘行为。
- 顶栏保留标题、回合标记、连续播放、显示昵称、适用地图的楼层及地图版本标签。
- 按用户最新反馈，冻结阶段标签放在地图容器左下角，left/bottom 10px，fit-content，
  有深色底且不截获鼠标；显示条件仍是原 freezeEndTick 判定。

产品修改仅在 `renderer/src/{replay-player,icons,main}.tsx` 和 `replay-state.ts` 的展示辅助函数。
没有修改 ReplayClock 类、Replay DTO、Parser、原始采样、地图绘制、道具视觉/事件语义或其他业务视图。

## 回归与证据

唯一真实输入：已有 `.demo/dust2.dem`，557650967 字节，SHA-256：
`db90fe85aab023a1d2c8a5996182e6120d98ef494f02a070b17982b235e4958c`。
没有下载、复制、新增或提交 DEM。

| 命令 | 结果 |
| --- | --- |
| `pnpm typecheck` | PASS，15/15 |
| `pnpm build` | PASS，8/8 |
| `pnpm --filter @cs2-analyst/desktop test` | PASS，149/149，0 skip |
| `node scripts/replay-smoke.mjs` | PASS，原报告 fingerprint 不变 |
| `node scripts/p7-ui-acceptance.mjs` | PASS，10 组检查、20 张截图 |
| `node scripts/p7-transport-acceptance.mjs` | PASS，真实 Electron 播放控制专项 |
| `git diff --check` | PASS |
| `git ls-files '*.dem'` | 空，无跟踪 DEM |

单元/SSR 覆盖：非零回合起点、回合终点、小时格式、32/64/128/63.5 tickRate、无效速率、
小数 tick 保留、两端 clamp、1.5× 实际推进与切速连续性、图标及禁用语义、文件名路径剥离。

专项使用 Electron BrowserWindow.setBounds，核对原生窗口和 inner size 都为 1024×640 / 1920×1032；
未用浏览器 viewport 模拟代替。两个尺寸中心偏差均为 0px，页面横纵溢出均为 0，Transport 与地图左右边界一致。
地图容器高度分别为 275px / 663px，Transport 为 100px / 104px；玩家状态和关键事件保持独立右列。
专项验证四个跳转按钮在暂停/播放时的行为、真实 1.5× 和 0.5× 切换、自然跨回合、手动回合切换、
五按钮真实 Tab focus 与可见 Tooltip、菜单滚动/Escape、长文件名省略/Tooltip及重新导入文件名更新。
最终 1.5× 墙钟/Canvas 采样比率为 1.5078；时钟单元测试按精确锚点验证 1.5×。

缺块专项在临时测试进程中包装既有 Main IPC handler，将真实 Chunk 结果延迟 650ms 返回；
不替换 Chunk 内容、不修改产品源码或 DEM。断言确实观察到多个缺块帧、等待期间 tick 不动，
真实数据到达后恢复播放。长文件名是明确标记的内存 presentation prop 用例，不冒充另一份真实 DEM。
最终记录到 188 个真实数据尚未返回的帧，缺块连续帧的 tick 均相等。

截图和 metrics 位于本机 `%TEMP%/cs2-p7-transport-evidence/`，不提交：

- `transport-1024x640.png`
- `transport-1920x1032.png`
- `long-filename-tooltip.png`
- `metrics.json`（倍速实测、缺块逐帧记录、窗口几何、控制台记录）

其余命令日志：`.tmp/p7-transport-{typecheck,build,desktop-test,replay-smoke,ui,special}.log`。
当前会话未提供 Browser skill/runtime，因此复用仓库的真实 Electron CDP 测试路径。
页面身份、非空内容、无框架错误遮罩、应用异常/控制台、截图与交互均检查。
未打包 Electron 的既有 sandbox CSP warning 精确分类并保留原文，其他应用 warning/error 仍使专项失败。

## 复审与剩余边界

独立只读复审检查源码、边界及两种尺寸/长文件名截图。
已修复复审发现的异常速率 ARIA 降级不一致，并增强缺块测试，避免未实际等待数据的空断言。
脚本修正了 Fluent 隐藏但保留 DOM 的菜单/Tooltip 定位、Escape 焦点及事件列表截图滚动稳定性。
最终复审无阻塞问题。

真实专项仅使用 Dust2；其他速率为单元测试，未将其声称为非 64 tick 真实 DEM 验收。
多楼层数据逻辑和楼层选择器未改，本轮没有新增其他地图真实截图。
历史 Replay 查询 5 秒预算仍是独立技术债，本轮未修改解析器。完成后等待人工验收，不进入 P8。

## 2026-10-18：Dropdown 对比度模式适配

- 在 `ui/win11-dropdown-selection` 分支、基线 `04488cbe02381e8945ff64dd726cae42a260636d` 上适配共享 `WinOption`。
- 普通配色保留品牌色背景竖条；`forced-colors: active` 下改为 `currentColor` 实线边框，继续由系统控制配色，不禁用强制颜色调整。`border-box` 保持标识外形为 3×16px；未选中项保持隐藏，Fluent 的选择、键盘、焦点和 ARIA 行为不变。
- 仅改 Desktop 展示和既有 Electron 验收脚本，不涉及领域包、DEM、分析规则或数据契约。
- `pnpm typecheck` 15/15、`pnpm build` 8/8、Desktop tests 150/150、`p7-transport-acceptance.mjs` 均 PASS。
- `p7-ui-acceptance.mjs` 首次与另一 Electron 验收并行运行时在合成事件行滚动可见性断言失败；单独完整复跑全部 10 组检查 PASS，未修改该脚本或放宽断言，首次失败原因未确定。
- 真实 Electron + 原有 `.demo/dust2.dem`，在 1024×640 / 1920×1032 下验证普通配色和 CDP 模拟的深浅强制颜色模式：白底黑条 / 黑底白条、前景色一致、背景色不同、3×16px、未选中项隐藏。控制台与异常检查通过，原有键盘焦点、Escape 和选择流程通过。
- 新截图和颜色/几何记录：本机 `%TEMP%/cs2-p7-transport-evidence/round-menu-{normal,contrast-light,contrast-dark}-{1024,1920}.png` 及 `metrics.json`，不提交图片或 DEM。未在本轮切换真实 Windows 对比度主题；截图使用 Chromium 媒体模拟，不能代表所有自定义系统配色组合。
