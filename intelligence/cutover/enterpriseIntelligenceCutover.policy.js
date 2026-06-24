import pool from "../../db.js";

export const CUTOVER_MODES = Object.freeze({
  LEGACY: "legacy",
  UNIFIED: "unified",
  SHADOW: "shadow",
  ISOLATED_LEGACY: "isolated_legacy",
});

export const CORE_CUTOVER_SURFACES = Object.freeze([
  "dashboard_overview",
  "dashboard_executive_detail",
  "user_performance",
  "admin_insights",
  "coaching_effectiveness",
  "user_trend",
  "user_project_performance",
  "projects_health",
  "team_comparison",
  "workspace_dashboard",
  "workspace_health",
]);

export const ISOLATED_NON_CORE_SURFACES = Object.freeze([
  "okr_goal_health",
  "enterprise_specialty_profitability_oracle",
  "enterprise_specialty_resignation_radar",
  "enterprise_specialty_ghost_work",
  "enterprise_specialty_org_truth_map",
  "ai_task_deadline_risk",
]);

const DEFAULT_CORE_MODE = CUTOVER_MODES.LEGACY;
let controlTableExistsCache = null;

function nowIso() {
  return new Date().toISOString();
}

async function controlTableExists() {
  if (controlTableExistsCache !== null) return controlTableExistsCache;
  const { rows } = await pool.query(
    `SELECT EXISTS (
       SELECT 1
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = 'enterprise_intelligence_cutover_controls'
     ) AS exists`
  ).catch(() => ({ rows: [{ exists: false }] }));
  controlTableExistsCache = Boolean(rows[0]?.exists);
  return controlTableExistsCache;
}

function isolatedPolicy(surface) {
  return {
    surface,
    mode: CUTOVER_MODES.ISOLATED_LEGACY,
    selectedSource: "legacy_isolated_non_core",
    rolloutEligible: false,
    rollbackSupported: false,
    shadowSupported: false,
    policySource: "non_core_isolation_contract",
    reason: "Surface is explicitly excluded from core enterprise intelligence cutover.",
    evaluatedAt: nowIso(),
  };
}

function defaultPolicy(surface, policySource = "default_legacy_safe_mode") {
  return {
    surface,
    mode: DEFAULT_CORE_MODE,
    selectedSource: "legacy_scoring_rollback",
    rolloutEligible: CORE_CUTOVER_SURFACES.includes(surface),
    rollbackSupported: true,
    shadowSupported: true,
    policySource,
    reason: "No cutover control row matched; defaulting to legacy for staged rollout safety.",
    evaluatedAt: nowIso(),
  };
}

function rowPolicy(surface, row) {
  const mode = row?.mode || DEFAULT_CORE_MODE;
  return {
    surface,
    mode,
    selectedSource: mode === CUTOVER_MODES.UNIFIED ? "enterprise_intelligence" : "legacy_scoring_rollback",
    rolloutEligible: true,
    rollbackSupported: true,
    shadowSupported: true,
    policySource: row.workspace_id
      ? row.surface === surface ? "workspace_surface_control" : "workspace_all_core_control"
      : row.surface === surface ? "global_surface_control" : "global_all_core_control",
    reason: row.reason || null,
    metadata: row.metadata || {},
    updatedAt: row.updated_at || null,
    evaluatedAt: nowIso(),
  };
}

export async function resolveEnterpriseIntelligenceCutoverPolicy({ workspaceId, surface }) {
  if (ISOLATED_NON_CORE_SURFACES.includes(surface)) {
    return isolatedPolicy(surface);
  }

  if (!CORE_CUTOVER_SURFACES.includes(surface)) {
    return {
      ...defaultPolicy(surface, "unknown_surface_default"),
      rolloutEligible: false,
      rollbackSupported: false,
      shadowSupported: false,
    };
  }

  if (!(await controlTableExists())) {
    return defaultPolicy(surface, "control_table_missing");
  }

  const { rows } = await pool.query(
    `SELECT workspace_id::text, surface, mode, reason, metadata, updated_at
     FROM enterprise_intelligence_cutover_controls
     WHERE surface = ANY($2::text[])
       AND (workspace_id = $1::uuid OR workspace_id IS NULL)
     ORDER BY
       CASE WHEN workspace_id = $1::uuid THEN 0 ELSE 1 END,
       CASE WHEN surface = $3 THEN 0 ELSE 1 END,
       updated_at DESC
     LIMIT 1`,
    [workspaceId, [surface, "all_core"], surface]
  ).catch((err) => {
    console.error("[enterprise-intelligence-cutover] policy read failed:", err.message);
    return { rows: [] };
  });

  return rows[0] ? rowPolicy(surface, rows[0]) : defaultPolicy(surface);
}

