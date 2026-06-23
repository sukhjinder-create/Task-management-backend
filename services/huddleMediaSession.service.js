import pool from "../db.js";

export const HUDDLE_MEDIA_SESSION_MODEL_VERSION = 1;

export const HUDDLE_MEDIA_PROVIDERS = Object.freeze({
  MESH: "mesh",
  LIVEKIT: "livekit",
});

export const HUDDLE_MEDIA_SESSION_STATES = Object.freeze({
  IDLE: "idle",
  ACTIVE: "active",
  ENDED: "ended",
  UNAVAILABLE: "unavailable",
});

export const HUDDLE_MEDIA_METADATA_STATUSES = Object.freeze({
  VALID: "valid",
  EMPTY: "empty",
  UNSUPPORTED_PROVIDER: "unsupported_provider",
});

const PROVIDER_METADATA_ALLOWLIST = Object.freeze({
  [HUDDLE_MEDIA_PROVIDERS.MESH]: new Set([
    "transport",
    "signaling",
    "roomMode",
    "compatibilitySource",
    "diagnostics",
  ]),
  [HUDDLE_MEDIA_PROVIDERS.LIVEKIT]: new Set([
    "roomName",
    "roomSid",
    "region",
    "egressEnabled",
    "ingressEnabled",
    "recordingEnabled",
    "transcriptionEnabled",
    "diagnostics",
  ]),
});

const SENSITIVE_METADATA_KEYS = new Set([
  "apiKey",
  "api_key",
  "authorization",
  "credential",
  "credentials",
  "ice",
  "iceServers",
  "jwt",
  "password",
  "secret",
  "sdp",
  "token",
]);

function safeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function objectOrEmpty(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value;
}

function runner(client) {
  return client || pool;
}

function json(value) {
  return JSON.stringify(value || {});
}

function safeNumber(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeKbps(value, fallback = null) {
  let number = Number(value);
  if (!Number.isFinite(number) || number < 0) return fallback;
  if (number > 100000) number = number / 1000;
  if (number > 20000) return fallback;
  return Number(number.toFixed(1));
}

function normalizeEstimatedMegabytesPerHour(value, bitrateKbps = null) {
  const normalizedBitrate = normalizeKbps(bitrateKbps);
  const number = safeNumber(value);
  if (normalizedBitrate !== null && (!Number.isFinite(number) || number > 20000)) {
    return Number(((normalizedBitrate * 3600) / 8 / 1000).toFixed(1));
  }
  if (!Number.isFinite(number) || number < 0 || number > 20000) return null;
  return Number(number.toFixed(1));
}

function safeBoolean(value, fallback = false) {
  return typeof value === "boolean" ? value : fallback;
}

function boundedString(value, maxLength = 160) {
  return safeString(value).slice(0, maxLength) || null;
}

function boundedArray(value, maxItems = 20) {
  return Array.isArray(value) ? value.slice(0, maxItems) : [];
}

function persistentStateFromModelState(state) {
  if (state === HUDDLE_MEDIA_SESSION_STATES.ACTIVE) return "active";
  if (state === HUDDLE_MEDIA_SESSION_STATES.ENDED) return "ended";
  if (state === HUDDLE_MEDIA_SESSION_STATES.UNAVAILABLE) return "failed";
  return "pending";
}

export function getDefaultMediaProviderType(env = process.env) {
  const configured = safeString(env.HUDDLE_MEDIA_PROVIDER).toLowerCase();
  if (configured === HUDDLE_MEDIA_PROVIDERS.LIVEKIT) {
    // LiveKit is modeled for future compatibility, but mesh remains the only
    // active implementation in Epic 5C.2.
    return HUDDLE_MEDIA_PROVIDERS.MESH;
  }
  return HUDDLE_MEDIA_PROVIDERS.MESH;
}

export function normalizeMediaProviderType(providerType = null) {
  const normalized = safeString(providerType).toLowerCase();
  if (normalized === HUDDLE_MEDIA_PROVIDERS.LIVEKIT) return normalized;
  return HUDDLE_MEDIA_PROVIDERS.MESH;
}

export function isMediaProviderImplemented(providerType) {
  const provider = normalizeMediaProviderType(providerType);
  return provider === HUDDLE_MEDIA_PROVIDERS.MESH ||
    provider === HUDDLE_MEDIA_PROVIDERS.LIVEKIT;
}

export function buildProviderRoomIdentity({
  providerType = HUDDLE_MEDIA_PROVIDERS.MESH,
  workspaceId,
  sessionId = null,
  legacyHuddleId = null,
  legacyChannelKey = null,
} = {}) {
  const provider = normalizeMediaProviderType(providerType);
  const scopeId =
    safeString(sessionId) ||
    safeString(legacyHuddleId) ||
    safeString(legacyChannelKey) ||
    "unmapped";

  return `${provider}:workspace:${safeString(workspaceId) || "unknown"}:huddle:${scopeId}`;
}

export function sanitizeProviderMetadata(providerType, metadata = {}) {
  const provider = normalizeMediaProviderType(providerType);
  const source = objectOrEmpty(metadata);
  const allowed = PROVIDER_METADATA_ALLOWLIST[provider] || new Set();
  const sanitized = {};

  for (const [key, value] of Object.entries(source)) {
    if (SENSITIVE_METADATA_KEYS.has(key)) continue;
    if (!allowed.has(key)) continue;
    sanitized[key] = value;
  }

  return sanitized;
}

export function getProviderMetadataStatus(providerType, metadata = {}) {
  const provider = normalizeMediaProviderType(providerType);
  if (!PROVIDER_METADATA_ALLOWLIST[provider]) {
    return HUDDLE_MEDIA_METADATA_STATUSES.UNSUPPORTED_PROVIDER;
  }
  return Object.keys(sanitizeProviderMetadata(provider, metadata)).length > 0
    ? HUDDLE_MEDIA_METADATA_STATUSES.VALID
    : HUDDLE_MEDIA_METADATA_STATUSES.EMPTY;
}

function deriveMediaSessionState({ session = null, legacyHuddle = null } = {}) {
  if (session?.ended_at || session?.state === "ended" || legacyHuddle?.ended_at) {
    return HUDDLE_MEDIA_SESSION_STATES.ENDED;
  }
  if (session || legacyHuddle) return HUDDLE_MEDIA_SESSION_STATES.ACTIVE;
  return HUDDLE_MEDIA_SESSION_STATES.IDLE;
}

export function createMediaSessionDiagnostics({
  providerType,
  providerRoomId,
  state,
  providerMetadataStatus,
  metadata = {},
  providerLock = null,
  providerSelection = null,
} = {}) {
  const provider = normalizeMediaProviderType(providerType);
  return {
    providerType: provider,
    selectedProvider: provider,
    requestedProvider: providerSelection?.requestedProvider || null,
    providerRoomId: providerRoomId || null,
    mediaSessionState: state || HUDDLE_MEDIA_SESSION_STATES.IDLE,
    providerMetadataStatus:
      providerMetadataStatus || HUDDLE_MEDIA_METADATA_STATUSES.EMPTY,
    providerImplemented: isMediaProviderImplemented(provider),
    roomProvisioned: Boolean(metadata?.roomProvisioned),
    tokenIssuanceEnabled: Boolean(metadata?.tokenIssuanceEnabled),
    selectionReason: providerSelection?.selectionReason || providerSelection?.reason || null,
    fallbackReason: providerSelection?.fallbackReason || null,
    providerLock: providerLock || {
      locked: false,
      providerType: null,
      immutable: true,
    },
    observedAt: new Date().toISOString(),
    metadata: objectOrEmpty(metadata),
  };
}

export function createHuddleMediaSession({
  session = null,
  legacyHuddle = null,
  workspaceId = null,
  providerType = null,
  providerMetadata = {},
  diagnosticsMetadata = {},
} = {}) {
  const provider = normalizeMediaProviderType(
    providerType || getDefaultMediaProviderType()
  );
  const resolvedWorkspaceId =
    workspaceId || session?.workspace_id || legacyHuddle?.workspace_id || null;
  const legacyHuddleId = session?.legacy_huddle_id || legacyHuddle?.huddle_id || null;
  const legacyChannelKey =
    session?.legacy_channel_key || legacyHuddle?.channel_key || null;
  const sessionId = session?.id || null;
  const providerRoomId = buildProviderRoomIdentity({
    providerType: provider,
    workspaceId: resolvedWorkspaceId,
    sessionId,
    legacyHuddleId,
    legacyChannelKey,
  });
  const sanitizedMetadata = sanitizeProviderMetadata(provider, providerMetadata);
  const providerMetadataStatus = getProviderMetadataStatus(
    provider,
    sanitizedMetadata
  );
  const state = deriveMediaSessionState({ session, legacyHuddle });

  return {
    version: HUDDLE_MEDIA_SESSION_MODEL_VERSION,
    sessionId,
    workspaceId: resolvedWorkspaceId,
    legacyHuddleId,
    legacyChannelKey,
    providerType: provider,
    providerRoomId,
    providerMetadata: {
      provider,
      status: providerMetadataStatus,
      implemented: isMediaProviderImplemented(provider),
      metadata: sanitizedMetadata,
    },
    state,
    diagnostics: createMediaSessionDiagnostics({
      providerType: provider,
      providerRoomId,
      state,
      providerMetadataStatus,
      metadata: diagnosticsMetadata,
    }),
  };
}

export function getMediaSessionDiagnostics(mediaSession) {
  if (!mediaSession) {
    return createMediaSessionDiagnostics({
      providerType: HUDDLE_MEDIA_PROVIDERS.MESH,
      state: HUDDLE_MEDIA_SESSION_STATES.UNAVAILABLE,
    });
  }
  return mediaSession.diagnostics || createMediaSessionDiagnostics(mediaSession);
}

export function assertHuddleMediaSessionModel(mediaSession) {
  if (!mediaSession || typeof mediaSession !== "object") {
    throw new Error("mediaSession is required");
  }
  const required = [
    "version",
    "workspaceId",
    "providerType",
    "providerRoomId",
    "providerMetadata",
    "state",
    "diagnostics",
  ];
  const missing = required.filter((key) => !(key in mediaSession));
  if (missing.length > 0) {
    throw new Error(`invalid huddle media session model: missing ${missing.join(", ")}`);
  }
  return mediaSession;
}

export function mediaSessionModelFromRow(row = {}) {
  if (!row) return null;
  const model = createHuddleMediaSession({
    session: {
      id: row.session_id,
      workspace_id: row.workspace_id,
      state: row.state === "ended" ? "ended" : "live",
    },
    workspaceId: row.workspace_id,
    providerType: row.provider_type,
    providerMetadata: row.provider_metadata,
    diagnosticsMetadata: row.diagnostics,
  });

  return {
    ...model,
    mediaSessionId: row.id,
    providerRoomId: row.provider_room_id,
    providerRoomSid: row.provider_room_sid || null,
    state: row.state,
    selectedBy: row.selected_by || null,
    provisionedAt: row.provisioned_at || null,
    endedAt: row.ended_at || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    diagnostics: {
      ...model.diagnostics,
      ...(row.diagnostics || {}),
      providerType: row.provider_type,
      providerRoomId: row.provider_room_id,
      mediaSessionState: row.state,
      roomProvisioned: Boolean(row.provisioned_at),
      tokenIssuanceEnabled: false,
    },
  };
}

export async function findPersistentMediaSession({
  workspaceId,
  sessionId,
  providerType = HUDDLE_MEDIA_PROVIDERS.MESH,
  client = null,
}) {
  if (!workspaceId) throw new Error("workspaceId is required");
  if (!sessionId) throw new Error("sessionId is required");

  const { rows } = await runner(client).query(
    `
    SELECT *
    FROM huddle_media_sessions
    WHERE workspace_id = $1
      AND session_id = $2
      AND provider_type = $3
    LIMIT 1
    `,
    [workspaceId, sessionId, normalizeMediaProviderType(providerType)]
  );

  return mediaSessionModelFromRow(rows[0] || null);
}

export async function findLockedMediaSession({
  workspaceId,
  sessionId,
  client = null,
}) {
  if (!workspaceId) throw new Error("workspaceId is required");
  if (!sessionId) throw new Error("sessionId is required");

  const { rows } = await runner(client).query(
    `
    SELECT *
    FROM huddle_media_sessions
    WHERE workspace_id = $1
      AND session_id = $2
    ORDER BY
      CASE state
        WHEN 'active' THEN 0
        WHEN 'pending' THEN 1
        WHEN 'degraded' THEN 2
        WHEN 'failed' THEN 3
        WHEN 'ended' THEN 4
        ELSE 5
      END,
      created_at ASC
    LIMIT 1
    `,
    [workspaceId, sessionId]
  );

  const mediaSession = mediaSessionModelFromRow(rows[0] || null);
  if (!mediaSession) return null;
  return {
    ...mediaSession,
    providerLocked: true,
    providerLock: {
      locked: true,
      immutable: true,
      providerType: mediaSession.providerType,
      mediaSessionId: mediaSession.mediaSessionId,
      providerRoomId: mediaSession.providerRoomId,
      selectedBy: mediaSession.selectedBy,
      reason: mediaSession.diagnostics?.selectionReason || "provider_lock_inherited",
      fallbackReason: mediaSession.diagnostics?.fallbackReason || null,
    },
  };
}

async function withProviderLockTransaction({ workspaceId, sessionId, client = null }, fn) {
  if (client) {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `huddle-media-provider-lock:${workspaceId}:${sessionId}`,
    ]);
    return fn(client);
  }
  const tx = await pool.connect();
  try {
    await tx.query("BEGIN");
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `huddle-media-provider-lock:${workspaceId}:${sessionId}`,
    ]);
    const result = await fn(tx);
    await tx.query("COMMIT");
    return result;
  } catch (err) {
    await tx.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    tx.release();
  }
}

