export function detectSignals(
  dimensions,
  historicalScores,
  executionSnapshot, // execution reality snapshot
  okrContext         // OKR portfolio health (optional) — from /objectives/workspace/health
) {

  const signals = [];

  // -----------------------------
  // PERFORMANCE BEHAVIOR SIGNALS
  // -----------------------------
  if (dimensions.momentum < -5)
    signals.push("Sustained performance decline");

  if (dimensions.volatility > 15)
    signals.push("High performance instability");

  if (dimensions.executionDiscipline < 50)
    signals.push("Low execution discipline");

  if (dimensions.timelinessIndex < 60)
    signals.push("Deadline management issue");


  // -----------------------------
  // EXECUTION REALITY SIGNALS
  // -----------------------------
  if (executionSnapshot) {

    const completionRate =
      executionSnapshot.completionRate * 100;

    const backlog =
      executionSnapshot.totalWork -
      executionSnapshot.completedWork;

    if (completionRate < 40)
      signals.push("Execution backlog expanding");

    if (completionRate < 25)
      signals.push("Critical delivery risk emerging");

    if (backlog > 200)
      signals.push("Workload accumulation exceeds execution capacity");
  }


  // -----------------------------
  // TREND SIGNAL
  // -----------------------------
  if (
    historicalScores.length >= 3 &&
    historicalScores.slice(-3).every(
      (s, i, arr) => i === 0 || s < arr[i - 1]
    )
  ) {
    signals.push("Three-month consecutive decline");
  }


  // ─────────────────────────────────────────────────────────────────────────
  // GOAL PORTFOLIO SIGNALS
  //
  // These signals fire when the intelligence layer detects that workspace
  // goals are unhealthy — stalled goals, off-track progress, or sprint
  // velocity that cannot deliver goals on time.
  //
  // okrContext shape (from GET /goals/workspace/health):
  //   { totalGoals, atRiskCount, stalledCount, behindCount,
  //     avgHealthScore, avgProgress, completedCount }
  // ─────────────────────────────────────────────────────────────────────────
  if (okrContext && okrContext.totalGoals > 0) {

    if (okrContext.atRiskCount > 0)
      signals.push(
        `${okrContext.atRiskCount} goal(s) are at risk or off-track`
      );

    if (okrContext.stalledCount > 0)
      signals.push(
        `${okrContext.stalledCount} goal(s) have stalled — no progress in 14+ days`
      );

    if (okrContext.behindCount > 0)
      signals.push(
        `${okrContext.behindCount} goal(s) are behind their expected progress pace`
      );

    if (okrContext.avgHealthScore !== null && okrContext.avgHealthScore < 35)
      signals.push("Goal portfolio health is critically low — most goals are at risk");

    const riskRatio = okrContext.atRiskCount / okrContext.totalGoals;
    if (riskRatio > 0.5)
      signals.push("More than half of workspace goals are currently at risk");
  }

  return signals;
}