import pool from "../db.js";
import { logAudit } from "./audit.service.js";
import { getAssuranceCommitmentDetail } from "./executionAssurance.service.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TYPES = new Set(["contractual", "regulatory", "security", "operational"]);
const SEVERITIES = new Set(["low", "medium", "high", "critical"]);
const STATUSES = new Set(["open", "satisfied", "waived"]);

function httpError(message, statusCode = 400, code = "ASSURANCE_OBLIGATION_INVALID") {
  return Object.assign(new Error(message), { statusCode, code });
}

function text(value, max, label, required = false) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (required && !normalized) throw httpError(`${label} is required`);
  if (normalized.length > max) throw httpError(`${label} must be ${max} characters or fewer`);
  return normalized || null;
}

function uuid(value, label) {
  const normalized = text(value, 100, label, true);
  if (!UUID.test(normalized)) throw httpError(`${label} is not valid`);
  return normalized;
}

function date(value, label) {
  if (value == null || value === "") return null;
  const normalized = String(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized) || !Number.isFinite(Date.parse(`${normalized}T00:00:00Z`))) {
    throw httpError(`${label} is not valid`);
  }
  return normalized;
}

function assertManager(role) {
  if (!["manager", "admin"].includes(String(role || "").toLowerCase())) {
    throw httpError("Manager access is required", 403, "ASSURANCE_FORBIDDEN");
  }
}

async function visibleGoal(args) {
  return getAssuranceCommitmentDetail({
    id: args.goalId,
    workspaceId: args.workspaceId,
    userId: args.actorId,
    role: args.role,
    database: args.database,
  });
}

export async function listAssuranceObligations({ workspaceId, goalId, actorId, role, database = pool }) {
  const id = uuid(goalId, "Outcome");
  await visibleGoal({ workspaceId, goalId: id, actorId, role, database });
  const { rows } = await database.query(
    `SELECT obligation.*, owner.username AS owner_name,
            COALESCE(evidence.items, '[]'::json) AS evidence
     FROM assurance_obligations obligation
     LEFT JOIN users owner ON owner.workspace_id=obligation.workspace_id AND owner.id=obligation.owner_id
     LEFT JOIN LATERAL (
       SELECT json_agg(json_build_object(
         'id', item.id, 'label', item.label, 'type', item.evidence_type,
         'recordedAt', item.recorded_at, 'linkedAt', link.linked_at
       ) ORDER BY link.linked_at DESC) AS items
       FROM assurance_obligation_evidence link
       JOIN goal_assurance_evidence item
         ON item.workspace_id=link.workspace_id AND item.goal_id=link.goal_id AND item.id=link.evidence_id
       WHERE link.workspace_id=obligation.workspace_id AND link.obligation_id=obligation.id
     ) evidence ON TRUE
     WHERE obligation.workspace_id=$1 AND obligation.goal_id=$2
     ORDER BY obligation.status, obligation.due_date NULLS LAST, obligation.created_at`,
    [workspaceId, id]
  );
  return rows;
}

export async function createAssuranceObligation({ workspaceId, goalId, actorId, role, input = {}, database = pool }) {
  assertManager(role);
  const id = uuid(goalId, "Outcome");
  await visibleGoal({ workspaceId, goalId: id, actorId, role, database });
  const type = String(input.type || input.obligationType || "operational").toLowerCase();
  const severity = String(input.severity || "medium").toLowerCase();
  if (!TYPES.has(type)) throw httpError("Obligation type is not supported");
  if (!SEVERITIES.has(severity)) throw httpError("Severity is not supported");
  const ownerId = input.ownerId ? uuid(input.ownerId, "Owner") : actorId;
  const { rows } = await database.query(
    `INSERT INTO assurance_obligations
       (workspace_id, goal_id, obligation_type, title, description, control_reference,
        owner_id, due_date, severity, created_by)
     SELECT $1,$2,$3,$4,$5,$6,user_record.id,$7,$8,$9
     FROM users user_record
     WHERE user_record.workspace_id=$1 AND user_record.id=$10 AND user_record.disabled_at IS NULL
     RETURNING *`,
    [workspaceId, id, type, text(input.title, 300, "Title", true), text(input.description, 4000, "Description"),
      text(input.controlReference ?? input.control_reference, 200, "Control reference"), date(input.dueDate ?? input.due_date, "Due date"),
      severity, actorId, ownerId]
  );
  if (!rows[0]) throw httpError("Owner is not an active workspace member", 409, "ASSURANCE_OWNER_UNAVAILABLE");
  await logAudit({ workspaceId, userId: actorId, action: "assurance.obligation.create", entityType: "assurance_obligation", entityId: rows[0].id, newValue: rows[0] });
  return rows[0];
}

