import pool from "../db.js";
import { createHuddleSessionEvent } from "./huddleEvent.service.js";

export const HUDDLE_ARTIFACT_TYPES = Object.freeze({
  TRANSCRIPT: "transcript",
  SUMMARY: "summary",
  DECISION: "decision",
  ACTION_ITEM: "action_item",
  TIMELINE: "timeline",
  MEMORY: "memory",
});

export const HUDDLE_ARTIFACT_STATUSES = Object.freeze({
  DRAFT: "draft",
  PENDING: "pending",
  PROCESSING: "processing",
  READY: "ready",
  FAILED: "failed",
  ARCHIVED: "archived",
  SUPERSEDED: "superseded",
  DELETED: "deleted",
});

export const HUDDLE_ARTIFACT_APPROVAL_STATUSES = Object.freeze({
  NOT_REQUIRED: "not_required",
  PENDING: "pending",
  APPROVED: "approved",
  REJECTED: "rejected",
  REVOKED: "revoked",
});

export const HUDDLE_ARTIFACT_VISIBILITIES = Object.freeze({
  SESSION_PARTICIPANTS: "session_participants",
  SCOPE_MEMBERS: "scope_members",
  WORKSPACE_ADMINS: "workspace_admins",
  PRIVATE: "private",
});

export const HUDDLE_ARTIFACT_SOURCE_KINDS = Object.freeze({
  TRANSCRIPT_SEGMENT: "transcript_segment",
  TRANSCRIPT_RANGE: "transcript_range",
  ARTIFACT: "artifact",
  EVENT: "event",
  MANUAL: "manual",
  PROVIDER: "provider",
});

export const HUDDLE_ARTIFACT_EVENTS = Object.freeze({
  CREATED: "huddle.artifact.created",
  UPDATED: "huddle.artifact.updated",
  APPROVED: "huddle.artifact.approved",
  REJECTED: "huddle.artifact.rejected",
  PERMISSION_GRANTED: "huddle.artifact.permission_granted",
  SOURCE_LINKED: "huddle.artifact.source_linked",
});

export const HUDDLE_ARTIFACT_PERMISSION_REASONS = Object.freeze({
  ALLOWED: "allowed",
  SESSION_NOT_FOUND: "session_not_found",
  ARTIFACT_NOT_FOUND: "artifact_not_found",
  PARTICIPATION_REQUIRED: "huddle_artifact_participation_required",
  WRITE_FORBIDDEN: "huddle_artifact_write_forbidden",
  APPROVAL_FORBIDDEN: "huddle_artifact_approval_forbidden",
  PRIVATE_ARTIFACT: "huddle_artifact_private",
  ADMIN_REQUIRED: "huddle_artifact_admin_required",
});

const CANONICAL_TYPES = Object.freeze(Object.values(HUDDLE_ARTIFACT_TYPES));
const ALL_TYPES = Object.freeze([
  ...CANONICAL_TYPES,
  "recording",
  "ai_memory",
  "task_link",
  "chat_follow_up",
  "quality_report",
  "compliance_export",
]);

function runner(client) {
  return client || pool;
}

function json(value) {
  return JSON.stringify(value && typeof value === "object" && !Array.isArray(value) ? value : {});
}

function safeString(value, maxLength = null) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return maxLength ? normalized.slice(0, maxLength) : normalized;
}

function safeUuid(value) {
  const normalized = safeString(String(value || ""));
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)
    ? normalized
    : null;
}

