# Asystence AIEP Cost Impact Assessment

**Date:** 2 July 2026  
**Scope:** Compute, storage, AI/provider, and operational cost  
**Verdict:** Low cost impact; no new AI-provider cost introduced.

## AI/provider cost

AIEP does not call AI providers.

It reuses existing:

- adaptive actions;
- runtime traces;
- predictions;
- workflow runs;
- capability invocations;
- learning signals.

Therefore it introduces no token cost and no provider latency.

## Compute cost

Compute cost comes from:

- admin dashboard reads;
- idempotent evaluation materialization;
- aggregate snapshot writes.

The work is bounded by limits and only runs on dashboard/API access, not on every task or chat event.

## Storage cost

New storage:

- one evaluation row per adaptive action lifecycle;
- periodic metric snapshot rows for workspace/platform dashboards.

The migration is additive and indexed. Historical archive/retention policy is recommended before large enterprise rollout.

## Recommended retention policy

For pilot:

- keep detailed evaluations for 180 days;
- keep monthly aggregates for 24 months;
- archive or compact old detailed records after pilot review.

For enterprise scale:

- partition or archive `adaptive_intelligence_evaluations` by month if row volume becomes high;
- keep superadmin platform snapshots aggregate-only;
- avoid storing raw customer content in platform-level metrics.

## Operational cost

Operators gain visibility into:

- recommendation effectiveness;
- confidence calibration;
- strategy effectiveness;
- context contribution;
- runtime failures.

This reduces investigation cost without adding another AI system.

## Final cost conclusion

AIEP is cost-conscious by design. Its primary cost is small relational storage and bounded dashboard aggregation. It introduces no additional AI inference cost.
