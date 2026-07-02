import pool from "../db.js";
import { parseGrowthRange } from "./growthDashboard.service.js";

const DAY_MS = 86_400_000;

const VIEW_EVENTS = new Set([
  "product.feature_viewed",
  "product.dashboard_viewed",
  "product.recommendation_viewed",
  "product.workflow_viewed",
]);

const USE_EVENTS = new Set([
  "product.feature_used",
  "product.action_clicked",
  "product.search_performed",
  "product.search_result_clicked",
  "product.ai_used",
  "product.ai_feature_used",
  "product.recommendation_actioned",
  "product.explainability_opened",
  "product.workflow_actioned",
  "product.project_created",
  "product.task_created",
  "product.chat_message_sent",
  "product.huddle_created",
  "product.attendance_signed_in",
  "product.attendance_signed_out",
]);

const FRICTION_EVENTS = new Set([
  "product.friction_detected",
  "product.abandonment_detected",
]);

function numberRow(row = {}) {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => {
      if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value)) return [key, Number(value)];
      return [key, value];
    })
  );
}

function round(value, digits = 1) {
  const number = Number(value || 0);
  const factor = 10 ** digits;
  return Math.round(number * factor) / factor;
}

function percentage(part, total) {
  if (!total) return 0;
  return round((Number(part || 0) / Number(total || 0)) * 100, 1);
}

function safeFeatureName(row = {}) {
  return row.feature_name || row.surface || row.screen || "Unknown surface";
}

function insight({
  id,
  type,
  priority = "medium",
  title,
  summary,
  evidence = [],
  recommendation,
  confidence = 0.7,
}) {
  return {
    id,
    type,
    priority,
    title,
    summary,
    evidence,
    recommendation,
    confidence: round(confidence, 2),
    generator: "product_discovery_rules_v1",
  };
}

function sortByPriority(items) {
  const rank = { critical: 4, high: 3, medium: 2, low: 1 };
  return [...items].sort((a, b) => (rank[b.priority] || 0) - (rank[a.priority] || 0) || b.confidence - a.confidence);
}

export function summarizeSessionFlows(rows = []) {
  const bySession = new Map();
  for (const row of rows) {
    const sessionId = row.session_id || row.actor_user_id || row.anonymous_id || "unknown";
    if (!bySession.has(sessionId)) {
      bySession.set(sessionId, {
        session_id: sessionId,
        actor_user_id: row.actor_user_id || null,
        workspace_id: row.workspace_id || null,
        events: [],
        click_count: 0,
        friction_count: 0,
        abandonment_count: 0,
        first_seen_at: row.occurred_at,
        last_seen_at: row.occurred_at,
      });
    }
    const flow = bySession.get(sessionId);
    flow.events.push({
      event_name: row.event_name,
      page_path: row.page_path || null,
      feature_name: row.feature_name || null,
      occurred_at: row.occurred_at,
    });
    if (row.event_name === "product.action_clicked") flow.click_count += 1;
    if (row.event_name === "product.friction_detected") flow.friction_count += 1;
    if (row.event_name === "product.abandonment_detected") flow.abandonment_count += 1;
    flow.last_seen_at = row.occurred_at;
  }

  return [...bySession.values()]
    .map((flow) => {
      const first = new Date(flow.first_seen_at).getTime();
      const last = new Date(flow.last_seen_at).getTime();
      const path = flow.events
        .map((event) => event.feature_name || event.page_path || event.event_name)
        .filter(Boolean);
      return {
        session_id: flow.session_id,
        actor_user_id: flow.actor_user_id,
        workspace_id: flow.workspace_id,
        step_count: flow.events.length,
        click_count: flow.click_count,
        friction_count: flow.friction_count,
        abandonment_count: flow.abandonment_count,
        duration_ms: Number.isFinite(last - first) ? Math.max(0, last - first) : 0,
        path_sample: path.slice(0, 12),
      };
    })
    .sort((a, b) => b.step_count - a.step_count)
    .slice(0, 25);
}

