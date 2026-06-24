import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  DASHBOARD_RANGES,
  buildDashboardVisualizations,
  dashboardRangeMeta,
} from "../intelligence/analytics/dashboardChartContract.service.js";

const REQUIRED_RANGES = {
  "30d": "day",
  "90d": "week",
  "6m": "week",
  "1y": "month",
  all: "month",
};

function read(relativePath) {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

function rangeSeries() {
  return [
    point("2026-01-06", 68),
    point("2026-02-03", 70),
    point("2026-03-03", 73),
    point("2026-04-07", 75),
    point("2026-05-05", 78),
    point("2026-06-01", 80),
    point("2026-06-08", 81),
    point("2026-06-15", 83),
    point("2026-06-24", 84),
  ];
}

function sparseSeries() {
  return [point("2026-06-24", 84)];
}

function point(date, score) {
  return {
    date,
    score,
    payload: {
      indexes: {
        productivityIndex: score + 1,
        deliveryReliabilityIndex: score - 1,
      },
      risk: {
        probability: Math.max(0, 100 - score),
      },
      dimensions: {
        workSustainability: { score: score - 3 },
        deliveryEffectiveness: { score: score + 2 },
        executionReliability: {
          metrics: { commitmentCompletion: score - 2 },
        },
      },
    },
  };
}

const snapshot = {
  projects: [
    { projectId: "project-1", projectName: "Alpha", score: 82, completionRate: 76, completionConfidence: 80 },
    { projectId: "project-2", projectName: "Beta", score: 71, completionRate: 63, completionConfidence: 68 },
  ],
  teams: [
    { teamKey: "manager:1", managerName: "Delivery Team", score: 79 },
  ],
};

function assertLineChart(chart, { range, granularity, sparseExpected }) {
  assert.equal(chart.type, "line", `${chart.key} must be a line chart`);
  assert.equal(chart.range.value, range, `${chart.key} must carry applied range`);
  assert.equal(chart.granularity, granularity, `${chart.key} must carry expected granularity`);
  assert.equal(chart.dataKey, "value", `${chart.key} must use canonical value dataKey`);
  assert.equal(chart.axis.x.dataKey, "label", `${chart.key} must define x axis label`);
  assert.equal(chart.axis.y.dataKey, "value", `${chart.key} must define y axis value`);
  assert.equal(chart.series[0].dataKey, "value", `${chart.key} must define series dataKey`);
  assert.equal(chart.pointCount, chart.data.length, `${chart.key} pointCount must match data length`);
  assert.equal(chart.sparse, sparseExpected, `${chart.key} sparse flag mismatch`);

  for (const datum of chart.data) {
    assert.ok(datum.label, `${chart.key} datum must include label`);
    assert.ok(datum.bucketStart, `${chart.key} datum must include bucketStart`);
    assert.ok(datum.bucketEnd, `${chart.key} datum must include bucketEnd`);
    assert.equal(typeof datum.value, "number", `${chart.key} datum value must be numeric`);
  }
}

function assertRange(role, range, trendSeries, sparseExpected = false) {
  const meta = dashboardRangeMeta(range);
  const visualizations = buildDashboardVisualizations({
    role,
    trendSeries,
    snapshot,
    scopedProjects: snapshot.projects,
    rangeMeta: meta,
  });

  assert.equal(visualizations.range.value, range, `${role} visualizations must carry applied range`);
  assert.equal(visualizations.range.granularity, REQUIRED_RANGES[range], `${role} visualizations must carry expected range granularity`);

  const lineCharts = visualizations.charts.filter((chart) => chart.type === "line");
  assert.ok(lineCharts.length > 0, `${role} must expose line charts`);

  for (const chart of lineCharts) {
    assertLineChart(chart, {
      range,
      granularity: REQUIRED_RANGES[range],
      sparseExpected,
    });
  }

  return {
    role,
    range,
    granularity: meta.granularity,
    chartCount: visualizations.charts.length,
    lineChartCount: lineCharts.length,
    firstLinePointCount: lineCharts[0].pointCount,
    sparse: lineCharts.every((chart) => chart.sparse === true),
  };
}

const results = [];
const adapterSource = read("intelligence/analytics/unifiedDashboard.adapter.js");
const repositorySource = read("intelligence/repositories/unifiedIntelligence.repository.js");
const routeSource = read("routes/dashboard.routes.js");
const serviceSource = read("services/dashboard.service.js");

assert.ok(routeSource.includes("range: req.query.range"), "Dashboard route must pass range query into service");
assert.ok(serviceSource.includes("range = \"30d\""), "Dashboard service must default range safely");
assert.ok(adapterSource.includes("dashboardRange: rangeMeta"), "Dashboard response must expose applied range metadata");
assert.ok(adapterSource.includes("range: rangeMeta.value"), "Dashboard adapter must request historical series with applied range");

for (const range of Object.keys(REQUIRED_RANGES)) {
  assert.ok(DASHBOARD_RANGES[range], `${range} must be a supported dashboard range`);
  if (range === "all") {
    assert.equal(DASHBOARD_RANGES[range].days, null, "ALL must not use a fixed day limit");
    assert.ok(repositorySource.includes('range !== "all"'), "Repository history query must omit date limit for ALL");
  } else {
    assert.ok(repositorySource.includes(`"${range}": ${DASHBOARD_RANGES[range].days}`), `${range} must map to repository history window`);
  }
  results.push(assertRange("admin", range, rangeSeries()));
  results.push(assertRange("manager", range, rangeSeries()));
  results.push(assertRange("user", range, rangeSeries()));
  results.push(assertRange("user", range, sparseSeries(), true));
}

console.log("Dashboard range chart contract verification passed", {
  ranges: Object.keys(REQUIRED_RANGES),
  roles: ["admin", "manager", "user"],
  sample: results.slice(0, 5),
});