export async function createOrGetLockedMediaSession({
  session,
  workspaceId = null,
  providerSelection = null,
  providerType = null,
  providerRoomId = null,
  providerMetadata = {},
  diagnostics = {},
  selectedBy = "provider_lock",
  client = null,
}) {
  if (!session?.id) throw new Error("session.id is required");
  const resolvedWorkspaceId = workspaceId || session.workspace_id;
  if (!resolvedWorkspaceId) throw new Error("workspaceId is required");

  return withProviderLockTransaction({
    workspaceId: resolvedWorkspaceId,
    sessionId: session.id,
    client,
  }, async (tx) => {
    const existing = await findLockedMediaSession({
      workspaceId: resolvedWorkspaceId,
      sessionId: session.id,
      client: tx,
    });
    if (existing) {
      const requestedProvider =
        providerSelection?.selectedProvider ||
        providerSelection?.providerType ||
        providerType ||
        null;
      return {
        ok: true,
        inherited: true,
        mismatch:
          Boolean(requestedProvider) &&
          normalizeMediaProviderType(requestedProvider) !== existing.providerType,
        mediaSession: existing,
        providerType: existing.providerType,
        providerLock: existing.providerLock,
      };
    }

    const selectedProvider = normalizeMediaProviderType(
      providerSelection?.selectedProvider ||
      providerSelection?.providerType ||
      providerType ||
      HUDDLE_MEDIA_PROVIDERS.MESH
    );
    const mediaSession = await createOrGetPersistentMediaSession({
      session,
      workspaceId: resolvedWorkspaceId,
      providerType: selectedProvider,
      providerRoomId,
      providerMetadata,
      diagnostics: {
        ...diagnostics,
        selectionReason:
          providerSelection?.selectionReason ||
          providerSelection?.reason ||
          diagnostics.selectionReason ||
          "provider_lock_created",
        fallbackReason:
          providerSelection?.fallbackReason ||
          diagnostics.fallbackReason ||
          null,
        clientCapabilities: providerSelection?.clientCapabilities || null,
        providerLock: {
          locked: true,
          immutable: true,
          providerType: selectedProvider,
        },
      },
      selectedBy,
      client: tx,
    });

    return {
      ok: true,
      inherited: false,
      mismatch: false,
      mediaSession: {
        ...mediaSession,
        providerLocked: true,
        providerLock: {
          locked: true,
          immutable: true,
          providerType: selectedProvider,
          mediaSessionId: mediaSession.mediaSessionId,
          providerRoomId: mediaSession.providerRoomId,
          selectedBy,
          reason:
            providerSelection?.selectionReason ||
            providerSelection?.reason ||
            "provider_lock_created",
          fallbackReason: providerSelection?.fallbackReason || null,
        },
      },
      providerType: selectedProvider,
      providerLock: {
        locked: true,
        immutable: true,
        providerType: selectedProvider,
        mediaSessionId: mediaSession.mediaSessionId,
        providerRoomId: mediaSession.providerRoomId,
        selectedBy,
      },
    };
  });
}

