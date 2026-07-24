import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { normalizeGrowthEvent } from "../growth/growthEvent.js";
import { matchProductGrowthEvent } from "../growth/growthProductTelemetry.middleware.js";
import {
  buildProductDiscoveryInsights,
  getProductDiscoveryReport,
  summarizeSessionFlows,
} from "../growth/productDiscovery.service.js";

test("pilot product telemetry accepts privacy-safe client events only", () => {
  const event = normalizeGrowthEvent({
    eventName: "product.search_performed",
    anonymousId: "anon-product-1",
    sessionId: "session-product-1",
    pagePath: "/search?q=private-customer-name",
    properties: {
      feature_name: "Workspace Search",
      search_scope: "all",
      query_length: 22,
      result_count: 4,
      query: "private-customer-name",
      prompt: "never collect this",
      message: "never collect this either",
    },
  }, { publicEvent: true });

  assert.equal(event.eventName, "product.search_performed");
  assert.equal(event.category, "engagement");
  assert.equal(event.pagePath, "/search");
  assert.deepEqual(event.properties, {
    feature_name: "Workspace Search",
    search_scope: "all",
    query_length: 22,
    result_count: 4,
  });
});

test("pilot telemetry still blocks forged product lifecycle milestones", () => {
  assert.throws(
    () => normalizeGrowthEvent({
      eventName: "product.task_created",
      anonymousId: "anon-product-2",
      sessionId: "session-product-2",
    }, { publicEvent: true }),
    /not accepted/
  );
});

test("product middleware captures discovery surfaces without recording failed requests", () => {
  assert.equal(matchProductGrowthEvent("GET", "/operations/search", 200)?.eventName, "product.search_performed");
  assert.equal(matchProductGrowthEvent("POST", "/operations/search/click", 200)?.eventName, "product.search_result_clicked");
  assert.equal(matchProductGrowthEvent("GET", "/adaptive/recommendations", 200)?.eventName, "product.recommendation_viewed");
  assert.equal(matchProductGrowthEvent("POST", "/adaptive/recommendations/rec-1/approve", 200)?.eventName, "product.recommendation_actioned");
  assert.equal(matchProductGrowthEvent("GET", "/adaptive/explain/recommendation/rec-1", 200)?.eventName, "product.explainability_opened");
  assert.equal(matchProductGrowthEvent("GET", "/adaptive/recommendations", 500), null);
});

test("product discovery insights identify ignored features, repeated use, friction, and recommendation trust", () => {
  const insights = buildProductDiscoveryInsights({
    overview: { product_events: 120, active_users: 6 },
    features: [
      { feature_name: "Adaptive Recommendations", views: 20, uses: 2, abandonments: 4, unique_users: 5, workspaces: 1 },
      { feature_name: "Tasks", views: 3, uses: 45, unique_users: 4, workspaces: 1, avg_duration_ms: 120000 },
    ],
    ai: { uses: 12, unique_users: 3, workspaces: 1, recommendation_events: 22, explainability_events: 1 },
    recommendations: { views: 20, actions: 2, unique_users: 5, workspaces: 1 },
    explainability: { opens: 1, unique_users: 1 },
    workflows: { views: 8, actions: 1, unique_users: 2, workspaces: 1 },
    dashboards: { views: 30, unique_users: 5 },
    search: { searches: 15, result_clicks: 2, avg_query_length: 11, avg_result_count: 6 },
    friction: [
      { feature_name: "Adaptive Recommendations", friction_events: 6, abandonments: 4, avg_hesitation_ms: 18000, avg_path_length: 14 },
    ],
    sessionFlows: [
      { session_id: "s1", step_count: 18, click_count: 20, friction_count: 1, path_sample: ["Dashboard", "Tasks", "Recommendations"] },
    ],
  });

  const types = new Set(insights.map((item) => item.type));
  assert.equal(types.has("ignored_feature"), true);
  assert.equal(types.has("repeatedly_used_feature"), true);
  assert.equal(types.has("confusing_workflow"), true);
  assert.equal(types.has("long_completion_path"), true);
  assert.equal(types.has("recommendation_usage"), true);
  assert.equal(insights[0].priority, "high");
});