export async function updateAssuranceObligation({ workspaceId, obligationId, actorId, role, input = {}, database = pool, now = new Date() }) {
  assertManager(role);
  const id = uuid(obligationId, "Obligation");
  const selected = await database.query("SELECT * FROM assurance_obligations WHERE workspace_id=$1 AND id=$2", [workspaceId, id]);
  const current = selected.rows[0];
  if (!current) throw httpError("Obligation not found", 404, "ASSURANCE_NOT_FOUND");
  await visibleGoal({ workspaceId, goalId: current.goal_id, actorId, role, database });
  const status = String(input.status ?? current.status).toLowerCase();
  const severity = String(input.severity ?? current.severity).toLowerCase();
  if (!STATUSES.has(status)) throw httpError("Obligation status is not supported");
  if (!SEVERITIES.has(severity)) throw httpError("Severity is not supported");
  const waiverReason = text(input.waiverReason ?? input.waiver_reason ?? current.waiver_reason, 2000, "Waiver reason", status === "waived");
  if (status === "satisfied") {
    const linked = await database.query(
      "SELECT 1 FROM assurance_obligation_evidence WHERE workspace_id=$1 AND obligation_id=$2 LIMIT 1",
      [workspaceId, id]
    );
    if (!linked.rows[0]) throw httpError("Link evidence before satisfying this obligation", 409, "ASSURANCE_EVIDENCE_REQUIRED");
  }
  const { rows } = await database.query(
    `UPDATE assurance_obligations SET
       title=$1, description=$2, control_reference=$3, due_date=$4, severity=$5,
       status=$6, waiver_reason=$7,
       satisfied_at=CASE WHEN $6='satisfied' THEN COALESCE(satisfied_at,$8) ELSE NULL END,
       updated_at=$8
     WHERE workspace_id=$9 AND id=$10 RETURNING *`,
    [text(input.title ?? current.title, 300, "Title", true), text(input.description ?? current.description, 4000, "Description"),
      text(input.controlReference ?? input.control_reference ?? current.control_reference, 200, "Control reference"),
      date(input.dueDate ?? input.due_date ?? current.due_date, "Due date"),
      severity, status, waiverReason, now.toISOString(), workspaceId, id]
  );
  await logAudit({ workspaceId, userId: actorId, action: "assurance.obligation.update", entityType: "assurance_obligation", entityId: id, oldValue: current, newValue: rows[0] });
  return rows[0];
}

export async function linkAssuranceObligationEvidence({ workspaceId, obligationId, evidenceId, actorId, role, database = pool }) {
  assertManager(role);
  const obligation = uuid(obligationId, "Obligation");
  const evidence = uuid(evidenceId, "Evidence");
  const { rows } = await database.query(
    `INSERT INTO assurance_obligation_evidence
       (workspace_id, obligation_id, goal_id, evidence_id, linked_by)
     SELECT obligation.workspace_id, obligation.id, obligation.goal_id, item.id, $3
     FROM assurance_obligations obligation
     JOIN goal_assurance_evidence item
       ON item.workspace_id=obligation.workspace_id AND item.goal_id=obligation.goal_id AND item.id=$2
     WHERE obligation.workspace_id=$1 AND obligation.id=$4
     ON CONFLICT DO NOTHING
     RETURNING *`,
    [workspaceId, evidence, actorId, obligation]
  );
  if (!rows[0]) {
    const exists = await database.query(
      "SELECT 1 FROM assurance_obligation_evidence WHERE workspace_id=$1 AND obligation_id=$2 AND evidence_id=$3",
      [workspaceId, obligation, evidence]
    );
    if (!exists.rows[0]) throw httpError("Obligation or evidence not found", 404, "ASSURANCE_NOT_FOUND");
  }
  await logAudit({ workspaceId, userId: actorId, action: "assurance.obligation.evidence_link", entityType: "assurance_obligation", entityId: obligation, newValue: { evidenceId: evidence } });
  return { obligationId: obligation, evidenceId: evidence, linked: true };
}