export function buildProductDiscoveryInsights({
  overview = {},
  features = [],
  ai = {},
  recommendations = {},
  explainability = {},
  workflows = {},
  dashboards = {},
  search = {},
  friction = [],
  sessionFlows = [],
} = {}) {
  const insights = [];
  const activeUsers = Number(overview.active_users || 0);

  if (!Number(overview.product_events || 0)) {
    insights.push(insight({
      id: "pilot-telemetry-warming-up",
      type: "telemetry_readiness",
      priority: "low",
      title: "Pilot telemetry is ready but has not accumulated product usage yet",
      summary: "No product discovery events were found in the selected period.",
      evidence: ["0 product discovery events in the selected range."],
      recommendation: "Run the pilot with telemetry enabled for at least one full work week before prioritizing V2 changes.",
      confidence: 0.95,
    }));
    return insights;
  }

  for (const feature of features.slice(0, 20)) {
    const name = safeFeatureName(feature);
    const views = Number(feature.views || 0);
    const uses = Number(feature.uses || 0);
    const abandonments = Number(feature.abandonments || 0);
    const uniqueUsers = Number(feature.unique_users || 0);
    const useRate = percentage(uses, views);
    if (views >= 8 && useRate <= 20 && uses < views) {
      insights.push(insight({
        id: `ignored:${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
        type: "ignored_feature",
        priority: abandonments >= 3 ? "high" : "medium",
        title: `${name} is being viewed but not used enough`,
        summary: `${views} views produced ${uses} measured uses (${useRate}% view-to-use rate).`,
        evidence: [
          `${views} view event(s).`,
          `${uses} use/action event(s).`,
          `${abandonments} abandonment signal(s).`,
          `${uniqueUsers} unique authenticated user(s).`,
        ],
        recommendation: "Review discoverability, copy, permissions, and the first action users are expected to take on this surface.",
        confidence: views >= 20 ? 0.82 : 0.65,
      }));
    }
    if (uses >= 15 && uniqueUsers >= 2) {
      insights.push(insight({
        id: `repeated:${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
        type: "repeatedly_used_feature",
        priority: "low",
        title: `${name} is becoming a repeated work surface`,
        summary: `${uniqueUsers} users generated ${uses} use/action events.`,
        evidence: [
          `${uses} measured uses.`,
          `${Number(feature.workspaces || 0)} workspace(s).`,
          `${round(feature.avg_duration_ms || 0, 0)}ms average recorded surface duration.`,
        ],
        recommendation: "Treat this as a V2 retention anchor. Preserve its workflow and investigate adjacent repeated manual work before redesigning it.",
        confidence: uses >= 40 ? 0.86 : 0.68,
      }));
    }
  }

  const worstFriction = friction[0];
  if (worstFriction && Number(worstFriction.friction_events || 0) > 0) {
    const name = safeFeatureName(worstFriction);
    insights.push(insight({
      id: `friction:${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      type: "confusing_workflow",
      priority: Number(worstFriction.friction_events) >= 5 ? "high" : "medium",
      title: `${name} shows friction or hesitation`,
      summary: `${worstFriction.friction_events} friction signal(s), ${worstFriction.abandonments || 0} abandonment signal(s), and ${round(worstFriction.avg_hesitation_ms || 0, 0)}ms average hesitation.`,
      evidence: [
        `${worstFriction.friction_events} friction event(s).`,
        `${worstFriction.abandonments || 0} abandonment event(s).`,
        `${round(worstFriction.avg_path_length || 0, 1)} average path length.`,
      ],
      recommendation: "Watch real pilot sessions for this workflow before changing UI. Confirm whether users are waiting on data, searching for the next action, or hitting permission/plan friction.",
      confidence: Number(worstFriction.friction_events) >= 5 ? 0.82 : 0.66,
    }));
  }

  const longFlow = sessionFlows.find((flow) => flow.step_count >= 12 || flow.click_count >= 16);
  if (longFlow) {
    insights.push(insight({
      id: `long-path:${longFlow.session_id}`,
      type: "long_completion_path",
      priority: longFlow.friction_count ? "high" : "medium",
      title: "Some sessions require long paths or repeated clicking",
      summary: `A measured session reached ${longFlow.step_count} steps and ${longFlow.click_count} tracked clicks.`,
      evidence: [
        `${longFlow.step_count} session step(s).`,
        `${longFlow.click_count} click event(s).`,
        `Path sample: ${longFlow.path_sample.join(" → ")}`,
      ],
      recommendation: "Review this journey as a V2 candidate for shortcutting repeated manual work, not for redesigning the whole platform.",
      confidence: longFlow.step_count >= 18 ? 0.8 : 0.62,
    }));
  }

  const recommendationViews = Number(recommendations.views || 0);
  const recommendationActions = Number(recommendations.actions || 0);
  if (recommendationViews > 0) {
    const actionRate = percentage(recommendationActions, recommendationViews);
    insights.push(insight({
      id: "recommendation-usage",
      type: "recommendation_usage",
      priority: actionRate < 15 && recommendationViews >= 10 ? "high" : "medium",
      title: `Adaptive recommendation action rate is ${actionRate}%`,
      summary: `${recommendationViews} recommendation views produced ${recommendationActions} measured actions.`,
      evidence: [
        `${recommendationViews} recommendation view(s).`,
        `${recommendationActions} approve/reject/execute/feedback action(s).`,
        `${Number(recommendations.unique_users || 0)} unique user(s).`,
      ],
      recommendation: actionRate < 15
        ? "Review recommendation timing and clarity before increasing automation."
        : "Continue collecting accepted/rejected outcomes to identify high-trust recommendation categories.",
      confidence: recommendationViews >= 20 ? 0.82 : 0.63,
    }));
  }

  const explainOpens = Number(explainability.opens || 0);
  if (recommendationViews > 0 || explainOpens > 0) {
    const explainRate = percentage(explainOpens, Math.max(1, recommendationViews));
    insights.push(insight({
      id: "explainability-usage",
      type: "explainability_usage",
      priority: explainRate < 10 && recommendationViews >= 10 ? "medium" : "low",
      title: `Explainability is opened for ${explainRate}% of recommendation views`,
      summary: `${explainOpens} explainability opens were measured against ${recommendationViews} recommendation views.`,
      evidence: [
        `${explainOpens} explainability open event(s).`,
        `${Number(explainability.unique_users || 0)} unique user(s).`,
      ],
      recommendation: "Use this to decide whether explanations are trusted, ignored, or hidden too deeply during the pilot.",
      confidence: recommendationViews >= 10 ? 0.72 : 0.55,
    }));
  }

  const aiUses = Number(ai.uses || 0);
  if (aiUses > 0) {
    insights.push(insight({
      id: "ai-adoption",
      type: "ai_adoption",
      priority: "medium",
      title: `${aiUses} AI-assisted action(s) were measured`,
      summary: `${Number(ai.unique_users || 0)} users across ${Number(ai.workspaces || 0)} workspaces used AI-assisted surfaces.`,
      evidence: [
        `${aiUses} AI usage event(s).`,
        `${Number(ai.recommendation_events || 0)} recommendation-related event(s).`,
        `${Number(ai.explainability_events || 0)} explainability event(s).`,
      ],
      recommendation: "Compare AI-assisted usage with manual paths to discover where V2 should make intelligence more invisible.",
      confidence: aiUses >= 10 ? 0.78 : 0.6,
    }));
  }

  const searches = Number(search.searches || 0);
  if (searches > 0) {
    const clickRate = percentage(search.result_clicks, searches);
    insights.push(insight({
      id: "search-analytics",
      type: "search_analytics",
      priority: searches >= 10 && clickRate < 25 ? "medium" : "low",
      title: `Search result click-through is ${clickRate}%`,
      summary: `${searches} searches produced ${Number(search.result_clicks || 0)} result clicks.`,
      evidence: [
        `${round(search.avg_query_length || 0, 1)} average query length.`,
        `${round(search.avg_result_count || 0, 1)} average result count.`,
      ],
      recommendation: clickRate < 25
        ? "Inspect anonymized search scopes and result counts to find missing navigation or knowledge gaps."
        : "Search appears useful; evaluate which scopes produce the fastest successful result clicks.",
      confidence: searches >= 10 ? 0.74 : 0.56,
    }));
  }

  const workflowViews = Number(workflows.views || 0);
  const workflowActions = Number(workflows.actions || 0);
  if (workflowViews || workflowActions) {
    insights.push(insight({
      id: "workflow-usage",
      type: "workflow_usage",
      priority: workflowViews && percentage(workflowActions, workflowViews) < 20 ? "medium" : "low",
      title: "Workflow usage is measurable for pilot review",
      summary: `${workflowViews} workflow views and ${workflowActions} workflow actions were captured.`,
      evidence: [
        `${Number(workflows.unique_users || 0)} unique workflow user(s).`,
        `${Number(workflows.workspaces || 0)} workspace(s).`,
      ],
      recommendation: "Use pilot evidence to decide whether workflows are naturally adopted or should remain admin-only in V2.",
      confidence: 0.64,
    }));
  }

  const dashboardViews = Number(dashboards.views || 0);
  if (dashboardViews && activeUsers) {
    insights.push(insight({
      id: "dashboard-usage",
      type: "dashboard_usage",
      priority: "low",
      title: `${dashboardViews} dashboard view(s) across ${activeUsers} active user(s)`,
      summary: "Dashboard usage is available as a baseline for executive and daily-operational engagement.",
      evidence: [
        `${dashboardViews} dashboard view event(s).`,
        `${Number(dashboards.unique_users || 0)} dashboard user(s).`,
      ],
      recommendation: "Track whether dashboards start sessions or only serve as navigation pass-through before redesigning executive summaries.",
      confidence: 0.6,
    }));
  }

  return sortByPriority(insights).slice(0, 20);
}

function discoveryRange(query = {}) {
  if (query.from || query.to) return parseGrowthRange(query);
  const now = new Date();
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  const from = new Date(to.getTime() - 7 * DAY_MS);
  return { from: from.toISOString(), to: to.toISOString(), days: 7 };
}

export async function getProductDiscoveryReport(query = {}, database = pool) {
  const range = discoveryRange(query);
  const params = [range.from, range.to];

  const [
    overviewResult,
    featureResult,
    aiResult,
    recommendationResult,
    explainabilityResult,
    workflowResult,
    dashboardResult,
    searchResult,
    frictionResult,
    journeyResult,
  ] = await Promise.all([
    database.query(
      `SELECT
         count(*) FILTER (WHERE event_name LIKE 'product.%') AS product_events,
         count(DISTINCT actor_user_id) FILTER (WHERE actor_user_id IS NOT NULL) AS active_users,
         count(DISTINCT workspace_id) FILTER (WHERE workspace_id IS NOT NULL) AS active_workspaces,
         count(DISTINCT session_id) FILTER (WHERE session_id IS NOT NULL) AS sessions,
         count(*) FILTER (WHERE event_name = 'product.feature_viewed') AS feature_views,
         count(*) FILTER (WHERE event_name = 'product.feature_used') AS feature_uses,
         count(*) FILTER (WHERE event_name = 'product.action_clicked') AS clicks,
         count(*) FILTER (WHERE event_name = 'product.friction_detected') AS friction_events,
         count(*) FILTER (WHERE event_name = 'product.abandonment_detected') AS abandonment_events
       FROM growth_events
       WHERE occurred_at >= $1 AND occurred_at < $2`,
      params
    ),
    database.query(
      `SELECT
         COALESCE(NULLIF(properties->>'feature_name', ''), NULLIF(properties->>'surface', ''),
                  initcap(replace(replace(event_name, 'product.', ''), '_', ' '))) AS feature_name,
         count(*) AS total_events,
         count(*) FILTER (WHERE event_name = ANY('{product.feature_viewed,product.dashboard_viewed,product.recommendation_viewed,product.workflow_viewed}'::text[])) AS views,
         count(*) FILTER (WHERE event_name = ANY('{product.feature_used,product.action_clicked,product.search_performed,product.search_result_clicked,product.ai_used,product.ai_feature_used,product.recommendation_actioned,product.explainability_opened,product.workflow_actioned,product.project_created,product.task_created,product.chat_message_sent,product.huddle_created,product.attendance_signed_in,product.attendance_signed_out}'::text[])) AS uses,
         count(*) FILTER (WHERE event_name = 'product.action_clicked') AS clicks,
         count(*) FILTER (WHERE event_name = 'product.friction_detected') AS friction_events,
         count(*) FILTER (WHERE event_name = 'product.abandonment_detected') AS abandonments,
         count(DISTINCT actor_user_id) FILTER (WHERE actor_user_id IS NOT NULL) AS unique_users,
         count(DISTINCT workspace_id) FILTER (WHERE workspace_id IS NOT NULL) AS workspaces,
         avg(CASE WHEN properties->>'duration_ms' ~ '^[0-9]+(\\.[0-9]+)?$' THEN (properties->>'duration_ms')::numeric END) AS avg_duration_ms,
         avg(CASE WHEN properties->>'click_count' ~ '^[0-9]+(\\.[0-9]+)?$' THEN (properties->>'click_count')::numeric END) AS avg_click_count
       FROM growth_events
       WHERE occurred_at >= $1 AND occurred_at < $2
         AND event_name LIKE 'product.%'
       GROUP BY 1
       ORDER BY total_events DESC, feature_name ASC
       LIMIT 40`,
      params
    ),
    database.query(
      `SELECT
         count(*) AS uses,
         count(DISTINCT actor_user_id) FILTER (WHERE actor_user_id IS NOT NULL) AS unique_users,
         count(DISTINCT workspace_id) FILTER (WHERE workspace_id IS NOT NULL) AS workspaces,
         count(*) FILTER (WHERE event_name LIKE 'product.recommendation%') AS recommendation_events,
         count(*) FILTER (WHERE event_name = 'product.explainability_opened') AS explainability_events
       FROM growth_events
       WHERE occurred_at >= $1 AND occurred_at < $2
         AND event_name = ANY('{product.ai_used,product.ai_feature_used,product.recommendation_viewed,product.recommendation_actioned,product.explainability_opened}'::text[])`,
      params
    ),
    database.query(
      `SELECT
         count(*) FILTER (WHERE event_name = 'product.recommendation_viewed') AS views,
         count(*) FILTER (WHERE event_name = 'product.recommendation_actioned') AS actions,
         count(DISTINCT actor_user_id) FILTER (WHERE actor_user_id IS NOT NULL) AS unique_users,
         count(DISTINCT workspace_id) FILTER (WHERE workspace_id IS NOT NULL) AS workspaces
       FROM growth_events
       WHERE occurred_at >= $1 AND occurred_at < $2
         AND event_name IN ('product.recommendation_viewed', 'product.recommendation_actioned')`,
      params
    ),
    database.query(
      `SELECT
         count(*) AS opens,
         count(DISTINCT actor_user_id) FILTER (WHERE actor_user_id IS NOT NULL) AS unique_users,
         count(DISTINCT workspace_id) FILTER (WHERE workspace_id IS NOT NULL) AS workspaces
       FROM growth_events
       WHERE occurred_at >= $1 AND occurred_at < $2
         AND event_name = 'product.explainability_opened'`,
      params
    ),
    database.query(
      `SELECT
         count(*) FILTER (WHERE event_name = 'product.workflow_viewed') AS views,
         count(*) FILTER (WHERE event_name = 'product.workflow_actioned') AS actions,
         count(DISTINCT actor_user_id) FILTER (WHERE actor_user_id IS NOT NULL) AS unique_users,
         count(DISTINCT workspace_id) FILTER (WHERE workspace_id IS NOT NULL) AS workspaces
       FROM growth_events
       WHERE occurred_at >= $1 AND occurred_at < $2
         AND event_name IN ('product.workflow_viewed', 'product.workflow_actioned')`,
      params
    ),
    database.query(
      `SELECT
         count(*) AS views,
         count(DISTINCT actor_user_id) FILTER (WHERE actor_user_id IS NOT NULL) AS unique_users,
         count(DISTINCT workspace_id) FILTER (WHERE workspace_id IS NOT NULL) AS workspaces
       FROM growth_events
       WHERE occurred_at >= $1 AND occurred_at < $2
         AND event_name = 'product.dashboard_viewed'`,
      params
    ),
    database.query(
      `SELECT
         count(*) FILTER (WHERE event_name = 'product.search_performed') AS searches,
         count(*) FILTER (WHERE event_name = 'product.search_result_clicked') AS result_clicks,
         count(DISTINCT actor_user_id) FILTER (WHERE actor_user_id IS NOT NULL) AS unique_users,
         count(DISTINCT workspace_id) FILTER (WHERE workspace_id IS NOT NULL) AS workspaces,
         avg(CASE WHEN properties->>'query_length' ~ '^[0-9]+(\\.[0-9]+)?$' THEN (properties->>'query_length')::numeric END) AS avg_query_length,
         avg(CASE WHEN properties->>'result_count' ~ '^[0-9]+(\\.[0-9]+)?$' THEN (properties->>'result_count')::numeric END) AS avg_result_count
       FROM growth_events
       WHERE occurred_at >= $1 AND occurred_at < $2
         AND event_name IN ('product.search_performed', 'product.search_result_clicked')`,
      params
    ),
    database.query(
      `SELECT
         COALESCE(NULLIF(properties->>'feature_name', ''), NULLIF(properties->>'surface', ''),
                  COALESCE(page_path, 'Unknown surface')) AS feature_name,
         count(*) AS friction_events,
         count(*) FILTER (WHERE event_name = 'product.abandonment_detected') AS abandonments,
         count(DISTINCT actor_user_id) FILTER (WHERE actor_user_id IS NOT NULL) AS unique_users,
         avg(CASE WHEN properties->>'hesitation_ms' ~ '^[0-9]+(\\.[0-9]+)?$' THEN (properties->>'hesitation_ms')::numeric END) AS avg_hesitation_ms,
         avg(CASE WHEN properties->>'path_length' ~ '^[0-9]+(\\.[0-9]+)?$' THEN (properties->>'path_length')::numeric END) AS avg_path_length,
         avg(CASE WHEN properties->>'duration_ms' ~ '^[0-9]+(\\.[0-9]+)?$' THEN (properties->>'duration_ms')::numeric END) AS avg_duration_ms
       FROM growth_events
       WHERE occurred_at >= $1 AND occurred_at < $2
         AND event_name IN ('product.friction_detected', 'product.abandonment_detected')
       GROUP BY 1
       ORDER BY friction_events DESC, abandonments DESC
       LIMIT 20`,
      params
    ),
    database.query(
      `SELECT id, event_name, actor_user_id, anonymous_id, workspace_id, session_id,
              page_path, properties->>'feature_name' AS feature_name, occurred_at
       FROM growth_events
       WHERE occurred_at >= $1 AND occurred_at < $2
         AND (event_name LIKE 'product.%' OR event_name LIKE 'website.%')
       ORDER BY occurred_at ASC
       LIMIT 1200`,
      params
    ),
  ]);

  const overview = numberRow(overviewResult.rows[0]);
  const features = featureResult.rows.map(numberRow);
  const ai = numberRow(aiResult.rows[0]);
  const recommendations = numberRow(recommendationResult.rows[0]);
  const explainability = numberRow(explainabilityResult.rows[0]);
  const workflows = numberRow(workflowResult.rows[0]);
  const dashboards = numberRow(dashboardResult.rows[0]);
  const search = numberRow(searchResult.rows[0]);
  const friction = frictionResult.rows.map(numberRow);
  const sessionFlows = summarizeSessionFlows(journeyResult.rows.map(numberRow));
  const insights = buildProductDiscoveryInsights({
    overview,
    features,
    ai,
    recommendations,
    explainability,
    workflows,
    dashboards,
    search,
    friction,
    sessionFlows,
  });

  return {
    range: {
      from: range.from.slice(0, 10),
      to: new Date(new Date(range.to).getTime() - DAY_MS).toISOString().slice(0, 10),
      days: range.days,
    },
    generated_at: new Date().toISOString(),
    overview,
    adoption: {
      feature_adoption: features,
      ai_adoption: ai,
      recommendation_usage: recommendations,
      explainability_usage: explainability,
      workflow_usage: workflows,
      dashboard_usage: dashboards,
      search_analytics: search,
    },
    friction: {
      signals: friction,
      session_flows: sessionFlows,
    },
    insights,
    intelligence: {
      generator: "product_discovery_rules_v1",
      weekly_insights_ready: true,
      privacy_model: "privacy_minimized_allowlisted_properties_no_prompt_message_or_search_query_content",
    },
  };
}

export async function persistProductDiscoveryInsights(report, database = pool) {
  if (!report?.insights?.length) return { persisted: 0 };
  const weekStart = report.range?.from;
  const weekEnd = report.range?.to;
  let persisted = 0;
  for (const item of report.insights) {
    const result = await database.query(
      `INSERT INTO growth_product_weekly_insights
         (week_start, week_end, insight_key, insight_type, priority, title, summary,
          evidence, recommendation, confidence, generated_at)
       VALUES ($1::date, $2::date, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, now())
       ON CONFLICT (week_start, insight_key)
       DO UPDATE SET
         week_end = EXCLUDED.week_end,
         insight_type = EXCLUDED.insight_type,
         priority = EXCLUDED.priority,
         title = EXCLUDED.title,
         summary = EXCLUDED.summary,
         evidence = EXCLUDED.evidence,
         recommendation = EXCLUDED.recommendation,
         confidence = EXCLUDED.confidence,
         generated_at = now()`,
      [
        weekStart,
        weekEnd,
        item.id,
        item.type,
        item.priority,
        item.title,
        item.summary,
        JSON.stringify(item.evidence || []),
        item.recommendation,
        item.confidence,
      ]
    );
    persisted += result.rowCount;
  }
  return { persisted };
}
