function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, value));
}

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

export function computeProductivityScore(metrics) {
  const total = Number(metrics?.totalTasks) || 0;
  const completed = Number(metrics?.completedTasks) || 0;
  const lateCompleted = Number(metrics?.lateCompletions) || 0;
  const activeOverdue = Number(metrics?.activeOverdue) || 0;
  const inProgress = Number(metrics?.inProgress) || 0;

  if (total === 0) {
    return {
      score: 70,
      dimensions: {
        completionRate: 0,
        timeliness: 100,
        backlogControl: 100,
        focusFlow: 100,
      },
    };
  }

  const completionRate = clamp((completed / total) * 100);
  const timeliness = completed === 0
    ? 100
    : clamp((1 - lateCompleted / completed) * 100);
  const backlogControl = clamp(100 - (activeOverdue / total) * 100);
  const focusFlow = clamp(100 - (inProgress / total) * 70);

  const score = clamp(
    0.45 * completionRate +
    0.25 * timeliness +
    0.20 * backlogControl +
    0.10 * focusFlow
  );

  return {
    score: round2(score),
    dimensions: {
      completionRate: round2(completionRate),
      timeliness: round2(timeliness),
      backlogControl: round2(backlogControl),
      focusFlow: round2(focusFlow),
    },
  };
}

export function computeAttendanceScore(metrics) {
  const signedIn = Number(metrics?.signedInMinutes) || 0;
  const available = Number(metrics?.availableMinutes) || 0;
  const screenOn = Number(metrics?.screenOnMinutes) || 0;
  const screenOff = Number(metrics?.screenOffMinutes) || 0;
  const presentDays = Number(metrics?.presentDays) || 0;
  const observedDays = Number(metrics?.observedDays) || 0;

  if (signedIn === 0 && observedDays === 0) {
    return {
      score: 65,
      dimensions: {
        availabilityRatio: 0,
        consistency: 0,
        focusPresence: 0,
      },
    };
  }

  const availabilityRatio = signedIn > 0 ? clamp((available / signedIn) * 100) : 0;
  const consistency = observedDays > 0 ? clamp((presentDays / observedDays) * 100) : 0;
  const totalScreen = screenOn + screenOff;
  const focusPresence = totalScreen > 0 ? clamp((screenOn / totalScreen) * 100) : 0;

  const score = clamp(
    0.50 * availabilityRatio +
    0.25 * consistency +
    0.25 * focusPresence
  );

  return {
    score: round2(score),
    dimensions: {
      availabilityRatio: round2(availabilityRatio),
      consistency: round2(consistency),
      focusPresence: round2(focusPresence),
    },
  };
}

export function computeUnifiedScore(productivityScore, attendanceScore) {
  const score = clamp(0.72 * (productivityScore || 0) + 0.28 * (attendanceScore || 0));
  return round2(score);
}

export function getScoreBand(score) {
  if (score >= 80) return "Excellent";
  if (score >= 65) return "Healthy";
  if (score >= 50) return "Watch";
  return "Critical";
}

export function buildExecutiveSummary({
  role,
  scopeLabel,
  counts,
  scoreCard,
  trend,
  topOverdue,
}) {
  const totalTasks = Number(counts?.totalTasks) || 0;
  const completed = Number(counts?.completedTasks) || 0;
  const overdue = Number(counts?.overdueTasks) || 0;
  const inProgress = Number(counts?.inProgressTasks) || 0;
  const completionRate = totalTasks > 0 ? round2((completed / totalTasks) * 100) : 0;
  const trendLabel = trend?.direction || "stable";
  const topRiskTask = topOverdue?.[0];

  const scoreBand = getScoreBand(scoreCard?.unifiedScore || 0);
  const headline = `${scopeLabel}: ${scoreBand} operational posture (${scoreCard?.unifiedScore || 0}/100)`;

  const narrative =
    `Current workspace execution is ${trendLabel}. Completion is ${completionRate}% ` +
    `(${completed}/${totalTasks} tasks), with ${overdue} overdue and ${inProgress} active in-progress items. ` +
    `Operational signal quality is driven by productivity ${scoreCard?.productivityScore || 0}/100 and ` +
    `attendance ${scoreCard?.attendanceScore || 0}/100, producing unified score ${scoreCard?.unifiedScore || 0}/100.`;

  const risks = [];
  if (overdue > 0) risks.push(`${overdue} overdue tasks require prioritization.`);
  if ((scoreCard?.attendanceScore || 0) < 55) risks.push("Attendance reliability is reducing execution confidence.");
  if ((scoreCard?.productivityScore || 0) < 55) risks.push("Productivity signals are below target performance.");
  if (topRiskTask?.task) risks.push(`Highest urgency: "${topRiskTask.task}" (${topRiskTask.overdue_days} days overdue).`);

  const strengths = [];
  if (completionRate >= 70) strengths.push(`Completion rate is strong at ${completionRate}%.`);
  if ((scoreCard?.attendanceScore || 0) >= 70) strengths.push("Attendance pattern supports operational continuity.");
  if (trendLabel === "improving") strengths.push("Recent score trend is improving.");

  const priorities = [];
  priorities.push("Drive overdue backlog down by enforcing deadline-first execution on critical tasks.");
  priorities.push("Cap concurrent in-progress load per owner until completion rate stabilizes above target.");
  priorities.push("Run weekly attendance variance review and realign assignments for low-availability users.");
  priorities.push("Escalate stalled work items with aging >48h to manager checkpoint.");

  if (role === "user") {
    return {
      headline,
      narrative:
        `Your current execution score is ${scoreCard?.unifiedScore || 0}/100. ` +
        `You have ${overdue} overdue task(s). Focus on overdue closure first, then in-progress items.`,
      strengths,
      risks,
      priorities: [
        "Complete overdue tasks before accepting new work.",
        "Keep daily availability consistent to improve attendance score.",
        "Close at least one in-progress task every day.",
      ],
    };
  }

  return {
    headline,
    narrative,
    strengths,
    risks,
    priorities,
  };
}
