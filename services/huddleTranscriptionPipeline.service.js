import pool from "../db.js";
import {
  createHuddleArtifact,
  listHuddleArtifacts,
} from "./huddleArtifact.service.js";
import {
  createCaptionEvent,
  recordSpeakerAttribution,
  updateTranscriptProcessingState,
} from "./huddleIntelligence.service.js";
import {
  HUDDLE_STT_PROVIDERS,
  createSttProviderGrant,
  getHuddleSttConfig,
  getHuddleSttProviderDiagnostics,
} from "./huddleSttProvider.service.js";
import {
  HUDDLE_TRANSCRIPT_SEGMENT_STATUSES,
  createTranscriptSegment,
  listTranscriptSegments,
  updateTranscriptSegment,
} from "./huddleTranscript.service.js";
import { createHuddleSessionEvent } from "./huddleEvent.service.js";

export const HUDDLE_TRANSCRIPTION_SESSION_STATUSES = Object.freeze({
  PENDING: "pending",
  ACTIVE: "active",
  PAUSED: "paused",
  FINALIZING: "finalizing",
  FINALIZED: "finalized",
  FAILED: "failed",
  CANCELLED: "cancelled",
});

export const HUDDLE_TRANSCRIPTION_EVENTS = Object.freeze({
  SESSION_STARTED: "huddle.transcription.session_started",
  TOKEN_GRANTED: "huddle.transcription.token_granted",
  PROVIDER_EVENT_PROCESSED: "huddle.transcription.provider_event_processed",
  TRANSCRIPT_FINALIZED: "huddle.transcription.transcript_finalized",
  TRANSCRIPT_FINALIZATION_SKIPPED: "huddle.transcription.transcript_finalization_skipped",
});

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

