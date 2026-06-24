# Enterprise Cutover Guardrails

Generated: 2026-06-24

## Guardrail 1 - Repository Authority

Core dashboards and intelligence APIs must read from:

- `user_intelligence`
- `project_intelligence`
- `team_intelligence`
- `workspace_intelligence`
- `intelligence_snapshots`

Dashboard services must remain read-only adapters.

## Guardrail 2 - Legacy Isolation

Non-core legacy analytics must use:

- `source: "legacy_isolated_non_core"`
- `legacyIsolated: true`
- `cutover.cutoverStatus: "excluded_from_enterprise_intelligence_cutover"`
- `cutover.dashboardEligible: false`

Implemented in:

- `intelligence/analytics/cutoverIsolation.service.js`

Currently isolated:

- OKR health
- profitability oracle
- resignation radar
- ghost work
- org truth map
- AI task deadline risk

## Guardrail 3 - No Active Monthly Score Producer

`cron/monthlyIntelligence.cron.js` must not call:

- `generateMonthlyScore`
- `generateMonthlyCoaching`
- `generateAdminInsights`

It may only capture authoritative repository snapshots.

## Guardrail 4 - Attendance Closeout

Attendance intelligence is recalculated after daily aggregation only.

Rules:

- sign-in/sign-off does not immediately recalculate attendance intelligence
- `attendance_closed_through_date` must be exposed
- non-working day attendance cannot penalize
- non-working day recognition requires meaningful delivery
- exceptional contribution indicators are bounded

## Guardrail 5 - Chart Contract

Dashboard charts must come from `visualizations.charts`.

Each chart must include:

- `id`
- `key`
- `type`
- `title`
- `scope`
- `source`
- `metric`
- `axis`
- `series`
- `data`

Frontend renders only.

## Guardrail 6 - Derived Team Comparison

`GET /intelligence/team/comparison` is a derived user comparison surface.

It must keep:

- `surfaceClassification: "derived_user_comparison"`
- `authority.scoreAuthority: "user_intelligence"`
- `authority.canonicalTeamAuthority: "team_intelligence"`
- `authority.teamScoreAuthority: false`

Canonical team score authority remains `team_intelligence`.

## Guardrail 7 - Recalculation Safety

Realtime recalculation must keep:

- stable dedupe keys
- coalescing delay
- retry attempts
- partial failure event recording
- stale aggregate prevention

Workspace aggregate refresh must be skipped after any failed child recalculation.

## Guardrail 8 - Verification Before Cutover

Required commands:

```bash
npm run verify:enterprise-intelligence
npm run verify:enterprise-intelligence:real-data
```

Frontend:

```bash
npm run build
```

Production cutover cannot be approved while real-data validation is blocked. If the configured DB host is unreachable, the validator must complete against the representative seeded workspace fallback and record that source in `real-data-shadow-validation-output.json`.
