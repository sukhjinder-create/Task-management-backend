export function detectSignals(dimensions, historicalScores) {

  const signals = [];

  if (dimensions.momentum < -5)
    signals.push("Sustained performance decline");

  if (dimensions.volatility > 15)
    signals.push("High performance instability");

  if (dimensions.executionDiscipline < 50)
    signals.push("Low execution discipline");

  if (dimensions.timelinessIndex < 60)
    signals.push("Deadline management issue");

  if (historicalScores.length >= 3 &&
      historicalScores.slice(-3).every((s, i, arr) =>
        i === 0 || s < arr[i - 1]
      )
  ) {
    signals.push("Three-month consecutive decline");
  }

  return signals;
}
