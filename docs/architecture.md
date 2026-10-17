# CS2 Analyst Architecture

## Overview

CS2 Analyst is structured as a desktop application with a deterministic analysis core.

## Packages

- `dem-parser`: CS2 DEM parsing adapter layer
- `match-model`: domain models for matches, rounds and players
- `analytics`: deterministic metrics calculation
- `deep-review`: deterministic Engagement, Kill / Multi-kill, Teamplay, Utility and Combat Execution evidence
- `findings`: pattern detection and coaching evidence
- `report-contract`: JSON-only Electron/Renderer presentation DTO (types only)

The Electron desktop app runs the native parser and the full deterministic pipeline in a Utility Process and sends a serializable report DTO to the sandboxed renderer over contextBridge IPC. The renderer never imports `dem-parser`, Node builtins or Analytics, and never recomputes metrics. Process model, IPC contract and UI: [desktop report](./desktop-report.md).

The Windows window shell is frameless (`frame: false`), with a persistent 40px Fluent UI title bar outside the report error boundary. Only the report content scrolls. Renderer window controls cross the named preload/contextBridge API; Main validates the current webContents and main frame for every invoke, shares the same gate with report import, and broadcasts native maximize/unmaximize state. Caption close calls BrowserWindow.close(), retaining worker cleanup in closed. There is no native titleBarOverlay, menu, renderer Electron access, or change to report data DTOs.

`report-contract` also carries a read-only per-player Round Timeline projection of existing `Match` facts (round side / result / cumulative score plus filtered kill / death / clutch / bomb events with round-relative seconds). It is built in the Desktop presenter from frozen data, never in the renderer, and adds no new Analytics semantics.

`report-contract.analysis` adds presentation-only player comparisons, per-player round trends and CT/T splits. The Desktop presenter copies frozen `PlayerMetrics` and counts existing Timeline kill/death facts; no raw MatchEvent reaches the renderer and no new Analytics algorithm is introduced. Missing round windows are marked incomplete rather than shown as confirmed zero facts.

**Supported platform: Windows x64 only.** Packaging targets the NSIS x64 installer and stages the `win32-x64-msvc` native binding; there is no cross-platform packaging path.

For Windows distribution the Main and Utility Process bundles inline every workspace package, and the native parser is staged next to the worker bundle as an asar-unpacked binding, so an installed application resolves nothing through pnpm workspace links. Packaging layout, staging script and installed-app verification: [Windows packaging](./windows-packaging.md).

The DEM implementation routes native demoparser2 results through an internal adapter and converter before returning `Match`. Native APIs are not exported by the package. The Electron main build keeps the native parser external and bundles the workspace packages. See [DEM parsing](./dem-parser.md) for the current mappings and limitations.

P5.7.1 adds explicit `Demoparser2Provider.parseWithSpatial()` returning Match plus a separate `MatchSpatialEvidence` domain contract from match-model. Its internal adapter reads the DEM once and shares bytes between the existing parser and one sparse spatial query. Core event/boundary ticks survive any budget; optional combat context alone can be trimmed. Event references, exact requested/actual ticks, relations and field coverage preserve missing evidence. Native types/Buffer remain internal; Analytics does not call demoparser2 and Desktop now uses this shared-input path in its Utility Process (P5.7.8). Contract and evidence: [Spatial foundation](./spatial-evidence.md).

P5.7.2 adds `deep-review`, depending only on match-model in production: `dem-parser → match-model → { analytics, deep-review }`. `analyzeEngagements(Match, optional MatchSpatialEvidence, options)` groups explicit hostile damage/kill contacts within formal round windows through shared-participant/time-gap connected components. The default 3-second gap is a product heuristic; no reliable tickRate means contacts remain but time grouping is unavailable. Spatial joins use exact round/type/tick/eventIndex with separate enrichment coverage. Utility and weapon_fire do not create anchors; unknown contact weapons are retained. No cycles, changes to frozen P3/Findings V1, desktop integration, AI or coaching conclusions. Future Findings V2 can consume both independent outputs. Definition, contracts, Nuke invariants and sensitivity: [Engagement analysis](./engagement-analysis.md).

P5.7.3 adds independent `resolveRoundAliveState(Round)` and `analyzeKillImpact(Match, optional EngagementAnalysis)` in deep-review. Freeze-end/start fallback roster evidence and formal victim deaths drive atomic same-tick groups; invalid roster/lifecycle/death/end evidence suppresses counts. Enemy attribution and four-key Engagement linkage have separate coverage. Round multi-kills retain state transitions and final round result without scores, causality or coaching. Spatial evidence is not required. P3 Opening/Clutch/multiKills, Findings V1 and Renderer remain frozen. Contracts, tests and Nuke samples: [Kill impact analysis](./kill-impact-analysis.md).

