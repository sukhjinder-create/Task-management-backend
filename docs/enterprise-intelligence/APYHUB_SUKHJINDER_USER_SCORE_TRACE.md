# Apyhub Sukhjinder User Score Trace

Generated: 2026-06-25

Scope: live production-backed score trace for the exact-case `Apyhub` workspace and user `Sukhjinder`. This is a trace, explainability, and presentation-hardening pass. It did not redesign the enterprise intelligence model.

## Resolution

| Item | Value |
| --- | --- |
| Workspace | `Apyhub` |
| Workspace ID | `3ff9264b-1a19-483a-b9e3-2a0b1840a1c2` |
| Workspace status | `active` |
| User | `Sukhjinder` |
| User ID | `f3d29844-e74e-418a-a28a-94c3c30bd9e7` |
| User email | `sukhjinder@apyhub.com` |
| Trace source | Deployed backend internal route, production DB-backed |
| Trace output | `docs/enterprise-intelligence/apyhub-sukhjinder-score-trace-output.json` |

## Current Displayed Card

| Card Field | Live Value |
| --- | --- |
| Overall score | `67/100` |
| Risk | `Low` |
| Attendance evidence bar | `92/100` |
| Delivery/productivity evidence bar | `92/100` |
| Evidence text | `1/2 assigned task(s) completed in the active evidence window 0/2 due-date tracked task(s) delivered on time` |
| Computed at | `2026-06-24T09:21:28.028Z` |
| Coverage start | `2026-05-26` |
| Coverage end | `2026-06-24` |
| Attendance closed through | `2026-06-23` |

Source row:

| Field | Value |
| --- | --- |
| Table | `user_intelligence` |
| Row ID | `d91e3ebe-4300-4522-a232-d05cf567fd7c` |
| Evidence hash | `874588aac57ab2c3427e0e3fbe6a1e692211028a3bea4c68bc098b23ae34bbec` |
| Calculation version | `enterprise-intelligence-v1` |
| Band | `Healthy` |
| Confidence | `82` |

## Field Authority Map

| Card Field | API Field | Authoritative Source | Inline Calculation? | Legacy Path? |
| --- | --- | --- | --- | --- |
| Overall score | `score` | `user_intelligence.score` | No | No |
| Attendance bar | `breakdown.attendanceScore` | `user_intelligence.attendance.score` | No | No |
| Previous productivity bar | `breakdown.productivityScore` | `user_intelligence.dimensions.deliveryEffectiveness.score` | No | No |
| Risk badge | `intelligence.risk.level` | `user_intelligence.risk.level` | No | No |
| Delta | frontend render delta from `/intelligence/user/trend` | `intelligence_snapshots`, scope `user` | Render-only delta, not score authority | No |
| Evidence text | `explanation` | first two `user_intelligence.drivers` | No | No |

Endpoint path:

```text
GET /intelligence/user/performance
-> getUserPerformance()
-> resolveCutoverResponse(surface: user_performance)
-> buildUserPerformanceResponse()
-> getUnifiedIntelligenceSnapshot()
-> getUserIntelligence()
-> user_intelligence
```

## Exact Score Reconstruction

The displayed score is not calculated in the dashboard. It is loaded from `user_intelligence.score` and reconstructs exactly from the stored enterprise dimensions.

Internal formula path:

```text
roundScore((coreScore * 0.82) + (professionalDiscipline * 0.18) - attendanceDrag + attendanceLift)
```

Live reconstruction:

| Component | Value |
| --- | --- |
| Persisted final score | `67` |
| Reconstructed final score | `67` |
| Reconstructed raw score | `67` |
| Core score | `67` |
| Professional Discipline | `67` |
| Average domain confidence | `82.4` |
| Attendance drag | `0` |
| Attendance lift | `0` |

Primary domain scores:

| Domain | Score | Key Metrics / Evidence |
| --- | --- | --- |
| Execution Reliability | `59` | Commitment completion `50`, due-date discipline `0`, carry-over control `100`, ownership consistency `100`, blocker responsiveness `72`. |
| Delivery Effectiveness | `92` | Throughput `100`, velocity `100`, completion quality `100`, estimation quality `64`, output consistency `100`. |
| Collaboration Health | `16` | Participation `0`, review completion `0`, stakeholder engagement `0`, cross-team `0`. |
| Work Sustainability | `85` | Workload balance `100`, carry-over health `100`, focus fragmentation `100`, overtime risk `35`, productivity under load `72`. |
| Professional Discipline | `67` | Attendance `92`, review completion `0`, update hygiene `75`, workflow score `100`. |

