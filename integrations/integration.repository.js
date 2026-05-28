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
 * Get ALL active integrations (used by sync worker)
 * Uses a short statement_timeout so a slow DB can't stall the worker.
 */
export async function getAllActiveIntegrations() {
  const client = await pool.connect();
  try {
    await client.query("SET statement_timeout = '15s'");
    const result = await client.query(`
      SELECT *
      FROM workspace_integrations
      WHERE status = 'connected'
    `);
    return result.rows;
  } finally {
    client.release();
  }
}

/**
 * Mark a connected integration after a successful worker sync.
 */
export async function markIntegrationSynced({
  workspaceId,
  provider,
  syncedAt = new Date(),
}) {
  await pool.query(
    `
    UPDATE workspace_integrations
    SET
      last_synced_at = $3,
      updated_at = NOW()
    WHERE workspace_id = $1
      AND provider = $2
    `,
    [workspaceId, provider, syncedAt]
  );
}
