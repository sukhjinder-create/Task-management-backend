import { getSnapshotSeries } from "../repositories/unifiedIntelligence.repository.js";

function normalizeRange(range = "30d") {
  return ["30d", "90d", "6m", "1y", "all", "custom"].includes(range) ? range : "30d";
}

export async function getHistoricalSeries({
  workspaceId,
  scopeType,
  subjectKey,
  range = "30d",
  startDate = null,
  endDate = null,
}) {
  return getSnapshotSeries({
    workspaceId,
    scopeType,
    subjectKey,
    range: normalizeRange(range),
    startDate,
    endDate,
  });
}

export function buildTrendAnalytics(series = []) {
  if (!series.length) {
    return {
      points: [],
      direction: "stable",
      delta: 0,
    };
  }
  const first = Number(series[0]?.score) || 0;
  const last = Number(series[series.length - 1]?.score) || 0;
  const delta = Math.round((last - first) * 100) / 100;
  return {
    points: series.map((point) => ({ date: point.date, score: point.score })),
    direction: delta > 3 ? "up" : delta < -3 ? "down" : "stable",
    delta,
  };
}

export default {
  getHistoricalSeries,
  buildTrendAnalytics,
};
