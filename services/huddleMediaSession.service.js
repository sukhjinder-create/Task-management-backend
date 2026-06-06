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
        ...diagnostics,
        tokenIssued: false,
        roomProvisioned: false,
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
  getMediaReadinessDiagnostics,
};
