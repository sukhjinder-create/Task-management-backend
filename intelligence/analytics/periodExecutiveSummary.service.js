import { createHash } from "crypto";
import pool from "../../db.js";
import { saveExecutiveSummary } from "../../events/executive/executiveSummary.store.js";
import { buildTrendAnalytics } from "./historicalAnalytics.service.js";

export const PERIOD_EXECUTIVE_SUMMARY_VERSION = "enterprise_executive_summary_v5";
const SUMMARY_KIND = "dashboard_period_executive_summary";

function dateKey(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function utcDate(year, monthIndex, day) {
  return new Date(Date.UTC(year, monthIndex, day));
}

function monthKey(date) {
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function round(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 100) / 100 : null;
}

function average(values = []) {
  const nums = values.map(Number).filter(Number.isFinite);
  if (!nums.length) return null;
  return round(nums.reduce((sum, value) => sum + value, 0) / nums.length);
}

function directionLabel(direction) {
  if (direction === "up") return "improving";
  if (direction === "down") return "declining";
  return "stable";
}

function movementVerb(direction) {
  if (direction === "up") return "strengthened";
  if (direction === "down") return "softened";
  return "held steady";
}

function riskMovementLabel(direction) {
  if (direction === "up") return "risk pressure increased";
  if (direction === "down") return "risk pressure eased";
  return "risk pressure stayed broadly stable";
}

function scoreSpan(score = {}) {
  const first = score.first ?? "n/a";
  const last = score.last ?? "n/a";
  const delta = Number(score.delta || 0);
  const sign = delta > 0 ? "+" : "";
  return `${first} -> ${last} (${sign}${delta})`;
}

function compactSentence(parts = []) {
  return parts.filter(Boolean).join(" ");
}

function sentenceList(items = [], fallback = "No dominant pattern is visible yet.", limit = 3) {
  const list = compactList(items, limit);
  if (!list.length) return fallback;
  if (list.length === 1) return list[0];
  if (list.length === 2) return `${list[0]} and ${list[1]}`;
  return `${list.slice(0, -1).join(", ")}, and ${list[list.length - 1]}`;
}

function qualitativeBand(value, { inverse = false } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "not yet conclusive";
  const normalized = inverse ? 100 - number : number;
  if (normalized >= 76) return "strong";
  if (normalized >= 62) return "stable";
  if (normalized >= 48) return "uneven";
  return "under pressure";
}

function trendPhrase(direction) {
  if (direction === "up") return "strengthened";
  if (direction === "down") return "weakened";
  return "remained broadly stable";
}

function riskPhrase(direction) {
  if (direction === "up") return "risk pressure expanded";
  if (direction === "down") return "risk pressure eased";
  return "risk pressure remained broadly stable";
}

function hashJson(value) {
  return createHash("sha256")
    .update(JSON.stringify(value ?? {}))
    .digest("hex");
}

function sanitizeSummaryText(text) {
  return String(text || "")
    .replace(/\bscore(?:d|s)?\b/gi, "posture")
    .replace(/\b\d+(?:\.\d+)?\s*\/\s*100\b/g, "the current band")
    .replace(/\b[+-]?\d+(?:\.\d+)?\s*(?:pt|point|points)\s+movement\b/gi, "material movement")
    .replace(/\bfrom\s+\d+(?:\.\d+)?\s+to\s+\d+(?:\.\d+)?\b/gi, "over the period")
    .replace(/\s+/g, " ")
    .trim();
}

function section(key, title, body, extra = {}) {
  return {
    key,
    title,
    body: sanitizeSummaryText(body),
    ...extra,
  };
}

function recommendation(priority, action, rationale) {
  return {
    priority,
    action: sanitizeSummaryText(action),
    rationale: sanitizeSummaryText(rationale),
  };
}

function topOrFallback(items = [], fallback) {
  return compactList(items, 1)[0] || fallback;
}

function operatingSignal(label, stat) {
  if (!stat || stat.pointCount === 0) {
    return `${label}: insufficient period history`;
  }
  const delta = Number(stat.delta || 0);
  const sign = delta > 0 ? "+" : "";
  return `${label}: avg ${stat.average ?? "n/a"}, ${directionLabel(stat.direction)}, ${sign}${delta} pt movement`;
}

function rangeNarrative(rangeValue) {
  if (rangeValue === "90d") return "quarter-style operating period";
  if (rangeValue === "6m") return "half-year operating horizon";
  if (rangeValue === "1y") return "annual performance window";
  if (rangeValue === "all") return "full-history workspace narrative";
  return "recent monthly operating period";
}

function rangeInterpretation(analysis) {
  const rangeValue = analysis.range?.value || "30d";
  const points = analysis.snapshotPointCount || 0;
  const coverage = compactSentence([
    analysis.coverageStart && `from ${analysis.coverageStart}`,
    analysis.coverageEnd && `through ${analysis.coverageEnd}`,
  ]) || "from the available snapshot window";

  if (rangeValue === "90d") {
    return `Quarter lens: ${points} snapshot point(s) ${coverage} are used as an in-quarter execution read, emphasizing quarter ramp, delivery cadence, and near-term recovery pressure.`;
  }
  if (rangeValue === "6m") {
    return `Half-year lens: ${points} snapshot point(s) ${coverage} are treated as a semester baseline, emphasizing capacity endurance, mid-horizon stability, and repeated operating patterns.`;
  }
  if (rangeValue === "1y") {
    return `Annual lens: ${points} snapshot point(s) ${coverage} represent the current year-to-date evidence, emphasizing strategic durability, seasonal exposure, and sustained governance risk.`;
  }
  if (rangeValue === "all") {
    return `Full-history lens: ${points} snapshot point(s) ${coverage} define the complete retained intelligence record, emphasizing lifetime baseline, archive coverage, and institutional memory.`;
  }
  return `Monthly lens: ${points} snapshot point(s) ${coverage} are used as the recent operating read, emphasizing immediate movement, current blockers, and short-cycle execution focus.`;
}

function compactList(items = [], limit = 4) {
  const seen = new Set();
  const output = [];
  for (const item of items) {
    const label = String(item || "").trim();
    if (!label || seen.has(label.toLowerCase())) continue;
    seen.add(label.toLowerCase());
    output.push(label);
    if (output.length >= limit) break;
  }
  return output;
}

function addFrequency(map, values = []) {
  for (const value of values || []) {
    const label = typeof value === "string"
      ? value
      : value?.label || value?.type || value?.message || "";
    const key = String(label || "").trim();
    if (!key) continue;
    map.set(key, (map.get(key) || 0) + 1);
  }
}

function topFrequency(map, fallback = [], limit = 4) {
  const ranked = [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([label]) => label);
  return compactList([...ranked, ...fallback], limit);
}

function chartStats(visualizations, key) {
  const chart = (visualizations?.charts || []).find((item) => item.key === key);
  const values = (chart?.data || []).map((point) => Number(point.value)).filter(Number.isFinite);
  if (!values.length) {
    return {
      key,
      pointCount: 0,
      average: null,
      first: null,
      last: null,
      delta: 0,
      direction: "stable",
    };
  }
  const first = values[0];
  const last = values[values.length - 1];
  const delta = round(last - first) || 0;
  return {
    key,
    title: chart?.title || key,
    pointCount: values.length,
    average: average(values),
    first: round(first),
    last: round(last),
    delta,
    direction: delta > 3 ? "up" : delta < -3 ? "down" : "stable",
  };
}

export function summaryBucketForRange(rangeMeta = {}, now = new Date()) {
  const value = rangeMeta.value || "30d";
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();

  if (value === "90d") {
    const quarter = Math.floor(month / 3) + 1;
    const start = utcDate(year, (quarter - 1) * 3, 1);
    const end = utcDate(year, quarter * 3, 0);
    return {
      rangeKey: "90D",
      periodKey: `90-${year}Q${quarter}`,
      label: `Q${quarter} ${year}`,
      bucketStart: dateKey(start),
      bucketEnd: dateKey(end),
      bucketType: "calendar_quarter",
      open: now <= end,
    };
  }

  if (value === "6m") {
    const half = month < 6 ? 1 : 2;
    const start = utcDate(year, half === 1 ? 0 : 6, 1);
    const end = utcDate(year, half === 1 ? 6 : 12, 0);
    return {
      rangeKey: "6M",
      periodKey: `6M-${year}H${half}`,
      label: `H${half} ${year}`,
      bucketStart: dateKey(start),
      bucketEnd: dateKey(end),
      bucketType: "calendar_half_year",
      open: now <= end,
    };
  }

  if (value === "1y") {
    const start = utcDate(year, 0, 1);
    const end = utcDate(year, 12, 0);
    return {
      rangeKey: "1Y",
      periodKey: `1Y-${year}`,
      label: `${year}`,
      bucketStart: dateKey(start),
      bucketEnd: dateKey(end),
      bucketType: "calendar_year",
      open: now <= end,
    };
  }

  if (value === "all") {
    return {
      rangeKey: "ALL",
      periodKey: "ALL",
      label: "All available history",
      bucketStart: null,
      bucketEnd: dateKey(now),
      bucketType: "all_history",
      open: false,
    };
  }

  const start = utcDate(year, month, 1);
  const end = utcDate(year, month + 1, 0);
  return {
    rangeKey: "30D",
    periodKey: `30-${monthKey(now)}`,
    label: `${String(month + 1).padStart(2, "0")}/${year}`,
    bucketStart: dateKey(start),
    bucketEnd: dateKey(end),
    bucketType: "calendar_month",
    open: now <= end,
  };
}

function summaryStoragePeriodKey(bucket = {}) {
  const digest = createHash("sha1")
    .update(`${PERIOD_EXECUTIVE_SUMMARY_VERSION}:${bucket.periodKey || "unknown"}`)
    .digest("hex")
    .slice(0, 8)
    .toUpperCase();
  return `V5${digest}`;
}

function summarizeSnapshotEvidence(snapshot = {}, intelligence = {}) {
  const users = snapshot.users || [];
  const projects = snapshot.projects || [];
  const teams = snapshot.teams || [];
  const usersWithAttendance = users.filter((user) => user.attendance?.score != null);
  const projectRisks = projects.filter((project) => String(project.risk?.level || "").toLowerCase() === "high");
  const blockedProjects = projects.filter((project) =>
    (project.concerns || []).some((concern) => /block|depend|risk|delay|overdue/i.test(String(concern)))
  );
  const collaborationSignals = [
    ...users.flatMap((user) => user.dimensions?.collaborationHealth?.drivers || []),
    ...teams.flatMap((team) => team.drivers || []),
  ];

  return {
    users: {
      count: users.length,
      usersWithAttendance: usersWithAttendance.length,
      attendanceReadiness: qualitativeBand(intelligence?.indexes?.attendanceReadinessIndex),
      professionalDiscipline: qualitativeBand(average(users.map((user) => user.dimensions?.professionalDiscipline?.score))),
      collaborationHealth: qualitativeBand(average(users.map((user) => user.dimensions?.collaborationHealth?.score))),
      sustainability: qualitativeBand(average(users.map((user) => user.dimensions?.workSustainability?.score))),
      deliveryEffectiveness: qualitativeBand(average(users.map((user) => user.dimensions?.deliveryEffectiveness?.score))),
      executionReliability: qualitativeBand(average(users.map((user) => user.dimensions?.executionReliability?.score))),
    },
    projects: {
      count: projects.length,
      highRiskCount: projectRisks.length,
      blockedOrDelayedCount: blockedProjects.length,
      deliveryConfidence: qualitativeBand(intelligence?.indexes?.deliveryConfidenceIndex),
      velocityHealth: qualitativeBand(average(projects.map((project) => project.indexes?.velocityHealth))),
      scopeStability: qualitativeBand(average(projects.map((project) => project.indexes?.scopeStability))),
      projectNames: compactList(projects.map((project) => project.projectName), 5),
    },
    teams: {
      count: teams.length,
      collaboration: qualitativeBand(intelligence?.indexes?.organizationalAlignmentIndex),
      predictability: qualitativeBand(average(teams.map((team) => team.indexes?.executionPredictability))),
      workloadBalance: qualitativeBand(average(teams.map((team) => team.indexes?.workloadBalanceIndex))),
    },
    collaborationSignals: compactList(collaborationSignals, 4),
    capacity: {
      sustainability: qualitativeBand(intelligence?.indexes?.capacitySustainabilityIndex),
      executionReality: qualitativeBand(intelligence?.indexes?.executionRealityIndex),
    },
  };
}

function operationalEvidenceSignature({ analysis, snapshot = {}, materialization = null }) {
  const signature = {
    summaryVersion: PERIOD_EXECUTIVE_SUMMARY_VERSION,
    range: analysis.range?.value,
    bucket: analysis.bucket?.periodKey,
    coverageStart: analysis.coverageStart,
    coverageEnd: analysis.coverageEnd,
    snapshotDates: (analysis.snapshotDates || []).slice(-120),
    snapshotPointCount: analysis.snapshotPointCount,
    taskContext: {
      totalTasks: analysis.taskContext.totalTasks,
      completedTasks: analysis.taskContext.completedTasks,
      overdueTasks: analysis.taskContext.overdueTasks,
      topOverdue: (analysis.taskContext.topOverdue || []).map((task) => ({
        id: task.id || null,
        task: task.task,
        projectName: task.projectName,
        overdueDays: task.overdueDays,
        priority: task.priority,
      })),
    },
    sourceWindow: {
      coverageStart: analysis.sourceWindow?.coverageStart || null,
      coverageEnd: analysis.sourceWindow?.coverageEnd || null,
      attendanceClosedThroughDate: analysis.sourceWindow?.attendanceClosedThroughDate || null,
    },
    operationalEvidence: analysis.operationalEvidence || {},
    entityCounts: {
      users: snapshot.users?.length || 0,
      projects: snapshot.projects?.length || 0,
      teams: snapshot.teams?.length || 0,
    },
    projectNames: (snapshot.projects || []).map((project) => project.projectName).sort(),
    materialized: Boolean(materialization?.materialized),
  };
  return hashJson(signature);
}

function analyzePeriod({ trendSeries = [], intelligence = {}, visualizations = {}, rangeMeta = {}, bucket = {}, counts = {}, topOverdue = [], snapshot = {}, materialization = null }) {
  const scores = trendSeries.map((point) => Number(point.score)).filter(Number.isFinite);
  const trend = buildTrendAnalytics(trendSeries);
  const firstScore = scores.length ? scores[0] : Number(intelligence?.score) || null;
  const lastScore = scores.length ? scores[scores.length - 1] : Number(intelligence?.score) || null;
  const diffs = [];
  for (let index = 1; index < scores.length; index += 1) {
    diffs.push(Math.abs(scores[index] - scores[index - 1]));
  }

  const strengthCounts = new Map();
  const concernCounts = new Map();
  const driverCounts = new Map();
  const indicatorCounts = new Map();

  addFrequency(strengthCounts, intelligence?.strengths);
  addFrequency(concernCounts, intelligence?.concerns);
  addFrequency(driverCounts, intelligence?.drivers);
  addFrequency(indicatorCounts, intelligence?.indicators);
  for (const point of trendSeries) {
    addFrequency(strengthCounts, point.payload?.strengths);
    addFrequency(concernCounts, point.payload?.concerns);
    addFrequency(driverCounts, point.payload?.drivers);
    addFrequency(indicatorCounts, point.payload?.indicators);
  }

  const analysis = {
    range: rangeMeta,
    bucket,
    snapshotPointCount: trendSeries.length,
    snapshotDates: trendSeries.map((point) => dateKey(point.date)).filter(Boolean),
    coverageStart: dateKey(trendSeries[0]?.date),
    coverageEnd: dateKey(trendSeries[trendSeries.length - 1]?.date),
    score: {
      first: round(firstScore),
      last: round(lastScore),
      average: average(scores),
      minimum: scores.length ? round(Math.min(...scores)) : null,
      maximum: scores.length ? round(Math.max(...scores)) : null,
      delta: round(trend.delta) || 0,
      direction: trend.direction,
      volatility: average(diffs) || 0,
    },
    chartSignals: {
      workspaceHealth: chartStats(visualizations, "workspace_health_trends"),
      productivity: chartStats(visualizations, "productivity_trends"),
      risk: chartStats(visualizations, "risk_trends"),
    },
    strengths: topFrequency(strengthCounts, intelligence?.strengths, 5),
    concerns: topFrequency(concernCounts, intelligence?.concerns, 5),
    drivers: topFrequency(driverCounts, intelligence?.drivers, 5),
    indicators: topFrequency(indicatorCounts, [], 5),
    currentRisk: intelligence?.risk || {},
    indexes: intelligence?.indexes || {},
    analytics: intelligence?.analytics || {},
    operationalEvidence: summarizeSnapshotEvidence(snapshot, intelligence),
    confidence: intelligence?.confidence ?? null,
    band: intelligence?.band || null,
    sourceWindow: {
      coverageStart: intelligence?.coverageStart || intelligence?.sourceWindow?.startDate || null,
      coverageEnd: intelligence?.coverageEnd || intelligence?.sourceWindow?.endDate || null,
      attendanceClosedThroughDate: intelligence?.attendanceClosedThroughDate || intelligence?.sourceWindow?.attendanceClosedThroughDate || null,
    },
    taskContext: {
      totalTasks: counts?.totalTasks || 0,
      completedTasks: counts?.completedTasks || 0,
      overdueTasks: counts?.overdueTasks || 0,
      topOverdue: (topOverdue || []).slice(0, 3).map((task) => ({
        id: task.id || null,
        task: task.task,
        projectName: task.project_name,
        overdueDays: task.overdue_days,
        priority: task.priority,
      })),
    },
  };

  analysis.operationalEvidenceHash = operationalEvidenceSignature({
    analysis,
    snapshot,
    materialization,
  });

  return analysis;
}

export function assessExecutiveSummaryQuality(summary = {}) {
  const text = [
    summary.headline,
    summary.narrative,
    summary.outlook,
    ...(summary.priorities || []),
    ...(summary.sections || []).map((item) => `${item.title || ""} ${item.body || ""}`),
  ].filter(Boolean).join(" ");
  const words = text.toLowerCase().match(/[a-z0-9]+/g) || [];
  const uniqueWords = new Set(words);
  const evidenceTerms = [
    "period",
    "trend",
    "risk",
    "productivity",
    "health",
    "concern",
    "driver",
    "outlook",
    "snapshot",
    "confidence",
    "delivery",
    "workspace",
    "attendance",
    "execution",
    "collaboration",
    "capacity",
    "sustainability",
    "leadership",
  ];
  const scoreCentricPattern = /\b(score|scored|scores|\/100|points?\s+movement|increased\s+from\s+\d|decreased\s+from\s+\d)\b/i;
  const requiredSectionKeys = [
    "executiveOverview",
    "operationalStrengths",
    "operationalRisks",
    "trendNarrative",
    "attendanceWorkforceReadiness",
    "deliveryExecution",
    "collaborationOrganizationalHealth",
    "capacitySustainability",
    "leadershipRecommendations",
    "outlook",
  ];
  const sectionKeys = new Set((summary.sections || []).map((item) => item.key));
  const checks = {
    hasSubstance: words.length >= 170,
    conciseEnough: words.length <= 900,
    referencesPeriod: /30d|90d|6m|1y|all|period|quarter|half-year|annual|history/i.test(text),
    referencesEvidence: evidenceTerms.filter((term) => text.toLowerCase().includes(term)).length >= 8,
    hasPriorities: Array.isArray(summary.priorities) && summary.priorities.length > 0,
    lowRepetition: words.length === 0 ? false : uniqueWords.size / words.length >= 0.42,
    hasOutlook: Boolean(summary.outlook && String(summary.outlook).length >= 80),
    hasRequiredSections: requiredSectionKeys.every((key) => sectionKeys.has(key)),
    avoidsScoreCentricLanguage: !scoreCentricPattern.test(text),
  };
  return {
    passed: Object.values(checks).every(Boolean),
    checks,
    wordCount: words.length,
    uniquenessRatio: words.length === 0 ? 0 : Math.round((uniqueWords.size / words.length) * 100) / 100,
    summaryVersion: PERIOD_EXECUTIVE_SUMMARY_VERSION,
  };
}

function buildRecommendations(analysis) {
  const recommendations = [];
  const topConcern = topOrFallback(analysis.concerns, "execution variability");
  const topDriver = topOrFallback(analysis.drivers, "the selected period's operating evidence");

  if ((analysis.taskContext.overdueTasks || 0) > 0 || /declining|down/i.test(analysis.score.direction)) {
    recommendations.push(recommendation(
      "High Priority",
      "Stabilize delivery commitments and clear the work most exposed to deadline slippage.",
      `This is driven by ${topConcern} and should be handled before it becomes a planning drag.`
    ));
  }

  if ((analysis.operationalEvidence?.projects?.highRiskCount || 0) > 0 || /risk|blocker|delay|overdue/i.test(topConcern)) {
    recommendations.push(recommendation(
      "High Priority",
      "Run a manager-level risk review focused on ownership, blockers, and recovery actions.",
      "The period evidence shows enough delivery or portfolio risk concentration to justify active leadership review."
    ));
  }

  recommendations.push(recommendation(
    recommendations.length ? "Medium Priority" : "High Priority",
    "Reinforce the strongest operating behaviour visible in the period.",
    `${sentenceList(analysis.strengths, "The positive evidence is distributed rather than concentrated", 2)} should be made repeatable across projects.`
  ));

  recommendations.push(recommendation(
    "Medium Priority",
    "Improve collaboration hygiene where participation or review signals are uneven.",
    "Execution confidence improves when comments, reviews, stakeholder follow-up, and cross-team visibility stay current."
  ));

  recommendations.push(recommendation(
    "Monitor",
    "Keep watching capacity sustainability and attendance readiness as leading indicators.",
    `${topDriver} should be reviewed alongside workload balance before new commitments are added.`
  ));

  return recommendations.slice(0, 5);
}

function buildNarrative({ scopeLabel, analysis, forecast, materialization }) {
  const periodName = rangeNarrative(analysis.range?.value);
  const direction = directionLabel(analysis.score.direction);
  const pointCount = analysis.snapshotPointCount;
  const productivity = analysis.chartSignals.productivity;
  const risk = analysis.chartSignals.risk;
  const health = analysis.chartSignals.workspaceHealth;
  const topConcern = topOrFallback(analysis.concerns, "no single recurring concern dominated the period");
  const topStrength = topOrFallback(analysis.strengths, "no single recurring strength dominated the period");
  const topDriver = topOrFallback(analysis.drivers, "combined execution, delivery, collaboration, and risk evidence shaped the period");
  const recommendations = buildRecommendations(analysis);
  const evidence = analysis.operationalEvidence || {};
  const dataDepth = pointCount >= 3
    ? `${pointCount} historical intelligence points`
    : pointCount === 2
      ? "2 historical intelligence points"
      : "the current intelligence point plus live repository context";
  const materializationNote = materialization?.materialized
    ? `Historical materialization expanded this view from ${materialization.beforePointCount || 0} to ${materialization.afterPointCount || pointCount} point(s).`
    : null;

  const taskPressure = (analysis.taskContext.overdueTasks || 0) > 0
    ? "Overdue work remains the clearest execution pressure in the selected scope."
    : "No concentrated overdue-work pressure is visible in this period.";
  const riskSentence = risk.pointCount > 0
    ? `${riskPhrase(risk.direction)} across the retained history.`
    : "Current risk context is based on retained repository signals rather than a raw numeric label.";
  const periodLabel = `${analysis.range.label} ${analysis.bucket.label}`;
  const trendNarrative = compactSentence([
    `Across ${dataDepth}, the operating trajectory ${trendPhrase(analysis.score.direction)} during the ${periodName}.`,
    health.pointCount > 0 && `Workspace health signals ${trendPhrase(health.direction)} while productivity ${trendPhrase(productivity.direction)}.`,
    riskSentence,
    materializationNote,
  ]);
  const attendanceBody = compactSentence([
    `Attendance and workforce readiness appear ${evidence.users?.attendanceReadiness || "not yet conclusive"} for this period.`,
    `Professional discipline is ${evidence.users?.professionalDiscipline || "not yet conclusive"}, supported by the attendance closeout through ${analysis.sourceWindow.attendanceClosedThroughDate || "the latest closed attendance day"}.`,
    "Non-working-day attendance remains a recognition signal only when paired with meaningful delivery, while repeated overtime remains a sustainability concern rather than an automatic performance lift.",
  ]);
  const deliveryBody = compactSentence([
    `Delivery and execution are ${evidence.projects?.deliveryConfidence || "not yet conclusive"} overall, with execution reliability reading as ${evidence.users?.executionReliability || "not yet conclusive"}.`,
    taskPressure,
    `Project momentum is shaped by ${sentenceList(analysis.drivers, "the available project and task evidence", 2)}.`,
  ]);
  const collaborationBody = compactSentence([
    `Collaboration and organizational health are ${evidence.teams?.collaboration || evidence.users?.collaborationHealth || "not yet conclusive"}.`,
    evidence.collaborationSignals?.length
      ? `The clearest collaboration signals are ${sentenceList(evidence.collaborationSignals, "", 3)}.`
      : "Review participation, communication hygiene, and stakeholder follow-up should remain part of manager review.",
  ]);
  const capacityBody = compactSentence([
    `Capacity sustainability is ${evidence.capacity?.sustainability || "not yet conclusive"}, with workload balance ${evidence.teams?.workloadBalance || "not yet conclusive"}.`,
    "The leadership read should watch for focus fragmentation, repeated overtime, and declining delivery despite longer hours.",
  ]);
  const outlook = compactSentence([
    `Outlook: current operational patterns suggest the workspace will remain ${direction} if the strongest behaviours are repeated and ${topConcern} receives active follow-up.`,
    forecast?.confidence === "low"
      ? "The outlook should be treated as directional because retained historical evidence is still thin for the selected period."
      : "The outlook is grounded in retained intelligence history and current repository evidence.",
  ]);
  const overview = compactSentence([
    `During the ${periodName} (${periodLabel}), ${scopeLabel.toLowerCase()} showed a ${direction} operating posture.`,
    `The strongest observed behaviour was ${topStrength}.`,
    `The main leadership concern was ${topConcern}.`,
    `The business read is driven by ${topDriver}.`,
  ]);

  const sections = [
    section("executiveOverview", "Executive Overview", overview),
    section("operationalStrengths", "Operational Strengths", `The strongest operating behaviours were ${sentenceList(analysis.strengths, "distributed across execution, delivery, and readiness signals", 4)}.`),
    section("operationalRisks", "Operational Risks", `The primary risks were ${sentenceList(analysis.concerns, "not concentrated in a single operating area", 4)}. ${riskSentence}`),
    section("trendNarrative", "Trend Narrative", trendNarrative),
    section("attendanceWorkforceReadiness", "Attendance & Workforce Readiness", attendanceBody),
    section("deliveryExecution", "Delivery & Execution", deliveryBody),
    section("collaborationOrganizationalHealth", "Collaboration & Organizational Health", collaborationBody),
    section("capacitySustainability", "Capacity & Sustainability", capacityBody),
    section(
      "leadershipRecommendations",
      "Leadership Recommendations",
      recommendations.map((item) => `${item.priority}: ${item.action} ${item.rationale}`).join(" "),
      { recommendations }
    ),
    section("outlook", "Outlook", outlook),
  ];
  const fullSummary = sections
    .map((item) => `${item.title}\n${item.body}`)
    .join("\n\n");
  const narrative = sections[0].body;

  return {
    headline: `${scopeLabel} ${analysis.range.label}: ${direction} executive operating brief`,
    narrative,
    sections,
    fullSummary,
    outlook,
    strengths: analysis.strengths,
    risks: analysis.concerns,
    concerns: analysis.concerns,
    priorities: recommendations.map((item) => `${item.priority}: ${item.action}`),
    recommendations,
    drivers: analysis.drivers,
    indicators: analysis.indicators,
    period: analysis.range,
    summaryBucket: analysis.bucket,
    operationalEvidenceHash: analysis.operationalEvidenceHash,
    regenerationPolicy: {
      summaryVersion: PERIOD_EXECUTIVE_SUMMARY_VERSION,
      regenerationTrigger: "material_operational_evidence_change",
      scoreWeightageChangesInvalidateSummary: false,
      evidenceSignature: analysis.operationalEvidenceHash,
    },
    metrics: {
      direction: directionLabel(analysis.score.direction),
      snapshotCount: analysis.snapshotPointCount,
      coverageStart: analysis.coverageStart,
      coverageEnd: analysis.coverageEnd,
      scopedTasks: analysis.taskContext.totalTasks,
      completedTasks: analysis.taskContext.completedTasks,
      overdueTasks: analysis.taskContext.overdueTasks,
      operationalState: direction,
      attendanceReadiness: evidence.users?.attendanceReadiness || null,
      deliveryConfidence: evidence.projects?.deliveryConfidence || null,
      collaborationHealth: evidence.teams?.collaboration || evidence.users?.collaborationHealth || null,
      capacitySustainability: evidence.capacity?.sustainability || null,
    },
  };
}

async function loadSavedSummary({ workspaceId, periodKey }) {
  const { rows } = await pool.query(
    `SELECT id, workspace_id, period, summary, source_data, created_at, status
     FROM workspace_executive_summaries
     WHERE workspace_id = $1
       AND period = $2
     LIMIT 1`,
    [workspaceId, periodKey]
  );
  return rows[0] || null;
}

function shouldReuseSavedSummary(row, analysis, rangeMeta, bucket) {
  if (!row?.summary || row.summary === "GENERATING") return false;
  const source = row.source_data || {};
  if (source.summaryKind !== SUMMARY_KIND) return false;
  if (source.summaryVersion !== PERIOD_EXECUTIVE_SUMMARY_VERSION) return false;
  if (source.dashboardRange?.value !== rangeMeta.value) return false;
  if (source.bucket?.periodKey !== bucket.periodKey) return false;

  const savedCount = Number(source.analysis?.snapshotPointCount || source.payload?.metrics?.snapshotCount || 0);
  if (savedCount < 2 && analysis.snapshotPointCount > savedCount) return false;
  if (source.operationalEvidenceHash && source.operationalEvidenceHash !== analysis.operationalEvidenceHash) {
    return false;
  }
  if (source.payload?.operationalEvidenceHash && source.payload.operationalEvidenceHash !== analysis.operationalEvidenceHash) {
    return false;
  }

  return true;
}

function hydrateSavedSummary(row) {
  const source = row.source_data || {};
  const payload = source.payload || {};
  return {
    ...payload,
    text: row.summary,
    persisted: true,
    reused: true,
    summaryId: row.id,
    persistence: {
      summaryId: row.id,
      periodKey: source.bucket?.periodKey || row.period,
      storagePeriodKey: row.period,
      reused: true,
      generatedAt: row.created_at,
      summaryVersion: source.summaryVersion,
      operationalEvidenceHash: source.operationalEvidenceHash || payload.operationalEvidenceHash || null,
      regenerationPolicy: payload.regenerationPolicy || source.regenerationPolicy || null,
    },
  };
}

export async function getOrCreateWorkspacePeriodExecutiveSummary({
  workspaceId,
  scopeLabel = "Workspace",
  rangeMeta,
  intelligence,
  counts,
  topOverdue,
  trendSeries,
  visualizations,
  forecast,
  materialization = null,
  snapshot = {},
}) {
  const bucket = summaryBucketForRange(rangeMeta);
  const storagePeriodKey = summaryStoragePeriodKey(bucket);
  const analysis = analyzePeriod({
    trendSeries,
    intelligence,
    visualizations,
    rangeMeta,
    bucket,
    counts,
    topOverdue,
    snapshot,
    materialization,
  });
  const existing = await loadSavedSummary({ workspaceId, periodKey: storagePeriodKey });
  if (shouldReuseSavedSummary(existing, analysis, rangeMeta, bucket)) {
    return hydrateSavedSummary(existing);
  }

  const builtPayload = buildNarrative({
    scopeLabel,
    analysis,
    forecast,
    materialization,
  });
  const payload = {
    ...builtPayload,
    quality: assessExecutiveSummaryQuality(builtPayload),
  };
  const summaryText = [
    payload.fullSummary,
  ].filter(Boolean).join("\n\n");

  const saved = await saveExecutiveSummary({
    workspaceId,
    period: storagePeriodKey,
    summary: summaryText,
    sourceData: {
      summaryKind: SUMMARY_KIND,
      summaryVersion: PERIOD_EXECUTIVE_SUMMARY_VERSION,
      dashboardRange: rangeMeta,
      bucket,
      storagePeriodKey,
      analysis,
      materialization,
      payload,
      operationalEvidenceHash: analysis.operationalEvidenceHash,
      regenerationPolicy: payload.regenerationPolicy,
    },
  });

  return {
    ...payload,
    text: summaryText,
    persisted: true,
    reused: false,
    summaryId: saved?.id || null,
    persistence: {
      summaryId: saved?.id || null,
      periodKey: bucket.periodKey,
      storagePeriodKey,
      reused: false,
      generatedAt: saved?.created_at || null,
      summaryVersion: PERIOD_EXECUTIVE_SUMMARY_VERSION,
      operationalEvidenceHash: analysis.operationalEvidenceHash,
      regenerationPolicy: payload.regenerationPolicy,
    },
  };
}

export default {
  PERIOD_EXECUTIVE_SUMMARY_VERSION,
  summaryBucketForRange,
  getOrCreateWorkspacePeriodExecutiveSummary,
};