export async function createOrGetPersistentMediaSession({
  session,
  workspaceId = null,
  providerType = HUDDLE_MEDIA_PROVIDERS.MESH,
  providerRoomId = null,
  providerMetadata = {},
  diagnostics = {},
  selectedBy = "provider_selector",
  client = null,
}) {
  if (!session?.id) throw new Error("session.id is required");
  const resolvedWorkspaceId = workspaceId || session.workspace_id;
  if (!resolvedWorkspaceId) throw new Error("workspaceId is required");

  const provider = normalizeMediaProviderType(providerType);
  const mediaSession = createHuddleMediaSession({
    session,
    workspaceId: resolvedWorkspaceId,
    providerType: provider,
    providerMetadata,
    diagnosticsMetadata: diagnostics,
  });
  const roomId = safeString(providerRoomId) || mediaSession.providerRoomId;
  const state = persistentStateFromModelState(mediaSession.state);

  const { rows } = await runner(client).query(
    `
    INSERT INTO huddle_media_sessions (
      workspace_id,
      session_id,
      provider_type,
      provider_room_id,
      state,
      selected_by,
      provider_metadata,
      diagnostics
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (session_id, provider_type)
    DO UPDATE SET
      provider_room_id = EXCLUDED.provider_room_id,
      provider_metadata = huddle_media_sessions.provider_metadata || EXCLUDED.provider_metadata,
      diagnostics = huddle_media_sessions.diagnostics || EXCLUDED.diagnostics,
      updated_at = now()
    RETURNING *
    `,
    [
      resolvedWorkspaceId,
      session.id,
      provider,
      roomId,
      state,
      selectedBy,
      json(mediaSession.providerMetadata.metadata),
      json({
        ...mediaSession.diagnostics,
        ...diagnostics,
        roomProvisioned: false,
        tokenIssuanceEnabled: false,
      }),
    ]
  );

  return mediaSessionModelFromRow(rows[0]);
}

export async function upsertMediaProviderIdentity({
  workspaceId,
  mediaSessionId,
  sessionId,
  participantId = null,
  deviceId = null,
  providerType = HUDDLE_MEDIA_PROVIDERS.MESH,
  providerIdentity,
  providerParticipantSid = null,
  identityKind = "workspace_user",
  userId = null,
  guestId = null,
  metadata = {},
  diagnostics = {},
  client = null,
}) {
  if (!workspaceId) throw new Error("workspaceId is required");
  if (!mediaSessionId) throw new Error("mediaSessionId is required");
  if (!sessionId) throw new Error("sessionId is required");
  if (!providerIdentity) throw new Error("providerIdentity is required");

  const provider = normalizeMediaProviderType(providerType);
  const { rows } = await runner(client).query(
    `
    INSERT INTO huddle_media_provider_identities (
      workspace_id,
      media_session_id,
      session_id,
      participant_id,
      device_id,
      provider_type,
      provider_identity,
      provider_participant_sid,
      identity_kind,
      user_id,
      guest_id,
      metadata,
      diagnostics,
      connected_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now())
    ON CONFLICT (workspace_id, provider_type, provider_identity)
    WHERE state = 'active'
    DO UPDATE SET
      media_session_id = EXCLUDED.media_session_id,
      session_id = EXCLUDED.session_id,
      participant_id = EXCLUDED.participant_id,
      device_id = EXCLUDED.device_id,
      provider_participant_sid = EXCLUDED.provider_participant_sid,
      metadata = huddle_media_provider_identities.metadata || EXCLUDED.metadata,
      diagnostics = huddle_media_provider_identities.diagnostics || EXCLUDED.diagnostics,
      updated_at = now()
    RETURNING *
    `,
    [
      workspaceId,
      mediaSessionId,
      sessionId,
      participantId,
      deviceId,
      provider,
      providerIdentity,
      providerParticipantSid,
      identityKind,
      userId,
      guestId,
      json(metadata),
      json({
        tokenIssued: false,
        roomProvisioned: false,
        ...diagnostics,
      }),
    ]
  );

  return rows[0] || null;
}

export async function findActiveMediaProviderIdentity({
  workspaceId,
  sessionId,
  providerType = HUDDLE_MEDIA_PROVIDERS.MESH,
  userId = null,
  deviceId = null,
  client = null,
}) {
  if (!workspaceId) throw new Error("workspaceId is required");
  if (!sessionId) throw new Error("sessionId is required");

  const provider = normalizeMediaProviderType(providerType);
  const values = [workspaceId, sessionId, provider];
  const predicates = [
    "workspace_id = $1",
    "session_id = $2",
    "provider_type = $3",
    "state = 'active'",
  ];

  if (userId) {
    values.push(userId);
    predicates.push(`user_id = $${values.length}`);
  }
  if (deviceId) {
    values.push(deviceId);
    predicates.push(`device_id = $${values.length}`);
  }

  const { rows } = await runner(client).query(
    `
    SELECT *
    FROM huddle_media_provider_identities
    WHERE ${predicates.join("\n      AND ")}
    ORDER BY connected_at DESC NULLS LAST, updated_at DESC
    LIMIT 1
    `,
    values
  );

  return rows[0] || null;
}

export async function endMediaSessionsForHuddleSession({
  workspaceId,
  sessionId,
  reason = "huddle_ended",
  endedAt = new Date(),
  client = null,
}) {
  if (!workspaceId) throw new Error("workspaceId is required");
  if (!sessionId) throw new Error("sessionId is required");

  const endedAtIso = endedAt instanceof Date
    ? endedAt.toISOString()
    : new Date(endedAt).toISOString();
  const diagnosticsPatch = {
    providerCleanup: {
      reason,
      endedAt: endedAtIso,
      source: "huddle:end",
    },
  };

  const identities = await runner(client).query(
    `
    UPDATE huddle_media_provider_identities
    SET
      state = 'inactive',
      disconnected_at = COALESCE(disconnected_at, $3::timestamptz),
      diagnostics = diagnostics || $4::jsonb,
      updated_at = now()
    WHERE workspace_id = $1
      AND session_id = $2
      AND state = 'active'
    RETURNING id
    `,
    [workspaceId, sessionId, endedAtIso, json(diagnosticsPatch)]
  );

  const sessions = await runner(client).query(
    `
    UPDATE huddle_media_sessions
    SET
      state = 'ended',
      ended_at = COALESCE(ended_at, $3::timestamptz),
      diagnostics = diagnostics || $4::jsonb,
      updated_at = now()
    WHERE workspace_id = $1
      AND session_id = $2
      AND state IN ('pending', 'active', 'degraded', 'failed')
    RETURNING *
    `,
    [workspaceId, sessionId, endedAtIso, json(diagnosticsPatch)]
  );

  return {
    mediaSessions: sessions.rows.map((row) => mediaSessionModelFromRow(row)),
    mediaSessionCount: sessions.rowCount || 0,
    providerIdentityCount: identities.rowCount || 0,
  };
}

function sanitizeQualityBrowser(raw = {}) {
  const browser = objectOrEmpty(raw);
  return {
    userAgent: boundedString(browser.userAgent, 240),
    platform: boundedString(browser.platform, 80),
    language: boundedString(browser.language, 40),
    viewportWidth: safeNumber(browser.viewportWidth),
    viewportHeight: safeNumber(browser.viewportHeight),
    screenWidth: safeNumber(browser.screenWidth),
    screenHeight: safeNumber(browser.screenHeight),
    devicePixelRatio: safeNumber(browser.devicePixelRatio),
  };
}