P5.7.4 adds `analyzeTeamplay(Match, optional EngagementAnalysis, optional KillImpactAnalysis, optional MatchSpatialEvidence, options)` returning independent TeamplayAnalysis. Direct-contact first roles/atomic participant tiers, two-way death follow-up evidence and before/after death counts remain deterministic facts. Default configurable 5s evidence window requires reliable tickRate; dead-before/same-tick killers and ambiguous player state cannot generate negative absence claims. Spatial enrichment uses exact event/sample ticks, deterministic alive-state eligibility and raw XY/Z/XYZ distances; distance never implies supportability, especially across Nuke floors. Four coverage layers preserve event response without Spatial, and incomplete feeds cannot manufacture first-role/none-observed evidence. No P3/Findings V1/desktop changes or scores/coaching. Contracts, structural tests and automatic samples: [Teamplay evidence](./teamplay-evidence.md).

P5.7.5 adds `analyzeUtilityContext(Match, optional MatchSpatialEvidence, optional KillImpactAnalysis)` in deep-review. UtilityEvent effects retain exact round/type/tick/eventIndex refs, effect XYZ, deterministic alive counts/atomic ambiguity, observed bomb lifecycle and at-event XY/Z/XYZ enemy/teammate distances. HE uses unique same-actor/same-tick reported damage; flash uses unique round-local entity+actor linkage; fire damage and effect-level flash assists remain unavailable. Six independent coverage layers preserve context without inventing release trajectories, intent, LOS, map geometry, quality or causal value. Only deep-review depends on match-model; frozen P3/Findings V1 and desktop remain unchanged. Research, constraints and automatic samples: [Utility context](./utility-context.md).

P5.7.6 adds independent `analyzeCombatExecution(Match, optional EngagementAnalysis, optional KillImpactAnalysis, optional MatchSpatialEvidence, options)` and JSON-only execution contracts in deep-review. Firearm damage/kill contacts, shooter-only weapon_fire refs, unique inside/1s heuristic lead-in association, tick-only first contact roles, same-opponent return contact and raw reported damage/distance facts have five coverage layers. Ambiguous fire is retained without assignment; incomplete feeds cannot manufacture none-observed; same-tick death/contact never becomes a zero-second reaction claim. KillImpact counts/tags are not reimplemented. There is no aim rating, target inference, misses, accuracy, angle, score, velocity or usercmd evidence. One shared parseWithSpatial per fixture feeds the same Engagement→KillImpact→Teamplay→Utility→CombatExecution production pipeline on Nuke/Inferno/Dust2. Contracts and reports: [Combat Execution](./combat-execution-evidence.md).

v0.1 Final Acceptance remains **PAUSED**. P5.7.0 is **PARTIAL PASS**; P5.7.1–P5.7.8 are **PASS**. Product Owner-confirmed personal fixtures have now been tested: demo1/demo3 pass the current personal gate, while demo2 native entity/state gaps block P5.7 FINAL acceptance. See [personal acceptance](./deep-review-personal-acceptance.md). Repository: `Evanpatchouli/cs2-analyst`.

`analytics` implements the P3 deterministic player and combat metrics and depends only on `match-model` domain types. Round windowing and roster coverage are centralized in `packages/analytics/src/coverage.ts` so individual metrics do not re-implement eligibility; the shared survival/trade timeline for KAST, Trade and Clutch lives in `packages/analytics/src/timeline.ts`. Definitions and limits: [analytics metrics](./analytics-metrics.md).

## P6 2D replay

[Replay technical route](./replay-technical-route.md) defines the fully local Canvas 2D viewer using
versioned radar images paired with overview metadata. Prepare assets in a maintenance environment,
prefer Valve-distributed source content and verify community extraction packages before use;
neither development nor end-user playback assumes an installed CS2 directory.

`parseWithReplay()` explicitly samples continuous observations through dem-parser and independent match-model contracts;
the existing sparse Spatial/Deep Review semantics and deterministic metrics remain unchanged. The
Utility Process shares input/Match/events and owns bounded replay sessions/chunks; Main/preload authorize requests;
report-contract carries additive JSON metadata and schema-v1 chunks. Renderer projects and interpolates display only.
Each chunk carries complete player/bomb baselines and guard frames for random seek. A session survives report delivery,
then new import, cancellation, release or window close clears the worker and outstanding requests.

