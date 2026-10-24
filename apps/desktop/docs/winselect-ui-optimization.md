# WinSelect 组件 UI 优化

## 范围

使用 Fluent UI v9 的 Dropdown、Option、OptionGroup 和 Tooltip，支持长文本省略、列表高度控制及分组。键盘导航、选中状态和 ARIA 仍由 Fluent 管理。修改仅在桌面 Renderer 展示层，不改变报告契约、解析或分析逻辑。

## 长文本省略与 Tooltip

实现：`apps/desktop/renderer/src/winui-option.tsx`。

- 内容 span 使用 `overflow: hidden`、`text-overflow: ellipsis`、`white-space: nowrap` 和 `min-width: 0`。
- 通过内容元素的 ref 比较 `scrollWidth` / `clientWidth`；不依赖 Griffel 生成的 class 名。
- ResizeObserver 直接观察内容元素，窗口尺寸或内容变化后重新检测；卸载时断开观察。
- 只有内容溢出且有文本时，hover/focus 才显示完整文本的 Tooltip。没有显式 `text` 时，普通字符串或数字 children 可作为文本。
- Tooltip 包装结构固定，溢出状态切换不会重新挂载 Option，避免丢失 Fluent 注册及焦点状态。
- 目标玩家选项直接使用昵称作为内容，不再叠加单独的昵称 Tooltip。

## 列表高度与覆盖规则

实现：`apps/desktop/renderer/src/winui-select.tsx`。

选择器默认宽度统一为 **190px**，不随选中昵称长短变化。“自己是谁”和“目标玩家”直接使用共享默认值，不再分别设置 190px / 250px。触发按钮的文本使用可收缩的独立 span 和 `minmax(0, 1fr)` 网格列，长文本省略，箭头保持可见。列表默认跟随触发按钮宽度。调用方仍可用 className/style 或 button slot 显式覆盖布局，例如热力图的 `width: 100%` 和回放工具栏的紧凑宽度。

默认最大高度为 `min(320px, calc(100vh - 96px))`，选项过多时内部滚动。Fluent 定位会写入行内 `max-height`，因此共享 CSS 使用带 `!important` 的规则，通过 CSS 自定义属性 `--winselect-max-height` 提供实际高度值。React 行内样式值中不包含 `!important`。

覆盖顺序：`listbox.style.maxHeight` > `maxHeight` > 默认高度。`listbox.style.maxHeight` 支持 CSS 长度字符串和数值（px）。只设置 `listbox` 的宽度或其他属性时，仍保留默认高度和滚动。`listbox` 其他 slot 属性及自定义 class 继续传递，class 使用 `mergeClasses` 合并；传入 `listbox={null}` 保留 Fluent 的禁用 slot 语义。

```tsx
// 默认高度
<WinSelect items={items} value={value} onValueChange={onChange} />

// 自定义高度
<WinSelect items={items} value={value} onValueChange={onChange} maxHeight="400px" />

// 设置宽度，仍保留默认高度
<WinSelect items={items} value={value} onValueChange={onChange}
  listbox={{ style: { maxWidth: '250px' } }} />

// listbox.style.maxHeight 优先于 maxHeight
<WinSelect items={items} value={value} onValueChange={onChange} maxHeight="400px"
  listbox={{ style: { maxHeight: 180, maxWidth: '250px' } }} />
```

## 分组及目标玩家开局阵营

```ts
export type WinSelectItem = { value: string; text: string; label?: ReactNode };
export type WinSelectGroup = { label?: string; items: readonly WinSelectItem[] };
// items 支持 readonly WinSelectItem[] | readonly WinSelectGroup[]
```

有标题的组使用 Fluent OptionGroup，无标题的组展平为选项。选中值和触发按钮文本从所有组中查找，原有扁平列表 API 保持兼容。

目标玩家分组由 `apps/desktop/renderer/src/player-select-groups.ts` 生成，`main.tsx` 按 players/timeline 引用缓存结果：

1. 只使用各玩家 **第 1 回合（round === 1）** 的 side 作为开局阵营证据；不依赖数组顺序，不统计多数阵营。
2. 按“开局CT”“开局T”顺序展示非空分组，组内保留原玩家顺序。
3. 换边、加时及 CT/T 回合数相同都不会改变分组。
4. 第 1 回合缺失、side 为 Unknown 或 timeline 缺失时，玩家保留在末尾的无标题选项中，仍可选择；不从后续回合猜测开局阵营。

## 验证记录（2026-10-25）

| 验证 | 结果 |
| --- | --- |
| `pnpm typecheck` | PASS，15/15 tasks |
| `pnpm --filter @cs2-analyst/desktop build` | PASS，含桌面类型检查、13/13 地图资源及 Main/preload/Renderer 构建 |
| `node --test apps/desktop/tests/player-select-groups.test.mjs apps/desktop/tests/report-ux.test.mjs apps/desktop/tests/app-shell.test.mjs` | PASS，33/33，无失败或跳过 |
| Electron/Chromium 组件交互 | PASS，默认 320px、自定义 180px、slot 数值 120px、仅宽度覆盖、class 高度覆盖及内部滚动；800×360 视口自动限制为 264px |
| 长文本和选中交互 | PASS，ellipsis/完整 Tooltip；扩大内容宽度后隐藏 Tooltip、缩小后恢复，Option DOM 身份保持；键盘 End/Enter、Escape 和鼠标选择通过，无控制台错误或警告 |
| 真实构建应用、`.demo/demo1.dem` | PASS，实际磁盘 File 经 preload/IPC/worker 导入、选择“稍后选择”继续；开局CT/开局T 各 5 人，10 个唯一选项，跨组切换正确，列表 cap 为 320px，无未捕获异常 |
| 默认等宽补验 | PASS，桌面类型检查、构建及上述 33 个用例重跑通过；组件实测默认 190px、长值 ellipsis，显式宽度仍可覆盖；真实 DEM 中两个玩家选择器均为 190px，逐一切换 10 名玩家后目标选择器始终为 190px；Tooltip/高度/键鼠选择交互重跑通过 |

