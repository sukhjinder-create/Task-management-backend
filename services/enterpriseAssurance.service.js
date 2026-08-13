import { createHash, randomUUID } from "crypto";
import pool from "../db.js";
import { logAudit } from "./audit.service.js";
import { notifyUser } from "./notification.service.js";
import {
  completeAssuranceCommitment,
  createAssuranceRecoveryTask,
  getAssuranceOverview,
} from "./executionAssurance.service.js";
import { queueImpactedIntelligenceRecalculation } from "../intelligence/realtime/recalculation.service.js";

const CONFIGURE_ROLES = new Set(["admin"]);
const MANAGER_ROLES = new Set(["admin", "manager"]);
const KNOWN_ROLES = new Set(["user", "manager", "admin"]);
const KNOWN_APPROVER_ROLES = new Set(["manager", "admin"]);
const APPROVAL_ACTIONS = new Set(["complete", "recovery"]);
const PORTFOLIO_STATUSES = new Set(["active", "completed", "archived"]);
const DEPENDENCY_TYPES = new Set(["blocks", "informs"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function queueAssuranceIntelligenceRefresh({ workspaceId, sourceId = null, metadata = {}, database = pool }) {
  // Tests and callers using an explicit transaction/fake database retain full
  // control over side effects. Production mutations use the coalesced canonical
  // intelligence queue after their authoritative write succeeds.
  if (database !== pool) return;
  queueImpactedIntelligenceRecalculation({
    workspaceId,
    reason: "outcome_assurance_changed",
    sourceType: "outcome_assurance",
    sourceId,
    metadata,
  });
}

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableJson(value[key])])
  );
}

export const DEFAULT_ASSURANCE_POLICY = Object.freeze({
  riskWindowDays: 14,
  requireResultEvidence: true,
  automaticExternalEvidence: true,
  notifyOnStateChange: true,
  minimumPatternSample: 3,
  approvalMatrix: {
    complete: {
      requestRoles: ["user", "manager", "admin"],
      approveRoles: ["manager", "admin"],
    },
    recovery: {
      requestRoles: ["manager", "admin"],
      approveRoles: ["manager", "admin"],
    },
    evidence: {
      writeRoles: ["user", "manager", "admin"],
    },
  },
});

function httpError(message, statusCode = 400, code = "ASSURANCE_INVALID_REQUEST") {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function cleanText(value, maxLength, { required = false, label = "Value" } = {}) {
  const text = typeof value === "string" ? value.trim() : "";
  if (required && !text) throw httpError(`${label} is required`);
  if (text.length > maxLength) throw httpError(`${label} must be ${maxLength} characters or fewer`);
  return text || null;
}

function uuidValue(value, label = "Identifier") {
  const normalized = cleanText(value, 100, { required: true, label });
  if (!UUID.test(normalized)) throw httpError(`${label} is not valid`);
  return normalized;
}

function dateValue(value, label = "Date") {
  if (value == null || value === "") return null;
  const normalized = String(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized) || !Number.isFinite(Date.parse(`${normalized}T00:00:00Z`))) {
    throw httpError(`${label} is not valid`);
  }
  return normalized;
}

