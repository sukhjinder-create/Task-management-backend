# Asystence Cloud Cost Optimization Report

**Date:** 02 July 2026  
**Scope:** Cloud Run, Cloud Build, GCR/Artifact Registry, Vercel

## Observed cost signals

| Area | Evidence | Risk |
|---|---|---|
| Backend Cloud Run | `minScale=1`, `maxScale=100`, `cpu-throttling=false`, `timeout=3600`, concurrency `1000`. | Higher always-on cost; acceptable for pilot but should be tuned. |
| AI Cloud Run | `minScale=0`, `maxScale=10`, timeout `300`, concurrency `80`. | Reasonable pilot posture. |
| Cloud Run revisions | Backend 22 revisions, AI 6 revisions. | Manageable, but prune old revisions after rollback window. |
| GCR backend images | 215 backend image tags. | Cleanup policy needed. |
| Artifact Registry | `cloud-run-source-deploy` size approximately `16,058,880,940` bytes. | Cleanup policy needed. |
| Frontend/Landing | Vercel deployments ready; no immediate cost issue observed. | Low. |

## Recommended cost actions

1. Add Artifact Registry cleanup policy retaining last 15-30 deployable images plus all currently trafficked rollback images.
2. Prune old GCR backend images after confirming rollback window.
3. Revisit backend Cloud Run:
   - Consider `minScale=0` outside business-critical windows, or keep `minScale=1` during pilot only.
   - Re-enable CPU throttling unless background in-request work requires always-allocated CPU.
   - Lower `maxScale=100` after traffic baseline is known.
   - Reassess `timeout=3600`; most API paths should not require one hour.
4. Track AI provider spend during pilot; AI `/ready` confirmed Groq availability and model listing.

## Actions not taken automatically

No image cleanup or Cloud Run scale reduction was performed during certification because those actions can reduce rollback depth or alter production performance. Treat them as controlled operations work after pilot approval.

