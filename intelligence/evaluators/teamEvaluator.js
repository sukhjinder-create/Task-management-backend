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

function avg(values = []) {
  const nums = values.map(Number).filter(Number.isFinite);
  if (!nums.length) return 0;
  return nums.reduce((total, value) => total + value, 0) / nums.length;
}

function balanceScore(values = [], neutral = 62) {
  const nums = values.map(Number).filter(Number.isFinite);
  if (nums.length < 2) return neutral;
  const mean = avg(nums);
  if (mean <= 0) return neutral;
  const spread = Math.sqrt(nums.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / nums.length);
  return roundScore(Math.max(0, 100 - Math.min(100, (spread / mean) * 100)));
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

export function evaluateTeamIntelligence({ workspaceId, teamKey, managerId = null, users = [], projects = [] }) {
  const memberScores = users.map((row) => Number(row.score)).filter(Number.isFinite);
  const projectScores = projects.map((row) => Number(row.score)).filter(Number.isFinite);
  const atRisk = users.filter((row) => row.risk?.level === "High" || Number(row.score) < 48).length;
  const highPerformers = users.filter((row) => Number(row.score) >= 75).length;
  const avgUser = avg(memberScores);
  const avgProject = avg(projectScores);

  const deliveryReliabilityIndex = adaptiveScore([
    { value: avgUser || 62 },
    { value: avgProject || avgUser || 62 },
    { value: ratio(highPerformers, Math.max(1, users.length), 0.4) * 100 },
  ], {
    confidence: evidenceConfidence({ observed: users.length + projects.length, expected: 4, breadth: projects.length ? 1 : 0.78 }),
  });
  const collaborationIndex = adaptiveScore(users.map((row) => ({
    value: row.dimensions?.collaborationHealth?.score ?? 62,
  })), { confidence: 70 });
  const executionPredictability = adaptiveScore(users.map((row) => ({
    value: row.dimensions?.executionReliability?.score ?? 62,
  })), { confidence: 70 });
  const workloadBalanceIndex = adaptiveScore([
    { value: balanceScore(users.map((row) => row.analytics?.assignedWork)) },
    { value: avg(users.map((row) => row.dimensions?.workSustainability?.score ?? 62)) || 62 },
  ], { confidence: evidenceConfidence({ observed: users.length, expected: 3, breadth: 0.82 }) });
  const blockerResolutionHealth = adaptiveScore([
    { value: avg(projects.map((row) => row.indexes?.dependencyRisk ?? 62)) || 62 },
    { value: avg(projects.map((row) => row.analytics?.blockedTasks != null
      ? Math.max(0, 100 - Number(row.analytics.blockedTasks) * 8)
      : 62)) || 62 },
  ], { confidence: evidenceConfidence({ observed: projects.length, expected: 2, breadth: projects.length ? 1 : 0.65 }) });
  const teamRiskIndex = roundScore(100 - adaptiveScore([
    { value: ratio(atRisk, Math.max(1, users.length), 0.2) * 100 },
    { value: 100 - (avgUser || 62) },
    { value: 100 - workloadBalanceIndex },
  ], { confidence: 72 }));
  const teamPerformanceIndex = adaptiveScore([
    { value: avgUser || 62 },
    { value: deliveryReliabilityIndex },
    { value: collaborationIndex },
    { value: executionPredictability },
    { value: workloadBalanceIndex },
    { value: blockerResolutionHealth },
    { value: teamRiskIndex },
  ], {
    confidence: evidenceConfidence({ observed: users.length, expected: 3, breadth: projects.length ? 1 : 0.8 }),
  });

  const indexes = {
    teamPerformanceIndex,
    deliveryReliabilityIndex,
    collaborationIndex,
    executionPredictability,
    workloadBalanceIndex,
    blockerResolutionHealth,
    teamRiskIndex,
  };
  const confidence = evidenceConfidence({ observed: users.length + projects.length, expected: 4, breadth: projects.length ? 1 : 0.8 });
  const score = adaptiveScore(Object.values(indexes).map((value) => ({ value })), { confidence });
  const riskProbability = Math.max(0, 100 - teamRiskIndex + atRisk * 6);

  const strengths = uniqueStrings([
    highPerformers > 0 && `${highPerformers} high performer(s) in team scope`,
    deliveryReliabilityIndex >= 75 && "Team delivery reliability is strong",
    collaborationIndex >= 75 && "Team collaboration signal is healthy",
  ].filter(Boolean));
  const concerns = uniqueStrings([
    atRisk > 0 && `${atRisk} at-risk member(s) require attention`,
    executionPredictability < 55 && "Execution predictability is weak",
    deliveryReliabilityIndex < 55 && "Team delivery reliability is below target",
    workloadBalanceIndex < 55 && "Team workload balance needs manager attention",
    blockerResolutionHealth < 55 && "Blocked work or dependency friction is affecting team flow",
  ].filter(Boolean));

  const output = {
    subjectType: "team",
    workspaceId,
    teamKey,
    managerId,
    score,
    band: bandForScore(score),
    trend: trendFromSeries([executionPredictability, deliveryReliabilityIndex, score]),
    confidence,
    indexes,
    strengths,
    concerns,
    drivers: uniqueStrings([
      `${users.length} member intelligence profile(s) aggregated`,
      `${projects.length} project intelligence profile(s) included`,
    ]),
    indicators: [
      atRisk > 0 && { type: "Team Risk", label: `${atRisk} at-risk team member(s)` },
    ].filter(Boolean),
    risk: {
      probability: roundScore(riskProbability),
      level: riskLevel(riskProbability),
    },
    analytics: {
      memberCount: users.length,
      projectCount: projects.length,
      highPerformers,
      atRisk,
      averageUserScore: roundScore(avgUser),
      averageProjectScore: roundScore(avgProject),
      workloadBalanceIndex,
      blockerResolutionHealth,
    },
    sourceWindow: aggregateSourceWindow([...users, ...projects]),
  };

  return {
    ...output,
    evidenceHash: hashEvidence({ indexes, analytics: output.analytics }),
  };
}

export default evaluateTeamIntelligence;
