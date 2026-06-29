import pool from "../db.js";

const DAY_MS = 86_400_000;

export function parseGrowthRange(query = {}) {
  const today = new Date();
  const defaultTo = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 1));
  const defaultFrom = new Date(defaultTo.getTime() - 30 * DAY_MS);
  const from = query.from ? new Date(`${query.from}T00:00:00.000Z`) : defaultFrom;
  const toInclusive = query.to ? new Date(`${query.to}T00:00:00.000Z`) : new Date(defaultTo.getTime() - DAY_MS);
  const to = new Date(toInclusive.getTime() + DAY_MS);

  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from >= to) {
    throw new Error("Invalid growth date range");
  }
  const days = Math.ceil((to - from) / DAY_MS);
  if (days > 366) throw new Error("Growth date range cannot exceed 366 days");
  return { from: from.toISOString(), to: to.toISOString(), days };
}

function numberRow(row) {
  return Object.fromEntries(
    Object.entries(row || {}).map(([key, value]) => [
      key,
      typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value,
    ])
  );
}

function percentChange(current, previous) {
  if (!previous) return current ? 100 : 0;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

function buildInsights({ overview, funnel, featureAdoption, series }) {
  const insights = [];
  const top = featureAdoption[0];
  const low = featureAdoption.length > 1 ? featureAdoption[featureAdoption.length - 1] : null;
  if (top) {
    insights.push({
      id: "top-feature",
      severity: "positive",
      title: `${top.feature_name} leads feature adoption`,
      detail: `${top.unique_users} unique users generated ${top.uses} measured uses in this period.`,
      generator: "rules_v1",
    });
  }
  if (low && low.unique_users < top.unique_users) {
    insights.push({
      id: "low-feature",
      severity: "attention",
      title: `${low.feature_name} has the lowest measured adoption`,
      detail: `Only ${low.unique_users} unique users reached this feature. Review discovery, onboarding, and plan access.`,
      generator: "rules_v1",
    });
  }
  const drop = funnel.slice(1).reduce((largest, stage, index) => {
    const previous = funnel[index];
    const amount = Math.max(0, previous.count - stage.count);
    return !largest || amount > largest.amount ? { from: previous.label, to: stage.label, amount, rate: stage.conversion_from_previous } : largest;
  }, null);
  if (drop?.amount) {
    insights.push({
      id: "funnel-drop",
      severity: "attention",
      title: `Largest funnel drop: ${drop.from} to ${drop.to}`,
      detail: `${drop.amount} identities did not reach the next measured milestone (${drop.rate}% step conversion).`,
      generator: "rules_v1",
    });
  }
  insights.push({
    id: "returning-users",
    severity: overview.returning_user_percentage >= 30 ? "positive" : "neutral",
    title: `${overview.returning_user_percentage}% of active users returned`,
    detail: `${overview.returning_users} of ${overview.active_users} active users had product activity before this period.`,
    generator: "rules_v1",
  });
  if (series.length >= 2) {
    const latest = series[series.length - 1];
    const prior = series[series.length - 2];
    insights.push({
      id: "daily-growth",
      severity: latest.active_users >= prior.active_users ? "positive" : "neutral",
      title: `Daily active users ${latest.active_users >= prior.active_users ? "increased" : "decreased"}`,
      detail: `${prior.active_users} to ${latest.active_users} across the latest two measured days.`,
      generator: "rules_v1",
    });
  }
  return insights;
}

export async function getGrowthDashboard(query = {}, database = pool) {
  const range = parseGrowthRange(query);
  const previousFrom = new Date(new Date(range.from).getTime() - range.days * DAY_MS).toISOString();
  const params = [range.from, range.to, previousFrom];

  const [overviewResult, seriesResult, dimensionsResult, funnelResult, activationResult, adoptionResult, retentionResult, journeysResult] = await Promise.all([
    database.query(
      `WITH current_period AS (
         SELECT
           count(*) FILTER (WHERE event_name = 'website.page_view') AS page_views,
           count(DISTINCT session_id) FILTER (WHERE event_name = 'website.page_view') AS sessions,
           count(*) FILTER (WHERE event_name = 'product.signup_completed') AS signups,
           count(*) FILTER (WHERE event_name = 'product.login_attempt') AS login_attempts,
           count(*) FILTER (WHERE event_name = 'product.login_succeeded') AS successful_logins,
           count(DISTINCT actor_user_id) FILTER (WHERE actor_user_id IS NOT NULL) AS active_users,
           count(DISTINCT workspace_id) FILTER (WHERE workspace_id IS NOT NULL AND event_name LIKE 'product.%') AS active_workspaces
         FROM growth_events WHERE occurred_at >= $1 AND occurred_at < $2
       ), previous_period AS (
         SELECT
           count(*) FILTER (WHERE event_name = 'website.page_view') AS page_views,
           count(*) FILTER (WHERE event_name = 'product.signup_completed') AS signups,
           count(DISTINCT actor_user_id) FILTER (WHERE actor_user_id IS NOT NULL) AS active_users
         FROM growth_events WHERE occurred_at >= $3 AND occurred_at < $1
       ), returning_users_cte AS (
         SELECT count(DISTINCT current.actor_user_id) AS users
         FROM growth_events current
         WHERE current.occurred_at >= $1 AND current.occurred_at < $2
           AND current.actor_user_id IS NOT NULL
           AND EXISTS (
             SELECT 1 FROM growth_events previous
             WHERE previous.actor_user_id = current.actor_user_id AND previous.occurred_at < $1
           )
       )
       SELECT c.*, p.page_views AS previous_page_views, p.signups AS previous_signups,
              p.active_users AS previous_active_users, r.users AS returning_users
       FROM current_period c CROSS JOIN previous_period p CROSS JOIN returning_users_cte r`,
      params
    ),
    database.query(
      `WITH days AS (
         SELECT generate_series($1::date, ($2::timestamptz - interval '1 day')::date, interval '1 day')::date AS day
       ), daily AS (
         SELECT occurred_at::date AS day,
           count(*) FILTER (WHERE event_name = 'website.page_view') AS page_views,
           count(*) FILTER (WHERE event_name = 'product.signup_completed') AS signups,
           count(DISTINCT actor_user_id) FILTER (WHERE actor_user_id IS NOT NULL) AS active_users,
           count(DISTINCT workspace_id) FILTER (WHERE workspace_id IS NOT NULL AND event_name LIKE 'product.%') AS active_workspaces
         FROM growth_events WHERE occurred_at >= $1 AND occurred_at < $2 GROUP BY 1
       )
       SELECT to_char(days.day, 'YYYY-MM-DD') AS day,
              COALESCE(daily.page_views, 0) AS page_views,
              COALESCE(daily.signups, 0) AS signups,
              COALESCE(daily.active_users, 0) AS active_users,
              COALESCE(daily.active_workspaces, 0) AS active_workspaces
       FROM days LEFT JOIN daily USING (day) ORDER BY days.day`,
      params.slice(0, 2)
    ),
    database.query(
      `SELECT dimension, value, count(*) AS total
       FROM (
         SELECT 'traffic_sources' AS dimension, COALESCE(traffic_source, 'direct') AS value FROM growth_events WHERE event_name = 'website.page_view' AND occurred_at >= $1 AND occurred_at < $2
         UNION ALL
         SELECT 'top_pages', COALESCE(page_path, '/') FROM growth_events WHERE event_name = 'website.page_view' AND occurred_at >= $1 AND occurred_at < $2
         UNION ALL
         SELECT 'landing_pages', COALESCE(landing_page, page_path, '/') FROM growth_events WHERE event_name = 'website.page_view' AND occurred_at >= $1 AND occurred_at < $2
         UNION ALL
         SELECT 'referrers', COALESCE(referrer_host, 'Direct') FROM growth_events WHERE event_name = 'website.page_view' AND occurred_at >= $1 AND occurred_at < $2
         UNION ALL
         SELECT 'devices', COALESCE(device_type, 'unknown') FROM growth_events WHERE event_name = 'website.page_view' AND occurred_at >= $1 AND occurred_at < $2
         UNION ALL
         SELECT 'browsers', COALESCE(browser, 'Other') FROM growth_events WHERE event_name = 'website.page_view' AND occurred_at >= $1 AND occurred_at < $2
         UNION ALL
         SELECT 'countries', COALESCE(country_code, 'Unknown') FROM growth_events WHERE event_name = 'website.page_view' AND occurred_at >= $1 AND occurred_at < $2
       ) dimensions
       GROUP BY dimension, value
       ORDER BY dimension, total DESC`,
      params.slice(0, 2)
    ),
    database.query(
      `SELECT event_name,
         count(DISTINCT CASE
           WHEN event_name LIKE 'website.%' THEN COALESCE(anonymous_id, session_id, actor_user_id::text)
           ELSE COALESCE(workspace_id, actor_user_id::text, anonymous_id)
         END) AS count
       FROM growth_events
       WHERE occurred_at >= $1 AND occurred_at < $2
         AND event_name = ANY($3::text[])
       GROUP BY event_name`,
      [range.from, range.to, [
        "website.page_view", "product.signup_completed", "product.workspace_created",
        "product.project_created", "product.task_created", "product.team_member_added",
        "product.chat_message_sent", "product.huddle_created", "product.ai_used",
      ]]
    ),
    database.query(
      `SELECT count(*) AS count FROM (
         SELECT workspace_id
         FROM growth_events
         WHERE workspace_id IS NOT NULL
           AND event_name = ANY($3::text[])
         GROUP BY workspace_id
         HAVING count(DISTINCT event_name) = 3
            AND max(occurred_at) >= $1 AND max(occurred_at) < $2
       ) activated`,
      [range.from, range.to, ["product.project_created", "product.task_created", "product.team_member_added"]]
    ),
    database.query(
      `SELECT COALESCE(properties->>'feature_name', initcap(replace(split_part(event_name, '.', 2), '_', ' '))) AS feature_name,
              count(*) AS uses,
              count(DISTINCT actor_user_id) FILTER (WHERE actor_user_id IS NOT NULL) AS unique_users,
              count(DISTINCT workspace_id) FILTER (WHERE workspace_id IS NOT NULL) AS workspaces
       FROM growth_events
       WHERE occurred_at >= $1 AND occurred_at < $2 AND category = 'engagement'
       GROUP BY 1 ORDER BY uses DESC, feature_name ASC LIMIT 20`,
      params.slice(0, 2)
    ),
    database.query(
      `WITH weeks AS (
         SELECT generate_series(date_trunc('week', $1::timestamptz), date_trunc('week', $2::timestamptz - interval '1 day'), interval '1 week') AS week
       ), active AS (
         SELECT date_trunc('week', occurred_at) AS week,
                count(DISTINCT actor_user_id) AS active_users
         FROM growth_events
         WHERE occurred_at >= $1 AND occurred_at < $2 AND actor_user_id IS NOT NULL
         GROUP BY 1
       )
       SELECT to_char(weeks.week, 'YYYY-MM-DD') AS week, COALESCE(active.active_users, 0) AS active_users
       FROM weeks LEFT JOIN active USING (week) ORDER BY weeks.week`,
      params.slice(0, 2)
    ),
    database.query(
      `SELECT id, event_name, actor_user_id, anonymous_id, workspace_id, page_path,
              properties->>'feature_name' AS feature_name, occurred_at
       FROM growth_events
       WHERE occurred_at >= $1 AND occurred_at < $2
       ORDER BY occurred_at DESC LIMIT 60`,
      params.slice(0, 2)
    ),
  ]);

  const rawOverview = numberRow(overviewResult.rows[0]);
  const activeUsers = rawOverview.active_users || 0;
  const overview = {
    page_views: rawOverview.page_views || 0,
    sessions: rawOverview.sessions || 0,
    signups: rawOverview.signups || 0,
    login_attempts: rawOverview.login_attempts || 0,
    successful_logins: rawOverview.successful_logins || 0,
    active_users: activeUsers,
    active_workspaces: rawOverview.active_workspaces || 0,
    returning_users: rawOverview.returning_users || 0,
    returning_user_percentage: activeUsers ? Math.round((rawOverview.returning_users / activeUsers) * 1000) / 10 : 0,
    growth: {
      page_views: percentChange(rawOverview.page_views, rawOverview.previous_page_views),
      signups: percentChange(rawOverview.signups, rawOverview.previous_signups),
      active_users: percentChange(activeUsers, rawOverview.previous_active_users),
    },
  };

  const dimensions = { traffic_sources: [], top_pages: [], landing_pages: [], referrers: [], devices: [], browsers: [], countries: [] };
  for (const row of dimensionsResult.rows) {
    if (dimensions[row.dimension] && dimensions[row.dimension].length < 10) {
      dimensions[row.dimension].push({ label: row.value, value: Number(row.total) });
    }
  }

  const counts = new Map(funnelResult.rows.map((row) => [row.event_name, Number(row.count)]));
  const stages = [
    ["website.page_view", "Visitor"], ["product.signup_completed", "Signup"],
    ["product.workspace_created", "Workspace Created"], ["product.project_created", "First Project"],
    ["product.task_created", "First Task"], ["product.team_member_added", "First Team Member"],
    ["product.chat_message_sent", "First Chat"], ["product.huddle_created", "First Huddle"],
    ["product.ai_used", "AI Usage"], ["product.activation_reached", "Activation"],
  ];
  const funnel = stages.map(([eventName, label], index) => {
    const count = eventName === "product.activation_reached" ? Number(activationResult.rows[0]?.count || 0) : (counts.get(eventName) || 0);
    const previous = index ? (eventName === "product.activation_reached" ? (counts.get(stages[index - 1][0]) || 0) : null) : null;
    const previousCount = index ? (previous ?? (counts.get(stages[index - 1][0]) || 0)) : count;
    return { key: eventName, label, count, conversion_from_previous: index && previousCount ? Math.min(100, Math.round((count / previousCount) * 1000) / 10) : 100 };
  });

  const series = seriesResult.rows.map(numberRow);
  const featureAdoption = adoptionResult.rows.map(numberRow);
  return {
    range: { from: range.from.slice(0, 10), to: new Date(new Date(range.to).getTime() - DAY_MS).toISOString().slice(0, 10), days: range.days },
    overview,
    series,
    acquisition: dimensions,
    funnel,
    engagement: { feature_adoption: featureAdoption },
    retention: { weekly_active_users: retentionResult.rows.map(numberRow), returning_user_percentage: overview.returning_user_percentage },
    journeys: journeysResult.rows,
    insights: buildInsights({ overview, funnel, featureAdoption, series }),
    intelligence: { generator: "rules_v1", ai_extension_ready: true },
  };
}