function transcriptionSessionIdFromSource(input = {}) {
  const sourceSegmentId = safeString(
    input.sourceSegmentId ||
      input.source_segment_id ||
      input.providerEventId ||
      input.provider_event_id,
    240
  );
  const match = sourceSegmentId.match(/deepgram:([0-9a-f-]{36}):/i);
  return safeUuid(match?.[1]);
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

function createServiceError(message, statusCode = 400, reason = message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.reason = reason;
  return err;
}

function serializePolicy(row = {}) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    scope: row.scope,
    enabled: row.enabled,
    providerName: row.provider_name,
    requireConsent: row.require_consent,
    hostControlsEnabled: row.host_controls_enabled,
    captionsEnabled: row.captions_enabled,
    transcriptArtifactsEnabled: row.transcript_artifacts_enabled,
    defaultLanguage: row.default_language,
    retentionDays: row.retention_days,
    policyVersion: row.policy_version,
    provenance: row.provenance_json || {},
    metadata: row.metadata || {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function serializeTranscriptionSession(row = {}) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    participantId: row.participant_id,
    participantDeviceId: row.participant_device_id,
    userId: row.user_id,
    guestId: row.guest_id,
    providerName: row.provider_name,
    providerSessionId: row.provider_session_id,
    transport: row.transport,
    status: row.status,
    captionsEnabled: row.captions_enabled,
    transcriptArtifactsEnabled: row.transcript_artifacts_enabled,
    consentRequired: row.consent_required,
    consentStatus: row.consent_status,
    policyId: row.policy_id,
    language: row.language,
    model: row.model,
    tokenExpiresAt: row.token_expires_at,
    lastEventAt: row.last_event_at,
    partialSegmentCount: row.partial_segment_count,
    finalSegmentCount: row.final_segment_count,
    retractedSegmentCount: row.retracted_segment_count,
    captionEventCount: row.caption_event_count,
    attributionCount: row.attribution_count,
    finalizedAt: row.finalized_at,
    failedAt: row.failed_at,
    failureReason: row.failure_reason,
    diagnostics: row.diagnostics || {},
    provenance: row.provenance_json || {},
    metadata: row.metadata || {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function serializeProviderEvent(row = {}) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    transcriptionSessionId: row.transcription_session_id,
    participantId: row.participant_id,
    providerName: row.provider_name,
    providerEventId: row.provider_event_id,
    providerRequestId: row.provider_request_id,
    sourceSegmentId: row.source_segment_id,
    eventType: row.event_type,
    status: row.status,
    transcriptSegmentId: row.transcript_segment_id,
    captionEventId: row.caption_event_id,
    speakerAttributionId: row.speaker_attribution_id,
    transcriptText: row.transcript_text,
    language: row.language,
    confidence: row.confidence === null || row.confidence === undefined ? null : Number(row.confidence),
    sequenceNumber: row.sequence_number,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    receivedAt: row.received_at,
    metadata: row.metadata || {},
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

async function getSessionRow({ workspaceId, sessionId, client = null }) {
  const { rows } = await runner(client).query(
    `
    SELECT *
    FROM huddle_sessions
    WHERE id = $1
      AND workspace_id = $2
    LIMIT 1
    `,
    [sessionId, workspaceId]
  );
  if (!rows[0]) {
    throw createServiceError("Huddle session not found", 404, "huddle_session_not_found");
  }
  return rows[0];
}

async function getParticipantForActor({
  workspaceId,
  sessionId,
  actorUserId,
  participantId = null,
  includeInactive = false,
  client = null,
}) {
  const params = [workspaceId, sessionId];
  const clauses = ["workspace_id = $1", "session_id = $2"];
  if (participantId) {
    params.push(participantId);
    clauses.push(`id = $${params.length}`);
  } else {
    params.push(actorUserId);
    clauses.push(`user_id = $${params.length}`);
  }
  const stateClause = includeInactive
    ? ""
    : "AND p.left_at IS NULL\n      AND p.join_state IN ('joining', 'joined', 'reconnecting', 'invited')";
  const { rows } = await runner(client).query(
    `
    SELECT
      p.*,
      COALESCE(
        NULLIF(u.username, ''),
        NULLIF(g.display_name, ''),
        NULLIF(p.metadata->>'displayName', '')
      ) AS display_name
    FROM huddle_session_participants p
    LEFT JOIN users u ON u.id = p.user_id
    LEFT JOIN huddle_guests g ON g.id = p.guest_id
    WHERE ${clauses.map((clause) => `p.${clause}`).join(" AND ")}
      ${stateClause}
    ORDER BY p.joined_at DESC NULLS LAST, p.created_at DESC
    LIMIT 1
    `,
    params
  );
  return rows[0] || null;
}

async function getLatestDeviceForParticipant({
  workspaceId,
  sessionId,
  participantId,
  client = null,
}) {
  if (!participantId) return null;
  const { rows } = await runner(client).query(
    `
    SELECT *
    FROM huddle_participant_devices
    WHERE workspace_id = $1
      AND session_id = $2
      AND participant_id = $3
      AND left_at IS NULL
    ORDER BY last_seen_at DESC NULLS LAST, joined_at DESC NULLS LAST
    LIMIT 1
    `,
    [workspaceId, sessionId, participantId]
  );
  return rows[0] || null;
}

async function getTranscriptionSessionRow({
  workspaceId,
  sessionId,
  transcriptionSessionId,
  client = null,
}) {
  const id = safeUuid(transcriptionSessionId);
  if (!id) return null;
  const { rows } = await runner(client).query(
    `
    SELECT *
    FROM huddle_transcription_sessions
    WHERE id = $1
      AND workspace_id = $2
      AND session_id = $3
    LIMIT 1
    `,
    [id, workspaceId, sessionId]
  );
  return rows[0] || null;
}

export async function getEffectiveTranscriptionPolicy({
  workspaceId,
  sessionId,
  client = null,
} = {}) {
  const config = getHuddleSttConfig();
  const { rows } = await runner(client).query(
    `
    SELECT *
    FROM huddle_transcription_policies
    WHERE workspace_id = $1
      AND (
        (scope = 'session' AND session_id = $2)
        OR (scope = 'workspace' AND session_id IS NULL)
      )
    ORDER BY
      CASE WHEN scope = 'session' THEN 0 ELSE 1 END,
      updated_at DESC
    LIMIT 1
    `,
    [workspaceId, sessionId]
  );
  const row = rows[0];
  if (row) return serializePolicy(row);
  return {
    id: null,
    workspaceId,
    sessionId: null,
    scope: "environment",
    enabled: config.enabled,
    providerName: config.provider,
    requireConsent: config.requireConsent,
    hostControlsEnabled: true,
    captionsEnabled: config.captionsEnabled,
    transcriptArtifactsEnabled: config.transcriptArtifactsEnabled,
    defaultLanguage: config.language,
    retentionDays: null,
    policyVersion: 1,
    provenance: { source: "environment" },
    metadata: {},
  };
}

export async function upsertTranscriptionPolicy({
  workspaceId,
  sessionId = null,
  actorUserId,
  role = "user",
  input = {},
  client = null,
} = {}) {
  if (!["admin", "owner", "manager"].includes(String(role || "").toLowerCase())) {
    throw createServiceError("Admin, owner, or manager required", 403, "transcription_policy_admin_required");
  }
  const scope = sessionId ? "session" : "workspace";
  return withTransaction(client, async (tx) => {
    if (sessionId) await getSessionRow({ workspaceId, sessionId, client: tx });
    const providerName = safeString(input.providerName || input.provider_name, 40) || HUDDLE_STT_PROVIDERS.DEEPGRAM;
    const values = [
      workspaceId,
      sessionId,
      scope,
      Boolean(input.enabled),
      providerName,
      Boolean(input.requireConsent ?? input.require_consent),
      input.hostControlsEnabled ?? input.host_controls_enabled ?? true,
      input.captionsEnabled ?? input.captions_enabled ?? true,
      input.transcriptArtifactsEnabled ?? input.transcript_artifacts_enabled ?? true,
      safeString(input.defaultLanguage || input.default_language, 32) || null,
      safeInteger(input.retentionDays || input.retention_days),
      json(input.provenance || input.provenance_json),
      json(input.metadata),
      actorUserId,
    ];
    const conflictTarget = sessionId
      ? "(workspace_id, session_id) WHERE scope = 'session' AND session_id IS NOT NULL"
      : "(workspace_id) WHERE scope = 'workspace' AND session_id IS NULL";
    const { rows } = await tx.query(
      `
      INSERT INTO huddle_transcription_policies (
        workspace_id, session_id, scope, enabled, provider_name, require_consent,
        host_controls_enabled, captions_enabled, transcript_artifacts_enabled,
        default_language, retention_days, policy_version, provenance_json, metadata,
        created_by, updated_by
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,1,$12::jsonb,$13::jsonb,$14,$14)
      ON CONFLICT ${conflictTarget}
      DO UPDATE SET
        enabled = EXCLUDED.enabled,
        provider_name = EXCLUDED.provider_name,
        require_consent = EXCLUDED.require_consent,
        host_controls_enabled = EXCLUDED.host_controls_enabled,
        captions_enabled = EXCLUDED.captions_enabled,
        transcript_artifacts_enabled = EXCLUDED.transcript_artifacts_enabled,
        default_language = EXCLUDED.default_language,
        retention_days = EXCLUDED.retention_days,
        policy_version = huddle_transcription_policies.policy_version + 1,
        provenance_json = huddle_transcription_policies.provenance_json || EXCLUDED.provenance_json,
        metadata = huddle_transcription_policies.metadata || EXCLUDED.metadata,
        updated_by = EXCLUDED.updated_by,
        updated_at = now()
      RETURNING *
      `,
      values
    );
    return { policy: serializePolicy(rows[0]) };
  });
}

async function evaluateConsent({
  workspaceId,
  sessionId,
  participantId,
  userId,
  policy,
  client = null,
}) {
  if (!policy?.requireConsent) {
    return { required: false, status: "not_required", allowed: true };
  }
  const { rows } = await runner(client).query(
    `
    SELECT *
    FROM huddle_intelligence_consent_records
    WHERE workspace_id = $1
      AND consent_type = 'transcription'
      AND status = 'granted'
      AND revoked_at IS NULL
      AND (
        (scope = 'workspace')
        OR (scope = 'session' AND session_id = $2)
        OR (scope = 'participant' AND session_id = $2 AND participant_id = $3)
        OR (scope = 'participant' AND session_id = $2 AND user_id = $4)
      )
    ORDER BY effective_at DESC NULLS LAST, created_at DESC
    LIMIT 1
    `,
    [workspaceId, sessionId, participantId, userId]
  );
  return {
    required: true,
    status: rows[0] ? "granted" : "requested",
    allowed: Boolean(rows[0]),
    consentRecordId: rows[0]?.id || null,
  };
}

async function upsertTranscriptionSession({
  workspaceId,
  sessionId,
  participant,
  device,
  actorUserId,
  policy,
  consent,
  grant,
  client,
}) {
  const providerSessionId = `${grant.provider}:${sessionId}:${participant?.id || actorUserId || "unknown"}`;
  const { rows } = await client.query(
    `
    INSERT INTO huddle_transcription_sessions (
      workspace_id, session_id, participant_id, participant_device_id, user_id, guest_id,
      provider_name, provider_session_id, transport, status, captions_enabled,
      transcript_artifacts_enabled, consent_required, consent_status, policy_id,
      language, model, token_expires_at, diagnostics, provenance_json, metadata, created_by
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'active',$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb,$19::jsonb,$20::jsonb,$21)
    RETURNING *
    `,
    [
      workspaceId,
      sessionId,
      participant?.id || null,
      device?.id || null,
      participant?.user_id || actorUserId || null,
      participant?.guest_id || null,
      grant.provider,
      providerSessionId,
      grant.transport,
      policy.captionsEnabled !== false,
      policy.transcriptArtifactsEnabled !== false,
      consent.required,
      consent.status,
      safeUuid(policy.id),
      grant.language,
      grant.model,
      grant.expiresAt,
      json({
        providerReady: true,
        capabilities: grant.capabilities,
        transport: grant.transport,
      }),
      json({
        provider: grant.provider,
        model: grant.model,
        tokenTtlSeconds: grant.expiresIn,
      }),
      json({ policyScope: policy.scope }),
      actorUserId,
    ]
  );
  return rows[0];
}

async function insertProviderEvent({
  workspaceId,
  sessionId,
  transcriptionSessionId,
  participantId,
  providerName,
  normalized,
  providerPayload,
  status = "received",
  transcriptSegmentId = null,
  captionEventId = null,
  speakerAttributionId = null,
  client,
}) {
  const { rows } = await client.query(
    `
    INSERT INTO huddle_transcription_provider_events (
      workspace_id, session_id, transcription_session_id, participant_id,
      provider_name, provider_event_id, provider_request_id, source_segment_id,
      event_type, status, transcript_segment_id, caption_event_id,
      speaker_attribution_id, transcript_text, language, confidence,
      sequence_number, started_at, ended_at, provider_payload, metadata
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb,$21::jsonb)
    ON CONFLICT (workspace_id, session_id, provider_name, provider_event_id)
      WHERE provider_event_id IS NOT NULL
    DO UPDATE SET
      transcription_session_id = COALESCE(EXCLUDED.transcription_session_id, huddle_transcription_provider_events.transcription_session_id),
      participant_id = COALESCE(EXCLUDED.participant_id, huddle_transcription_provider_events.participant_id),
      status = EXCLUDED.status,
      transcript_segment_id = COALESCE(EXCLUDED.transcript_segment_id, huddle_transcription_provider_events.transcript_segment_id),
      caption_event_id = COALESCE(EXCLUDED.caption_event_id, huddle_transcription_provider_events.caption_event_id),
      speaker_attribution_id = COALESCE(EXCLUDED.speaker_attribution_id, huddle_transcription_provider_events.speaker_attribution_id),
      transcript_text = COALESCE(EXCLUDED.transcript_text, huddle_transcription_provider_events.transcript_text),
      provider_payload = huddle_transcription_provider_events.provider_payload || EXCLUDED.provider_payload,
      metadata = huddle_transcription_provider_events.metadata || EXCLUDED.metadata
    RETURNING *
    `,
    [
      workspaceId,
      sessionId,
      safeUuid(transcriptionSessionId),
      safeUuid(participantId),
      providerName,
      normalized.providerEventId,
      normalized.providerRequestId,
      normalized.sourceSegmentId,
      normalized.eventType,
      status,
      safeUuid(transcriptSegmentId),
      safeUuid(captionEventId),
      safeUuid(speakerAttributionId),
      normalized.text,
      normalized.language,
      normalized.confidence,
      normalized.sequenceNumber,
      normalized.startedAt,
      normalized.endedAt,
      json(providerPayload),
      json(normalized.metadata),
    ]
  );
  return rows[0];
}

function deepgramAlternative(payload = {}) {
  return payload?.channel?.alternatives?.[0] || {};
}

function secondsToIso(baseIso, offsetSeconds) {
  const number = Number(offsetSeconds);
  if (!Number.isFinite(number)) return null;
  const base = baseIso ? new Date(baseIso).getTime() : Date.now();
  return new Date(base + number * 1000).toISOString();
}

export function normalizeTranscriptionProviderEvent(input = {}) {
  const providerPayload = objectOrEmpty(
    input.providerPayload ||
    input.provider_payload ||
    input.deepgram ||
    input.payload ||
    input.event
  );
  const providerName = safeString(input.provider || input.providerName || input.provider_name, 40) ||
    HUDDLE_STT_PROVIDERS.DEEPGRAM;
  const alt = deepgramAlternative(providerPayload);
  const text = safeString(input.text || input.transcript || alt.transcript, 4000);
  const explicitStatus = safeString(input.status, 32).toLowerCase();
  const isRetraction = explicitStatus === "retracted" || providerPayload.type === "Retraction";
  const isFinal =
    explicitStatus === "final" ||
    providerPayload.is_final === true ||
    providerPayload.speech_final === true;
  const status = isRetraction
    ? HUDDLE_TRANSCRIPT_SEGMENT_STATUSES.RETRACTED
    : isFinal
      ? HUDDLE_TRANSCRIPT_SEGMENT_STATUSES.FINAL
      : HUDDLE_TRANSCRIPT_SEGMENT_STATUSES.PARTIAL;
  const eventType = status === "final"
    ? "final"
    : status === "retracted"
      ? "retracted"
      : "partial";
  const receivedAt = input.receivedAt || new Date().toISOString();
  const startedAt =
    input.startedAt ||
    input.started_at ||
    secondsToIso(receivedAt, providerPayload.start);
  const duration = Number(input.duration ?? providerPayload.duration);
  const endedAt =
    input.endedAt ||
    input.ended_at ||
    (startedAt && Number.isFinite(duration)
      ? new Date(new Date(startedAt).getTime() + duration * 1000).toISOString()
      : null);
  const sequenceNumber = safeInteger(input.sequenceNumber || input.sequence_number);
  const sourceSegmentId =
    safeString(input.sourceSegmentId || input.source_segment_id, 160) ||
    safeString(providerPayload.channel_index, 80) ||
    safeString(providerPayload.metadata?.request_id, 120) ||
    null;
  const providerEventId =
    safeString(input.providerEventId || input.provider_event_id, 200) ||
    [
      providerName,
      sourceSegmentId || "segment",
      sequenceNumber ?? "n",
      status,
      safeString(providerPayload.metadata?.request_id, 80),
    ].filter(Boolean).join(":").slice(0, 200);

  return {
    providerName,
    providerPayload,
    providerEventId,
    providerRequestId:
      safeString(input.providerRequestId || input.provider_request_id, 200) ||
      safeString(providerPayload.metadata?.request_id, 200) ||
      null,
    sourceSegmentId,
    eventType,
    status,
    text,
    language: safeString(input.language || providerPayload.channel?.detected_language, 32) || null,
    confidence: safeConfidence(input.confidence ?? alt.confidence),
    sequenceNumber,
    startedAt,
    endedAt,
    metadata: {
      isFinal,
      speechFinal: providerPayload.speech_final === true,
      wordCount: Array.isArray(alt.words) ? alt.words.length : null,
      providerType: safeString(providerPayload.type, 80) || null,
    },
  };
}

export async function grantTranscriptionProviderToken({
  workspaceId,
  sessionId,
  actorUserId,
  role = "user",
  participantId = null,
  language = null,
  client = null,
} = {}) {
  return withTransaction(client, async (tx) => {
    const session = await getSessionRow({ workspaceId, sessionId, client: tx });
    if (session.ended_at || session.state === "ended") {
      throw createServiceError("Huddle session has ended", 409, "huddle_session_ended");
    }
    const participant = await getParticipantForActor({
      workspaceId,
      sessionId,
      actorUserId,
      participantId,
      client: tx,
    });
    if (!participant && !["admin", "owner", "manager"].includes(String(role).toLowerCase())) {
      throw createServiceError("Huddle participation required", 403, "huddle_participation_required");
    }
    const device = await getLatestDeviceForParticipant({
      workspaceId,
      sessionId,
      participantId: participant?.id,
      client: tx,
    });
    const policy = await getEffectiveTranscriptionPolicy({ workspaceId, sessionId, client: tx });
    if (!policy.enabled) {
      throw createServiceError("Huddle transcription is disabled", 503, "huddle_transcription_disabled");
    }
    const consent = await evaluateConsent({
      workspaceId,
      sessionId,
      participantId: participant?.id || null,
      userId: actorUserId,
      policy,
      client: tx,
    });
    if (!consent.allowed) {
      throw createServiceError("Transcription consent required", 403, "transcription_consent_required");
    }

    const { rows: keytermRows } = await tx.query(
      `
      SELECT DISTINCT
        COALESCE(u.username, g.display_name, p.metadata->>'displayName') AS display_name
      FROM huddle_session_participants p
      LEFT JOIN users u ON u.id = p.user_id
      LEFT JOIN huddle_guests g ON g.id = p.guest_id
      WHERE p.workspace_id = $1
        AND p.session_id = $2
      `,
      [workspaceId, sessionId]
    );
    const keyterms = keytermRows
      .map((row) => safeString(row.display_name, 100))
      .filter(Boolean);
    const grant = await createSttProviderGrant({
      workspaceId,
      sessionId,
      participantId: participant?.id,
      provider: policy.providerName,
      language: language || policy.defaultLanguage,
      keyterms,
    });
    const transcriptionSession = await upsertTranscriptionSession({
      workspaceId,
      sessionId,
      participant,
      device,
      actorUserId,
      policy,
      consent,
      grant,
      client: tx,
    });
    await insertProviderEvent({
      workspaceId,
      sessionId,
      transcriptionSessionId: transcriptionSession.id,
      participantId: participant?.id || null,
      providerName: grant.provider,
      normalized: {
        providerEventId: `token:${transcriptionSession.id}:${Date.now()}`,
        providerRequestId: null,
        sourceSegmentId: null,
        eventType: "token_granted",
        status: "token_granted",
        text: null,
        language: grant.language,
        confidence: null,
        sequenceNumber: null,
        startedAt: null,
        endedAt: null,
        metadata: { expiresAt: grant.expiresAt },
      },
      providerPayload: { transport: grant.transport, expiresIn: grant.expiresIn },
      status: "processed",
      client: tx,
    });
    const event = await createHuddleSessionEvent({
      sessionId,
      workspaceId,
      actorUserId,
      eventType: HUDDLE_TRANSCRIPTION_EVENTS.TOKEN_GRANTED,
      eventPayload: {
        transcriptionSessionId: transcriptionSession.id,
        provider: grant.provider,
        model: grant.model,
        language: grant.language,
        keytermCount: grant.keytermCount,
      },
      client: tx,
    });
    return {
      provider: grant.provider,
      model: grant.model,
      language: grant.language,
      transport: grant.transport,
      listenUrl: grant.listenUrl,
      accessToken: grant.accessToken,
      expiresIn: grant.expiresIn,
      expiresAt: grant.expiresAt,
      keytermCount: grant.keytermCount,
      transcriptionSession: serializeTranscriptionSession(transcriptionSession),
      policy,
      consent,
      event,
    };
  });
}

async function findSegmentBySource({ workspaceId, sessionId, sourceProvider, sourceSegmentId, client }) {
  if (!sourceSegmentId) return null;
  const { rows } = await client.query(
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

export async function ingestTranscriptionProviderEvent({
  workspaceId,
  sessionId,
  actorUserId,
  role = "user",
  transcriptionSessionId,
  input = {},
  client = null,
} = {}) {
  return withTransaction(client, async (tx) => {
    const backendReceivedAt = new Date().toISOString();
    const session = await getSessionRow({ workspaceId, sessionId, client: tx });
    if (session.ended_at || session.state === "ended") {
      throw createServiceError("Huddle session has ended", 409, "huddle_session_ended");
    }
    const normalized = normalizeTranscriptionProviderEvent(input);
    const sourceDerivedTranscriptionSessionId =
      transcriptionSessionIdFromSource(input) ||
      transcriptionSessionIdFromSource({
        sourceSegmentId: normalized.sourceSegmentId,
        providerEventId: normalized.providerEventId,
      });
    const requestedTranscriptionSessionId =
      transcriptionSessionId ||
      input.transcriptionSessionId ||
      input.transcription_session_id ||
      sourceDerivedTranscriptionSessionId ||
      null;
    const transcriptionSession = await getTranscriptionSessionRow({
      workspaceId,
      sessionId,
      transcriptionSessionId: requestedTranscriptionSessionId,
      client: tx,
    });
    const effectiveTranscriptionSessionId =
      transcriptionSession?.id || safeUuid(requestedTranscriptionSessionId);
    const requestedParticipantId =
      input.participantId ||
      input.participant_id ||
      transcriptionSession?.participant_id ||
      null;
    let participant = await getParticipantForActor({
      workspaceId,
      sessionId,
      actorUserId,
      participantId: requestedParticipantId,
      client: tx,
    });
    if (!participant && transcriptionSession?.participant_id) {
      participant = await getParticipantForActor({
        workspaceId,
        sessionId,
        actorUserId,
        participantId: transcriptionSession.participant_id,
        includeInactive: true,
        client: tx,
      });
    }
    if (!participant && transcriptionSession?.user_id) {
      participant = await getParticipantForActor({
        workspaceId,
        sessionId,
        actorUserId: transcriptionSession.user_id,
        includeInactive: true,
        client: tx,
      });
    }
    if (!participant && !["admin", "owner", "manager"].includes(String(role).toLowerCase())) {
      throw createServiceError("Huddle participation required", 403, "huddle_participation_required");
    }

    const participantDeviceId =
      input.participantDeviceId ||
      input.participant_device_id ||
      transcriptionSession?.participant_device_id ||
      null;
    if (!normalized.text && normalized.status !== HUDDLE_TRANSCRIPT_SEGMENT_STATUSES.RETRACTED) {
      const ignored = await insertProviderEvent({
        workspaceId,
        sessionId,
        transcriptionSessionId: effectiveTranscriptionSessionId,
        participantId: participant?.id || null,
        providerName: normalized.providerName,
        normalized,
        providerPayload: normalized.providerPayload,
        status: "ignored",
        client: tx,
      });
      return { ignored: true, providerEvent: serializeProviderEvent(ignored), reason: "empty_transcript" };
    }

    let segmentResult = null;
    if (normalized.status === HUDDLE_TRANSCRIPT_SEGMENT_STATUSES.RETRACTED) {
      const existing = await findSegmentBySource({
        workspaceId,
        sessionId,
        sourceProvider: normalized.providerName,
        sourceSegmentId: normalized.sourceSegmentId,
        client: tx,
      });
      if (existing) {
        segmentResult = await updateTranscriptSegment({
          workspaceId,
          segmentId: existing.id,
          actorUserId,
          role,
          patch: {
            status: HUDDLE_TRANSCRIPT_SEGMENT_STATUSES.RETRACTED,
            text: normalized.text || existing.transcript_text,
            metadata: {
              ...(existing.metadata || {}),
              retractedByProvider: normalized.providerName,
            },
          },
          client: tx,
        });
      }
    } else {
      segmentResult = await createTranscriptSegment({
        workspaceId,
        sessionId,
        actorUserId,
        role,
        input: {
          participantId: participant?.id || null,
          participantDeviceId,
          speakerKind: participant?.participant_kind || "workspace_user",
          speakerUserId: participant?.user_id || actorUserId || null,
          speakerGuestId: participant?.guest_id || null,
          speakerLabel:
            input.speakerLabel ||
            input.speaker_label ||
            participant?.display_name ||
            null,
          sourceProvider: normalized.providerName,
          sourceSegmentId: normalized.sourceSegmentId,
          language: normalized.language,
          text: normalized.text,
          status: normalized.status,
          confidence: normalized.confidence,
          startedAt: normalized.startedAt,
          endedAt: normalized.endedAt,
          sequenceNumber: normalized.sequenceNumber,
          metadata: {
            providerEventId: normalized.providerEventId,
            providerRequestId: normalized.providerRequestId,
            transcriptionSessionId: effectiveTranscriptionSessionId,
            providerMetadata: normalized.metadata,
          },
        },
        client: tx,
      });
    }

    const segment = segmentResult?.segment || null;
    let attributionResult = null;
    if (segment?.id && participant?.id) {
      attributionResult = await recordSpeakerAttribution({
        workspaceId,
        sessionId,
        actorUserId,
        role,
        input: {
          transcriptSegmentId: segment.id,
          participantId: participant.id,
          participantDeviceId,
          speakerKind: participant.participant_kind || "workspace_user",
          speakerUserId: participant.user_id || actorUserId || null,
          speakerGuestId: participant.guest_id || null,
          speakerLabel:
            input.speakerLabel ||
            input.speaker_label ||
            participant.display_name ||
            null,
          confidence: normalized.confidence,
          attributionSource: "provider",
          providerName: normalized.providerName,
          providerSpeakerId: input.providerSpeakerId || input.provider_speaker_id || participant.id,
          provenance: {
            transcriptionSessionId: effectiveTranscriptionSessionId,
            sourceSegmentId: normalized.sourceSegmentId,
          },
        },
        client: tx,
      });
    }

    let captionResult = null;
    if (segment?.id) {
      captionResult = await createCaptionEvent({
        workspaceId,
        sessionId,
        actorUserId,
        role,
        input: {
          transcriptSegmentId: segment.id,
          speakerAttributionId: attributionResult?.attribution?.id || null,
          text: normalized.text || segment.text,
          status: normalized.status,
          sourceProvider: normalized.providerName,
          sequenceNumber: normalized.sequenceNumber,
          language: normalized.language,
          confidence: normalized.confidence,
          replayable: true,
          metadata: {
            transcriptionSessionId: effectiveTranscriptionSessionId,
            providerEventId: normalized.providerEventId,
            sourceSegmentId: normalized.sourceSegmentId,
            clientCapturedAt:
              input.clientCapturedAt || input.client_captured_at || null,
            clientProviderReceivedAt:
              input.clientProviderReceivedAt ||
              input.client_provider_received_at ||
              null,
            clientPostedAt: input.clientPostedAt || input.client_posted_at || null,
            backendReceivedAt,
          },
        },
        client: tx,
      });
    }

    await updateTranscriptProcessingState({
      workspaceId,
      sessionId,
      actorUserId,
      role,
      status: normalized.status === "final" ? "finalizing" : normalized.status,
      sourceProvider: normalized.providerName,
      segmentStatus: normalized.status,
      lastSegmentId: segment?.id || null,
      provenance: {
        transcriptionSessionId: effectiveTranscriptionSessionId,
        providerEventId: normalized.providerEventId,
      },
      diagnostics: {
        lastProviderStatus: normalized.status,
      },
      metadata: {
        providerName: normalized.providerName,
      },
      client: tx,
    });

    const providerEvent = await insertProviderEvent({
      workspaceId,
      sessionId,
      transcriptionSessionId: effectiveTranscriptionSessionId,
      participantId: participant?.id || null,
      providerName: normalized.providerName,
      normalized,
      providerPayload: normalized.providerPayload,
      status: "processed",
      transcriptSegmentId: segment?.id || null,
      captionEventId: captionResult?.caption?.id || null,
      speakerAttributionId: attributionResult?.attribution?.id || null,
      client: tx,
    });

    await repairTranscriptionIdentityLinks({
      workspaceId,
      sessionId,
      sourceSegmentId: normalized.sourceSegmentId,
      client: tx,
    });

    if (effectiveTranscriptionSessionId) {
      await tx.query(
        `
        UPDATE huddle_transcription_sessions
        SET last_event_at = now(),
            partial_segment_count = partial_segment_count + $4,
            final_segment_count = final_segment_count + $5,
            retracted_segment_count = retracted_segment_count + $6,
            caption_event_count = caption_event_count + $7,
            attribution_count = attribution_count + $8,
            diagnostics = diagnostics || $9::jsonb,
            updated_at = now()
        WHERE id = $1
          AND workspace_id = $2
          AND session_id = $3
        `,
        [
          effectiveTranscriptionSessionId,
          workspaceId,
          sessionId,
          normalized.status === "partial" ? 1 : 0,
          normalized.status === "final" ? 1 : 0,
          normalized.status === "retracted" ? 1 : 0,
          captionResult?.caption?.id ? 1 : 0,
          attributionResult?.attribution?.id ? 1 : 0,
          json({ lastProviderEventId: normalized.providerEventId }),
        ]
      );
    }

    const event = await createHuddleSessionEvent({
      sessionId,
      workspaceId,
      actorUserId,
      eventType: HUDDLE_TRANSCRIPTION_EVENTS.PROVIDER_EVENT_PROCESSED,
      eventPayload: {
        transcriptionSessionId: effectiveTranscriptionSessionId,
        providerEventId: normalized.providerEventId,
        transcriptSegmentId: segment?.id || null,
        captionEventId: captionResult?.caption?.id || null,
        speakerAttributionId: attributionResult?.attribution?.id || null,
        status: normalized.status,
      },
      client: tx,
    });

    return {
      providerEvent: serializeProviderEvent(providerEvent),
      segment,
      caption: captionResult?.caption || null,
      attribution: attributionResult?.attribution || null,
      event,
    };
  });
}

function transcriptArtifactText(segments = []) {
  return segments
    .map((segment) => {
      const speaker = segment.speaker?.label || segment.speaker?.userId || segment.participantId || "Speaker";
      const at = segment.startedAt ? new Date(segment.startedAt).toISOString() : "";
      return `[${at}] ${speaker}: ${segment.text}`;
    })
    .join("\n");
}

function retentionExpiresAt(policy = {}) {
  if (!Number.isInteger(policy.retentionDays)) return null;
  if (policy.retentionDays <= 0) return new Date().toISOString();
  return new Date(Date.now() + policy.retentionDays * 24 * 60 * 60 * 1000).toISOString();
}

async function repairTranscriptionIdentityLinks({
  workspaceId,
  sessionId,
  sourceSegmentId = null,
  client,
}) {
  const params = [workspaceId, sessionId, sourceSegmentId || null];
  await client.query(
    `
    WITH resolved AS (
      SELECT DISTINCT
        e.source_segment_id,
        e.provider_name,
        substring(e.source_segment_id from 'deepgram:([0-9a-f-]{36}):')::uuid AS transcription_session_id,
        ts.participant_id,
        ts.participant_device_id,
        ts.user_id,
        ts.guest_id
      FROM huddle_transcription_provider_events e
      JOIN huddle_transcription_sessions ts
        ON ts.id = substring(e.source_segment_id from 'deepgram:([0-9a-f-]{36}):')::uuid
       AND ts.workspace_id = e.workspace_id
       AND ts.session_id = e.session_id
      WHERE e.workspace_id = $1
        AND e.session_id = $2
        AND e.source_segment_id ~ 'deepgram:[0-9a-f-]{36}:'
        AND ($3::text IS NULL OR e.source_segment_id = $3)
    )
    UPDATE huddle_transcript_segments s
    SET participant_id = COALESCE(s.participant_id, r.participant_id),
        participant_device_id = COALESCE(s.participant_device_id, r.participant_device_id),
        speaker_kind = CASE
          WHEN s.speaker_kind IS NULL OR s.speaker_kind = 'unknown' THEN
            CASE WHEN r.user_id IS NOT NULL THEN 'workspace_user'
                 WHEN r.guest_id IS NOT NULL THEN 'guest'
                 ELSE s.speaker_kind END
          ELSE s.speaker_kind
        END,
        speaker_user_id = COALESCE(s.speaker_user_id, r.user_id),
        speaker_guest_id = COALESCE(s.speaker_guest_id, r.guest_id),
        metadata = s.metadata || jsonb_build_object('transcriptionSessionId', r.transcription_session_id),
        updated_at = now()
    FROM resolved r
    WHERE s.workspace_id = $1
      AND s.session_id = $2
      AND s.source_provider = r.provider_name
      AND s.source_segment_id = r.source_segment_id
    `,
    params
  );

  await client.query(
    `
    WITH segment_links AS (
      SELECT
        s.id AS transcript_segment_id,
        s.source_segment_id,
        s.participant_id,
        s.participant_device_id,
        s.speaker_user_id,
        s.speaker_guest_id,
        substring(s.source_segment_id from 'deepgram:([0-9a-f-]{36}):')::uuid AS transcription_session_id
      FROM huddle_transcript_segments s
      WHERE s.workspace_id = $1
        AND s.session_id = $2
        AND s.source_segment_id ~ 'deepgram:[0-9a-f-]{36}:'
        AND ($3::text IS NULL OR s.source_segment_id = $3)
    )
    UPDATE huddle_speaker_attributions a
    SET transcript_segment_id = COALESCE(a.transcript_segment_id, sl.transcript_segment_id),
        participant_id = COALESCE(a.participant_id, sl.participant_id),
        participant_device_id = COALESCE(a.participant_device_id, sl.participant_device_id),
        speaker_user_id = COALESCE(a.speaker_user_id, sl.speaker_user_id),
        speaker_guest_id = COALESCE(a.speaker_guest_id, sl.speaker_guest_id),
        provenance_json = a.provenance_json || jsonb_build_object('transcriptionSessionId', sl.transcription_session_id),
        updated_at = now()
    FROM segment_links sl
    WHERE a.workspace_id = $1
      AND a.session_id = $2
      AND a.provenance_json->>'sourceSegmentId' = sl.source_segment_id
    `,
    params
  );

  await client.query(
    `
    WITH event_links AS (
      SELECT
        e.provider_event_id,
        e.source_segment_id,
        e.provider_name,
        substring(e.source_segment_id from 'deepgram:([0-9a-f-]{36}):')::uuid AS transcription_session_id,
        ts.participant_id,
        s.id AS transcript_segment_id,
        (
          SELECT a.id
          FROM huddle_speaker_attributions a
          WHERE a.workspace_id = e.workspace_id
            AND a.session_id = e.session_id
            AND a.provenance_json->>'sourceSegmentId' = e.source_segment_id
          ORDER BY a.created_at DESC
          LIMIT 1
        ) AS speaker_attribution_id
      FROM huddle_transcription_provider_events e
      JOIN huddle_transcription_sessions ts
        ON ts.id = substring(e.source_segment_id from 'deepgram:([0-9a-f-]{36}):')::uuid
       AND ts.workspace_id = e.workspace_id
       AND ts.session_id = e.session_id
      LEFT JOIN huddle_transcript_segments s
        ON s.workspace_id = e.workspace_id
       AND s.session_id = e.session_id
       AND s.source_provider = e.provider_name
       AND s.source_segment_id = e.source_segment_id
      WHERE e.workspace_id = $1
        AND e.session_id = $2
        AND e.source_segment_id ~ 'deepgram:[0-9a-f-]{36}:'
        AND ($3::text IS NULL OR e.source_segment_id = $3)
    )
    UPDATE huddle_caption_events c
    SET transcript_segment_id = COALESCE(c.transcript_segment_id, el.transcript_segment_id),
        speaker_attribution_id = COALESCE(c.speaker_attribution_id, el.speaker_attribution_id),
        metadata = c.metadata || jsonb_build_object('transcriptionSessionId', el.transcription_session_id)
    FROM event_links el
    WHERE c.workspace_id = $1
      AND c.session_id = $2
      AND c.metadata->>'providerEventId' = el.provider_event_id
    `,
    params
  );

  await client.query(
    `
    WITH event_links AS (
      SELECT
        e.id,
        substring(e.source_segment_id from 'deepgram:([0-9a-f-]{36}):')::uuid AS transcription_session_id,
        ts.participant_id,
        s.id AS transcript_segment_id,
        (
          SELECT c.id
          FROM huddle_caption_events c
          WHERE c.workspace_id = e.workspace_id
            AND c.session_id = e.session_id
            AND c.metadata->>'providerEventId' = e.provider_event_id
          ORDER BY c.emitted_at DESC
          LIMIT 1
        ) AS caption_event_id,
        (
          SELECT a.id
          FROM huddle_speaker_attributions a
          WHERE a.workspace_id = e.workspace_id
            AND a.session_id = e.session_id
            AND a.provenance_json->>'sourceSegmentId' = e.source_segment_id
          ORDER BY a.created_at DESC
          LIMIT 1
        ) AS speaker_attribution_id
      FROM huddle_transcription_provider_events e
      JOIN huddle_transcription_sessions ts
        ON ts.id = substring(e.source_segment_id from 'deepgram:([0-9a-f-]{36}):')::uuid
       AND ts.workspace_id = e.workspace_id
       AND ts.session_id = e.session_id
      LEFT JOIN huddle_transcript_segments s
        ON s.workspace_id = e.workspace_id
       AND s.session_id = e.session_id
       AND s.source_provider = e.provider_name
       AND s.source_segment_id = e.source_segment_id
      WHERE e.workspace_id = $1
        AND e.session_id = $2
        AND e.source_segment_id ~ 'deepgram:[0-9a-f-]{36}:'
        AND ($3::text IS NULL OR e.source_segment_id = $3)
    )
    UPDATE huddle_transcription_provider_events e
    SET transcription_session_id = COALESCE(e.transcription_session_id, el.transcription_session_id),
        participant_id = COALESCE(e.participant_id, el.participant_id),
        transcript_segment_id = COALESCE(e.transcript_segment_id, el.transcript_segment_id),
        caption_event_id = COALESCE(e.caption_event_id, el.caption_event_id),
        speaker_attribution_id = COALESCE(e.speaker_attribution_id, el.speaker_attribution_id)
    FROM event_links el
    WHERE e.id = el.id
    `,
    params
  );

  await client.query(
    `
    WITH stats AS (
      SELECT
        transcription_session_id,
        count(*) FILTER (WHERE event_type = 'partial')::int AS partial_count,
        count(*) FILTER (WHERE event_type = 'final')::int AS final_count
      FROM huddle_transcription_provider_events
      WHERE workspace_id = $1
        AND session_id = $2
        AND transcription_session_id IS NOT NULL
      GROUP BY transcription_session_id
    ),
    caption_stats AS (
      SELECT
        substring(s.source_segment_id from 'deepgram:([0-9a-f-]{36}):')::uuid AS transcription_session_id,
        count(c.*)::int AS caption_count
      FROM huddle_caption_events c
      JOIN huddle_transcript_segments s
        ON s.id = c.transcript_segment_id
       AND s.workspace_id = c.workspace_id
       AND s.session_id = c.session_id
      WHERE c.workspace_id = $1
        AND c.session_id = $2
        AND s.source_segment_id ~ 'deepgram:[0-9a-f-]{36}:'
      GROUP BY transcription_session_id
    ),
    attribution_stats AS (
      SELECT
        substring(s.source_segment_id from 'deepgram:([0-9a-f-]{36}):')::uuid AS transcription_session_id,
        count(a.*)::int AS attribution_count
      FROM huddle_speaker_attributions a
      JOIN huddle_transcript_segments s
        ON s.id = a.transcript_segment_id
       AND s.workspace_id = a.workspace_id
       AND s.session_id = a.session_id
      WHERE a.workspace_id = $1
        AND a.session_id = $2
        AND s.source_segment_id ~ 'deepgram:[0-9a-f-]{36}:'
      GROUP BY transcription_session_id
    )
    UPDATE huddle_transcription_sessions ts
    SET partial_segment_count = COALESCE(stats.partial_count, 0),
        final_segment_count = COALESCE(stats.final_count, 0),
        caption_event_count = COALESCE(caption_stats.caption_count, 0),
        attribution_count = COALESCE(attribution_stats.attribution_count, 0),
        updated_at = now()
    FROM stats
    LEFT JOIN caption_stats
      ON caption_stats.transcription_session_id = stats.transcription_session_id
    LEFT JOIN attribution_stats
      ON attribution_stats.transcription_session_id = stats.transcription_session_id
    WHERE ts.id = stats.transcription_session_id
      AND ts.workspace_id = $1
      AND ts.session_id = $2
    `,
    params.slice(0, 2)
  );
}

export async function finalizeHuddleTranscript({
  workspaceId,
  sessionId,
  actorUserId = null,
  role = "admin",
  reason = "huddle_ended",
  client = null,
} = {}) {
  return withTransaction(client, async (tx) => {
    await getSessionRow({ workspaceId, sessionId, client: tx });
    await tx.query(
      "SELECT pg_advisory_xact_lock(hashtext($1))",
      [`huddle_transcript_finalization:${workspaceId}:${sessionId}`]
    );
    const policy = await getEffectiveTranscriptionPolicy({ workspaceId, sessionId, client: tx });
    await repairTranscriptionIdentityLinks({ workspaceId, sessionId, client: tx });
    const existing = await listHuddleArtifacts({
      workspaceId,
      sessionId,
      actorUserId,
      role,
      artifactType: "transcript",
      status: "ready",
      limit: 1,
      client: tx,
    });
    if (existing.length) {
      return { skipped: true, reason: "transcript_artifact_already_exists", artifact: existing[0] };
    }

    const segments = await listTranscriptSegments({
      workspaceId,
      sessionId,
      actorUserId,
      role,
      status: HUDDLE_TRANSCRIPT_SEGMENT_STATUSES.FINAL,
      includeRetracted: false,
      limit: 5000,
      client: tx,
    });
    if (!segments.length) {
      await updateTranscriptProcessingState({
        workspaceId,
        sessionId,
        actorUserId,
        role,
        status: "finalized",
        sourceProvider: policy.providerName || "unknown",
        provenance: { reason, segmentCount: 0 },
        diagnostics: { transcriptArtifactCreated: false },
        client: tx,
      });
      const event = await createHuddleSessionEvent({
        sessionId,
        workspaceId,
        actorUserId,
        eventType: HUDDLE_TRANSCRIPTION_EVENTS.TRANSCRIPT_FINALIZATION_SKIPPED,
        eventPayload: { reason: "no_final_segments" },
        client: tx,
      });
      return { skipped: true, reason: "no_final_segments", event };
    }

    const text = transcriptArtifactText(segments);
    const artifact = await createHuddleArtifact({
      workspaceId,
      sessionId,
      actorUserId,
      role,
      input: {
        artifactType: "transcript",
        status: "ready",
        contentText: text,
        contentJson: {
          segmentCount: segments.length,
          segments,
          generatedBy: "huddle_transcription_pipeline",
        },
        visibility: "session_participants",
        retentionPolicy: policy.retentionDays === null ? null : "huddle_transcription_policy",
        retentionExpiresAt: retentionExpiresAt(policy),
        provenance: {
          source: "transcript_segments",
          reason,
          providerName: policy.providerName,
        },
        metadata: {
          finalSegmentCount: segments.length,
          transcriptionProvider: policy.providerName,
        },
        sources: segments.map((segment) => ({
          sourceKind: "transcript_segment",
          transcriptSegmentId: segment.id,
          rangeStartAt: segment.startedAt,
          rangeEndAt: segment.endedAt,
          metadata: {
            sourceProvider: segment.sourceProvider,
            sourceSegmentId: segment.sourceSegmentId,
          },
        })),
      },
      client: tx,
    });
    await updateTranscriptProcessingState({
      workspaceId,
      sessionId,
      actorUserId,
      role,
      status: "finalized",
      sourceProvider: policy.providerName || "unknown",
      provenance: {
        reason,
        artifactId: artifact.artifact.id,
      },
      diagnostics: {
        transcriptArtifactCreated: true,
        finalSegmentCount: segments.length,
      },
      client: tx,
    });
    await tx.query(
      `
      UPDATE huddle_transcription_sessions
      SET status = 'finalized',
          finalized_at = now(),
          updated_at = now()
      WHERE workspace_id = $1
        AND session_id = $2
        AND status IN ('pending', 'active', 'paused', 'finalizing')
      `,
      [workspaceId, sessionId]
    );
    const event = await createHuddleSessionEvent({
      sessionId,
      workspaceId,
      actorUserId,
      eventType: HUDDLE_TRANSCRIPTION_EVENTS.TRANSCRIPT_FINALIZED,
      eventPayload: {
        artifactId: artifact.artifact.id,
        finalSegmentCount: segments.length,
      },
      client: tx,
    });
    return { artifact: artifact.artifact, segmentCount: segments.length, event };
  });
}

export async function getTranscriptionSessionDiagnostics({
  workspaceId,
  sessionId,
  actorUserId,
  role = "user",
  client = null,
} = {}) {
  const session = await getSessionRow({ workspaceId, sessionId, client });
  const participant = await getParticipantForActor({ workspaceId, sessionId, actorUserId, client });
  if (!participant && !["admin", "owner", "manager"].includes(String(role).toLowerCase()) && session.visibility !== "workspace") {
    throw createServiceError("Huddle participation required", 403, "huddle_participation_required");
  }
  const policy = await getEffectiveTranscriptionPolicy({ workspaceId, sessionId, client });
  const [sessionRows, eventCounts, segmentCounts, captionCounts, attributionCounts] = await Promise.all([
    runner(client).query(
      `
      SELECT *
      FROM huddle_transcription_sessions
      WHERE workspace_id = $1 AND session_id = $2
      ORDER BY updated_at DESC
      LIMIT 25
      `,
      [workspaceId, sessionId]
    ),
    runner(client).query(
      `
      SELECT event_type, status, count(*)::int AS count
      FROM huddle_transcription_provider_events
      WHERE workspace_id = $1 AND session_id = $2
      GROUP BY event_type, status
      `,
      [workspaceId, sessionId]
    ),
    runner(client).query(
      `
      SELECT status, count(*)::int AS count
      FROM huddle_transcript_segments
      WHERE workspace_id = $1 AND session_id = $2 AND deleted_at IS NULL
      GROUP BY status
      `,
      [workspaceId, sessionId]
    ),
    runner(client).query(
      `
      SELECT status, count(*)::int AS count
      FROM huddle_caption_events
      WHERE workspace_id = $1 AND session_id = $2
      GROUP BY status
      `,
      [workspaceId, sessionId]
    ),
    runner(client).query(
      `
      SELECT status, count(*)::int AS count
      FROM huddle_speaker_attributions
      WHERE workspace_id = $1 AND session_id = $2
      GROUP BY status
      `,
      [workspaceId, sessionId]
    ),
  ]);
  return {
    provider: getHuddleSttProviderDiagnostics(),
    policy,
    session: {
      id: session.id,
      state: session.state,
      endedAt: session.ended_at,
    },
    transcriptionSessions: sessionRows.rows.map(serializeTranscriptionSession),
    providerEvents: eventCounts.rows,
    transcriptSegments: segmentCounts.rows,
    captionEvents: captionCounts.rows,
    speakerAttribution: attributionCounts.rows,
    finalization: {
      readyForArtifact: segmentCounts.rows.some((row) => row.status === "final" && row.count > 0),
    },
  };
}

export function getHuddleTranscriptionDiagnostics() {
  const provider = getHuddleSttProviderDiagnostics();
  return {
    ready: provider.ready,
    domain: "huddle_transcription",
    providerNeutral: true,
    productionProvider: HUDDLE_STT_PROVIDERS.DEEPGRAM,
    audioTransport: "client_to_provider_with_backend_token_grant",
    canonicalStores: {
      transcriptSegments: "huddle_transcript_segments",
      captionEvents: "huddle_caption_events",
      speakerAttribution: "huddle_speaker_attributions",
      transcriptArtifacts: "huddle_artifacts",
      providerEvents: "huddle_transcription_provider_events",
      transcriptionSessions: "huddle_transcription_sessions",
      policies: "huddle_transcription_policies",
    },
    provider,
  };
}

export default {
  HUDDLE_TRANSCRIPTION_SESSION_STATUSES,
  HUDDLE_TRANSCRIPTION_EVENTS,
  getEffectiveTranscriptionPolicy,
  upsertTranscriptionPolicy,
  grantTranscriptionProviderToken,
  ingestTranscriptionProviderEvent,
  finalizeHuddleTranscript,
  getTranscriptionSessionDiagnostics,
  getHuddleTranscriptionDiagnostics,
  normalizeTranscriptionProviderEvent,
};
