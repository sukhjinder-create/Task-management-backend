import pool from "../db.js";
import { createHuddleSessionEvent } from "./huddleEvent.service.js";

export const HUDDLE_TRANSCRIPT_SEGMENT_STATUSES = Object.freeze({
  PARTIAL: "partial",
  FINAL: "final",
  RETRACTED: "retracted",
});

export const HUDDLE_TRANSCRIPT_SPEAKER_KINDS = Object.freeze({
  WORKSPACE_USER: "workspace_user",
  GUEST: "guest",
  AI_AGENT: "ai_agent",
  SYSTEM: "system",
  UNKNOWN: "unknown",
});

export const HUDDLE_TRANSCRIPT_EVENTS = Object.freeze({
  SEGMENT_CREATED: "huddle.transcript.segment_created",
  SEGMENT_UPDATED: "huddle.transcript.segment_updated",
  SEGMENT_FINALIZED: "huddle.transcript.segment_finalized",
  SEGMENT_RETRACTED: "huddle.transcript.segment_retracted",
});

export const HUDDLE_TRANSCRIPT_PERMISSION_REASONS = Object.freeze({
  ALLOWED: "allowed",
  SESSION_NOT_FOUND: "session_not_found",
  WORKSPACE_MISMATCH: "workspace_mismatch",
  PARTICIPATION_REQUIRED: "huddle_participation_required",
  WRITE_PARTICIPATION_REQUIRED: "huddle_transcript_write_participation_required",
  ATTRIBUTION_FORBIDDEN: "huddle_transcript_attribution_forbidden",
});

const TRANSCRIPT_EVENT_TYPES = Object.freeze(Object.values(HUDDLE_TRANSCRIPT_EVENTS));

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

function safeConfidence(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.min(Math.max(number, 0), 1);
}

function safeInteger(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (!Number.isInteger(number)) return null;
  return number;
}