function boundedInteger(value, fallback, minimum, maximum, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw httpError(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed ?? fallback;
}

function booleanValue(value, label) {
  if (typeof value !== "boolean") throw httpError(`${label} must be true or false`);
  return value;
}

function normalizeRoleList(value, fallback) {
  if (!Array.isArray(value)) return [...fallback];
  const roles = [...new Set(value.map((role) => String(role || "").toLowerCase()).filter((role) => KNOWN_ROLES.has(role)))];
  return roles.length ? roles : [...fallback];
}

function normalizeApproverRoleList(value, fallback) {
  if (!Array.isArray(value)) return [...fallback];
  const roles = [...new Set(value.map((role) => String(role || "").toLowerCase()).filter((role) => KNOWN_APPROVER_ROLES.has(role)))];
  return roles.length ? roles : [...fallback];
}

function mapPolicy(row = null) {
  const matrix = row?.approval_matrix && typeof row.approval_matrix === "object"
    ? row.approval_matrix
    : DEFAULT_ASSURANCE_POLICY.approvalMatrix;
  return {
    riskWindowDays: Number(row?.risk_window_days ?? DEFAULT_ASSURANCE_POLICY.riskWindowDays),
    // Verification without result evidence would make the assurance contract
    // self-contradictory. This is an invariant, not a tenant toggle.
    requireResultEvidence: true,
    automaticExternalEvidence: row?.automatic_external_evidence ?? DEFAULT_ASSURANCE_POLICY.automaticExternalEvidence,
    notifyOnStateChange: row?.notify_on_state_change ?? DEFAULT_ASSURANCE_POLICY.notifyOnStateChange,
    minimumPatternSample: Number(row?.minimum_pattern_sample ?? DEFAULT_ASSURANCE_POLICY.minimumPatternSample),
    approvalMatrix: {
      complete: {
        requestRoles: normalizeRoleList(matrix.complete?.requestRoles, DEFAULT_ASSURANCE_POLICY.approvalMatrix.complete.requestRoles),
        approveRoles: normalizeApproverRoleList(matrix.complete?.approveRoles, DEFAULT_ASSURANCE_POLICY.approvalMatrix.complete.approveRoles),
      },
      recovery: {
        requestRoles: normalizeRoleList(matrix.recovery?.requestRoles, DEFAULT_ASSURANCE_POLICY.approvalMatrix.recovery.requestRoles),
        approveRoles: normalizeApproverRoleList(matrix.recovery?.approveRoles, DEFAULT_ASSURANCE_POLICY.approvalMatrix.recovery.approveRoles),
      },
      evidence: {
        writeRoles: normalizeRoleList(matrix.evidence?.writeRoles, DEFAULT_ASSURANCE_POLICY.approvalMatrix.evidence.writeRoles),
      },
    },
    version: Number(row?.version || 1),
    updatedAt: row?.updated_at || null,
  };
}

export function normalizeAssurancePolicy(input = {}, current = DEFAULT_ASSURANCE_POLICY) {
  const matrix = input.approvalMatrix || input.approval_matrix || current.approvalMatrix;
  return {
    riskWindowDays: boundedInteger(
      input.riskWindowDays ?? input.risk_window_days ?? current.riskWindowDays,
      current.riskWindowDays, 1, 90, "Risk window"
    ),
    requireResultEvidence: true,
    automaticExternalEvidence: booleanValue(
      input.automaticExternalEvidence ?? input.automatic_external_evidence ?? current.automaticExternalEvidence,
      "Automatic external evidence"
    ),
    notifyOnStateChange: booleanValue(
      input.notifyOnStateChange ?? input.notify_on_state_change ?? current.notifyOnStateChange,
      "State-change notifications"
    ),
    minimumPatternSample: boundedInteger(
      input.minimumPatternSample ?? input.minimum_pattern_sample ?? current.minimumPatternSample,
      current.minimumPatternSample, 3, 100, "Minimum learning sample"
    ),
    approvalMatrix: {
      complete: {
        requestRoles: normalizeRoleList(matrix.complete?.requestRoles, current.approvalMatrix.complete.requestRoles),
        approveRoles: normalizeApproverRoleList(matrix.complete?.approveRoles, current.approvalMatrix.complete.approveRoles),
      },
      recovery: {
        requestRoles: normalizeApproverRoleList(matrix.recovery?.requestRoles, current.approvalMatrix.recovery.requestRoles),
        approveRoles: normalizeApproverRoleList(matrix.recovery?.approveRoles, current.approvalMatrix.recovery.approveRoles),
      },
      evidence: {
        writeRoles: normalizeRoleList(matrix.evidence?.writeRoles, current.approvalMatrix.evidence.writeRoles),
      },
    },
  };
}

export async function getAssurancePolicy(workspaceId, database = pool) {
  const { rows } = await database.query(
    "SELECT * FROM assurance_workspace_policies WHERE workspace_id = $1 LIMIT 1",
    [workspaceId]
  );
  return mapPolicy(rows[0]);
}

export async function updateAssurancePolicy({ workspaceId, actorId, role, input, database = pool }) {
  if (!CONFIGURE_ROLES.has(String(role || "").toLowerCase())) {
    throw httpError("Workspace admin access is required", 403, "ASSURANCE_FORBIDDEN");
  }
  const current = await getAssurancePolicy(workspaceId, database);
  const value = normalizeAssurancePolicy(input, current);
  const { rows } = await database.query(
    `
    INSERT INTO assurance_workspace_policies (
      workspace_id, risk_window_days, require_result_evidence,
      automatic_external_evidence, notify_on_state_change,
      minimum_pattern_sample, approval_matrix, updated_by
    ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
    ON CONFLICT (workspace_id) DO UPDATE SET
      risk_window_days = EXCLUDED.risk_window_days,
      require_result_evidence = EXCLUDED.require_result_evidence,
      automatic_external_evidence = EXCLUDED.automatic_external_evidence,
      notify_on_state_change = EXCLUDED.notify_on_state_change,
      minimum_pattern_sample = EXCLUDED.minimum_pattern_sample,
      approval_matrix = EXCLUDED.approval_matrix,
      version = assurance_workspace_policies.version + 1,
      updated_by = EXCLUDED.updated_by,
      updated_at = now()
    RETURNING *
    `,
    [
      workspaceId,
      value.riskWindowDays,
      Boolean(value.requireResultEvidence),
      Boolean(value.automaticExternalEvidence),
      Boolean(value.notifyOnStateChange),
      value.minimumPatternSample,
      JSON.stringify(value.approvalMatrix),
      actorId,
    ]
  );
  await logAudit({
    workspaceId,
    userId: actorId,
    action: "assurance.policy.update",
    entityType: "workspace",
    entityId: workspaceId,
    oldValue: current,
    newValue: value,
  });
  queueAssuranceIntelligenceRefresh({
    workspaceId,
    sourceId: workspaceId,
    metadata: { change: "policy", policyVersion: Number(rows[0]?.version || 1) },
    database,
  });
  return mapPolicy(rows[0]);
}

function roleAllowed(policy, action, permission, role) {
  return (policy.approvalMatrix?.[action]?.[permission] || []).includes(String(role || "").toLowerCase());
}

export async function assertAssuranceApprover({ workspaceId, role, action, database = pool }) {
  if (!APPROVAL_ACTIONS.has(action)) throw httpError("Approval action is not supported");
  const policy = await getAssurancePolicy(workspaceId, database);
  if (!roleAllowed(policy, action, "approveRoles", role)) {
    throw httpError("Your workspace policy requires approval from another role", 403, "ASSURANCE_APPROVAL_REQUIRED");
  }
  return policy;
}

export async function assertAssuranceEvidenceWriter({ workspaceId, role, database = pool }) {
  const policy = await getAssurancePolicy(workspaceId, database);
  if (!roleAllowed(policy, "evidence", "writeRoles", role)) {
    throw httpError("Your workspace policy does not allow this role to record evidence", 403, "ASSURANCE_FORBIDDEN");
  }
  return policy;
}

async function requireOutcome({ workspaceId, goalId, userId, role, database = pool, policy = null }) {
  const overview = await getAssuranceOverview({ workspaceId, userId, role, database, policy });
  const outcome = overview.commitments.find((item) => String(item.id) === String(goalId));
  if (!outcome) throw httpError("Outcome not found", 404, "ASSURANCE_NOT_FOUND");
  return outcome;
}

export async function getAssurancePortfolio({ workspaceId, userId, role, database = pool, now = new Date() }) {
  if (!MANAGER_ROLES.has(String(role || "").toLowerCase())) {
    throw httpError("Manager access is required", 403, "ASSURANCE_FORBIDDEN");
  }
  const policy = await getAssurancePolicy(workspaceId, database);
  const overview = await getAssuranceOverview({ workspaceId, userId, role, database, now, policy });
  const visibleGoalIds = overview.commitments.map((item) => item.id);
  const [portfolioResult, linkResult, dependencyResult] = await Promise.all([
    database.query(
      `SELECT p.*, u.username AS owner_name
       FROM assurance_portfolios p
       LEFT JOIN users u ON u.id = p.owner_id AND u.workspace_id = p.workspace_id
       WHERE p.workspace_id = $1 AND p.status != 'archived'
         AND (
           $2='admin'
           OR p.owner_id=$3
           OR EXISTS (
             SELECT 1 FROM assurance_portfolio_goals visible_link
             WHERE visible_link.workspace_id=p.workspace_id
               AND visible_link.portfolio_id=p.id
               AND visible_link.goal_id=ANY($4::uuid[])
           )
         )
       ORDER BY p.target_date ASC NULLS LAST, p.created_at ASC`,
      [workspaceId, String(role || "").toLowerCase(), userId, visibleGoalIds]
    ),
    database.query(
      `SELECT portfolio_id, goal_id FROM assurance_portfolio_goals
       WHERE workspace_id=$1 AND goal_id=ANY($2::uuid[])`,
      [workspaceId, visibleGoalIds]
    ),
    database.query(
      `SELECT d.*, predecessor.title AS predecessor_title, successor.title AS successor_title,
              predecessor.status AS predecessor_status, predecessor.primary_project_id AS predecessor_project_id,
              successor.primary_project_id AS successor_project_id
       FROM assurance_goal_dependencies d
       JOIN okr_objectives predecessor
         ON predecessor.workspace_id = d.workspace_id AND predecessor.id = d.predecessor_goal_id
       JOIN okr_objectives successor
         ON successor.workspace_id = d.workspace_id AND successor.id = d.successor_goal_id
       WHERE d.workspace_id=$1
         AND d.predecessor_goal_id=ANY($2::uuid[])
         AND d.successor_goal_id=ANY($2::uuid[])
       ORDER BY d.created_at ASC`,
      [workspaceId, visibleGoalIds]
    ),
  ]);

  const byId = new Map(overview.commitments.map((item) => [String(item.id), item]));
  const links = new Map();
  for (const link of linkResult.rows) {
    const goal = byId.get(String(link.goal_id));
    if (!goal) continue;
    if (!links.has(String(link.portfolio_id))) links.set(String(link.portfolio_id), []);
    links.get(String(link.portfolio_id)).push(goal);
  }
  const portfolios = portfolioResult.rows.map((portfolio) => {
    const commitments = links.get(String(portfolio.id)) || [];
    return {
      ...portfolio,
      canManage: String(role || "").toLowerCase() === "admin" || String(portfolio.owner_id) === String(userId),
      commitments,
      summary: {
        total: commitments.length,
        verified: commitments.filter((item) => item.assurance.state === "verified").length,
        needsAttention: commitments.filter((item) => ["at_risk", "off_track", "needs_evidence"].includes(item.assurance.state)).length,
      },
    };
  }).filter((portfolio) => (
    String(role || "").toLowerCase() === "admin"
    || String(portfolio.owner_id) === String(userId)
    || portfolio.commitments.length > 0
  ));
  return {
    generatedAt: now.toISOString(),
    portfolios,
    dependencies: dependencyResult.rows,
    availableCommitments: overview.commitments,
  };
}

async function assertActiveWorkspaceUser(workspaceId, userId, database = pool) {
  const { rows } = await database.query(
    `SELECT u.id FROM users u
     JOIN workspace_users wu ON wu.user_id = u.id AND wu.workspace_id = $1
     WHERE u.id = $2 AND u.workspace_id = $1 AND wu.billing_status != 'pending'
       AND COALESCE(u.is_system, FALSE) = FALSE AND u.role != 'system' LIMIT 1`,
    [workspaceId, userId]
  );
  if (!rows[0]) throw httpError("Owner is not an active workspace member");
}

export async function createAssurancePortfolio({ workspaceId, actorId, role, input, database = pool }) {
  if (!MANAGER_ROLES.has(String(role || "").toLowerCase())) throw httpError("Manager access is required", 403, "ASSURANCE_FORBIDDEN");
  const name = cleanText(input.name, 200, { required: true, label: "Portfolio name" });
  const description = cleanText(input.description, 2000, { label: "Description" });
  const ownerId = String(role || "").toLowerCase() === "admin"
    ? (input.ownerId || input.owner_id || actorId)
    : actorId;
  const targetDate = dateValue(input.targetDate ?? input.target_date, "Target date");
  await assertActiveWorkspaceUser(workspaceId, ownerId, database);
  const { rows } = await database.query(
    `INSERT INTO assurance_portfolios (workspace_id, name, description, owner_id, target_date, created_by)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [workspaceId, name, description, ownerId, targetDate, actorId]
  );
  await logAudit({ workspaceId, userId: actorId, action: "assurance.portfolio.create", entityType: "assurance_portfolio", entityId: rows[0].id, newValue: { name, ownerId, targetDate } });
  return rows[0];
}

export async function updateAssurancePortfolio({ id, workspaceId, actorId, role, input, database = pool }) {
  if (!MANAGER_ROLES.has(String(role || "").toLowerCase())) throw httpError("Manager access is required", 403, "ASSURANCE_FORBIDDEN");
  const portfolioId = uuidValue(id, "Portfolio");
  const { rows: existing } = await database.query("SELECT * FROM assurance_portfolios WHERE id = $1 AND workspace_id = $2", [portfolioId, workspaceId]);
  if (!existing[0]) throw httpError("Portfolio not found", 404, "ASSURANCE_NOT_FOUND");
  if (String(role || "").toLowerCase() === "manager" && String(existing[0].owner_id) !== String(actorId)) {
    throw httpError("Managers can update only portfolios they own", 403, "ASSURANCE_FORBIDDEN");
  }
  const status = String(input.status ?? existing[0].status).toLowerCase();
  if (!PORTFOLIO_STATUSES.has(status)) throw httpError("Portfolio status is not supported");
  const ownerId = String(role || "").toLowerCase() === "admin"
    ? (input.ownerId ?? input.owner_id ?? existing[0].owner_id)
    : actorId;
  if (ownerId) await assertActiveWorkspaceUser(workspaceId, ownerId, database);
  const { rows } = await database.query(
    `UPDATE assurance_portfolios SET name=$1, description=$2, owner_id=$3, target_date=$4, status=$5, updated_at=now()
     WHERE id=$6 AND workspace_id=$7 RETURNING *`,
    [
      cleanText(input.name ?? existing[0].name, 200, { required: true, label: "Portfolio name" }),
      cleanText(input.description ?? existing[0].description, 2000, { label: "Description" }),
      ownerId,
      dateValue(input.targetDate ?? input.target_date ?? existing[0].target_date, "Target date"),
      status,
      portfolioId,
      workspaceId,
    ]
  );
  await logAudit({ workspaceId, userId: actorId, action: "assurance.portfolio.update", entityType: "assurance_portfolio", entityId: portfolioId, oldValue: existing[0], newValue: rows[0] });
  return rows[0];
}

export async function setPortfolioCommitment({ portfolioId, goalId, workspaceId, actorId, role, linked = true, database = pool }) {
  if (!MANAGER_ROLES.has(String(role || "").toLowerCase())) throw httpError("Manager access is required", 403, "ASSURANCE_FORBIDDEN");
  const validPortfolioId = uuidValue(portfolioId, "Portfolio");
  const validGoalId = uuidValue(goalId, "Outcome");
  await requireOutcome({ workspaceId, goalId: validGoalId, userId: actorId, role, database });
  const { rows } = await database.query(
    `SELECT
       EXISTS (
         SELECT 1 FROM assurance_portfolios
         WHERE id=$1 AND workspace_id=$3
           AND ($4='admin' OR owner_id=$5)
       ) AS portfolio_exists,
       EXISTS (SELECT 1 FROM okr_objectives WHERE id=$2 AND workspace_id=$3 AND success_measure IS NOT NULL AND target_date IS NOT NULL) AS goal_exists`,
    [validPortfolioId, validGoalId, workspaceId, String(role || "").toLowerCase(), actorId]
  );
  if (!rows[0]?.portfolio_exists || !rows[0]?.goal_exists) throw httpError("Portfolio or outcome not found", 404, "ASSURANCE_NOT_FOUND");
  if (linked) {
    await database.query(
      `INSERT INTO assurance_portfolio_goals (workspace_id, portfolio_id, goal_id, added_by)
       VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      [workspaceId, validPortfolioId, validGoalId, actorId]
    );
  } else {
    await database.query(
      "DELETE FROM assurance_portfolio_goals WHERE workspace_id=$1 AND portfolio_id=$2 AND goal_id=$3",
      [workspaceId, validPortfolioId, validGoalId]
    );
  }
  await logAudit({ workspaceId, userId: actorId, action: linked ? "assurance.portfolio.goal_link" : "assurance.portfolio.goal_unlink", entityType: "assurance_portfolio", entityId: validPortfolioId, newValue: { goalId: validGoalId } });
  return { linked };
}

