# Enterprise Real Data Shadow Validation

Generated: 2026-06-24

## Status

Result: completed.

Readiness signal: `representative_seeded_workspace_validation_passed_for_staged_cutover`.

This closes the previous local blocker where the configured database host could not be resolved.

Operationalization addendum:

- the validation result remains the evidence baseline for staged/canary cutover
- the new cutover control layer does not alter the intelligence model or seeded validation data
- before broad rollout, run the same validator against reachable live/staging database rows and compare against the seeded baseline

## Data Source Used

The validator still tries the configured database first.

The configured host remains unreachable locally:

```text
getaddrinfo ENOTFOUND db.jygpfnpdphbnmysnyyww.supabase.co
```

Because direct DB validation was unavailable, this pass used the approved local fallback: a representative seeded workspace snapshot.

Dataset:

- `docs/enterprise-intelligence/representative-workspace-shadow-dataset.json`

Raw output:

- `docs/enterprise-intelligence/real-data-shadow-validation-output.json`

The dataset contains no production PII. It covers a realistic workspace shape across users, projects, tasks, comments, reviews, time logs, attendance, leave, project status history, blockers, milestones, and sprint data.

## Coverage

| Area | Count |
| --- | ---: |
| Users | 4 |
| Projects | 2 |
| Tasks | 12 |
| Comments | 9 |
| Reviews | 4 |
| Time logs | 8 |
| Attendance rows | 58 |
| Leave requests | 2 |
| Project status rows | 5 |
| Blockers | 2 |
| Milestones | 3 |
| Sprints | 2 |

Time model:

- coverage_start: `2026-06-01`
- coverage_end: `2026-06-24`
- attendance_closed_through_date: `2026-06-23`

## Validation Results

| Check | Result |
| --- | --- |
| User legacy vs unified deltas | Passed |
| Project legacy vs unified deltas | Passed |
| Workspace legacy vs unified delta | Passed |
| Large score deltas >= 25 | 0 |
| Contradictory outcomes | 0 |
| Attendance anomalies | 0 |
| Weekend/holiday contribution anomalies | 0 |
| Project intelligence inconsistencies | 0 |
| Workspace aggregate inconsistencies | 0 |
| Team comparison inconsistencies | 0 |
| Missing snapshot issues | 0 |

## Attendance Proof

The representative dataset includes:

- non-working day attendance with meaningful delivery
- non-working day attendance without meaningful delivery
- approved leave
- approved half-day
- weekend contribution recognition
- burnout watch signal

Observed result:

- no non-working day penalty was applied
- only meaningful non-working day work received recognition
- trivial non-working activity stayed informational
- exceptional recognition remained bounded
- overtime visibility appeared as burnout watch, not score inflation

## Team Comparison Proof

`/intelligence/team/comparison` is validated as a derived user comparison surface.

Observed result:

- derived comparison rows matched `user_intelligence` authority scores
- canonical `team_intelligence` rows were present for reference
- no derived row attempted to become a canonical team score
- no team comparison inconsistency was found

## Limitations

This was not live production database validation. It was a representative seeded workspace snapshot used because the configured database host was unreachable locally.

This is enough to remove the local DNS blocker and support a staged cutover decision. A broad rollout should still compare against live/staging database rows once that database is reachable.