function safeTimestamp(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function objectOrEmpty(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function arrayOrEmpty(value) {
  return Array.isArray(value) ? value : [];
}

function boundedText(value, maxLength = 200000) {
  const text = safeString(value);
  return text ? text.slice(0, maxLength) : null;
}

function isPrivilegedRole(role) {
  return ["admin", "owner", "manager"].includes(safeString(role).toLowerCase());
}

function isHuddleHost(session, userId) {
  const uid = String(userId || "");
  return Boolean(
    uid &&
    (String(session?.started_by || "") === uid || String(session?.host_user_id || "") === uid)
  );
}

function isJoinedParticipant(participant) {
  if (!participant?.id) return false;
  if (participant.left_at) return false;
  return ["joined", "joining", "reconnecting", "invited"].includes(
    safeString(participant.join_state || "joined")
  );
}

function createServiceError(message, statusCode = 400, reason = message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.reason = reason;
  return err;
}

function normalizeType(type) {
  const normalized = safeString(type).toLowerCase();
  if (ALL_TYPES.includes(normalized)) return normalized;
  return HUDDLE_ARTIFACT_TYPES.TRANSCRIPT;
}

function normalizeStatus(status, fallback = HUDDLE_ARTIFACT_STATUSES.DRAFT) {
  const normalized = safeString(status).toLowerCase();
  if (Object.values(HUDDLE_ARTIFACT_STATUSES).includes(normalized)) return normalized;
  return fallback;
}

function normalizeApprovalStatus(
  status,
  fallback = HUDDLE_ARTIFACT_APPROVAL_STATUSES.NOT_REQUIRED
) {
  const normalized = safeString(status).toLowerCase();
  if (Object.values(HUDDLE_ARTIFACT_APPROVAL_STATUSES).includes(normalized)) return normalized;
  return fallback;
}

function normalizeVisibility(visibility) {
  const normalized = safeString(visibility).toLowerCase();
  if (Object.values(HUDDLE_ARTIFACT_VISIBILITIES).includes(normalized)) return normalized;
  return HUDDLE_ARTIFACT_VISIBILITIES.SESSION_PARTICIPANTS;
}

function normalizeSourceKind(kind) {
  const normalized = safeString(kind).toLowerCase();
  if (Object.values(HUDDLE_ARTIFACT_SOURCE_KINDS).includes(normalized)) return normalized;
  return HUDDLE_ARTIFACT_SOURCE_KINDS.MANUAL;
}

async function withTransaction(client, callback) {
  if (client) return callback(client);
  const tx = await pool.connect();
  try {
    await tx.query("BEGIN");
    const result = await callback(tx);
    await tx.query("COMMIT");
    return result;
  } catch (err) {
    await tx.query("ROLLBACK");
    throw err;
  } finally {
    tx.release();
  }
}

function serializeArtifact(row = {}) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    artifactType: row.artifact_type,
    status: row.status,
    currentRevision: row.current_revision,
    approvalStatus: row.approval_status,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    rejectedBy: row.rejected_by,
    rejectedAt: row.rejected_at,
    approvalNote: row.approval_note,
    createdBy: row.created_by,
    sourceEventId: row.source_event_id,
    storageProvider: row.storage_provider,
    storageKey: row.storage_key,
    contentJson: row.content_json || {},
    contentText: row.content_text,
    visibility: row.visibility,
    retentionPolicy: row.retention_policy,
    retentionExpiresAt: row.retention_expires_at,
    retentionHold: Boolean(row.retention_hold),
    provenance: row.provenance_json || {},
    metadata: row.metadata || {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

function serializeRevision(row = {}) {
  if (!row) return null;
  return {
    id: row.id,
    artifactId: row.artifact_id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    revisionNumber: row.revision_number,
    artifactType: row.artifact_type,
    status: row.status,
    approvalStatus: row.approval_status,
    contentJson: row.content_json || {},
    contentText: row.content_text,
    provenance: row.provenance_json || {},
    sourceEventId: row.source_event_id,
    createdBy: row.created_by,
    metadata: row.metadata || {},
    createdAt: row.created_at,
  };
}

function serializeSource(row = {}) {
  if (!row) return null;
  return {
    id: row.id,
    artifactId: row.artifact_id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    sourceKind: row.source_kind,
    transcriptSegmentId: row.transcript_segment_id,
    sourceArtifactId: row.source_artifact_id,
    sourceEventId: row.source_event_id,
    sourceRef: row.source_ref,
    rangeStartAt: row.range_start_at,
    rangeEndAt: row.range_end_at,
    createdBy: row.created_by,
    metadata: row.metadata || {},
    createdAt: row.created_at,
  };
}

function serializePermission(row = {}) {
  if (!row) return null;
  return {
    id: row.id,
    artifactId: row.artifact_id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    principalKind: row.principal_kind,
    userId: row.user_id,
    participantId: row.participant_id,
    roleName: row.role_name,
    permission: row.permission,
    grantedBy: row.granted_by,
    metadata: row.metadata || {},
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
    revokedBy: row.revoked_by,
  };
}

function serializeEvent(row = {}) {
  if (!row) return null;
  return {
    id: row.id,
    sessionId: row.session_id,
    workspaceId: row.workspace_id,
    actorUserId: row.actor_user_id,
    actorGuestId: row.actor_guest_id,
    eventType: row.event_type,
    eventPayload: row.event_payload || {},
    createdAt: row.created_at,
  };
}

function hasExplicitPermission({ grants = [], userId, participant, role, action }) {
  const acceptable = action === "read"
    ? ["read", "write", "approve", "admin"]
    : action === "write"
    ? ["write", "admin"]
    : action === "approve"
    ? ["approve", "admin"]
    : ["admin"];
  const participantId = participant?.id ? String(participant.id) : null;
  const uid = String(userId || "");
  const normalizedRole = safeString(role).toLowerCase();

  return grants.some((grant) => {
    if (!acceptable.includes(grant.permission)) return false;
    if (grant.revoked_at) return false;
    if (grant.principal_kind === "workspace") return true;
    if (grant.principal_kind === "session_participants" && participantId) return true;
    if (grant.principal_kind === "user" && uid && String(grant.user_id) === uid) return true;
    if (grant.principal_kind === "participant" && participantId && String(grant.participant_id) === participantId) return true;
    if (grant.principal_kind === "role" && normalizedRole && safeString(grant.role_name).toLowerCase() === normalizedRole) return true;
    return false;
  });
}

export function evaluateArtifactPermission({
  session = null,
  participant = null,
  artifact = null,
  grants = [],
  userId = null,
  role = "user",
  action = "read",
} = {}) {
  if (!session) {
    return { allowed: false, reason: HUDDLE_ARTIFACT_PERMISSION_REASONS.SESSION_NOT_FOUND };
  }

  const privileged = isPrivilegedRole(role);
  const host = isHuddleHost(session, userId);
  const participantJoined = isJoinedParticipant(participant);
  const creator = artifact?.created_by && String(artifact.created_by) === String(userId || "");
  const explicit = hasExplicitPermission({ grants, userId, participant, role, action });
  const visibility = artifact?.visibility || HUDDLE_ARTIFACT_VISIBILITIES.SESSION_PARTICIPANTS;

  if (action === "read") {
    if (artifact?.deleted_at || artifact?.status === HUDDLE_ARTIFACT_STATUSES.DELETED) {
      return { allowed: privileged, reason: privileged ? "allowed" : "huddle_artifact_deleted" };
    }
    if (visibility === HUDDLE_ARTIFACT_VISIBILITIES.WORKSPACE_ADMINS) {
      return {
        allowed: privileged || explicit,
        reason: privileged || explicit
          ? HUDDLE_ARTIFACT_PERMISSION_REASONS.ALLOWED
          : HUDDLE_ARTIFACT_PERMISSION_REASONS.ADMIN_REQUIRED,
      };
    }
    if (visibility === HUDDLE_ARTIFACT_VISIBILITIES.PRIVATE) {
      return {
        allowed: privileged || creator || explicit,
        reason: privileged || creator || explicit
          ? HUDDLE_ARTIFACT_PERMISSION_REASONS.ALLOWED
          : HUDDLE_ARTIFACT_PERMISSION_REASONS.PRIVATE_ARTIFACT,
      };
    }
    const allowed = privileged || host || participantJoined || explicit;
    return {
      allowed,
      reason: allowed
        ? HUDDLE_ARTIFACT_PERMISSION_REASONS.ALLOWED
        : HUDDLE_ARTIFACT_PERMISSION_REASONS.PARTICIPATION_REQUIRED,
    };
  }

  if (action === "write") {
    const immutableApproval =
      artifact?.approval_status === HUDDLE_ARTIFACT_APPROVAL_STATUSES.APPROVED &&
      !privileged &&
      !explicit;
    const allowed = !immutableApproval && (privileged || host || creator || explicit);
    return {
      allowed,
      reason: allowed
        ? HUDDLE_ARTIFACT_PERMISSION_REASONS.ALLOWED
        : HUDDLE_ARTIFACT_PERMISSION_REASONS.WRITE_FORBIDDEN,
    };
  }

  if (action === "approve") {
    const allowed = privileged || host || explicit;
    return {
      allowed,
      reason: allowed
        ? HUDDLE_ARTIFACT_PERMISSION_REASONS.ALLOWED
        : HUDDLE_ARTIFACT_PERMISSION_REASONS.APPROVAL_FORBIDDEN,
    };
  }

  const allowed = privileged || explicit;
  return {
    allowed,
    reason: allowed
      ? HUDDLE_ARTIFACT_PERMISSION_REASONS.ALLOWED
      : HUDDLE_ARTIFACT_PERMISSION_REASONS.ADMIN_REQUIRED,
  };
}

async function getSessionAccessContext({ workspaceId, sessionId, userId, role = "user", client = null }) {
  if (!workspaceId) throw createServiceError("workspaceId is required", 400, "workspace_required");
  if (!sessionId) throw createServiceError("sessionId is required", 400, "session_required");
  if (!userId) throw createServiceError("userId is required", 401, "user_required");

  const { rows } = await runner(client).query(
    `
    SELECT
      s.*,
      p.id AS access_participant_id,
      p.user_id AS access_participant_user_id,
      p.guest_id AS access_participant_guest_id,
      p.join_state AS access_participant_join_state,
      p.left_at AS access_participant_left_at
    FROM huddle_sessions s
    LEFT JOIN huddle_session_participants p
      ON p.session_id = s.id
     AND p.workspace_id = s.workspace_id
     AND p.user_id = $3
    WHERE s.id = $1
      AND s.workspace_id = $2
    ORDER BY p.joined_at DESC NULLS LAST, p.created_at DESC NULLS LAST
    LIMIT 1
    `,
    [sessionId, workspaceId, userId]
  );

  const row = rows[0];
  if (!row) {
    throw createServiceError(
      "Huddle session not found",
      404,
      HUDDLE_ARTIFACT_PERMISSION_REASONS.SESSION_NOT_FOUND
    );
  }

  const participant = row.access_participant_id
    ? {
        id: row.access_participant_id,
        user_id: row.access_participant_user_id,
        guest_id: row.access_participant_guest_id,
        join_state: row.access_participant_join_state,
        left_at: row.access_participant_left_at,
      }
    : null;

  return { workspaceId, sessionId, userId, role, session: row, participant };
}

async function getArtifactGrants({ artifactId, workspaceId, client = null }) {
  const { rows } = await runner(client).query(
    `
    SELECT *
    FROM huddle_artifact_permissions
    WHERE artifact_id = $1
      AND workspace_id = $2
      AND revoked_at IS NULL
    `,
    [artifactId, workspaceId]
  );
  return rows;
}

function assertPermission(permission) {
  if (permission.allowed) return;
  const statusCode =
    permission.reason === HUDDLE_ARTIFACT_PERMISSION_REASONS.SESSION_NOT_FOUND ||
    permission.reason === HUDDLE_ARTIFACT_PERMISSION_REASONS.ARTIFACT_NOT_FOUND
      ? 404
      : 403;
  throw createServiceError(permission.reason, statusCode, permission.reason);
}

async function getArtifactRow({ workspaceId, artifactId, client = null }) {
  const { rows } = await runner(client).query(
    `
    SELECT *
    FROM huddle_artifacts
    WHERE id = $1
      AND workspace_id = $2
    LIMIT 1
    `,
    [artifactId, workspaceId]
  );
  const artifact = rows[0] || null;
  if (!artifact) {
    throw createServiceError(
      "Huddle artifact not found",
      404,
      HUDDLE_ARTIFACT_PERMISSION_REASONS.ARTIFACT_NOT_FOUND
    );
  }
  return artifact;
}

async function recordArtifactEvent({ eventType, artifact, actorUserId, eventPayload = {}, client }) {
  return createHuddleSessionEvent({
    workspaceId: artifact.workspace_id,
    sessionId: artifact.session_id,
    actorUserId,
    eventType,
    eventPayload: {
      artifact: {
        id: artifact.id,
        artifactType: artifact.artifact_type,
        status: artifact.status,
        approvalStatus: artifact.approval_status,
        currentRevision: artifact.current_revision,
      },
      ...eventPayload,
    },
    client,
  });
}

async function insertRevision({ artifact, createdBy, metadata = {}, client }) {
  const { rows } = await client.query(
    `
    INSERT INTO huddle_artifact_revisions (
      artifact_id,
      workspace_id,
      session_id,
      revision_number,
      artifact_type,
      status,
      approval_status,
      content_json,
      content_text,
      provenance_json,
      source_event_id,
      created_by,
      metadata
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10::jsonb,$11,$12,$13::jsonb)
    RETURNING *
    `,
    [
      artifact.id,
      artifact.workspace_id,
      artifact.session_id,
      artifact.current_revision || 1,
      artifact.artifact_type,
      artifact.status,
      artifact.approval_status,
      json(artifact.content_json),
      artifact.content_text || null,
      json(artifact.provenance_json),
      artifact.source_event_id || null,
      createdBy || null,
      json(metadata),
    ]
  );
  return rows[0];
}

function normalizeSourceInput(source = {}) {
  return {
    sourceKind: normalizeSourceKind(source.sourceKind || source.source_kind),
    transcriptSegmentId: safeUuid(source.transcriptSegmentId || source.transcript_segment_id),
    sourceArtifactId: safeUuid(source.sourceArtifactId || source.source_artifact_id),
    sourceEventId: safeUuid(source.sourceEventId || source.source_event_id),
    sourceRef: safeString(source.sourceRef || source.source_ref, 500) || null,
    rangeStartAt: safeTimestamp(source.rangeStartAt || source.range_start_at),
    rangeEndAt: safeTimestamp(source.rangeEndAt || source.range_end_at),
    metadata: objectOrEmpty(source.metadata),
  };
}

async function insertSources({ artifact, sources = [], createdBy, client }) {
  const inserted = [];
  for (const source of arrayOrEmpty(sources)) {
    const normalized = normalizeSourceInput(source);
    const { rows } = await client.query(
      `
      INSERT INTO huddle_artifact_sources (
        artifact_id,
        workspace_id,
        session_id,
        source_kind,
        transcript_segment_id,
        source_artifact_id,
        source_event_id,
        source_ref,
        range_start_at,
        range_end_at,
        created_by,
        metadata
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
      RETURNING *
      `,
      [
        artifact.id,
        artifact.workspace_id,
        artifact.session_id,
        normalized.sourceKind,
        normalized.transcriptSegmentId,
        normalized.sourceArtifactId,
        normalized.sourceEventId,
        normalized.sourceRef,
        normalized.rangeStartAt,
        normalized.rangeEndAt,
        createdBy || null,
        json(normalized.metadata),
      ]
    );
    inserted.push(rows[0]);
  }
  return inserted;
}

function normalizeArtifactInput(input = {}) {
  const approvalStatus = normalizeApprovalStatus(input.approvalStatus || input.approval_status);
  return {
    artifactType: normalizeType(input.artifactType || input.artifact_type || input.type),
    status: normalizeStatus(input.status),
    approvalStatus,
    sourceEventId: safeUuid(input.sourceEventId || input.source_event_id),
    storageProvider: safeString(input.storageProvider || input.storage_provider, 80) || null,
    storageKey: safeString(input.storageKey || input.storage_key, 300) || null,
    contentJson: objectOrEmpty(input.contentJson || input.content_json),
    contentText: boundedText(input.contentText || input.content_text || input.text),
    visibility: normalizeVisibility(input.visibility),
    retentionPolicy: safeString(input.retentionPolicy || input.retention_policy, 120) || null,
    retentionExpiresAt: safeTimestamp(input.retentionExpiresAt || input.retention_expires_at),
    retentionHold: Boolean(input.retentionHold ?? input.retention_hold ?? false),
    provenance: objectOrEmpty(input.provenance || input.provenanceJson || input.provenance_json),
    metadata: objectOrEmpty(input.metadata),
    sources: arrayOrEmpty(input.sources),
  };
}

export async function createHuddleArtifact({
  workspaceId,
  sessionId,
  actorUserId,
  role = "user",
  input = {},
  client = null,
}) {
  return withTransaction(client, async (tx) => {
    const context = await getSessionAccessContext({ workspaceId, sessionId, userId: actorUserId, role, client: tx });
    const canCreate =
      isPrivilegedRole(role) ||
      isHuddleHost(context.session, actorUserId) ||
      isJoinedParticipant(context.participant);
    const sessionPermission = {
      allowed: canCreate,
      reason: canCreate
        ? HUDDLE_ARTIFACT_PERMISSION_REASONS.ALLOWED
        : HUDDLE_ARTIFACT_PERMISSION_REASONS.PARTICIPATION_REQUIRED,
    };
    assertPermission(sessionPermission);

    const normalized = normalizeArtifactInput(input);
    const { rows } = await tx.query(
      `
      INSERT INTO huddle_artifacts (
        workspace_id,
        session_id,
        artifact_type,
        status,
        created_by,
        source_event_id,
        storage_provider,
        storage_key,
        content_json,
        content_text,
        visibility,
        retention_policy,
        retention_expires_at,
        retention_hold,
        approval_status,
        provenance_json,
        metadata
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15,$16::jsonb,$17::jsonb)
      RETURNING *
      `,
      [
        workspaceId,
        sessionId,
        normalized.artifactType,
        normalized.status,
        actorUserId,
        normalized.sourceEventId,
        normalized.storageProvider,
        normalized.storageKey,
        json(normalized.contentJson),
        normalized.contentText,
        normalized.visibility,
        normalized.retentionPolicy,
        normalized.retentionExpiresAt,
        normalized.retentionHold,
        normalized.approvalStatus,
        json(normalized.provenance),
        json(normalized.metadata),
      ]
    );

    const artifact = rows[0];
    const revision = await insertRevision({
      artifact,
      createdBy: actorUserId,
      metadata: { reason: "artifact_created" },
      client: tx,
    });
    const sources = await insertSources({
      artifact,
      sources: normalized.sources,
      createdBy: actorUserId,
      client: tx,
    });
    const event = await recordArtifactEvent({
      eventType: HUDDLE_ARTIFACT_EVENTS.CREATED,
      artifact,
      actorUserId,
      eventPayload: {
        revisionId: revision.id,
        sourceCount: sources.length,
      },
      client: tx,
    });

    return {
      artifact: serializeArtifact(artifact),
      revision: serializeRevision(revision),
      sources: sources.map(serializeSource),
      event: serializeEvent(event),
      permission: sessionPermission,
    };
  });
}

export async function getHuddleArtifact({
  workspaceId,
  artifactId,
  actorUserId,
  role = "user",
  client = null,
}) {
  const artifact = await getArtifactRow({ workspaceId, artifactId, client });
  const context = await getSessionAccessContext({
    workspaceId,
    sessionId: artifact.session_id,
    userId: actorUserId,
    role,
    client,
  });
  const grants = await getArtifactGrants({ artifactId, workspaceId, client });
  assertPermission(evaluateArtifactPermission({
    session: context.session,
    participant: context.participant,
    artifact,
    grants,
    userId: actorUserId,
    role,
    action: "read",
  }));
  return serializeArtifact(artifact);
}

export async function listHuddleArtifacts({
  workspaceId,
  sessionId,
  actorUserId,
  role = "user",
  artifactType = null,
  status = null,
  approvalStatus = null,
  includeDeleted = false,
  limit = 100,
  client = null,
}) {
  const context = await getSessionAccessContext({ workspaceId, sessionId, userId: actorUserId, role, client });
  assertPermission(evaluateArtifactPermission({
    session: context.session,
    participant: context.participant,
    userId: actorUserId,
    role,
    action: "read",
    artifact: { visibility: HUDDLE_ARTIFACT_VISIBILITIES.SESSION_PARTICIPANTS },
  }));

  const params = [workspaceId, sessionId];
  const conditions = ["workspace_id = $1", "session_id = $2"];
  let idx = 3;

  if (!includeDeleted) {
    conditions.push("deleted_at IS NULL");
    conditions.push("status != 'deleted'");
  }
  const type = artifactType ? normalizeType(artifactType) : null;
  if (type) {
    conditions.push(`artifact_type = $${idx}`);
    params.push(type);
    idx += 1;
  }
  const normalizedStatus = status ? normalizeStatus(status, null) : null;
  if (normalizedStatus) {
    conditions.push(`status = $${idx}`);
    params.push(normalizedStatus);
    idx += 1;
  }
  const normalizedApproval = approvalStatus ? normalizeApprovalStatus(approvalStatus, null) : null;
  if (normalizedApproval) {
    conditions.push(`approval_status = $${idx}`);
    params.push(normalizedApproval);
    idx += 1;
  }
  params.push(Math.min(Math.max(Number(limit) || 100, 1), 500));

  const { rows } = await runner(client).query(
    `
    SELECT *
    FROM huddle_artifacts
    WHERE ${conditions.join(" AND ")}
    ORDER BY updated_at DESC, created_at DESC
    LIMIT $${idx}
    `,
    params
  );

  const visible = [];
  for (const artifact of rows) {
    const grants = await getArtifactGrants({ artifactId: artifact.id, workspaceId, client });
    const permission = evaluateArtifactPermission({
      session: context.session,
      participant: context.participant,
      artifact,
      grants,
      userId: actorUserId,
      role,
      action: "read",
    });
    if (permission.allowed) visible.push(serializeArtifact(artifact));
  }

  return visible;
}

export async function updateHuddleArtifact({
  workspaceId,
  artifactId,
  actorUserId,
  role = "user",
  patch = {},
  client = null,
}) {
  return withTransaction(client, async (tx) => {
    const existing = await getArtifactRow({ workspaceId, artifactId, client: tx });
    const context = await getSessionAccessContext({ workspaceId, sessionId: existing.session_id, userId: actorUserId, role, client: tx });
    const grants = await getArtifactGrants({ artifactId, workspaceId, client: tx });
    const permission = evaluateArtifactPermission({
      session: context.session,
      participant: context.participant,
      artifact: existing,
      grants,
      userId: actorUserId,
      role,
      action: "write",
    });
    assertPermission(permission);

    const normalized = normalizeArtifactInput({
      ...existing,
      ...patch,
      artifactType: patch.artifactType || patch.artifact_type || existing.artifact_type,
      contentJson: patch.contentJson || patch.content_json || existing.content_json,
      contentText: patch.contentText ?? patch.content_text ?? existing.content_text,
      retentionPolicy: patch.retentionPolicy ?? patch.retention_policy ?? existing.retention_policy,
      retentionExpiresAt: patch.retentionExpiresAt ?? patch.retention_expires_at ?? existing.retention_expires_at,
      provenance: patch.provenance || patch.provenanceJson || patch.provenance_json || existing.provenance_json,
      approvalStatus: patch.approvalStatus || patch.approval_status || existing.approval_status,
    });
    const nextRevision = Number(existing.current_revision || 1) + 1;
    const deletedAt = normalized.status === HUDDLE_ARTIFACT_STATUSES.DELETED
      ? new Date().toISOString()
      : existing.deleted_at;

    const { rows } = await tx.query(
      `
      UPDATE huddle_artifacts
      SET
        artifact_type = $3,
        status = $4,
        source_event_id = COALESCE($5, source_event_id),
        storage_provider = COALESCE($6, storage_provider),
        storage_key = COALESCE($7, storage_key),
        content_json = $8::jsonb,
        content_text = $9,
        visibility = $10,
        retention_policy = $11,
        retention_expires_at = $12,
        retention_hold = $13,
        approval_status = $14,
        provenance_json = $15::jsonb,
        metadata = metadata || $16::jsonb,
        current_revision = $17,
        deleted_at = $18
      WHERE id = $1
        AND workspace_id = $2
      RETURNING *
      `,
      [
        artifactId,
        workspaceId,
        normalized.artifactType,
        normalized.status,
        normalized.sourceEventId,
        normalized.storageProvider,
        normalized.storageKey,
        json(normalized.contentJson),
        normalized.contentText,
        normalized.visibility,
        normalized.retentionPolicy,
        normalized.retentionExpiresAt,
        normalized.retentionHold,
        normalized.approvalStatus,
        json(normalized.provenance),
        json(normalized.metadata),
        nextRevision,
        deletedAt,
      ]
    );

    const artifact = rows[0];
    const revision = await insertRevision({
      artifact,
      createdBy: actorUserId,
      metadata: { reason: "artifact_updated" },
      client: tx,
    });
    const sources = await insertSources({ artifact, sources: normalized.sources, createdBy: actorUserId, client: tx });
    const event = await recordArtifactEvent({
      eventType: HUDDLE_ARTIFACT_EVENTS.UPDATED,
      artifact,
      actorUserId,
      eventPayload: { revisionId: revision.id, sourceCount: sources.length },
      client: tx,
    });

    return {
      artifact: serializeArtifact(artifact),
      revision: serializeRevision(revision),
      sources: sources.map(serializeSource),
      event: serializeEvent(event),
      permission,
    };
  });
}

export async function approveHuddleArtifact({
  workspaceId,
  artifactId,
  actorUserId,
  role = "user",
  approvalNote = null,
  client = null,
}) {
  return withTransaction(client, async (tx) => {
    const existing = await getArtifactRow({ workspaceId, artifactId, client: tx });
    const context = await getSessionAccessContext({ workspaceId, sessionId: existing.session_id, userId: actorUserId, role, client: tx });
    const grants = await getArtifactGrants({ artifactId, workspaceId, client: tx });
    const permission = evaluateArtifactPermission({
      session: context.session,
      participant: context.participant,
      artifact: existing,
      grants,
      userId: actorUserId,
      role,
      action: "approve",
    });
    assertPermission(permission);

    const { rows } = await tx.query(
      `
      UPDATE huddle_artifacts
      SET approval_status = 'approved',
          approved_by = $3,
          approved_at = now(),
          rejected_by = NULL,
          rejected_at = NULL,
          approval_note = COALESCE($4, approval_note),
          current_revision = current_revision + 1
      WHERE id = $1
        AND workspace_id = $2
      RETURNING *
      `,
      [artifactId, workspaceId, actorUserId, safeString(approvalNote, 2000) || null]
    );
    const artifact = rows[0];
    const revision = await insertRevision({
      artifact,
      createdBy: actorUserId,
      metadata: { reason: "artifact_approved" },
      client: tx,
    });
    const event = await recordArtifactEvent({
      eventType: HUDDLE_ARTIFACT_EVENTS.APPROVED,
      artifact,
      actorUserId,
      eventPayload: { revisionId: revision.id },
      client: tx,
    });
    return { artifact: serializeArtifact(artifact), revision: serializeRevision(revision), event: serializeEvent(event), permission };
  });
}

export async function rejectHuddleArtifact({
  workspaceId,
  artifactId,
  actorUserId,
  role = "user",
  approvalNote = null,
  client = null,
}) {
  return withTransaction(client, async (tx) => {
    const existing = await getArtifactRow({ workspaceId, artifactId, client: tx });
    const context = await getSessionAccessContext({ workspaceId, sessionId: existing.session_id, userId: actorUserId, role, client: tx });
    const grants = await getArtifactGrants({ artifactId, workspaceId, client: tx });
    const permission = evaluateArtifactPermission({
      session: context.session,
      participant: context.participant,
      artifact: existing,
      grants,
      userId: actorUserId,
      role,
      action: "approve",
    });
    assertPermission(permission);

    const { rows } = await tx.query(
      `
      UPDATE huddle_artifacts
      SET approval_status = 'rejected',
          rejected_by = $3,
          rejected_at = now(),
          approved_by = NULL,
          approved_at = NULL,
          approval_note = COALESCE($4, approval_note),
          current_revision = current_revision + 1
      WHERE id = $1
        AND workspace_id = $2
      RETURNING *
      `,
      [artifactId, workspaceId, actorUserId, safeString(approvalNote, 2000) || null]
    );
    const artifact = rows[0];
    const revision = await insertRevision({
      artifact,
      createdBy: actorUserId,
      metadata: { reason: "artifact_rejected" },
      client: tx,
    });
    const event = await recordArtifactEvent({
      eventType: HUDDLE_ARTIFACT_EVENTS.REJECTED,
      artifact,
      actorUserId,
      eventPayload: { revisionId: revision.id },
      client: tx,
    });
    return { artifact: serializeArtifact(artifact), revision: serializeRevision(revision), event: serializeEvent(event), permission };
  });
}

export async function listArtifactRevisions({
  workspaceId,
  artifactId,
  actorUserId,
  role = "user",
  client = null,
}) {
  await getHuddleArtifact({ workspaceId, artifactId, actorUserId, role, client });
  const { rows } = await runner(client).query(
    `
    SELECT *
    FROM huddle_artifact_revisions
    WHERE artifact_id = $1
      AND workspace_id = $2
    ORDER BY revision_number DESC
    `,
    [artifactId, workspaceId]
  );
  return rows.map(serializeRevision);
}

export async function listArtifactSources({
  workspaceId,
  artifactId,
  actorUserId,
  role = "user",
  client = null,
}) {
  await getHuddleArtifact({ workspaceId, artifactId, actorUserId, role, client });
  const { rows } = await runner(client).query(
    `
    SELECT *
    FROM huddle_artifact_sources
    WHERE artifact_id = $1
      AND workspace_id = $2
    ORDER BY created_at ASC
    `,
    [artifactId, workspaceId]
  );
  return rows.map(serializeSource);
}

export async function addArtifactSources({
  workspaceId,
  artifactId,
  actorUserId,
  role = "user",
  sources = [],
  client = null,
}) {
  return withTransaction(client, async (tx) => {
    const existing = await getArtifactRow({ workspaceId, artifactId, client: tx });
    const context = await getSessionAccessContext({ workspaceId, sessionId: existing.session_id, userId: actorUserId, role, client: tx });
    const grants = await getArtifactGrants({ artifactId, workspaceId, client: tx });
    assertPermission(evaluateArtifactPermission({
      session: context.session,
      participant: context.participant,
      artifact: existing,
      grants,
      userId: actorUserId,
      role,
      action: "write",
    }));
    const inserted = await insertSources({ artifact: existing, sources, createdBy: actorUserId, client: tx });
    const event = await recordArtifactEvent({
      eventType: HUDDLE_ARTIFACT_EVENTS.SOURCE_LINKED,
      artifact: existing,
      actorUserId,
      eventPayload: { sourceCount: inserted.length },
      client: tx,
    });
    return { sources: inserted.map(serializeSource), event: serializeEvent(event) };
  });
}

function normalizePermissionInput(input = {}) {
  return {
    principalKind: safeString(input.principalKind || input.principal_kind).toLowerCase() || "user",
    userId: safeUuid(input.userId || input.user_id),
    participantId: safeUuid(input.participantId || input.participant_id),
    roleName: safeString(input.roleName || input.role_name, 80) || null,
    permission: safeString(input.permission).toLowerCase() || "read",
    metadata: objectOrEmpty(input.metadata),
  };
}

export async function grantArtifactPermission({
  workspaceId,
  artifactId,
  actorUserId,
  role = "user",
  input = {},
  client = null,
}) {
  return withTransaction(client, async (tx) => {
    const artifact = await getArtifactRow({ workspaceId, artifactId, client: tx });
    const context = await getSessionAccessContext({ workspaceId, sessionId: artifact.session_id, userId: actorUserId, role, client: tx });
    const grants = await getArtifactGrants({ artifactId, workspaceId, client: tx });
    assertPermission(evaluateArtifactPermission({
      session: context.session,
      participant: context.participant,
      artifact,
      grants,
      userId: actorUserId,
      role,
      action: "admin",
    }));

    const normalized = normalizePermissionInput(input);
    const { rows } = await tx.query(
      `
      INSERT INTO huddle_artifact_permissions (
        artifact_id,
        workspace_id,
        session_id,
        principal_kind,
        user_id,
        participant_id,
        role_name,
        permission,
        granted_by,
        metadata
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
      RETURNING *
      `,
      [
        artifactId,
        workspaceId,
        artifact.session_id,
        normalized.principalKind,
        normalized.userId,
        normalized.participantId,
        normalized.roleName,
        normalized.permission,
        actorUserId,
        json(normalized.metadata),
      ]
    );
    const permission = rows[0];
    const event = await recordArtifactEvent({
      eventType: HUDDLE_ARTIFACT_EVENTS.PERMISSION_GRANTED,
      artifact,
      actorUserId,
      eventPayload: { permissionId: permission.id, permission: permission.permission },
      client: tx,
    });
    return { permission: serializePermission(permission), event: serializeEvent(event) };
  });
}

export async function listArtifactPermissions({
  workspaceId,
  artifactId,
  actorUserId,
  role = "user",
  client = null,
}) {
  const artifact = await getArtifactRow({ workspaceId, artifactId, client });
  const context = await getSessionAccessContext({ workspaceId, sessionId: artifact.session_id, userId: actorUserId, role, client });
  const grants = await getArtifactGrants({ artifactId, workspaceId, client });
  assertPermission(evaluateArtifactPermission({
    session: context.session,
    participant: context.participant,
    artifact,
    grants,
    userId: actorUserId,
    role,
    action: "admin",
  }));
  return grants.map(serializePermission);
}

export function getHuddleArtifactDiagnostics() {
  const aiGenerationEnabled = ["1", "true", "yes", "on"].includes(
    String(process.env.HUDDLE_INTELLIGENCE_GENERATION_ENABLED || "").trim().toLowerCase()
  );
  return {
    ready: true,
    model: "huddle_artifacts",
    canonicalTypes: CANONICAL_TYPES,
    lifecycleStates: Object.values(HUDDLE_ARTIFACT_STATUSES),
    approvalStates: Object.values(HUDDLE_ARTIFACT_APPROVAL_STATUSES),
    sourceKinds: Object.values(HUDDLE_ARTIFACT_SOURCE_KINDS),
    revisionTable: "huddle_artifact_revisions",
    sourceTable: "huddle_artifact_sources",
    permissionTable: "huddle_artifact_permissions",
    aiGenerationEnabled,
    captionsEnabled: false,
    memoryPromotionEnabled: false,
  };
}

export default {
  HUDDLE_ARTIFACT_TYPES,
  HUDDLE_ARTIFACT_STATUSES,
  HUDDLE_ARTIFACT_APPROVAL_STATUSES,
  HUDDLE_ARTIFACT_VISIBILITIES,
  HUDDLE_ARTIFACT_SOURCE_KINDS,
  createHuddleArtifact,
  updateHuddleArtifact,
  approveHuddleArtifact,
  rejectHuddleArtifact,
  getHuddleArtifact,
  listHuddleArtifacts,
  listArtifactRevisions,
  listArtifactSources,
  addArtifactSources,
  grantArtifactPermission,
  listArtifactPermissions,
  evaluateArtifactPermission,
  getHuddleArtifactDiagnostics,
};