test("session flow summary keeps aggregate paths and counts only", () => {
  const flows = summarizeSessionFlows([
    { event_name: "website.page_view", session_id: "s1", page_path: "/dashboard", occurred_at: "2026-07-01T10:00:00.000Z" },
    { event_name: "product.action_clicked", session_id: "s1", feature_name: "Tasks", occurred_at: "2026-07-01T10:00:10.000Z" },
    { event_name: "product.friction_detected", session_id: "s1", feature_name: "Tasks", occurred_at: "2026-07-01T10:00:20.000Z" },
  ]);

  assert.equal(flows.length, 1);
  assert.equal(flows[0].step_count, 3);
  assert.equal(flows[0].click_count, 1);
  assert.equal(flows[0].friction_count, 1);
  assert.deepEqual(flows[0].path_sample, ["/dashboard", "Tasks", "Tasks"]);
});

test("product discovery report composes dashboard-ready sections from database results", async () => {
  const responses = [
    { rows: [{ product_events: "40", active_users: "3", active_workspaces: "1", sessions: "4", feature_views: "12", feature_uses: "4", clicks: "8", friction_events: "1", abandonment_events: "1" }] },
    { rows: [{ feature_name: "Dashboard", total_events: "12", views: "10", uses: "2", clicks: "3", friction_events: "1", abandonments: "1", unique_users: "3", workspaces: "1" }] },
    { rows: [{ uses: "6", unique_users: "2", workspaces: "1", recommendation_events: "3", explainability_events: "1" }] },
    { rows: [{ views: "8", actions: "1", unique_users: "2", workspaces: "1" }] },
    { rows: [{ opens: "1", unique_users: "1", workspaces: "1" }] },
    { rows: [{ views: "2", actions: "1", unique_users: "1", workspaces: "1" }] },
    { rows: [{ views: "10", unique_users: "3", workspaces: "1" }] },
    { rows: [{ searches: "5", result_clicks: "1", unique_users: "2", workspaces: "1", avg_query_length: "9", avg_result_count: "4" }] },
    { rows: [{ feature_name: "Dashboard", friction_events: "1", abandonments: "1", unique_users: "1", avg_hesitation_ms: "12000", avg_path_length: "9", avg_duration_ms: "90000" }] },
    { rows: [
      { event_name: "website.page_view", session_id: "s1", page_path: "/dashboard", occurred_at: "2026-07-01T10:00:00.000Z" },
      { event_name: "product.action_clicked", session_id: "s1", feature_name: "Dashboard", occurred_at: "2026-07-01T10:00:20.000Z" },
    ] },
  ];
  let call = 0;
  const database = {
    query: async () => responses[call++] || { rows: [] },
  };

  const report = await getProductDiscoveryReport({ from: "2026-07-01", to: "2026-07-07" }, database);
  assert.equal(call, responses.length);
  assert.equal(report.range.days, 7);
  assert.equal(report.overview.product_events, 40);
  assert.equal(report.adoption.feature_adoption[0].feature_name, "Dashboard");
  assert.equal(report.friction.session_flows[0].step_count, 2);
  assert.equal(report.intelligence.weekly_insights_ready, true);
  assert.ok(report.insights.length >= 1);
});

test("product discovery migration is additive, indexed, and privacy documented", () => {
  const sql = fs.readFileSync(new URL("../migrations/20260702_enterprise_pilot_product_discovery.sql", import.meta.url), "utf8");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS growth_product_weekly_insights/);
  assert.match(sql, /UNIQUE \(week_start, insight_key\)/);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /Must not contain message text, prompt text, raw search query text/);
});