组件测试使用本次实际 TSX 文件构建的临时入口，视口覆盖桌面窗口及 800×360。会话没有 Browser skill，沿用仓库现有 Electron CDP 测试基础设施，无新增测试依赖。组件测试不等同于整页应用验收；真实 DEM 检查另行覆盖实际应用中的分组及选择。

临时脚本和截图均在系统临时目录，不进入仓库：

- `cs2-winselect-qa.mjs`；最终证据目录 `cs2-winselect-qa-h9JzIz`，包含 `groups.png`、`tooltip.png`、`short-window.png`。
- `cs2-winselect-report-qa.mjs`；最终证据目录 `cs2-winselect-report-qa-LClLXi`，包含 `real-demo-groups.png`。
- 等宽补验沿用上述临时脚本：组件证据目录 `cs2-winselect-qa-ughbII`，真实报告证据目录 `cs2-winselect-report-qa-oSB6q2`。

额外尝试 `node scripts/desktop-report-smoke.mjs`：**FAIL，未进入 DEM 报告场景**。`scripts/window-shell-checks.mjs:40` 仍断言标题栏导航仅有 `back/forward`，当前 HEAD 的 `app-titlebar.tsx` 已包含 `back/home/forward`。这两处均未被本次修改；不放宽旧断言、不把该 smoke 记作通过。上述真实 DEM 定向检查独立通过。本次不包含安装版、原生 Explorer 拖放或跨显示器 DPI 验收。

分组回归测试：`apps/desktop/tests/player-select-groups.test.mjs`，覆盖 12/12 换边、时间线倒序、后续多数阵营与开局不同，以及缺失/未知开局证据。

## 2026-10-25：限高列表保留选项行高

问题：只验证列表 `max-height` / `overflow-y` 或分组玩家列表，不足以保证未分组选项的行高。`WinOption` 的 `overflow: hidden` 使其在纵向 Flex 列表中的自动最小高度不再保护内容，默认 `flex-shrink: 1` 会压缩长列表；18 项回合菜单实测行高仅约 15.4px，列表 `scrollHeight === clientHeight === 320`，没有实际滚动范围。

修复：共享 `WinOption` 设置 `flexShrink: 0`，保留 Fluent 默认 32px 自然行高，不另设固定高度。列表仍使用原默认高度上限及内部滚动，自定义高度、文本省略、Tooltip、选中竖条和 Fluent 键盘行为不变。

排查：Renderer 的所有选择器均使用 `WinSelect` / `WinOption`。回放及热力图回合、热力图玩家、自己是谁、导入身份选择和比赛库地图筛选等未分组列表在项数较多或窗口较矮时均可能受影响，共享修复统一覆盖；已分组的目标玩家列表原先行高正常，继续验证其行为。

本次验证：

- `pnpm --filter @cs2-analyst/desktop build`：PASS，包含类型检查、13/13 地图资源校验及 Main/preload/Renderer 构建。
- `node --test apps/desktop/tests/player-select-groups.test.mjs apps/desktop/tests/report-ux.test.mjs apps/desktop/tests/app-shell.test.mjs`：PASS，35/35，0 skip。
- 真实 TSX 组件在 Electron/Chromium 中实测：1024×768 / 800×360，18/40 项回合、11/10/6 项普通列表及 40 项分组列表全部保持 32px；超出实际列表高度时滚动，End 显示末项、Enter 选择末项、Escape 关闭均通过。默认/自定义/slot/class 高度、Tooltip 及鼠标选择回归通过，无应用异常或控制台错误/警告。
- 已构建应用及本地 `.demo/demo1.dem`：回放 24 项、热力图 25 项回合列表均保持 32px，320px 列表内滚动；比赛库地图筛选/排序、导入身份选择、自己是谁、目标玩家、对比指标、回放倍速和所有热力图筛选器逐一验证行高、末项显示及 Escape。页面身份、非空内容、无 Vite 错误遮罩及无未捕获异常均通过。

本次会话没有 Browser skill，沿用项目既有 Electron CDP 验证设施，没有新增浏览器依赖。临时脚本 `cs2-winselect-height-qa.mjs` / `cs2-winselect-height-report-qa.mjs` 和截图存放在系统临时目录，不进入仓库。未执行安装包、多显示器 DPI 或多楼层 DEM 验收；修复仅涉及 Renderer 共用样式，不改变领域包、IPC 或 DEM 数据。

最终本机证据目录：`%TEMP%/cs2-winselect-qa-dQUl2g/`（组件/矮窗口）及 `%TEMP%/cs2-winselect-report-qa-mjn7KO/`（真实应用回放、热力图及 `selector-metrics.json`）。
