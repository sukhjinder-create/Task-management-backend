import { evaluateAndPersistWorkspace } from "../intelligence/engine/unifiedIntelligence.engine.js";
import { getWorkspaceIntelligence } from "../intelligence/repositories/unifiedIntelligence.repository.js";
import { notifyUser } from "./notification.service.js";
import pool from "../db.js";

const HEALTH_WARN_THRESHOLD = 50;
const HEALTH_CAUTION_THRESHOLD = 65;

async function notifyAdminsIfNeeded(workspaceId, healthScore) {
  if (!Number.isFinite(healthScore) || healthScore >= HEALTH_CAUTION_THRESHOLD) {
    return;
  }

  try {
    const { rows: admins } = await pool.query(
      `SELECT id
       FROM users
       WHERE workspace_id = $1
         AND role = 'admin'
         AND (is_system IS NOT TRUE)`,
      [workspaceId]
    );

    const isCritical = healthScore < HEALTH_WARN_THRESHOLD;
    const level = isCritical ? "Critical" : "Caution";
    const message = `Workspace health ${level}: enterprise intelligence score is ${healthScore}%. Review risks, overdue work, and delivery confidence.`;

    for (const { id: adminId } of admins) {
      await notifyUser({
        user_id: adminId,
        type: "workspace_warning",
        message,
        workspaceId,
      });
    }
  } catch (err) {
    console.error("[notifications] workspace health warning failed:", err.message);
  }
}

export async function getWorkspaceHealthScore(workspaceId) {
  try {
    const intelligence = await getWorkspaceIntelligence({ workspaceId });
    return intelligence ? Number(intelligence.score) : null;
  } catch (err) {
    if (err?.code !== "42P01") {
      console.error("[enterprise-intelligence] workspace health read failed:", err.message);
    }
    return null;
  }
}

export async function recomputeWorkspaceHealth(workspaceId, { notify = true } = {}) {
  try {
    const intelligence = await evaluateAndPersistWorkspace({ workspaceId });
    const score = Number(intelligence?.score);
    if (!Number.isFinite(score)) {
      return null;
    }

    console.log("[enterprise-intelligence] Workspace health recomputed:", workspaceId, `-> ${score}%`);

    if (notify) {
      await notifyAdminsIfNeeded(workspaceId, score);
    }

    return score;
  } catch (err) {
    if (err?.code !== "INTELLIGENCE_SCHEMA_MISSING") {
      console.error("[enterprise-intelligence] workspace health recompute failed:", err.message);
    }
    return getWorkspaceHealthScore(workspaceId);
  }
}

export default {
  getWorkspaceHealthScore,
  recomputeWorkspaceHealth,
};
