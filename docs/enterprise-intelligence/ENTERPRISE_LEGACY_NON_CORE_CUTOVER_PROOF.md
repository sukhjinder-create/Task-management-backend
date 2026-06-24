# Enterprise Legacy Non-Core Cutover Proof

Generated: 2026-06-24

## Purpose

This report proves that isolated non-core legacy intelligence cannot silently conflict with the production cutover of core enterprise dashboard intelligence.

Core dashboard cutover means:

- admin dashboard
- manager dashboard
- user dashboard
- dashboard scorecards
- dashboard charts
- dashboard rankings
- dashboard trends
- unified intelligence snapshot/history APIs

## Isolation Contract

All isolated paths are wrapped with:

- `source: "legacy_isolated_non_core"`
- `cutover.intelligenceAuthority: "not_authoritative_for_enterprise_cutover"`
- `cutover.cutoverStatus: "excluded_from_enterprise_intelligence_cutover"`
- `cutover.dashboardEligible: false`

Helper:

- `intelligence/analytics/cutoverIsolation.service.js`
- `intelligence/cutover/enterpriseIntelligenceCutover.policy.js` also classifies these surfaces as `isolated_legacy` and `rolloutEligible: false`.

## Operationalization Addendum

This production cutover pass did not migrate or redesign non-core specialty formulas.

That is intentional. These surfaces are not part of the core dashboard cutover policy and cannot be moved to `shadow` or `unified` through `enterprise_intelligence_cutover_controls`.

Operational rule:

- cutover health may list isolated non-core surfaces for visibility
- cutover controls must not target these surfaces
- success metrics for dashboard cutover must ignore these payloads
- any payload with `legacy_isolated_non_core` or `isolated_legacy` remains informational only

## Route And UI Surface Proof

| Surface | Route | UI Surface | Core dashboard consumer? | Contributes to unified score/risk/chart? | Contradiction risk during cutover | Cutover behavior |
| --- | --- | --- | --- | --- | --- | --- |
| OKR health | `GET /intelligence/goals/health` | No active core dashboard consumer found. OKR page uses `/goals/*` module routes. | No | No. Executive summary keeps OKR under `legacyContext.okrHealth` and sets core `okrHealth` to `null`. | Low. It is not used as enterprise performance authority. | Leave isolated. Keep available for OKR module context only. |
| Profitability oracle | `GET /intelligence/enterprise/profitability-oracle` | `src/pages/EnterpriseIntelligence.jsx` | No | No | Low. Specialty page may show heuristic project risk, but it is not beside core dashboard scorecards/charts. | Leave isolated and label as non-core. |
| Resignation radar | `GET /intelligence/enterprise/resignation-radar` | `src/pages/EnterpriseIntelligence.jsx` | No | No | Low. Specialty retention heuristic is separate from dashboard risk. | Leave isolated and label as non-core. |
| Ghost work | `GET /intelligence/enterprise/ghost-work` | `src/pages/EnterpriseIntelligence.jsx` | No | No | Low. Specialty integrity heuristic is separate from user dashboard performance. | Leave isolated and label as non-core. |
| Org truth map | `GET /intelligence/enterprise/org-truth-map` | `src/pages/EnterpriseIntelligence.jsx` | No | No | Low. Specialty archetype/value heuristic is separate from unified team/workspace indexes. | Leave isolated and label as non-core. |
| AI task deadline risk | `GET /ai-features/tasks/:taskId/risk`, `GET /ai-features/risks` | `src/pages/AIFeatures.jsx` risk heatmap | No | No | Low. It is task-helper risk only, not enterprise performance risk. | Leave isolated and label as non-core. |

## Backend Proof

Implemented isolation points:

- `intelligence/intelligence.controller.js`
  - `okr_goal_health`
  - `enterprise_specialty_profitability_oracle`
  - `enterprise_specialty_resignation_radar`
  - `enterprise_specialty_ghost_work`
  - `enterprise_specialty_org_truth_map`
- `services/aiFeatures.service.js`
  - `ai_task_deadline_risk`
- `intelligence/analytics/intelligenceResponses.service.js`
  - moves OKR health into `legacyContext.okrHealth`
  - keeps core `okrHealth` as `null`
- `intelligence/executiveSummary.generator.js`
  - skips isolated OKR context with `dashboardEligible !== false`

## Frontend Proof

Core dashboard:

- `src/pages/Dashboard.jsx` consumes `/dashboard/overview`, `/intelligence/user/performance`, `/intelligence/user/trend`, `/intelligence/user/project-performance`, `/intelligence/insights`, and `/intelligence/workspace/health`.
- These paths are repository-backed compatibility or dashboard adapter paths.
- The dashboard does not call `/intelligence/enterprise/*` or `/ai-features/risks`.

Specialty UI:

- `src/pages/EnterpriseIntelligence.jsx` calls `/intelligence/enterprise/*`.
- `src/pages/AIFeatures.jsx` calls `/ai-features/risks`.
- These pages are outside the core dashboard cutover surface.

OKR UI:

- `src/pages/OKR.jsx` uses `/goals/*` module routes.
- It does not use `/intelligence/goals/health` in the inspected dashboard path.

## Cutover Safety Decision

Safe to leave isolated for staged production cutover.

Reason:

- they do not feed core dashboard scorecards, charts, rankings, or trend lines
- every isolated API declares non-authoritative cutover metadata
- the executive summary no longer consumes OKR health as a core signal
- the real-data validation pack checks for derived/team and anomaly conflicts separately

## Required Operating Rule

During staged cutover, any payload with `source: "legacy_isolated_non_core"` must be excluded from:

- cutover success metrics
- dashboard score comparisons
- user performance rankings
- team performance indexes
- project portfolio health charts
- workspace health charts
