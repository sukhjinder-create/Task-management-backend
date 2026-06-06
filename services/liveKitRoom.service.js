import {
  HUDDLE_MEDIA_PROVIDERS,
  HUDDLE_MEDIA_SESSION_STATES,
  buildProviderRoomIdentity,
  createMediaSessionDiagnostics,
  getProviderMetadataStatus,
  sanitizeProviderMetadata,
} from "./huddleMediaSession.service.js";

export const LIVEKIT_ROOM_SERVICE_STATES = Object.freeze({
  NOT_CONFIGURED: "not_configured",
  MODELED: "modeled",
  DISABLED: "disabled",
});

export const LIVEKIT_ROOM_STATES = Object.freeze({
  DISABLED: "disabled",
  MODELED: "modeled",
  IDLE: "idle",
  ACTIVE: "active",
  ENDED: "ended",
  FAILED: "failed",
});

export const LIVEKIT_READINESS_STATES = Object.freeze({
  MODELED: "modeled",
  DISABLED: "disabled",
  NOT_INSTALLED: "not_installed",
  NOT_READY: "not_ready",
});

export const LIVEKIT_IDENTITY_KINDS = Object.freeze({
  WORKSPACE_USER: "workspace_user",
  GUEST: "guest",
  AI_AGENT: "ai_agent",
  SYSTEM: "system",
  UNKNOWN: "unknown",
});

export const LIVEKIT_TRACK_KINDS = Object.freeze({
  AUDIO: "audio",
  VIDEO: "video",
});

export const LIVEKIT_TRACK_SOURCES = Object.freeze({
  MICROPHONE: "microphone",
  CAMERA: "camera",
  SCREEN_SHARE: "screen_share",
});

export const LIVEKIT_PUBLICATION_STATES = Object.freeze({
  UNPUBLISHED: "unpublished",
  PUBLISHING: "publishing",
  PUBLISHED: "published",
  FAILED: "failed",
});

export const LIVEKIT_SUBSCRIPTION_STATES = Object.freeze({
  UNSUBSCRIBED: "unsubscribed",
  SUBSCRIBING: "subscribing",
  SUBSCRIBED: "subscribed",
  FAILED: "failed",
});

const SAFE_IDENTITY_KINDS = new Set(Object.values(LIVEKIT_IDENTITY_KINDS));
const SAFE_TRACK_KINDS = new Set(Object.values(LIVEKIT_TRACK_KINDS));
const SAFE_TRACK_SOURCES = new Set(Object.values(LIVEKIT_TRACK_SOURCES));
const SAFE_PUBLICATION_STATES = new Set(Object.values(LIVEKIT_PUBLICATION_STATES));
const SAFE_SUBSCRIPTION_STATES = new Set(Object.values(LIVEKIT_SUBSCRIPTION_STATES));

function safeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isEnabled(value) {
  return safeString(value).toLowerCase() === "true";
}