function sanitizeQualityAggregate(raw = {}) {
  const aggregate = objectOrEmpty(raw);
  const totalBitrateKbps = normalizeKbps(aggregate.totalBitrateKbps);
  const sendBitrateKbps = normalizeKbps(aggregate.sendBitrateKbps);
  const receiveBitrateKbps = normalizeKbps(aggregate.receiveBitrateKbps);
  return {
    participantCount: safeNumber(aggregate.participantCount, 0),
    trackCount: safeNumber(aggregate.trackCount, 0),
    videoTrackCount: safeNumber(aggregate.videoTrackCount, 0),
    audioTrackCount: safeNumber(aggregate.audioTrackCount, 0),
    screenShareTrackCount: safeNumber(aggregate.screenShareTrackCount, 0),
    averageRttMs: safeNumber(aggregate.averageRttMs),
    averagePacketLoss: safeNumber(aggregate.averagePacketLoss),
    totalBitrateKbps,
    sendBitrateKbps,
    receiveBitrateKbps,
    estimatedMegabytesPerHour: normalizeEstimatedMegabytesPerHour(
      aggregate.estimatedMegabytesPerHour,
      totalBitrateKbps
    ),
    maxSendWidth: safeNumber(aggregate.maxSendWidth),
    maxSendHeight: safeNumber(aggregate.maxSendHeight),
    maxReceiveWidth: safeNumber(aggregate.maxReceiveWidth),
    maxReceiveHeight: safeNumber(aggregate.maxReceiveHeight),
    maxScreenShareSendWidth: safeNumber(aggregate.maxScreenShareSendWidth),
    maxScreenShareSendHeight: safeNumber(aggregate.maxScreenShareSendHeight),
    maxScreenShareReceiveWidth: safeNumber(aggregate.maxScreenShareReceiveWidth),
    maxScreenShareReceiveHeight: safeNumber(aggregate.maxScreenShareReceiveHeight),
    maxRequestedReceiveWidth: safeNumber(aggregate.maxRequestedReceiveWidth),
    maxRequestedReceiveHeight: safeNumber(aggregate.maxRequestedReceiveHeight),
    maxRequestedContentReceiveWidth: safeNumber(aggregate.maxRequestedContentReceiveWidth),
    maxRequestedContentReceiveHeight: safeNumber(aggregate.maxRequestedContentReceiveHeight),
    renderTargetTrackCount: safeNumber(aggregate.renderTargetTrackCount, 0),
    renderTargetMismatchCount: safeNumber(aggregate.renderTargetMismatchCount, 0),
    screenShareSendBitrateKbps: normalizeKbps(aggregate.screenShareSendBitrateKbps),
    screenShareReceiveBitrateKbps: normalizeKbps(aggregate.screenShareReceiveBitrateKbps),
    adaptiveStreamAttachedTrackCount: safeNumber(aggregate.adaptiveStreamAttachedTrackCount, 0),
    selectedLowLayerCount: safeNumber(aggregate.selectedLowLayerCount, 0),
    selectedMediumLayerCount: safeNumber(aggregate.selectedMediumLayerCount, 0),
    selectedHighLayerCount: safeNumber(aggregate.selectedHighLayerCount, 0),
    freezeTrackCount: safeNumber(aggregate.freezeTrackCount, 0),
    freezeDeltaTrackCount: safeNumber(aggregate.freezeDeltaTrackCount, 0),
    totalFreezeCount: safeNumber(aggregate.totalFreezeCount),
    totalFreezeDurationSeconds: safeNumber(aggregate.totalFreezeDurationSeconds),
    totalFramesDropped: safeNumber(aggregate.totalFramesDropped),
    totalFramesDecoded: safeNumber(aggregate.totalFramesDecoded),
    totalFramesRendered: safeNumber(aggregate.totalFramesRendered),
    totalFreezeCountCumulative: safeNumber(aggregate.totalFreezeCountCumulative),
    totalFreezeDurationCumulativeSeconds: safeNumber(
      aggregate.totalFreezeDurationCumulativeSeconds
    ),
    totalFramesDroppedCumulative: safeNumber(aggregate.totalFramesDroppedCumulative),
    totalFramesDecodedCumulative: safeNumber(aggregate.totalFramesDecodedCumulative),
    totalFramesRenderedCumulative: safeNumber(aggregate.totalFramesRenderedCumulative),
    turnRelayTrackCount: safeNumber(aggregate.turnRelayTrackCount, 0),
    selectedCandidatePairCount: safeNumber(aggregate.selectedCandidatePairCount, 0),
    localRelayCandidateTrackCount: safeNumber(aggregate.localRelayCandidateTrackCount, 0),
    remoteRelayCandidateTrackCount: safeNumber(aggregate.remoteRelayCandidateTrackCount, 0),
  };
}

function sanitizeQualityStartup(raw = {}) {
  const startup = objectOrEmpty(raw);
  const tokenEndpointBackendTimings = objectOrEmpty(startup.tokenEndpointBackendTimings);
  return {
    joinMs: safeNumber(startup.joinMs),
    publishMs: safeNumber(startup.publishMs),
    subscribeMs: safeNumber(startup.subscribeMs),
    intentToJoinMs: safeNumber(startup.intentToJoinMs),
    firstAudioMs: safeNumber(startup.firstAudioMs),
    firstVideoMs: safeNumber(startup.firstVideoMs),
    firstRemoteParticipantMs: safeNumber(startup.firstRemoteParticipantMs),
    firstAudioAfterParticipantMs: safeNumber(
      startup.firstAudioAfterParticipantMs
    ),
    firstVideoAfterParticipantMs: safeNumber(
      startup.firstVideoAfterParticipantMs
    ),
    captionsActiveMs: safeNumber(startup.captionsActiveMs),
    firstCaptionMs: safeNumber(startup.firstCaptionMs),
    prepareLatencyMs: safeNumber(startup.prepareLatencyMs),
    sdkLoadLatencyMs: safeNumber(startup.sdkLoadLatencyMs),
    roomEndpointLatencyMs: safeNumber(startup.roomEndpointLatencyMs),
    tokenEndpointLatencyMs: safeNumber(startup.tokenEndpointLatencyMs),
    tokenEndpointBackendTimings: {
      endpointTotalMs: safeNumber(tokenEndpointBackendTimings.endpointTotalMs),
      authorizationMs: safeNumber(tokenEndpointBackendTimings.authorizationMs),
      tokenIssuanceMs: safeNumber(tokenEndpointBackendTimings.tokenIssuanceMs),
      identityPersistQueuedMs: safeNumber(tokenEndpointBackendTimings.identityPersistQueuedMs),
      authorizationTotalMs: safeNumber(tokenEndpointBackendTimings.authorizationTotalMs),
      scopeResolutionMs: safeNumber(tokenEndpointBackendTimings.scopeResolutionMs),
      durableSessionResolutionMs: safeNumber(tokenEndpointBackendTimings.durableSessionResolutionMs),
      providerLockLookupMs: safeNumber(tokenEndpointBackendTimings.providerLockLookupMs),
      providerSelectionMs: safeNumber(tokenEndpointBackendTimings.providerSelectionMs),
      providerLockAcquisitionMs: safeNumber(tokenEndpointBackendTimings.providerLockAcquisitionMs),
      providerLockInheritedWithoutWrite: safeBoolean(
        tokenEndpointBackendTimings.providerLockInheritedWithoutWrite
      ),
    },
    preconnectLatencyMs: safeNumber(startup.preconnectLatencyMs),
    preconnectInserted: safeBoolean(startup.preconnectInserted),
    connectLatencyMs: safeNumber(startup.connectLatencyMs),
    totalJoinLatencyMs: safeNumber(startup.totalJoinLatencyMs),
    captionGrantLatencyMs: safeNumber(startup.captionGrantLatencyMs),
    captionWebsocketOpenLatencyMs: safeNumber(startup.captionWebsocketOpenLatencyMs),
    captionRecorderStartLatencyMs: safeNumber(startup.captionRecorderStartLatencyMs),
    captionTransportReadyLatencyMs: safeNumber(startup.captionTransportReadyLatencyMs),
    captionTransportReadyFromIntentMs: safeNumber(startup.captionTransportReadyFromIntentMs),
    captionFirstProviderResultLatencyMs: safeNumber(startup.captionFirstProviderResultLatencyMs),
    captionFirstBackendEventLatencyMs: safeNumber(startup.captionFirstBackendEventLatencyMs),
    captionFirstLocalCaptionLatencyMs: safeNumber(startup.captionFirstLocalCaptionLatencyMs),
    captionFirstDeliveryLatencyMs: safeNumber(startup.captionFirstDeliveryLatencyMs),
    captionGrantCacheHit: Boolean(startup.captionGrantCacheHit),
    captionGrantSharedInFlight: Boolean(startup.captionGrantSharedInFlight),
    mediaPrewarmLatencyMs: safeNumber(startup.mediaPrewarmLatencyMs),
    mediaPrewarmOk: safeBoolean(startup.mediaPrewarmOk),
    mediaPrewarmTrackCount: safeNumber(startup.mediaPrewarmTrackCount),
  };
}

function sanitizeQualityParticipant(raw = {}) {
  const participant = objectOrEmpty(raw);
  return {
    participantId: boundedString(participant.participantId, 180),
    isLocal: safeBoolean(participant.isLocal),
    displayName: boundedString(participant.displayName, 80),
    connectionQuality: boundedString(participant.connectionQuality, 40),
    trackCount: safeNumber(participant.trackCount, 0),
    videoTrackCount: safeNumber(participant.videoTrackCount, 0),
    audioTrackCount: safeNumber(participant.audioTrackCount, 0),
    screenShareTrackCount: safeNumber(participant.screenShareTrackCount, 0),
    rttMs: safeNumber(participant.rttMs),
    packetLoss: safeNumber(participant.packetLoss),
    bitrateKbps: normalizeKbps(participant.bitrateKbps),
  };
}

function sanitizeQualitySenderEncoding(raw = {}) {
  const encoding = objectOrEmpty(raw);
  return {
    index: safeNumber(encoding.index),
    rid: boundedString(encoding.rid, 32),
    active: safeBoolean(encoding.active),
    scaleResolutionDownBy: safeNumber(encoding.scaleResolutionDownBy),
    maxBitrateKbps: safeNumber(encoding.maxBitrateKbps),
    maxFramerate: safeNumber(encoding.maxFramerate),
    scalabilityMode: boundedString(encoding.scalabilityMode, 60),
  };
}

