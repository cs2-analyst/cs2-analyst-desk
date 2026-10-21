# CS2 Analyst

Windows x64 桌面应用，用于本地 CS2 DEM 赛后分析。Electron + React + TypeScript，UI 使用 Fluent UI v9。确定性 Analytics 与证据化 Findings 独立于桌面界面，不做实时 overlay 或自动扫描 DEM。

## 开发与验证

```powershell
pnpm install
pnpm typecheck
pnpm build
pnpm --filter @cs2-analyst/desktop dev
pnpm --filter @cs2-analyst/desktop test
pnpm --filter @cs2-analyst/desktop test:report
pnpm test:smoke
pnpm --filter @cs2-analyst/desktop pack:win
pnpm --filter @cs2-analyst/desktop pack:win:test
pnpm test:installed
```

当前应用版本为 `0.2.0`（L0–L5 本地比赛库已封板）；生产安装包构建后位于 `release/0.2.0/CS2-Analyst-Setup-0.2.0.exe`。详见 [架构](docs/architecture.md)、[桌面报告](docs/desktop-report.md)、[Windows 打包](docs/windows-packaging.md) 与 [路线图](docs/roadmap.md)。

## P5.6.5 Branding & App Icon

正式产品名为 **CS2 Analyst**。`apps/desktop/resources/branding/cs2-analyst-mark.png` 是不带文字的透明 mark；`cs2-analyst-logo.png` 是带 `CS2-ANALYST` 文字的 lockup。PNG 原图不修改；Windows 使用 `resources/icon.ico` 的七种分辨率（16/24/32/48/64/128/256），标题栏使用 20px mark + CS2 Analyst。

内部 workspace 包、preload bridge 和环境变量统一使用 `@cs2-analyst/*`、`window.cs2Analyst`、`CS2_ANALYST_*`。迁移只改标识与品牌，不修改业务算法。
