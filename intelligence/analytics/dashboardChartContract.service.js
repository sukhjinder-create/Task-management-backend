export const DASHBOARD_RANGES = {
  "30d": { value: "30d", label: "30D", days: 30, granularity: "day" },
  "90d": { value: "90d", label: "90D", days: 90, granularity: "week" },
  "6m": { value: "6m", label: "6M", days: 183, granularity: "week" },
  "1y": { value: "1y", label: "1Y", days: 366, granularity: "month" },
  all: { value: "all", label: "ALL", days: null, granularity: "month" },
};

function normalizeDashboardRange(range = "30d") {
  const normalized = String(range || "30d").trim().toLowerCase();
  return DASHBOARD_RANGES[normalized]?.value || "30d";
}

export function dashboardRangeMeta(range = "30d") {
  return DASHBOARD_RANGES[normalizeDashboardRange(range)] || DASHBOARD_RANGES["30d"];
}

function safeDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isoDate(date) {
  return date ? date.toISOString().slice(0, 10) : null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function dayMonth(date) {
  return `${String(date.getUTCDate()).padStart(2, "0")} ${MONTHS[date.getUTCMonth()]}`;
}

function monthYear(date) {
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

function formatBucketLabel(date, rangeMeta = {}, { detailed = false, bucketEnd = null } = {}) {
  if (!date) return null;
  const range = rangeMeta?.value || "30d";
  const end = bucketEnd ? safeDate(bucketEnd) : null;

  if (detailed) {
    const startLabel = `${dayMonth(date)} ${date.getUTCFullYear()}`;
    if (end && isoDate(end) !== isoDate(date)) {
      return `${startLabel} - ${dayMonth(end)} ${end.getUTCFullYear()}`;
    }
    return range === "6m" || range === "1y" || range === "all"
      ? monthYear(date)
      : startLabel;
  }

  if (range === "30d" || range === "90d") return dayMonth(date);
  if (range === "all") return monthYear(date);
  return MONTHS[date.getUTCMonth()];
}

function startOfUtcWeek(date) {
  const copy = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = copy.getUTCDay() || 7;
  copy.setUTCDate(copy.getUTCDate() - day + 1);
  return copy;
}

function endOfUtcWeek(start) {
  const copy = new Date(start);
  copy.setUTCDate(copy.getUTCDate() + 6);
  return copy;
}

function bucketInfo(value, granularity, rangeMeta = dashboardRangeMeta()) {
  const date = safeDate(value);
  if (!date) return null;

  if (granularity === "month") {
    const monthStart = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
    const monthEnd = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
    const key = isoDate(monthStart).slice(0, 7);
    return {
      key,
      label: formatBucketLabel(monthStart, rangeMeta),
      tooltipLabel: formatBucketLabel(monthStart, rangeMeta, { detailed: true, bucketEnd: isoDate(monthEnd) }),
      bucketStart: isoDate(monthStart),
      bucketEnd: isoDate(monthEnd),
    };
  }

  if (granularity === "week") {
    const weekStart = startOfUtcWeek(date);
    const weekEnd = endOfUtcWeek(weekStart);
    return {
      key: isoDate(weekStart),
      label: formatBucketLabel(weekStart, rangeMeta),
      tooltipLabel: formatBucketLabel(weekStart, rangeMeta, { detailed: true, bucketEnd: isoDate(weekEnd) }),
      bucketStart: isoDate(weekStart),
      bucketEnd: isoDate(weekEnd),
    };
  }

  return {
    key: isoDate(date),
    label: formatBucketLabel(date, rangeMeta),
    tooltipLabel: formatBucketLabel(date, rangeMeta, { detailed: true }),
    bucketStart: isoDate(date),
    bucketEnd: isoDate(date),
  };
}

function chartLabel(point, index, rangeMeta = dashboardRangeMeta()) {
  if (point?.label) return point.label;
  if (point?.bucketStart) {
    const start = safeDate(point.bucketStart);
    return formatBucketLabel(start, rangeMeta, { bucketEnd: point.bucketEnd }) || String(point.bucketStart);
  }
  if (point?.date) return formatBucketLabel(safeDate(point.date), rangeMeta) || String(point.date);
  if (point?.month) return point.month;
  return `P${index + 1}`;
}

function chartTooltipLabel(point, rangeMeta = dashboardRangeMeta()) {
  if (point?.tooltipLabel) return point.tooltipLabel;
  const start = safeDate(point?.bucketStart || point?.date);
  if (!start) return point?.label || null;
  return formatBucketLabel(start, rangeMeta, { detailed: true, bucketEnd: point?.bucketEnd || point?.date });
}

function metricFromSnapshot(point, path, fallback = null) {
  const parts = path.split(".");
  let current = point?.payload || {};
  for (const part of parts) {
    current = current?.[part];
    if (current == null) return fallback;
  }
  const value = Number(current);
  return Number.isFinite(value) ? value : fallback;
}

function chartValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function chartAxis() {
  return {
    x: { dataKey: "label", type: "category" },
    y: { dataKey: "value", domain: [0, 100] },
  };
}

function chartSeries(metric) {
  return [
    {
      id: "value",
      label: metric,
      dataKey: "value",
    },
  ];
}

function lineChart({ key, title, metric, points, scope = null, rangeMeta }) {
  const data = (points || []).map((point, index) => ({
    label: chartLabel(point, index, rangeMeta),
    tooltipLabel: chartTooltipLabel(point, rangeMeta),
    date: point.date,
    bucketStart: point.bucketStart || point.date || null,
    bucketEnd: point.bucketEnd || point.date || null,
    value: chartValue(point.value),
  })).filter((point) => point.value != null);

  return {
    id: key,
    key,
    title,
    type: "line",
    dataKey: "value",
    metric,
    source: "intelligence_snapshots",
    scope: scope || { type: "dashboard_intelligence" },
    axis: chartAxis(),
    series: chartSeries(metric),
    range: rangeMeta,
    granularity: rangeMeta?.granularity || "day",
    pointCount: data.length,
    sparse: data.length < 2,
    data,
  };
}

function barChart({ key, title, metric, source, rows, scope = null, rangeMeta = null }) {
  return {
    id: key,
    key,
    title,
    type: "bar",
    dataKey: "value",
    metric,
    source,
    scope: scope || { type: "dashboard_intelligence" },
    axis: chartAxis(),
    series: chartSeries(metric),
    range: rangeMeta,
    granularity: null,
    pointCount: rows?.length || 0,
    sparse: false,
    data: (rows || []).map((row) => ({
      label: row.label,
      value: chartValue(row.value),
    })),
  };
}

function historicalPoints(series = [], selector, rangeMeta = dashboardRangeMeta()) {
  const rawPoints = series
    .map((point) => ({
      date: point.date,
      value: chartValue(selector(point)),
    }))
    .filter((point) => point.date && point.value != null);

  if (rangeMeta.granularity === "day") {
    return rawPoints.map((point, index) => ({
      ...point,
      label: chartLabel(point, index, rangeMeta),
      tooltipLabel: chartTooltipLabel(point, rangeMeta),
      bucketStart: point.date,
      bucketEnd: point.date,
      sampleCount: 1,
    }));
  }

  const buckets = new Map();
  for (const point of rawPoints) {
    const info = bucketInfo(point.date, rangeMeta.granularity, rangeMeta);
    if (!info) continue;
    const existing = buckets.get(info.key) || {
      ...info,
      date: info.bucketEnd,
      values: [],
    };
    existing.values.push(point.value);
    buckets.set(info.key, existing);
  }

  return [...buckets.values()].map((bucket) => {
    const average = bucket.values.reduce((sum, value) => sum + value, 0) / bucket.values.length;
    return {
      date: bucket.date,
      label: bucket.label,
      tooltipLabel: bucket.tooltipLabel,
      bucketStart: bucket.bucketStart,
      bucketEnd: bucket.bucketEnd,
      value: Math.round(average * 100) / 100,
      sampleCount: bucket.values.length,
    };
  });
}

function topRows(items = [], labelKey, valueSelector, limit = 8) {
  return items
    .map((item) => ({
      label: item?.[labelKey] || item?.managerName || item?.projectName || item?.username || item?.teamKey || "Item",
      value: valueSelector(item),
    }))
    .filter((row) => row.label)
    .slice(0, limit);
}

export function buildDashboardVisualizations({ role, trendSeries, snapshot, scopedProjects, rangeMeta }) {
  const scoreTrend = historicalPoints(trendSeries, (point) => Number(point.score) || 0, rangeMeta);
  const projectRows = topRows(scopedProjects, "projectName", (project) => project.score);
  const allProjectRows = topRows(snapshot.projects, "projectName", (project) => project.score);
  const teamRows = topRows(snapshot.teams, "managerName", (team) => team.score);
  const scope = { type: "role_dashboard", role, range: rangeMeta.value };

  if (role === "admin") {
    return {
      range: rangeMeta,
      charts: [
        lineChart({ key: "workspace_health_trends", title: "Workspace Health Trends", metric: "Workspace Health", points: scoreTrend, scope, rangeMeta }),
        lineChart({
          key: "productivity_trends",
          title: "Productivity Trends",
          metric: "Productivity",
          points: historicalPoints(trendSeries, (point) => metricFromSnapshot(point, "indexes.productivityIndex"), rangeMeta),
          scope,
          rangeMeta,
        }),
        lineChart({
          key: "risk_trends",
          title: "Risk Trends",
          metric: "Risk Probability",
          points: historicalPoints(trendSeries, (point) => metricFromSnapshot(point, "risk.probability"), rangeMeta),
          scope,
          rangeMeta,
        }),
        barChart({ key: "team_comparisons", title: "Team Comparisons", metric: "Team Score", source: "team_intelligence", rows: teamRows, scope, rangeMeta }),
        barChart({ key: "project_portfolio_comparisons", title: "Project Portfolio Comparisons", metric: "Project Score", source: "project_intelligence", rows: allProjectRows, scope, rangeMeta }),
        barChart({ key: "department_comparisons", title: "Department Comparisons", metric: "Team Scope Score", source: "team_intelligence", rows: teamRows, scope, rangeMeta }),
      ],
    };
  }

  if (role === "manager") {
    return {
      range: rangeMeta,
      charts: [
        barChart({ key: "assigned_project_performance", title: "Assigned Project Performance", metric: "Project Score", source: "project_intelligence", rows: projectRows, scope, rangeMeta }),
        lineChart({
          key: "team_delivery_trends",
          title: "Team Delivery Trends",
          metric: "Delivery Reliability",
          points: historicalPoints(trendSeries, (point) => metricFromSnapshot(point, "indexes.deliveryReliabilityIndex"), rangeMeta),
          scope,
          rangeMeta,
        }),
        lineChart({
          key: "team_risk_trends",
          title: "Team Risk Trends",
          metric: "Risk Probability",
          points: historicalPoints(trendSeries, (point) => metricFromSnapshot(point, "risk.probability"), rangeMeta),
          scope,
          rangeMeta,
        }),
        barChart({
          key: "sprint_progress_trends",
          title: "Sprint Progress Trends",
          metric: "Completion Rate",
          source: "project_intelligence",
          rows: topRows(scopedProjects, "projectName", (project) => project.completionRate),
          scope,
          rangeMeta,
        }),
        barChart({
          key: "completion_forecasts",
          title: "Completion Forecasts",
          metric: "Completion Confidence",
          source: "project_intelligence",
          rows: topRows(scopedProjects, "projectName", (project) => project.completionConfidence),
          scope,
          rangeMeta,
        }),
      ],
    };
  }

  return {
    range: rangeMeta,
    charts: [
      lineChart({ key: "personal_performance_trends", title: "Personal Performance Trends", metric: "Personal Score", points: scoreTrend, scope, rangeMeta }),
      lineChart({
        key: "workload_trends",
        title: "Workload Trends",
        metric: "Sustainability",
        points: historicalPoints(trendSeries, (point) => metricFromSnapshot(point, "dimensions.workSustainability.score"), rangeMeta),
        scope,
        rangeMeta,
      }),
      lineChart({
        key: "delivery_trends",
        title: "Delivery Trends",
        metric: "Delivery Effectiveness",
        points: historicalPoints(trendSeries, (point) => metricFromSnapshot(point, "dimensions.deliveryEffectiveness.score"), rangeMeta),
        scope,
        rangeMeta,
      }),
      lineChart({
        key: "task_completion_trends",
        title: "Task Completion Trends",
        metric: "Commitment Completion",
        points: historicalPoints(trendSeries, (point) => metricFromSnapshot(point, "dimensions.executionReliability.metrics.commitmentCompletion"), rangeMeta),
        scope,
        rangeMeta,
      }),
      lineChart({
        key: "personal_risk_trends",
        title: "Personal Risk Trends",
        metric: "Risk Probability",
        points: historicalPoints(trendSeries, (point) => metricFromSnapshot(point, "risk.probability"), rangeMeta),
        scope,
        rangeMeta,
      }),
    ],
  };
}

export default {
  DASHBOARD_RANGES,
  dashboardRangeMeta,
  buildDashboardVisualizations,
};
