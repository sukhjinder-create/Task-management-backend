export function detectSignals(
  dimensions,
  historicalScores,
  executionSnapshot // ⭐ NEW
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
  // EXECUTION REALITY SIGNALS (NEW)
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

  return signals;
}