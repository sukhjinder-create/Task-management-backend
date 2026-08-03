// integrations/sync/integration.syncConfig.repository.js
//
// Per-integration sync behaviour: how a provider stays current (webhook vs poll),
// how often it is reconciled, and which external projects are in scope.
//
// Before this, every connected integration in every workspace was polled in full
// every 60 seconds with no way to scope or tune it.

import pool from "../../db.js";

const DEFAULTS = Object.freeze({
  sync_mode: "webhook",
  reconcile_interval_minutes: 1440,
  scoped_project_ids: [],
});

// Mirrors the CHECK constraints in 20260803_universal_integrations.sql — kept in
// sync deliberately so a bad value is rejected with a clear message instead of a
// raw Postgres constraint violation.
export const MIN_RECONCILE_MINUTES = 5;
export const MAX_RECONCILE_MINUTES = 43200; // 30 days
export const SYNC_MODES = Object.freeze(["webhook", "poll", "manual", "disabled"]);

function toArray(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (value == null || value === "") return [];
  return [String(value)];
}

/** Config for one integration, falling back to defaults when no row exists yet. */
export async function getSyncConfig(workspaceId, provider) {
  const { rows } = await pool.query(
    `SELECT * FROM integration_sync_config WHERE workspace_id = $1 AND provider = $2 LIMIT 1`,
    [workspaceId, provider]
  );
  if (rows[0]) return rows[0];
  return { workspace_id: workspaceId, provider, ...DEFAULTS, next_reconcile_at: null };
}

export async function listSyncConfigs(workspaceId) {
  const { rows } = await pool.query(
    `SELECT * FROM integration_sync_config WHERE workspace_id = $1 ORDER BY provider`,
    [workspaceId]
  );
  return rows;
}

/**
 * Create or update an integration's sync configuration.
 * Only the keys present in `patch` are changed.
 */
export async function upsertSyncConfig({ workspaceId, provider, patch = {} }) {
  if (patch.syncMode !== undefined && !SYNC_MODES.includes(patch.syncMode)) {
    throw new Error(`Invalid sync mode: ${patch.syncMode}`);
  }
  if (patch.reconcileIntervalMinutes !== undefined) {
    const minutes = Number(patch.reconcileIntervalMinutes);
    if (!Number.isFinite(minutes) || minutes < MIN_RECONCILE_MINUTES || minutes > MAX_RECONCILE_MINUTES) {
      throw new Error(
        `Reconcile interval must be between ${MIN_RECONCILE_MINUTES} and ${MAX_RECONCILE_MINUTES} minutes`
      );
    }
  }

  const current = await getSyncConfig(workspaceId, provider);
  const syncMode = patch.syncMode ?? current.sync_mode;
  const interval = Number(patch.reconcileIntervalMinutes ?? current.reconcile_interval_minutes);
  const scoped = patch.scopedProjectIds !== undefined
    ? toArray(patch.scopedProjectIds)
    : toArray(current.scoped_project_ids);

  // Changing the cadence should take effect from now, not from whenever the
  // previously scheduled run happened to be.
  const intervalChanged = interval !== Number(current.reconcile_interval_minutes);
  const nextReconcileAt = ["webhook", "poll"].includes(syncMode)
    ? (intervalChanged || !current.next_reconcile_at
        ? new Date(Date.now() + interval * 60_000)
        : current.next_reconcile_at)
    : null;

  const { rows } = await pool.query(
    `
    INSERT INTO integration_sync_config
      (workspace_id, provider, sync_mode, reconcile_interval_minutes, scoped_project_ids, next_reconcile_at)
    VALUES ($1, $2, $3, $4, $5::jsonb, $6)
    ON CONFLICT (workspace_id, provider) DO UPDATE SET
      sync_mode = EXCLUDED.sync_mode,
      reconcile_interval_minutes = EXCLUDED.reconcile_interval_minutes,
      scoped_project_ids = EXCLUDED.scoped_project_ids,
      next_reconcile_at = EXCLUDED.next_reconcile_at,
      updated_at = NOW()
    RETURNING *
    `,
    [workspaceId, provider, syncMode, interval, JSON.stringify(scoped), nextReconcileAt]
  );
  return rows[0];
}

/** Remove config when an integration is disconnected. */
export async function deleteSyncConfig(workspaceId, provider) {
  await pool.query(
    `DELETE FROM integration_sync_config WHERE workspace_id = $1 AND provider = $2`,
    [workspaceId, provider]
  );
}

/**
 * Integrations whose reconciliation sweep is due.
 *
 * Claimed with FOR UPDATE SKIP LOCKED and immediately pushed forward so two app
 * instances can run this concurrently without double-reconciling — the same
 * pattern the adaptive event queue uses.
 */
export async function claimDueReconciliations({ limit = 5 } = {}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `
      WITH due AS (
        SELECT id FROM integration_sync_config
        WHERE sync_mode IN ('webhook', 'poll')
          AND next_reconcile_at IS NOT NULL
          AND next_reconcile_at <= NOW()
        ORDER BY next_reconcile_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT $1
      )
      UPDATE integration_sync_config c
      SET next_reconcile_at = NOW() + (c.reconcile_interval_minutes * interval '1 minute'),
          updated_at = NOW()
      FROM due
      WHERE c.id = due.id
      RETURNING c.*
      `,
      [Math.min(Math.max(Number(limit) || 5, 1), 50)]
    );
    await client.query("COMMIT");
    return rows;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function recordReconcileSuccess({ workspaceId, provider }) {
  await pool.query(
    `UPDATE integration_sync_config
     SET last_reconciled_at = NOW(), consecutive_failures = 0,
         last_error = NULL, last_error_at = NULL, updated_at = NOW()
     WHERE workspace_id = $1 AND provider = $2`,
    [workspaceId, provider]
  );
}

/**
 * Record a failed sweep and back off exponentially so a broken or revoked
 * integration stops hammering the provider (and our logs) every cycle.
 * Capped so it always recovers on its own once the provider comes back.
 */
export async function recordReconcileFailure({ workspaceId, provider, error }) {
  await pool.query(
    `UPDATE integration_sync_config
     SET consecutive_failures = consecutive_failures + 1,
         last_error = $3,
         last_error_at = NOW(),
         next_reconcile_at = NOW() + (
           LEAST(
             reconcile_interval_minutes * POWER(2, LEAST(consecutive_failures + 1, 5)),
             ${MAX_RECONCILE_MINUTES}
           ) * interval '1 minute'
         ),
         updated_at = NOW()
     WHERE workspace_id = $1 AND provider = $2`,
    [workspaceId, provider, String(error || "").slice(0, 2000)]
  );
}

/** Note that a webhook arrived — proof the real-time path is alive. */
export async function recordWebhookEvent({ workspaceId, provider }) {
  await pool.query(
    `UPDATE integration_sync_config
     SET last_event_at = NOW(), updated_at = NOW()
     WHERE workspace_id = $1 AND provider = $2`,
    [workspaceId, provider]
  );
}

/**
 * Is this external project in scope for background sync/webhooks?
 * An empty scope list means "everything", preserving pre-scoping behaviour.
 */
export function isProjectInScope(config, externalProjectId) {
  const scoped = toArray(config?.scoped_project_ids);
  if (!scoped.length) return true;
  return scoped.includes(String(externalProjectId));
}

export { DEFAULTS as SYNC_CONFIG_DEFAULTS };
