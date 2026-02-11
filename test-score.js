import { calculateScore } from "./events/scoring/scoreCalculator.js";

const testCases = [
  {
    name: "High performer",
    input: {
      attendanceRatio: 0.95,
      taskCompletionRatio: 0.9,
      timelinessRatio: 0.85,
      stabilityRatio: 0.8,
      collaborationRatio: 0.7,
    },
  },
  {
    name: "Average performer",
    input: {
      attendanceRatio: 0.8,
      taskCompletionRatio: 0.65,
      timelinessRatio: 0.6,
      stabilityRatio: 0.6,
      collaborationRatio: 0.5,
    },
  },
  {
    name: "At-risk performer",
    input: {
      attendanceRatio: 0.5,
      taskCompletionRatio: 0.4,
      timelinessRatio: 0.3,
      stabilityRatio: 0.4,
      collaborationRatio: 0.2,
    },
  },
];

for (const t of testCases) {
  const result = calculateScore(t.input);
  console.log("\n---", t.name, "---");
  console.log(result);
}
