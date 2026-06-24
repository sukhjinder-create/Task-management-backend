# Enterprise Legacy Path Resolution Report

Generated: 2026-06-24

## Resolution Strategy

Every remaining legacy-dependent intelligence path was resolved in one of two ways:

1. Migrated to unified intelligence for core dashboard/intelligence use.
2. Explicitly isolated from enterprise production cutover when non-core.

No remaining non-core path should silently present itself as authoritative enterprise intelligence.

## Migrated Core Paths

| Area | Resolution |
| --- | --- |
| Dashboard overview | Unified dashboard adapter |
| Executive detail | Unified dashboard adapter |
| User performance | `user_intelligence` |
| User trends | `intelligence_snapshots` |
| Project performance | `project_intelligence` |
| Workspace health | `workspace_intelligence` |
| Admin insights | Unified snapshot and snapshots |
| Projects health | `project_intelligence` |
| Team comparison | Explicit `derived_user_comparison` response backed by `user_intelligence`, with `team_intelligence` kept as canonical team authority |
| Review user context | `user_intelligence` |
| Monthly cron | Snapshot/audit capture from unified repositories |

## Intentionally Isolated Paths

| Path | Why Isolated | Guardrail |
| --- | --- | --- |
| OKR health | Goal pacing is a product-module signal, not enterprise performance scoring | `legacy_isolated_non_core`, not dashboard eligible |
| Profitability oracle | Specialty direct project/task heuristic | `legacy_isolated_non_core`, not dashboard eligible |
| Resignation radar | Specialty retention heuristic | `legacy_isolated_non_core`, not dashboard eligible |
| Ghost work | Specialty integrity heuristic | `legacy_isolated_non_core`, not dashboard eligible |
| Org truth map | Specialty archetype heuristic | `legacy_isolated_non_core`, not dashboard eligible |
| AI task deadline risk | Task-level AI Hub helper | `legacy_isolated_non_core`, not dashboard eligible |

## Executive Summary Handling

Before:

- OKR health could enter executive summary source data as `okrHealth`.

Now:

- OKR health is moved to `legacyContext.okrHealth`.
- Core `okrHealth` is set to `null`.
- The generator skips any OKR health with `dashboardEligible === false`.

This prevents silent mixed-intelligence executive scoring.

## Legacy Code Still Present

Legacy monthly scoring and analytics files remain on disk for shadow comparison and rollback. They are not active score producers for core dashboard cutover.

Examples:

- `events/scoring/monthlyScoring.service.js`
- `events/scoring/monthlyScore.store.js`
- `intelligence/manualScoring.service.js`
- `intelligence/intelligence.service.js`
- `intelligence/intelligence.repository.js`

## Cutover Rule

During production cutover, only routes marked `source: "enterprise_intelligence"` or repository-backed dashboard responses may be treated as authoritative performance intelligence.

Routes marked `source: "legacy_isolated_non_core"` must remain outside core dashboard scorecards, rankings, trends, and cutover success criteria.

`GET /intelligence/team/comparison` is allowed during cutover only as a derived comparison surface. It must not be used as canonical team score authority because its payload declares `authority.teamScoreAuthority = false`.