Radar/overview pairing, map versions, independent landmark calibration and multi-floor Z ranges must
be checked; missing/uncertain evidence remains explicit. Display interpolation never becomes analytics
evidence. P6 has no P7 heatmap or P8 backend dependency and does not establish LOS or tactical quality.
The development machine has no CS2 installation; there is no game-directory discovery or runtime asset extraction.
The user authorized committing and pushing radar PNGs and original overviews on 2026-10-16, then expanded
the supported set to Dust2, Inferno, Mirage, Ancient, Overpass, Vertigo, Nuke, Anubis, Train and Cache
(13 PNGs / 10 overviews; Nuke, Vertigo and Train have two layers).
Source checkouts include these assets; checkouts without radars still support reports and event/state browsing.
Build/pack validates pinned digests; provenance and the unconfirmed third-party redistribution license remain recorded in the resource manifest.
All map/DEM version matches remain unconfirmed and are labelled schematic; Nuke shared-Z transitions stay unknown.
Current phase status, exact fixture scope and actual measurements: [P6 implementation](./replay-implementation.md).

## Principles

DEM parsing, analysis logic and UI presentation must remain independent.

AI coaching is an optional interpretation layer built on top of structured findings.

P8's planned model-independent knowledge, coaching and evaluation route is documented in
[AI Coach technical route](./ai-coach-technical-route.md). It preserves local deterministic analysis,
stores reviewed professional-demo knowledge in private backends outside model weights, and separates
conditional AI recommendations from verified Findings. This is a future design, not an implemented component;
map geometry/visibility capabilities require independent validation beyond P6 2D rendering.

## Planned P8 backend applications (not implemented)

Keep all applications in this monorepo, with independently built and deployed backends. Paths below
are planned names, not existing directories or newly authorized implementation work.

| Application | Responsibility | Boundary |
| --- | --- | --- |
| Existing `apps/desktop` | Local personal DEM parsing, deterministic analysis, P6/P7 and coaching presentation | Sends only necessary structured evidence to the coaching API; no personal DEM upload, professional knowledge database, internal system prompts or provider credentials |
| Planned `apps/knowledge-pipeline` | Internal professional DEM ingestion, evidence extraction, candidate-rule review, isolated evaluation, knowledge release and revocation | Operator-only jobs/admin interfaces; owns the private draft database and publishes immutable versioned knowledge snapshots through an internal channel |
| Planned `apps/coach-api` | Authenticated client analysis API, released-knowledge retrieval, validated geometry queries, provider-independent model orchestration and output validation | No personal DEM parsing or core metric recomputation; reads published snapshots only, not drafts or held-out evaluation material; returns filtered coaching DTOs |

Professional DEMs may be parsed in the internal knowledge pipeline by reusing `dem-parser` and the
domain packages. This explicitly replaces the earlier blanket no-server-DEM restriction for this
internal professional-data workflow only; personal DEMs remain local. The current native binding
is validated for Windows x64, so backend platform compatibility must be checked before ingestion.

Shared domain/service contracts belong in `packages/`, independently of Electron. Applications do
not import one another's entry points; the deterministic packages never depend on backend storage,
networking or models. Concrete package names, HTTP framework and API schemas remain implementation
design work. No existing public contracts or package dependencies change in this documentation update.

The knowledge pipeline is the sole writer of its initial private SQLite store. The coaching API
loads immutable reviewed snapshots with version/digest checks; the applications do not share a
writable database. Provider SDKs, model credentials, internal prompts, full professional cases,
private coaching rules and evaluation assets are excluded from desktop bundles and client-accessible endpoints.
User-facing explanations and necessary version identifiers may be returned, not raw private assets,
provider responses or debug logs. The backend may use hosted or self-hosted models; no client-side
offline knowledge mode is planned by this route.

Internal administration and client analysis must be isolated by deployment/routing and authorization.
Before public exposure, define and validate authentication, authorization, request limits, quotas,
and evidence/log retention. Do not embed a permanent shared backend secret in the desktop installer.
This service-access prerequisite is independent of the **planned local-only match library**, which has no account service or history backend. See [Match Library Plan](./match-library-plan.md).
Client-side schema consistency does not prove source-DEM authenticity; the API's advice is based on
submitted evidence, with unknown information preserved. Network/model failure leaves local reports usable.

## Future boundary (not implemented)

Auto DEM discovery / directory scanning is **not planned**: the user always selects personal DEMs explicitly, and no code scans Steam / CS2 directories. The prior future `apps/api` + account/session + remotely stored match-history-summary concept has been **superseded** by the user-approved **Windows Local-first Match Library**. No public personal match history backend, client login, or personal DEM upload is planned.

