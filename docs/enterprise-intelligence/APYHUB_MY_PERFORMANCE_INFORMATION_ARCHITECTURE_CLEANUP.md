# Apyhub My Performance Information Architecture Cleanup

Generated: 2026-06-25

Scope: final My Performance explainability pass for the certified enterprise intelligence score experience. This pass did not redesign scoring, change huddles/chat/calling/video, alter cutover policy, or move score logic into the frontend.

## What Was Confusing Before

The previous My Performance card mixed three layers in one visual area:

- Final score composition domains.
- Supporting evidence signals.
- Behavioral diagnostics.

This made the card feel duplicative:

- `Delivery Effectiveness` appeared as an evidence bar even though it is a top-level final-score domain.
- `Attendance Evidence` appeared visually similar to score domains even though it feeds `Professional Discipline`.
- `Task Velocity`, `Timeliness`, `Execution Discipline`, and `Workload Stress` appeared as a separate score-like block instead of drill-down diagnostics.

For Apyhub/Sukhjinder, that made `Attendance 92`, `Delivery Effectiveness 92`, and final score `67` harder to understand than it needed to be.

## New Hierarchy

The card now follows a single enterprise hierarchy:

1. Final Performance Score
   - Shows the final `user_intelligence.score`, risk badge, trend delta, and canonical short narrative.

2. Score Composition
   - Shows the only primary score-composition layer.
   - Uses the canonical domains from `user_intelligence.dimensions`:
     - Execution Reliability
     - Delivery Effectiveness
     - Collaboration Health
     - Work Sustainability
     - Professional Discipline

3. Evidence Inputs
   - Shows supporting evidence that feeds the score domains.
   - Attendance is shown here as evidence feeding `Professional Discipline`, not as a peer final-score domain.

4. Behavioral / Diagnostic Drivers
   - Shows detailed operating signals such as timeliness, task velocity, workload stress, blocker responsiveness, collaboration participation, and workload balance.
   - These are explicitly labeled as diagnostics, not another score-composition layer.

## Backend Contract Changes

`GET /intelligence/user/performance` now returns a structured, repository-backed explanation contract under `scoreExplanation`:

- `scoreNarrative`
- `scoreComposition`
- `evidenceInputs`
- `diagnosticDrivers`
- `attendanceContribution`

Backward-compatible fields remain available:

- `domainRows`
- `evidenceBars`
- `breakdown`

No frontend scoring formula was added. The frontend renders the canonical explanation payload.

## Frontend Changes

The dashboard My Performance card now renders:

- `scoreNarrative` near the final score.
- `scoreComposition` as the only primary domain section.
- `evidenceInputs` as a separate supporting-signal section.
- `diagnosticDrivers` as the drill-down behavioral section.

The old ambiguous `Score Evidence Dimensions` section and nested `Score Composition Read` presentation were removed from the visible hierarchy.

## Apyhub / Sukhjinder Confirmation

Live canonical score trace remains:

| Field | Value |
| --- | --- |
| Workspace | `Apyhub` |
| User | `Sukhjinder` |
| Final score | `67` |
| Score authority | `user_intelligence.score` |
| Attendance evidence | `92` |
| Delivery Effectiveness | `92` |
| Execution Reliability | `59` |
| Collaboration Health | `16` |
| Professional Discipline | `67` |
| Attendance effect | about `+2` vs removing attendance evidence |

The page now explains that:

- `67` is the final canonical score.
- `Delivery Effectiveness 92` is a score-composition domain, not a duplicated evidence bar.
- `Attendance 92` is supporting evidence feeding `Professional Discipline`.
- Timeliness, task velocity, workload stress, and related metrics are diagnostic drivers.

## Validation

Local validation completed:

- `node --check intelligence/analytics/intelligenceResponses.service.js`
- frontend `npm run build`

Post-deploy live validation should confirm the deployed response contains:

- `scoreExplanation.scoreNarrative`
- `scoreExplanation.scoreComposition`
- `scoreExplanation.evidenceInputs`
- `scoreExplanation.diagnosticDrivers`
- `scoreExplanation.attendanceContribution`

## Verdict

The My Performance card is now organized as a coherent enterprise explainability surface. It preserves the certified scoring model while making the final score, score domains, evidence inputs, and diagnostics clearly distinct.
