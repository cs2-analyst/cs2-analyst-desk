# P7 最终补强：多楼层回放正确性 + 展示 UX（待实施）

> 状态：**PLANNED / BLOCKED ON REAL DEM DIAGNOSTICS**。2026-10-18 用户发现 Nuke 多楼层回放存在疑似缺帧。**不得宣称此问题已修复**；本文件记录审查和下一轮实施门槛，不进入 L0–L5 或 P8。基线 `main`：`56cb31ec813362cb5fe7c021285ef6e44ee3101d`。
>
> 产品目标：实现清晰、准确、可复现的双层地图回放；平滑可访问的 Collapse 展开/收起；分析/深度复盘视图内容分组选项卡并内部滚动；比赛报告只给三套布局设计，**不实施布局改造**。

## 0. 执行顺序与拆分

| 工作包 | 内容 | Gate |
| --- | --- | --- |
| **S0 — Nuke Replay Diagnosis**（P0） | 用现有本地 `.demo/nuke.dem` 逐 tick 确认所谓“缺帧”原因 | 数据层/插值/楼层过滤/资源错配可区分，真实故障报告可重放 |
| **S1 — Multi-floor Replay Fix**（P0） | 依据 S0 结论修复回放正确性，不制造假坐标 | Nuke 自动与手动楼层、跨层/死亡/未知 Z、倍速/seek/Chunk 通过真实 Electron；不回归 Dust2 |
| **S2 — Spatial Semantics Audit**（P0 审计） | 横向审查 Nuke/Vertigo：Deep Review、Spatial Evidence、Heatmap 的 Z/楼层覆盖和限制 | 已有 XYZ 与未实现拓扑/LOS 分开记录；无证据的跨层判断不升级为“已适配” |
| **S3 — Collapse Motion**（P2） | 统一展开/收起动画及 reduced-motion | 无状态丢失/焦点错乱、内容不裁断、动画平滑 |
| **S4 — Analysis & Deep Review UX**（P2） | 分析三选项卡、深度复盘两个 Tooltip + 三选项卡、空状态/内部滚动 | 不改变任何指标、Findings、关联回合/回放跳转 |
| **S5 — Report Layout Study**（设计已批准） | 方案 A「顶部 8 KPI + 下方双列独立滚动」经用户正式选定；其他两案仅保留对照 | **DESIGN APPROVED / NOT IMPLEMENTED**；此轮只更新文档，报告 UI 必须另行授权、实机验收 |
| **S6 — Acceptance** | 全量回归与真实 Windows Electron 人工验收 | 本 P7 观察项关闭前，禁止启动 L 或 P8 |

S0→S1 必须分离；无法取得真实 `.demo/nuke.dem` 或未能复现时只报告未验证，不应用“显示旧位置”“猜楼层”“画平滑跨层直线”之类假修复。Vertigo 如无本地真实样本，明确未验收。

## 1. S0/S1 Nuke 回放故障分析与修复边界

### 已经从当前代码确认的事实

- `apps/desktop/shared/replay-map-geometry.ts`：Nuke 两层在 Z=-495 共享边界；Vertigo 两层在 Z=11700 共享边界；共享边界、Z 缺失、越界保守返回 `null`。
- `apps/desktop/renderer/src/replay-state.ts`：`replayDisplayFrame` 对没有同层证据的相邻采样拒绝位置插值；返回中间帧中各玩家 `position=null`，不会延续旧位置。
- `apps/desktop/renderer/src/replay-player.tsx`：`floor='auto'` 依据**选中玩家**当前 Z 决定显示底图层；当选中玩家 Z 缺失时 `layerId=null`，Canvas 绘制有早退条件。玩家绘制也需 `resolveMapLayer(map, p[4]) === view.layerId`。
- `packages/dem-parser/src/providers/replay.ts` 采样 `frames`、`missingPlayerSamples` 和连续段断点逻辑存在；但这些计数并不能直接说明用户看到的“整帧空白”属于原生缺行、保守断开、自动楼层选择还是地图对齐问题。
- 已有 Nuke/Vertigo 资源与楼层合成验证不能替代真实 DEM 全程播放；地图版本仍 `unconfirmed`。

### 强制诊断

对用户本地白名单 `.demo/nuke.dem`（如可取得，先计算并记录真实 SHA-256；严禁下载、更换或将 DEM 提交至 Git）：