export async function createAssuranceDependency({ workspaceId, actorId, role, input, database = pool }) {
  if (!MANAGER_ROLES.has(String(role || "").toLowerCase())) throw httpError("Manager access is required", 403, "ASSURANCE_FORBIDDEN");
  const predecessorGoalId = uuidValue(input.predecessorGoalId ?? input.predecessor_goal_id, "Predecessor outcome");
  const successorGoalId = uuidValue(input.successorGoalId ?? input.successor_goal_id, "Successor outcome");
  if (predecessorGoalId === successorGoalId) throw httpError("An outcome cannot depend on itself");
  const dependencyType = String(input.dependencyType ?? input.dependency_type ?? "blocks").toLowerCase();
  if (!DEPENDENCY_TYPES.has(dependencyType)) throw httpError("Dependency type is not supported");
  await Promise.all([
    requireOutcome({ workspaceId, goalId: predecessorGoalId, userId: actorId, role, database }),
    requireOutcome({ workspaceId, goalId: successorGoalId, userId: actorId, role, database }),
  ]);
  const { rows } = await database.query(
    `WITH RECURSIVE path(goal_id) AS (
       SELECT successor_goal_id FROM assurance_goal_dependencies
       WHERE workspace_id=$1 AND predecessor_goal_id=$2
       UNION
       SELECT d.successor_goal_id FROM assurance_goal_dependencies d
       JOIN path p ON p.goal_id=d.predecessor_goal_id WHERE d.workspace_id=$1
     )
     SELECT
       EXISTS (SELECT 1 FROM okr_objectives WHERE workspace_id=$1 AND id=$2 AND success_measure IS NOT NULL) AS predecessor_exists,
       EXISTS (SELECT 1 FROM okr_objectives WHERE workspace_id=$1 AND id=$3 AND success_measure IS NOT NULL) AS successor_exists,
       EXISTS (SELECT 1 FROM path WHERE goal_id=$3) AS creates_cycle`,
    [workspaceId, successorGoalId, predecessorGoalId]
  );
  if (!rows[0]?.predecessor_exists || !rows[0]?.successor_exists) throw httpError("Outcome not found", 404, "ASSURANCE_NOT_FOUND");
  if (rows[0].creates_cycle) throw httpError("This dependency would create a cycle", 409, "ASSURANCE_DEPENDENCY_CYCLE");
  const inserted = await database.query(
    `INSERT INTO assurance_goal_dependencies
       (workspace_id, predecessor_goal_id, successor_goal_id, dependency_type, note, created_by)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (workspace_id, predecessor_goal_id, successor_goal_id)
     DO UPDATE SET dependency_type=EXCLUDED.dependency_type, note=EXCLUDED.note
     RETURNING *`,
    [workspaceId, predecessorGoalId, successorGoalId, dependencyType, cleanText(input.note, 1000), actorId]
  );
  await logAudit({ workspaceId, userId: actorId, action: "assurance.dependency.upsert", entityType: "assurance_dependency", entityId: inserted.rows[0].id, newValue: inserted.rows[0] });
  return inserted.rows[0];
}

