# Asystence Production Behavioural Certification

**Date:** 02 July 2026  
**Environment:** Live production  
**Workspace used:** `apyhub` (`ba1fca50-897e-4a18-8b22-dc72dd35e7fd`)  
**Final stamp:** `codex-cert-1782940349942`

## Behavioural result

Final authenticated production validation passed:

```json
{
  "checksTotal": 42,
  "checksPassed": 42,
  "checksFailed": 0,
  "criticalFailed": 0
}
```

## Key evidence

| Evidence | ID |
|---|---|
| Project created | `14456f4a-58de-45c3-9892-7dee3121d1ff` |
| Primary task | `bbac504b-ba27-4596-8959-05c9e8d1af6f` |
| AI-generated task | `574d04d4-5c2b-4bc7-a65f-e433d73acbf2` |
| Adaptive action | `c60d46f4-a18a-4ecd-bf7a-e4252d3d359f` |
| Workflow action | `9a7043f9-959c-49b2-a829-59b3e46b1eae` |
| Chat channel | `72f0e5e2-f283-465c-9989-81a565f29324` |

## Adaptive proof chain

| Layer | Evidence | Result |
|---|---|---|
| Event queue | Queue rows `506`, `508`, `509`, `510`, `513` completed with `attempts=1`, `last_error=null`. | Passed |
| Recommendation | Action `c60d46f4...` created by `adaptive_runtime`, `approval_mode=approval_required`. | Passed |
| Approval | Action was rejected through approval flow and stored as `status=rejected`. | Passed |
| Workflow | Workflow action `9a7043f9...` stored as `manual_only`, `status=pending`. | Passed |
| Learning | User-scoped `recommendation.rejected` signal recorded. | Passed |
| Prediction evaluation | `recommendation.accepted` and `outcome.delivery_health_improves` predictions evaluated. | Passed |
| Personalization isolation | Learning signals scoped to user/workspace; E2E forged workspace header could not override token workspace. | Passed |

## Behavioural verdict

The production Adaptive Orchestrator now demonstrates the intended event → reasoning → recommendation → approval → learning → evaluation chain in live production.

