import pool from "../../db.js";
import {
  SCORING_CONFIG_VERSION,
  defaultScoringConfig,
  normalizeScoringConfig,
} from "../config/scoringConfig.model.js";

let schemaEnsured = false;

async function ensureScoringConfigTable() {
  if (schemaEnsured) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS enterprise_intelligence_scoring_configs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      config JSONB NOT NULL DEFAULT '{}'::jsonb,
      normalized_config JSONB NOT NULL DEFAULT '{}'::jsonb,
      config_version TEXT NOT NULL DEFAULT 'enterprise-scoring-weights-v1',
      updated_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (workspace_id)
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_enterprise_intelligence_scoring_configs_workspace
      ON enterprise_intelligence_scoring_configs(workspace_id, updated_at DESC)
  `);
  schemaEnsured = true;
}

function mapConfigRow(row, workspaceId) {
  const normalized = row?.normalized_config?.groups
    ? row.normalized_config
    : normalizeScoringConfig(row?.config || {}, defaultScoringConfig());
  return {
    ...normalized,
    workspaceId: row?.workspace_id || workspaceId || normalized.workspaceId || null,
    source: "enterprise_intelligence_scoring_config",
    version: row?.config_version || normalized.version || SCORING_CONFIG_VERSION,
    updatedAt: row?.updated_at || normalized.updatedAt || null,
    updatedBy: row?.updated_by || normalized.updatedBy || null,
    persisted: Boolean(row),
  };
}

export async function getWorkspaceScoringConfig({ workspaceId }) {
  await ensureScoringConfigTable();
  const { rows } = await pool.query(
    `SELECT *
     FROM enterprise_intelligence_scoring_configs
     WHERE workspace_id = $1
     LIMIT 1`,
    [workspaceId]
  );
  if (!rows[0]) {
    return {
      ...defaultScoringConfig(),
      workspaceId,
      persisted: false,
    };
  }
  return mapConfigRow(rows[0], workspaceId);
}

export async function upsertWorkspaceScoringConfig({ workspaceId, patch = {}, updatedBy = null }) {
  await ensureScoringConfigTable();
  const existing = await getWorkspaceScoringConfig({ workspaceId });
  const normalized = normalizeScoringConfig(
    {
      ...patch,
      workspaceId,
      updatedBy,
      updatedAt: new Date().toISOString(),
    },
    existing
  );

  const { rows } = await pool.query(
    `INSERT INTO enterprise_intelligence_scoring_configs
      (workspace_id, config, normalized_config, config_version, updated_by, updated_at)
     VALUES ($1, $2::jsonb, $3::jsonb, $4, $5, now())
     ON CONFLICT (workspace_id)
     DO UPDATE SET
       config = EXCLUDED.config,
       normalized_config = EXCLUDED.normalized_config,
       config_version = EXCLUDED.config_version,
       updated_by = EXCLUDED.updated_by,
       updated_at = now()
     RETURNING *`,
    [
      workspaceId,
      JSON.stringify(patch || {}),
      JSON.stringify(normalized),
      SCORING_CONFIG_VERSION,
      updatedBy,
    ]
  );

  return mapConfigRow(rows[0], workspaceId);
}

export default {
  getWorkspaceScoringConfig,
  upsertWorkspaceScoringConfig,
};
