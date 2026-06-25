# Apyhub My Performance Score Math Explainability

Generated: 2026-06-25

Scope: final score-math explainability pass for the My Performance card. This pass did not redesign the scoring model, move scoring math into the frontend, change huddles/chat/calling/video, or alter the certified enterprise intelligence architecture.

## What Changed

The My Performance card already separated:

- Final Performance Score
- Score Composition
- Evidence Inputs
- Behavioral / Diagnostic Drivers

This pass closes the remaining math explainability gap by adding a backend-owned score calculation drilldown for the final score.

## Final Score Tooltip / Popover

The final score tile now has an info trigger. Hovering/focusing the score area shows a compact canonical calculation popover sourced from `scoreExplanation.scoreCalculation`.

The popover shows:

- final score authority: `user_intelligence.score`
- readable formula:
  - `round((core score x 0.82) + (professional discipline x 0.18) - attendance drag + attendance lift)`
- core block score and contribution points
- Professional Discipline score and contribution points
- attendance lift / drag adjustment
- raw score before rounding and final rounded score
- domain impact versus a neutral `60/100` counterfactual
- attendance effect and Professional Discipline formation inputs

No React-side score math was added. The frontend only renders backend-provided values.

## Backend Contract Added

`GET /intelligence/user/performance` now includes:

```text
scoreExplanation.scoreCalculation
```

Main fields:

- `formulaLabel`
- `formulaReadable`
- `finalScore`
- `reconstructedFinalScore`
- `rawScoreBeforeRounding`
- `coreScore`
- `coreContributionPoints`
- `professionalDisciplineScore`
- `professionalDisciplineContributionPoints`
- `attendanceDrag`
- `attendanceLift`
- `directAttendanceAdjustment`
- `domainContributions[]`
- `attendanceEffect`
- `professionalDisciplineFormation`

`scoreExplanation.evidenceInputs[]` now also includes:

- `feedsDomains[]`
- `effect`
- `effectLabel`
- `effectTone`

## Composition vs Evidence

The UI now states:

- Score Composition: these are the canonical score domains that directly produce the final score.
- Evidence Inputs: these signals do not form a second score; they feed one or more score-composition domains.

Each evidence input card shows:

- score/value
- domain(s) it feeds
- support/pressure state
- backend-generated explanation note

## Apyhub / Sukhjinder Validation Target

Expected live values for Apyhub/Sukhjinder:

| Field | Value |
| --- | --- |
| Final score | `67` |
| Score authority | `user_intelligence.score` |
| Core formula | `core x 0.82 + professional discipline x 0.18 - attendance drag + attendance lift` |
| Score Composition | Execution Reliability, Delivery Effectiveness, Collaboration Health, Work Sustainability, Professional Discipline |
| Attendance Evidence | `92`, feeds Professional Discipline |
| Attendance final effect | about `+2` versus removing attendance evidence |
| Professional Discipline inputs | Attendance, Review Completion, Update Hygiene, Workflow Compliance |

## Validation

Local validation passed:

- `node --check intelligence/analytics/intelligenceResponses.service.js`
- `npm run verify:enterprise-intelligence`
- frontend `npm run build`

Production validation passed after deployment:

| Field | Observed |
| --- | --- |
| API revision | `asystence-api-00241-6l8` |
| Frontend alias | `https://app.asystence.com` |
| Trace status | `200` |
| `scoreExplanation.scoreCalculation` | present |
| Final score | `67` |
| Reconstructed final score | `67` |
| Core score | `67` |
| Core contribution points | `54.94` |
| Professional Discipline score | `67` |
| Professional Discipline contribution points | `12.06` |
| Attendance score | `92` |
| Attendance final effect | `+2` versus removing attendance evidence |

The live trace returned domain contributions for Execution Reliability, Delivery Effectiveness, Collaboration Health, Work Sustainability, and Professional Discipline. Evidence inputs now include the domains they feed and their backend-generated effect labels.

## Verdict

The My Performance score is no longer a black box. A user/admin can inspect the final `67/100` calculation directly in the product without needing the backend trace report.
