import pool from "../db.js";
import { normalizeHuddleTranscriptText } from "../utils/huddleTranscriptText.js";
import { createHuddleSessionEvent } from "./huddleEvent.service.js";

export const HUDDLE_INTELLIGENCE_JOB_TYPES = Object.freeze({
  TRANSCRIPT_FINALIZATION: "transcript_finalization",
  CAPTION_GENERATION: "caption_generation",
  SUMMARY_GENERATION: "summary_generation",
  DECISION_EXTRACTION: "decision_extraction",
  ACTION_ITEM_EXTRACTION: "action_item_extraction",
  OWNERSHIP_RESOLUTION: "ownership_resolution",
  TIMELINE_GENERATION: "timeline_generation",
  MEMORY_PROMOTION: "memory_promotion",
  MEETING_DIGEST_GENERATION: "meeting_digest_generation",
});

export const HUDDLE_INTELLIGENCE_JOB_STATUSES = Object.freeze({
  QUEUED: "queued",
  PROCESSING: "processing",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
});

export const HUDDLE_TRANSCRIPT_PROCESSING_STATUSES = Object.freeze({
  IDLE: "idle",
  INGESTING: "ingesting",
  PARTIAL: "partial",
  FINALIZING: "finalizing",
  FINALIZED: "finalized",
  RETRACTED: "retracted",
  FAILED: "failed",
});

export const HUDDLE_INTELLIGENCE_EVENTS = Object.freeze({
  JOB_QUEUED: "huddle.intelligence.job_queued",
  JOB_PROCESSING: "huddle.intelligence.job_processing",
  JOB_COMPLETED: "huddle.intelligence.job_completed",
  JOB_FAILED: "huddle.intelligence.job_failed",
  JOB_RETRY_SCHEDULED: "huddle.intelligence.job_retry_scheduled",
  JOB_RECOVERED: "huddle.intelligence.job_recovered",
  JOB_CANCELLED: "huddle.intelligence.job_cancelled",
  TRANSCRIPT_STATE_UPDATED: "huddle.intelligence.transcript_state_updated",
  SPEAKER_ATTRIBUTION_RECORDED: "huddle.intelligence.speaker_attribution_recorded",
  CAPTION_EMITTED: "huddle.intelligence.caption_emitted",
  TIMELINE_ENTRY_CREATED: "huddle.intelligence.timeline_entry_created",
  OWNERSHIP_RESOLUTION_UPDATED: "huddle.intelligence.ownership_resolution_updated",
  MEMORY_CANDIDATE_UPDATED: "huddle.intelligence.memory_candidate_updated",
  DIGEST_UPDATED: "huddle.intelligence.digest_updated",
  CONSENT_RECORDED: "huddle.intelligence.consent_recorded",
});

const JOB_TYPES = Object.freeze(Object.values(HUDDLE_INTELLIGENCE_JOB_TYPES));
const JOB_STATUSES = Object.freeze(Object.values(HUDDLE_INTELLIGENCE_JOB_STATUSES));

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

