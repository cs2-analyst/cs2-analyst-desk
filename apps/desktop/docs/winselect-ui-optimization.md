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

组件测试使用本次实际 TSX 文件构建的临时入口，视口覆盖桌面窗口及 800×360。会话没有 Browser skill，沿用仓库现有 Electron CDP 测试基础设施，无新增测试依赖。组件测试不等同于整页应用验收；真实 DEM 检查另行覆盖实际应用中的分组及选择。

临时脚本和截图均在系统临时目录，不进入仓库：

- `cs2-winselect-qa.mjs`；最终证据目录 `cs2-winselect-qa-h9JzIz`，包含 `groups.png`、`tooltip.png`、`short-window.png`。
- `cs2-winselect-report-qa.mjs`；最终证据目录 `cs2-winselect-report-qa-LClLXi`，包含 `real-demo-groups.png`。

额外尝试 `node scripts/desktop-report-smoke.mjs`：**FAIL，未进入 DEM 报告场景**。`scripts/window-shell-checks.mjs:40` 仍断言标题栏导航仅有 `back/forward`，当前 HEAD 的 `app-titlebar.tsx` 已包含 `back/home/forward`。这两处均未被本次修改；不放宽旧断言、不把该 smoke 记作通过。上述真实 DEM 定向检查独立通过。本次不包含安装版、原生 Explorer 拖放或跨显示器 DPI 验收。

分组回归测试：`apps/desktop/tests/player-select-groups.test.mjs`，覆盖 12/12 换边、时间线倒序、后续多数阵营与开局不同，以及缺失/未知开局证据。
