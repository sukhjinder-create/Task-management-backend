import { createHash } from "crypto";

export const INTELLIGENCE_VERSION = "enterprise-intelligence-v1";

export function clamp(value, min = 0, max = 100) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

export function clamp01(value) {
  return clamp(value, 0, 1);
}

export function roundScore(value) {
  return Math.round(clamp(value));
}

export function ratio(part, total, neutral = 0.5) {
  const p = Number(part) || 0;
  const t = Number(total) || 0;
  if (t <= 0) return neutral;
  return clamp01(p / t);
}

export function inverseRatio(part, total, neutral = 0.5) {
  return clamp01(1 - ratio(part, total, neutral));
}

export function bounded(value, healthy, poor) {
  const v = Number(value) || 0;
  if (healthy === poor) return v <= healthy ? 1 : 0;
  if (healthy < poor) {
    if (v <= healthy) return 1;
    if (v >= poor) return 0;
    return clamp01(1 - ((v - healthy) / (poor - healthy)));
  }
  if (v >= healthy) return 1;
  if (v <= poor) return 0;
  return clamp01((v - poor) / (healthy - poor));
}

export function varianceScore(values = [], tolerance = 60) {
  const nums = values.map(Number).filter(Number.isFinite);
  if (nums.length <= 1) return 70;
  const mean = nums.reduce((sum, v) => sum + v, 0) / nums.length;
  const avgDeviation = nums.reduce((sum, v) => sum + Math.abs(v - mean), 0) / nums.length;
  return roundScore(bounded(avgDeviation, tolerance, tolerance * 4) * 100);
}

export function trendFromSeries(values = []) {
  const nums = values.map(Number).filter(Number.isFinite);
  if (nums.length < 2) return "stable";
  const first = nums[0];
  const last = nums[nums.length - 1];
  const delta = last - first;
  if (delta >= 4) return "up";
  if (delta <= -4) return "down";
  return "stable";
}

export function bandForScore(score) {
  const s = Number(score) || 0;
  if (s >= 85) return "Exceptional";
  if (s >= 75) return "Strong";
  if (s >= 62) return "Healthy";
  if (s >= 48) return "Watch";
  return "Critical";
}

export function riskLevel(probability) {
  const p = Number(probability) || 0;
  if (p >= 70) return "High";
  if (p >= 42) return "Medium";
  return "Low";
}

export function evidenceConfidence({ observed = 0, expected = 1, breadth = 1, volatility = 0 }) {
  const coverage = ratio(observed, expected, expected <= 0 ? 0.65 : 0);
  const breadthScore = clamp01(Number(breadth) || 0);
  const stability = clamp01(1 - (Number(volatility) || 0));
  return roundScore((coverage * 0.46 + breadthScore * 0.34 + stability * 0.20) * 100);
}

export function adaptiveScore(signals = [], options = {}) {
  const observed = signals
    .filter((signal) => signal && Number.isFinite(Number(signal.value)));

  if (!observed.length) return options.neutral ?? 60;

  const values = observed.map((signal) => clamp(Number(signal.value)));
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const sorted = [...values].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const low = sorted[0];
  const high = sorted[sorted.length - 1];
  const spread = high - low;
  const balance = clamp(100 - spread * 0.35);
  const confidence = options.confidence == null ? 75 : clamp(options.confidence);

  // Non-linear blend: rewards balanced evidence and dampens outliers.
  const harmonic = values.length
    / values.reduce((sum, v) => sum + (1 / Math.max(8, v)), 0);
  const raw =
    (mean * 0.32) +
    (median * 0.30) +
    (harmonic * 0.22) +
    (balance * 0.10) +
    (confidence * 0.06);

  return roundScore(raw);
}

export function domainSummary({ name, score, confidence, strengths = [], concerns = [], drivers = [], metrics = {}, indicators = [] }) {
  return {
    name,
    score: roundScore(score),
    band: bandForScore(score),
    confidence: roundScore(confidence),
    strengths,
    concerns,
    drivers,
    indicators,
    metrics,
  };
}

export function hashEvidence(value) {
  return createHash("sha256")
    .update(JSON.stringify(value ?? {}))
    .digest("hex");
}

export function uniqueStrings(items = []) {
  const out = [];
  const seen = new Set();
  for (const item of items) {
    const text = String(item || "").trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

export function compactJson(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}