1. 找出 3–5 个确切出现“缺帧”的回合与 tick 时间区间（包括自动楼层和手动上/下层对比，录屏/连续帧）。
2. 每个异常 tick 采集：`requestedTick`、`actualTick`、选中玩家 `position/segment/alive/health/side`、相邻帧 gap、`maxInterpolationTicks`、相邻层结果、`floor` 模式、`layerId`、`imageReady`、`chunk` 是否在缓存、`frame=null` 与实际 drawnPlayerCount。
3. 将异常分门别类：A 原生行缺失 / Sample Budget，B 采样跨段断开，C 跨楼层插值被保守拒绝，D 自动楼层因选中玩家死亡/未知 Z 变为 null，E 楼层阈值/版本/资源错误，F Chunk/IPC 等待，G Canvas 绘制与生命周期。
4. 对照实际已验证 Z 与地图层数据；**不要将层切换造成的某些玩家不可见等同于整帧缺失**；必要时把「底图层未知」「玩家位置不可用」「正在等待 Chunk」分别向用户解释。
5. 遵循真实证据：在确定同楼层连续两端采样可靠时才插值，禁止通过跨层直线补位、对未知 Z 猜层、无限维持最后位置来美化动画。
6. 在选中玩家死亡/断线/Z 未知期间，如果 S0 证据确认自动层逻辑导致整帧丢失，可以探索“保留上一个**可靠已确认楼层**为底图展示状态，并明确标签提示跟随目标楼层暂不可判定”，但不能假装当前玩家仍存在此层；该方案必须在真实 Electron 上验收后采用，不能未经实测先固定。
7. 玩家跨层应维持合理的手动楼层选择、图标过滤和持续效果楼层规则；破片/烟火/道具轨迹不从另一层错误穿透显示；存在未知 Z 时尊重现有降级政策。
8. 回归 Dust2（单层）、Nuke（双层）、Vertigo（若确有真实合法样本）、切玩家、死亡/复活/断连、暂停/1×/1.5×/4×、手动 seek、连续播放、Chunk 边界、自动/手动楼层、缩放/DPI，并给缺失率/连续空白时长的前后定量对比。

### S2 空间分析语义审计

分清三种不同能力层级，不能把它们混为一谈：
- **XYZ 事件证据**：已有 Nuke 真实验收（如 `docs/deep-review-spatial-nuke.json`），能记录真实 Z 和准确事件 tick；不等于已通过多层语义验收。
- **热力图楼层统计/雷达渲染**：已有 `resolveMapLayer`/unknownLayer / otherFloor 的保守分类和合成测试；应以真实 Nuke 逐层定位抽查，核查跨层共 XY 的分桶不会产生误导。
- **空间战术含义**：LOS、地图可达路径、跨楼层支援/补枪、水平距离近但实际被楼板隔开等，不具备经验证的拓扑/碰撞语义。不得从 XY 距离或静态 2D 雷达得出安全/可支援/可互见结论；无可靠证据时维持未知，不为了 S2 引入 P8 地图几何或 AI 推理。

审计需列出每种空间相关 Findings / Analytics / Deep Review 展示结论是否使用 `Z`、只报告事实还是隐含相互可达；确定误导才做最小语义/coverage 修复，任何修改必须维持 P3/P4 已冻结 API 和统计口径（确需变更则另行授权）。

## 2. S3 Collapse 动画

当前多处使用原生 `<details>/<summary>`（例如 `main.tsx` Findings 证据、`deep-review.tsx` 说明与限制）与条件渲染（例如回合时间线展开）；默认展开/收起是瞬变。统一约束：

- 采用适合 Fluent UI v9 的高度/透明度过渡，目标 **180–240ms**，ease-out；不引入动画重依赖，也不通过长延时降低响应。
- 内容高度随实际文本自适应；动画不得裁掉最后一行或错误将大内容固定高度。必要时测量 scrollHeight / CSS grid 0fr→1fr，选择健壮方法；关闭必须等动画结束再真正卸载可访问内容。
- 键盘 Enter/Space、焦点保留、`aria-expanded`、屏幕阅读器、与 Tab/隐藏面板共存；快速多次点击状态正确，切比赛不保留旧内容。
- `prefers-reduced-motion: reduce` 关闭或几乎取消过渡；Windows 高对比度不依赖透明度表达状态。
- 仅已打开内容区参与滚动，不得重新引入视图级滚动；回合时间线已有独立内滚区域。
- 先列出所有实际需要动画的 Collapse 入口（包含侧栏折叠，如确认属于本轮范围），逐项回归，避免只改其中一个卡片。

## 3. S4 分析页：三个选项卡 / 独立内部滚动

现有 `apps/desktop/renderer/src/analysis-views.tsx` 三块内容为：全场玩家对比、回合表现趋势、CT/T 表现对比；目前依次垂直排列，由主 `tabPanel` 滚动。改为：

