# Rollback Plan

Date: 2026-06-24

## Scope

Rollback is local and code/database only. No production deployment was performed.

## Code Rollback

Revert changed files for the enterprise intelligence feature if validation fails:

- `intelligence/engine/*`
- `intelligence/evaluators/*`
- `intelligence/repositories/*`
- `intelligence/realtime/*`
- `intelligence/analytics/*`
- `services/dashboard.service.js`
- changed mutation services/routes
- frontend `src/pages/Dashboard.jsx`

Do not delete legacy scoring code during rollback.

## Database Rollback

If the migration was run locally and must be reverted, drop only the enterprise intelligence tables:

```sql
DROP TABLE IF EXISTS intelligence_recalculation_events;
DROP TABLE IF EXISTS intelligence_snapshots;
DROP TABLE IF EXISTS workspace_intelligence;
DROP TABLE IF EXISTS team_intelligence;
DROP TABLE IF EXISTS project_intelligence;
DROP TABLE IF EXISTS user_intelligence;
```

No legacy score tables are removed by the migration.

## Operational Rollback

Because no production env vars or infrastructure were changed, no infrastructure rollback is required.

## Data Safety

Enterprise intelligence rows are derived outputs. Source-of-truth operational data remains in the existing task, attendance, leave, review, project, and workspace tables.
