# Enterprise Shadow Validation Report

Generated: 2026-06-24

## Validation Pack

Primary local command:

```bash
npm run verify:enterprise-intelligence
```

Latest local result:

```text
Enterprise intelligence architecture verification passed {
  syntheticScore: 93,
  confidence: 98,
  attendanceScore: 94,
  workspaceExecutionIndex: 75,
  projectMomentum: 95,
  teamWorkloadBalance: 66,
  indicators: 1
}
```

Real-data shadow validation command:

```bash
npm run verify:enterprise-intelligence:real-data
```

Latest real-data result:

```text
status: completed
readiness: representative_seeded_workspace_validation_passed_for_staged_cutover
source: local_representative_seeded_workspace_snapshot
large score deltas: 0
contradictions: 0
blocker anomalies: 0
```

Evidence file:

`docs/enterprise-intelligence/real-data-shadow-validation-output.json`

Frontend payload/build regression command:

```bash
npm run build
```

Latest frontend result:

```text
vite build completed successfully
2963 modules transformed
```

Warnings observed:

- `baseline-browser-mapping` data is over two months old.
- `caniuse-lite` browsers data is out of date.
- Some chunks are larger than 500 kB after minification.

These are existing build hygiene warnings, not intelligence regressions.

## Tests Covered

| Requirement | Evidence |
| --- | --- |
| Legacy vs new comparison | Real-data script completed against representative seeded workspace fallback because the configured DB host remains unreachable. |
| Determinism tests | Synthetic user evidence is evaluated twice; score and evidence hash must match. |
| Idempotency tests | Repository writes use upsert; snapshots use unique `(workspace_id, scope_type, subject_key, period_key, captured_for_date)`. |
| Duplicate-event tests | Queue verifier asserts stable dedupe key, coalescing, and merged metadata. |
| Partial-failure recovery tests | Unified engine verifier asserts partial failure recording and workspace stale aggregate prevention. |
| Snapshot consistency tests | Repository verifier asserts `intelligence_snapshots` custom range and canonical time fields. |
| Dashboard payload regression tests | Verifier asserts `visualizations.charts`, role-specific chart keys, no old weighting copy, and no chart risk fallback. |

## Shadow Comparison SQL Pack

Use this only against a local database that contains both old and new tables.

User comparison:

```sql
SELECT
  ui.workspace_id,
  ui.user_id,
  ui.score AS new_score,
  wms.score AS legacy_score,
  ui.score - wms.score AS delta,
  ui.last_evaluated_at AS new_computed_at,
  wms.month AS legacy_month
FROM user_intelligence ui
LEFT JOIN workspace_monthly_scores wms
  ON wms.workspace_id = ui.workspace_id
 AND wms.user_id = ui.user_id
 AND wms.month = to_char(CURRENT_DATE, 'YYYY-MM')
ORDER BY ABS(ui.score - COALESCE(wms.score, ui.score)) DESC NULLS LAST
LIMIT 25;
```

Project comparison:

```sql
SELECT
  pi.workspace_id,
  pi.project_id,
  pi.score AS new_score,
  wpms.score AS legacy_score,
  pi.score - wpms.score AS delta,
  pi.last_evaluated_at AS new_computed_at,
  wpms.month AS legacy_month
FROM project_intelligence pi
LEFT JOIN workspace_project_monthly_scores wpms
  ON wpms.workspace_id = pi.workspace_id
 AND wpms.project_id = pi.project_id
 AND wpms.month = to_char(CURRENT_DATE, 'YYYY-MM')
ORDER BY ABS(pi.score - COALESCE(wpms.score, pi.score)) DESC NULLS LAST
LIMIT 25;
```

Workspace comparison:

```sql
SELECT
  wi.workspace_id,
  wi.score AS new_workspace_score,
  ROUND(AVG(wms.score), 2) AS legacy_average_user_score,
  wi.last_evaluated_at AS new_computed_at,
  to_char(CURRENT_DATE, 'YYYY-MM') AS legacy_month
FROM workspace_intelligence wi
LEFT JOIN workspace_monthly_scores wms
  ON wms.workspace_id = wi.workspace_id
 AND wms.month = to_char(CURRENT_DATE, 'YYYY-MM')
GROUP BY wi.workspace_id, wi.score, wi.last_evaluated_at;
```

## Current Gaps

- Specialty enterprise endpoints, OKR health, and AI task risk are now explicitly isolated from enterprise cutover authority.
- DB host resolution still fails for the configured database, so live/staging DB comparison should be rerun when connectivity is restored.
- Local verifier is synthetic/static for queue duplicate and partial-failure behavior; DB-backed retry execution should be monitored during staged cutover.

## Production Readiness Gate

Do not remove legacy monthly scoring tables until:

1. Shadow comparisons have been captured for live/staging workspaces.
2. Snapshot history has at least one weekly cycle.
3. Specialty analytics remain explicitly isolated from enterprise score authority.
4. Dashboard payload regression is confirmed against live/staging data.
