# Enterprise Scoring Config And Workspace Formula Correction

Generated: 2026-06-25  
Scope: final correction pass for the enterprise scoring configuration surface and Workspace Health explainability. This pass did not redesign the intelligence model, did not move score math into the frontend, did not change environment variables, and did not touch huddles/chat/calling/video modules.

## Executive Verdict

The correction pass is complete for the certified Apyhub core dashboard scope.

- The main workspace-admin scoring UI now exposes only `User Score Balance`.
- The only editable pair is `Core Domains` and `Professional Discipline`.
- Internal user-core, project, team, and workspace index weights remain backend-owned engine internals.
- Workspace Health explainability now includes a backend-owned `scoreCalculation` block with final score, raw score before rounding, domain rows, weights, weighted contributions, adaptive formula components, attendance/readiness contribution, and user-score-balance propagation.
- User Score Balance to Workspace Health propagation is intended and now documented in the API contract and UI tooltip as an indirect rollup through `user_intelligence` outputs.

## What Was Wrong Before

The previous admin scoring surface exposed internal composition groups:

- User Core Domain Emphasis
- Project Intelligence Emphasis
- Team Intelligence Emphasis
- Workspace Health Emphasis
- User Score Balance

That made the product surface look like an engineering console. It also made Workspace Health movement harder to trust because admins could see many internal weights without a compact explanation of which control was meant for product use.

Workspace Health explainability also showed index rows and neutral impact, but it did not clearly show the canonical adaptive scoring construction. Attendance Readiness was described narratively rather than shown as score x weight = contribution.

## Final Admin Scoring Surface

Backend now returns:

- `config`: full canonical scoring config for compatibility and engine audit.
- `editableConfig`: narrowed workspace-admin product surface.
- `adminSurface`: alias of `editableConfig` for explicit product semantics.

The admin surface is:

```json
{
  "source": "enterprise_intelligence_scoring_config_admin_surface",
  "productSurface": "workspace_admin_user_score_balance",
  "editableGroupKeys": ["userFinalBalance"],
  "groups": {
    "userFinalBalance": {
      "label": "User Score Balance",
      "type": "pair",
      "weights": {
        "core": 0.99,
        "professionalDiscipline": 0.01
      }
    }
  }
}
```

The pair remains normalized with the existing backend constraints:

- minimum `0.01`
- maximum `0.99`
- normalized total `1`
- paired auto-complement behavior

The frontend Dashboard consumes `editableConfig || adminSurface || config` and filters the main UI to `userFinalBalance`, so older responses cannot accidentally re-expose internal groups.

## Final Workspace Health Formula Contract

Workspace Health authority remains:

```text
workspace_intelligence.score
```

The backend now returns:

```text
scoreExplanation.scoreCalculation
```

Formula:

```text
workspace score = weighted/adaptive blend of workspace index scores:
weighted mean 32%,
median 30%,
harmonic mean 22%,
balance / outlier dampener 10%,
evidence confidence 6%
```

The contract includes:

- `finalScore`
- `rawScoreBeforeRounding`
- `finalRoundedScore`
- `scoreAuthority`
- `formulaLabel`
- `formulaReadable`
- `domainContributions[]`
- `formulaComponents[]`
- `attendanceReadinessContribution`
- `workforceSustainabilityContribution`
- `userScoreBalancePropagation`

Each workspace index row includes:

- key
- label
- score
- configured weight
- normalized weight
- weighted contribution points
- source path
- final-score impact versus neutral

## Attendance / Readiness Contribution

Attendance Readiness is mathematically visible when present.

Live Apyhub verification returned:

```json
{
  "key": "attendanceReadinessIndex",
  "label": "Attendance Readiness",
  "score": 67,
  "configuredWeight": 0.0693,
  "normalizedWeight": 0.0693,
  "weightedContributionPoints": 4.64,
  "finalScoreImpactVsNeutral": 1,
  "contributionPath": "direct_workspace_index",
  "directOrIndirect": "direct",
  "source": "workspace_intelligence.indexes.attendanceReadinessIndex"
}
```

Interpretation:

- Attendance Readiness contributes directly as a workspace index.
- It does not dominate Workspace Health.
- It is still part of the adaptive blend, so its weighted-mean contribution is visible before the adaptive formula components are applied.

## User Score Balance To Workspace Health

