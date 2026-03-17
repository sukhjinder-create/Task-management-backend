import pool from "../db.js";
import { notifyUser } from "./notification.service.js";

const HEALTH_WARN_THRESHOLD    = 50; // 🔴 critical
const HEALTH_CAUTION_THRESHOLD = 65; // 🟡 caution

export async function recomputeWorkspaceHealth(workspaceId) {
  try {

    // --------------------------------------------------
    // 1️⃣ INTERNAL TASK METRICS
    // --------------------------------------------------
    const internalResult = await pool.query(`
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE status = 'completed') AS completed
      FROM tasks
      WHERE workspace_id = $1
    `, [workspaceId]);

    const internalTotal =
      Number(internalResult.rows[0].total) || 0;

    const internalCompleted =
      Number(internalResult.rows[0].completed) || 0;


    // --------------------------------------------------
    // 2️⃣ EXTERNAL TASK INVENTORY (TOTAL WORKLOAD)
    // integration_entity_state = 1 row per external task
    // --------------------------------------------------
    const externalTotalResult = await pool.query(`
      SELECT COUNT(*) AS total
      FROM integration_entity_state
      WHERE workspace_id = $1
    `, [workspaceId]);

    const externalTotal =
      Number(externalTotalResult.rows[0].total) || 0;


    // --------------------------------------------------
    // 3️⃣ EXTERNAL COMPLETED TASKS
    // derived from execution signals
    // --------------------------------------------------
    const externalCompletedResult = await pool.query(`
      SELECT COUNT(DISTINCT external_id) AS completed
      FROM workspace_execution_signals
      WHERE workspace_id = $1
        AND signal_type = 'INTEGRATION_TASK_COMPLETED'
    `, [workspaceId]);

    const externalCompleted =
      Number(externalCompletedResult.rows[0].completed) || 0;


    // --------------------------------------------------
    // 4️⃣ COMBINED EXECUTION HEALTH
    // --------------------------------------------------
    const combinedTotal =
      internalTotal + externalTotal;

    const combinedCompleted =
      internalCompleted + externalCompleted;

    let healthScore = 70; // neutral baseline

    if (combinedTotal > 0) {
      healthScore = Math.round(
        (combinedCompleted / combinedTotal) * 100
      );
    }

    // clamp safety
    healthScore = Math.max(0, Math.min(100, healthScore));


    // --------------------------------------------------
    // 5️⃣ UPSERT HEALTH SCORE
    // --------------------------------------------------
    const result = await pool.query(`
      INSERT INTO workspace_health (workspace_id, health_score)
      VALUES ($1, $2)
      ON CONFLICT (workspace_id)
      DO UPDATE SET
        health_score = EXCLUDED.health_score,
        updated_at = NOW()
      RETURNING health_score
    `, [workspaceId, healthScore]);

    console.log(
      "💓 Workspace health recomputed:",
      workspaceId,
      `→ ${healthScore}%`
    );

    // ── Notify admins if health is in warning/critical zone ──────
    if (healthScore < HEALTH_CAUTION_THRESHOLD) {
      try {
        const { rows: admins } = await pool.query(
          `SELECT id FROM users
           WHERE workspace_id = $1
             AND role = 'admin'
             AND (is_system IS NOT TRUE)`,
          [workspaceId]
        );

        const isCritical = healthScore < HEALTH_WARN_THRESHOLD;
        const emoji   = isCritical ? "🔴" : "🟡";
        const level   = isCritical ? "Critical" : "Caution";
        const message = `${emoji} Workspace health ${level}: score dropped to ${healthScore}% — review overdue tasks and task completion rate`;

        for (const { id: adminId } of admins) {
          await notifyUser({
            user_id:     adminId,
            type:        "workspace_warning",
            message,
            workspaceId,
          });
        }
      } catch (notifErr) {
        console.error("[notifications] workspace health warning failed:", notifErr.message);
      }
    }

    return result.rows[0].health_score;

  } catch (err) {
    console.error("Workspace health recompute failed:", err);
    return 70;
  }
}