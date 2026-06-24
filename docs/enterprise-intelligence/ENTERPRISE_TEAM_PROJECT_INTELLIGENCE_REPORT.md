# Enterprise Team And Project Intelligence Report

Generated: 2026-06-24

## Team Intelligence Proof

`team_intelligence` is computed in `intelligence/evaluators/teamEvaluator.js`.

It is not only an average of user scores.

Team-level indexes:

- `teamPerformanceIndex`
- `deliveryReliabilityIndex`
- `collaborationIndex`
- `executionPredictability`
- `workloadBalanceIndex`
- `blockerResolutionHealth`
- `teamRiskIndex`

Evidence used:

- member intelligence profiles
- project intelligence profiles
- high-performer ratio
- at-risk member count
- member collaboration dimensions
- member execution reliability dimensions
- member workload distribution
- member sustainability dimensions
- project delivery scores
- project dependency and blocked-work health
- team risk probability

The evaluator stores:

- score
- band
- trend
- confidence
- strengths
- concerns
- drivers
- indicators
- risk
- analytics
- source window
- evidence hash

Important nuance: user and project scores are inputs, but the team result also evaluates delivery reliability, collaboration, execution predictability, workload balance, blocker/dependency flow health, and risk concentration.

## Project Intelligence Proof

`project_intelligence` is computed in `intelligence/evaluators/projectEvaluator.js`.

It is not a monthly score replacement.

Project-level indexes:

- `deliveryHealth`
- `velocityHealth`
- `scopeStability`
- `dependencyRisk`
- `completionConfidence`
- `executionMomentum`
- `participationHealth`

Evidence used:

- task completion status
- due date discipline
- overdue open work
- blocked open work
- story point completion
- completion cycle time
- sprint completion
- task dependency links
- scope growth within the evidence window
- recent completions within the evidence window
- assignee/ownership coverage

The evaluator stores:

- score
- band
- trend
- confidence
- strengths
- concerns
- drivers
- indicators
- risk
- analytics
- source window
- evidence hash

## Current Repository Flow

1. `collectProjectEvidence()` gathers project evidence.
2. `evaluateProjectIntelligence()` creates project intelligence.
3. `saveProjectIntelligence()` writes `project_intelligence`.
4. `writeSnapshot()` writes `intelligence_snapshots`.
5. Team and workspace evaluators consume saved project intelligence as evidence.

## Gap Noted

`GET /intelligence/team/comparison` returns a derived user-comparison table from `user_intelligence` for backward compatibility. It now declares `surfaceClassification: "derived_user_comparison"`, points to `team_intelligence` as canonical team authority, and declares `authority.teamScoreAuthority = false`.

## Final Completion Update

The verifier now evaluates synthetic project and team outputs and asserts:

- project `executionMomentum`
- project `participationHealth`
- team `workloadBalanceIndex`
- team `blockerResolutionHealth`
- workspace `attendanceReadinessIndex`
- workspace `capacitySustainabilityIndex`
