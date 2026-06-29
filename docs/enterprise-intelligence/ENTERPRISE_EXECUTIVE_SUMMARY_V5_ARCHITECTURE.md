# Enterprise Executive Summary V5 Architecture

Generated: 2026-06-29

Scope: executive summary rearchitecture from score-driven narrative to evidence-driven executive intelligence. This pass does not redesign dashboard layout, enterprise scoring, huddles, chat, calling, video, auth, RBAC, tasks, projects, attendance, reviews, comments, or time logs.

## Executive Verdict

Executive summaries now use `enterprise_executive_summary_v5`.

The active admin dashboard executive summary is generated as an operational briefing. It answers:

> What happened in this workspace during the selected period?

It no longer answers:

> What numerical score did the workspace receive?

Scores remain available in score cards, charts, explainability panels, and analytics APIs. The executive summary uses scores only as internal classification hints and does not narrate raw score values, score formulas, or score weightage behavior.

## Old Architecture

Before v5, the selected-period executive summary was too close to the scoring surface:

- The summary version was `dashboard_period_summary_v4`.
- Narrative text described score state and score movement.
- The dashboard executive-detail response appended a score sentence to the full summary.
- Reuse was tied to selected period and snapshot density, but did not explicitly declare that scoring weight changes should not invalidate summaries.
- The physical `workspace_executive_summaries.period` key was shared by all summary versions, so a new version could overwrite the previous period artifact.

This made the summary sensitive to scoring configuration even when the underlying operational reality had not changed.

## New Architecture

The v5 path lives in:

- `intelligence/analytics/periodExecutiveSummary.service.js`
- `intelligence/analytics/unifiedDashboard.adapter.js`
- `intelligence/intelligence.controller.js`
- `events/executive/executiveSummary.store.js`
- `routes/internal.js`

The summary is now built from a period analysis object that separates:

- operational evidence
- historical movement
- attendance/workforce readiness
- delivery and execution state
- collaboration health
- capacity and sustainability
- task pressure
- project and team signals
- risk posture
- leadership actions

The output contains:

- `sections`
- `fullSummary`
- `headline`
- `narrative`
- `outlook`
- `recommendations`
- `quality`
- `operationalEvidenceHash`
- `regenerationPolicy`
- `persistence`

## Required Sections

Every v5 summary contains these section keys:

- `executiveOverview`
- `operationalStrengths`
- `operationalRisks`
- `trendNarrative`
- `attendanceWorkforceReadiness`
- `deliveryExecution`
- `collaborationOrganizationalHealth`
- `capacitySustainability`
- `leadershipRecommendations`
- `outlook`

The dashboard renders these sections using the existing dashboard card, typography, and border language. No dashboard redesign was introduced.

## Evidence Sources

V5 summaries are grounded in the existing enterprise intelligence source of truth:

- `workspace_intelligence`
- `team_intelligence`
- `project_intelligence`
- `user_intelligence`
- `intelligence_snapshots`
- attendance intelligence through the current user and workspace intelligence profiles
- task counts and overdue work from scoped task queries
- project names, risk signals, blockers, delayed work, and project intelligence indexes
- team collaboration, predictability, and workload signals
- historical chart contract data in `visualizations.charts`

Numerical intelligence outputs can still classify state internally as strong, stable, uneven, under pressure, improving, declining, or stable. Raw numerical score narration is removed from the executive summary text.

## Generation Lifecycle

1. Dashboard requests `/dashboard/overview` or `/dashboard/executive-detail`.
2. The unified dashboard adapter resolves the selected role, scope, range, snapshot, scoped task counts, project health, and historical series.
3. If selected-range history is sparse, history materialization runs through the existing snapshot materialization service.
4. Admin workspace summaries call `getOrCreateWorkspacePeriodExecutiveSummary()`.
5. The summary service builds a period analysis from retained intelligence history and current enterprise repository context.
6. The v5 summary is either reused from `workspace_executive_summaries` or regenerated when material operational evidence changed.
7. The frontend renders backend-provided summary sections. It does not derive summary math.

## Persistence Model

The physical `workspace_executive_summaries.period` column is limited to `varchar(10)`, so v5 uses a compact versioned storage key:

```text
V5 + 8-character SHA1 digest
```

The full readable period and version remain in `source_data`:

- `summaryKind`
- `summaryVersion`
- `dashboardRange`
- `bucket`
- `storagePeriodKey`
- `analysis`
- `materialization`
- `payload`
- `operationalEvidenceHash`
- `regenerationPolicy`

This preserves older period artifacts instead of overwriting them merely because v5 exists.

## Regeneration Rules

V5 summaries are reused when:

- summary kind matches
- summary version is `enterprise_executive_summary_v5`
- dashboard range matches
- period bucket matches
- the saved summary is not a stale one-point summary when richer history now exists
- saved `operationalEvidenceHash` matches the current operational evidence hash

V5 summaries regenerate when:

- operational evidence changes materially
- historical snapshot coverage changes materially
- selected-period bucket changes
- summary version changes
- stored evidence hash no longer matches the current evidence hash
- stale sparse history has been replaced by richer history

V5 summaries do not regenerate only because scoring weightages changed.

The persisted policy is:

