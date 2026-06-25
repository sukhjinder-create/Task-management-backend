import {
  adaptiveScore,
  bandForScore,
  bounded,
  clamp,
  domainSummary,
  evidenceConfidence,
  hashEvidence,
  inverseRatio,
  ratio,
  riskLevel,
  roundScore,
  trendFromSeries,
  uniqueStrings,
} from "../engine/scorePrimitives.js";
import { evaluateAttendance } from "./attendanceEvaluator.js";
import {
  appliedScoreModel,
  getScoringGroupWeights,
  scoreWithScoringConfig,
} from "../config/scoringConfig.model.js";

function isCompleted(task) {
  const status = String(task?.status || "").toLowerCase();
  return ["completed", "done", "closed"].includes(status);
}

function isOpen(task) {
  const status = String(task?.status || "").toLowerCase();
  return !["completed", "done", "closed", "cancelled"].includes(status);
}

function avg(values = []) {
  const nums = values.map(Number).filter(Number.isFinite);
  if (!nums.length) return 0;
  return nums.reduce((total, value) => total + value, 0) / nums.length;
}

function dayDiff(start, end) {
  const a = new Date(start);
  const b = new Date(end);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
  return Math.max(0, (b.getTime() - a.getTime()) / 86400000);
}

function buildTaskMetrics(evidence) {
  const tasks = evidence.tasks.filter((task) => String(task.assigned_to || "") === String(evidence.userId));
  const priorTasks = (evidence.priorTasks || []).filter((task) => String(task.assigned_to || "") === String(evidence.userId));
  const completed = tasks.filter(isCompleted);
  const open = tasks.filter(isOpen);
  const withDue = tasks.filter((task) => task.due_date);
  const onTime = completed.filter((task) =>
    task.due_date && task.completed_at && new Date(task.completed_at) <= new Date(task.due_date)
  );
  const overdueOpen = open.filter((task) => task.due_date && new Date(task.due_date) < evidence.range.end);
  const carryOver = open.filter((task) => new Date(task.created_at) < evidence.range.start);
  const storyPoints = completed.reduce((total, task) => total + (Number(task.story_points) || 0), 0);
  const priorCompleted = priorTasks.filter(isCompleted);
  const completionDurations = completed
    .map((task) => dayDiff(task.created_at, task.completed_at))
    .filter((value) => value != null);
  const estimatedCompleted = completed.filter((task) => Number(task.estimation_hours) > 0);
  const actualHoursByTask = new Map();
  for (const log of evidence.timeLogs) {
    actualHoursByTask.set(log.task_id, (actualHoursByTask.get(log.task_id) || 0) + (Number(log.hours) || 0));
  }
  const estimationScores = estimatedCompleted.map((task) => {
    const actual = actualHoursByTask.get(task.id) || 0;
    const estimated = Number(task.estimation_hours) || 0;
    if (actual <= 0 || estimated <= 0) return null;
    const deviation = Math.abs(actual - estimated) / Math.max(actual, estimated);
    return clamp((1 - deviation) * 100);
  }).filter((value) => value != null);

  const blocked = evidence.taskLinks.filter((link) => link.link_type === "is_blocked_by" || link.link_type === "blocks");
  const resolvedBlocked = blocked.filter((link) => isCompleted(link));

  return {
    tasks,
    total: tasks.length,
    completed: completed.length,
    open: open.length,
    withDue: withDue.length,
    onTime: onTime.length,
    overdueOpen: overdueOpen.length,
    carryOver: carryOver.length,
    storyPoints,
    priorCompleted: priorCompleted.length,
    completionDurations,
    avgCompletionDays: avg(completionDurations),
    estimationQuality: avg(estimationScores) || (estimatedCompleted.length ? 45 : 64),
    blocked: blocked.length,
    resolvedBlocked: resolvedBlocked.length,
    activeInProgress: open.filter((task) => ["in-progress", "in_progress"].includes(String(task.status || "").toLowerCase())).length,
    bugRatio: ratio(tasks.filter((task) => String(task.task_type || "").toLowerCase() === "bug").length, tasks.length, 0),
  };
}

