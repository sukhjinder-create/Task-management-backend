import { clamp } from "../shared/runtimeUtils.js";
import { recommendationAcceptancePrior } from "./personalizationEngine.service.js";

export async function applyAdaptivePolicy({ event, context, recommendations, priorLoader = recommendationAcceptancePrior }) {
  const graph = context?.data?.operationalGraph || {};
  const decisions = await Promise.all(recommendations.map(async (recommendation) => {
    const prior = await priorLoader({
      workspaceId: event.workspaceId,
      userId: recommendation.targetUserId || event.actorUserId || null,
      teamId: event.metadata?.teamId || null,
      projectId: recommendation.projectId || graph.relevance?.projectId || null,
      departmentId: event.metadata?.departmentId || null,
      enterpriseId: event.metadata?.enterpriseId || null,
    });
    const ruleConfidence = clamp(Number(recommendation.ruleConfidence ?? recommendation.confidence ?? 0.5), 0, 1);
    const acceptanceProbability = prior.probability;
    const evidenceCoverage = clamp(Number(context.coverage ?? 0), 0, 1);
    const executionConfidence = recommendation.capabilityKey ? 0.9 : 0.5;
    const predictionConfidence = clamp((ruleConfidence * 0.55) + (evidenceCoverage * 0.25) + (acceptanceProbability * 0.2), 0.05, 0.99);
    const outcomeConfidence = clamp((predictionConfidence * 0.7) + (executionConfidence * 0.3), 0.05, 0.99);
    const suppress = prior.sampleCount >= 3
      && acceptanceProbability <= 0.2
      && recommendation.capabilityKey === "notification.send"
      && !["critical"].includes(recommendation.riskLevel);
    return {
      ...recommendation,
      confidence: ruleConfidence,
      confidenceModel: {
        ruleConfidence,
        predictionConfidence,
        outcomeConfidence,
        acceptanceProbability,
        executionConfidence,
        evidenceCoverage,
      },
      personalization: {
        source: prior.source,
        scopeType: prior.scopeType,
        scopeId: prior.scopeId,
        sampleCount: prior.sampleCount,
        explanation: prior.explanation,
      },
      policyDecision: suppress ? "suppressed" : "proposed",
      policyExplanation: suppress
        ? `Suppressed after ${prior.sampleCount} scoped signals reduced acceptance probability to ${Math.round(acceptanceProbability * 100)}%.`
        : `Ranked using ${prior.source}; acceptance probability ${Math.round(acceptanceProbability * 100)}%.`,
      rankScore: outcomeConfidence * (recommendation.riskLevel === "critical" ? 1.25 : recommendation.riskLevel === "high" ? 1.1 : 1),
    };
  }));
  return {
    proposed: decisions.filter((item) => item.policyDecision === "proposed").sort((a, b) => b.rankScore - a.rankScore),
    suppressed: decisions.filter((item) => item.policyDecision === "suppressed"),
  };
}