```json
{
  "summaryVersion": "enterprise_executive_summary_v5",
  "regenerationTrigger": "material_operational_evidence_change",
  "scoreWeightageChangesInvalidateSummary": false
}
```

## Operational Evidence Hash

The operational evidence hash intentionally excludes scoring configuration and raw final score values. It includes:

- summary version
- selected range
- selected period bucket
- snapshot coverage dates
- retained snapshot dates
- snapshot point count
- scoped task totals
- completed task totals
- overdue task totals
- top overdue task identity and pressure
- source window and attendance closeout date
- operational evidence summary
- entity counts
- project names
- whether history materialization affected the period view

This makes score-weight toggles safe while still detecting material operational changes.

## AI Prompt Design

The legacy executive summary prompt now includes a v5 directive for any fallback generation path:

- write as an experienced COO
- explain operational reality, not mathematical scores
- avoid raw score values, score movement, and scoring formulas
- use the ten required section concepts
- provide 3 to 5 prioritized leadership actions
- make the outlook operational, not score-predictive
- keep tone concise, objective, evidence-based, and free of generic AI language

The active admin dashboard summary path is deterministic and repository-backed. The prompt update protects legacy or fallback generation from regressing into score narration.

## Quality Gates

`assessExecutiveSummaryQuality()` now verifies:

- sufficient substance
- concise length
- selected-period awareness
- evidence references
- prioritized actions
- low repetition
- meaningful outlook
- all ten required sections
- no score-centric language

The internal live verifier checks these gates for `30d`, `90d`, `6m`, `1y`, and `all`.

## Backend Contract

Dashboard overview now returns v5 summary fields:

- `executiveSummary.sections`
- `executiveSummary.fullSummary`
- `executiveSummary.recommendations`
- `executiveSummary.quality`
- `executiveSummary.operationalEvidenceHash`
- `executiveSummary.regenerationPolicy`
- `executiveSummary.persistence`

Dashboard executive detail now returns:

- `sections`
- `fullSummary`
- `recommendations`
- `regenerationPolicy`
- evidence/reuse reasoning

The previous score sentence was removed from executive detail.

## Frontend Contract

The dashboard UI remains visually unchanged in design language.

Frontend changes are limited to rendering backend-provided summary sections and object-shaped recommendations:

- no score math in frontend
- no summary derivation in frontend
- no new design system
- no dashboard redesign

## Local Validation

Passed:

```bash
npm run verify:enterprise-intelligence
```

Observed:

```text
Enterprise intelligence architecture verification passed
```

Passed:

```bash
npm run verify:dashboard-range-charts
```

Observed:

```text
Dashboard range chart contract verification passed
```

Backend syntax checks passed for:

- `intelligence/analytics/periodExecutiveSummary.service.js`
- `intelligence/analytics/unifiedDashboard.adapter.js`
- `intelligence/intelligence.controller.js`
- `events/executive/executiveSummary.store.js`
- `intelligence/executiveSummary.generator.js`
- `routes/internal.js`

## Live Apyhub Validation

Live validation is executed through the internal production-safe route:

```text
POST /internal/enterprise-intelligence/executive-summary-v5-verify
```

Validation covers:

- `30d`
- `90d`
- `6m`
- `1y`
- `all`
- v5 version proof
- required section proof
- quality proof
- persisted second-read reuse
- scoring weight toggle proof
- operational evidence mismatch regeneration proof

Result: passed on the live Apyhub workspace.

Validation run:

```text
generatedAt: 2026-06-29T09:30:06.602Z
workspaceId: 3ff9264b-1a19-483a-b9e3-2a0b1840a1c2
summaryVersion: enterprise_executive_summary_v5
Cloud Run revision: asystence-api-00276-cjq
frontend alias: https://app.asystence.com
certified: true
failures: []
```

Baseline live recalculation:

```text
workspaceScore: 60
users: 3
projects: 3
teams: 0
```

Range validation:

| Range | Sections | Quality | Second Read Reused | Score-Centric Language Avoided | Weightage-Independent Policy |
| --- | ---: | --- | --- | --- | --- |
| 30d | 10 | Passed | Yes | Yes | Yes |
| 90d | 10 | Passed | Yes | Yes | Yes |
| 6m | 10 | Passed | Yes | Yes | Yes |
| 1y | 10 | Passed | Yes | Yes | Yes |
| all | 10 | Passed | Yes | Yes | Yes |

Weightage independence proof:

```text
core weight changed: 0.01 -> 0.99 -> 0.01
workspace score changed: 60 -> 54 -> 60
summary regenerated by weight change: false
operational evidence hash stable across weight change: true
score changed during weight toggle: true
```

Operational evidence regeneration proof:

```text
stored operational evidence hash was intentionally invalidated
first read after mismatch regenerated the summary
second read reused the regenerated summary
```

Representative required section keys returned for every range:

```text
executiveOverview
operationalStrengths
operationalRisks
trendNarrative
attendanceWorkforceReadiness
deliveryExecution
collaborationOrganizationalHealth
capacitySustainability
leadershipRecommendations
outlook
```

## Final Architecture Statement

Executive Summary v5 is an evidence-driven enterprise operational briefing layer. It remains connected to the single enterprise intelligence source of truth while no longer being dependent on configurable score weightages for narrative validity.