function sanitizeQualityTrack(raw = {}) {
  const track = objectOrEmpty(raw);
  return {
    trackId: boundedString(track.trackId, 180),
    participantId: boundedString(track.participantId, 180),
    isLocal: safeBoolean(track.isLocal),
    kind: boundedString(track.kind, 32),
    source: boundedString(track.source, 40),
    direction: boundedString(track.direction, 24),
    publicationState: boundedString(track.publicationState, 40),
    subscriptionState: boundedString(track.subscriptionState, 40),
    isMuted: safeBoolean(track.isMuted),
    isSubscribed: safeBoolean(track.isSubscribed),
    width: safeNumber(track.width),
    height: safeNumber(track.height),
    framesPerSecond: safeNumber(track.framesPerSecond),
    mediaSourceWidth: safeNumber(track.mediaSourceWidth),
    mediaSourceHeight: safeNumber(track.mediaSourceHeight),
    mediaSourceFrameRate: safeNumber(track.mediaSourceFrameRate),
    mediaSourceFacingMode: boundedString(track.mediaSourceFacingMode, 40),
    mediaSourceResizeMode: boundedString(track.mediaSourceResizeMode, 40),
    mediaSourceDisplaySurface: boundedString(track.mediaSourceDisplaySurface, 40),
    mediaTrackContentHint: boundedString(track.mediaTrackContentHint, 80),
    bitrateKbps: normalizeKbps(track.bitrateKbps),
    availableOutgoingBitrateKbps: normalizeKbps(track.availableOutgoingBitrateKbps),
    availableIncomingBitrateKbps: normalizeKbps(track.availableIncomingBitrateKbps),
    rttMs: safeNumber(track.rttMs),
    packetLoss: safeNumber(track.packetLoss),
    packetsLost: safeNumber(track.packetsLost),
    packetsSent: safeNumber(track.packetsSent),
    packetsReceived: safeNumber(track.packetsReceived),
    bytesSent: safeNumber(track.bytesSent),
    bytesReceived: safeNumber(track.bytesReceived),
    framesDropped: safeNumber(track.framesDropped),
    framesDecoded: safeNumber(track.framesDecoded),
    framesRendered: safeNumber(track.framesRendered),
    freezeCount: safeNumber(track.freezeCount),
    totalFreezesDuration: safeNumber(track.totalFreezesDuration),
    framesDroppedDelta: safeNumber(track.framesDroppedDelta),
    framesDecodedDelta: safeNumber(track.framesDecodedDelta),
    framesRenderedDelta: safeNumber(track.framesRenderedDelta),
    freezeCountDelta: safeNumber(track.freezeCountDelta),
    totalFreezesDurationDelta: safeNumber(track.totalFreezesDurationDelta),
    pauseCount: safeNumber(track.pauseCount),
    totalPausesDuration: safeNumber(track.totalPausesDuration),
    pauseCountDelta: safeNumber(track.pauseCountDelta),
    totalPausesDurationDelta: safeNumber(track.totalPausesDurationDelta),
    codec: boundedString(track.codec, 80),
    mimeType: boundedString(track.mimeType, 80),
    rid: boundedString(track.rid, 32),
    scalabilityMode: boundedString(track.scalabilityMode, 60),
    simulcastLayer: boundedString(track.simulcastLayer, 40),
    streamState: boundedString(track.streamState, 40),
    videoQuality: boundedString(track.videoQuality, 40),
    senderEncodingCount: safeNumber(track.senderEncodingCount),
    senderActiveEncodingCount: safeNumber(track.senderActiveEncodingCount),
    senderEncodings: boundedArray(track.senderEncodings, 5).map(
      sanitizeQualitySenderEncoding
    ),
    qualityLimitationReason: boundedString(track.qualityLimitationReason, 60),
    publicationWidth: safeNumber(track.publicationWidth),
    publicationHeight: safeNumber(track.publicationHeight),
    renderedWidth: safeNumber(track.renderedWidth),
    renderedHeight: safeNumber(track.renderedHeight),
    requestedWidth: safeNumber(track.requestedWidth),
    requestedHeight: safeNumber(track.requestedHeight),
    requestedContentWidth: safeNumber(track.requestedContentWidth),
    requestedContentHeight: safeNumber(track.requestedContentHeight),
    requestedSourceWidth: safeNumber(track.requestedSourceWidth),
    requestedSourceHeight: safeNumber(track.requestedSourceHeight),
    requestedFramesPerSecond: safeNumber(track.requestedFramesPerSecond),
    requestedPixelRatio: safeNumber(track.requestedPixelRatio),
    renderTargetVisible:
      track.renderTargetVisible === null || track.renderTargetVisible === undefined
        ? null
        : safeBoolean(track.renderTargetVisible),
    attachedElementCount: safeNumber(track.attachedElementCount, 0),
    adaptiveStreamAttached: safeBoolean(track.adaptiveStreamAttached),
    currentBitrateKbps: safeNumber(track.currentBitrateKbps),
    selectedCandidatePairId: boundedString(track.selectedCandidatePairId, 120),
    candidatePairState: boundedString(track.candidatePairState, 40),
    candidatePairNominated: safeBoolean(track.candidatePairNominated),
    candidatePairSelected: safeBoolean(track.candidatePairSelected),
    localCandidateType: boundedString(track.localCandidateType, 40),
    remoteCandidateType: boundedString(track.remoteCandidateType, 40),
    localCandidateProtocol: boundedString(track.localCandidateProtocol, 40),
    remoteCandidateProtocol: boundedString(track.remoteCandidateProtocol, 40),
    localRelayProtocol: boundedString(track.localRelayProtocol, 40),
    remoteRelayProtocol: boundedString(track.remoteRelayProtocol, 40),
    localNetworkType: boundedString(track.localNetworkType, 40),
    usingTurnRelay: safeBoolean(track.usingTurnRelay),
  };
}

export function sanitizeLiveKitQualityDiagnostics(raw = {}) {
  const diagnostics = objectOrEmpty(raw);
  const tracks = boundedArray(diagnostics.tracks, 48).map(sanitizeQualityTrack);
  const participants = boundedArray(diagnostics.participants, 24).map(sanitizeQualityParticipant);
  return {
    observedAt: boundedString(diagnostics.observedAt, 40) || new Date().toISOString(),
    provider: HUDDLE_MEDIA_PROVIDERS.LIVEKIT,
    providerRoomId: boundedString(diagnostics.providerRoomId, 220),
    adaptiveStream: safeBoolean(diagnostics.adaptiveStream),
    dynacast: safeBoolean(diagnostics.dynacast),
    browser: sanitizeQualityBrowser(diagnostics.browser),
    startup: sanitizeQualityStartup(diagnostics.startup),
    aggregate: sanitizeQualityAggregate({
      ...diagnostics.aggregate,
      participantCount: diagnostics.aggregate?.participantCount ?? participants.length,
      trackCount: diagnostics.aggregate?.trackCount ?? tracks.length,
    }),
    participants,
    tracks,
  };
}

export async function recordLiveKitQualityDiagnostics({
  workspaceId,
  sessionId,
  providerRoomId = null,
  userId = null,
  deviceId = null,
  diagnostics = {},
  client = null,
}) {
  if (!workspaceId) throw new Error("workspaceId is required");
  if (!sessionId) throw new Error("sessionId is required");

  const sanitized = sanitizeLiveKitQualityDiagnostics({
    ...diagnostics,
    providerRoomId: providerRoomId || diagnostics.providerRoomId,
  });
  const observedAt = new Date().toISOString();
  const diagnosticsPatch = {
    liveKitQuality: sanitized,
    liveKitQualityUpdatedAt: observedAt,
  };

  const sessions = await runner(client).query(
    `
    UPDATE huddle_media_sessions
    SET
      diagnostics = COALESCE(diagnostics, '{}'::jsonb) || $3::jsonb,
      updated_at = now()
    WHERE workspace_id = $1
      AND session_id = $2
      AND provider_type = 'livekit'
    RETURNING id
    `,
    [workspaceId, sessionId, json(diagnosticsPatch)]
  );

  let providerIdentityCount = 0;
  let providerIdentityId = null;
  if (userId || deviceId) {
    const values = [workspaceId, sessionId, HUDDLE_MEDIA_PROVIDERS.LIVEKIT, json(diagnosticsPatch)];
    const predicates = [
      "workspace_id = $1",
      "session_id = $2",
      "provider_type = $3",
      "state = 'active'",
    ];
    if (userId) {
      values.push(userId);
      predicates.push(`user_id = $${values.length}`);
    }
    if (deviceId) {
      values.push(deviceId);
      predicates.push(`device_id = $${values.length}`);
    }

    const identities = await runner(client).query(
      `
      UPDATE huddle_media_provider_identities
      SET
        diagnostics = COALESCE(diagnostics, '{}'::jsonb) || $4::jsonb,
        updated_at = now()
      WHERE ${predicates.join("\n        AND ")}
      RETURNING id
      `,
      values
    );
    providerIdentityCount = identities.rowCount || 0;
    providerIdentityId = identities.rows[0]?.id || null;
  }

  const qualityObservedAt = Number.isNaN(new Date(sanitized.observedAt).getTime())
    ? observedAt
    : sanitized.observedAt;
  const sample = await runner(client).query(
    `
    INSERT INTO huddle_media_quality_samples (
      workspace_id,
      session_id,
      media_session_id,
      provider_identity_id,
      provider_type,
      provider_room_id,
      user_id,
      device_id,
      observed_at,
      aggregate,
      participants,
      tracks,
      browser,
      metadata
    )
    VALUES (
      $1,$2,$3,$4,'livekit',$5,$6,$7,$8,
      $9::jsonb,$10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb
    )
    RETURNING id
    `,
    [
      workspaceId,
      sessionId,
      sessions.rows[0]?.id || null,
      providerIdentityId,
      sanitized.providerRoomId,
      userId,
      deviceId,
      qualityObservedAt,
      json(sanitized.aggregate),
      JSON.stringify(sanitized.participants),
      JSON.stringify(sanitized.tracks),
      json(sanitized.browser),
      json({
        adaptiveStream: sanitized.adaptiveStream,
        dynacast: sanitized.dynacast,
        startup: sanitized.startup,
      }),
    ]
  );

  return {
    mediaSessionUpdated: (sessions.rowCount || 0) > 0,
    mediaSessionCount: sessions.rowCount || 0,
    providerIdentityCount,
    qualitySampleId: sample.rows[0]?.id || null,
    observedAt,
    summary: sanitized.aggregate,
  };
}