function objectOrEmpty(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
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

function normalizeStatus(status, fallback = HUDDLE_TRANSCRIPT_SEGMENT_STATUSES.PARTIAL) {
  const normalized = safeString(status).toLowerCase();
  if (Object.values(HUDDLE_TRANSCRIPT_SEGMENT_STATUSES).includes(normalized)) {
    return normalized;
  }
  return fallback;
}

function normalizeSpeakerKind(kind, { speakerUserId = null, speakerGuestId = null } = {}) {
  const normalized = safeString(kind).toLowerCase();
  if (Object.values(HUDDLE_TRANSCRIPT_SPEAKER_KINDS).includes(normalized)) {
    return normalized;
  }
  if (speakerUserId) return HUDDLE_TRANSCRIPT_SPEAKER_KINDS.WORKSPACE_USER;
  if (speakerGuestId) return HUDDLE_TRANSCRIPT_SPEAKER_KINDS.GUEST;
  return HUDDLE_TRANSCRIPT_SPEAKER_KINDS.UNKNOWN;
}

function serializeTranscriptSegment(row = {}) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    participantId: row.participant_id,
    participantDeviceId: row.participant_device_id,
    speaker: {
      kind: row.speaker_kind,
      userId: row.speaker_user_id,
      guestId: row.speaker_guest_id,
      label: row.resolved_speaker_label || row.speaker_label,
    },
    sourceProvider: row.source_provider,
    sourceSegmentId: row.source_segment_id,
    sourceEventId: row.source_event_id,
    language: row.language,
    text: row.transcript_text,
    status: row.status,
    confidence: row.confidence === null || row.confidence === undefined
      ? null
      : Number(row.confidence),
    startedAt: row.started_at,
    endedAt: row.ended_at,
    finalizedAt: row.finalized_at,
    sequenceNumber: row.sequence_number,
    revision: row.revision,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    metadata: row.metadata || {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function serializeTranscriptEvent(row = {}) {
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

export function evaluateTranscriptPermission({
  session = null,
  participant = null,
  userId = null,
  role = "user",
  action = "read",
  targetSpeakerUserId = null,
  targetParticipantId = null,
} = {}) {
  if (!session) {
    return {
      allowed: false,
      reason: HUDDLE_TRANSCRIPT_PERMISSION_REASONS.SESSION_NOT_FOUND,
    };
  }

  const privileged = isPrivilegedRole(role);
  const host = isHuddleHost(session, userId);
  const participantJoined = isJoinedParticipant(participant);
  const workspaceVisible = session.visibility === "workspace";

  if (action === "read") {
    const allowed = privileged || host || participantJoined || workspaceVisible;
    return {
      allowed,
      reason: allowed
        ? HUDDLE_TRANSCRIPT_PERMISSION_REASONS.ALLOWED
        : HUDDLE_TRANSCRIPT_PERMISSION_REASONS.PARTICIPATION_REQUIRED,
      privileged,
      host,
      participant: participantJoined,
      workspaceVisible,
    };
  }

  const canWrite = privileged || host || participantJoined;
  if (!canWrite) {
    return {
      allowed: false,
      reason: HUDDLE_TRANSCRIPT_PERMISSION_REASONS.WRITE_PARTICIPATION_REQUIRED,
      privileged,
      host,
      participant: participantJoined,
      workspaceVisible,
    };
  }

  if (!privileged) {
    const userMismatch =
      targetSpeakerUserId && String(targetSpeakerUserId) !== String(userId || "");
    const participantMismatch =
      targetParticipantId &&
      participant?.id &&
      String(targetParticipantId) !== String(participant.id);
    if (userMismatch || participantMismatch) {
      return {
        allowed: false,
        reason: HUDDLE_TRANSCRIPT_PERMISSION_REASONS.ATTRIBUTION_FORBIDDEN,
        privileged,
        host,
        participant: participantJoined,
        workspaceVisible,
      };
    }
  }

  return {
    allowed: true,
    reason: HUDDLE_TRANSCRIPT_PERMISSION_REASONS.ALLOWED,
    privileged,
    host,
    participant: participantJoined,
    workspaceVisible,
  };
}

async function getSessionAccessContext({
  workspaceId,
  sessionId,
  userId,
  role = "user",
  client = null,
}) {
  if (!workspaceId) {
    throw createServiceError("workspaceId is required", 400, "workspace_required");
  }
  if (!sessionId) {
    throw createServiceError("sessionId is required", 400, "session_required");
  }
  if (!userId) {
    throw createServiceError("userId is required", 401, "user_required");
  }

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
      HUDDLE_TRANSCRIPT_PERMISSION_REASONS.SESSION_NOT_FOUND
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

  return {
    workspaceId,
    sessionId,
    userId,
    role,
    session: row,
    participant,
  };
}

function assertPermission(permission) {
  if (permission.allowed) return;
  const statusCode = permission.reason === HUDDLE_TRANSCRIPT_PERMISSION_REASONS.SESSION_NOT_FOUND
    ? 404
    : 403;
  throw createServiceError(permission.reason, statusCode, permission.reason);
}

async function validateParticipantTarget({
  workspaceId,
  sessionId,
  participantId = null,
  userId = null,
  client,
}) {
  if (!participantId) return null;
  const { rows } = await runner(client).query(
    `
    SELECT *
    FROM huddle_session_participants
    WHERE id = $1
      AND session_id = $2
      AND workspace_id = $3
    LIMIT 1
    `,
    [participantId, sessionId, workspaceId]
  );
  const participant = rows[0] || null;
  if (!participant) {
    throw createServiceError("Participant not found", 400, "participant_not_found");
  }
  if (userId && participant.user_id && String(participant.user_id) !== String(userId)) {
    throw createServiceError(
      "Participant does not match speaker user",
      400,
      "participant_speaker_mismatch"
    );
  }
  return participant;
}

async function recordTranscriptEvent({
  eventType,
  segment,
  actorUserId,
  actorGuestId = null,
  client,
}) {
  return createHuddleSessionEvent({
    workspaceId: segment.workspace_id,
    sessionId: segment.session_id,
    actorUserId,
    actorGuestId,
    eventType,
    eventPayload: {
      segment: serializeTranscriptSegment(segment),
      transcript: {
        segmentId: segment.id,
        status: segment.status,
        sourceProvider: segment.source_provider,
        sourceSegmentId: segment.source_segment_id,
        revision: segment.revision,
      },
    },
    client,
  });
}

async function findExistingSourceSegment({
  workspaceId,
  sessionId,
  sourceProvider,
  sourceSegmentId,
  client,
}) {
  if (!sourceSegmentId) return null;
  const { rows } = await runner(client).query(
    `
    SELECT *
    FROM huddle_transcript_segments
    WHERE workspace_id = $1
      AND session_id = $2
      AND source_provider = $3
      AND source_segment_id = $4
      AND deleted_at IS NULL
    LIMIT 1
    `,
    [workspaceId, sessionId, sourceProvider, sourceSegmentId]
  );
  return rows[0] || null;
}

function normalizeSegmentInput(input = {}, context = {}, options = {}) {
  const speakerGuestId = safeUuid(input.speakerGuestId || input.speaker_guest_id);
  const requestedSpeakerKind = safeString(input.speakerKind || input.speaker_kind).toLowerCase();
  const nonHumanSpeakerKind = [
    HUDDLE_TRANSCRIPT_SPEAKER_KINDS.AI_AGENT,
    HUDDLE_TRANSCRIPT_SPEAKER_KINDS.SYSTEM,
    HUDDLE_TRANSCRIPT_SPEAKER_KINDS.UNKNOWN,
  ].includes(requestedSpeakerKind);
  const defaultSpeakerUser =
    options.defaultSpeakerUser !== false && !speakerGuestId && !nonHumanSpeakerKind;
  const speakerUserId =
    safeUuid(input.speakerUserId || input.speaker_user_id) ||
    (defaultSpeakerUser ? safeUuid(context.userId) : null);
  const participantId =
    safeUuid(input.participantId || input.participant_id) ||
    safeUuid(context.participant?.id);
  const status = normalizeStatus(input.status);
  const endedAt = safeTimestamp(input.endedAt || input.ended_at);
  const finalizedAt =
    status === HUDDLE_TRANSCRIPT_SEGMENT_STATUSES.FINAL
      ? safeTimestamp(input.finalizedAt || input.finalized_at, new Date().toISOString())
      : null;

  return {
    participantId,
    participantDeviceId: safeUuid(input.participantDeviceId || input.participant_device_id),
    speakerKind: normalizeSpeakerKind(input.speakerKind || input.speaker_kind, {
      speakerUserId,
      speakerGuestId,
    }),
    speakerUserId,
    speakerGuestId,
    speakerLabel: safeString(input.speakerLabel || input.speaker_label, 160) || null,
    sourceProvider: safeString(input.sourceProvider || input.source_provider, 80) || "unknown",
    sourceSegmentId: safeString(input.sourceSegmentId || input.source_segment_id, 160) || null,
    sourceEventId: safeUuid(input.sourceEventId || input.source_event_id),
    language: safeString(input.language, 32) || null,
    transcriptText: safeString(input.text || input.transcriptText || input.transcript_text),
    status,
    confidence: safeConfidence(input.confidence),
    startedAt: safeTimestamp(input.startedAt || input.started_at, new Date().toISOString()),
    endedAt,
    finalizedAt,
    sequenceNumber: safeInteger(input.sequenceNumber || input.sequence_number),
    metadata: objectOrEmpty(input.metadata),
  };
}

export async function createTranscriptSegment({
  workspaceId,
  sessionId,
  actorUserId,
  role = "user",
  input = {},
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
    const normalized = normalizeSegmentInput(input, context);
    if (!normalized.transcriptText) {
      throw createServiceError("Transcript text is required", 400, "transcript_text_required");
    }

    const permission = evaluateTranscriptPermission({
      session: context.session,
      participant: context.participant,
      userId: actorUserId,
      role,
      action: "write",
      targetSpeakerUserId: normalized.speakerUserId,
      targetParticipantId: normalized.participantId,
    });
    assertPermission(permission);

    await validateParticipantTarget({
      workspaceId,
      sessionId,
      participantId: normalized.participantId,
      userId: normalized.speakerUserId,
      client: tx,
    });

    const existing = await findExistingSourceSegment({
      workspaceId,
      sessionId,
      sourceProvider: normalized.sourceProvider,
      sourceSegmentId: normalized.sourceSegmentId,
      client: tx,
    });

    if (existing) {
      const updated = await updateTranscriptSegment({
        workspaceId,
        segmentId: existing.id,
        actorUserId,
        role,
        patch: {
          ...input,
          status: normalized.status,
          text: normalized.transcriptText,
        },
        client: tx,
      });
      return { ...updated, idempotentUpdate: true };
    }

    const { rows } = await tx.query(
      `
      INSERT INTO huddle_transcript_segments (
        workspace_id,
        session_id,
        participant_id,
        participant_device_id,
        speaker_kind,
        speaker_user_id,
        speaker_guest_id,
        speaker_label,
        source_provider,
        source_segment_id,
        source_event_id,
        language,
        transcript_text,
        status,
        confidence,
        started_at,
        ended_at,
        finalized_at,
        sequence_number,
        created_by,
        updated_by,
        metadata
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8,
        $9, $10, $11, $12, $13, $14, $15,
        $16, $17, $18, $19, $20, $21, $22::jsonb
      )
      ON CONFLICT (workspace_id, session_id, source_provider, source_segment_id)
        WHERE source_segment_id IS NOT NULL AND deleted_at IS NULL
      DO UPDATE SET
        participant_id = COALESCE(EXCLUDED.participant_id, huddle_transcript_segments.participant_id),
        participant_device_id = COALESCE(EXCLUDED.participant_device_id, huddle_transcript_segments.participant_device_id),
        speaker_kind = COALESCE(EXCLUDED.speaker_kind, huddle_transcript_segments.speaker_kind),
        speaker_user_id = COALESCE(EXCLUDED.speaker_user_id, huddle_transcript_segments.speaker_user_id),
        speaker_guest_id = COALESCE(EXCLUDED.speaker_guest_id, huddle_transcript_segments.speaker_guest_id),
        speaker_label = COALESCE(EXCLUDED.speaker_label, huddle_transcript_segments.speaker_label),
        source_event_id = COALESCE(EXCLUDED.source_event_id, huddle_transcript_segments.source_event_id),
        language = COALESCE(EXCLUDED.language, huddle_transcript_segments.language),
        transcript_text = EXCLUDED.transcript_text,
        status = EXCLUDED.status,
        confidence = COALESCE(EXCLUDED.confidence, huddle_transcript_segments.confidence),
        started_at = COALESCE(huddle_transcript_segments.started_at, EXCLUDED.started_at),
        ended_at = COALESCE(EXCLUDED.ended_at, huddle_transcript_segments.ended_at),
        finalized_at = CASE
          WHEN EXCLUDED.status = 'final' THEN COALESCE(huddle_transcript_segments.finalized_at, now())
          ELSE huddle_transcript_segments.finalized_at
        END,
        sequence_number = COALESCE(EXCLUDED.sequence_number, huddle_transcript_segments.sequence_number),
        updated_by = EXCLUDED.updated_by,
        metadata = huddle_transcript_segments.metadata || EXCLUDED.metadata
      RETURNING *
      `,
      [
        workspaceId,
        sessionId,
        normalized.participantId,
        normalized.participantDeviceId,
        normalized.speakerKind,
        normalized.speakerUserId,
        normalized.speakerGuestId,
        normalized.speakerLabel,
        normalized.sourceProvider,
        normalized.sourceSegmentId,
        normalized.sourceEventId,
        normalized.language,
        normalized.transcriptText,
        normalized.status,
        normalized.confidence,
        normalized.startedAt,
        normalized.endedAt,
        normalized.finalizedAt,
        normalized.sequenceNumber,
        actorUserId,
        actorUserId,
        json(normalized.metadata),
      ]
    );

    const segment = rows[0];
    const event = await recordTranscriptEvent({
      eventType:
        segment.status === HUDDLE_TRANSCRIPT_SEGMENT_STATUSES.FINAL
          ? HUDDLE_TRANSCRIPT_EVENTS.SEGMENT_FINALIZED
          : HUDDLE_TRANSCRIPT_EVENTS.SEGMENT_CREATED,
      segment,
      actorUserId,
      client: tx,
    });

    return {
      segment: serializeTranscriptSegment(segment),
      event: serializeTranscriptEvent(event),
      permission,
    };
  });
}

export async function getTranscriptSegment({
  workspaceId,
  segmentId,
  actorUserId,
  role = "user",
  client = null,
}) {
  const { rows } = await runner(client).query(
    `
    SELECT
      s.*,
      COALESCE(
        NULLIF(s.speaker_label, ''),
        NULLIF(u.username, ''),
        NULLIF(g.display_name, ''),
        NULLIF(p.metadata->>'displayName', '')
      ) AS resolved_speaker_label
    FROM huddle_transcript_segments s
    LEFT JOIN users u ON u.id = s.speaker_user_id
    LEFT JOIN huddle_guests g ON g.id = s.speaker_guest_id
    LEFT JOIN huddle_session_participants p
      ON p.id = s.participant_id
     AND p.workspace_id = s.workspace_id
     AND p.session_id = s.session_id
    WHERE s.id = $1
      AND s.workspace_id = $2
      AND s.deleted_at IS NULL
    LIMIT 1
    `,
    [segmentId, workspaceId]
  );
  const segment = rows[0] || null;
  if (!segment) {
    throw createServiceError("Transcript segment not found", 404, "transcript_segment_not_found");
  }
  const context = await getSessionAccessContext({
    workspaceId,
    sessionId: segment.session_id,
    userId: actorUserId,
    role,
    client,
  });
  assertPermission(evaluateTranscriptPermission({
    session: context.session,
    participant: context.participant,
    userId: actorUserId,
    role,
    action: "read",
  }));

  return serializeTranscriptSegment(segment);
}

export async function listTranscriptSegments({
  workspaceId,
  sessionId,
  actorUserId,
  role = "user",
  status = null,
  sourceProvider = null,
  after = null,
  includeRetracted = false,
  limit = 200,
  client = null,
}) {
  const context = await getSessionAccessContext({
    workspaceId,
    sessionId,
    userId: actorUserId,
    role,
    client,
  });
  assertPermission(evaluateTranscriptPermission({
    session: context.session,
    participant: context.participant,
    userId: actorUserId,
    role,
    action: "read",
  }));

  const params = [workspaceId, sessionId];
  const conditions = [
    "s.workspace_id = $1",
    "s.session_id = $2",
    "s.deleted_at IS NULL",
  ];
  let idx = 3;

  const normalizedStatus = status ? normalizeStatus(status, null) : null;
  if (normalizedStatus) {
    conditions.push(`s.status = $${idx}`);
    params.push(normalizedStatus);
    idx += 1;
  } else if (!includeRetracted) {
    conditions.push("s.status != 'retracted'");
  }

  const provider = safeString(sourceProvider, 80);
  if (provider) {
    conditions.push(`s.source_provider = $${idx}`);
    params.push(provider);
    idx += 1;
  }

  const afterTimestamp = safeTimestamp(after);
  if (afterTimestamp) {
    conditions.push(`s.updated_at > $${idx}`);
    params.push(afterTimestamp);
    idx += 1;
  }

  params.push(Math.min(Math.max(Number(limit) || 200, 1), 1000));

  const { rows } = await runner(client).query(
    `
    SELECT
      s.*,
      COALESCE(
        NULLIF(s.speaker_label, ''),
        NULLIF(u.username, ''),
        NULLIF(g.display_name, ''),
        NULLIF(p.metadata->>'displayName', '')
      ) AS resolved_speaker_label
    FROM huddle_transcript_segments s
    LEFT JOIN users u ON u.id = s.speaker_user_id
    LEFT JOIN huddle_guests g ON g.id = s.speaker_guest_id
    LEFT JOIN huddle_session_participants p
      ON p.id = s.participant_id
     AND p.workspace_id = s.workspace_id
     AND p.session_id = s.session_id
    WHERE ${conditions.join(" AND ")}
    ORDER BY s.started_at ASC, s.created_at ASC
    LIMIT $${idx}
    `,
    params
  );

  return rows.map(serializeTranscriptSegment);
}

export async function updateTranscriptSegment({
  workspaceId,
  segmentId,
  actorUserId,
  role = "user",
  patch = {},
  client = null,
}) {
  return withTransaction(client, async (tx) => {
    const { rows: existingRows } = await tx.query(
      `
      SELECT *
      FROM huddle_transcript_segments
      WHERE id = $1
        AND workspace_id = $2
        AND deleted_at IS NULL
      LIMIT 1
      `,
      [segmentId, workspaceId]
    );
    const existing = existingRows[0];
    if (!existing) {
      throw createServiceError("Transcript segment not found", 404, "transcript_segment_not_found");
    }

    const context = await getSessionAccessContext({
      workspaceId,
      sessionId: existing.session_id,
      userId: actorUserId,
      role,
      client: tx,
    });
    const normalizedPatch = normalizeSegmentInput(
      {
        ...existing,
        ...patch,
        text:
          patch.text ??
          patch.transcriptText ??
          patch.transcript_text ??
          existing.transcript_text,
        speakerUserId:
          patch.speakerUserId ??
          patch.speaker_user_id ??
          existing.speaker_user_id,
        participantId:
          patch.participantId ??
          patch.participant_id ??
          existing.participant_id,
      },
      context,
      { defaultSpeakerUser: false }
    );
    const permission = evaluateTranscriptPermission({
      session: context.session,
      participant: context.participant,
      userId: actorUserId,
      role,
      action: "write",
      targetSpeakerUserId: normalizedPatch.speakerUserId,
      targetParticipantId: normalizedPatch.participantId,
    });
    assertPermission(permission);

    const nextStatus = patch.status
      ? normalizeStatus(patch.status, existing.status)
      : existing.status;
    const nextFinalizedAt =
      nextStatus === HUDDLE_TRANSCRIPT_SEGMENT_STATUSES.FINAL
        ? (existing.finalized_at || safeTimestamp(patch.finalizedAt || patch.finalized_at, new Date().toISOString()))
        : existing.finalized_at;

    const { rows } = await tx.query(
      `
      UPDATE huddle_transcript_segments
      SET
        participant_id = COALESCE($3, participant_id),
        participant_device_id = COALESCE($4, participant_device_id),
        speaker_kind = COALESCE($5, speaker_kind),
        speaker_user_id = COALESCE($6, speaker_user_id),
        speaker_guest_id = COALESCE($7, speaker_guest_id),
        speaker_label = COALESCE($8, speaker_label),
        language = COALESCE($9, language),
        transcript_text = COALESCE($10, transcript_text),
        status = $11,
        confidence = COALESCE($12, confidence),
        ended_at = COALESCE($13, ended_at),
        finalized_at = COALESCE($14, finalized_at),
        sequence_number = COALESCE($15, sequence_number),
        updated_by = $16,
        metadata = metadata || $17::jsonb
      WHERE id = $1
        AND workspace_id = $2
      RETURNING *
      `,
      [
        segmentId,
        workspaceId,
        normalizedPatch.participantId,
        normalizedPatch.participantDeviceId,
        normalizedPatch.speakerKind,
        normalizedPatch.speakerUserId,
        normalizedPatch.speakerGuestId,
        normalizedPatch.speakerLabel,
        normalizedPatch.language,
        normalizedPatch.transcriptText || null,
        nextStatus,
        normalizedPatch.confidence,
        normalizedPatch.endedAt,
        nextFinalizedAt,
        normalizedPatch.sequenceNumber,
        actorUserId,
        json(patch.metadata),
      ]
    );

    const segment = rows[0];
    const eventType =
      segment.status === HUDDLE_TRANSCRIPT_SEGMENT_STATUSES.RETRACTED
        ? HUDDLE_TRANSCRIPT_EVENTS.SEGMENT_RETRACTED
        : segment.status === HUDDLE_TRANSCRIPT_SEGMENT_STATUSES.FINAL
        ? HUDDLE_TRANSCRIPT_EVENTS.SEGMENT_FINALIZED
        : HUDDLE_TRANSCRIPT_EVENTS.SEGMENT_UPDATED;
    const event = await recordTranscriptEvent({
      eventType,
      segment,
      actorUserId,
      client: tx,
    });

    return {
      segment: serializeTranscriptSegment(segment),
      event: serializeTranscriptEvent(event),
      permission,
    };
  });
}

export async function finalizeTranscriptSegment({
  workspaceId,
  segmentId,
  actorUserId,
  role = "user",
  patch = {},
  client = null,
}) {
  return updateTranscriptSegment({
    workspaceId,
    segmentId,
    actorUserId,
    role,
    patch: {
      ...patch,
      status: HUDDLE_TRANSCRIPT_SEGMENT_STATUSES.FINAL,
      finalizedAt: patch.finalizedAt || new Date().toISOString(),
    },
    client,
  });
}

export async function listTranscriptEvents({
  workspaceId,
  sessionId,
  actorUserId,
  role = "user",
  after = null,
  limit = 200,
  client = null,
}) {
  const context = await getSessionAccessContext({
    workspaceId,
    sessionId,
    userId: actorUserId,
    role,
    client,
  });
  assertPermission(evaluateTranscriptPermission({
    session: context.session,
    participant: context.participant,
    userId: actorUserId,
    role,
    action: "read",
  }));

  const params = [workspaceId, sessionId, TRANSCRIPT_EVENT_TYPES];
  const conditions = [
    "workspace_id = $1",
    "session_id = $2",
    "event_type = ANY($3::text[])",
  ];
  let idx = 4;
  const afterTimestamp = safeTimestamp(after);
  if (afterTimestamp) {
    conditions.push(`created_at > $${idx}`);
    params.push(afterTimestamp);
    idx += 1;
  }
  params.push(Math.min(Math.max(Number(limit) || 200, 1), 1000));

  const { rows } = await runner(client).query(
    `
    SELECT *
    FROM huddle_session_events
    WHERE ${conditions.join(" AND ")}
    ORDER BY created_at ASC
    LIMIT $${idx}
    `,
    params
  );

  return rows.map(serializeTranscriptEvent);
}

export function getHuddleTranscriptDiagnostics() {
  return {
    ready: true,
    model: "huddle_transcript_segments",
    supportedStatuses: Object.values(HUDDLE_TRANSCRIPT_SEGMENT_STATUSES),
    supportedSpeakerKinds: Object.values(HUDDLE_TRANSCRIPT_SPEAKER_KINDS),
    eventTypes: TRANSCRIPT_EVENT_TYPES,
    canonicalSource: "huddle_transcript_segments",
    aiGenerationEnabled: false,
    captionsEnabled: false,
  };
}

export default {
  HUDDLE_TRANSCRIPT_SEGMENT_STATUSES,
  HUDDLE_TRANSCRIPT_SPEAKER_KINDS,
  HUDDLE_TRANSCRIPT_EVENTS,
  createTranscriptSegment,
  updateTranscriptSegment,
  finalizeTranscriptSegment,
  getTranscriptSegment,
  listTranscriptSegments,
  listTranscriptEvents,
  getHuddleTranscriptDiagnostics,
};
