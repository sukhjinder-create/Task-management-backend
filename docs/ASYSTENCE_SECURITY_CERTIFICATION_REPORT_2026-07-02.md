# Asystence Security Certification Report

**Date:** 02 July 2026  
**Scope:** Secrets, authentication, tenant isolation, internal APIs, AI service, adaptive governance

## Passed evidence

| Control | Evidence | Result |
|---|---|---|
| Backend secrets | 31 backend sensitive env vars deployed as Secret Manager references. | Passed |
| AI secrets | 5 AI sensitive env vars deployed as Secret Manager references. | Passed |
| Raw secret scan | Cloud Run raw secret-like env scan returned 0 backend and 0 AI raw secret-like variables. | Passed |
| JWT/auth | Production E2E `auth.me` passed. | Passed |
| Workspace isolation | Forged workspace header could not override token workspace. | Passed |
| Approval enforcement | Approval-required action remained governed; rejection recorded. | Passed |
| Manual-only workflow | Testing-agent workflow action stored as `manual_only`, pending. | Passed |
| AI internal readiness | AI `/ready` verified backend internal contracts and internal auth-dependent connectivity. | Passed |
| Local production-safety | Frontend runtime refuses production API while browser is localhost unless explicitly allowed. | Passed |
| High/critical audit | Backend high/critical audit gate passed; AI audit found 0 vulnerabilities. | Passed |

## Remaining security risks

| Risk | Classification | Recommendation |
|---|---|---|
| Backend has 8 moderate npm audit findings through `firebase-admin` transitive dependencies. | Code/dependency hardening, not critical release blocker. | Schedule Node 22 + Firebase Admin 14 upgrade with regression cycle. |
| No confirmed staging failure-injection/security drill environment. | Infrastructure/operations. | Create staging before broad rollout. |
| Credential rotation history cannot be fully proven from repository evidence alone. | Operator/provider. | Maintain rotation log in Secret Manager/GitHub/Vercel operations runbook. |

## Verdict

Security posture is acceptable for a controlled production rollout / enterprise pilot. Broader enterprise rollout should include staging security drills and dependency modernization.