function splitCsv(value) {
  return safeString(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function safeBoolean(value) {
  return value === true;
}

function objectOrEmpty(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value;
}

function safeIdentityKind({ identityKind = null, userId = null, guestId = null } = {}) {
  const normalized = safeString(identityKind).toLowerCase();
  if (SAFE_IDENTITY_KINDS.has(normalized)) return normalized;
  if (safeString(userId)) return LIVEKIT_IDENTITY_KINDS.WORKSPACE_USER;
  if (safeString(guestId)) return LIVEKIT_IDENTITY_KINDS.GUEST;
  return LIVEKIT_IDENTITY_KINDS.UNKNOWN;
}

function safeTrackKind(kind, source) {
  const normalized = safeString(kind).toLowerCase();
  if (SAFE_TRACK_KINDS.has(normalized)) return normalized;
  return source === LIVEKIT_TRACK_SOURCES.MICROPHONE
    ? LIVEKIT_TRACK_KINDS.AUDIO
    : LIVEKIT_TRACK_KINDS.VIDEO;
}

function safeTrackSource(source, kind) {
  const normalized = safeString(source).toLowerCase();
  if (SAFE_TRACK_SOURCES.has(normalized)) return normalized;
  return safeString(kind).toLowerCase() === LIVEKIT_TRACK_KINDS.AUDIO
    ? LIVEKIT_TRACK_SOURCES.MICROPHONE
    : LIVEKIT_TRACK_SOURCES.CAMERA;
}

function safePublicationState(state) {
  const normalized = safeString(state).toLowerCase();
  return SAFE_PUBLICATION_STATES.has(normalized)
    ? normalized
    : LIVEKIT_PUBLICATION_STATES.UNPUBLISHED;
}

function safeSubscriptionState(state) {
  const normalized = safeString(state).toLowerCase();
  return SAFE_SUBSCRIPTION_STATES.has(normalized)
    ? normalized
    : LIVEKIT_SUBSCRIPTION_STATES.UNSUBSCRIBED;
}

function sanitizeLiveKitRoomMetadata(metadata = {}) {
  const sanitized = sanitizeProviderMetadata(
    HUDDLE_MEDIA_PROVIDERS.LIVEKIT,
    metadata
  );
  return {
    roomName: safeString(sanitized.roomName) || null,
    roomSid: safeString(sanitized.roomSid) || null,
    region: safeString(sanitized.region) || null,
    egressEnabled: safeBoolean(sanitized.egressEnabled),
    ingressEnabled: safeBoolean(sanitized.ingressEnabled),
    recordingEnabled: safeBoolean(sanitized.recordingEnabled),
    transcriptionEnabled: safeBoolean(sanitized.transcriptionEnabled),
  };
}

export function getLiveKitRoomEndpointConfig({
  env = process.env,
  workspaceId = null,
} = {}) {
  const workspaceAllowlist = splitCsv(env.HUDDLE_LIVEKIT_CANARY_WORKSPACES);
  const canaryEnabled = isEnabled(env.HUDDLE_LIVEKIT_CANARY_ENABLED);
  const roomEndpointEnabled = isEnabled(env.HUDDLE_LIVEKIT_ROOM_ENDPOINT_ENABLED);
  const connectivityEnabled = isEnabled(env.HUDDLE_LIVEKIT_CANARY_CONNECTIVITY_ENABLED);
  const workspaceAllowed =
    canaryEnabled &&
    (workspaceAllowlist.includes("*") ||
      (Boolean(workspaceId) && workspaceAllowlist.includes(String(workspaceId))));
  const liveKitUrl = safeString(env.LIVEKIT_URL);

  return {
    providerType: HUDDLE_MEDIA_PROVIDERS.LIVEKIT,
    canaryEnabled,
    roomEndpointEnabled,
    connectivityEnabled,
    workspaceId: workspaceId || null,
    workspaceAllowed,
    workspaceAllowlistCount: workspaceAllowlist.length,
    liveKitUrl: liveKitUrl || null,
    ready:
      canaryEnabled &&
      roomEndpointEnabled &&
      connectivityEnabled &&
      workspaceAllowed &&
      Boolean(liveKitUrl),
  };
}

export function createLiveKitParticipantMapping({
  workspaceId = null,
  sessionId = null,
  mediaSessionId = null,
  participantId = null,
  deviceId = null,
  providerIdentity = null,
  providerParticipantSid = null,
  identityKind = null,
  userId = null,
  guestId = null,
} = {}) {
  const resolvedParticipantId =
    safeString(participantId) ||
    safeString(providerIdentity) ||
    safeString(providerParticipantSid) ||
    null;
  const resolvedDeviceId =
    safeString(deviceId) ||
    (resolvedParticipantId ? `livekit:${resolvedParticipantId}:device` : null);
  const resolvedUserId = safeString(userId) || null;
  const resolvedGuestId = safeString(guestId) || null;
  const resolvedKind = safeIdentityKind({
    identityKind,
    userId: resolvedUserId,
    guestId: resolvedGuestId,
  });
  const resolvedProviderIdentity =
    safeString(providerIdentity) ||
    resolvedParticipantId ||
    resolvedDeviceId ||
    null;

  return {
    providerType: HUDDLE_MEDIA_PROVIDERS.LIVEKIT,
    workspaceId: safeString(workspaceId) || null,
    sessionId: safeString(sessionId) || null,
    mediaSessionId: safeString(mediaSessionId) || null,
    participantId: resolvedParticipantId,
    deviceId: resolvedDeviceId,
    userId: resolvedUserId,
    guestId: resolvedGuestId,
    identityKind: resolvedKind,
    providerIdentity: resolvedProviderIdentity,
    providerParticipantSid: safeString(providerParticipantSid) || null,
    state: LIVEKIT_READINESS_STATES.MODELED,
    active: false,
    diagnostics: {
      mappingReady: Boolean(resolvedProviderIdentity),
      hasWorkspaceId: Boolean(safeString(workspaceId)),
      hasSessionId: Boolean(safeString(sessionId)),
      hasMediaSessionId: Boolean(safeString(mediaSessionId)),
      hasParticipantId: Boolean(resolvedParticipantId),
      hasDeviceId: Boolean(resolvedDeviceId),
      hasUserId: Boolean(resolvedUserId),
      hasGuestId: Boolean(resolvedGuestId),
      hasProviderIdentity: Boolean(resolvedProviderIdentity),
      hasProviderParticipantSid: Boolean(safeString(providerParticipantSid)),
      roomJoinReady: false,
      tokenReady: false,
    },
  };
}

export function createLiveKitTrackMapping({
  workspaceId = null,
  sessionId = null,
  mediaSessionId = null,
  participantId = null,
  deviceId = null,
  providerTrackId = null,
  trackId = null,
  kind = null,
  source = null,
  publicationState = null,
  subscriptionState = null,
  isLocal = false,
} = {}) {
  const resolvedSource = safeTrackSource(source, kind);
  const resolvedKind = safeTrackKind(kind, resolvedSource);
  const resolvedTrackId =
    safeString(trackId) ||
    safeString(providerTrackId) ||
    [
      safeString(deviceId) || "unmapped-device",
      resolvedKind,
      resolvedSource,
      "unpublished",
    ].join(":");

  return {
    providerType: HUDDLE_MEDIA_PROVIDERS.LIVEKIT,
    workspaceId: safeString(workspaceId) || null,
    sessionId: safeString(sessionId) || null,
    mediaSessionId: safeString(mediaSessionId) || null,
    participantId: safeString(participantId) || null,
    deviceId: safeString(deviceId) || null,
    trackId: resolvedTrackId,
    providerTrackId: safeString(providerTrackId) || null,
    kind: resolvedKind,
    source: resolvedSource,
    publicationState: safePublicationState(publicationState),
    subscriptionState: safeSubscriptionState(subscriptionState),
    isLocal: Boolean(isLocal),
    active: false,
    diagnostics: {
      mappingReady: Boolean(resolvedTrackId),
      hasWorkspaceId: Boolean(safeString(workspaceId)),
      hasSessionId: Boolean(safeString(sessionId)),
      hasMediaSessionId: Boolean(safeString(mediaSessionId)),
      hasParticipantId: Boolean(safeString(participantId)),
      hasDeviceId: Boolean(safeString(deviceId)),
      hasProviderTrackId: Boolean(safeString(providerTrackId)),
      cameraTrack: resolvedSource === LIVEKIT_TRACK_SOURCES.CAMERA,
      microphoneTrack: resolvedSource === LIVEKIT_TRACK_SOURCES.MICROPHONE,
      screenShareTrack: resolvedSource === LIVEKIT_TRACK_SOURCES.SCREEN_SHARE,
      publicationReady: false,
      subscriptionReady: false,
    },
  };
}

export function createLiveKitReadinessDiagnostics({
  room = null,
  participants = [],
  tracks = [],
  tokenReady = false,
} = {}) {
  const safeParticipants = Array.isArray(participants) ? participants : [];
  const safeTracks = Array.isArray(tracks) ? tracks : [];
  const cameraTrackCount = safeTracks.filter(
    (track) => track.source === LIVEKIT_TRACK_SOURCES.CAMERA
  ).length;
  const microphoneTrackCount = safeTracks.filter(
    (track) => track.source === LIVEKIT_TRACK_SOURCES.MICROPHONE
  ).length;
  const screenShareTrackCount = safeTracks.filter(
    (track) => track.source === LIVEKIT_TRACK_SOURCES.SCREEN_SHARE
  ).length;

  return {
    providerType: HUDDLE_MEDIA_PROVIDERS.LIVEKIT,
    modeled: true,
    enabled: false,
    active: false,
    sdk: {
      available: false,
      status: LIVEKIT_READINESS_STATES.NOT_INSTALLED,
    },
    token: {
      ready: Boolean(tokenReady) && false,
      status: LIVEKIT_READINESS_STATES.DISABLED,
      issuanceEnabled: false,
    },
    room: {
      ready: false,
      state: room?.state || HUDDLE_MEDIA_SESSION_STATES.IDLE,
      providerRoomId: room?.providerRoomId || null,
      provisioned: false,
      provisioningEnabled: false,
    },
    participants: {
      ready: false,
      mappingReady: true,
      count: safeParticipants.length,
    },
    tracks: {
      ready: false,
      mappingReady: true,
      count: safeTracks.length,
      cameraTrackCount,
      microphoneTrackCount,
      screenShareTrackCount,
    },
    reason: "livekit_foundation_model_only",
  };
}

export class LiveKitRoomService {
  constructor({
    enabled = false,
    sdkInstalled = false,
    roomProvisioningEnabled = false,
  } = {}) {
    this.enabled = false && enabled;
    this.sdkInstalled = false && sdkInstalled;
    this.roomProvisioningEnabled = false && roomProvisioningEnabled;
    this.diagnostics = {
      providerType: HUDDLE_MEDIA_PROVIDERS.LIVEKIT,
      enabled: this.enabled,
      sdkInstalled: this.sdkInstalled,
      roomProvisioningEnabled: this.roomProvisioningEnabled,
      roomsProvisioned: 0,
      provisioningAttempts: 0,
      provisioningFailures: 0,
      lastAttemptAt: null,
      lastError: null,
    };
  }

  getReadiness() {
    const config = getLiveKitRoomEndpointConfig();
    return {
      providerType: HUDDLE_MEDIA_PROVIDERS.LIVEKIT,
      state: LIVEKIT_ROOM_SERVICE_STATES.MODELED,
      enabled: config.roomEndpointEnabled,
      sdkInstalled: false,
      roomEndpointEnabled: config.roomEndpointEnabled,
      roomProvisioningEnabled: false,
      connectivityEnabled: config.connectivityEnabled,
      workspaceScoped: true,
      liveKitUrlConfigured: Boolean(config.liveKitUrl),
      tokenReady: false,
      roomReady: config.ready,
      participantReady: false,
      trackReady: false,
      reason: config.ready
        ? "livekit_room_endpoint_ready"
        : "livekit_room_endpoint_disabled",
    };
  }

  buildRoomModel({
    workspaceId,
    sessionId,
    legacyHuddleId = null,
    legacyChannelKey = null,
    providerRoomId = null,
    providerMetadata = {},
    participantMappings = [],
    trackMappings = [],
  } = {}) {
    const roomId =
      safeString(providerRoomId) ||
      buildProviderRoomIdentity({
        providerType: HUDDLE_MEDIA_PROVIDERS.LIVEKIT,
        workspaceId,
        sessionId,
        legacyHuddleId,
        legacyChannelKey,
      });
    const roomMetadata = sanitizeLiveKitRoomMetadata({
      ...objectOrEmpty(providerMetadata),
      roomName: roomId,
    });
    const providerMetadataStatus = getProviderMetadataStatus(
      HUDDLE_MEDIA_PROVIDERS.LIVEKIT,
      roomMetadata
    );
    const readiness = createLiveKitReadinessDiagnostics({
      room: {
        state: HUDDLE_MEDIA_SESSION_STATES.IDLE,
        providerRoomId: roomId,
      },
      participants: participantMappings,
      tracks: trackMappings,
    });

    return {
      providerType: HUDDLE_MEDIA_PROVIDERS.LIVEKIT,
      providerRoomId: roomId,
      providerRoomSid: null,
      workspaceId: workspaceId || null,
      sessionId: sessionId || null,
      state: HUDDLE_MEDIA_SESSION_STATES.IDLE,
      roomState: LIVEKIT_ROOM_STATES.MODELED,
      roomProvisioned: false,
      readiness,
      providerMetadata: {
        ...roomMetadata,
        roomName: roomMetadata.roomName || roomId,
      },
      participantMappings,
      trackMappings,
      diagnostics: createMediaSessionDiagnostics({
        providerType: HUDDLE_MEDIA_PROVIDERS.LIVEKIT,
        providerRoomId: roomId,
        state: HUDDLE_MEDIA_SESSION_STATES.IDLE,
        providerMetadataStatus,
        metadata: {
          serviceState: LIVEKIT_ROOM_SERVICE_STATES.MODELED,
          roomProvisioningEnabled: false,
          readiness,
        },
      }),
    };
  }

  async ensureRoom(params = {}) {
    this.diagnostics.provisioningAttempts += 1;
    this.diagnostics.lastAttemptAt = new Date().toISOString();
    const room = this.buildRoomModel(params);
    return {
      ok: false,
      reason: "livekit_room_provisioning_disabled",
      room,
      diagnostics: this.getDiagnostics(),
    };
  }

  async closeRoom(params = {}) {
    return {
      ok: false,
      reason: "livekit_room_close_disabled",
      providerType: HUDDLE_MEDIA_PROVIDERS.LIVEKIT,
      providerRoomId: params.providerRoomId || null,
      diagnostics: this.getDiagnostics(),
    };
  }

  getDiagnostics() {
    const readiness = this.getReadiness();
    return {
      ...this.diagnostics,
      readiness,
      observedAt: new Date().toISOString(),
    };
  }
}

const liveKitRoomService = new LiveKitRoomService();

export default liveKitRoomService;

export {
  sanitizeLiveKitRoomMetadata,
};