export async function deleteAssuranceDependency({ id, workspaceId, actorId, role, database = pool }) {
  if (!MANAGER_ROLES.has(String(role || "").toLowerCase())) throw httpError("Manager access is required", 403, "ASSURANCE_FORBIDDEN");
  const dependencyId = uuidValue(id, "Dependency");
  const { rows: existing } = await database.query(
    "SELECT * FROM assurance_goal_dependencies WHERE id=$1 AND workspace_id=$2",
    [dependencyId, workspaceId]
  );
  if (!existing[0]) throw httpError("Dependency not found", 404, "ASSURANCE_NOT_FOUND");
  await Promise.all([
    requireOutcome({ workspaceId, goalId: existing[0].predecessor_goal_id, userId: actorId, role, database }),
    requireOutcome({ workspaceId, goalId: existing[0].successor_goal_id, userId: actorId, role, database }),
  ]);
  await database.query("DELETE FROM assurance_goal_dependencies WHERE id=$1 AND workspace_id=$2", [dependencyId, workspaceId]);
  await logAudit({ workspaceId, userId: actorId, action: "assurance.dependency.delete", entityType: "assurance_dependency", entityId: dependencyId, oldValue: existing[0] });
  return { deleted: true };
}

async function notifyApprovalRoles({ workspaceId, policy, action, title, message, sourceKey, metadata, database = pool }) {
  const roles = policy.approvalMatrix[action].approveRoles;
  const { rows } = await database.query(
    `SELECT DISTINCT u.id FROM users u
     JOIN workspace_users wu ON wu.user_id=u.id AND wu.workspace_id=$1
     JOIN okr_objectives o ON o.workspace_id=$1 AND o.id=$3
     WHERE u.workspace_id=$1 AND u.role = ANY($2::text[]) AND wu.billing_status != 'pending'
       AND COALESCE(u.is_system, FALSE)=FALSE
       AND (
         u.role='admin'
         OR (
           u.role='manager'
           AND (
             o.owner_id=u.id
             OR o.primary_project_id = ANY(COALESCE(u.projects, ARRAY[]::uuid[]))
             OR EXISTS (
               SELECT 1 FROM okr_sprint_links manager_link
               JOIN sprints manager_sprint ON manager_sprint.id=manager_link.sprint_id
               WHERE manager_link.objective_id=o.id
                 AND manager_sprint.workspace_id=o.workspace_id
                 AND manager_sprint.project_id=ANY(COALESCE(u.projects, ARRAY[]::uuid[]))
             )
           )
         )
       )`,
    [workspaceId, roles, metadata.goalId]
  );
  await Promise.all(rows.map((user) => notifyUser({
    user_id: user.id,
    workspaceId,
    type: "assurance_decision",
    title,
    message,
    action_url: "/outcomes/inbox",
    source_key: `${sourceKey}:${user.id}`,
    metadata,
    mirrorToChat: false,
    broadcastToSlack: false,
  }).catch(() => null)));
}

export async function requestAssuranceApproval({ goalId, workspaceId, actorId, role, input = {}, database = pool }) {
  const actionType = String(input.actionType ?? input.action_type ?? "complete").toLowerCase();
  if (!APPROVAL_ACTIONS.has(actionType)) throw httpError("Approval action is not supported");
  const policy = await getAssurancePolicy(workspaceId, database);
  if (!roleAllowed(policy, actionType, "requestRoles", role)) {
    throw httpError("Your workspace policy does not allow this request", 403, "ASSURANCE_FORBIDDEN");
  }
  const goal = await requireOutcome({ workspaceId, goalId, userId: actorId, role, database, policy });
  if (!MANAGER_ROLES.has(String(role || "").toLowerCase()) && String(goal.owner_id) !== String(actorId)) {
    throw httpError("You can only request a decision for an outcome you own", 403, "ASSURANCE_FORBIDDEN");
  }
  const payload = actionType === "complete"
    ? {
        evidenceLabel: cleanText(input.evidenceLabel ?? input.label, 500, { required: policy.requireResultEvidence && goal.assurance.counts.resultEvidence === 0, label: "Result evidence" }),
        note: cleanText(input.note, 4000, { label: "Evidence note" }),
      }
    : {};
  const { rows } = await database.query(
    `INSERT INTO assurance_approval_requests (workspace_id, goal_id, action_type, payload, requested_by)
     VALUES ($1,$2,$3,$4::jsonb,$5)
     ON CONFLICT (workspace_id, goal_id, action_type) WHERE status='pending'
     DO UPDATE SET payload=EXCLUDED.payload, requested_by=EXCLUDED.requested_by, requested_at=now()
     RETURNING *`,
    [workspaceId, goal.id, actionType, JSON.stringify(payload), actorId]
  );
  await logAudit({ workspaceId, userId: actorId, action: "assurance.approval.request", entityType: "assurance_approval", entityId: rows[0].id, newValue: { goalId: goal.id, actionType } });
  await notifyApprovalRoles({
    workspaceId,
    policy,
    action: actionType,
    title: "Outcome decision required",
    message: `${goal.title} is awaiting ${actionType === "complete" ? "completion verification" : "a recovery decision"}.`,
    sourceKey: `assurance:approval:${rows[0].id}`,
    metadata: { approvalId: rows[0].id, goalId: goal.id, actionType },
    database,
  });
  return rows[0];
}

