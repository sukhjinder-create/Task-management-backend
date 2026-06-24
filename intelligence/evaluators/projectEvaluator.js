import {
  adaptiveScore,
  bandForScore,
  bounded,
  evidenceConfidence,
  hashEvidence,
  inverseRatio,
  ratio,
  riskLevel,
  roundScore,
  trendFromSeries,
  uniqueStrings,
} from "../engine/scorePrimitives.js";

function isCompleted(task) {
  return ["completed", "done", "closed"].includes(String(task?.status || "").toLowerCase());
}

function isOpen(task) {
  return !["completed", "done", "closed", "cancelled"].includes(String(task?.status || "").toLowerCase());
}

function avg(values = []) {
  const nums = values.map(Number).filter(Number.isFinite);
  if (!nums.length) return 0;
  return nums.reduce((total, value) => total + value, 0) / nums.length;
}

function completionDays(task) {
  if (!task?.completed_at) return null;
  const start = new Date(task.created_at);
  const end = new Date(task.completed_at);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  return Math.max(0, (end - start) / 86400000);
}

export function evaluateProjectIntelligence(evidence) {
  const tasks = evidence.tasks || [];
  const total = tasks.length;
  const completed = tasks.filter(isCompleted);
  const open = tasks.filter(isOpen);
  const overdue = open.filter((task) => task.due_date && new Date(task.due_date) < evidence.range.end);
  const blocked = open.filter((task) => task.is_blocked);
  const due = tasks.filter((task) => task.due_date);
  const onTime = completed.filter((task) =>
    task.due_date && task.completed_at && new Date(task.completed_at) <= new Date(task.due_date)
  );
  const totalPoints = tasks.reduce((sum, task) => sum + (Number(task.story_points) || 0), 0);
  const completedPoints = completed.reduce((sum, task) => sum + (Number(task.story_points) || 0), 0);
  const avgCompletionDays = avg(completed.map(completionDays).filter((value) => value != null));
  const scopeGrowth = tasks.filter((task) => new Date(task.created_at) >= evidence.range.start).length;
  const sprintCompleted = (evidence.sprints || []).filter((sprint) => sprint.status === "completed").length;
  const sprintTotal = (evidence.sprints || []).length;
  const assignedUsers = new Set(tasks.map((task) => task.assigned_to).filter(Boolean));
  const recentCompletions = completed.filter((task) =>
    task.completed_at && new Date(task.completed_at) >= evidence.range.start
  ).length;

  const deliveryHealth = adaptiveScore([
    { value: ratio(completed.length, total, total ? 0 : 0.62) * 100 },
    { value: due.length ? ratio(onTime.length, due.length, 0.5) * 100 : 68 },
    { value: inverseRatio(overdue.length, Math.max(1, total), 0.65) * 100 },
  ], {
    confidence: evidenceConfidence({ observed: total, expected: 8, breadth: due.length ? 1 : 0.75 }),
  });

  const velocityHealth = adaptiveScore([
    { value: totalPoints > 0 ? ratio(completedPoints, totalPoints, 0.5) * 100 : ratio(completed.length, total, 0.6) * 100 },
    { value: avgCompletionDays ? bounded(avgCompletionDays, 6, 24) * 100 : 64 },
    { value: sprintTotal ? ratio(sprintCompleted, sprintTotal, 0.5) * 100 : 66 },
  ], {
    confidence: evidenceConfidence({ observed: completed.length + sprintTotal, expected: 5, breadth: totalPoints > 0 ? 1 : 0.7 }),
  });

  const scopeStability = adaptiveScore([
    { value: bounded(scopeGrowth / Math.max(1, total), 0.25, 0.75) * 100 },
    { value: inverseRatio(overdue.length, Math.max(1, open.length), 0.7) * 100 },
    { value: bounded(open.length, Math.max(3, completed.length + 2), Math.max(8, completed.length + 10)) * 100 },
  ], {
    confidence: evidenceConfidence({ observed: total, expected: 8, breadth: 0.9 }),
  });

  const dependencyRisk = adaptiveScore([
    { value: inverseRatio(blocked.length, Math.max(1, open.length), 0.75) * 100 },
    { value: inverseRatio((evidence.links || []).filter((link) => ["blocks", "is_blocked_by"].includes(link.link_type)).length, Math.max(1, total), 0.72) * 100 },
    { value: overdue.length ? bounded(overdue.length, 0, Math.max(2, total * 0.25)) * 100 : 82 },
  ], {
    confidence: evidenceConfidence({ observed: total + (evidence.links || []).length, expected: 8, breadth: 1 }),
  });

  const completionConfidence = adaptiveScore([
    { value: deliveryHealth },
    { value: velocityHealth },
    { value: scopeStability },
    { value: dependencyRisk },
  ], {
    confidence: evidenceConfidence({ observed: completed.length + open.length, expected: 8, breadth: 1 }),
  });
  const executionMomentum = adaptiveScore([
    { value: ratio(recentCompletions, Math.max(1, completed.length), completed.length ? 0.5 : 0.62) * 100 },
    { value: inverseRatio(overdue.length, Math.max(1, open.length), 0.7) * 100 },
    { value: velocityHealth },
  ], {
    confidence: evidenceConfidence({ observed: recentCompletions + sprintTotal, expected: 4, breadth: sprintTotal ? 1 : 0.72 }),
  });
  const participationHealth = adaptiveScore([
    { value: ratio(assignedUsers.size, Math.max(1, Math.min(total, 6)), 0.55) * 100 },
    { value: inverseRatio(blocked.length, Math.max(1, open.length), 0.75) * 100 },
    { value: total > 0 ? ratio(tasks.filter((task) => task.assigned_to).length, total, 0.72) * 100 : 62 },
  ], {
    confidence: evidenceConfidence({ observed: total, expected: 6, breadth: assignedUsers.size > 1 ? 1 : 0.68 }),
  });

  const indexes = {
    deliveryHealth,
    velocityHealth,
    scopeStability,
    dependencyRisk,
    completionConfidence,
    executionMomentum,
    participationHealth,
  };

  const confidence = evidenceConfidence({
    observed: total + (evidence.links || []).length + sprintTotal,
    expected: 10,
    breadth: sprintTotal ? 1 : 0.82,
  });
  const score = adaptiveScore(Object.values(indexes).map((value) => ({ value })), { confidence });
  const riskProbability = Math.max(0, 100 - score + overdue.length * 4 + blocked.length * 5);

  const strengths = uniqueStrings([
    deliveryHealth >= 76 && "Delivery health is strong",
    velocityHealth >= 76 && "Velocity is supporting predictable progress",
    scopeStability >= 76 && "Scope is staying stable",
    dependencyRisk >= 76 && "Dependency risk is controlled",
    executionMomentum >= 76 && "Execution momentum is healthy",
    participationHealth >= 76 && "Project participation is well distributed",
  ].filter(Boolean));
  const concerns = uniqueStrings([
    deliveryHealth < 55 && "Delivery health is below target",
    velocityHealth < 55 && "Velocity health is weak",
    scopeStability < 55 && "Scope movement is increasing execution risk",
    dependencyRisk < 55 && "Dependencies or blocked work require attention",
    executionMomentum < 55 && "Execution momentum is slowing",
    participationHealth < 55 && "Participation or ownership coverage is thin",
    overdue.length > 0 && `${overdue.length} open task(s) are overdue`,
  ].filter(Boolean));
  const drivers = uniqueStrings([
    `${completed.length}/${total} task(s) complete`,
    `${completedPoints}/${totalPoints || 0} story point(s) complete`,
    `${blocked.length} blocked open task(s), ${overdue.length} overdue open task(s)`,
  ]);

  const output = {
    subjectType: "project",
    workspaceId: evidence.workspaceId,
    projectId: evidence.projectId,
    score,
    band: bandForScore(score),
    trend: trendFromSeries([scopeStability, deliveryHealth, score]),
    confidence,
    indexes,
    strengths,
    concerns,
    drivers,
    indicators: [
      riskProbability >= 70 && { type: "Project Risk", label: "Delivery risk requires intervention" },
      dependencyRisk < 55 && { type: "Dependency Risk", label: "Dependency risk is elevated" },
    ].filter(Boolean),
    risk: {
      probability: roundScore(riskProbability),
      level: riskLevel(riskProbability),
    },
    analytics: {
      totalTasks: total,
      completedTasks: completed.length,
      openTasks: open.length,
      overdueTasks: overdue.length,
      blockedTasks: blocked.length,
      completionRate: roundScore(ratio(completed.length, total, 0) * 100),
      completionConfidence,
      executionMomentum,
      participationHealth,
      participantCount: assignedUsers.size,
    },
    sourceWindow: {
      startDate: evidence.range.startDate,
      endDate: evidence.range.endDate,
      windowDays: evidence.range.windowDays,
    },
  };

  return {
    ...output,
    evidenceHash: hashEvidence({ indexes, analytics: output.analytics, sourceWindow: output.sourceWindow }),
  };
}

export default evaluateProjectIntelligence;
