import pool from "../db.js";
import { logAudit } from "./audit.service.js";
import {
  approveOperationsAction,
  createOperationsAction,
} from "./operationsAction.service.js";

const MANAGER_ROLES = new Set(["admin", "owner", "manager"]);
const PRIORITIES = new Set(["low", "medium", "high", "critical"]);
const EVIDENCE_TYPES = new Set([
  "result",
  "milestone",
  "document",
  "task",
  "project",
  "integration",
  "correction",
]);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

function uuidValue(value, { required = false, label = "Identifier" } = {}) {
  const normalized = cleanText(value, 100, { required, label });
  if (normalized && !UUID.test(normalized)) throw httpError(`${label} is not valid`);
  return normalized;
}

function dateOnly(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  return String(value || "").slice(0, 10);
}

function todayUtc(now = new Date()) {
  return dateOnly(now);
}

function daysBetween(fromDate, toDate) {
  if (!ISO_DATE.test(String(fromDate)) || !ISO_DATE.test(String(toDate))) return null;
  const from = Date.parse(`${fromDate}T00:00:00.000Z`);
  const to = Date.parse(`${toDate}T00:00:00.000Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return Math.round((to - from) / 86_400_000);
}

export function canManageAssurance(role) {
  return MANAGER_ROLES.has(String(role || "").toLowerCase());
}

export function deriveTimePeriod(targetDate) {
  if (!ISO_DATE.test(String(targetDate || ""))) return "Unscheduled";
  const [year, month] = String(targetDate).split("-").map(Number);
  return `Q${Math.ceil(month / 3)} ${year}`;
}

export function normalizeAssuranceInput(input = {}) {
  const outcome = cleanText(input.outcome ?? input.title, 500, {
    required: true,
    label: "Outcome",
  });
  const successMeasure = cleanText(input.successMeasure ?? input.success_measure, 2000, {
    required: true,
    label: "Success measure",
  });
  const whyItMatters = cleanText(input.whyItMatters ?? input.description, 4000, {
    label: "Context",
  });
  const targetDate = String(input.targetDate ?? input.target_date ?? "").trim();
  if (!ISO_DATE.test(targetDate) || !Number.isFinite(Date.parse(`${targetDate}T00:00:00.000Z`))) {
    throw httpError("Target date must be a valid date in YYYY-MM-DD format");
  }

  const priority = String(input.priority || "high").toLowerCase();
  if (!PRIORITIES.has(priority)) throw httpError("Priority is not supported");

  const requirements = Array.isArray(input.evidenceRequirements ?? input.evidence_requirements)
    ? (input.evidenceRequirements ?? input.evidence_requirements)
      .map((item) => cleanText(item, 300))
      .filter(Boolean)
      .slice(0, 20)
    : [];

  return {
    outcome,
    successMeasure,
    whyItMatters,
    targetDate,
    ownerId: uuidValue(input.ownerId ?? input.owner_id, { label: "Owner" }),
    primaryProjectId: uuidValue(input.primaryProjectId ?? input.primary_project_id, { label: "Project" }),
    priority,
    evidenceRequirements: requirements,
  };
}

function numeric(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function calculateAssuranceState(row, now = new Date()) {
  const progress = Math.max(0, Math.min(100, numeric(row.progress)));
  const taskCount = numeric(row.task_count);
  const completedTaskCount = numeric(row.completed_task_count);
  const overdueTaskCount = numeric(row.overdue_task_count);
  const blockedTaskCount = numeric(row.blocked_task_count);
  const linkedSprintCount = numeric(row.linked_sprint_count);
  const evidenceCount = numeric(row.evidence_count);
  const resultEvidenceCount = numeric(row.result_evidence_count);
  const targetDate = dateOnly(row.target_date);
  const remainingDays = daysBetween(todayUtc(now), targetDate);
  const hasExecutionEvidence = evidenceCount > 0 || taskCount > 0 || linkedSprintCount > 0;
  const markedComplete = row.status === "done" || progress >= 100;

  let state;
  let explanation;
  if (markedComplete && resultEvidenceCount > 0) {
    state = "verified";
    explanation = "The outcome is complete and has recorded result evidence.";
  } else if (markedComplete) {
    state = "needs_evidence";
    explanation = "Completion is recorded, but result evidence is still required.";
  } else if (!hasExecutionEvidence) {
    state = "insufficient_evidence";
    explanation = "Connect a project or record evidence before delivery status is inferred.";
  } else if (row.status === "off_track" || overdueTaskCount > 0 || (remainingDays != null && remainingDays < 0)) {
    state = "off_track";
    explanation = overdueTaskCount > 0
      ? `${overdueTaskCount} connected task${overdueTaskCount === 1 ? " is" : "s are"} overdue.`
      : "The target date has passed without verified completion.";
  } else if (row.status === "at_risk" || blockedTaskCount > 0 || (remainingDays != null && remainingDays <= 14 && progress < 80)) {
    state = "at_risk";
    explanation = blockedTaskCount > 0
      ? `${blockedTaskCount} connected task${blockedTaskCount === 1 ? " is" : "s are"} blocked.`
      : "The target date is approaching and the outcome needs review.";
  } else {
    state = "on_track";
    explanation = "Connected work is progressing without a current exception.";
  }

  return {
    state,
    explanation,
    evidenceStatus: hasExecutionEvidence ? "observed" : "insufficient_evidence",
    remainingDays,
    taskProgress: taskCount > 0 ? Math.round((completedTaskCount / taskCount) * 100) : null,
    counts: {
      tasks: taskCount,
      completedTasks: completedTaskCount,
      overdueTasks: overdueTaskCount,
      blockedTasks: blockedTaskCount,
      linkedSprints: linkedSprintCount,
      evidence: evidenceCount,
      resultEvidence: resultEvidenceCount,
      governedActions: numeric(row.governed_action_count),
      pendingDecisions: numeric(row.pending_decision_count),
    },
  };
}

export function buildAssuranceAttention(commitment) {
  const state = commitment.assurance?.state;
  if (["verified", "on_track"].includes(state)) return null;

  const action = state === "needs_evidence"
    ? "add_evidence"
    : state === "insufficient_evidence"
      ? "connect_work"
      : commitment.primary_project_id
        ? "create_recovery_task"
        : "connect_work";

  return {
    id: `commitment:${commitment.id}:${state}`,
    commitmentId: commitment.id,
    title: commitment.title,
    state,
    reason: commitment.assurance.explanation,
    action,
    actionLabel: {
      add_evidence: "Add result evidence",
      connect_work: "Connect work",
      create_recovery_task: "Create recovery task",
    }[action],
    targetDate: dateOnly(commitment.target_date) || null,
    projectName: commitment.project_name || null,
  };
}

function mapCommitment(row, now) {
  return {
    ...row,
    target_date: dateOnly(row.target_date) || null,
    progress: numeric(row.progress),
    evidence_requirements: Array.isArray(row.evidence_requirements) ? row.evidence_requirements : [],
    assurance: calculateAssuranceState(row, now),
  };
}

async function queryCommitments({ workspaceId, userId, role, commitmentId = null, database = pool, now = new Date() }) {
  const values = [workspaceId];
  // Legacy Goals remain untouched and continue through /okr. Only outcomes
  // created with the assurance contract appear on this surface.
  const where = [
    "o.workspace_id = $1",
    "o.success_measure IS NOT NULL",
    "o.target_date IS NOT NULL",
  ];
  let parameter = 2;

  if (commitmentId) {
    where.push(`o.id = $${parameter++}`);
    values.push(commitmentId);
  }
  if (!canManageAssurance(role)) {
    where.push(`o.owner_id = $${parameter++}`);
    values.push(userId);
  }

  const { rows } = await database.query(
    `
    SELECT
      o.id,
      o.workspace_id,
      o.owner_id,
      o.title,
      o.description,
      o.time_period,
      o.status,
      o.progress,
      o.success_measure,
      o.target_date,
      o.primary_project_id,
      o.priority,
      o.evidence_requirements,
      o.created_at,
      o.updated_at,
      owner.username AS owner_name,
      project.name AS project_name,
      COALESCE(work.task_count, 0)::int AS task_count,
      COALESCE(work.completed_task_count, 0)::int AS completed_task_count,
      COALESCE(work.overdue_task_count, 0)::int AS overdue_task_count,
      COALESCE(work.blocked_task_count, 0)::int AS blocked_task_count,
      COALESCE(sprints.linked_sprint_count, 0)::int AS linked_sprint_count,
      COALESCE(evidence.evidence_count, 0)::int AS evidence_count,
      COALESCE(evidence.result_evidence_count, 0)::int AS result_evidence_count,
      COALESCE(actions.governed_action_count, 0)::int AS governed_action_count,
      COALESCE(actions.pending_decision_count, 0)::int AS pending_decision_count
    FROM okr_objectives o
    LEFT JOIN users owner
      ON owner.id = o.owner_id AND owner.workspace_id = o.workspace_id
    LEFT JOIN projects project
      ON project.id = o.primary_project_id AND project.workspace_id = o.workspace_id
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*) AS task_count,
        COUNT(*) FILTER (WHERE t.status = 'completed') AS completed_task_count,
        COUNT(*) FILTER (
          WHERE t.status != 'completed' AND t.due_date IS NOT NULL AND t.due_date < CURRENT_DATE
        ) AS overdue_task_count,
        COUNT(*) FILTER (WHERE t.status != 'completed' AND t.is_blocked = TRUE) AS blocked_task_count
      FROM tasks t
      WHERE t.workspace_id = o.workspace_id
        AND (
          (o.primary_project_id IS NOT NULL AND t.project_id = o.primary_project_id)
          OR EXISTS (
            SELECT 1 FROM okr_sprint_links osl
            WHERE osl.objective_id = o.id AND osl.sprint_id = t.sprint_id
          )
        )
    ) work ON TRUE
    LEFT JOIN LATERAL (
      SELECT COUNT(*) AS linked_sprint_count
      FROM okr_sprint_links osl
      JOIN sprints s ON s.id = osl.sprint_id AND s.workspace_id = o.workspace_id
      WHERE osl.objective_id = o.id
    ) sprints ON TRUE
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*) AS evidence_count,
        COUNT(*) FILTER (WHERE gae.evidence_type = 'result') AS result_evidence_count
      FROM goal_assurance_evidence gae
      WHERE gae.workspace_id = o.workspace_id AND gae.goal_id = o.id
    ) evidence ON TRUE
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*) AS governed_action_count,
        COUNT(*) FILTER (WHERE oaa.status IN ('pending', 'approved')) AS pending_decision_count
      FROM operations_ai_actions oaa
      WHERE oaa.workspace_id = o.workspace_id AND oaa.goal_id = o.id
    ) actions ON TRUE
    WHERE ${where.join(" AND ")}
    ORDER BY
      CASE o.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
      o.target_date ASC NULLS LAST,
      o.updated_at DESC
    `,
    values
  );

  return rows.map((row) => mapCommitment(row, now));
}

async function getAssuranceOptions(workspaceId, database = pool) {
  const [ownersResult, projectsResult] = await Promise.all([
    database.query(
      `
      SELECT u.id, u.username, u.role
      FROM users u
      JOIN workspace_users wu ON wu.user_id = u.id AND wu.workspace_id = $1
      WHERE u.workspace_id = $1
        AND wu.billing_status != 'pending'
        AND COALESCE(u.is_system, FALSE) = FALSE
        AND u.role != 'system'
      ORDER BY u.username ASC
      `,
      [workspaceId]
    ),
    database.query(
      `SELECT id, name FROM projects WHERE workspace_id = $1 ORDER BY name ASC`,
      [workspaceId]
    ),
  ]);

  return { owners: ownersResult.rows, projects: projectsResult.rows };
}

export async function getAssuranceOverview({ workspaceId, userId, role, database = pool, now = new Date() }) {
  const commitments = await queryCommitments({ workspaceId, userId, role, database, now });
  const attention = commitments.map(buildAssuranceAttention).filter(Boolean);
  const options = canManageAssurance(role)
    ? await getAssuranceOptions(workspaceId, database)
    : { owners: [], projects: [] };

  return {
    generatedAt: now.toISOString(),
    evidencePolicy: "No status is inferred until workspace-scoped work or evidence exists.",
    summary: {
      total: commitments.length,
      needsAttention: attention.length,
      verified: commitments.filter((item) => item.assurance.state === "verified").length,
      pendingDecisions: commitments.reduce((sum, item) => sum + item.assurance.counts.pendingDecisions, 0),
    },
    commitments,
    attention,
    options,
  };
}

async function requireCommitment({ id, workspaceId, userId, role, database = pool, now = new Date() }) {
  const commitmentId = uuidValue(id, { required: true, label: "Outcome" });
  const rows = await queryCommitments({
    workspaceId,
    userId,
    role,
    commitmentId,
    database,
    now,
  });
  if (!rows[0]) throw httpError("Outcome not found", 404, "ASSURANCE_NOT_FOUND");
  return rows[0];
}

async function assertWorkspaceOwner(workspaceId, ownerId, database = pool) {
  const { rows } = await database.query(
    `
    SELECT u.id
    FROM users u
    JOIN workspace_users wu ON wu.user_id = u.id AND wu.workspace_id = $1
    WHERE u.id = $2
      AND u.workspace_id = $1
      AND wu.billing_status != 'pending'
      AND COALESCE(u.is_system, FALSE) = FALSE
      AND u.role != 'system'
    LIMIT 1
    `,
    [workspaceId, ownerId]
  );
  if (!rows[0]) throw httpError("Owner is not an active member of this workspace");
}

async function assertWorkspaceProject(workspaceId, projectId, database = pool) {
  if (!projectId) return;
  const { rows } = await database.query(
    "SELECT id FROM projects WHERE id = $1 AND workspace_id = $2 LIMIT 1",
    [projectId, workspaceId]
  );
  if (!rows[0]) throw httpError("Project was not found in this workspace");
}

export async function createAssuranceCommitment({
  workspaceId,
  actorId,
  role,
  input,
  database = pool,
  now = new Date(),
}) {
  if (!canManageAssurance(role)) throw httpError("Manager access is required", 403, "ASSURANCE_FORBIDDEN");
  const value = normalizeAssuranceInput(input);
  value.ownerId ||= actorId;
  await Promise.all([
    assertWorkspaceOwner(workspaceId, value.ownerId, database),
    assertWorkspaceProject(workspaceId, value.primaryProjectId, database),
  ]);

  const { rows } = await database.query(
    `
    INSERT INTO okr_objectives (
      workspace_id, owner_id, title, description, time_period, status, progress,
      success_measure, target_date, primary_project_id, priority, evidence_requirements
    )
    VALUES ($1,$2,$3,$4,$5,'on_track',0,$6,$7,$8,$9,$10::jsonb)
    RETURNING id
    `,
    [
      workspaceId,
      value.ownerId,
      value.outcome,
      value.whyItMatters,
      deriveTimePeriod(value.targetDate),
      value.successMeasure,
      value.targetDate,
      value.primaryProjectId,
      value.priority,
      JSON.stringify(value.evidenceRequirements),
    ]
  );

  await logAudit({
    workspaceId,
    userId: actorId,
    action: "assurance.outcome.create",
    entityType: "goal",
    entityId: rows[0].id,
    newValue: {
      title: value.outcome,
      targetDate: value.targetDate,
      ownerId: value.ownerId,
      primaryProjectId: value.primaryProjectId,
    },
  });

  return requireCommitment({ id: rows[0].id, workspaceId, userId: actorId, role, database, now });
}

export async function updateAssuranceCommitment({
  id,
  workspaceId,
  actorId,
  role,
  input,
  database = pool,
  now = new Date(),
}) {
  if (!canManageAssurance(role)) throw httpError("Manager access is required", 403, "ASSURANCE_FORBIDDEN");
  const current = await requireCommitment({ id, workspaceId, userId: actorId, role, database, now });
  const value = normalizeAssuranceInput({
    outcome: input.outcome ?? input.title ?? current.title,
    successMeasure: input.successMeasure ?? input.success_measure ?? current.success_measure,
    whyItMatters: input.whyItMatters ?? input.description ?? current.description,
    targetDate: input.targetDate ?? input.target_date ?? current.target_date,
    ownerId: input.ownerId ?? input.owner_id ?? current.owner_id,
    primaryProjectId: Object.prototype.hasOwnProperty.call(input, "primaryProjectId")
      ? input.primaryProjectId
      : Object.prototype.hasOwnProperty.call(input, "primary_project_id")
        ? input.primary_project_id
        : current.primary_project_id,
    priority: input.priority ?? current.priority,
    evidenceRequirements: input.evidenceRequirements ?? input.evidence_requirements ?? current.evidence_requirements,
  });
  await Promise.all([
    assertWorkspaceOwner(workspaceId, value.ownerId, database),
    assertWorkspaceProject(workspaceId, value.primaryProjectId, database),
  ]);

  const { rows } = await database.query(
    `
    UPDATE okr_objectives SET
      owner_id = $1,
      title = $2,
      description = $3,
      time_period = $4,
      success_measure = $5,
      target_date = $6,
      primary_project_id = $7,
      priority = $8,
      evidence_requirements = $9::jsonb,
      updated_at = NOW()
    WHERE id = $10 AND workspace_id = $11
    RETURNING id
    `,
    [
      value.ownerId,
      value.outcome,
      value.whyItMatters,
      deriveTimePeriod(value.targetDate),
      value.successMeasure,
      value.targetDate,
      value.primaryProjectId,
      value.priority,
      JSON.stringify(value.evidenceRequirements),
      id,
      workspaceId,
    ]
  );
  if (!rows[0]) throw httpError("Outcome not found", 404, "ASSURANCE_NOT_FOUND");

  await logAudit({
    workspaceId,
    userId: actorId,
    action: "assurance.outcome.update",
    entityType: "goal",
    entityId: id,
    oldValue: { title: current.title, targetDate: current.target_date },
    newValue: { title: value.outcome, targetDate: value.targetDate },
  });
  return requireCommitment({ id, workspaceId, userId: actorId, role, database, now });
}

async function assertEvidenceSource({ workspaceId, sourceEntityType, sourceEntityId, database = pool }) {
  if (!sourceEntityId || !sourceEntityType) return;
  const supported = { task: "tasks", project: "projects" };
  const table = supported[sourceEntityType];
  if (!table) return;
  const validatedSourceId = uuidValue(sourceEntityId, { required: true, label: sourceEntityType });
  const { rows } = await database.query(
    `SELECT id FROM ${table} WHERE id = $1 AND workspace_id = $2 LIMIT 1`,
    [validatedSourceId, workspaceId]
  );
  if (!rows[0]) throw httpError(`Referenced ${sourceEntityType} was not found in this workspace`);
}

export async function addAssuranceEvidence({
  id,
  workspaceId,
  actorId,
  role,
  input,
  database = pool,
  now = new Date(),
}) {
  const commitment = await requireCommitment({ id, workspaceId, userId: actorId, role, database, now });
  if (!canManageAssurance(role) && String(commitment.owner_id) !== String(actorId)) {
    throw httpError("You can only add evidence to outcomes you own", 403, "ASSURANCE_FORBIDDEN");
  }

  const evidenceType = String(input.evidenceType ?? input.evidence_type ?? "result").toLowerCase();
  if (!EVIDENCE_TYPES.has(evidenceType)) throw httpError("Evidence type is not supported");
  const label = cleanText(input.label, 500, { required: true, label: "Evidence" });
  const note = cleanText(input.note, 4000, { label: "Evidence note" });
  const sourceEntityType = cleanText(input.sourceEntityType ?? input.source_entity_type, 50);
  const sourceEntityId = cleanText(input.sourceEntityId ?? input.source_entity_id, 200);
  await assertEvidenceSource({ workspaceId, sourceEntityType, sourceEntityId, database });

  const { rows } = await database.query(
    `
    INSERT INTO goal_assurance_evidence (
      workspace_id, goal_id, evidence_type, label, note,
      source_entity_type, source_entity_id, recorded_by, provenance, recorded_at
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)
    RETURNING *
    `,
    [
      workspaceId,
      id,
      evidenceType,
      label,
      note,
      sourceEntityType,
      sourceEntityId,
      actorId,
      JSON.stringify({ source: "workspace_user", schemaVersion: 1 }),
      now.toISOString(),
    ]
  );

  await logAudit({
    workspaceId,
    userId: actorId,
    action: "assurance.evidence.record",
    entityType: "goal",
    entityId: id,
    newValue: { evidenceId: rows[0].id, evidenceType, label },
  });
  return rows[0];
}

export async function completeAssuranceCommitment({
  id,
  workspaceId,
  actorId,
  role,
  input = {},
  database = pool,
  now = new Date(),
}) {
  if (!canManageAssurance(role)) throw httpError("Manager access is required", 403, "ASSURANCE_FORBIDDEN");
  const current = await requireCommitment({ id, workspaceId, userId: actorId, role, database, now });
  const evidenceLabel = cleanText(input.evidenceLabel ?? input.label, 500, { label: "Result evidence" });
  const evidenceNote = cleanText(input.note, 4000, { label: "Evidence note" });
  if (!evidenceLabel && current.assurance.counts.resultEvidence === 0) {
    throw httpError("Add a short result statement before marking this outcome complete");
  }

  const client = await database.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM okr_objectives WHERE id = $1 AND workspace_id = $2 FOR UPDATE", [id, workspaceId]);
    if (evidenceLabel) {
      await client.query(
        `
        INSERT INTO goal_assurance_evidence (
          workspace_id, goal_id, evidence_type, label, note, recorded_by, provenance, recorded_at
        ) VALUES ($1,$2,'result',$3,$4,$5,$6::jsonb,$7)
        `,
        [
          workspaceId,
          id,
          evidenceLabel,
          evidenceNote,
          actorId,
          JSON.stringify({ source: "completion_confirmation", schemaVersion: 1 }),
          now.toISOString(),
        ]
      );
    }
    await client.query(
      `UPDATE okr_objectives
       SET status = 'done', progress = 100, updated_at = NOW()
       WHERE id = $1 AND workspace_id = $2`,
      [id, workspaceId]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  await logAudit({
    workspaceId,
    userId: actorId,
    action: "assurance.outcome.complete",
    entityType: "goal",
    entityId: id,
    oldValue: { status: current.status, progress: current.progress },
    newValue: { status: "done", progress: 100, resultEvidenceRecorded: Boolean(evidenceLabel) },
  });
  return requireCommitment({ id, workspaceId, userId: actorId, role, database, now });
}

function recoveryDueDate(targetDate, now = new Date()) {
  const today = todayUtc(now);
  const sevenDays = new Date(`${today}T00:00:00.000Z`);
  sevenDays.setUTCDate(sevenDays.getUTCDate() + 7);
  const proposed = sevenDays.toISOString().slice(0, 10);
  return ISO_DATE.test(String(targetDate || "")) && targetDate > today && targetDate < proposed
    ? targetDate
    : proposed;
}

export async function createAssuranceRecoveryTask({
  id,
  workspaceId,
  actorId,
  role,
  database = pool,
  now = new Date(),
}) {
  if (!canManageAssurance(role)) throw httpError("Manager access is required", 403, "ASSURANCE_FORBIDDEN");
  const commitment = await requireCommitment({ id, workspaceId, userId: actorId, role, database, now });
  if (!commitment.primary_project_id) {
    throw httpError("Connect a project before creating recovery work");
  }
  if (commitment.assurance.state === "verified") {
    throw httpError("This outcome is already verified", 409, "ASSURANCE_ALREADY_VERIFIED");
  }

  const attention = buildAssuranceAttention(commitment);
  const idempotencyKey = [
    "assurance-recovery",
    id,
    dateOnly(commitment.updated_at),
    commitment.assurance.state,
    commitment.assurance.counts.overdueTasks,
    commitment.assurance.counts.blockedTasks,
  ].join(":");

  const action = await createOperationsAction({
    workspaceId,
    source: "assurance",
    roleScope: "workspace",
    title: `Recovery task for ${commitment.title}`.slice(0, 500),
    summary: attention?.reason || "Follow up on this outcome before its target date.",
    explanation: "Created only after an authorized manager requested the intervention.",
    confidence: null,
    riskLevel: commitment.assurance.state === "off_track" ? "high" : "medium",
    actionType: "create_followup_task",
    createdBy: actorId,
    targetUserId: commitment.owner_id,
    projectId: commitment.primary_project_id,
    goalId: commitment.id,
    payload: {
      projectId: commitment.primary_project_id,
      taskTitle: `Resolve outcome risk: ${commitment.title}`.slice(0, 500),
      assignedTo: commitment.owner_id,
      dueDate: recoveryDueDate(commitment.target_date, now),
      priority: commitment.priority === "critical" ? "high" : commitment.priority,
      description: `${attention?.reason || "Outcome needs attention"}\n\nSuccess measure: ${commitment.success_measure}`,
    },
    evidence: [{
      type: "outcome_assurance",
      source: "workspace_commitment",
      fact: attention?.reason || commitment.assurance.explanation,
      goalId: commitment.id,
    }],
    generatedBy: "deterministic_assurance_rule",
    approvalMode: "approval_required",
    idempotencyKey,
  });

  const executed = action.status === "executed"
    ? action
    : await approveOperationsAction({
      id: action.id,
      workspaceId,
      actorId,
      role,
      notes: "Authorized from Execution Assurance",
      execute: true,
    });

  await logAudit({
    workspaceId,
    userId: actorId,
    action: "assurance.recovery_task.execute",
    entityType: "goal",
    entityId: id,
    newValue: { actionId: executed.id, result: executed.result || null },
  });
  return executed;
}

export async function getAssuranceCommitmentDetail({
  id,
  workspaceId,
  userId,
  role,
  database = pool,
  now = new Date(),
}) {
  const commitment = await requireCommitment({ id, workspaceId, userId, role, database, now });
  const [evidenceResult, actionResult] = await Promise.all([
    database.query(
      `
      SELECT gae.*, u.username AS recorded_by_name
      FROM goal_assurance_evidence gae
      LEFT JOIN users u ON u.id = gae.recorded_by AND u.workspace_id = gae.workspace_id
      WHERE gae.workspace_id = $1 AND gae.goal_id = $2
      ORDER BY gae.recorded_at DESC
      `,
      [workspaceId, id]
    ),
    database.query(
      `
      SELECT id, title, summary, explanation, status, risk_level, result,
             approved_by, approved_at, executed_at, created_at
      FROM operations_ai_actions
      WHERE workspace_id = $1 AND goal_id = $2
      ORDER BY created_at DESC
      LIMIT 50
      `,
      [workspaceId, id]
    ),
  ]);

  return { commitment, evidence: evidenceResult.rows, decisions: actionResult.rows };
}