function evaluateExecutionReliability(task) {
  const commitmentCompletion = ratio(task.completed, task.total, task.total ? 0 : 0.62) * 100;
  const dueDateDiscipline = task.withDue > 0
    ? ratio(task.onTime, task.withDue, 0.55) * 100
    : 66;
  const carryOverControl = inverseRatio(task.carryOver, Math.max(1, task.open), 0.64) * 100;
  const ownershipConsistency = bounded(task.overdueOpen, 0, Math.max(2, task.total * 0.35)) * 100;
  const blockerResponsiveness = task.blocked > 0
    ? ratio(task.resolvedBlocked, task.blocked, 0.5) * 100
    : 72;

  const confidence = evidenceConfidence({
    observed: task.total + task.blocked,
    expected: Math.max(4, task.total),
    breadth: task.withDue > 0 ? 1 : 0.75,
  });
  const score = adaptiveScore([
    { value: commitmentCompletion },
    { value: dueDateDiscipline },
    { value: carryOverControl },
    { value: ownershipConsistency },
    { value: blockerResponsiveness },
  ], { confidence });

  return domainSummary({
    name: "Execution Reliability",
    score,
    confidence,
    strengths: [
      commitmentCompletion >= 76 && "Commitments are being completed reliably",
      dueDateDiscipline >= 76 && "Due-date discipline is strong",
      blockerResponsiveness >= 76 && "Blockers are being resolved quickly",
    ].filter(Boolean),
    concerns: [
      commitmentCompletion < 55 && "Commitment completion is below expected reliability",
      dueDateDiscipline < 55 && "Deadline discipline needs attention",
      carryOverControl < 55 && "Carry-over work is accumulating",
      task.overdueOpen > 0 && `${task.overdueOpen} open task(s) are overdue`,
    ].filter(Boolean),
    drivers: [
      `${task.completed}/${task.total} assigned task(s) completed in the active evidence window`,
      `${task.onTime}/${task.withDue} due-date tracked task(s) delivered on time`,
    ],
    metrics: {
      commitmentCompletion,
      dueDateDiscipline,
      carryOverControl,
      ownershipConsistency,
      blockerResponsiveness,
    },
  });
}

function evaluateDeliveryEffectiveness(task) {
  const throughput = bounded(task.completed, Math.max(1, task.priorCompleted), 0) * 100;
  const velocity = bounded(task.avgCompletionDays, 5, 21) * 100;
  const estimationQuality = task.estimationQuality;
  const completionQuality = bounded(task.bugRatio, 0.12, 0.55) * 100;
  const outputConsistency = bounded(Math.abs(task.completed - task.priorCompleted), 1, Math.max(4, task.completed + task.priorCompleted)) * 100;
  const confidence = evidenceConfidence({
    observed: task.completed + task.priorCompleted,
    expected: Math.max(4, task.total),
    breadth: task.completionDurations.length > 0 ? 1 : 0.65,
  });
  const score = adaptiveScore([
    { value: throughput },
    { value: velocity },
    { value: estimationQuality },
    { value: completionQuality },
    { value: outputConsistency },
  ], { confidence });

  return domainSummary({
    name: "Delivery Effectiveness",
    score,
    confidence,
    strengths: [
      throughput >= 76 && "Throughput is improving against the previous window",
      velocity >= 76 && "Completed work is moving at a healthy pace",
      estimationQuality >= 76 && "Estimated effort aligns with logged effort",
    ].filter(Boolean),
    concerns: [
      throughput < 55 && "Throughput is below recent baseline",
      velocity < 55 && "Average completion time is slowing delivery",
      estimationQuality < 55 && "Estimation quality is weak or under-instrumented",
    ].filter(Boolean),
    drivers: [
      `${task.completed} completion(s), ${task.storyPoints} story point(s), ${Math.round(task.avgCompletionDays * 10) / 10} avg completion day(s)`,
    ],
    metrics: {
      throughput,
      velocity,
      estimationQuality,
      completionQuality,
      outputConsistency,
    },
  });
}

function evaluateCollaborationHealth(evidence, task) {
  const participation = bounded(evidence.comments.length + evidence.watchers.length, Math.max(2, task.total * 0.4), 0) * 100;
  const reviewCompletion = evidence.reviews.length === 0
    ? 68
    : ratio(evidence.reviews.filter((review) => review.status === "submitted").length, evidence.reviews.length, 0.5) * 100;
  const stakeholderEngagement = bounded(new Set([
    ...evidence.comments.map((row) => row.project_id),
    ...evidence.watchers.map((row) => row.project_id),
  ].filter(Boolean)).size, 2, 0) * 100;
  const crossTeam = bounded(new Set(evidence.comments.map((row) => row.assigned_to).filter(Boolean)).size, 2, 0) * 100;
  const confidence = evidenceConfidence({
    observed: evidence.comments.length + evidence.watchers.length + evidence.reviews.length,
    expected: Math.max(3, task.total),
    breadth: evidence.reviews.length > 0 ? 1 : 0.75,
  });
  const score = adaptiveScore([
    { value: participation },
    { value: reviewCompletion },
    { value: stakeholderEngagement },
    { value: crossTeam },
  ], { confidence });

  return domainSummary({
    name: "Collaboration Health",
    score,
    confidence,
    strengths: [
      participation >= 76 && "Collaboration activity is visible in task discussions",
      reviewCompletion >= 76 && "Review participation is complete",
      stakeholderEngagement >= 76 && "Stakeholder engagement spans multiple work streams",
    ].filter(Boolean),
    concerns: [
      participation < 50 && "Limited collaboration signal in comments or watched work",
      reviewCompletion < 60 && "Review participation requires follow-through",
    ].filter(Boolean),
    drivers: [
      `${evidence.comments.length} comment(s), ${evidence.watchers.length} watched task signal(s), ${evidence.reviews.length} review record(s)`,
    ],
    metrics: {
      participation,
      reviewCompletion,
      stakeholderEngagement,
      crossTeam,
    },
  });
}

