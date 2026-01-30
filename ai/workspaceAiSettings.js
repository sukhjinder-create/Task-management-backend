import pool from "../db.js";

export async function getWorkspaceAiSettings(workspaceId) {
  const { rows } = await pool.query(
    `
    SELECT ai_enabled, ai_auto_reply
    FROM workspace_ai_settings
    WHERE workspace_id = $1
    `,
    [workspaceId]
  );

  // Defaults (AI ON)
  return rows[0] || {
    ai_enabled: true,
    ai_auto_reply: true,
  };
}
