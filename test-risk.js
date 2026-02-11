import { classifyRisk } from "./events/scoring/riskClassifier.js";

console.log(
  classifyRisk({
    currentScore: 40,
    trend: "DECLINING",
    confidence: "HIGH",
  })
);

console.log(
  classifyRisk({
    currentScore: 62,
    trend: "IMPROVING",
    confidence: "HIGH",
  })
);
