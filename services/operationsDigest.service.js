import pool from "../db.js";
import { notifyUser } from "./notification.service.js";
import { getDailyOperatingSystem } from "./operationsCommandCenter.service.js";
import { tableExists } from "./operationsShared.service.js";

function normalizeSections(value) {
  return Array.isArray(value) && value.length > 0
    ? value.map((item) => String(item).trim()).filter(Boolean)
    : ["priorities", "people", "approvals", "risks"];
}

function buildDigestSummary(dailyOs) {
  const priorities = dailyOs.now?.priorities || [];
  const peopleSignals = dailyOs.now?.peopleSignals || {};
  const approvals = dailyOs.now?.approvals || {};
  const reviewItems = dailyOs.watchlist?.reviews || [];
  const automation = dailyOs.watchlist?.automation || [];

  const lines = [
    dailyOs.headline,
    dailyOs.narrative,
    `Priorities: ${priorities.length} active focus item(s).`,
    `People: ${peopleSignals.onLeaveToday?.length || 0} on leave, ${peopleSignals.absentToday?.length || 0} absent.`,
    `Approvals: ${approvals.pendingOperationsActions || 0} operations action(s), ${approvals.pendingAutopilotActions || 0} autopilot action(s).`,
    `Watchlist: ${reviewItems.length} review item(s), ${automation.length} automation signal(s).`,
  ];

  return lines.join(" ");
}

export async function getDigestPreferences({ workspaceId, userId }) {
  const { rows } = await pool.query(
    `
    SELECT *
    FROM workspace_digest_preferences
    WHERE workspace_id = $1
      AND user_id = $2
    LIMIT 1
    `,
    [workspaceId, userId]
  );

  return rows[0] || {
    workspace_id: workspaceId,
    user_id: userId,
    enabled: true,
    frequency: "daily",
    delivery_hour: 8,
    channel: "in_app",
    include_sections: ["priorities", "people", "approvals", "risks"],
    last_sent_on: null,
  };
}

export async function upsertDigestPreferences({
  workspaceId,
  userId,
  enabled = true,
  frequency = "daily",
  deliveryHour = 8,
  channel = "in_app",
  includeSections = [],
}) {
  const { rows } = await pool.query(
    `
    INSERT INTO workspace_digest_preferences (
      workspace_id,
      user_id,
      enabled,
      frequency,
      delivery_hour,
      channel,
      include_sections
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
    ON CONFLICT (workspace_id, user_id)
    DO UPDATE SET
      enabled = EXCLUDED.enabled,
      frequency = EXCLUDED.frequency,
      delivery_hour = EXCLUDED.delivery_hour,
      channel = EXCLUDED.channel,
      include_sections = EXCLUDED.include_sections,
      updated_at = NOW()
    RETURNING *
    `,
    [
      workspaceId,
      userId,
      enabled,
      frequency,
      Math.min(Math.max(Number(deliveryHour) || 8, 0), 23),
      channel === "email" ? "email" : "in_app",
      JSON.stringify(normalizeSections(includeSections)),
    ]
  );

  return rows[0];
}

export async function generateWorkspaceDigest({
  workspaceId,
  userId,
  role,
  deliveryMode = "preview",
}) {
  const dailyOs = await getDailyOperatingSystem({ workspaceId, userId, role });
  const summary = buildDigestSummary(dailyOs);

  const { rows } = await pool.query(
    `
    INSERT INTO workspace_digest_runs (
      workspace_id,
      user_id,
      role_scope,
      digest_type,
      delivery_mode,
      summary,
      content,
      status
    )
    VALUES ($1,$2,$3,'daily_os',$4,$5,$6::jsonb,'generated')
    RETURNING *
    `,
    [workspaceId, userId, role, deliveryMode, summary, JSON.stringify(dailyOs)]
  );

  if (deliveryMode !== "preview") {
    await notifyUser({
      user_id: userId,
      type: "daily_digest",
      message: summary,
      workspaceId,
    });

    await pool.query(
      `
      UPDATE workspace_digest_preferences
      SET last_sent_on = CURRENT_DATE,
          updated_at = NOW()
      WHERE workspace_id = $1
        AND user_id = $2
      `,
      [workspaceId, userId]
    );
  }

  return {
    digest: rows[0],
    dailyOs,
  };
}

export async function listDigestHistory({ workspaceId, userId, role, limit = 20 }) {
  const params = [workspaceId];
  const conditions = [`workspace_id = $1`];
  let idx = 2;

  if (!(role === "admin" || role === "owner" || role === "manager")) {
    conditions.push(`user_id = $${idx}`);
    params.push(userId);
    idx += 1;
  }

  params.push(Math.min(Math.max(Number(limit) || 20, 1), 100));

  const { rows } = await pool.query(
    `
    SELECT *
    FROM workspace_digest_runs
    WHERE ${conditions.join(" AND ")}
    ORDER BY created_at DESC
    LIMIT $${idx}
    `,
    params
  );

  return rows;
}

export async function deliverDueDigests() {
  if (!(await tableExists("workspace_digest_preferences"))) {
    return { delivered: 0 };
  }

  const currentHour = new Date().getHours();
  const { rows: prefs } = await pool.query(
    `
    SELECT
      wdp.workspace_id,
      wdp.user_id,
      wdp.delivery_hour,
      u.role
    FROM workspace_digest_preferences wdp
    JOIN users u ON u.id = wdp.user_id
    WHERE wdp.enabled = TRUE
      AND wdp.frequency = 'daily'
      AND wdp.delivery_hour = $1
      AND (wdp.last_sent_on IS NULL OR wdp.last_sent_on < CURRENT_DATE)
    `,
    [currentHour]
  );

  let delivered = 0;
  for (const pref of prefs) {
    try {
      await generateWorkspaceDigest({
        workspaceId: pref.workspace_id,
        userId: pref.user_id,
        role: pref.role,
        deliveryMode: "scheduled",
      });
      delivered += 1;
    } catch (error) {
      console.error("[operations-digest] delivery failed", {
        workspaceId: pref.workspace_id,
        userId: pref.user_id,
        error: error.message,
      });
    }
  }

  return { delivered };
}
