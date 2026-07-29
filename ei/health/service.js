// ei/health/service.js
//
// EI V2.1 Wave C — orchestration for platform health. Deterministic, flag-gated,
// additive, computed (pure projection). Separates evidence-backed health from
// insufficient-evidence dimensions so no health figure is fabricated.

import { computeHealth } from "./health.js";
import { isEiHealthEnabled } from "../config/flags.js";

/** @param {object} args { workspaceId, corpus } */
export async function computePlatformHealth({ workspaceId, corpus = {} } = {}) {
  if (!isEiHealthEnabled(workspaceId)) return { skipped: "flag_off" };
  const metrics = computeHealth(corpus);
  const backed = metrics.filter((x) => x.evidenceSufficient);
  return {
    workspaceId: String(workspaceId),
    eiVersion: "2.1",
    generatedFrom: "reasoning_corpus_and_outcomes",
    metrics,
    summary: { total: metrics.length, evidenceBacked: backed.length, insufficientEvidence: metrics.length - backed.length, insufficientKeys: metrics.filter((x) => !x.evidenceSufficient).map((x) => x.key) },
  };
}
