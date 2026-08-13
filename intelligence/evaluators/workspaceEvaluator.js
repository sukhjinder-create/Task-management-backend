import {
  adaptiveScore,
  bandForScore,
  evidenceConfidence,
  hashEvidence,
  ratio,
  riskLevel,
  roundScore,
  trendFromSeries,
  uniqueStrings,
} from "../engine/scorePrimitives.js";
import {
  appliedScoreModel,
  scoreObjectWithScoringConfig,
} from "../config/scoringConfig.model.js";

function avg(values = []) {
  const nums = values.map(Number).filter(Number.isFinite);
  if (!nums.length) return 0;
  return nums.reduce((total, value) => total + value, 0) / nums.length;
}

function aggregateSourceWindow(items = []) {
  const starts = items.map((item) => item.coverageStart || item.sourceWindow?.startDate).filter(Boolean).sort();
  const ends = items.map((item) => item.coverageEnd || item.sourceWindow?.endDate).filter(Boolean).sort();
  const attendanceClosed = items
    .map((item) => item.attendanceClosedThroughDate || item.sourceWindow?.attendanceClosedThroughDate)
    .filter(Boolean)
    .sort();
  return {
    startDate: starts[0] || null,
    endDate: ends[ends.length - 1] || null,
    attendanceClosedThroughDate: attendanceClosed[0] || null,
    source: "latest_authoritative_profiles",
  };
}