export async function decideAssuranceApproval({ id, workspaceId, actorId, role, input = {}, database = pool, now = new Date() }) {
  const approvalId = uuidValue(id, "Approval");
  const decision = String(input.decision || "approved").toLowerCase();
  if (!["approved", "rejected"].includes(decision)) throw httpError("Decision must be approved or rejected");
  const { rows } = await database.query(
    `SELECT ar.*, o.title AS goal_title FROM assurance_approval_requests ar
     JOIN okr_objectives o ON o.id=ar.goal_id AND o.workspace_id=ar.workspace_id
     WHERE ar.id=$1 AND ar.workspace_id=$2 LIMIT 1`,
    [approvalId, workspaceId]
  );
  const request = rows[0];
  if (!request) throw httpError("Approval request not found", 404, "ASSURANCE_NOT_FOUND");
  if (request.status !== "pending") throw httpError("This request has already been decided", 409, "ASSURANCE_ALREADY_DECIDED");
  await requireOutcome({ workspaceId, goalId: request.goal_id, userId: actorId, role, database });
  const policy = await assertAssuranceApprover({ workspaceId, role, action: request.action_type, database });
  const note = cleanText(input.note, 2000, { label: "Decision note" });
  if (decision === "rejected") {
    const rejected = await database.query(
      `UPDATE assurance_approval_requests SET status='rejected', decided_by=$1, decision_note=$2, decided_at=$3
       WHERE id=$4 AND workspace_id=$5 AND status='pending' RETURNING *`,
      [actorId, note, now.toISOString(), approvalId, workspaceId]
    );
    if (!rejected.rows[0]) throw httpError("This request has already been decided", 409, "ASSURANCE_ALREADY_DECIDED");
  } else {
    const claimed = await database.query(
      `UPDATE assurance_approval_requests SET status='approved', decided_by=$1, decision_note=$2, decided_at=$3
       WHERE id=$4 AND workspace_id=$5 AND status='pending' RETURNING *`,
      [actorId, note, now.toISOString(), approvalId, workspaceId]
    );
    if (!claimed.rows[0]) throw httpError("This request has already been decided", 409, "ASSURANCE_ALREADY_DECIDED");
    try {
      if (request.action_type === "complete") {
        await completeAssuranceCommitment({
          id: request.goal_id,
          workspaceId,
          actorId,
          role,
          input: request.payload || {},
          database,
          now,
          requireResultEvidence: policy.requireResultEvidence,
          policy,
        });
      } else {
        await createAssuranceRecoveryTask({ id: request.goal_id, workspaceId, actorId, role, database, now, policy });
      }
    } catch (error) {
      await database.query(
        `UPDATE assurance_approval_requests SET status='pending', decided_by=NULL, decision_note=NULL, decided_at=NULL
         WHERE id=$1 AND workspace_id=$2 AND status='approved'`,
        [approvalId, workspaceId]
      );
      throw error;
    }
  }
  await logAudit({ workspaceId, userId: actorId, action: `assurance.approval.${decision}`, entityType: "assurance_approval", entityId: approvalId, newValue: { decision, note } });
  if (request.requested_by) {
    await notifyUser({
      user_id: request.requested_by,
      workspaceId,
      type: "assurance_decision",
      title: `Outcome request ${decision}`,
      message: `${request.goal_title} was ${decision}.`,
      action_url: `/outcomes#outcome-${request.goal_id}`,
      source_key: `assurance:approval:${approvalId}:${decision}`,
      metadata: { approvalId, goalId: request.goal_id, decision },
      mirrorToChat: false,
      broadcastToSlack: false,
    }).catch(() => null);
  }
  return { id: approvalId, status: decision, policyVersion: policy.version };
}

export async function getAssuranceInbox({ workspaceId, userId, role, database = pool, now = new Date() }) {
  const policy = await getAssurancePolicy(workspaceId, database);
  const overview = await getAssuranceOverview({ workspaceId, userId, role, database, now, policy });
  const attention = String(role || "").toLowerCase() === "user"
    ? overview.attention.map((item) => item.action === "create_recovery_task"
      ? { ...item, action: "review_outcome", actionLabel: "Review outcome" }
      : item)
    : overview.attention;
  const canApproveComplete = roleAllowed(policy, "complete", "approveRoles", role);
  const canApproveRecovery = roleAllowed(policy, "recovery", "approveRoles", role);
  const visibleGoalIds = overview.commitments.map((item) => item.id);
  if (visibleGoalIds.length === 0) {
    return {
      generatedAt: now.toISOString(),
      attention,
      approvals: [],
      summary: { attention: attention.length, pendingApprovals: 0, total: attention.length },
    };
  }
  const { rows } = await database.query(
    `SELECT ar.*, o.title AS goal_title, requester.username AS requested_by_name
     FROM assurance_approval_requests ar
     JOIN okr_objectives o ON o.id=ar.goal_id AND o.workspace_id=ar.workspace_id
     LEFT JOIN users requester ON requester.id=ar.requested_by AND requester.workspace_id=ar.workspace_id
     WHERE ar.workspace_id=$1 AND ar.status='pending'
       AND ar.goal_id=ANY($5::uuid[])
       AND (
         (ar.action_type='complete' AND $2::boolean)
         OR (ar.action_type='recovery' AND $3::boolean)
         OR ar.requested_by=$4
       )
     ORDER BY ar.requested_at ASC`,
    [workspaceId, canApproveComplete, canApproveRecovery, userId, visibleGoalIds]
  );
  return {
    generatedAt: now.toISOString(),
    attention,
    approvals: rows.map((item) => ({
      ...item,
      canApprove: item.action_type === "complete" ? canApproveComplete : canApproveRecovery,
    })),
    summary: {
      attention: attention.length,
      pendingApprovals: rows.length,
      total: attention.length + rows.length,
    },
  };
}

export async function ingestExternalAssuranceEvidence({ workspaceId, database = pool, now = new Date() }) {
  const { rows } = await database.query(
    `INSERT INTO goal_assurance_evidence (
       workspace_id, goal_id, evidence_type, label, note, source_entity_type,
       source_entity_id, source_provider, idempotency_key, provenance, recorded_at
     )
     SELECT DISTINCT
       o.workspace_id,
       o.id,
       CASE WHEN t.status='completed' THEN 'milestone' ELSE 'integration' END,
       CASE WHEN t.status='completed'
         THEN 'Completed external work: ' || t.task
         ELSE 'External work reported blocked: ' || t.task END,
       'Captured automatically from the connected ' || m.provider || ' task.',
       'task',
       t.id::text,
       m.provider,
       'external:' || m.provider || ':' || m.external_task_id || ':' ||
         CASE WHEN t.status='completed' THEN 'completed' ELSE 'blocked' END,
       jsonb_build_object(
         'source', 'enterprise_integration',
         'provider', m.provider,
         'externalTaskId', m.external_task_id,
         'internalTaskId', t.id,
         'schemaVersion', 1
       ),
       $2::timestamptz
     FROM okr_objectives o
     JOIN tasks t ON t.workspace_id=o.workspace_id
       AND (
         (o.primary_project_id IS NOT NULL AND t.project_id=o.primary_project_id)
         OR EXISTS (
           SELECT 1 FROM okr_sprint_links osl
           WHERE osl.objective_id=o.id AND osl.sprint_id=t.sprint_id
         )
       )
     JOIN integration_task_mappings m
       ON m.workspace_id=t.workspace_id AND m.internal_task_id=t.id
     WHERE o.workspace_id=$1
       AND o.success_measure IS NOT NULL AND o.target_date IS NOT NULL
       AND (t.status='completed' OR t.is_blocked=TRUE)
     ON CONFLICT (workspace_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
     RETURNING id, goal_id, source_provider`,
    [workspaceId, now.toISOString()]
  );
  return { captured: rows.length, evidence: rows };
}

