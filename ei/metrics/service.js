// ei/metrics/service.js
//
// EI V2.1 — orchestration for evidence-backed platform/value metrics. Deterministic,
// flag-gated, additive, computed (not persisted). The report separates metrics that
// are evidence-backed now from those that are honestly marked insufficient_evidence,
// so an investor/enterprise report can never present a fabricated number.

import { computeMetrics } from "./metrics.js";
import { isEiMetricsEnabled } from "../config/flags.js";

/**
 * @param {object} args
 * @param {string} args.workspaceId
 * @param {object} args.corpus  { traces, predictions, recommendations, evidence }
 */
export async function computePlatformMetrics({ workspaceId, corpus = {} } = {}) {
  if (!isEiMetricsEnabled(workspaceId)) return { skipped: "flag_off" };
  const metrics = computeMetrics(corpus);
  const evidenceBacked = metrics.filter((m) => m.evidenceSufficient);
  const insufficient = metrics.filter((m) => !m.evidenceSufficient);
  return {
    workspaceId: String(workspaceId),
    eiVersion: "2.1",
    generatedFrom: "reasoning_corpus", // pure projection of immutable EI records
    metrics,
    summary: {
      total: metrics.length,
      evidenceBacked: evidenceBacked.length,
      insufficientEvidence: insufficient.length,
      insufficientKeys: insufficient.map((m) => m.key),
    },
  };
}