export async function listLiveKitQualitySamples({
  workspaceId,
  sessionId,
  actorUserId,
  role = "user",
  limit = 200,
  client = null,
}) {
  const access = await runner(client).query(
    `
    SELECT
      s.started_by,
      s.host_user_id,
      EXISTS (
        SELECT 1
        FROM huddle_session_participants p
        WHERE p.workspace_id = s.workspace_id
          AND p.session_id = s.id
          AND p.user_id = $3
      ) AS participated
    FROM huddle_sessions s
    WHERE s.workspace_id = $1
      AND s.id = $2
    LIMIT 1
    `,
    [workspaceId, sessionId, actorUserId]
  );
  const session = access.rows[0];
  if (!session) {
    const error = new Error("huddle_session_not_found");
    error.statusCode = 404;
    error.reason = "huddle_session_not_found";
    throw error;
  }
  const privileged = ["admin", "manager", "owner"].includes(String(role || "").toLowerCase());
  const host =
    String(session.started_by || "") === String(actorUserId || "") ||
    String(session.host_user_id || "") === String(actorUserId || "");
  if (!privileged && !host && !session.participated) {
    const error = new Error("huddle_quality_access_denied");
    error.statusCode = 403;
    error.reason = "huddle_quality_access_denied";
    throw error;
  }
  const { rows } = await runner(client).query(
    `
    SELECT
      id,
      workspace_id,
      session_id,
      media_session_id,
      provider_identity_id,
      provider_type,
      provider_room_id,
      user_id,
      device_id,
      observed_at,
      aggregate,
      participants,
      tracks,
      browser,
      metadata,
      created_at
    FROM huddle_media_quality_samples
    WHERE workspace_id = $1
      AND session_id = $2
      AND provider_type = 'livekit'
    ORDER BY observed_at DESC, created_at DESC
    LIMIT $3
    `,
    [workspaceId, sessionId, Math.min(Math.max(Number(limit) || 200, 1), 1000)]
  );
  return rows.map((row) => ({
    id: row.id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    mediaSessionId: row.media_session_id,
    providerIdentityId: row.provider_identity_id,
    provider: row.provider_type,
    providerRoomId: row.provider_room_id,
    userId: row.user_id,
    deviceId: row.device_id,
    observedAt: row.observed_at,
    aggregate: row.aggregate || {},
    participants: row.participants || [],
    tracks: row.tracks || [],
    browser: row.browser || {},
    metadata: row.metadata || {},
    createdAt: row.created_at,
  }));
}

function finiteValues(values) {
  return values.map(Number).filter(Number.isFinite);
}

function average(values) {
  const numbers = finiteValues(values);
  if (!numbers.length) return null;
  return Number(
    (numbers.reduce((total, value) => total + value, 0) / numbers.length).toFixed(2)
  );
}

function positiveAverage(values) {
  const numbers = finiteValues(values).filter((value) => value > 0);
  if (!numbers.length) return null;
  return Number(
    (numbers.reduce((total, value) => total + value, 0) / numbers.length).toFixed(2)
  );
}

function uniqueStrings(values) {
  return [...new Set(values.map((value) => boundedString(value, 80)).filter(Boolean))];
}