Decision: intended propagation.

User Score Balance does not directly change workspace index weights.

It changes canonical `user_intelligence.score`. Workspace Intelligence then aggregates user outputs into:

- `workspaceHealthIndex`
- `productivityIndex`
- `strategicRiskIndex`
- high performer / at-risk distribution
- readiness rollups including `attendanceReadinessIndex`
- sustainability rollups including `capacitySustainabilityIndex`

Therefore Workspace Health can move after recalculation when User Score Balance changes. This is not a hidden override and not an accidental coupling. The UI tooltip now states the propagation as:

```text
User Score Balance changes canonical user_intelligence.score. Workspace Health then aggregates those user scores into workspaceHealthIndex, strategicRiskIndex, high-performer/at-risk distribution, and readiness rollups, so workspace_intelligence.score can move after recalculation.
```

The contract also exposes:

```json
{
  "intended": true,
  "mode": "indirect_user_intelligence_rollup",
  "directWorkspaceWeightChangedByUserBalance": false
}
```

## Apyhub Live Verification

Target:

- Workspace: exact-case Apyhub
- Workspace ID: `3ff9264b-1a19-483a-b9e3-2a0b1840a1c2`
- Backend revision: `asystence-api-00251-tfp`
- Frontend alias: `https://app.asystence.com`
- Frontend deployment: `https://asystence-ixdky9rew-sukhjinders400-4830s-projects.vercel.app`

Live internal closure verification returned:

```json
{
  "status": 200,
  "adminSurface": {
    "editableGroupKeys": ["userFinalBalance"],
    "hiddenGroupKeys": [
      "userCoreDomains",
      "projectIndexes",
      "teamIndexes",
      "workspaceIndexes"
    ],
    "groupCount": 1,
    "visibleGroups": ["userFinalBalance"]
  },
  "pairWeights": {
    "core": 0.99,
    "professionalDiscipline": 0.01
  },
  "pairTotal": 1,
  "recalculation": {
    "workspaceScore": 55,
    "users": 3,
    "projects": 3,
    "teams": 0
  }
}
```

Workspace Health formula proof:

```json
{
  "healthScore": 55,
  "finalScore": 55,
  "authority": "workspace_intelligence.score",
  "rawScoreBeforeRounding": 54.58,
  "finalRoundedScore": 55,
  "componentCount": 5,
  "domainCount": 8
}
```

Frontend production bundle proof:

```json
{
  "chunkUrl": "https://app.asystence.com/assets/Dashboard-B93GcutC.js",
  "hasUserScoreBalance": true,
  "hasAdminSurfaceFilter": true,
  "hasInternalWeightCopy": true,
  "hasOldMultiWeightCopy": false,
  "hasTeamIntelligenceLabel": false,
  "hasProjectIntelligenceLabel": false,
  "hasWorkspaceFormulaRendering": true
}
```

## Validation Evidence

Passed:

```bash
node --check intelligence/config/scoringConfig.model.js
node --check intelligence/analytics/intelligenceResponses.service.js
node --check intelligence/intelligence.controller.js
node --check routes/internal.js
npm run verify:enterprise-intelligence
npm run verify:dashboard-range-charts
npm run build
```

`verify:enterprise-intelligence` now also asserts:

- admin scoring surface exposes only `userFinalBalance`
- Dashboard renders `adminScoringGroups`
- Dashboard hides internal scoring groups from the main admin UI
- Dashboard renders backend-owned `workspaceScoreCalculation`
- Dashboard renders attendance/readiness contribution math
- Dashboard no longer contains the old main UI multi-weight copy

## Deployment Evidence

Backend:

- Git commit: `b2f33b6`
- Cloud Build: `c09c2790-7dc4-4236-b718-abf370b3f51c`
- Cloud Run revision: `asystence-api-00251-tfp`
- Traffic: 100%

Frontend:

- Git commit: `6d23759`
- Vercel production deployment: `https://asystence-ixdky9rew-sukhjinders400-4830s-projects.vercel.app`
- Alias: `https://app.asystence.com`

## Final Status

The enterprise intelligence/dashboard workstream remains closed for the certified Apyhub core scope after this correction pass.

The correction did not reopen the architecture. It narrowed the admin-facing scoring surface, hardened Workspace Health explainability, and made the intended user-score-balance to workspace-health propagation explicit and auditable.
