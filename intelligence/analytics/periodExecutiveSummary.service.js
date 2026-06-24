import pool from "../../db.js";
import { saveExecutiveSummary } from "../../events/executive/executiveSummary.store.js";
import { buildTrendAnalytics } from "./historicalAnalytics.service.js";

export const PERIOD_EXECUTIVE_SUMMARY_VERSION = "dashboard_period_summary_v2";
const SUMMARY_KIND = "dashboard_period_executive_summary";

function dateKey(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function utcDate(year, monthIndex, day) {
  return new Date(Date.UTC(year, monthIndex, day));
}

function monthKey(date) {
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function round(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 100) / 100 : null;
}

function average(values = []) {
  const nums = values.map(Number).filter(Number.isFinite);
  if (!nums.length) return null;
  return round(nums.reduce((sum, value) => sum + value, 0) / nums.length);
}

function directionLabel(direction) {
  if (direction === "up") return "improving";
  if (direction === "down") return "declining";
  return "stable";
}

function rangeNarrative(rangeValue) {
  if (rangeValue === "90d") return "quarter-style operating period";
  if (rangeValue === "6m") return "half-year operating horizon";
  if (rangeValue === "1y") return "annual performance window";
  if (rangeValue === "all") return "full-history workspace narrative";
  return "recent monthly operating period";
}

function compactList(items = [], limit = 4) {
  const seen = new Set();
  const output = [];
  for (const item of items) {
    const label = String(item || "").trim();
    if (!label || seen.has(label.toLowerCase())) continue;
    seen.add(label.toLowerCase());
    output.push(label);
    if (output.length >= limit) break;
  }
  return output;
}

function addFrequency(map, values = []) {
  for (const value of values || []) {
    const label = typeof value === "string"
      ? value
      : value?.label || value?.type || value?.message || "";
    const key = String(label || "").trim();
    if (!key) continue;
    map.set(key, (map.get(key) || 0) + 1);
  }
}

function topFrequency(map, fallback = [], limit = 4) {
  const ranked = [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([label]) => label);
  return compactList([...ranked, ...fallback], limit);
}

function chartStats(visualizations, key) {
  const chart = (visualizations?.charts || []).find((item) => item.key === key);
  const values = (chart?.data || []).map((point) => Number(point.value)).filter(Number.isFinite);
  if (!values.length) {
    return {
      key,
      pointCount: 0,
      average: null,
      first: null,
      last: null,
      delta: 0,
      direction: "stable",
    };
  }
  const first = values[0];
  const last = values[values.length - 1];
  const delta = round(last - first) || 0;
  return {
    key,
    title: chart?.title || key,
    pointCount: values.length,
    average: average(values),
    first: round(first),
    last: round(last),
    delta,
    direction: delta > 3 ? "up" : delta < -3 ? "down" : "stable",
  };
}

export function summaryBucketForRange(rangeMeta = {}, now = new Date()) {
  const value = rangeMeta.value || "30d";
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();

  if (value === "90d") {
    const quarter = Math.floor(month / 3) + 1;
    const start = utcDate(year, (quarter - 1) * 3, 1);
    const end = utcDate(year, quarter * 3, 0);
    return {
      rangeKey: "90D",
      periodKey: `90-${year}Q${quarter}`,
      label: `Q${quarter} ${year}`,
      bucketStart: dateKey(start),
      bucketEnd: dateKey(end),
      bucketType: "calendar_quarter",
      open: now <= end,
    };
  }

  if (value === "6m") {
    const half = month < 6 ? 1 : 2;
    const start = utcDate(year, half === 1 ? 0 : 6, 1);
    const end = utcDate(year, half === 1 ? 6 : 12, 0);
    return {
      rangeKey: "6M",
      periodKey: `6M-${year}H${half}`,
      label: `H${half} ${year}`,
      bucketStart: dateKey(start),
      bucketEnd: dateKey(end),
      bucketType: "calendar_half_year",
      open: now <= end,
    };
  }

  if (value === "1y") {
    const start = utcDate(year, 0, 1);
    const end = utcDate(year, 12, 0);
    return {
      rangeKey: "1Y",
      periodKey: `1Y-${year}`,
      label: `${year}`,
      bucketStart: dateKey(start),
      bucketEnd: dateKey(end),
      bucketType: "calendar_year",
      open: now <= end,
    };
  }

  if (value === "all") {
    return {
      rangeKey: "ALL",
      periodKey: "ALL",
      label: "All available history",
      bucketStart: null,
      bucketEnd: dateKey(now),
      bucketType: "all_history",
      open: false,
    };
  }

  const start = utcDate(year, month, 1);
  const end = utcDate(year, month + 1, 0);
  return {
    rangeKey: "30D",
    periodKey: `30-${monthKey(now)}`,
    label: `${String(month + 1).padStart(2, "0")}/${year}`,
    bucketStart: dateKey(start),
    bucketEnd: dateKey(end),
    bucketType: "calendar_month",
    open: now <= end,
  };
}

function analyzePeriod({ trendSeries = [], intelligence = {}, visualizations = {}, rangeMeta = {}, bucket = {}, counts = {}, topOverdue = [] }) {
  const scores = trendSeries.map((point) => Number(point.score)).filter(Number.isFinite);
  const trend = buildTrendAnalytics(trendSeries);
  const firstScore = scores.length ? scores[0] : Number(intelligence?.score) || null;
  const lastScore = scores.length ? scores[scores.length - 1] : Number(intelligence?.score) || null;
  const diffs = [];
  for (let index = 1; index < scores.length; index += 1) {
    diffs.push(Math.abs(scores[index] - scores[index - 1]));
  }

  const strengthCounts = new Map();
  const concernCounts = new Map();
  const driverCounts = new Map();
  const indicatorCounts = new Map();

  addFrequency(strengthCounts, intelligence?.strengths);
  addFrequency(concernCounts, intelligence?.concerns);
  addFrequency(driverCounts, intelligence?.drivers);
  addFrequency(indicatorCounts, intelligence?.indicators);
  for (const point of trendSeries) {
    addFrequency(strengthCounts, point.payload?.strengths);
    addFrequency(concernCounts, point.payload?.concerns);
    addFrequency(driverCounts, point.payload?.drivers);
    addFrequency(indicatorCounts, point.payload?.indicators);
  }

  return {
    range: rangeMeta,
    bucket,
    snapshotPointCount: trendSeries.length,
    coverageStart: dateKey(trendSeries[0]?.date),
    coverageEnd: dateKey(trendSeries[trendSeries.length - 1]?.date),
    score: {
      first: round(firstScore),
      last: round(lastScore),
      average: average(scores),
      minimum: scores.length ? round(Math.min(...scores)) : null,
      maximum: scores.length ? round(Math.max(...scores)) : null,
      delta: round(trend.delta) || 0,
      direction: trend.direction,
      volatility: average(diffs) || 0,
    },
    chartSignals: {
      workspaceHealth: chartStats(visualizations, "workspace_health_trends"),
      productivity: chartStats(visualizations, "productivity_trends"),
      risk: chartStats(visualizations, "risk_trends"),
    },
    strengths: topFrequency(strengthCounts, intelligence?.strengths, 5),
    concerns: topFrequency(concernCounts, intelligence?.concerns, 5),
    drivers: topFrequency(driverCounts, intelligence?.drivers, 5),
    indicators: topFrequency(indicatorCounts, [], 5),
    currentRisk: intelligence?.risk || {},
    confidence: intelligence?.confidence ?? null,
    band: intelligence?.band || null,
    taskContext: {
      totalTasks: counts?.totalTasks || 0,
      completedTasks: counts?.completedTasks || 0,
      overdueTasks: counts?.overdueTasks || 0,
      topOverdue: (topOverdue || []).slice(0, 3).map((task) => ({
        task: task.task,
        projectName: task.project_name,
        overdueDays: task.overdue_days,
        priority: task.priority,
      })),
    },
  };
}

function buildPriorities(analysis) {
  const priorities = [];
  if (analysis.score.direction === "down") {
    priorities.push("Stabilize the intelligence trajectory by addressing the period's recurring delivery risks.");
  }
  if ((analysis.taskContext.overdueTasks || 0) > 0) {
    priorities.push(`Reduce the overdue task queue (${analysis.taskContext.overdueTasks} item(s)) before it becomes a planning drag.`);
  }
  if (String(analysis.currentRisk?.level || "").toLowerCase() === "high") {
    priorities.push("Review the high-risk workspace signals with project owners and agree on immediate recovery actions.");
  }
  priorities.push(...analysis.concerns.slice(0, 3));
  priorities.push("Keep event-driven intelligence snapshots current so leadership sees period movement, not only current posture.");
  return compactList(priorities, 5);
}

function buildNarrative({ scopeLabel, analysis, forecast, materialization }) {
  const periodName = rangeNarrative(analysis.range?.value);
  const direction = directionLabel(analysis.score.direction);
  const score = analysis.score.last ?? 0;
  const delta = Math.abs(analysis.score.delta || 0);
  const pointCount = analysis.snapshotPointCount;
  const productivity = analysis.chartSignals.productivity;
  const risk = analysis.chartSignals.risk;
  const topConcern = analysis.concerns[0] || "No dominant concern repeated across the selected period.";
  const topStrength = analysis.strengths[0] || "No dominant strength repeated across the selected period.";
  const topDriver = analysis.drivers[0] || "The period was shaped by the combined execution, delivery, collaboration, and risk evidence.";
  const dataDepth = pointCount >= 3
    ? `${pointCount} historical intelligence points`
    : pointCount === 2
      ? "2 historical intelligence points"
      : "the current intelligence point plus live repository context";
  const materializationNote = materialization?.materialized
    ? `Historical materialization expanded this view from ${materialization.beforePointCount || 0} to ${materialization.afterPointCount || pointCount} point(s).`
    : null;

  const outlookBase = forecast?.reasoning || "Forward outlook is based on the selected period's enterprise intelligence trajectory.";
  const outlook =
    `Next-month outlook: ${outlookBase} ` +
    `Period context shows ${direction} movement, average score ${analysis.score.average ?? "n/a"}, ` +
    `productivity ${directionLabel(productivity.direction)} (${productivity.delta || 0} pt delta), ` +
    `and risk ${directionLabel(risk.direction)} (${risk.delta || 0} pt delta).`;

  return {
    headline: `${scopeLabel}: ${analysis.range.label} ${direction} executive intelligence (${score}/100)`,
    narrative:
      `For the ${periodName} (${analysis.bucket.label}), ${scopeLabel.toLowerCase()} is ${analysis.band || "unclassified"} at ${score}/100, ` +
      `${direction} by ${delta} point(s) across ${dataDepth}. ` +
      `The selected-period score band ranged from ${analysis.score.minimum ?? "n/a"} to ${analysis.score.maximum ?? "n/a"} with average movement volatility ${analysis.score.volatility}. ` +
      `Productivity averaged ${productivity.average ?? "n/a"} and risk averaged ${risk.average ?? "n/a"} across the same dashboard contract. ` +
      `The strongest repeated strength was: ${topStrength}. The most visible concern was: ${topConcern}. ` +
      `Primary driver: ${topDriver}. ` +
      `${analysis.taskContext.overdueTasks || 0} scoped overdue item(s) remain visible in the period context.` +
      `${materializationNote ? ` ${materializationNote}` : ""}`,
    outlook,
    strengths: analysis.strengths,
    risks: analysis.concerns,
    concerns: analysis.concerns,
    priorities: buildPriorities(analysis),
    drivers: analysis.drivers,
    indicators: analysis.indicators,
    period: analysis.range,
    summaryBucket: analysis.bucket,
    metrics: {
      score: analysis.score.last,
      averageScore: analysis.score.average,
      delta: analysis.score.delta,
      direction: directionLabel(analysis.score.direction),
      snapshotCount: analysis.snapshotPointCount,
      coverageStart: analysis.coverageStart,
      coverageEnd: analysis.coverageEnd,
      productivityAverage: productivity.average,
      productivityDelta: productivity.delta,
      riskAverage: risk.average,
      riskDelta: risk.delta,
      scopedTasks: analysis.taskContext.totalTasks,
      completedTasks: analysis.taskContext.completedTasks,
      overdueTasks: analysis.taskContext.overdueTasks,
      confidence: analysis.confidence,
    },
  };
}

async function loadSavedSummary({ workspaceId, periodKey }) {
  const { rows } = await pool.query(
    `SELECT id, workspace_id, period, summary, source_data, created_at, status
     FROM workspace_executive_summaries
     WHERE workspace_id = $1
       AND period = $2
     LIMIT 1`,
    [workspaceId, periodKey]
  );
  return rows[0] || null;
}

function shouldReuseSavedSummary(row, analysis, rangeMeta, bucket) {
  if (!row?.summary || row.summary === "GENERATING") return false;
  const source = row.source_data || {};
  if (source.summaryKind !== SUMMARY_KIND) return false;
  if (source.summaryVersion !== PERIOD_EXECUTIVE_SUMMARY_VERSION) return false;
  if (source.dashboardRange?.value !== rangeMeta.value) return false;
  if (source.bucket?.periodKey !== bucket.periodKey) return false;

  const savedCount = Number(source.analysis?.snapshotPointCount || source.payload?.metrics?.snapshotCount || 0);
  if (savedCount < 2 && analysis.snapshotPointCount > savedCount) return false;

  return true;
}

function hydrateSavedSummary(row) {
  const source = row.source_data || {};
  const payload = source.payload || {};
  return {
    ...payload,
    text: row.summary,
    persisted: true,
    reused: true,
    summaryId: row.id,
    persistence: {
      summaryId: row.id,
      periodKey: row.period,
      reused: true,
      generatedAt: row.created_at,
      summaryVersion: source.summaryVersion,
    },
  };
}

export async function getOrCreateWorkspacePeriodExecutiveSummary({
  workspaceId,
  scopeLabel = "Workspace",
  rangeMeta,
  intelligence,
  counts,
  topOverdue,
  trendSeries,
  visualizations,
  forecast,
  materialization = null,
}) {
  const bucket = summaryBucketForRange(rangeMeta);
  const analysis = analyzePeriod({
    trendSeries,
    intelligence,
    visualizations,
    rangeMeta,
    bucket,
    counts,
    topOverdue,
  });
  const existing = await loadSavedSummary({ workspaceId, periodKey: bucket.periodKey });
  if (shouldReuseSavedSummary(existing, analysis, rangeMeta, bucket)) {
    return hydrateSavedSummary(existing);
  }

  const payload = buildNarrative({
    scopeLabel,
    analysis,
    forecast,
    materialization,
  });
  const summaryText = [
    payload.headline,
    payload.narrative,
    payload.outlook,
  ].filter(Boolean).join("\n\n");

  const saved = await saveExecutiveSummary({
    workspaceId,
    period: bucket.periodKey,
    summary: summaryText,
    sourceData: {
      summaryKind: SUMMARY_KIND,
      summaryVersion: PERIOD_EXECUTIVE_SUMMARY_VERSION,
      dashboardRange: rangeMeta,
      bucket,
      analysis,
      materialization,
      payload,
    },
  });

  return {
    ...payload,
    text: summaryText,
    persisted: true,
    reused: false,
    summaryId: saved?.id || null,
    persistence: {
      summaryId: saved?.id || null,
      periodKey: bucket.periodKey,
      reused: false,
      generatedAt: saved?.created_at || null,
      summaryVersion: PERIOD_EXECUTIVE_SUMMARY_VERSION,
    },
  };
}

export default {
  PERIOD_EXECUTIVE_SUMMARY_VERSION,
  summaryBucketForRange,
  getOrCreateWorkspacePeriodExecutiveSummary,
};