function evaluateWorkSustainability(evidence, task, attendance) {
  const workloadBalance = bounded(task.open, Math.max(4, task.completed + 2), Math.max(10, task.completed + 10)) * 100;
  const carryOverHealth = inverseRatio(task.carryOver, Math.max(1, task.open), 0.6) * 100;
  const focusFragmentation = bounded(task.activeInProgress, 2, 8) * 100;
  const overtimeRisk = attendance.concerns.some((concern) => /non-working|long work hours|Longer hours/i.test(concern))
    ? 35
    : 76;
  const productivityUnderLoad = task.overdueOpen > 0 && task.open > task.completed + 3 ? 42 : 72;
  const confidence = evidenceConfidence({
    observed: task.total + evidence.attendance.length,
    expected: Math.max(6, task.total),
    breadth: evidence.attendance.length > 0 ? 1 : 0.65,
  });
  const score = adaptiveScore([
    { value: workloadBalance },
    { value: carryOverHealth },
    { value: focusFragmentation },
    { value: overtimeRisk },
    { value: productivityUnderLoad },
  ], { confidence });

  return domainSummary({
    name: "Work Sustainability",
    score,
    confidence,
    strengths: [
      workloadBalance >= 76 && "Workload is staying within a manageable range",
      focusFragmentation >= 76 && "Concurrent work-in-progress is controlled",
    ].filter(Boolean),
    concerns: [
      workloadBalance < 55 && "Open workload is becoming unbalanced",
      focusFragmentation < 55 && "Too many concurrent in-progress items may fragment focus",
      overtimeRisk < 55 && "Burnout indicators require manager visibility",
    ].filter(Boolean),
    drivers: [
      `${task.open} open task(s), ${task.activeInProgress} in-progress task(s), ${task.carryOver} carry-over item(s)`,
    ],
    metrics: {
      workloadBalance,
      carryOverHealth,
      focusFragmentation,
      overtimeRisk,
      productivityUnderLoad,
    },
  });
}

function evaluateProfessionalDiscipline(evidence, attendance) {
  const reviewCompletion = evidence.reviews.length === 0
    ? 66
    : ratio(evidence.reviews.filter((review) => review.status === "submitted").length, evidence.reviews.length, 0.5) * 100;
  const updateHygiene = bounded(evidence.activity.length + evidence.comments.length, 4, 0) * 100;
  const workflowCompliance = evidence.activity.filter((row) =>
    ["STATUS_CHANGED", "PRIORITY_CHANGED", "DESCRIPTION_UPDATED"].includes(row.action_type)
  ).length;
  const workflowScore = bounded(workflowCompliance, 2, 0) * 100;
  const confidence = evidenceConfidence({
    observed: evidence.activity.length + evidence.reviews.length + evidence.attendance.length,
    expected: 8,
    breadth: 1,
  });
  const score = adaptiveScore([
    { value: attendance.score },
    { value: reviewCompletion },
    { value: updateHygiene },
    { value: workflowScore },
  ], { confidence });

  return domainSummary({
    name: "Professional Discipline",
    score,
    confidence,
    strengths: [
      attendance.score >= 76 && "Attendance discipline supports operational readiness",
      reviewCompletion >= 76 && "Review obligations are being completed",
      updateHygiene >= 76 && "Work updates are visible and timely",
    ].filter(Boolean),
    concerns: [
      attendance.score < 55 && "Attendance discipline is reducing operating confidence",
      reviewCompletion < 60 && "Review completion is incomplete",
      updateHygiene < 45 && "Task update hygiene is under-instrumented",
    ].filter(Boolean),
    drivers: [
      `Attendance confidence ${attendance.confidence}/100, ${evidence.activity.length} activity log signal(s)`,
    ],
    metrics: {
      attendanceScore: attendance.score,
      reviewCompletion,
      updateHygiene,
      workflowScore,
    },
  });
}