export function evaluateWorkspaceIntelligence({ workspaceId, users = [], projects = [], teams = [], evidence = {}, scoringConfig = null }) {
  const userScores = users.map((row) => Number(row.score)).filter(Number.isFinite);
  const projectScores = projects.map((row) => Number(row.score)).filter(Number.isFinite);
  const teamScores = teams.map((row) => Number(row.score)).filter(Number.isFinite);
  const atRiskUsers = users.filter((row) => row.risk?.level === "High" || Number(row.score) < 48).length;
  const highPerformers = users.filter((row) => Number(row.score) >= 75).length;
  const criticalProjects = projects.filter((row) => row.risk?.level === "High" || Number(row.score) < 48).length;
  const execution = evidence.execution || {};
  const internalTotal = Number(execution.internalTotal) || 0;
  const internalCompleted = Number(execution.internalCompleted) || 0;
  const externalTotal = Number(execution.externalTotal) || 0;
  const externalCompleted = Number(execution.externalCompleted) || 0;
  const totalWork = Number(execution.totalWork) || internalTotal + externalTotal;
  const completedWork = Number(execution.completedWork) || internalCompleted + externalCompleted;
  const assuranceEvidence = evidence.assurance || {};
  const assuranceEligible = assuranceEvidence.eligible === true;
  const assuranceOutcomeCount = Number(assuranceEvidence.outcomeCount) || 0;
  const assuranceVerifiedSampleSize = Number(assuranceEvidence.verifiedSampleSize) || 0;
  const assuranceRequiredSampleSize = Math.max(3, Number(assuranceEvidence.requiredSampleSize) || 3);
  const assuranceSnapshottedOutcomeCount = Number(assuranceEvidence.snapshottedOutcomeCount) || 0;
  const assuranceSignals = [
    assuranceVerifiedSampleSize > 0 && {
      value: ratio(assuranceEvidence.verifiedOnTimeCount, assuranceVerifiedSampleSize, 0.62) * 100,
    },
    assuranceOutcomeCount > 0 && {
      value: ratio(assuranceEvidence.outcomesWithEvidence, assuranceOutcomeCount, 0.62) * 100,
    },
    assuranceSnapshottedOutcomeCount > 0 && {
      value: ratio(assuranceEvidence.healthyOutcomeCount, assuranceSnapshottedOutcomeCount, 0.62) * 100,
    },
  ].filter(Boolean);
  const outcomeAssuranceIndex = assuranceEligible
    ? adaptiveScore(assuranceSignals, {
      neutral: 62,
      confidence: evidenceConfidence({
        observed: assuranceVerifiedSampleSize,
        expected: Math.max(assuranceRequiredSampleSize, 10),
        breadth: assuranceSignals.length / 3,
      }),
    })
    : null;
  const baseExecutionSignals = [
    internalTotal > 0 && { value: ratio(internalCompleted, internalTotal, 0.62) * 100 },
    externalTotal > 0 && { value: ratio(externalCompleted, externalTotal, 0.62) * 100 },
    totalWork > 0 && { value: ratio(completedWork, totalWork, 0.62) * 100 },
  ].filter(Boolean);
  const baseExecutionConfidence = evidenceConfidence({
    observed: Math.min(totalWork, 24),
    expected: 24,
    breadth: externalTotal > 0 ? 1 : 0.82,
  });
  const executionRealityWithoutAssurance = adaptiveScore(baseExecutionSignals, {
    neutral: 62,
    confidence: baseExecutionConfidence,
  });
  const executionSignals = [
    ...baseExecutionSignals,
    assuranceEligible && { value: outcomeAssuranceIndex },
  ].filter(Boolean);
  const executionRealityIndex = adaptiveScore(executionSignals, {
    neutral: 62,
    confidence: evidenceConfidence({
      observed: Math.min(totalWork, 24) + (assuranceEligible ? 1 : 0),
      expected: 24,
      breadth: externalTotal > 0 || assuranceEligible ? 1 : 0.82,
    }),
  });

  const workspaceHealthConfidence = evidenceConfidence({
    observed: users.length + projects.length + teams.length + (totalWork > 0 ? 1 : 0),
    expected: 9,
    breadth: teams.length || totalWork > 0 ? 1 : 0.8,
  });
  const workspaceHealthWithoutOutcomeAssurance = adaptiveScore([
    { value: avg(userScores) || 62 },
    { value: avg(projectScores) || 62 },
    { value: avg(teamScores) || avg(userScores) || 62 },
    { value: executionRealityWithoutAssurance },
  ], { confidence: workspaceHealthConfidence });
  const workspaceHealthIndex = adaptiveScore([
    { value: avg(userScores) || 62 },
    { value: avg(projectScores) || 62 },
    { value: avg(teamScores) || avg(userScores) || 62 },
    { value: executionRealityIndex },
  ], { confidence: workspaceHealthConfidence });

  const productivityIndex = adaptiveScore([
    { value: avg(users.map((row) => row.dimensions?.deliveryEffectiveness?.score ?? 62)) || 62 },
    { value: avg(projects.map((row) => row.indexes?.velocityHealth ?? 62)) || 62 },
    { value: ratio(highPerformers, Math.max(1, users.length), 0.35) * 100 },
  ], { confidence: 74 });

  const strategicRiskIndex = roundScore(100 - adaptiveScore([
    { value: ratio(atRiskUsers, Math.max(1, users.length), 0.2) * 100 },
    { value: ratio(criticalProjects, Math.max(1, projects.length), 0.2) * 100 },
    { value: 100 - (avg(userScores) || 62) },
  ], { confidence: 74 }));

  const baseDeliverySignals = [
    { value: avg(projects.map((row) => row.indexes?.completionConfidence ?? row.score ?? 62)) || 62 },
    { value: avg(teams.map((row) => row.indexes?.deliveryReliabilityIndex ?? row.score ?? 62)) || 62 },
  ];
  const deliveryConfidenceWithoutAssurance = adaptiveScore(baseDeliverySignals, {
    confidence: evidenceConfidence({
      observed: projects.length + teams.length,
      expected: 4,
      breadth: 1,
    }),
  });
  const deliveryConfidenceIndex = adaptiveScore([
    ...baseDeliverySignals,
    assuranceEligible && { value: outcomeAssuranceIndex },
  ].filter(Boolean), { confidence: evidenceConfidence({
    observed: projects.length + teams.length + (assuranceEligible ? 1 : 0),
    expected: 4,
    breadth: 1,
  }) });

  const organizationalAlignmentIndex = adaptiveScore([
    { value: avg(teams.map((row) => row.indexes?.executionPredictability ?? row.score ?? 62)) || 62 },
    { value: avg(users.map((row) => row.dimensions?.collaborationHealth?.score ?? 62)) || 62 },
    { value: avg(projectScores) || 62 },
  ], { confidence: 72 });
  const attendanceReadinessIndex = adaptiveScore([
    { value: avg(users.map((row) => row.attendance?.score ?? 62)) || 62 },
    { value: avg(users.map((row) => row.dimensions?.professionalDiscipline?.score ?? 62)) || 62 },
  ], { confidence: evidenceConfidence({ observed: users.filter((row) => row.attendance?.score != null).length, expected: Math.max(1, users.length), breadth: 0.78 }) });
  const capacitySustainabilityIndex = adaptiveScore([
    { value: avg(users.map((row) => row.dimensions?.workSustainability?.score ?? 62)) || 62 },
    { value: avg(teams.map((row) => row.indexes?.workloadBalanceIndex ?? 62)) || 62 },
  ], { confidence: evidenceConfidence({ observed: users.length + teams.length, expected: 6, breadth: teams.length ? 1 : 0.75 }) });

  const indexes = {
    workspaceHealthIndex,
    productivityIndex,
    strategicRiskIndex,
    deliveryConfidenceIndex,
    organizationalAlignmentIndex,
    executionRealityIndex,
    attendanceReadinessIndex,
    capacitySustainabilityIndex,
  };
  const confidence = evidenceConfidence({
    observed: users.length + projects.length + teams.length,
    expected: 10,
    breadth: teams.length && projects.length ? 1 : 0.82,
  });
  const scoreModel = appliedScoreModel(scoringConfig, ["workspaceIndexes"]);
  const score = scoreObjectWithScoringConfig(indexes, scoringConfig, "workspaceIndexes", { confidence });
  const scoreWithoutOutcomeAssurance = assuranceEligible
    ? scoreObjectWithScoringConfig({
      ...indexes,
      workspaceHealthIndex: workspaceHealthWithoutOutcomeAssurance,
      executionRealityIndex: executionRealityWithoutAssurance,
      deliveryConfidenceIndex: deliveryConfidenceWithoutAssurance,
    }, scoringConfig, "workspaceIndexes", { confidence })
    : score;
  const riskProbability = Math.max(0, 100 - strategicRiskIndex + atRiskUsers * 3 + criticalProjects * 5);

  const output = {
    subjectType: "workspace",
    workspaceId,
    score,
    band: bandForScore(score),
    trend: trendFromSeries([productivityIndex, deliveryConfidenceIndex, score]),
    confidence,
    indexes,
    strengths: uniqueStrings([
      highPerformers > 0 && `${highPerformers} high performer(s) across the workspace`,
      deliveryConfidenceIndex >= 75 && "Delivery confidence is strong",
      organizationalAlignmentIndex >= 75 && "Organizational alignment is healthy",
      executionRealityIndex >= 75 && "Execution reality signals are healthy",
      assuranceEligible && outcomeAssuranceIndex >= 75 && "Verified outcome assurance is strong",
      attendanceReadinessIndex >= 75 && "Attendance readiness is healthy",
      capacitySustainabilityIndex >= 75 && "Capacity sustainability is healthy",
    ].filter(Boolean)),
    concerns: uniqueStrings([
      atRiskUsers > 0 && `${atRiskUsers} at-risk employee(s) require manager follow-up`,
      criticalProjects > 0 && `${criticalProjects} high-risk project(s) need portfolio attention`,
      strategicRiskIndex < 55 && "Strategic risk is elevated",
      totalWork > 0 && executionRealityIndex < 55 && "Execution completion evidence is below expected level",
      assuranceEligible && outcomeAssuranceIndex < 55 && "Verified outcomes show assurance pressure",
      attendanceReadinessIndex < 55 && "Attendance readiness requires follow-up",
      capacitySustainabilityIndex < 55 && "Capacity sustainability risk is elevated",
    ].filter(Boolean)),
    drivers: uniqueStrings([
      `${users.length} user profile(s), ${projects.length} project profile(s), ${teams.length} team profile(s) aggregated`,
      totalWork > 0 && `${completedWork} of ${totalWork} tracked work item(s) completed across internal and integration sources`,
      assuranceEligible && `${assuranceVerifiedSampleSize} verified outcome(s) contribute to execution reality and delivery confidence`,
    ]),
    indicators: [
      atRiskUsers > 0 && { type: "People Risk", label: `${atRiskUsers} at-risk employee(s)` },
      criticalProjects > 0 && { type: "Portfolio Risk", label: `${criticalProjects} project(s) in high-risk zone` },
      totalWork > 0 && executionRealityIndex < 55 && { type: "Execution Risk", label: "Tracked work completion is under pressure" },
      assuranceEligible && outcomeAssuranceIndex < 55 && { type: "Outcome Assurance", label: "Verified outcome evidence is under pressure" },
    ].filter(Boolean),
    risk: {
      probability: roundScore(riskProbability),
      level: riskLevel(riskProbability),
    },
    analytics: {
      userCount: users.length,
      projectCount: projects.length,
      teamCount: teams.length,
      highPerformers,
      atRiskUsers,
      criticalProjects,
      averageUserScore: roundScore(avg(userScores)),
      averageProjectScore: roundScore(avg(projectScores)),
      averageTeamScore: roundScore(avg(teamScores)),
      attendanceReadinessIndex,
      capacitySustainabilityIndex,
      execution: {
        internalTotal,
        internalCompleted,
        externalTotal,
        externalCompleted,
        totalWork,
        completedWork,
        externalProviderCount: Number(execution.externalProviderCount) || 0,
        externalSignalCount: Number(execution.externalSignalCount) || 0,
      },
      assurance: {
        eligible: assuranceEligible,
        status: assuranceEligible ? "contributing" : "learning",
        requiredSampleSize: assuranceRequiredSampleSize,
        verifiedSampleSize: assuranceVerifiedSampleSize,
        outcomeCount: assuranceOutcomeCount,
        outcomesWithEvidence: Number(assuranceEvidence.outcomesWithEvidence) || 0,
        verifiedOnTimeCount: Number(assuranceEvidence.verifiedOnTimeCount) || 0,
        snapshottedOutcomeCount: assuranceSnapshottedOutcomeCount,
        healthyOutcomeCount: Number(assuranceEvidence.healthyOutcomeCount) || 0,
        attentionOutcomeCount: Number(assuranceEvidence.attentionOutcomeCount) || 0,
        verifiedOnTimeRate: assuranceVerifiedSampleSize > 0
          ? roundScore(ratio(assuranceEvidence.verifiedOnTimeCount, assuranceVerifiedSampleSize, 0) * 100)
          : null,
        evidenceCoverageRate: assuranceOutcomeCount > 0
          ? roundScore(ratio(assuranceEvidence.outcomesWithEvidence, assuranceOutcomeCount, 0) * 100)
          : null,
        currentHealthyRate: assuranceSnapshottedOutcomeCount > 0
          ? roundScore(ratio(assuranceEvidence.healthyOutcomeCount, assuranceSnapshottedOutcomeCount, 0) * 100)
          : null,
        outcomeAssuranceIndex,
        contributionPaths: assuranceEligible
          ? ["executionRealityIndex", "deliveryConfidenceIndex"]
          : [],
        indexImpactPoints: {
          workspaceHealthIndex: workspaceHealthIndex - workspaceHealthWithoutOutcomeAssurance,
          executionRealityIndex: executionRealityIndex - executionRealityWithoutAssurance,
          deliveryConfidenceIndex: deliveryConfidenceIndex - deliveryConfidenceWithoutAssurance,
        },
        scoreWithoutOutcomeAssurance,
        finalScoreImpactPoints: score - scoreWithoutOutcomeAssurance,
        guardrail: "No score contribution is made before the workspace reaches its configured verified-outcome sample.",
      },
      scoreModel,
    },
    scoreModel,
    sourceWindow: aggregateSourceWindow([...users, ...projects, ...teams]),
  };

  return {
    ...output,
    evidenceHash: hashEvidence({ indexes, analytics: output.analytics, scoreModel }),
  };
}

export default evaluateWorkspaceIntelligence;
