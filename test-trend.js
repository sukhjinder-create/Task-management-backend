import { calculateScoreTrend } from "./events/scoring/trendCalculator.js";

const data = [
  { month: "2025-12", score: 55 },
  { month: "2026-01", score: 48 },
  { month: "2026-02", score: 40 },
];

console.log(calculateScoreTrend(data));