export function summarizeLiveKitQualitySamples(samples = []) {
  const ordered = [...samples].sort(
    (left, right) =>
      new Date(left.observedAt || 0).getTime() -
      new Date(right.observedAt || 0).getTime()
  );
  const realDeviceSamples = ordered.filter(
    (sample) => !/HeadlessChrome/i.test(sample.browser?.userAgent || "")
  );
  const source = realDeviceSamples.length ? realDeviceSamples : ordered;
  const aggregates = source.map((sample) => sample.aggregate || {});
  const startupSamples = source.map((sample) => sample.metadata?.startup || {});
  const tracks = source.flatMap((sample) => sample.tracks || []);
  const receiveVideo = tracks.filter(
    (track) => track.kind === "video" && track.direction === "receive"
  );
  const sendVideo = tracks.filter(
    (track) => track.kind === "video" && track.direction === "send"
  );
  const screenShare = tracks.filter((track) => track.source === "screen");
  const targetedReceiveVideo = receiveVideo.filter(
    (track) => Number(track.requestedWidth) > 0 && Number(track.requestedHeight) > 0
  );
  const averageSendFps = average(sendVideo.map((track) => track.framesPerSecond));
  const averageReceiveFps = average(
    receiveVideo.map((track) => track.framesPerSecond)
  );
  const averageSendMediaSourceFps = average(
    sendVideo.map((track) => track.mediaSourceFrameRate)
  );
  const averageReceiveMediaSourceFps = average(
    receiveVideo.map((track) => track.mediaSourceFrameRate)
  );
  const videoCodecs = uniqueStrings(
    tracks
      .filter((track) => track.kind === "video")
      .map((track) => track.codec)
  );
  const qualityLimitationReasons = tracks.reduce((counts, track) => {
    const reason = boundedString(track.qualityLimitationReason, 60);
    if (reason && reason !== "none") {
      counts[reason] = (counts[reason] || 0) + 1;
    }
    return counts;
  }, {});
  const averageRttMs = average(aggregates.map((item) => item.averageRttMs));
  const averagePacketLoss = average(
    aggregates.map((item) => item.averagePacketLoss)
  );
  const averageBitrateKbps = average(
    aggregates.map((item) => item.totalBitrateKbps)
  );
  const averageSendBitrateKbps =
    average(aggregates.map((item) => item.sendBitrateKbps)) ??
    average(sendVideo.map((track) => track.bitrateKbps));
  const averageReceiveBitrateKbps =
    average(aggregates.map((item) => item.receiveBitrateKbps)) ??
    average(receiveVideo.map((track) => track.bitrateKbps));
  const estimatedMegabytesPerHour =
    average(aggregates.map((item) => item.estimatedMegabytesPerHour)) ??
    (averageBitrateKbps === null
      ? null
      : Number(((averageBitrateKbps * 3600) / 8 / 1000).toFixed(2)));
  const maxReceiveWidth = Math.max(
    0,
    ...finiteValues(receiveVideo.map((track) => track.width))
  ) || null;
  const maxReceiveHeight = Math.max(
    0,
    ...finiteValues(
      receiveVideo
        .filter((track) => Number(track.width) === maxReceiveWidth)
        .map((track) => track.height)
    )
  ) || null;
  const maxReceiveLongEdge =
    maxReceiveWidth && maxReceiveHeight
      ? Math.max(maxReceiveWidth, maxReceiveHeight)
      : null;
  const maxReceiveShortEdge =
    maxReceiveWidth && maxReceiveHeight
      ? Math.min(maxReceiveWidth, maxReceiveHeight)
      : null;
  const maxSendWidth = Math.max(
    0,
    ...finiteValues(sendVideo.map((track) => track.width))
  ) || null;
  const maxSendHeight = Math.max(
    0,
    ...finiteValues(
      sendVideo
        .filter((track) => Number(track.width) === maxSendWidth)
        .map((track) => track.height)
    )
  ) || null;
  const renderTargetTrackCount = aggregates.reduce(
    (total, item) => total + (Number(item.renderTargetTrackCount) || 0),
    0
  );
  const renderTargetMismatchCount = aggregates.reduce(
    (total, item) => total + (Number(item.renderTargetMismatchCount) || 0),
    0
  );
  const renderTargetMatchRate = renderTargetTrackCount
    ? Number(
        (
          (renderTargetTrackCount - renderTargetMismatchCount) /
          renderTargetTrackCount
        ).toFixed(4)
      )
    : null;
  const averageRequestedReceiveWidth = average(
    targetedReceiveVideo.map((track) => track.requestedWidth)
  );
  const averageRequestedReceiveHeight = average(
    targetedReceiveVideo.map((track) => track.requestedHeight)
  );
  const averageRequestedContentReceiveWidth = average(
    targetedReceiveVideo.map((track) => track.requestedContentWidth)
  );
  const averageRequestedContentReceiveHeight = average(
    targetedReceiveVideo.map((track) => track.requestedContentHeight)
  );
  const visibleTargetWidth =
    averageRequestedContentReceiveWidth ?? averageRequestedReceiveWidth;
  const visibleTargetHeight =
    averageRequestedContentReceiveHeight ?? averageRequestedReceiveHeight;
  const visibleTargetLongEdge =
    visibleTargetWidth && visibleTargetHeight
      ? Math.max(visibleTargetWidth, visibleTargetHeight)
      : null;
  const visibleTargetShortEdge =
    visibleTargetWidth && visibleTargetHeight
      ? Math.min(visibleTargetWidth, visibleTargetHeight)
      : null;
  const renderTargetSatisfied =
    renderTargetMatchRate !== null && renderTargetMatchRate >= 0.9;
  const maxAggregateNumber = (key) =>
    Math.max(0, ...finiteValues(aggregates.map((item) => item[key]))) || 0;
  const totalFreezeCount = maxAggregateNumber("totalFreezeCount");
  const totalFreezeDurationSeconds = Number(
    maxAggregateNumber("totalFreezeDurationSeconds").toFixed(3)
  );
  const totalFramesDropped = maxAggregateNumber("totalFramesDropped");
  const totalFramesDecoded = maxAggregateNumber("totalFramesDecoded");
  const totalFramesRendered = maxAggregateNumber("totalFramesRendered");
  const totalFreezeCountCumulative = maxAggregateNumber("totalFreezeCountCumulative");
  const totalFreezeDurationCumulativeSeconds = Number(
    maxAggregateNumber("totalFreezeDurationCumulativeSeconds").toFixed(3)
  );
  const turnRelayTrackCount = maxAggregateNumber("turnRelayTrackCount");
  const selectedCandidatePairCount = maxAggregateNumber("selectedCandidatePairCount");
  const localRelayCandidateTrackCount = maxAggregateNumber("localRelayCandidateTrackCount");
  const remoteRelayCandidateTrackCount = maxAggregateNumber("remoteRelayCandidateTrackCount");
  const candidateTypes = tracks.reduce((counts, track) => {
    const localType = boundedString(track.localCandidateType, 40);
    const remoteType = boundedString(track.remoteCandidateType, 40);
    const key = localType || remoteType ? `${localType || "unknown"}:${remoteType || "unknown"}` : null;
    if (key) counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
  const receiveBelowVisibleTarget =
    visibleTargetLongEdge !== null &&
    maxReceiveLongEdge !== null &&
    maxReceiveLongEdge < visibleTargetLongEdge * 0.9;
  const receiveBelowMinimum =
    maxReceiveLongEdge !== null &&
    maxReceiveLongEdge < 640 &&
    (visibleTargetLongEdge === null || receiveBelowVisibleTarget);
  const receiveBelowHdExpectation =
    maxReceiveLongEdge !== null &&
    maxReceiveLongEdge < 720 &&
    (visibleTargetLongEdge === null || visibleTargetLongEdge >= 720);
  const receiveShortBelowVisibleTarget =
    visibleTargetShortEdge !== null &&
    maxReceiveShortEdge !== null &&
    maxReceiveShortEdge < visibleTargetShortEdge * 0.9;
  const lowBitrateActionable =
    averageBitrateKbps !== null &&
    averageBitrateKbps < 350 &&
    (!renderTargetSatisfied ||
      averageReceiveFps === null ||
      averageReceiveFps < 18 ||
      totalFreezeCount > 0 ||
      Boolean(qualityLimitationReasons.bandwidth));
  let score = source.length ? 100 : 0;
  const observations = [];
  if (!realDeviceSamples.length && ordered.length) {
    observations.push("Only synthetic browser telemetry is available");
  }
  if (averageRttMs !== null && averageRttMs > 300) {
    score -= 25;
    observations.push("Round-trip latency is above 300 ms");
  } else if (averageRttMs !== null && averageRttMs > 180) {
    score -= 12;
    observations.push("Round-trip latency is elevated");
  }
  if (averagePacketLoss !== null && averagePacketLoss > 0.05) {
    score -= 30;
    observations.push("Packet loss is above 5%");
  } else if (averagePacketLoss !== null && averagePacketLoss > 0.02) {
    score -= 15;
    observations.push("Packet loss is above 2%");
  }
  if (receiveBelowMinimum) {
    score -= 20;
    observations.push("Received video never exceeded 640 px");
  } else if (receiveBelowVisibleTarget) {
    score -= 12;
    observations.push("Received video remained below the visible tile target");
  } else if (receiveBelowHdExpectation) {
    score -= 8;
    observations.push("Received video did not reach 720p");
  }
  if (averageReceiveFps !== null && averageReceiveFps < 24) {
    score -= averageReceiveFps < 18 ? 15 : 8;
    observations.push("Received video frame rate remained below 24 fps");
  }
  if (lowBitrateActionable) {
    score -= 15;
    observations.push("Observed aggregate bitrate is low");
  }
  if (
    estimatedMegabytesPerHour !== null &&
    estimatedMegabytesPerHour > 750
  ) {
    score -= 15;
    observations.push("Estimated media data usage is unusually high");
  }
  if (receiveVideo.length && !receiveVideo.some((track) => track.adaptiveStreamAttached)) {
    score -= 15;
    observations.push("Remote video was not attached through LiveKit adaptive streaming");
  }
  if (renderTargetMatchRate !== null && renderTargetMatchRate < 0.8) {
    score -= 15;
    observations.push(
      "Received video frequently remained below the dimensions requested by visible tiles"
    );
  }
  if (totalFreezeCount > 0) {
    score -= Math.min(
      20,
      Math.max(5, Math.ceil(totalFreezeDurationSeconds || totalFreezeCount / 2))
    );
    observations.push("Receiver reported decoded video freezes");
  }
  if (qualityLimitationReasons.bandwidth) {
    score -= 10;
    observations.push(
      `Bandwidth limited ${qualityLimitationReasons.bandwidth} video track samples`
    );
  }
  const connectionScore = Math.max(
    0,
    100 -
      (averageRttMs > 300 ? 35 : averageRttMs > 180 ? 15 : 0) -
      (averagePacketLoss > 0.05 ? 40 : averagePacketLoss > 0.02 ? 20 : 0)
  );
  const videoScore = Math.max(
    0,
    100 -
      (receiveBelowMinimum ? 30 : receiveBelowVisibleTarget ? 15 : receiveBelowHdExpectation ? 10 : 0) -
      (receiveShortBelowVisibleTarget ||
      (visibleTargetShortEdge === null &&
        maxReceiveShortEdge !== null &&
        maxReceiveShortEdge < 360)
        ? 10
        : 0) -
      (averageReceiveFps !== null && averageReceiveFps < 24 ? 10 : 0) -
      (lowBitrateActionable ? 25 : 0) -
      (receiveVideo.length &&
      !receiveVideo.some((track) => track.adaptiveStreamAttached)
        ? 20
        : 0) -
      (renderTargetMatchRate !== null && renderTargetMatchRate < 0.8 ? 20 : 0) -
      (totalFreezeCount > 0
        ? Math.min(
            25,
            Math.max(8, Math.ceil(totalFreezeDurationSeconds || totalFreezeCount / 2))
          )
        : 0) -
      (qualityLimitationReasons.bandwidth ? 10 : 0) -
      (averagePacketLoss > 0.05 ? 25 : averagePacketLoss > 0.02 ? 10 : 0)
  );
  const audioTracks = tracks.filter((track) => track.kind === "audio");
  const audioPacketLoss = average(audioTracks.map((track) => track.packetLoss));
  const audioScore = Math.max(
    0,
    100 -
      (audioPacketLoss > 0.05 ? 45 : audioPacketLoss > 0.02 ? 20 : 0) -
      (averageRttMs > 300 ? 25 : averageRttMs > 180 ? 10 : 0)
  );
  return {
    ready: realDeviceSamples.length > 0,
    score: Math.max(0, Math.min(100, score)),
    rating:
      score >= 85 ? "excellent" : score >= 70 ? "good" : score >= 50 ? "degraded" : "poor",
    scores: {
      overall: Math.max(0, Math.min(100, score)),
      video: videoScore,
      audio: audioScore,
      connection: connectionScore,
    },
    sampleCount: ordered.length,
    realDeviceSampleCount: realDeviceSamples.length,
    syntheticSampleCount: ordered.length - realDeviceSamples.length,
    observedFrom: source[0]?.observedAt || null,
    observedTo: source.at(-1)?.observedAt || null,
    metrics: {
      averageRttMs,
      averagePacketLoss,
      averageBitrateKbps,
      averageSendBitrateKbps,
      averageReceiveBitrateKbps,
      averageSendFps,
      averageReceiveFps,
      averageSendMediaSourceFps,
      averageReceiveMediaSourceFps,
      videoCodecs,
      qualityLimitationReasons,
      estimatedMegabytesPerHour,
      averageIntentToJoinMs: positiveAverage(
        startupSamples.map((item) => item.intentToJoinMs)
      ),
      averageJoinMs: positiveAverage(startupSamples.map((item) => item.joinMs)),
      averagePublishMs: positiveAverage(startupSamples.map((item) => item.publishMs)),
      averageMediaPrewarmLatencyMs: positiveAverage(
        startupSamples.map((item) => item.mediaPrewarmLatencyMs)
      ),
      mediaPrewarmSuccessCount: startupSamples.filter((item) => item.mediaPrewarmOk).length,
      averagePrepareLatencyMs: positiveAverage(
        startupSamples.map((item) => item.prepareLatencyMs)
      ),
      averageRoomEndpointLatencyMs: positiveAverage(
        startupSamples.map((item) => item.roomEndpointLatencyMs)
      ),
      averageTokenEndpointLatencyMs: positiveAverage(
        startupSamples.map((item) => item.tokenEndpointLatencyMs)
      ),
      averageConnectLatencyMs: positiveAverage(
        startupSamples.map((item) => item.connectLatencyMs)
      ),
      averageTotalJoinLatencyMs: positiveAverage(
        startupSamples.map((item) => item.totalJoinLatencyMs)
      ),
      averageFirstAudioMs: positiveAverage(
        startupSamples.map((item) => item.firstAudioMs)
      ),
      averageFirstVideoMs: positiveAverage(
        startupSamples.map((item) => item.firstVideoMs)
      ),
      averageFirstRemoteParticipantMs: positiveAverage(
        startupSamples.map((item) => item.firstRemoteParticipantMs)
      ),
      averageFirstAudioAfterParticipantMs: positiveAverage(
        startupSamples.map((item) => item.firstAudioAfterParticipantMs)
      ),
      averageFirstVideoAfterParticipantMs: positiveAverage(
        startupSamples.map((item) => item.firstVideoAfterParticipantMs)
      ),
      averageCaptionsActiveMs: positiveAverage(
        startupSamples.map((item) => item.captionsActiveMs)
      ),
      averageFirstCaptionMs: positiveAverage(
        startupSamples.map((item) => item.firstCaptionMs)
      ),
      averageCaptionTransportReadyMs: positiveAverage(
        startupSamples.map((item) => item.captionTransportReadyLatencyMs)
      ),
      averageCaptionTransportReadyFromIntentMs: positiveAverage(
        startupSamples.map((item) => item.captionTransportReadyFromIntentMs)
      ),
      averageCaptionGrantMs: positiveAverage(
        startupSamples.map((item) => item.captionGrantLatencyMs)
      ),
      averageCaptionWebsocketOpenMs: positiveAverage(
        startupSamples.map((item) => item.captionWebsocketOpenLatencyMs)
      ),
      averageCaptionRecorderStartMs: positiveAverage(
        startupSamples.map((item) => item.captionRecorderStartLatencyMs)
      ),
      averageCaptionFirstProviderResultMs: positiveAverage(
        startupSamples.map((item) => item.captionFirstProviderResultLatencyMs)
      ),
      averageCaptionFirstBackendEventMs: positiveAverage(
        startupSamples.map((item) => item.captionFirstBackendEventLatencyMs)
      ),
      averageCaptionFirstLocalCaptionMs: positiveAverage(
        startupSamples.map((item) => item.captionFirstLocalCaptionLatencyMs)
      ),
      averageCaptionFirstDeliveryMs: positiveAverage(
        startupSamples.map((item) => item.captionFirstDeliveryLatencyMs)
      ),
      captionGrantCacheHitCount: startupSamples.filter((item) => item.captionGrantCacheHit).length,
      captionGrantSharedInFlightCount: startupSamples.filter(
        (item) => item.captionGrantSharedInFlight
      ).length,
      renderTargetTrackCount,
      renderTargetMismatchCount,
      renderTargetMatchRate,
      averageRequestedReceiveWidth,
      averageRequestedReceiveHeight,
      averageRequestedContentReceiveWidth,
      averageRequestedContentReceiveHeight,
      averageScreenShareSendBitrateKbps: average(
        aggregates.map((item) => item.screenShareSendBitrateKbps)
      ),
      averageScreenShareReceiveBitrateKbps: average(
        aggregates.map((item) => item.screenShareReceiveBitrateKbps)
      ),
      maxSendResolution:
        maxSendWidth && maxSendHeight ? `${maxSendWidth}x${maxSendHeight}` : null,
      maxReceiveResolution:
        maxReceiveWidth && maxReceiveHeight
          ? `${maxReceiveWidth}x${maxReceiveHeight}`
          : null,
      maxReceiveLongEdge,
      maxReceiveShortEdge,
      totalFreezeCount,
      totalFreezeDurationSeconds,
      totalFreezeCountCumulative,
      totalFreezeDurationCumulativeSeconds,
      totalFramesDropped,
      totalFramesDecoded,
      totalFramesRendered,
      turnRelayTrackCount,
      selectedCandidatePairCount,
      localRelayCandidateTrackCount,
      remoteRelayCandidateTrackCount,
      candidateTypes,
      sendVideoTrackCount: sendVideo.length,
      receiveVideoTrackCount: receiveVideo.length,
      screenShareTrackCount: screenShare.length,
      lowLayerSamples: aggregates.reduce(
        (total, item) => total + (Number(item.selectedLowLayerCount) || 0),
        0
      ),
      mediumLayerSamples: aggregates.reduce(
        (total, item) => total + (Number(item.selectedMediumLayerCount) || 0),
        0
      ),
      highLayerSamples: aggregates.reduce(
        (total, item) => total + (Number(item.selectedHighLayerCount) || 0),
        0
      ),
    },
    observations,
  };
}

export function getMediaReadinessDiagnostics({
  providerSelection = null,
  mediaSession = null,
  roomDiagnostics = null,
  tokenDiagnostics = null,
} = {}) {
  const sessionDiagnostics = getMediaSessionDiagnostics(mediaSession);
  return {
    providerType:
      providerSelection?.providerType ||
      mediaSession?.providerType ||
      HUDDLE_MEDIA_PROVIDERS.MESH,
    providerReadiness: providerSelection?.providerReadiness || {
      mesh: { modeled: true, enabled: true, active: true },
      livekit: {
        providerType: HUDDLE_MEDIA_PROVIDERS.LIVEKIT,
        modeled: true,
        enabled: false,
        active: false,
        sdk: {
          available: false,
          status: "not_installed",
        },
        token: {
          ready: false,
          status: "disabled",
          issuanceEnabled: false,
        },
        room: {
          ready: false,
          state: HUDDLE_MEDIA_SESSION_STATES.IDLE,
          providerRoomId: null,
          provisioned: false,
          provisioningEnabled: false,
        },
        participants: {
          ready: false,
          mappingReady: true,
          count: 0,
        },
        tracks: {
          ready: false,
          mappingReady: true,
          count: 0,
          cameraTrackCount: 0,
          microphoneTrackCount: 0,
          screenShareTrackCount: 0,
        },
        reason: "livekit_foundation_model_only",
      },
    },
    mediaSessionState: sessionDiagnostics.mediaSessionState,
    providerRoomId: sessionDiagnostics.providerRoomId || null,
    roomProvisioningStatus: roomDiagnostics?.readiness?.state || "disabled",
    roomProvisioned: false,
    tokenStatus: tokenDiagnostics?.status?.status || "disabled",
    tokenIssuanceEnabled: false,
    observedAt: new Date().toISOString(),
  };
}

export default {
  HUDDLE_MEDIA_SESSION_MODEL_VERSION,
  HUDDLE_MEDIA_PROVIDERS,
  HUDDLE_MEDIA_SESSION_STATES,
  HUDDLE_MEDIA_METADATA_STATUSES,
  getDefaultMediaProviderType,
  normalizeMediaProviderType,
  isMediaProviderImplemented,
  buildProviderRoomIdentity,
  sanitizeProviderMetadata,
  getProviderMetadataStatus,
  createMediaSessionDiagnostics,
  createHuddleMediaSession,
  getMediaSessionDiagnostics,
  assertHuddleMediaSessionModel,
  mediaSessionModelFromRow,
  findPersistentMediaSession,
  findLockedMediaSession,
  createOrGetLockedMediaSession,
  createOrGetPersistentMediaSession,
  upsertMediaProviderIdentity,
  findActiveMediaProviderIdentity,
  endMediaSessionsForHuddleSession,
  sanitizeLiveKitQualityDiagnostics,
  recordLiveKitQualityDiagnostics,
  listLiveKitQualitySamples,
  summarizeLiveKitQualitySamples,
  getMediaReadinessDiagnostics,
};
