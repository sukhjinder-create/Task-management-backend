import pool from "../db.js";

/**
 * Get last stored sync state
 */
export async function getIntegrationState(workspaceId, provider) {
  const { rows } = await pool.query(
    `
    SELECT state
    FROM integration_state
    WHERE workspace_id = $1
      AND provider = $2
    LIMIT 1
    `,
    [workspaceId, provider]
  );

  return rows[0]?.state || null;
}

/**
 * Save latest sync state
 */
export async function saveIntegrationState(
  workspaceId,
  provider,
  state
) {
  await pool.query(
    `
    INSERT INTO integration_state (workspace_id, provider, state)
    VALUES ($1, $2, $3)
    ON CONFLICT (workspace_id, provider)
    DO UPDATE SET
      state = EXCLUDED.state,
      updated_at = NOW()
    `,
    [workspaceId, provider, state]
  );
}
