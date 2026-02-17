export function calculateDimensions({
  tasks,
  historicalScores,
  activityLog
}) {

  const totalTasks = tasks.length;
  const completedTasks = tasks.filter(t => t.status === "completed").length;
  const overdueTasks = tasks.filter(t => t.overdue === true).length;

  const executionDiscipline =
    totalTasks === 0 ? 0 :
    (completedTasks / totalTasks) * 100;

  const timelinessIndex =
    totalTasks === 0 ? 0 :
    (1 - overdueTasks / totalTasks) * 100;

  const consistencyStability = calculateConsistency(activityLog);

  const momentum = calculateMomentum(historicalScores);

  const volatility = calculateVolatility(historicalScores);

  return {
    executionDiscipline,
    timelinessIndex,
    consistencyStability,
    momentum,
    volatility
  };
}

function calculateMomentum(scores) {
  if (scores.length < 2) return 0;

  const n = scores.length;
  const xMean = (n - 1) / 2;
  const yMean = scores.reduce((a, b) => a + b, 0) / n;

  let numerator = 0;
  let denominator = 0;

  for (let i = 0; i < n; i++) {
    numerator += (i - xMean) * (scores[i] - yMean);
    denominator += (i - xMean) ** 2;
  }

  return denominator === 0 ? 0 : numerator / denominator;
}

function calculateVolatility(scores) {
  if (scores.length === 0) return 0;

  const mean =
    scores.reduce((a, b) => a + b, 0) / scores.length;

  const variance =
    scores.reduce((sum, s) => sum + (s - mean) ** 2, 0) /
    scores.length;

  return Math.sqrt(variance);
}

function calculateConsistency(activityLog) {
  if (!activityLog.length) return 0;

  const values = activityLog.map(a => a.activityCount);

  const mean =
    values.reduce((a, b) => a + b, 0) / values.length;

  const variance =
    values.reduce((sum, v) => sum + (v - mean) ** 2, 0) /
    values.length;

  return 100 - Math.min(100, Math.sqrt(variance));
}