async function recordVerifiedOutcome({ workspaceId, commitment, preCompletionState = null, database = pool, now = new Date() }) {
  if (commitment.assurance.state !== "verified") return null;
  const { rows } = await database.query(
    `INSERT INTO assurance_outcome_observations (
       workspace_id, goal_id, target_date, verified_at, on_time, days_to_verify,
       pre_completion_state, evidence_count, external_evidence_count,
       recovery_action_count, decision_count, approved_decision_count,
       average_decision_hours, source_snapshot
     )
     SELECT
       $1, o.id, o.target_date, $3::timestamptz,
       CASE WHEN o.target_date IS NULL THEN NULL ELSE $3::date <= o.target_date END,
       GREATEST(0, ($3::date - o.created_at::date)),
       $5,
       (SELECT COUNT(*)::int FROM goal_assurance_evidence e WHERE e.workspace_id=$1 AND e.goal_id=o.id),
       (SELECT COUNT(*)::int FROM goal_assurance_evidence e WHERE e.workspace_id=$1 AND e.goal_id=o.id AND e.source_provider IS NOT NULL),
       (SELECT COUNT(*)::int FROM operations_ai_actions a WHERE a.workspace_id=$1 AND a.goal_id=o.id AND a.action_type='create_followup_task' AND a.status='executed'),
       (SELECT COUNT(*)::int FROM assurance_approval_requests decision WHERE decision.workspace_id=$1 AND decision.goal_id=o.id),
       (SELECT COUNT(*)::int FROM assurance_approval_requests decision WHERE decision.workspace_id=$1 AND decision.goal_id=o.id AND decision.status='approved'),
       (SELECT ROUND(AVG(EXTRACT(EPOCH FROM (decision.decided_at-decision.requested_at))/3600)::numeric, 2)
        FROM assurance_approval_requests decision
        WHERE decision.workspace_id=$1 AND decision.goal_id=o.id AND decision.decided_at IS NOT NULL),
       $4::jsonb
     FROM okr_objectives o
     WHERE o.workspace_id=$1 AND o.id=$2
     ON CONFLICT (workspace_id, goal_id) DO NOTHING
     RETURNING *`,
    [workspaceId, commitment.id, now.toISOString(), JSON.stringify({ assurance: commitment.assurance, schemaVersion: 1 }), preCompletionState]
  );
  return rows[0] || null;
}

export async function refreshAssuranceMemory({ workspaceId, database = pool, now = new Date(), policy = null }) {
  const currentPolicy = policy || await getAssurancePolicy(workspaceId, database);
  const { rows } = await database.query(
    `SELECT
       COUNT(*)::int AS sample_size,
       COUNT(*) FILTER (WHERE on_time IS TRUE)::int AS on_time_count,
       COUNT(*) FILTER (WHERE recovery_action_count > 0)::int AS recovery_sample_size,
       COUNT(*) FILTER (WHERE recovery_action_count > 0 AND on_time IS TRUE)::int AS recovery_on_time_count,
       COUNT(*) FILTER (WHERE decision_count > 0)::int AS decision_sample_size,
       COUNT(*) FILTER (WHERE decision_count > 0 AND on_time IS TRUE)::int AS decision_on_time_count,
       ROUND(AVG(average_decision_hours) FILTER (WHERE decision_count > 0), 1) AS average_decision_hours,
       ROUND(AVG(days_to_verify)::numeric, 1) AS average_days_to_verify,
       ARRAY_AGG(id ORDER BY verified_at DESC) AS observation_ids
     FROM assurance_outcome_observations WHERE workspace_id=$1`,
    [workspaceId]
  );
  const aggregate = rows[0] || {};
  const sampleSize = Number(aggregate.sample_size || 0);
  if (sampleSize < currentPolicy.minimumPatternSample) {
    return { status: "learning", sampleSize, requiredSampleSize: currentPolicy.minimumPatternSample, patterns: [] };
  }
  const onTimeRate = sampleSize ? Math.round((Number(aggregate.on_time_count || 0) / sampleSize) * 100) : null;
  const patterns = [{
    key: "verified_delivery_baseline",
    title: "Verified delivery baseline",
    statement: `In ${sampleSize} verified workspace outcomes, ${onTimeRate}% were verified by their target date.`,
    sampleSize,
    evidence: {
      observationIds: aggregate.observation_ids,
      onTimeCount: Number(aggregate.on_time_count || 0),
      onTimeRate,
      averageDaysToVerify: aggregate.average_days_to_verify == null ? null : Number(aggregate.average_days_to_verify),
      interpretation: "Observed association only; no causal claim is made.",
    },
  }];
  const recoverySample = Number(aggregate.recovery_sample_size || 0);
  if (recoverySample >= currentPolicy.minimumPatternSample) {
    const recoveryRate = Math.round((Number(aggregate.recovery_on_time_count || 0) / recoverySample) * 100);
    patterns.push({
      key: "recovery_intervention_observation",
      title: "Recovery intervention outcomes",
      statement: `Among ${recoverySample} verified outcomes with a governed recovery task, ${recoveryRate}% were verified by target date.`,
      sampleSize: recoverySample,
      evidence: {
        observationIds: aggregate.observation_ids,
        onTimeCount: Number(aggregate.recovery_on_time_count || 0),
        onTimeRate: recoveryRate,
        interpretation: "Observed association only; other factors may explain the result.",
      },
    });
  }
  const decisionSample = Number(aggregate.decision_sample_size || 0);
  if (decisionSample >= currentPolicy.minimumPatternSample) {
    const decisionOnTimeRate = Math.round((Number(aggregate.decision_on_time_count || 0) / decisionSample) * 100);
    patterns.push({
      key: "governed_decision_observation",
      title: "Governed decision outcomes",
      statement: `Among ${decisionSample} verified outcomes with an assurance decision, ${decisionOnTimeRate}% were verified by target date.`,
      sampleSize: decisionSample,
      evidence: {
        observationIds: aggregate.observation_ids,
        onTimeCount: Number(aggregate.decision_on_time_count || 0),
        onTimeRate: decisionOnTimeRate,
        averageDecisionHours: aggregate.average_decision_hours == null ? null : Number(aggregate.average_decision_hours),
        interpretation: "Observed association only; this does not prove the decision caused the delivery result.",
      },
    });
  }
  for (const pattern of patterns) {
    await database.query(
      `INSERT INTO assurance_memory_patterns
         (workspace_id, pattern_key, title, statement, sample_size, evidence, confidence_label, last_observed_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)
       ON CONFLICT (workspace_id, pattern_key) DO UPDATE SET
         title=EXCLUDED.title, statement=EXCLUDED.statement, sample_size=EXCLUDED.sample_size,
         evidence=EXCLUDED.evidence,
         confidence_label=EXCLUDED.confidence_label,
         version=assurance_memory_patterns.version + 1,
         last_observed_at=EXCLUDED.last_observed_at
       WHERE assurance_memory_patterns.statement IS DISTINCT FROM EXCLUDED.statement
          OR assurance_memory_patterns.sample_size IS DISTINCT FROM EXCLUDED.sample_size
          OR assurance_memory_patterns.evidence IS DISTINCT FROM EXCLUDED.evidence
          OR assurance_memory_patterns.confidence_label IS DISTINCT FROM EXCLUDED.confidence_label`,
      [workspaceId, pattern.key, pattern.title, pattern.statement, pattern.sampleSize, JSON.stringify(pattern.evidence), pattern.sampleSize >= 10 ? "established" : "emerging", now.toISOString()]
    );
  }
  const stored = await database.query(
    `SELECT * FROM assurance_memory_patterns WHERE workspace_id=$1 ORDER BY last_observed_at DESC`,
    [workspaceId]
  );
  return { status: "ready", sampleSize, requiredSampleSize: currentPolicy.minimumPatternSample, patterns: stored.rows };
}