Task evidence in the intelligence source window:

| Metric | Value |
| --- | --- |
| Total assigned tasks | `2` |
| Completed tasks | `1` |
| Due-date tracked tasks | `2` |
| On-time completed tasks | `0` |
| Open overdue tasks | `0` |
| Source window | `2026-05-26` to `2026-06-24` |

## Attendance Contribution Proof

Attendance is actively contributing to the displayed score.

| Attendance Trace | Value |
| --- | --- |
| Attendance score used by displayed row | `92` |
| Attendance source | `user_intelligence.attendance.score` |
| Professional Discipline with attendance | `67` |
| Professional Discipline without attendance signal | `58` |
| Professional Discipline with neutral attendance | `59` |
| Final score with attendance | `67` |
| Final score without attendance signal | `65` |
| Final score with neutral attendance | `66` |
| Effective final lift vs no attendance signal | `+2` |
| Effective final lift vs neutral attendance | `+1` |
| Direct attendance lift/drag adjustment | `0` |

Conclusion: attendance is not cosmetic. In this case it improves the final score by about two points versus removing attendance from Professional Discipline. It does not create a direct bonus because the bounded lift rule did not activate for this user row. It also does not dominate the final score because the model is intentionally execution-led and evidence-balanced.

## Why 92 / 92 Does Not Produce Final 92

The `92` attendance bar and `92` productivity bar were not final-score averages.

The actual answer for this user:

- Attendance `92` is an attendance evidence score.
- Productivity `92` was actually `Delivery Effectiveness`, not total productivity or final performance.
- Final score `67` is pulled down mainly by:
  - Collaboration Health `16`.
  - Execution Reliability `59`.
  - Professional Discipline `67`, where attendance is strong but review completion is `0`.
- Execution evidence specifically says `1/2` assigned tasks completed and `0/2` due-date tracked tasks delivered on time.
- Work Sustainability is high at `85`, but includes an overtime risk concern.

Therefore the final score of `67` is correct for the current canonical model. The old UI presentation was partially misleading because it showed two high evidence bars without clearly saying they were domain evidence scores rather than final-score components.

## Recalculation Check

A non-persisted recalculation from current live evidence returned:

| Field | Value |
| --- | --- |
| Recomputed score | `67` |
| Matches persisted final score? | `true` |
| Recomputed attendance score | `89` |
| Recomputed delivery effectiveness | `92` |
| Recomputed execution reliability | `59` |

The displayed card still correctly uses the persisted `user_intelligence` row. The recomputed attendance score is slightly lower because the live evidence now includes a newer attendance closeout than the displayed row, but the final score remains `67`.

## Fixes Applied

Backend:

- Added canonical `scoreExplanation` to `GET /intelligence/user/performance`.
- `scoreExplanation` is built from `user_intelligence`, not frontend math.
- Added a locked internal trace route:
  - `POST /internal/enterprise-intelligence/user-score-trace`
- Added repeatable trace runner:
  - `npm run trace:apyhub-sukhjinder-score`

Frontend:

- Renamed the card section from `Intelligence Evidence` to `Score Evidence Dimensions`.
- Renamed `Attendance` to `Attendance Evidence`.
- Renamed misleading `Productivity` to `Delivery Effectiveness`.
- Added backend-provided explanation text stating the final score is not an average of the evidence bars.
- Added a compact `Score Composition Read` using backend-provided domain rows.
- Corrected delta wording from `vs last month` to `vs previous intelligence point`, because the value comes from snapshot series, not a monthly table.

## Final Verdict

| Question | Answer |
| --- | --- |
| Did attendance actively contribute to Sukhjinder's displayed score? | Yes. It contributes through Professional Discipline and improves the final score by about `+2` versus removing attendance. |
| Did attendance alone determine the score? | No. It is one signal inside a broader enterprise model. |
| Is the displayed `67` correct? | Yes. It is the canonical `user_intelligence.score` and reconstructs exactly to `67`. |
| Was the UI misleading? | Partially. The high bars were evidence dimensions but looked like direct score components. |
| Was a scoring bug found? | No final-score bug was found. The issue was explainability/presentation. |
| Was the certified architecture preserved? | Yes. No scoring redesign or dashboard redesign was performed. |
