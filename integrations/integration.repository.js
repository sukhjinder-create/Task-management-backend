// integrations/integration.repository.js

import pool from "../db.js";

/**
 * Save or update integration connection
 */
export async function upsertIntegration({
  workspaceId,
  provider,
  config = {},
}) {
  const result = await pool.query(
    `
    INSERT INTO workspace_integrations
      (workspace_id, provider, config)
    VALUES ($1, $2, $3)
    ON CONFLICT (workspace_id, provider)
    DO UPDATE SET
      config = EXCLUDED.config,
      status = 'connected',
      updated_at = NOW()
    RETURNING *;
    `,
    [workspaceId, provider, config]
  );

  return result.rows[0];
}

/**
 * Get integrations for a workspace
 */
export async function getWorkspaceIntegrations(workspaceId) {
  const result = await pool.query(
    `
    SELECT *
    FROM workspace_integrations
    WHERE workspace_id = $1
    `,
    [workspaceId]
  );

  return result.rows;
}

/**
 * Get single integration
 */
export async function getIntegration(workspaceId, provider) {
  const result = await pool.query(
    `
    SELECT *
    FROM workspace_integrations
    WHERE workspace_id = $1
      AND provider = $2
    LIMIT 1
    `,
    [workspaceId, provider]
  );

  return result.rows[0] || null;
}

/**
 * Get ALL active integrations (used on boot)
 */
export async function getAllActiveIntegrations() {
  const result = await pool.query(`
    SELECT *
    FROM workspace_integrations
    WHERE status = 'connected'
  `);

  return result.rows;
}