async function reconcileStateSnapshots({ workspaceId, commitments, policy, database = pool, now = new Date(), notify = true }) {
  const { rows: priorRows } = await database.query(
    "SELECT goal_id, state, state_data, transition_count FROM assurance_state_snapshots WHERE workspace_id=$1",
    [workspaceId]
  );
  const prior = new Map(priorRows.map((row) => [String(row.goal_id), row]));
  const snapshots = commitments.map((commitment) => {
    const previous = prior.get(String(commitment.id));
    const changed = !previous || previous.state !== commitment.assurance.state;
    return {
      goal_id: commitment.id,
      state: commitment.assurance.state,
      explanation: commitment.assurance.explanation,
      state_data: commitment.assurance,
      transition_count: Number(previous?.transition_count || 0) + (changed ? 1 : 0),
    };
  });
  if (snapshots.length) {
    await database.query(
      `WITH incoming AS (
         SELECT
           $1::uuid AS workspace_id,
           item.goal_id::uuid AS goal_id,
           item.state,
           item.explanation,
           item.state_data,
           item.transition_count,
           $3::timestamptz AS observed_at
         FROM jsonb_to_recordset($2::jsonb) AS item(
           goal_id text, state text, explanation text,
           state_data jsonb, transition_count integer
         )
       )
       INSERT INTO assurance_state_snapshots
         (workspace_id, goal_id, state, explanation, state_data, transition_count, observed_at, changed_at)
       SELECT workspace_id, goal_id, state, explanation, state_data, transition_count, observed_at, observed_at
       FROM incoming
       ON CONFLICT (workspace_id, goal_id) DO UPDATE SET
         state=EXCLUDED.state, explanation=EXCLUDED.explanation, state_data=EXCLUDED.state_data,
         transition_count=EXCLUDED.transition_count, observed_at=EXCLUDED.observed_at,
         changed_at=CASE WHEN assurance_state_snapshots.state<>EXCLUDED.state THEN EXCLUDED.changed_at ELSE assurance_state_snapshots.changed_at END`,
      [workspaceId, JSON.stringify(snapshots), now.toISOString()]
    );
  }
  let transitions = 0;
  let materialChanges = 0;
  let verifiedObservations = 0;
  for (const commitment of commitments) {
    const previous = prior.get(String(commitment.id));
    const changed = !previous || previous.state !== commitment.assurance.state;
    const transitionCount = Number(previous?.transition_count || 0) + (changed ? 1 : 0);
    if (changed) transitions += 1;
    if (!previous || changed || JSON.stringify(stableJson(previous.state_data || {})) !== JSON.stringify(stableJson(commitment.assurance || {}))) {
      materialChanges += 1;
    }
    if (
      changed && notify && policy.notifyOnStateChange && commitment.owner_id &&
      ["at_risk", "off_track", "needs_evidence"].includes(commitment.assurance.state)
    ) {
      await notifyUser({
        user_id: commitment.owner_id,
        workspaceId,
        type: "assurance_attention",
        title: "Outcome needs attention",
        message: `${commitment.title}: ${commitment.assurance.explanation}`,
        action_url: `/outcomes#outcome-${commitment.id}`,
        source_key: `assurance:state:${commitment.id}:${commitment.assurance.state}:${transitionCount}`,
        metadata: { goalId: commitment.id, state: commitment.assurance.state, transitionCount },
        mirrorToChat: false,
        broadcastToSlack: false,
      }).catch(() => null);
    }
    const observation = await recordVerifiedOutcome({ workspaceId, commitment, preCompletionState: previous?.state || null, database, now });
    if (observation) verifiedObservations += 1;
  }
  return { transitions, materialChanges, verifiedObservations };
}

export async function reconcileAssuranceWorkspace({ workspaceId, database = pool, now = new Date(), notify = true }) {
  const policy = await getAssurancePolicy(workspaceId, database);
  const ingestion = policy.automaticExternalEvidence
    ? await ingestExternalAssuranceEvidence({ workspaceId, database, now })
    : { captured: 0, evidence: [] };
  const overview = await getAssuranceOverview({ workspaceId, userId: null, role: "admin", database, now, policy });
  const snapshots = await reconcileStateSnapshots({ workspaceId, commitments: overview.commitments, policy, database, now, notify });
  const learning = await refreshAssuranceMemory({ workspaceId, database, now, policy });
  if (ingestion.captured > 0 || snapshots.materialChanges > 0 || snapshots.verifiedObservations > 0) {
    queueAssuranceIntelligenceRefresh({
      workspaceId,
      metadata: {
        capturedEvidence: ingestion.captured,
        stateTransitions: snapshots.transitions,
        materialStateChanges: snapshots.materialChanges,
        verifiedObservations: snapshots.verifiedObservations,
      },
      database,
    });
  }
  return {
    workspaceId,
    capturedEvidence: ingestion.captured,
    transitions: snapshots.transitions,
    materialChanges: snapshots.materialChanges,
    verifiedObservations: snapshots.verifiedObservations,
    learning,
    overview,
  };
}

export async function reconcileAllAssuranceWorkspaces({ database = pool, now = new Date(), limit = 50 } = {}) {
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
  const { rows } = await database.query(
    `SELECT o.workspace_id, MIN(snapshot.observed_at) AS last_observed_at
     FROM okr_objectives o
     LEFT JOIN assurance_state_snapshots snapshot
       ON snapshot.workspace_id=o.workspace_id AND snapshot.goal_id=o.id
     WHERE o.success_measure IS NOT NULL AND o.target_date IS NOT NULL
     GROUP BY o.workspace_id
     ORDER BY MIN(snapshot.observed_at) ASC NULLS FIRST, o.workspace_id
     LIMIT $1`,
    [safeLimit]
  );
  const summary = { scanned: rows.length, reconciled: 0, capturedEvidence: 0, transitions: 0, failures: [] };
  for (const row of rows) {
    try {
      const result = await reconcileAssuranceWorkspace({ workspaceId: row.workspace_id, database, now });
      summary.reconciled += 1;
      summary.capturedEvidence += result.capturedEvidence;
      summary.transitions += result.transitions;
    } catch (error) {
      summary.failures.push({ workspaceId: row.workspace_id, error: error.message });
    }
  }
  return summary;
}