function safeTimestamp(value, fallback = null) {
  if (!value) return fallback;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function safeInteger(value, fallback = null) {
  const number = Number(value);
  return Number.isInteger(number) ? number : fallback;
}

function safeConfidence(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.min(Math.max(number, 0), 1);
}

function objectOrEmpty(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function arrayOrEmpty(value) {
  return Array.isArray(value) ? value : [];
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

function normalizeJobType(type) {
  const normalized = safeString(type).toLowerCase();
  if (JOB_TYPES.includes(normalized)) return normalized;
  return HUDDLE_INTELLIGENCE_JOB_TYPES.TRANSCRIPT_FINALIZATION;
}

function normalizeJobStatus(status, fallback = HUDDLE_INTELLIGENCE_JOB_STATUSES.QUEUED) {
  const normalized = safeString(status).toLowerCase();
  if (JOB_STATUSES.includes(normalized)) return normalized;
  return fallback;
}

function normalizeTranscriptProcessingStatus(status, fallback = HUDDLE_TRANSCRIPT_PROCESSING_STATUSES.IDLE) {
  const normalized = safeString(status).toLowerCase();
  if (Object.values(HUDDLE_TRANSCRIPT_PROCESSING_STATUSES).includes(normalized)) return normalized;
  return fallback;
}

function serializeJob(row = {}) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    artifactId: row.artifact_id,
    outputArtifactId: row.output_artifact_id,
    transcriptSegmentId: row.transcript_segment_id,
    jobType: row.job_type,
    status: row.status,
    priority: row.priority,
    version: row.version,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    scheduledAt: row.scheduled_at,
    lockedAt: row.locked_at,
    lockedBy: row.locked_by,
    leaseExpiresAt: row.lease_expires_at,
    heartbeatAt: row.heartbeat_at,
    lastRecoveredAt: row.last_recovered_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    failedAt: row.failed_at,
    cancelledAt: row.cancelled_at,
    cancelledBy: row.cancelled_by,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    idempotencyKey: row.idempotency_key,
    input: row.input_json || {},
    output: row.output_json || {},
    provenance: row.provenance_json || {},
    metadata: row.metadata || {},
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function serializeJobAttempt(row = {}) {
  if (!row) return null;
  return {
    id: row.id,
    jobId: row.job_id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    attemptNumber: row.attempt_number,
    workerId: row.worker_id,
    status: row.status,
    startedAt: row.started_at,
    heartbeatAt: row.heartbeat_at,
    completedAt: row.completed_at,
    failedAt: row.failed_at,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    input: row.input_json || {},
    output: row.output_json || {},
    provenance: row.provenance_json || {},
    metadata: row.metadata || {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function serializeJobDependency(row = {}) {
  if (!row) return null;
  return {
    id: row.id,
    jobId: row.job_id,
    dependsOnJobId: row.depends_on_job_id,
    dependencyType: row.dependency_type,
    dependencyStatus: row.dependency_status || null,
    metadata: row.metadata || {},
    createdAt: row.created_at,
  };
}

function serializeProcessingState(row = {}) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    status: row.status,
    sourceProvider: row.source_provider,
    partialSegmentCount: row.partial_segment_count,
    finalSegmentCount: row.final_segment_count,
    retractedSegmentCount: row.retracted_segment_count,
    revisionCount: row.revision_count,
    lastSegmentId: row.last_segment_id,
    lastPartialAt: row.last_partial_at,
    lastFinalAt: row.last_final_at,
    finalizedAt: row.finalized_at,
    processingVersion: row.processing_version,
    provenance: row.provenance_json || {},
    diagnostics: row.diagnostics || {},
    metadata: row.metadata || {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function serializeAttribution(row = {}) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    transcriptSegmentId: row.transcript_segment_id,
    participantId: row.participant_id,
    participantDeviceId: row.participant_device_id,
    providerIdentityId: row.provider_identity_id,
    speakerKind: row.speaker_kind,
    speakerUserId: row.speaker_user_id,
    speakerGuestId: row.speaker_guest_id,
    speakerLabel: row.speaker_label,
    confidence: row.confidence === null || row.confidence === undefined ? null : Number(row.confidence),
    attributionSource: row.attribution_source,
    providerName: row.provider_name,
    providerSpeakerId: row.provider_speaker_id,
    correctionOfId: row.correction_of_id,
    correctedBy: row.corrected_by,
    correctedAt: row.corrected_at,
    status: row.status,
    provenance: row.provenance_json || {},
    metadata: row.metadata || {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function serializeCaption(row = {}) {
  if (!row) return null;
  const normalizedText = normalizeHuddleTranscriptText(row.caption_text, {
    maxLength: null,
  });
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    transcriptSegmentId: row.transcript_segment_id,
    speakerAttributionId: row.speaker_attribution_id,
    text: normalizedText.text,
    status: row.status,
    sourceProvider: row.source_provider,
    sequenceNumber: row.sequence_number,
    language: row.language,
    confidence: row.confidence === null || row.confidence === undefined ? null : Number(row.confidence),
    replayable: Boolean(row.replayable),
    eventVersion: row.event_version,
    emittedAt: row.emitted_at,
    finalizedAt: row.finalized_at,
    speaker: {
      participantId:
        row.speaker_participant_id ||
        row.attribution_participant_id ||
        row.segment_participant_id ||
        null,
      userId:
        row.speaker_user_id ||
        row.attribution_speaker_user_id ||
        row.segment_speaker_user_id ||
        null,
      guestId:
        row.speaker_guest_id ||
        row.attribution_speaker_guest_id ||
        row.segment_speaker_guest_id ||
        null,
      label:
        row.speaker_display_name ||
        row.attribution_speaker_label ||
        row.segment_speaker_label ||
        null,
    },
    metadata: row.metadata || {},
    createdAt: row.created_at,
  };
}

function serializeTimelineEntry(row = {}) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    artifactId: row.artifact_id,
    transcriptSegmentId: row.transcript_segment_id,
    eventId: row.event_id,
    participantId: row.participant_id,
    entryType: row.entry_type,
    title: row.title,
    description: row.description,
    occurredAt: row.occurred_at,
    rangeStartAt: row.range_start_at,
    rangeEndAt: row.range_end_at,
    sortOrder: row.sort_order,
    confidence: row.confidence === null || row.confidence === undefined ? null : Number(row.confidence),
    provenance: row.provenance_json || {},
    metadata: row.metadata || {},
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function serializeOwnership(row = {}) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    artifactId: row.artifact_id,
    transcriptSegmentId: row.transcript_segment_id,
    suggestedOwnerUserId: row.suggested_owner_user_id,
    suggestedOwnerParticipantId: row.suggested_owner_participant_id,
    resolvedOwnerUserId: row.resolved_owner_user_id,
    confidence: row.confidence === null || row.confidence === undefined ? null : Number(row.confidence),
    approvalRequired: Boolean(row.approval_required),
    status: row.status,
    resolutionNote: row.resolution_note,
    resolvedBy: row.resolved_by,
    resolvedAt: row.resolved_at,
    provenance: row.provenance_json || {},
    metadata: row.metadata || {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function serializeMemoryCandidate(row = {}) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    artifactId: row.artifact_id,
    sourceArtifactId: row.source_artifact_id,
    transcriptSegmentId: row.transcript_segment_id,
    title: row.title,
    candidateText: row.candidate_text,
    memoryVisibility: row.memory_visibility,
    status: row.status,
    confidence: row.confidence === null || row.confidence === undefined ? null : Number(row.confidence),
    approvalRequired: Boolean(row.approval_required),
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    rejectedBy: row.rejected_by,
    rejectedAt: row.rejected_at,
    promotedMemoryId: row.promoted_memory_id,
    promotedAt: row.promoted_at,
    provenance: row.provenance_json || {},
    metadata: row.metadata || {},
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function serializeDigest(row = {}) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    digestType: row.digest_type,
    status: row.status,
    summaryArtifactId: row.summary_artifact_id,
    decisionsArtifactId: row.decisions_artifact_id,
    actionsArtifactId: row.actions_artifact_id,
    timelineArtifactId: row.timeline_artifact_id,
    digest: row.digest_json || {},
    provenance: row.provenance_json || {},
    metadata: row.metadata || {},
    generatedByJobId: row.generated_by_job_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function serializeConsent(row = {}) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    participantId: row.participant_id,
    userId: row.user_id,
    consentType: row.consent_type,
    status: row.status,
    scope: row.scope,
    policyVersion: row.policy_version,
    effectiveAt: row.effective_at,
    revokedAt: row.revoked_at,
    recordedBy: row.recorded_by,
    metadata: row.metadata || {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function serializeRetentionPolicy(row = {}) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    artifactType: row.artifact_type,
    policyName: row.policy_name,
    retentionDays: row.retention_days,
    retentionAction: row.retention_action,
    legalHold: Boolean(row.legal_hold),
    status: row.status,
    metadata: row.metadata || {},
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function serializeEvent(row = {}) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    actorUserId: row.actor_user_id,
    eventType: row.event_type,
    eventPayload: row.event_payload || {},
    createdAt: row.created_at,
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
  if (!row) throw createServiceError("Huddle session not found", 404, "session_not_found");
  const participant = row.access_participant_id
    ? {
        id: row.access_participant_id,
        user_id: row.access_participant_user_id,
        join_state: row.access_participant_join_state,
        left_at: row.access_participant_left_at,
      }
    : null;
  return { session: row, participant, userId, role, workspaceId, sessionId };
}

function assertSessionPermission(context, action = "read") {
  const privileged = isPrivilegedRole(context.role);
  const host = isHuddleHost(context.session, context.userId);
  const participant = isJoinedParticipant(context.participant);
  const workspaceVisible = context.session.visibility === "workspace";
  const allowed = action === "read"
    ? privileged || host || participant || workspaceVisible
    : privileged || host || participant;
  if (!allowed) {
    throw createServiceError("huddle_intelligence_access_denied", 403, "huddle_intelligence_access_denied");
  }
}

async function recordIntelligenceEvent({ eventType, workspaceId, sessionId, actorUserId, payload = {}, client }) {
  return createHuddleSessionEvent({
    workspaceId,
    sessionId,
    actorUserId,
    eventType,
    eventPayload: payload,
    client,
  });
}

export async function enqueueIntelligenceJob({
  workspaceId,
  sessionId,
  actorUserId,
  role = "user",
  jobType,
  artifactId = null,
  outputArtifactId = null,
  transcriptSegmentId = null,
  priority = 100,
  version = 1,
  maxAttempts = 3,
  scheduledAt = null,
  idempotencyKey = null,
  input = {},
  provenance = {},
  metadata = {},
  dependsOnJobIds = [],
  dependencyType = "hard",
  client = null,
}) {
  return withTransaction(client, async (tx) => {
    const context = await getSessionAccessContext({ workspaceId, sessionId, userId: actorUserId, role, client: tx });
    assertSessionPermission(context, "write");

    const normalizedType = normalizeJobType(jobType);
    const values = [
      workspaceId,
      sessionId,
      safeUuid(artifactId),
      safeUuid(outputArtifactId),
      safeUuid(transcriptSegmentId),
      normalizedType,
      Math.min(Math.max(Number(priority) || 100, 0), 1000),
      Math.max(Number(version) || 1, 1),
      Math.min(Math.max(Number(maxAttempts) || 3, 1), 10),
      safeTimestamp(scheduledAt, new Date().toISOString()),
      safeString(idempotencyKey, 240) || null,
      json(input),
      json(provenance),
      json(metadata),
      actorUserId,
    ];

    const { rows } = await tx.query(
      `
      INSERT INTO huddle_intelligence_jobs (
        workspace_id,
        session_id,
        artifact_id,
        output_artifact_id,
        transcript_segment_id,
        job_type,
        priority,
        version,
        max_attempts,
        scheduled_at,
        idempotency_key,
        input_json,
        provenance_json,
        metadata,
        created_by
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14::jsonb,$15)
      ON CONFLICT (workspace_id, session_id, job_type, idempotency_key)
      WHERE idempotency_key IS NOT NULL
      DO UPDATE SET
        input_json = EXCLUDED.input_json,
        provenance_json = huddle_intelligence_jobs.provenance_json || EXCLUDED.provenance_json,
        metadata = huddle_intelligence_jobs.metadata || EXCLUDED.metadata,
        updated_at = now()
      RETURNING *
      `,
      values
    );
    const job = rows[0];
    const dependencyRows = [];
    for (const dependencyJobId of [...new Set(arrayOrEmpty(dependsOnJobIds).map(safeUuid).filter(Boolean))]) {
      if (dependencyJobId === job.id) continue;
      const dependencyResult = await tx.query(
        `
        INSERT INTO huddle_intelligence_job_dependencies (
          job_id,
          depends_on_job_id,
          dependency_type,
          metadata
        )
        SELECT $1, upstream.id, $3, $4::jsonb
        FROM huddle_intelligence_jobs upstream
        WHERE upstream.id = $2
          AND upstream.workspace_id = $5
          AND upstream.session_id = $6
        ON CONFLICT (job_id, depends_on_job_id)
        DO UPDATE SET
          dependency_type = EXCLUDED.dependency_type,
          metadata = huddle_intelligence_job_dependencies.metadata || EXCLUDED.metadata
        RETURNING *
        `,
        [
          job.id,
          dependencyJobId,
          dependencyType === "soft" ? "soft" : "hard",
          json({ source: "enqueue" }),
          workspaceId,
          sessionId,
        ]
      );
      if (dependencyResult.rows[0]) dependencyRows.push(dependencyResult.rows[0]);
    }
    const event = await recordIntelligenceEvent({
      eventType: HUDDLE_INTELLIGENCE_EVENTS.JOB_QUEUED,
      workspaceId,
      sessionId,
      actorUserId,
      payload: { jobId: job.id, jobType: job.job_type, status: job.status },
      client: tx,
    });
    return {
      job: serializeJob(job),
      dependencies: dependencyRows.map(serializeJobDependency),
      event: serializeEvent(event),
    };
  });
}

export async function getIntelligenceJob({ workspaceId, jobId, actorUserId, role = "user", client = null }) {
  const { rows } = await runner(client).query(
    `SELECT * FROM huddle_intelligence_jobs WHERE id = $1 AND workspace_id = $2 LIMIT 1`,
    [jobId, workspaceId]
  );
  const job = rows[0];
  if (!job) throw createServiceError("job_not_found", 404, "job_not_found");
  const context = await getSessionAccessContext({ workspaceId, sessionId: job.session_id, userId: actorUserId, role, client });
  assertSessionPermission(context, "read");
  return serializeJob(job);
}

export async function listIntelligenceJobs({
  workspaceId,
  sessionId,
  actorUserId,
  role = "user",
  jobType = null,
  status = null,
  artifactId = null,
  limit = 100,
  client = null,
}) {
  const context = await getSessionAccessContext({ workspaceId, sessionId, userId: actorUserId, role, client });
  assertSessionPermission(context, "read");
  const params = [workspaceId, sessionId];
  const conditions = ["workspace_id = $1", "session_id = $2"];
  let idx = 3;
  if (jobType) {
    conditions.push(`job_type = $${idx}`);
    params.push(normalizeJobType(jobType));
    idx += 1;
  }
  if (status) {
    conditions.push(`status = $${idx}`);
    params.push(normalizeJobStatus(status));
    idx += 1;
  }
  if (artifactId) {
    conditions.push(`(artifact_id = $${idx} OR output_artifact_id = $${idx})`);
    params.push(artifactId);
    idx += 1;
  }
  params.push(Math.min(Math.max(Number(limit) || 100, 1), 500));
  const { rows } = await runner(client).query(
    `
    SELECT *
    FROM huddle_intelligence_jobs
    WHERE ${conditions.join(" AND ")}
    ORDER BY created_at DESC
    LIMIT $${idx}
    `,
    params
  );
  return rows.map(serializeJob);
}

export async function claimNextIntelligenceJob({
  workerId,
  jobTypes = JOB_TYPES,
  now = new Date(),
  leaseSeconds = 90,
  client = null,
}) {
  if (!safeString(workerId)) throw createServiceError("workerId is required", 400, "worker_required");
  return withTransaction(client, async (tx) => {
    const { rows } = await tx.query(
      `
      WITH next_job AS (
        SELECT j.id
        FROM huddle_intelligence_jobs j
        WHERE j.status = 'queued'
          AND j.attempt_count < j.max_attempts
          AND j.scheduled_at <= $1
          AND j.job_type = ANY($2::text[])
          AND NOT EXISTS (
            SELECT 1
            FROM huddle_intelligence_job_dependencies dependency
            JOIN huddle_intelligence_jobs upstream
              ON upstream.id = dependency.depends_on_job_id
            WHERE dependency.job_id = j.id
              AND dependency.dependency_type = 'hard'
              AND upstream.status <> 'completed'
              AND NOT (
                j.job_type IN ('meeting_digest_generation', 'ownership_resolution')
                AND upstream.status IN ('failed', 'cancelled')
              )
          )
        ORDER BY j.priority ASC, j.scheduled_at ASC, j.created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      UPDATE huddle_intelligence_jobs j
      SET status = 'processing',
          attempt_count = attempt_count + 1,
          locked_at = $1,
          locked_by = $3,
          lease_expires_at = $1::timestamptz + make_interval(secs => $4),
          heartbeat_at = $1,
          started_at = COALESCE(started_at, $1),
          error_code = NULL,
          error_message = NULL,
          updated_at = now()
      FROM next_job
      WHERE j.id = next_job.id
      RETURNING j.*
      `,
      [
        safeTimestamp(now, new Date().toISOString()),
        arrayOrEmpty(jobTypes).map(normalizeJobType),
        safeString(workerId, 120),
        Math.min(Math.max(Number(leaseSeconds) || 90, 30), 900),
      ]
    );
    const job = rows[0] || null;
    if (job) {
      await tx.query(
        `
        INSERT INTO huddle_intelligence_job_attempts (
          job_id,
          workspace_id,
          session_id,
          attempt_number,
          worker_id,
          status,
          started_at,
          heartbeat_at,
          input_json,
          provenance_json,
          metadata
        )
        VALUES ($1,$2,$3,$4,$5,'processing',$6,$6,$7::jsonb,$8::jsonb,$9::jsonb)
        ON CONFLICT (job_id, attempt_number)
        DO UPDATE SET
          worker_id = EXCLUDED.worker_id,
          status = 'processing',
          heartbeat_at = EXCLUDED.heartbeat_at,
          metadata = huddle_intelligence_job_attempts.metadata || EXCLUDED.metadata,
          updated_at = now()
        `,
        [
          job.id,
          job.workspace_id,
          job.session_id,
          job.attempt_count,
          safeString(workerId, 120),
          safeTimestamp(now, new Date().toISOString()),
          json(job.input_json),
          json(job.provenance_json),
          json({ leaseSeconds: Math.min(Math.max(Number(leaseSeconds) || 90, 30), 900) }),
        ]
      );
      await recordIntelligenceEvent({
        eventType: HUDDLE_INTELLIGENCE_EVENTS.JOB_PROCESSING,
        workspaceId: job.workspace_id,
        sessionId: job.session_id,
        actorUserId: job.created_by,
        payload: { jobId: job.id, jobType: job.job_type, workerId },
        client: tx,
      });
    }
    return serializeJob(job);
  });
}

export async function completeIntelligenceJob({
  workspaceId,
  jobId,
  output = {},
  outputArtifactId = null,
  metadata = {},
  client = null,
}) {
  return withTransaction(client, async (tx) => {
    const { rows } = await tx.query(
      `
      UPDATE huddle_intelligence_jobs
      SET status = 'completed',
          output_json = $3::jsonb,
          output_artifact_id = COALESCE($4, output_artifact_id),
          metadata = metadata || $5::jsonb,
          completed_at = now(),
          locked_at = NULL,
          locked_by = NULL,
          lease_expires_at = NULL,
          heartbeat_at = now(),
          updated_at = now()
      WHERE id = $1
        AND workspace_id = $2
      RETURNING *
      `,
      [jobId, workspaceId, json(output), safeUuid(outputArtifactId), json(metadata)]
    );
    const job = rows[0];
    if (!job) throw createServiceError("job_not_found", 404, "job_not_found");
    await tx.query(
      `
      UPDATE huddle_intelligence_job_attempts
      SET status = 'completed',
          output_json = $3::jsonb,
          metadata = metadata || $4::jsonb,
          completed_at = now(),
          heartbeat_at = now()
      WHERE job_id = $1
        AND attempt_number = $2
      `,
      [job.id, job.attempt_count, json(output), json(metadata)]
    );
    const event = await recordIntelligenceEvent({
      eventType: HUDDLE_INTELLIGENCE_EVENTS.JOB_COMPLETED,
      workspaceId,
      sessionId: job.session_id,
      actorUserId: job.created_by,
      payload: { jobId: job.id, jobType: job.job_type },
      client: tx,
    });
    return { job: serializeJob(job), event: serializeEvent(event) };
  });
}

export async function failIntelligenceJob({
  workspaceId,
  jobId,
  errorCode = "intelligence_job_failed",
  errorMessage = null,
  retry = true,
  retryDelaySeconds = null,
  metadata = {},
  client = null,
}) {
  return withTransaction(client, async (tx) => {
    const { rows } = await tx.query(
      `
      UPDATE huddle_intelligence_jobs
      SET status = CASE
            WHEN $5 = TRUE AND attempt_count < max_attempts THEN 'queued'
            ELSE 'failed'
          END,
          error_code = $3,
          error_message = $4,
          failed_at = now(),
          locked_at = NULL,
          locked_by = NULL,
          lease_expires_at = NULL,
          heartbeat_at = now(),
          scheduled_at = CASE
            WHEN $5 = TRUE AND attempt_count < max_attempts
              THEN now() + make_interval(secs => $7)
            ELSE scheduled_at
          END,
          metadata = metadata || $6::jsonb,
          updated_at = now()
      WHERE id = $1
        AND workspace_id = $2
      RETURNING *
      `,
      [
        jobId,
        workspaceId,
        safeString(errorCode, 120),
        safeString(errorMessage, 2000) || null,
        Boolean(retry),
        json(metadata),
        Math.min(
          Math.max(Number(retryDelaySeconds) || 15, 1),
          3600
        ),
      ]
    );
    const job = rows[0];
    if (!job) throw createServiceError("job_not_found", 404, "job_not_found");
    const retryScheduled = job.status === HUDDLE_INTELLIGENCE_JOB_STATUSES.QUEUED;
    await tx.query(
      `
      UPDATE huddle_intelligence_job_attempts
      SET status = $3,
          error_code = $4,
          error_message = $5,
          metadata = metadata || $6::jsonb,
          failed_at = now(),
          heartbeat_at = now()
      WHERE job_id = $1
        AND attempt_number = $2
      `,
      [
        job.id,
        job.attempt_count,
        retryScheduled ? "retry_scheduled" : "failed",
        job.error_code,
        job.error_message,
        json(metadata),
      ]
    );
    const event = await recordIntelligenceEvent({
      eventType: retryScheduled
        ? HUDDLE_INTELLIGENCE_EVENTS.JOB_RETRY_SCHEDULED
        : HUDDLE_INTELLIGENCE_EVENTS.JOB_FAILED,
      workspaceId,
      sessionId: job.session_id,
      actorUserId: job.created_by,
      payload: { jobId: job.id, jobType: job.job_type, status: job.status, errorCode: job.error_code },
      client: tx,
    });
    return { job: serializeJob(job), event: serializeEvent(event) };
  });
}

export async function cancelIntelligenceJob({ workspaceId, jobId, actorUserId, role = "user", reason = null, client = null }) {
  return withTransaction(client, async (tx) => {
    const existing = await getIntelligenceJob({ workspaceId, jobId, actorUserId, role, client: tx });
    const context = await getSessionAccessContext({ workspaceId, sessionId: existing.sessionId, userId: actorUserId, role, client: tx });
    assertSessionPermission(context, "write");
    const { rows } = await tx.query(
      `
      UPDATE huddle_intelligence_jobs
      SET status = 'cancelled',
          cancelled_at = now(),
          cancelled_by = $3,
          locked_at = NULL,
          locked_by = NULL,
          lease_expires_at = NULL,
          heartbeat_at = now(),
          metadata = metadata || $4::jsonb,
          updated_at = now()
      WHERE id = $1
        AND workspace_id = $2
      RETURNING *
      `,
      [jobId, workspaceId, actorUserId, json({ reason: safeString(reason, 500) || null })]
    );
    const job = rows[0];
    await tx.query(
      `
      UPDATE huddle_intelligence_job_attempts
      SET status = 'cancelled',
          metadata = metadata || $3::jsonb,
          failed_at = now(),
          heartbeat_at = now()
      WHERE job_id = $1
        AND attempt_number = $2
        AND status = 'processing'
      `,
      [job.id, job.attempt_count, json({ reason: safeString(reason, 500) || null })]
    );
    const event = await recordIntelligenceEvent({
      eventType: HUDDLE_INTELLIGENCE_EVENTS.JOB_CANCELLED,
      workspaceId,
      sessionId: job.session_id,
      actorUserId,
      payload: { jobId: job.id, jobType: job.job_type, reason },
      client: tx,
    });
    return { job: serializeJob(job), event: serializeEvent(event) };
  });
}

export async function heartbeatIntelligenceJob({
  workspaceId,
  jobId,
  workerId,
  leaseSeconds = 90,
  client = null,
}) {
  const { rows } = await runner(client).query(
    `
    UPDATE huddle_intelligence_jobs
    SET heartbeat_at = now(),
        lease_expires_at = now() + make_interval(secs => $4),
        updated_at = now()
    WHERE id = $1
      AND workspace_id = $2
      AND status = 'processing'
      AND locked_by = $3
    RETURNING *
    `,
    [
      jobId,
      workspaceId,
      safeString(workerId, 120),
      Math.min(Math.max(Number(leaseSeconds) || 90, 30), 900),
    ]
  );
  const job = rows[0];
  if (!job) throw createServiceError("job_lease_not_owned", 409, "job_lease_not_owned");
  await runner(client).query(
    `
    UPDATE huddle_intelligence_job_attempts
    SET heartbeat_at = now()
    WHERE job_id = $1
      AND attempt_number = $2
      AND worker_id = $3
      AND status = 'processing'
    `,
    [job.id, job.attempt_count, safeString(workerId, 120)]
  );
  return serializeJob(job);
}

export async function recoverStaleIntelligenceJobs({
  now = new Date(),
  retryDelaySeconds = 15,
  limit = 100,
  client = null,
} = {}) {
  return withTransaction(client, async (tx) => {
    const { rows } = await tx.query(
      `
      WITH stale AS (
        SELECT id
        FROM huddle_intelligence_jobs
        WHERE status = 'processing'
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at < $1
        ORDER BY lease_expires_at ASC
        LIMIT $2
        FOR UPDATE SKIP LOCKED
      )
      UPDATE huddle_intelligence_jobs job
      SET status = CASE
            WHEN attempt_count < max_attempts THEN 'queued'
            ELSE 'failed'
          END,
          error_code = 'worker_lease_expired',
          error_message = 'The worker lease expired before the job completed.',
          failed_at = now(),
          scheduled_at = CASE
            WHEN attempt_count < max_attempts
              THEN now() + make_interval(secs => $3)
            ELSE scheduled_at
          END,
          locked_at = NULL,
          locked_by = NULL,
          lease_expires_at = NULL,
          heartbeat_at = now(),
          last_recovered_at = now(),
          metadata = metadata || '{"recoveredFromExpiredLease":true}'::jsonb,
          updated_at = now()
      FROM stale
      WHERE job.id = stale.id
      RETURNING job.*
      `,
      [
        safeTimestamp(now, new Date().toISOString()),
        Math.min(Math.max(Number(limit) || 100, 1), 500),
        Math.min(Math.max(Number(retryDelaySeconds) || 15, 1), 3600),
      ]
    );

    for (const job of rows) {
      await tx.query(
        `
        UPDATE huddle_intelligence_job_attempts
        SET status = 'recovered',
            error_code = 'worker_lease_expired',
            error_message = 'The worker lease expired before the job completed.',
            failed_at = now(),
            heartbeat_at = now(),
            metadata = metadata || '{"recoveredFromExpiredLease":true}'::jsonb
        WHERE job_id = $1
          AND attempt_number = $2
        `,
        [job.id, job.attempt_count]
      );
      await recordIntelligenceEvent({
        eventType: HUDDLE_INTELLIGENCE_EVENTS.JOB_RECOVERED,
        workspaceId: job.workspace_id,
        sessionId: job.session_id,
        actorUserId: job.created_by,
        payload: {
          jobId: job.id,
          jobType: job.job_type,
          status: job.status,
          attemptCount: job.attempt_count,
        },
        client: tx,
      });
    }

    return {
      recoveredCount: rows.length,
      jobs: rows.map(serializeJob),
    };
  });
}

export async function listIntelligenceJobAttempts({
  workspaceId,
  sessionId,
  jobId,
  actorUserId,
  role = "user",
  client = null,
}) {
  const job = await getIntelligenceJob({ workspaceId, jobId, actorUserId, role, client });
  if (String(job.sessionId) !== String(sessionId)) {
    throw createServiceError("job_session_mismatch", 409, "job_session_mismatch");
  }
  const { rows } = await runner(client).query(
    `
    SELECT *
    FROM huddle_intelligence_job_attempts
    WHERE workspace_id = $1
      AND session_id = $2
      AND job_id = $3
    ORDER BY attempt_number DESC
    `,
    [workspaceId, sessionId, jobId]
  );
  return rows.map(serializeJobAttempt);
}

export async function listIntelligenceJobDependencies({
  workspaceId,
  sessionId,
  jobId,
  actorUserId,
  role = "user",
  client = null,
}) {
  const job = await getIntelligenceJob({ workspaceId, jobId, actorUserId, role, client });
  if (String(job.sessionId) !== String(sessionId)) {
    throw createServiceError("job_session_mismatch", 409, "job_session_mismatch");
  }
  const { rows } = await runner(client).query(
    `
    SELECT dependency.*, upstream.status AS dependency_status
    FROM huddle_intelligence_job_dependencies dependency
    JOIN huddle_intelligence_jobs upstream
      ON upstream.id = dependency.depends_on_job_id
    WHERE dependency.job_id = $1
      AND upstream.workspace_id = $2
      AND upstream.session_id = $3
    ORDER BY dependency.created_at ASC
    `,
    [jobId, workspaceId, sessionId]
  );
  return rows.map(serializeJobDependency);
}

export async function updateTranscriptProcessingState({
  workspaceId,
  sessionId,
  actorUserId,
  role = "user",
  status = null,
  sourceProvider = "unknown",
  segmentStatus = null,
  lastSegmentId = null,
  provenance = {},
  diagnostics = {},
  metadata = {},
  client = null,
}) {
  return withTransaction(client, async (tx) => {
    const context = await getSessionAccessContext({ workspaceId, sessionId, userId: actorUserId, role, client: tx });
    assertSessionPermission(context, "write");
    const normalizedStatus = normalizeTranscriptProcessingStatus(status || (
      segmentStatus === "final" ? "finalizing" :
      segmentStatus === "partial" ? "partial" :
      segmentStatus === "retracted" ? "retracted" :
      "ingesting"
    ));
    const partialInc = segmentStatus === "partial" ? 1 : 0;
    const finalInc = segmentStatus === "final" ? 1 : 0;
    const retractedInc = segmentStatus === "retracted" ? 1 : 0;
    const now = new Date().toISOString();
    const { rows } = await tx.query(
      `
      INSERT INTO huddle_transcript_processing_state (
        workspace_id,
        session_id,
        status,
        source_provider,
        partial_segment_count,
        final_segment_count,
        retracted_segment_count,
        revision_count,
        last_segment_id,
        last_partial_at,
        last_final_at,
        finalized_at,
        provenance_json,
        diagnostics,
        metadata
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14::jsonb)
      ON CONFLICT (workspace_id, session_id)
      DO UPDATE SET
        status = EXCLUDED.status,
        source_provider = EXCLUDED.source_provider,
        partial_segment_count = huddle_transcript_processing_state.partial_segment_count + $5,
        final_segment_count = huddle_transcript_processing_state.final_segment_count + $6,
        retracted_segment_count = huddle_transcript_processing_state.retracted_segment_count + $7,
        revision_count = huddle_transcript_processing_state.revision_count + 1,
        last_segment_id = COALESCE(EXCLUDED.last_segment_id, huddle_transcript_processing_state.last_segment_id),
        last_partial_at = COALESCE(EXCLUDED.last_partial_at, huddle_transcript_processing_state.last_partial_at),
        last_final_at = COALESCE(EXCLUDED.last_final_at, huddle_transcript_processing_state.last_final_at),
        finalized_at = COALESCE(EXCLUDED.finalized_at, huddle_transcript_processing_state.finalized_at),
        provenance_json = huddle_transcript_processing_state.provenance_json || EXCLUDED.provenance_json,
        diagnostics = huddle_transcript_processing_state.diagnostics || EXCLUDED.diagnostics,
        metadata = huddle_transcript_processing_state.metadata || EXCLUDED.metadata,
        updated_at = now()
      RETURNING *
      `,
      [
        workspaceId,
        sessionId,
        normalizedStatus,
        safeString(sourceProvider, 120) || "unknown",
        partialInc,
        finalInc,
        retractedInc,
        safeUuid(lastSegmentId),
        partialInc ? now : null,
        finalInc ? now : null,
        normalizedStatus === "finalized" ? now : null,
        json(provenance),
        json(diagnostics),
        json(metadata),
      ]
    );
    const state = rows[0];
    const event = await recordIntelligenceEvent({
      eventType: HUDDLE_INTELLIGENCE_EVENTS.TRANSCRIPT_STATE_UPDATED,
      workspaceId,
      sessionId,
      actorUserId,
      payload: { status: state.status, lastSegmentId: state.last_segment_id },
      client: tx,
    });
    return { state: serializeProcessingState(state), event: serializeEvent(event) };
  });
}

export async function getTranscriptProcessingState({ workspaceId, sessionId, actorUserId, role = "user", client = null }) {
  const context = await getSessionAccessContext({ workspaceId, sessionId, userId: actorUserId, role, client });
  assertSessionPermission(context, "read");
  const { rows } = await runner(client).query(
    `SELECT * FROM huddle_transcript_processing_state WHERE workspace_id = $1 AND session_id = $2 LIMIT 1`,
    [workspaceId, sessionId]
  );
  return serializeProcessingState(rows[0]) || {
    workspaceId,
    sessionId,
    status: HUDDLE_TRANSCRIPT_PROCESSING_STATUSES.IDLE,
    partialSegmentCount: 0,
    finalSegmentCount: 0,
    retractedSegmentCount: 0,
    revisionCount: 0,
  };
}

export async function recordSpeakerAttribution({ workspaceId, sessionId, actorUserId, role = "user", input = {}, client = null }) {
  return withTransaction(client, async (tx) => {
    const context = await getSessionAccessContext({ workspaceId, sessionId, userId: actorUserId, role, client: tx });
    assertSessionPermission(context, "write");
    const { rows } = await tx.query(
      `
      INSERT INTO huddle_speaker_attributions (
        workspace_id, session_id, transcript_segment_id, participant_id, participant_device_id,
        provider_identity_id, speaker_kind, speaker_user_id, speaker_guest_id, speaker_label,
        confidence, attribution_source, provider_name, provider_speaker_id, correction_of_id,
        corrected_by, corrected_at, status, provenance_json, metadata
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb,$20::jsonb)
      RETURNING *
      `,
      [
        workspaceId,
        sessionId,
        safeUuid(input.transcriptSegmentId || input.transcript_segment_id),
        safeUuid(input.participantId || input.participant_id),
        safeUuid(input.participantDeviceId || input.participant_device_id),
        safeUuid(input.providerIdentityId || input.provider_identity_id),
        safeString(input.speakerKind || input.speaker_kind, 80) || "unknown",
        safeUuid(input.speakerUserId || input.speaker_user_id),
        safeUuid(input.speakerGuestId || input.speaker_guest_id),
        safeString(input.speakerLabel || input.speaker_label, 160) || null,
        safeConfidence(input.confidence),
        safeString(input.attributionSource || input.attribution_source, 80) || "unknown",
        safeString(input.providerName || input.provider_name, 120) || null,
        safeString(input.providerSpeakerId || input.provider_speaker_id, 200) || null,
        safeUuid(input.correctionOfId || input.correction_of_id),
        input.correctionOfId || input.correction_of_id ? actorUserId : null,
        input.correctionOfId || input.correction_of_id ? new Date().toISOString() : null,
        safeString(input.status, 40) || "active",
        json(input.provenance || input.provenance_json),
        json(input.metadata),
      ]
    );
    const attribution = rows[0];
    const event = await recordIntelligenceEvent({
      eventType: HUDDLE_INTELLIGENCE_EVENTS.SPEAKER_ATTRIBUTION_RECORDED,
      workspaceId,
      sessionId,
      actorUserId,
      payload: { attributionId: attribution.id, transcriptSegmentId: attribution.transcript_segment_id },
      client: tx,
    });
    return { attribution: serializeAttribution(attribution), event: serializeEvent(event) };
  });
}

export async function correctSpeakerAttribution({ workspaceId, sessionId, actorUserId, role = "user", attributionId, correction = {}, client = null }) {
  return withTransaction(client, async (tx) => {
    const context = await getSessionAccessContext({ workspaceId, sessionId, userId: actorUserId, role, client: tx });
    assertSessionPermission(context, "write");
    await tx.query(
      `
      UPDATE huddle_speaker_attributions
      SET status = 'corrected',
          corrected_by = $4,
          corrected_at = now(),
          updated_at = now()
      WHERE id = $1
        AND workspace_id = $2
        AND session_id = $3
      `,
      [attributionId, workspaceId, sessionId, actorUserId]
    );
    return recordSpeakerAttribution({
      workspaceId,
      sessionId,
      actorUserId,
      role,
      input: {
        ...correction,
        correctionOfId: attributionId,
        attributionSource: "correction",
      },
      client: tx,
    });
  });
}

export async function createCaptionEvent({ workspaceId, sessionId, actorUserId, role = "user", input = {}, client = null }) {
  return withTransaction(client, async (tx) => {
    const context = await getSessionAccessContext({ workspaceId, sessionId, userId: actorUserId, role, client: tx });
    assertSessionPermission(context, "write");
    const normalizedText = normalizeHuddleTranscriptText(
      input.text || input.captionText || input.caption_text,
      { maxLength: 4000 }
    );
    const text = normalizedText.text;
    if (!text) throw createServiceError("caption_text_required", 400, "caption_text_required");
    const status = ["partial", "final", "retracted"].includes(safeString(input.status).toLowerCase())
      ? safeString(input.status).toLowerCase()
      : "partial";
    const { rows } = await tx.query(
      `
      INSERT INTO huddle_caption_events (
        workspace_id, session_id, transcript_segment_id, speaker_attribution_id,
        caption_text, status, source_provider, sequence_number, language, confidence,
        replayable, event_version, finalized_at, metadata
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb)
      RETURNING *
      `,
      [
        workspaceId,
        sessionId,
        safeUuid(input.transcriptSegmentId || input.transcript_segment_id),
        safeUuid(input.speakerAttributionId || input.speaker_attribution_id),
        text,
        status,
        safeString(input.sourceProvider || input.source_provider, 120) || "unknown",
        safeInteger(input.sequenceNumber || input.sequence_number),
        safeString(input.language, 32) || null,
        safeConfidence(input.confidence),
        input.replayable === undefined ? true : Boolean(input.replayable),
        Math.max(Number(input.eventVersion || input.event_version) || 1, 1),
        status === "final" ? safeTimestamp(input.finalizedAt || input.finalized_at, new Date().toISOString()) : null,
        json({
          ...objectOrEmpty(input.metadata),
          transcriptNormalization: normalizedText.diagnostics,
        }),
      ]
    );
    const caption = rows[0];
    const event = await recordIntelligenceEvent({
      eventType: HUDDLE_INTELLIGENCE_EVENTS.CAPTION_EMITTED,
      workspaceId,
      sessionId,
      actorUserId,
      payload: { captionEventId: caption.id, status: caption.status, replayable: caption.replayable },
      client: tx,
    });
    return { caption: serializeCaption(caption), event: serializeEvent(event) };
  });
}

export async function listCaptionEvents({ workspaceId, sessionId, actorUserId, role = "user", after = null, replayableOnly = true, limit = 200, client = null }) {
  const context = await getSessionAccessContext({ workspaceId, sessionId, userId: actorUserId, role, client });
  assertSessionPermission(context, "read");
  const params = [workspaceId, sessionId];
  const conditions = ["c.workspace_id = $1", "c.session_id = $2"];
  let idx = 3;
  if (replayableOnly) conditions.push("c.replayable = TRUE");
  const afterTimestamp = safeTimestamp(after);
  if (afterTimestamp) {
    conditions.push(`c.emitted_at > $${idx}`);
    params.push(afterTimestamp);
    idx += 1;
  }
  params.push(Math.min(Math.max(Number(limit) || 200, 1), 5000));
  const direction = afterTimestamp ? "ASC" : "DESC";
  const { rows } = await runner(client).query(
    `
    SELECT
      c.*,
      a.participant_id AS attribution_participant_id,
      a.speaker_user_id AS attribution_speaker_user_id,
      a.speaker_guest_id AS attribution_speaker_guest_id,
      a.speaker_label AS attribution_speaker_label,
      s.participant_id AS segment_participant_id,
      s.speaker_user_id AS segment_speaker_user_id,
      s.speaker_guest_id AS segment_speaker_guest_id,
      s.speaker_label AS segment_speaker_label,
      COALESCE(
        NULLIF(a.speaker_label, ''),
        NULLIF(s.speaker_label, ''),
        NULLIF(u.username, ''),
        NULLIF(g.display_name, '')
      ) AS speaker_display_name
    FROM huddle_caption_events c
    LEFT JOIN huddle_speaker_attributions a
      ON a.id = c.speaker_attribution_id
     AND a.workspace_id = c.workspace_id
     AND a.session_id = c.session_id
    LEFT JOIN huddle_transcript_segments s
      ON s.id = c.transcript_segment_id
     AND s.workspace_id = c.workspace_id
     AND s.session_id = c.session_id
    LEFT JOIN users u
      ON u.id = COALESCE(a.speaker_user_id, s.speaker_user_id)
    LEFT JOIN huddle_guests g
      ON g.id = COALESCE(a.speaker_guest_id, s.speaker_guest_id)
    WHERE ${conditions.join(" AND ")}
    ORDER BY
      c.emitted_at ${direction},
      c.sequence_number ${direction} NULLS LAST,
      c.created_at ${direction}
    LIMIT $${idx}
    `,
    params
  );
  const orderedRows = afterTimestamp ? rows : [...rows].reverse();
  return orderedRows.map(serializeCaption);
}

export async function createTimelineEntry({ workspaceId, sessionId, actorUserId, role = "user", input = {}, client = null }) {
  return withTransaction(client, async (tx) => {
    const context = await getSessionAccessContext({ workspaceId, sessionId, userId: actorUserId, role, client: tx });
    assertSessionPermission(context, "write");
    const { rows } = await tx.query(
      `
      INSERT INTO huddle_timeline_entries (
        workspace_id, session_id, artifact_id, transcript_segment_id, event_id, participant_id,
        entry_type, title, description, occurred_at, range_start_at, range_end_at, sort_order,
        confidence, provenance_json, metadata, created_by
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16::jsonb,$17)
      RETURNING *
      `,
      [
        workspaceId,
        sessionId,
        safeUuid(input.artifactId || input.artifact_id),
        safeUuid(input.transcriptSegmentId || input.transcript_segment_id),
        safeUuid(input.eventId || input.event_id),
        safeUuid(input.participantId || input.participant_id),
        safeString(input.entryType || input.entry_type, 80) || "system",
        safeString(input.title, 300) || null,
        safeString(input.description, 4000) || null,
        safeTimestamp(input.occurredAt || input.occurred_at, new Date().toISOString()),
        safeTimestamp(input.rangeStartAt || input.range_start_at),
        safeTimestamp(input.rangeEndAt || input.range_end_at),
        safeInteger(input.sortOrder || input.sort_order, 0),
        safeConfidence(input.confidence),
        json(input.provenance || input.provenance_json),
        json(input.metadata),
        actorUserId,
      ]
    );
    const timelineEntry = rows[0];
    const event = await recordIntelligenceEvent({
      eventType: HUDDLE_INTELLIGENCE_EVENTS.TIMELINE_ENTRY_CREATED,
      workspaceId,
      sessionId,
      actorUserId,
      payload: { timelineEntryId: timelineEntry.id, entryType: timelineEntry.entry_type },
      client: tx,
    });
    return { timelineEntry: serializeTimelineEntry(timelineEntry), event: serializeEvent(event) };
  });
}

export async function listTimelineEntries({ workspaceId, sessionId, actorUserId, role = "user", entryType = null, limit = 300, client = null }) {
  const context = await getSessionAccessContext({ workspaceId, sessionId, userId: actorUserId, role, client });
  assertSessionPermission(context, "read");
  const params = [workspaceId, sessionId];
  const conditions = ["workspace_id = $1", "session_id = $2"];
  let idx = 3;
  if (entryType) {
    conditions.push(`entry_type = $${idx}`);
    params.push(safeString(entryType, 80));
    idx += 1;
  }
  params.push(Math.min(Math.max(Number(limit) || 300, 1), 1000));
  const { rows } = await runner(client).query(
    `
    SELECT *
    FROM huddle_timeline_entries
    WHERE ${conditions.join(" AND ")}
    ORDER BY occurred_at ASC, sort_order ASC, created_at ASC
    LIMIT $${idx}
    `,
    params
  );
  return rows.map(serializeTimelineEntry);
}

async function insertSimpleStateRecord({ table, workspaceId, sessionId, actorUserId, role, input, serializer, eventType, idName, client }) {
  return withTransaction(client, async (tx) => {
    const context = await getSessionAccessContext({ workspaceId, sessionId, userId: actorUserId, role, client: tx });
    assertSessionPermission(context, "write");
    const normalized = objectOrEmpty(input);
    const columns = {
      ownership: `
        artifact_id, transcript_segment_id, suggested_owner_user_id, suggested_owner_participant_id,
        resolved_owner_user_id, confidence, approval_required, status, resolution_note, resolved_by,
        resolved_at, provenance_json, metadata
      `,
      memory: `
        artifact_id, source_artifact_id, transcript_segment_id, title, candidate_text,
        memory_visibility, status, confidence, approval_required, approved_by, approved_at,
        rejected_by, rejected_at, provenance_json, metadata, created_by
      `,
      digest: `
        digest_type, status, summary_artifact_id, decisions_artifact_id, actions_artifact_id,
        timeline_artifact_id, digest_json, provenance_json, metadata, generated_by_job_id, created_by
      `,
      consent: `
        participant_id, user_id, consent_type, status, scope, policy_version,
        effective_at, revoked_at, recorded_by, metadata
      `,
      retention: `
        artifact_type, policy_name, retention_days, retention_action, legal_hold, status, metadata, created_by
      `,
    }[table];
    const valueBuilders = {
      ownership: [
        safeUuid(normalized.artifactId || normalized.artifact_id),
        safeUuid(normalized.transcriptSegmentId || normalized.transcript_segment_id),
        safeUuid(normalized.suggestedOwnerUserId || normalized.suggested_owner_user_id),
        safeUuid(normalized.suggestedOwnerParticipantId || normalized.suggested_owner_participant_id),
        safeUuid(normalized.resolvedOwnerUserId || normalized.resolved_owner_user_id),
        safeConfidence(normalized.confidence),
        normalized.approvalRequired === undefined ? true : Boolean(normalized.approvalRequired),
        safeString(normalized.status, 80) || "suggested",
        safeString(normalized.resolutionNote || normalized.resolution_note, 1000) || null,
        safeUuid(normalized.resolvedBy || normalized.resolved_by),
        safeTimestamp(normalized.resolvedAt || normalized.resolved_at),
        json(normalized.provenance || normalized.provenance_json),
        json(normalized.metadata),
      ],
      memory: [
        safeUuid(normalized.artifactId || normalized.artifact_id),
        safeUuid(normalized.sourceArtifactId || normalized.source_artifact_id),
        safeUuid(normalized.transcriptSegmentId || normalized.transcript_segment_id),
        safeString(normalized.title, 300) || null,
        safeString(normalized.candidateText || normalized.candidate_text, 200000),
        safeString(normalized.memoryVisibility || normalized.memory_visibility, 40) || "workspace",
        safeString(normalized.status, 80) || "candidate",
        safeConfidence(normalized.confidence),
        normalized.approvalRequired === undefined ? true : Boolean(normalized.approvalRequired),
        safeUuid(normalized.approvedBy || normalized.approved_by),
        safeTimestamp(normalized.approvedAt || normalized.approved_at),
        safeUuid(normalized.rejectedBy || normalized.rejected_by),
        safeTimestamp(normalized.rejectedAt || normalized.rejected_at),
        json(normalized.provenance || normalized.provenance_json),
        json(normalized.metadata),
        actorUserId,
      ],
      digest: [
        safeString(normalized.digestType || normalized.digest_type, 80) || "post_meeting",
        safeString(normalized.status, 80) || "draft",
        safeUuid(normalized.summaryArtifactId || normalized.summary_artifact_id),
        safeUuid(normalized.decisionsArtifactId || normalized.decisions_artifact_id),
        safeUuid(normalized.actionsArtifactId || normalized.actions_artifact_id),
        safeUuid(normalized.timelineArtifactId || normalized.timeline_artifact_id),
        json(normalized.digest || normalized.digestJson || normalized.digest_json),
        json(normalized.provenance || normalized.provenance_json),
        json(normalized.metadata),
        safeUuid(normalized.generatedByJobId || normalized.generated_by_job_id),
        actorUserId,
      ],
      consent: [
        safeUuid(normalized.participantId || normalized.participant_id),
        safeUuid(normalized.userId || normalized.user_id),
        safeString(normalized.consentType || normalized.consent_type, 80) || "ai_processing",
        safeString(normalized.status, 80) || "not_requested",
        safeString(normalized.scope, 80) || "session",
        Math.max(Number(normalized.policyVersion || normalized.policy_version) || 1, 1),
        safeTimestamp(normalized.effectiveAt || normalized.effective_at),
        safeTimestamp(normalized.revokedAt || normalized.revoked_at),
        actorUserId,
        json(normalized.metadata),
      ],
      retention: [
        safeString(normalized.artifactType || normalized.artifact_type, 80) || null,
        safeString(normalized.policyName || normalized.policy_name, 160) || "default",
        safeInteger(normalized.retentionDays || normalized.retention_days),
        safeString(normalized.retentionAction || normalized.retention_action, 80) || "retain",
        Boolean(normalized.legalHold || normalized.legal_hold),
        safeString(normalized.status, 80) || "active",
        json(normalized.metadata),
        actorUserId,
      ],
    }[table];
    const tableName = {
      ownership: "huddle_ownership_resolutions",
      memory: "huddle_memory_candidates",
      digest: "huddle_meeting_digests",
      consent: "huddle_intelligence_consent_records",
      retention: "huddle_intelligence_retention_policies",
    }[table];
    const placeholders = valueBuilders.map((_, i) => `$${i + 3}`).join(",");
    const { rows } = await tx.query(
      `
      INSERT INTO ${tableName} (workspace_id, session_id, ${columns})
      VALUES ($1,$2,${placeholders})
      RETURNING *
      `,
      [workspaceId, sessionId, ...valueBuilders]
    );
    const record = rows[0];
    const event = await recordIntelligenceEvent({
      eventType,
      workspaceId,
      sessionId,
      actorUserId,
      payload: { [idName]: record.id },
      client: tx,
    });
    return { [idName.replace(/Id$/, "")]: serializer(record), event: serializeEvent(event) };
  });
}

export function createOwnershipResolution(args) {
  return insertSimpleStateRecord({
    ...args,
    table: "ownership",
    serializer: serializeOwnership,
    eventType: HUDDLE_INTELLIGENCE_EVENTS.OWNERSHIP_RESOLUTION_UPDATED,
    idName: "ownershipResolutionId",
  });
}

export async function updateOwnershipResolution({ workspaceId, sessionId, ownershipResolutionId, actorUserId, role = "user", patch = {}, client = null }) {
  return withTransaction(client, async (tx) => {
    const context = await getSessionAccessContext({ workspaceId, sessionId, userId: actorUserId, role, client: tx });
    const canReview = isPrivilegedRole(role) || isHuddleHost(context.session, actorUserId);
    if (!canReview) {
      throw createServiceError(
        "Ownership review requires the Huddle host or a workspace reviewer",
        403,
        "ownership_review_forbidden"
      );
    }
    const allowedStatuses = new Set(["approved", "reassigned", "rejected", "cancelled"]);
    const status = safeString(patch.status, 80);
    if (!allowedStatuses.has(status)) {
      throw createServiceError(
        "Invalid ownership review transition",
        400,
        "ownership_status_invalid"
      );
    }
    const existingResult = await tx.query(
      `
      SELECT *
      FROM huddle_ownership_resolutions
      WHERE id = $1
        AND workspace_id = $2
        AND session_id = $3
      LIMIT 1
      FOR UPDATE
      `,
      [ownershipResolutionId, workspaceId, sessionId]
    );
    const existing = existingResult.rows[0];
    if (!existing) {
      throw createServiceError(
        "ownership_resolution_not_found",
        404,
        "ownership_resolution_not_found"
      );
    }
    const requestedOwnerUserId = safeUuid(
      patch.resolvedOwnerUserId || patch.resolved_owner_user_id
    );
    const resolvedOwnerUserId =
      status === "approved"
        ? requestedOwnerUserId || existing.resolved_owner_user_id || existing.suggested_owner_user_id
        : status === "reassigned"
          ? requestedOwnerUserId
          : null;
    if (["approved", "reassigned"].includes(status) && !resolvedOwnerUserId) {
      throw createServiceError(
        "An owner must be selected before approval",
        422,
        "ownership_owner_required"
      );
    }
    if (resolvedOwnerUserId) {
      const target = await tx.query(
        `
        SELECT id
        FROM huddle_session_participants
        WHERE workspace_id = $1
          AND session_id = $2
          AND user_id = $3
        LIMIT 1
        `,
        [workspaceId, sessionId, resolvedOwnerUserId]
      );
      if (!target.rows[0]) {
        throw createServiceError(
          "Selected owner did not participate in this Huddle",
          422,
          "ownership_participant_required"
        );
      }
    }

    if (
      existing.status === status &&
      String(existing.resolved_owner_user_id || "") === String(resolvedOwnerUserId || "")
    ) {
      return {
        ownershipResolution: serializeOwnership(existing),
        event: null,
        idempotent: true,
      };
    }
    const expectedStatus = safeString(patch.expectedStatus || patch.expected_status, 80);
    if (expectedStatus && expectedStatus !== existing.status) {
      throw createServiceError(
        "Ownership suggestion changed before the review was saved",
        409,
        "ownership_revision_conflict"
      );
    }
    const { rows } = await tx.query(
      `
      UPDATE huddle_ownership_resolutions
      SET status = $4,
          resolved_owner_user_id = $5,
          resolution_note = COALESCE($6, resolution_note),
          resolved_by = $7,
          resolved_at = now(),
          metadata = metadata || $8::jsonb,
          updated_at = now()
      WHERE id = $1
        AND workspace_id = $2
        AND session_id = $3
      RETURNING *
      `,
      [
        ownershipResolutionId,
        workspaceId,
        sessionId,
        status,
        resolvedOwnerUserId,
        safeString(patch.resolutionNote || patch.resolution_note, 1000) || null,
        actorUserId,
        json({
          ...objectOrEmpty(patch.metadata),
          previousStatus: existing.status,
          reviewedAt: new Date().toISOString(),
        }),
      ]
    );
    const ownership = rows[0];
    const event = await recordIntelligenceEvent({
      eventType: HUDDLE_INTELLIGENCE_EVENTS.OWNERSHIP_RESOLUTION_UPDATED,
      workspaceId,
      sessionId,
      actorUserId,
      payload: {
        ownershipResolutionId: ownership.id,
        previousStatus: existing.status,
        status: ownership.status,
        previousOwnerUserId: existing.resolved_owner_user_id,
        resolvedOwnerUserId: ownership.resolved_owner_user_id,
        resolutionNote: ownership.resolution_note,
      },
      client: tx,
    });
    return { ownershipResolution: serializeOwnership(ownership), event: serializeEvent(event) };
  });
}

export function createMemoryCandidate(args) {
  return insertSimpleStateRecord({
    ...args,
    table: "memory",
    serializer: serializeMemoryCandidate,
    eventType: HUDDLE_INTELLIGENCE_EVENTS.MEMORY_CANDIDATE_UPDATED,
    idName: "memoryCandidateId",
  });
}

export async function updateMemoryCandidate({ workspaceId, sessionId, memoryCandidateId, actorUserId, role = "user", patch = {}, client = null }) {
  return withTransaction(client, async (tx) => {
    const context = await getSessionAccessContext({ workspaceId, sessionId, userId: actorUserId, role, client: tx });
    const canReview = isPrivilegedRole(role) || isHuddleHost(context.session, actorUserId);
    if (!canReview) {
      throw createServiceError(
        "Memory review requires the Huddle host or a workspace reviewer",
        403,
        "memory_review_forbidden"
      );
    }
    const status = safeString(patch.status, 80) || "pending_approval";
    if (!["candidate", "pending_approval", "approved", "rejected", "cancelled"].includes(status)) {
      throw createServiceError(
        "Memory promotion uses the dedicated promotion endpoint",
        400,
        "memory_status_invalid"
      );
    }
    const approved = status === "approved";
    const rejected = status === "rejected";
    const existingResult = await tx.query(
      `
      SELECT *
      FROM huddle_memory_candidates
      WHERE id = $1
        AND workspace_id = $2
        AND session_id = $3
      LIMIT 1
      FOR UPDATE
      `,
      [memoryCandidateId, workspaceId, sessionId]
    );
    const existing = existingResult.rows[0];
    if (!existing) {
      throw createServiceError(
        "memory_candidate_not_found",
        404,
        "memory_candidate_not_found"
      );
    }
    const nextTitle = safeString(patch.title, 300) || existing.title;
    const nextText =
      safeString(patch.candidateText || patch.candidate_text, 200000) ||
      existing.candidate_text;
    const contentChanged =
      nextTitle !== existing.title || nextText !== existing.candidate_text;
    if (existing.status === status && !contentChanged) {
      return {
        memoryCandidate: serializeMemoryCandidate(existing),
        event: null,
        idempotent: true,
      };
    }
    const expectedStatus = safeString(patch.expectedStatus || patch.expected_status, 80);
    if (expectedStatus && expectedStatus !== existing.status) {
      throw createServiceError(
        "Memory candidate changed before the review was saved",
        409,
        "memory_revision_conflict"
      );
    }
    const revisionResult = await tx.query(
      `
      SELECT COALESCE(MAX(revision_number), 0) + 1 AS next_revision
      FROM huddle_memory_candidate_revisions
      WHERE memory_candidate_id = $1
      `,
      [memoryCandidateId]
    );
    const revisionNumber = Number(revisionResult.rows[0]?.next_revision || 1);
    await tx.query(
      `
      INSERT INTO huddle_memory_candidate_revisions (
        workspace_id,
        session_id,
        memory_candidate_id,
        revision_number,
        status,
        title,
        candidate_text,
        changed_by,
        change_reason,
        metadata
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
      `,
      [
        workspaceId,
        sessionId,
        memoryCandidateId,
        revisionNumber,
        existing.status,
        existing.title,
        existing.candidate_text,
        actorUserId,
        contentChanged ? "content_edited" : "status_changed",
        json({ nextStatus: status }),
      ]
    );
    const { rows } = await tx.query(
      `
      UPDATE huddle_memory_candidates
      SET status = $4,
          title = COALESCE($5, title),
          candidate_text = COALESCE($6, candidate_text),
          approved_by = CASE WHEN $7 = TRUE THEN $9::uuid ELSE NULL END,
          approved_at = CASE WHEN $7 = TRUE THEN now() ELSE NULL END,
          rejected_by = CASE WHEN $8 = TRUE THEN $9::uuid ELSE NULL END,
          rejected_at = CASE WHEN $8 = TRUE THEN now() ELSE NULL END,
          promoted_memory_id = promoted_memory_id,
          promoted_at = promoted_at,
          metadata = metadata || $10::jsonb,
          updated_at = now()
      WHERE id = $1
        AND workspace_id = $2
        AND session_id = $3
      RETURNING *
      `,
      [
        memoryCandidateId,
        workspaceId,
        sessionId,
        status,
        nextTitle,
        nextText,
        approved,
        rejected,
        actorUserId,
        json({
          ...objectOrEmpty(patch.metadata),
          previousStatus: existing.status,
          reviewedAt: new Date().toISOString(),
        }),
      ]
    );
    const memoryCandidate = rows[0];
    if (!memoryCandidate) throw createServiceError("memory_candidate_not_found", 404, "memory_candidate_not_found");
    const event = await recordIntelligenceEvent({
      eventType: HUDDLE_INTELLIGENCE_EVENTS.MEMORY_CANDIDATE_UPDATED,
      workspaceId,
      sessionId,
      actorUserId,
      payload: {
        memoryCandidateId: memoryCandidate.id,
        previousStatus: existing.status,
        status: memoryCandidate.status,
        revisionNumber,
        contentChanged,
      },
      client: tx,
    });
    return { memoryCandidate: serializeMemoryCandidate(memoryCandidate), event: serializeEvent(event) };
  });
}

export function createMeetingDigest(args) {
  return insertSimpleStateRecord({
    ...args,
    table: "digest",
    serializer: serializeDigest,
    eventType: HUDDLE_INTELLIGENCE_EVENTS.DIGEST_UPDATED,
    idName: "meetingDigestId",
  });
}

export async function upsertMeetingDigest({
  workspaceId,
  sessionId,
  actorUserId,
  role = "user",
  input,
  client = null,
}) {
  return withTransaction(client, async (tx) => {
    const context = await getSessionAccessContext({
      workspaceId,
      sessionId,
      userId: actorUserId,
      role,
      client: tx,
    });
    assertSessionPermission(context, "write");
    const normalized = objectOrEmpty(input);
    const digestType = safeString(normalized.digestType || normalized.digest_type, 80) || "post_meeting";
    const { rows } = await tx.query(
      `
      INSERT INTO huddle_meeting_digests (
        workspace_id, session_id, digest_type, status, summary_artifact_id,
        decisions_artifact_id, actions_artifact_id, timeline_artifact_id,
        digest_json, provenance_json, metadata, generated_by_job_id, created_by
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12,$13)
      ON CONFLICT (workspace_id, session_id, digest_type)
      DO UPDATE SET
        status = EXCLUDED.status,
        summary_artifact_id = EXCLUDED.summary_artifact_id,
        decisions_artifact_id = EXCLUDED.decisions_artifact_id,
        actions_artifact_id = EXCLUDED.actions_artifact_id,
        timeline_artifact_id = EXCLUDED.timeline_artifact_id,
        digest_json = EXCLUDED.digest_json,
        provenance_json = EXCLUDED.provenance_json,
        metadata = huddle_meeting_digests.metadata || EXCLUDED.metadata,
        generated_by_job_id = COALESCE(EXCLUDED.generated_by_job_id, huddle_meeting_digests.generated_by_job_id),
        updated_at = now()
      RETURNING *
      `,
      [
        workspaceId,
        sessionId,
        digestType,
        safeString(normalized.status, 80) || "ready",
        safeUuid(normalized.summaryArtifactId || normalized.summary_artifact_id),
        safeUuid(normalized.decisionsArtifactId || normalized.decisions_artifact_id),
        safeUuid(normalized.actionsArtifactId || normalized.actions_artifact_id),
        safeUuid(normalized.timelineArtifactId || normalized.timeline_artifact_id),
        json(normalized.digest || normalized.digestJson || normalized.digest_json),
        json(normalized.provenance || normalized.provenance_json),
        json(normalized.metadata),
        safeUuid(normalized.generatedByJobId || normalized.generated_by_job_id),
        actorUserId,
      ]
    );
    const record = rows[0];
    const event = await recordIntelligenceEvent({
      eventType: HUDDLE_INTELLIGENCE_EVENTS.DIGEST_UPDATED,
      workspaceId,
      sessionId,
      actorUserId,
      payload: { meetingDigestId: record.id, upserted: true },
      client: tx,
    });
    return { meetingDigest: serializeDigest(record), event: serializeEvent(event) };
  });
}

export function recordIntelligenceConsent(args) {
  return insertSimpleStateRecord({
    ...args,
    table: "consent",
    serializer: serializeConsent,
    eventType: HUDDLE_INTELLIGENCE_EVENTS.CONSENT_RECORDED,
    idName: "consentRecordId",
  });
}

export function createRetentionPolicy(args) {
  return insertSimpleStateRecord({
    ...args,
    table: "retention",
    serializer: serializeRetentionPolicy,
    eventType: HUDDLE_INTELLIGENCE_EVENTS.CONSENT_RECORDED,
    idName: "retentionPolicyId",
  });
}

async function listBySession({ tableName, serializer, workspaceId, sessionId, actorUserId, role = "user", limit = 100, client = null }) {
  const context = await getSessionAccessContext({ workspaceId, sessionId, userId: actorUserId, role, client });
  assertSessionPermission(context, "read");
  const { rows } = await runner(client).query(
    `
    SELECT *
    FROM ${tableName}
    WHERE workspace_id = $1
      AND session_id = $2
    ORDER BY created_at DESC
    LIMIT $3
    `,
    [workspaceId, sessionId, Math.min(Math.max(Number(limit) || 100, 1), 500)]
  );
  return rows.map(serializer);
}

export const listOwnershipResolutions = (args) =>
  listBySession({ ...args, tableName: "huddle_ownership_resolutions", serializer: serializeOwnership });

export const listMemoryCandidates = (args) =>
  listBySession({ ...args, tableName: "huddle_memory_candidates", serializer: serializeMemoryCandidate });

export const listMeetingDigests = (args) =>
  listBySession({ ...args, tableName: "huddle_meeting_digests", serializer: serializeDigest });

export const listConsentRecords = (args) =>
  listBySession({ ...args, tableName: "huddle_intelligence_consent_records", serializer: serializeConsent });

export const listRetentionPolicies = (args) =>
  listBySession({ ...args, tableName: "huddle_intelligence_retention_policies", serializer: serializeRetentionPolicy });

export async function getArtifactProcessingState({ workspaceId, sessionId, artifactId, actorUserId, role = "user", client = null }) {
  const jobs = await listIntelligenceJobs({
    workspaceId,
    sessionId,
    actorUserId,
    role,
    artifactId,
    limit: 100,
    client,
  });
  return {
    workspaceId,
    sessionId,
    artifactId,
    queued: jobs.filter((job) => job.status === "queued").length,
    processing: jobs.filter((job) => job.status === "processing").length,
    completed: jobs.filter((job) => job.status === "completed").length,
    failed: jobs.filter((job) => job.status === "failed").length,
    cancelled: jobs.filter((job) => job.status === "cancelled").length,
    jobs,
  };
}

export function getHuddleIntelligenceDiagnostics() {
  const generationEnabled = ["1", "true", "yes", "on"].includes(
    String(process.env.HUDDLE_INTELLIGENCE_GENERATION_ENABLED || "").trim().toLowerCase()
  );
  return {
    ready: true,
    domain: "huddle_intelligence",
    separatedFromMedia: true,
    generationEnabled,
    sttProviderEnabled: true,
    captionsUiEnabled: true,
    memoryPromotionEnabled: false,
    taskCreationEnabled: false,
    jobTypes: JOB_TYPES,
    jobStatuses: JOB_STATUSES,
    transcriptProcessingStatuses: Object.values(HUDDLE_TRANSCRIPT_PROCESSING_STATUSES),
    tables: {
      jobs: "huddle_intelligence_jobs",
      jobAttempts: "huddle_intelligence_job_attempts",
      jobDependencies: "huddle_intelligence_job_dependencies",
      transcriptProcessing: "huddle_transcript_processing_state",
      speakerAttribution: "huddle_speaker_attributions",
      captions: "huddle_caption_events",
      timeline: "huddle_timeline_entries",
      ownership: "huddle_ownership_resolutions",
      memoryCandidates: "huddle_memory_candidates",
      meetingDigests: "huddle_meeting_digests",
      consent: "huddle_intelligence_consent_records",
      retention: "huddle_intelligence_retention_policies",
    },
  };
}

export default {
  HUDDLE_INTELLIGENCE_JOB_TYPES,
  HUDDLE_INTELLIGENCE_JOB_STATUSES,
  HUDDLE_TRANSCRIPT_PROCESSING_STATUSES,
  enqueueIntelligenceJob,
  getIntelligenceJob,
  listIntelligenceJobs,
  claimNextIntelligenceJob,
  completeIntelligenceJob,
  failIntelligenceJob,
  cancelIntelligenceJob,
  heartbeatIntelligenceJob,
  recoverStaleIntelligenceJobs,
  listIntelligenceJobAttempts,
  listIntelligenceJobDependencies,
  updateTranscriptProcessingState,
  getTranscriptProcessingState,
  recordSpeakerAttribution,
  correctSpeakerAttribution,
  createCaptionEvent,
  listCaptionEvents,
  createTimelineEntry,
  listTimelineEntries,
  createOwnershipResolution,
  updateOwnershipResolution,
  createMemoryCandidate,
  updateMemoryCandidate,
  createMeetingDigest,
  upsertMeetingDigest,
  recordIntelligenceConsent,
  createRetentionPolicy,
  listOwnershipResolutions,
  listMemoryCandidates,
  listMeetingDigests,
  listConsentRecords,
  listRetentionPolicies,
  getArtifactProcessingState,
  getHuddleIntelligenceDiagnostics,
};
