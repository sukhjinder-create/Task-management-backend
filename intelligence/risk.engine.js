export function calculateRisk(dimensions) {

  const {
    executionDiscipline,
    timelinessIndex,
    consistencyStability,
    momentum,
    volatility
  } = dimensions;

  const riskScore =
      0.30 * (100 - executionDiscipline)
    + 0.25 * (100 - timelinessIndex)
    + 0.20 * (100 - consistencyStability)
    + 0.15 * Math.abs(momentum * 10)
    + 0.10 * volatility;

  const probability = Math.min(100, Math.max(0, riskScore));

  return {
    riskProbability: probability,
    riskLevel:
      probability > 70 ? "High" :
      probability > 40 ? "Medium" :
      "Low"
  };
}