async function getScopedAssuranceLearning({ workspaceId, goalIds, database = pool, policy }) {
  if (!goalIds.length) {
    return { status: "learning", sampleSize: 0, requiredSampleSize: policy.minimumPatternSample, patterns: [] };
  }
  const { rows } = await database.query(
    `SELECT
       COUNT(*)::int AS sample_size,
       COUNT(*) FILTER (WHERE on_time IS TRUE)::int AS on_time_count,
       COUNT(*) FILTER (WHERE recovery_action_count > 0)::int AS recovery_sample_size,
       COUNT(*) FILTER (WHERE recovery_action_count > 0 AND on_time IS TRUE)::int AS recovery_on_time_count,
       COUNT(*) FILTER (WHERE decision_count > 0)::int AS decision_sample_size,
       COUNT(*) FILTER (WHERE decision_count > 0 AND on_time IS TRUE)::int AS decision_on_time_count,
       ROUND(AVG(average_decision_hours) FILTER (WHERE decision_count > 0), 1) AS average_decision_hours,
       ROUND(AVG(days_to_verify)::numeric, 1) AS average_days_to_verify,
       ARRAY_AGG(id ORDER BY verified_at DESC) AS observation_ids
     FROM assurance_outcome_observations
     WHERE workspace_id=$1 AND goal_id=ANY($2::uuid[])`,
    [workspaceId, goalIds]
  );
  const aggregate = rows[0] || {};
  const sampleSize = Number(aggregate.sample_size || 0);
  if (sampleSize < policy.minimumPatternSample) {
    return { status: "learning", sampleSize, requiredSampleSize: policy.minimumPatternSample, patterns: [] };
  }
  const observationIds = aggregate.observation_ids || [];
  const onTimeRate = Math.round((Number(aggregate.on_time_count || 0) / sampleSize) * 100);
  const patterns = [{
    pattern_key: "verified_delivery_baseline",
    title: "Verified delivery baseline",
    statement: `In ${sampleSize} verified outcomes in your managed scope, ${onTimeRate}% were verified by their target date.`,
    sample_size: sampleSize,
    confidence_label: sampleSize >= 10 ? "established" : "emerging",
    evidence: {
      observationIds,
      onTimeCount: Number(aggregate.on_time_count || 0),
      onTimeRate,
      averageDaysToVerify: aggregate.average_days_to_verify == null ? null : Number(aggregate.average_days_to_verify),
      interpretation: "Observed association only; no causal claim is made.",
    },
  }];
  const recoverySample = Number(aggregate.recovery_sample_size || 0);
  if (recoverySample >= policy.minimumPatternSample) {
    const recoveryRate = Math.round((Number(aggregate.recovery_on_time_count || 0) / recoverySample) * 100);
    patterns.push({
      pattern_key: "recovery_intervention_observation",
      title: "Recovery intervention outcomes",
      statement: `Among ${recoverySample} visible verified outcomes with a governed recovery task, ${recoveryRate}% were verified by target date.`,
      sample_size: recoverySample,
      confidence_label: recoverySample >= 10 ? "established" : "emerging",
      evidence: {
        observationIds,
        onTimeCount: Number(aggregate.recovery_on_time_count || 0),
        onTimeRate: recoveryRate,
        interpretation: "Observed association only; other factors may explain the result.",
      },
    });
  }
  const decisionSample = Number(aggregate.decision_sample_size || 0);
  if (decisionSample >= policy.minimumPatternSample) {
    const decisionOnTimeRate = Math.round((Number(aggregate.decision_on_time_count || 0) / decisionSample) * 100);
    patterns.push({
      pattern_key: "governed_decision_observation",
      title: "Governed decision outcomes",
      statement: `Among ${decisionSample} visible verified outcomes with an assurance decision, ${decisionOnTimeRate}% were verified by target date.`,
      sample_size: decisionSample,
      confidence_label: decisionSample >= 10 ? "established" : "emerging",
      evidence: {
        observationIds,
        onTimeCount: Number(aggregate.decision_on_time_count || 0),
        onTimeRate: decisionOnTimeRate,
        averageDecisionHours: aggregate.average_decision_hours == null ? null : Number(aggregate.average_decision_hours),
        interpretation: "Observed association only; this does not prove the decision caused the delivery result.",
      },
    });
  }
  return { status: "ready", sampleSize, requiredSampleSize: policy.minimumPatternSample, patterns };
}

export async function getExecutiveAssuranceReport({ workspaceId, userId, role, database = pool, now = new Date() }) {
  if (!MANAGER_ROLES.has(String(role || "").toLowerCase())) throw httpError("Manager access is required", 403, "ASSURANCE_FORBIDDEN");
  const policy = await getAssurancePolicy(workspaceId, database);
  const overview = await getAssuranceOverview({ workspaceId, userId, role, database, now, policy });
  const visibleGoalIds = overview.commitments.map((item) => item.id);
  const [portfolio, approvalResult, evidenceResult, exportResult, learning] = await Promise.all([
    getAssurancePortfolio({ workspaceId, userId, role, database, now }),
    database.query(
      `SELECT status, action_type, COUNT(*)::int AS count FROM assurance_approval_requests
       WHERE workspace_id=$1 AND goal_id=ANY($2::uuid[])
       GROUP BY status, action_type ORDER BY status, action_type`,
      [workspaceId, visibleGoalIds]
    ),
    database.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE source_provider IS NOT NULL)::int AS external,
              COUNT(DISTINCT goal_id)::int AS outcomes_with_evidence
       FROM goal_assurance_evidence
       WHERE workspace_id=$1 AND goal_id=ANY($2::uuid[])`,
      [workspaceId, visibleGoalIds]
    ),
    database.query(
      `SELECT id, format, schema_version, record_count, sha256, generated_at
       FROM assurance_export_manifests
       WHERE workspace_id=$1 AND ($2='admin' OR requested_by=$3)
       ORDER BY generated_at DESC LIMIT 20`,
      [workspaceId, String(role || "").toLowerCase(), userId]
    ),
    String(role || "").toLowerCase() === "admin"
      ? refreshAssuranceMemory({ workspaceId, database, now, policy })
      : getScopedAssuranceLearning({ workspaceId, goalIds: visibleGoalIds, database, policy }),
  ]);
  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    evidencePolicy: overview.evidencePolicy,
    summary: overview.summary,
    evidenceCoverage: evidenceResult.rows[0] || { total: 0, external: 0, outcomes_with_evidence: 0 },
    commitments: overview.commitments,
    portfolios: portfolio.portfolios,
    dependencies: portfolio.dependencies,
    decisions: approvalResult.rows,
    learning,
    policy,
    recentExports: exportResult.rows,
    scope: String(role || "").toLowerCase() === "admin" ? "workspace" : "managed_projects",
  };
}

function csvCell(value) {
  let text = value == null ? "" : String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function reportCsv(report) {
  const header = ["outcome_id", "outcome", "owner", "target_date", "state", "explanation", "project", "evidence_count", "external_evidence_count", "pending_decisions"];
  const rows = report.commitments.map((item) => [
    item.id,
    item.title,
    item.owner_name,
    item.target_date,
    item.assurance.state,
    item.assurance.explanation,
    item.project_name,
    item.assurance.counts.evidence,
    item.external_evidence_count || 0,
    item.assurance.counts.pendingDecisions,
  ]);
  return [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

export async function generateAssuranceExport({ workspaceId, userId, role, format = "json", database = pool, now = new Date() }) {
  const normalizedFormat = String(format || "json").toLowerCase();
  if (!["json", "csv"].includes(normalizedFormat)) throw httpError("Export format must be json or csv");
  const report = await getExecutiveAssuranceReport({ workspaceId, userId, role, database, now });
  const exportId = randomUUID();
  let content;
  let digestSource;
  if (normalizedFormat === "csv") {
    content = reportCsv(report);
    digestSource = content;
  } else {
    digestSource = JSON.stringify(report);
    const digest = createHash("sha256").update(digestSource).digest("hex");
    content = JSON.stringify({
      manifest: {
        exportId,
        workspaceId,
        generatedAt: now.toISOString(),
        schemaVersion: 1,
        digestAlgorithm: "SHA-256",
        digestScope: "data",
        sha256: digest,
      },
      data: report,
    }, null, 2);
  }
  const sha256 = createHash("sha256").update(digestSource).digest("hex");
  await database.query(
    `INSERT INTO assurance_export_manifests
       (id, workspace_id, requested_by, format, schema_version, record_count, sha256, filters, generated_at)
     VALUES ($1,$2,$3,$4,1,$5,$6,$7::jsonb,$8)`,
    [exportId, workspaceId, userId, normalizedFormat, report.commitments.length, sha256, JSON.stringify({ scope: "workspace_assurance" }), now.toISOString()]
  );
  await logAudit({ workspaceId, userId, action: "assurance.export.generate", entityType: "assurance_export", entityId: exportId, newValue: { format: normalizedFormat, sha256, recordCount: report.commitments.length } });
  return {
    exportId,
    format: normalizedFormat,
    sha256,
    content,
    contentType: normalizedFormat === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8",
    filename: `assurance-${now.toISOString().slice(0, 10)}.${normalizedFormat}`,
  };
}
