# CS2 Analyst Agent 项目规范 v1

> 本文件是 Agent 的地图，不是项目百科全书。
> 项目事实写入代码、测试和 `docs/`；详细流程写入 `.agents/`。

## Project Positioning

CS2 Analyst is a Windows desktop application focused on CS2 DEM post-match analysis.

Scope:

- Parse CS2 demo files.
- Build match domain models.
- Analyze player performance with deterministic rules.
- Generate evidence-based coaching findings.

Out of scope:

- Real-time overlay.
- GSI live tracking.
- General CS2 companion features.

## DEM Fixture Policy

- For new development phases, use only local `.demo/<map-name>.dem` fixtures with a map-only filename (for example `dust2.dem`, `nuke.dem`) and `.demo/demo1.dem`, `.demo/demo2.dem`, or `.demo/demo.dem`.
- Do not use match-named DEM files or `demo3.dem` for P7+ validation. Historical acceptance records may preserve legacy fixture facts, but legacy inputs must not be reused as new-stage validation evidence.
- The Dust2 real-data fixture path is `.demo/dust2.dem`. If the same local bytes still use an old match-specific filename, rename the file locally to this map-only name without changing its contents; verify its SHA-256 when required.
- DEM files are local-only: never commit them, copy them into the repository, or download replacement samples.

## Architecture Rules

- Desktop application: Electron + React + TypeScript.
- UI system: Fluent UI v9 only.
- Keep domain logic independent from Electron/UI.

Core packages:

- `packages/dem-parser` — DEM parsing adapters.
- `packages/match-model` — CS2 match domain model.
- `packages/analytics` — deterministic statistics and analysis.
- `packages/findings` — evidence-based coaching findings.

Dependency direction:

```text
DEM
 ↓
dem-parser
 ↓
match-model
 ↓
analytics
 ↓
findings
 ↓
UI / AI explanation
```

Do not bypass package boundaries.

## Local Match Library Docs

- Future client-local match library: [roadmap](docs/roadmap.md), [stage gates](docs/match-library-plan.md), [titlebar/nav](docs/match-library-navigation.md), [local archive](docs/match-library-storage.md).
- L0–L5 implementation is explicitly authorized. **L0–L2 PASS; L3/L4 RUNNING; L5 HOLD.** Current gates and evidence: [execution ledger](docs/match-library-execution.md), [L1 evidence](docs/match-library-l1-foundation-evidence.md), [L2 evidence](docs/match-library-l2-offline-restore-evidence.md). Do not bypass dependencies, revive the superseded account/`apps/api` plan, or start P8.

## Agent Workflow

Before non-trivial tasks:

1. Read relevant documents under `docs/`.
2. Check `.agents/workflows/` for applicable workflow.
3. Select the appropriate agent/model according to `.agents/routing/model-routing.md`.
4. Keep the work unit small and independently verifiable.
5. After an independently verifiable work unit passes validation, create a focused Git commit before handoff or starting another independent work unit, unless the user/task explicitly says not to commit.

Important workflows:

- Feature development: `.agents/workflows/feature-development.md`
- DEM analysis development: `.agents/workflows/demo-analysis-development.md`
- Analytics rule design: `.agents/workflows/analytics-rule-design.md`
- Domain model changes: `.agents/workflows/domain-model-change.md`

## Agent Routing

Use model routing defined in:

`.agents/routing/model-routing.md`

General rules:

- Simple edits, documentation, known fixes → lower-cost execution agent.
- Normal implementation with clear design → worker agent.
- Architecture decisions, domain modeling, API boundaries → reasoning agent.
- Difficult diagnosis or high-risk changes → deep solver.
- Independent review for non-trivial changes → reviewer.

Do not use the strongest model by default. Re-evaluate complexity after investigation.

## Development Principles

- Evidence first: every coaching conclusion must reference measurable findings.
- Deterministic analysis is separate from AI explanation.
- Do not let AI invent gameplay conclusions without supporting data.
- Prefer minimal, maintainable changes.
- Do not introduce abstractions without a current requirement.
- Do not refactor unrelated code during feature work.

## Monorepo Rules

- Use pnpm workspace.
- Turbo is used for task orchestration.
- Keep package boundaries clean.
- Shared domain contracts belong in packages, not inside Electron.

## Validation

Before finishing implementation:

- Run relevant typecheck/build/test commands.
- Verify changed package boundaries.
- Report changed files, validation results, and remaining risks.
