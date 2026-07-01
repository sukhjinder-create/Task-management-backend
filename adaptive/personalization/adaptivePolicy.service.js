import { clamp } from "../shared/runtimeUtils.js";
import { adaptiveStrategyPrior, recommendationAcceptancePrior } from "./personalizationEngine.service.js";

export async function applyAdaptivePolicy({
  event,
  context,
  recommendations,
  priorLoader = recommendationAcceptancePrior,
  strategyLoader = adaptiveStrategyPrior,
}) {
  const graph = context?.data?.operationalGraph || {};
  const decisions = await Promise.all(recommendations.map(async (recommendation) => {
    const profileInput = {
      workspaceId: event.workspaceId,
      userId: recommendation.targetUserId || event.actorUserId || null,
      teamId: event.metadata?.teamId || null,
      projectId: recommendation.projectId || graph.relevance?.projectId || null,
      departmentId: event.metadata?.departmentId || null,
      enterpriseId: event.metadata?.enterpriseId || null,
    };
    const [prior, strategy] = await Promise.all([
      priorLoader(profileInput),
      strategyLoader(profileInput),
    ]);
    const ruleConfidence = clamp(Number(recommendation.ruleConfidence ?? recommendation.confidence ?? 0.5), 0, 1);
    const acceptanceProbability = prior.probability;
    const evidenceCoverage = clamp(Number(context.coverage ?? 0), 0, 1);
    const executionConfidence = recommendation.capabilityKey ? 0.9 : 0.5;
    const preferredCapability = strategy.preferredCapabilities.includes(recommendation.capabilityKey);
    const avoidedCapability = strategy.avoidedCapabilities.includes(recommendation.capabilityKey);
    const strategyAdjustment = preferredCapability ? 0.08 : avoidedCapability ? -0.12 : 0;
    const notificationPenalty = recommendation.capabilityKey === "notification.send"
      && strategy.notificationCadence === "digest_or_critical_only"
      && recommendation.riskLevel !== "critical"
      ? -0.1
      : 0;
    const predictionConfidence = clamp(
      (ruleConfidence * 0.52) + (evidenceCoverage * 0.23) + (acceptanceProbability * 0.2)
      + strategyAdjustment + notificationPenalty,
      0.05,
      0.99
    );
    const outcomeConfidence = clamp((predictionConfidence * 0.7) + (executionConfidence * 0.3), 0.05, 0.99);
    const suppress = prior.sampleCount >= 3
      && acceptanceProbability <= 0.2
      && recommendation.capabilityKey === "notification.send"
      && !["critical"].includes(recommendation.riskLevel);
    const strategySuppress = avoidedCapability
      && strategy.sampleCount >= 3
      && !["high", "critical"].includes(recommendation.riskLevel);
    const effectiveTiming = strategy.preferredTiming && !["high", "critical"].includes(recommendation.riskLevel)
      ? strategy.preferredTiming
      : recommendation.recommendedTiming;
    const stricterApproval = strategy.approvalBias === "prefer_manual_review" ? "manual_only"
      : strategy.approvalBias === "prefer_approval_gate" && recommendation.approvalMode !== "manual_only" ? "approval_required"
        : recommendation.approvalMode;
    return {
      ...recommendation,
      confidence: ruleConfidence,
      recommendedTiming: effectiveTiming,
      approvalMode: stricterApproval,
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
        strategySource: strategy.source,
        strategyScopeType: strategy.scopeType,
        strategySampleCount: strategy.sampleCount,
        strategyExplanation: strategy.explanation,
        preferredCapabilities: strategy.preferredCapabilities,
        avoidedCapabilities: strategy.avoidedCapabilities,
        notificationCadence: strategy.notificationCadence,
        approvalBias: strategy.approvalBias,
        timing: effectiveTiming,
      },
      policyDecision: suppress || strategySuppress ? "suppressed" : "proposed",
      policyExplanation: suppress
        ? `Suppressed after ${prior.sampleCount} scoped signals reduced acceptance probability to ${Math.round(acceptanceProbability * 100)}%.`
        : strategySuppress
          ? `Suppressed by ${strategy.source}; ${recommendation.capabilityKey} is currently avoided for this scope.`
          : `Ranked using ${prior.source} and ${strategy.source}; acceptance probability ${Math.round(acceptanceProbability * 100)}%, timing ${effectiveTiming || "policy default"}.`,
      rankScore: outcomeConfidence
        * (recommendation.riskLevel === "critical" ? 1.25 : recommendation.riskLevel === "high" ? 1.1 : 1)
        * (preferredCapability ? 1.08 : avoidedCapability ? 0.82 : 1),
    };
  }));
  return {
    proposed: decisions.filter((item) => item.policyDecision === "proposed").sort((a, b) => b.rankScore - a.rankScore),
    suppressed: decisions.filter((item) => item.policyDecision === "suppressed"),
  };
}
