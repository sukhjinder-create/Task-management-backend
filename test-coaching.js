import { evaluateCoachingTrigger } from "./events/coaching/coachingTrigger.engine.js";

console.log(
  evaluateCoachingTrigger({
    riskLevel: "HIGH",
    trend: "DECLINING",
    confidence: "HIGH",
  })
);

console.log(
  evaluateCoachingTrigger({
    riskLevel: "MEDIUM",
    trend: "STABLE",
    confidence: "HIGH",
  })
);