export function setCutoverHeaders(res, policy) {
  if (!res || !policy) return;
  res.set("X-Enterprise-Intelligence-Mode", policy.mode);
  res.set("X-Enterprise-Intelligence-Surface", policy.surface);
  res.set("X-Enterprise-Intelligence-Source", policy.selectedSource);
  res.set("X-Enterprise-Intelligence-Policy", policy.policySource);
}

export function withCutoverMetadata(payload, policy, extra = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }
  return {
    ...payload,
    cutover: {
      ...(payload.cutover || {}),
      surface: policy.surface,
      mode: policy.mode,
      selectedSource: policy.selectedSource,
      policySource: policy.policySource,
      rolloutEligible: policy.rolloutEligible,
      rollbackSupported: policy.rollbackSupported,
      shadowSupported: policy.shadowSupported,
      evaluatedAt: policy.evaluatedAt,
      ...extra,
    },
  };
}

export async function listEnterpriseIntelligenceCutoverControls({ workspaceId }) {
  if (!(await controlTableExists())) {
    return {
      tableInstalled: false,
      defaultMode: DEFAULT_CORE_MODE,
      controls: [],
    };
  }

  const { rows } = await pool.query(
    `SELECT id::text, workspace_id::text, surface, mode, reason, metadata, updated_by::text, created_at, updated_at
     FROM enterprise_intelligence_cutover_controls
     WHERE workspace_id = $1 OR workspace_id IS NULL
     ORDER BY workspace_id NULLS LAST, surface ASC`,
    [workspaceId]
  );

  return {
    tableInstalled: true,
    defaultMode: DEFAULT_CORE_MODE,
    controls: rows,
  };
}

export async function upsertEnterpriseIntelligenceCutoverControl({
  workspaceId,
  surface,
  mode,
  reason = null,
  metadata = {},
  updatedBy = null,
  global = false,
}) {
  if (!CORE_CUTOVER_SURFACES.includes(surface) && surface !== "all_core") {
    const err = new Error(`Unsupported enterprise intelligence cutover surface: ${surface}`);
    err.code = "INVALID_CUTOVER_SURFACE";
    throw err;
  }
  if (![CUTOVER_MODES.LEGACY, CUTOVER_MODES.UNIFIED, CUTOVER_MODES.SHADOW].includes(mode)) {
    const err = new Error(`Unsupported enterprise intelligence cutover mode: ${mode}`);
    err.code = "INVALID_CUTOVER_MODE";
    throw err;
  }
  if (!(await controlTableExists())) {
    const err = new Error("Enterprise intelligence cutover controls table is not installed.");
    err.code = "INTELLIGENCE_CUTOVER_SCHEMA_MISSING";
    throw err;
  }

  const controlWorkspaceId = global ? null : workspaceId;
  const existing = await pool.query(
    `SELECT id
     FROM enterprise_intelligence_cutover_controls
     WHERE COALESCE(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid)
       = COALESCE($1::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
       AND surface = $2
     LIMIT 1`,
    [controlWorkspaceId, surface]
  );

  if (existing.rows[0]) {
    const { rows } = await pool.query(
      `UPDATE enterprise_intelligence_cutover_controls
       SET mode = $2,
           reason = $3,
           metadata = $4,
           updated_by = $5,
           updated_at = now()
       WHERE id = $1
       RETURNING id::text, workspace_id::text, surface, mode, reason, metadata, updated_by::text, created_at, updated_at`,
      [existing.rows[0].id, mode, reason, metadata, updatedBy]
    );
    return rows[0];
  }

  const { rows } = await pool.query(
    `INSERT INTO enterprise_intelligence_cutover_controls
       (workspace_id, surface, mode, reason, metadata, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id::text, workspace_id::text, surface, mode, reason, metadata, updated_by::text, created_at, updated_at`,
    [controlWorkspaceId, surface, mode, reason, metadata, updatedBy]
  );

  return rows[0];
}

export default {
  CUTOVER_MODES,
  CORE_CUTOVER_SURFACES,
  ISOLATED_NON_CORE_SURFACES,
  listEnterpriseIntelligenceCutoverControls,
  resolveEnterpriseIntelligenceCutoverPolicy,
  setCutoverHeaders,
  upsertEnterpriseIntelligenceCutoverControl,
  withCutoverMetadata,
};