export function evaluateUserIntelligence(evidence, options = {}) {
  const scoringConfig = options.scoringConfig || null;
  const attendance = evaluateAttendance(evidence);
  const task = buildTaskMetrics(evidence);

  const domains = {
    executionReliability: evaluateExecutionReliability(task),
    deliveryEffectiveness: evaluateDeliveryEffectiveness(task),
    collaborationHealth: evaluateCollaborationHealth(evidence, task),
    workSustainability: evaluateWorkSustainability(evidence, task, attendance),
    professionalDiscipline: evaluateProfessionalDiscipline(evidence, attendance),
  };

  const primaryDomains = [
    { key: "executionReliability", value: domains.executionReliability.score },
    { key: "deliveryEffectiveness", value: domains.deliveryEffectiveness.score },
    { key: "collaborationHealth", value: domains.collaborationHealth.score },
    { key: "workSustainability", value: domains.workSustainability.score },
  ];
  const professional = domains.professionalDiscipline.score;
  const scoreModel = appliedScoreModel(scoringConfig, ["userFinalBalance", "userCoreDomains"]);
  const finalWeights = getScoringGroupWeights(scoringConfig, "userFinalBalance");
  const coreScore = scoreWithScoringConfig(primaryDomains, scoringConfig, "userCoreDomains", {
    confidence: avg(Object.values(domains).map((domain) => domain.confidence)),
  });

  const attendanceDrag = attendance.score < 45 && coreScore > 70 ? Math.min(8, (45 - attendance.score) / 2) : 0;
  const attendanceLift = attendance.score > 82 && coreScore < 62 ? 2 : 0;
  const score = roundScore(
    (coreScore * (finalWeights.core ?? 0.82)) +
    (professional * (finalWeights.professionalDiscipline ?? 0.18)) -
    attendanceDrag +
    attendanceLift
  );
  const confidence = roundScore(avg(Object.values(domains).map((domain) => domain.confidence)));
  const trend = trendFromSeries([
    task.priorCompleted ? bounded(task.priorCompleted, task.completed || 1, 0) * 100 : score,
    score,
  ]);

  const strengths = uniqueStrings([
    ...Object.values(domains).flatMap((domain) => domain.strengths || []),
    ...attendance.strengths,
  ]).slice(0, 8);
  const concerns = uniqueStrings([
    ...Object.values(domains).flatMap((domain) => domain.concerns || []),
    ...attendance.concerns,
  ]).slice(0, 8);
  const drivers = uniqueStrings([
    ...Object.values(domains).flatMap((domain) => domain.drivers || []),
  ]).slice(0, 10);

  const riskProbability = clamp(
    (100 - score) * 0.55 +
    Math.max(0, task.overdueOpen * 8) +
    Math.max(0, task.carryOver * 3) +
    (confidence < 50 ? 8 : 0)
  );

  const indicators = [
    ...(attendance.indicators || []),
    riskProbability >= 70 && { type: "Performance Risk", label: "High underperformance risk" },
    domains.workSustainability.metrics.overtimeRisk < 55 && { type: "Burnout Risk", label: "Burnout protection signal active" },
  ].filter(Boolean);

  const output = {
    subjectType: "user",
    workspaceId: evidence.workspaceId,
    userId: evidence.userId,
    score,
    band: bandForScore(score),
    trend,
    confidence,
    dimensions: domains,
    attendance,
    strengths,
    concerns,
    drivers,
    indicators,
    risk: {
      probability: roundScore(riskProbability),
      level: riskLevel(riskProbability),
    },
    analytics: {
      assignedWork: task.total,
      completedWork: task.completed,
      openWork: task.open,
      overdueWork: task.overdueOpen,
      carryOverWork: task.carryOver,
      completionTrend: trend,
      deliveryTrend: domains.deliveryEffectiveness.band,
      workloadTrend: domains.workSustainability.band,
      scoreModel,
    },
    scoreModel,
    sourceWindow: {
      startDate: evidence.range.startDate,
      endDate: evidence.range.endDate,
      windowDays: evidence.range.windowDays,
      attendanceClosedThroughDate: evidence.attendanceClosedThroughDate || null,
      attendanceCoverageStart: evidence.attendanceCoverage?.startDate || null,
      attendanceCoverageEnd: evidence.attendanceCoverage?.endDate || null,
    },
  };

  return {
    ...output,
    evidenceHash: hashEvidence({
      task,
      domains,
      attendance,
      scoreModel,
      sourceWindow: output.sourceWindow,
    }),
  };
}

export default evaluateUserIntelligence;