```text
┌─────────────────────────────────────────────────────────────────────┐
│ [全场玩家对比] [回合表现趋势] [CT / T 表现对比]                     │  固定 TabList
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│            当前 Tab 内容（填满剩余视图高度）                       │
│                   内部 overflow-y: auto                            │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

- 第一个「全场玩家对比」默认选中；Tab 使用 Fluent UI v9、受控 selectedValue；点击或键盘切换不破坏指标选择/排序及 Tooltip。
- 主分析页无 view-level Y 滚动；`main.tsx` 给 analysis 独立 `flex:1; min-height:0; overflow:hidden` 的 panel 样式，Tab 内容自身 flex:1/overflow:auto。
- 原有回合趋势横向滚动继续保留；CT/T 比较窄屏时容许内部布局纵向排列。
- 3 个旧分析组件尽量复用，避免重新建领域数据。
- 无分析数据时在 Tab 内容区保持清晰降级，不因缺某玩家对象丢掉 Tab。

## 4. S4 深度复盘：两种标题 Tooltip + 三个选项卡

- 头部「深度复盘」标题右侧增加 `?` Tooltip，内容为原有“根据 DEM 中能够明确记录的交火、人数变化、队友跟进和道具效果生成。”，删除正文解释文字；通过 hover、focus 均可访问。
- `coverage.status==='partial'` 时标题右侧增加 warning 图标 Tooltip，完整保留“这场录像中有部分记录无法完整判断，具体限制可在每张卡片的「说明与限制」中查看。”的原意；当不可用时保留可见的不可用错误正文，不能只藏入 Tooltip。
- 展示区改为 `优先复盘 | 亮点 | 补充观察` 三个 Fluent Tab，**三项始终存在**；每项内容占满剩余高度并在内部纵向滚动，Deep Review View 本身无 Y 页面滚动。
- 默认优先复盘；切换目标玩家或比赛时选中态应重置或保持为合理可预期状态，测试证明确认。
- **缺失数据也保留 Tab**，Tab 内容中心摆放轻量 Fluent 线条图标 + 俏皮但不嘲讽、不中伤玩家的空状态：
  - 优先复盘：`这场暂时没有需要重点复盘的地方，先把好状态保持住。`
  - 亮点：`高光可能在路上，这场还没有足够证据点亮它。`
  - 补充观察：`观察哨今天很安静，没有额外值得补充的记录。`
- 空状态严格写明“没有足够证据/未生成结论”，不暗示“打得完美”；覆盖不可用时使用诚实且明确的数据不可用说明，不用俏皮措辞掩盖失败。
- 既有 `查看相关回合`、`比赛回放 Rn`、`说明与限制` 及证据 DTO 不变；卡片内部 Collapse 动画统一由 S3 处理。
- 响应式：1024×640 与 1920×1032，禁止外层页面滚动；滚动条只在选中 Tab 内容内部。

## 5. S5 比赛报告：方案 A 已获批准，仅设计不实施

**用户已选定方案 A：顶部八项指标 + 下方 Findings / 道具与残局两列独立内部滚动。** 方案 B/C 只留作对照，不能自行切换。完整布局、内容保留、响应式风险、结构示意与门槛见 [比赛报告方案 A 冻结设计](./p7-report-layout-options.md)。仍必须保留 8 项 KPI、Findings、道具、残局、错误警告和证据/回合联动；无页面滚动不能通过裁内容实现。**本次只确认产品设计，没有授权改 Report JSX/CSS。实现应在 Nuke 核心正确性问题得到处理后单独安排。**

## 6. 测试与交付要求

- **第一优先**：真实 Nuke DEM 复现与根因分类 + 修复；既有 Nuke Deep Review 单独验收不自动代表 Replay 通过。
- 测试：Parser/Replay/Heatmap/Deep Review 的相关回归；`pnpm typecheck`、`pnpm build`、desktop tests、真实 Replay/Heatmap/Electron smoke、`git diff --check`、`git ls-files '*.dem'`。
- UI：真实 Electron 1024×640 与 1920×1032，验证 Tab 按键/鼠标/滚动、Tooltip hover/focus、Collapse 动画和 reduced motion、切玩家/比赛后的状态、内容不丢失。
- 交付：出现缺帧的具体 round/tick、原因证据、修复差异与未覆盖样本；具体改动文件、SHA、截图/录屏、测试结果与不可验证项；独立复审。**没跑的验收不能写 PASS**。
- 本轮报告设计为文档-only；Replay ≤5 秒历史预算继续独立跟踪；阶段 L0–L5 与 P8 都不开始。