The match library will store the completed, versioned local analysis report plus replay chunks and sufficient heatmap evidence for all existing filters in a local SQLite-indexed, per-match compressed archive; it **will not retain the source DEM**. Import/export and deletion are user-controlled. On reopen without the DEM, Main/Utility constructs fresh trusted Replay/Heatmap sessions from saved data. The installed app assets remain shared. Full rules and evidence-before-implementation gates: [Local Match Library Plan](./match-library-plan.md), [Titlebar + Navigation](./match-library-navigation.md), and [Storage + Archive](./match-library-storage.md).

The 40px Electron titlebar will have left-aligned back/forward navigation icons and the existing app mark/name centered on the **entire window's geometric center** (not between unequal action groups), retaining the existing right-hand window controls and drag/keyboard/accessibility behavior. Match-detail sidebar keeps its six existing per-match features; the rejected global/subsection sidebar restructuring is not planned.

This independent future work does **not** start P8, which retains its private professional-demo knowledge pipeline and optional AI coaching API; those backends store their own controlled knowledge assets, not the end user's match history.

`findings` consumes only frozen `MatchAnalytics` via the Analytics public package. `generateFindings` runs pure deterministic rules and returns ranked evidence with per-player caps (3 issues, 2 highlights). It does not parse DEMs or recompute Analytics; parser is a devDependency only for real-demo golden tests. Policy and gaps: [Findings Engine](./findings-engine.md).

## Deep Review Findings V2 (P5.7.7)

`packages/deep-review` exposes `analyzeDeepReviewFindings(Match, playerId, { engagements, impact, teamplay, utility, execution })`. It validates and aggregates existing evidence into independent JSON-only Findings with stable exact refs, fixed heuristics, deterministic priority/caps/dedup and contradiction diagnostics. Production dependency remains match-model; no upstream analyzer/native parse is invoked here. At P5.7.7, Findings V1 (`packages/findings`), P3, report-contract and Desktop remained frozen; P5.7.8 adds presentation integration while algorithms remain frozen. Status: P5.7.7 PASS after P5.7.7.1 calibration; P5.7.8 Desktop UX PASS. Exact firstReceived/firstDealt refs independently define Findings eligibility including received-only, without changing Execution roles. Finding refs/rounds identify actual occurrences only; denominator remains counts/facts. Lone, same-Engagement no-follow and exact teamflash are contexts; fixed context priority/caps replace old teamplay window overlap dedup. The original implementation was technically valid, but product calibration exposed overbroad/misaligned rules. See [Findings V2](./deep-review-findings-v2.md) and [fixture matrix](./demo-fixtures.md). Train **REMOVED / NOT REQUIRED**; personal fixture provenance confirmed by Product Owner; compatibility gate **FAIL** due to demo2 native entity/state gaps; Final Acceptance **PAUSED**.

## Desktop branding (P5.6.5)

CS2 Analyst uses a 20px transparent PNG mark plus its product name in the 40px titlebar. The text lockup is retained as a canonical resource. Windows EXE/NSIS/uninstaller icons use a seven-resolution ICO (16/24/32/48/64/128/256). BrowserWindow uses the mark from extraResources in installed apps and a bundle-relative path in dev/preview; Renderer imports the PNG through Vite. No shell resource depends on the source machine's Downloads directory.

Workspace packages, the preload bridge and environment variables are now @cs2-analyst/*, window.cs2Analyst and CS2_ANALYST_*. This is an identifier migration with no domain algorithm changes. Production App ID is com.evanpatchouli.cs2analyst; test seam appends .testseam. Full installed and native visual acceptance remains incomplete; see the P5.6.5 validation record in windows-packaging.md.

## Desktop Deep Review (P5.7.8)

The Utility Process shares a single parseWithSpatial result across P3/V1 and the full production
Engagement → KillImpact → Teamplay → UtilityContext → CombatExecution pipeline. Findings V2 runs
for each valid player with those same inputs. The presenter whitelists product fields into
report-contract schema v2; raw analysis/spatial evidence and debug diagnostics do not cross IPC.
Renderer only selects per-player DTOs. Four mounted tabs start at 比赛报告, with 深度复盘 as an
independent advanced review entry; warning reviews, success highlights and neutral contexts
preserve Findings V2 copy and collapsible caveats.
Occurrence-only rounds use existing Timeline expansion/scroll/highlight. The workspace dependency
is bundled into the installed worker; native loader/staging/IPC/installer security layout is unchanged.
[Deep Review Desktop](./deep-review-desktop.md) records validation and formal P5.7.8 PASS.

Personal compatibility gate: [acceptance evidence](./deep-review-personal-acceptance.md). All three use the unchanged production Desktop pipeline. demo2 native entity/state gaps correctly degrade downstream coverage; no threshold, semantic, filename or player-specific production repair was introduced.
