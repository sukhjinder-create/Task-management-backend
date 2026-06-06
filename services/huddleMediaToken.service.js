import {
  HUDDLE_MEDIA_PROVIDERS,
  normalizeMediaProviderType,
} from "./huddleMediaSession.service.js";
import { AccessToken } from "livekit-server-sdk";

export const HUDDLE_MEDIA_TOKEN_STATUSES = Object.freeze({
  DISABLED: "disabled",
  NOT_IMPLEMENTED: "not_implemented",
  REJECTED: "rejected",
  ISSUED: "issued",
  CONFIGURATION_MISSING: "configuration_missing",
});

export const HUDDLE_MEDIA_TOKEN_GRANTS = Object.freeze({
  ROOM_JOIN: "roomJoin",
  CAN_PUBLISH: "canPublish",
  CAN_SUBSCRIBE: "canSubscribe",
  CAN_PUBLISH_DATA: "canPublishData",
  CAN_UPDATE_OWN_METADATA: "canUpdateOwnMetadata",
});

const DEFAULT_GRANTS = Object.freeze([
  HUDDLE_MEDIA_TOKEN_GRANTS.ROOM_JOIN,
  HUDDLE_MEDIA_TOKEN_GRANTS.CAN_PUBLISH,
  HUDDLE_MEDIA_TOKEN_GRANTS.CAN_SUBSCRIBE,
  HUDDLE_MEDIA_TOKEN_GRANTS.CAN_PUBLISH_DATA,
]);

const ALLOWED_TOKEN_GRANTS = new Set(Object.values(HUDDLE_MEDIA_TOKEN_GRANTS));

const SAFE_AUTHORIZATION_ROLES = new Set([
  "host",
  "co_host",
  "participant",
  "guest",
  "listener",
  "recorder",
  "ai_agent",
  "system",
]);

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

function numericTtlSeconds(value, fallback = 600) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), 3600);
}

function uniqueGrants(grants = DEFAULT_GRANTS) {
  return Array.from(
    new Set(
      (grants || [])
        .map(safeString)
        .filter((grant) => ALLOWED_TOKEN_GRANTS.has(grant))
    )
  );
}

export function getLiveKitTokenEndpointConfig({
  env = process.env,
  workspaceId = null,
} = {}) {
  const workspaceAllowlist = splitCsv(env.HUDDLE_LIVEKIT_CANARY_WORKSPACES);
  const workspaceAllowed =
    isEnabled(env.HUDDLE_LIVEKIT_CANARY_ENABLED) &&
    (workspaceAllowlist.includes("*") ||
      (Boolean(workspaceId) && workspaceAllowlist.includes(String(workspaceId))));
  const tokenEndpointEnabled = isEnabled(env.HUDDLE_LIVEKIT_TOKEN_ENDPOINT_ENABLED);
  const connectivityEnabled = isEnabled(env.HUDDLE_LIVEKIT_CANARY_CONNECTIVITY_ENABLED);
  const liveKitUrl = safeString(env.LIVEKIT_URL);
  const apiKey = safeString(env.LIVEKIT_API_KEY);
  const apiSecret = safeString(env.LIVEKIT_API_SECRET);
  const ttlSeconds = numericTtlSeconds(env.HUDDLE_LIVEKIT_TOKEN_TTL_SECONDS);

  return {
    providerType: HUDDLE_MEDIA_PROVIDERS.LIVEKIT,
    canaryEnabled: isEnabled(env.HUDDLE_LIVEKIT_CANARY_ENABLED),
    tokenEndpointEnabled,
    connectivityEnabled,
    workspaceId: workspaceId || null,
    workspaceAllowed,
    workspaceAllowlistCount: workspaceAllowlist.length,
    liveKitUrl: liveKitUrl || null,
    apiKeyConfigured: Boolean(apiKey),
    apiSecretConfigured: Boolean(apiSecret),
    ttlSeconds,
    ready:
      tokenEndpointEnabled &&
      connectivityEnabled &&
      workspaceAllowed &&
      Boolean(liveKitUrl) &&
      Boolean(apiKey) &&
      Boolean(apiSecret),
  };
}

function getLiveKitTokenSecretConfig(env = process.env) {
  return {
    apiKey: safeString(env.LIVEKIT_API_KEY),
    apiSecret: safeString(env.LIVEKIT_API_SECRET),
  };
}

function tokenGrantFromRequest(request = {}) {
  const grants = new Set(uniqueGrants(request.requestedGrants));
  return {
    roomJoin: grants.has(HUDDLE_MEDIA_TOKEN_GRANTS.ROOM_JOIN),
    room: request.providerRoomId,
    canPublish: grants.has(HUDDLE_MEDIA_TOKEN_GRANTS.CAN_PUBLISH),
    canSubscribe: grants.has(HUDDLE_MEDIA_TOKEN_GRANTS.CAN_SUBSCRIBE),
    canPublishData: grants.has(HUDDLE_MEDIA_TOKEN_GRANTS.CAN_PUBLISH_DATA),
    canUpdateOwnMetadata: grants.has(
      HUDDLE_MEDIA_TOKEN_GRANTS.CAN_UPDATE_OWN_METADATA
    ),
  };
}

export function createMediaTokenRequest({
  workspaceId,
  sessionId,
  mediaSessionId = null,
  providerType = HUDDLE_MEDIA_PROVIDERS.MESH,
  providerRoomId = null,
  participantId = null,
  deviceId = null,
  userId = null,
  guestId = null,
  identityKind = userId ? "workspace_user" : guestId ? "guest" : "unknown",
  providerIdentity = null,
  requestedGrants = DEFAULT_GRANTS,
  ttlSeconds = 600,
  metadata = {},
} = {}) {
  return {
    workspaceId: workspaceId || null,
    sessionId: sessionId || null,
    mediaSessionId,
    providerType: normalizeMediaProviderType(providerType),
    providerRoomId,
    participantId,
    deviceId,
    userId,
    guestId,
    identityKind,
    providerIdentity,
    requestedGrants: uniqueGrants(requestedGrants),
    ttlSeconds,
    metadata,
  };
}

export function validateMediaTokenRequestContract(request = {}) {
  const missing = [];
  if (!request.workspaceId) missing.push("workspaceId");
  if (!request.sessionId) missing.push("sessionId");
  if (!request.providerType) missing.push("providerType");
  if (!request.providerRoomId) missing.push("providerRoomId");
  if (!request.providerIdentity) missing.push("providerIdentity");
  if (!request.participantId && !request.userId && !request.guestId) {
    missing.push("participant identity");
  }

  return {
    ok: missing.length === 0,
    missing,
  };
}

function sanitizeTokenRequestSummary(request = {}) {
  const normalized = createMediaTokenRequest(request);
  const requestedGrants = uniqueGrants(normalized.requestedGrants);
  return {
    providerType: normalized.providerType,
    identityKind: safeString(normalized.identityKind) || "unknown",
    requestedGrantCount: requestedGrants.length,
    requestedGrants,
    ttlSeconds:
      Number.isFinite(Number(normalized.ttlSeconds)) &&
      Number(normalized.ttlSeconds) > 0
        ? Number(normalized.ttlSeconds)
        : null,
    hasWorkspaceId: Boolean(normalized.workspaceId),
    hasSessionId: Boolean(normalized.sessionId),
    hasMediaSessionId: Boolean(normalized.mediaSessionId),
    hasProviderRoomId: Boolean(normalized.providerRoomId),
    hasParticipantId: Boolean(normalized.participantId),
    hasDeviceId: Boolean(normalized.deviceId),
    hasUserId: Boolean(normalized.userId),
    hasGuestId: Boolean(normalized.guestId),
    hasProviderIdentity: Boolean(normalized.providerIdentity),
  };
}

function sanitizeAuthorizationSummary(authorization = {}) {
  const role = safeString(authorization?.role);
  return {
    authorized: Boolean(authorization?.authorized),
    role: SAFE_AUTHORIZATION_ROLES.has(role) ? role : "participant",
    checks: {
      workspaceAccess: Boolean(authorization?.workspaceAccess),
      scopeAccess: Boolean(authorization?.scopeAccess),
      participantAllowed: Boolean(authorization?.participantAllowed),
      deviceAllowed: Boolean(authorization?.deviceAllowed),
      sessionLive: Boolean(authorization?.sessionLive),
      providerAllowed: Boolean(authorization?.providerAllowed),
      planEntitled: Boolean(authorization?.planEntitled),
    },
  };
}

export function createMediaTokenAuthorizationContract({
  workspaceAccess = false,
  scopeAccess = false,
  participantAllowed = false,
  deviceAllowed = false,
  sessionLive = false,
  providerAllowed = false,
  planEntitled = false,
  role = "participant",
} = {}) {
  return {
    workspaceAccess: Boolean(workspaceAccess),
    scopeAccess: Boolean(scopeAccess),
    participantAllowed: Boolean(participantAllowed),
    deviceAllowed: Boolean(deviceAllowed),
    sessionLive: Boolean(sessionLive),
    providerAllowed: Boolean(providerAllowed),
    planEntitled: Boolean(planEntitled),
    role,
    authorized:
      Boolean(workspaceAccess) &&
      Boolean(scopeAccess) &&
      Boolean(participantAllowed) &&
      Boolean(deviceAllowed) &&
      Boolean(sessionLive) &&
      Boolean(providerAllowed) &&
      Boolean(planEntitled),
  };
}

export class HuddleMediaTokenService {
  constructor({ enabled = false, tokenIssuanceEnabled = false } = {}) {
    this.enabled = false && enabled;
    this.tokenIssuanceEnabled = false && tokenIssuanceEnabled;
    this.diagnostics = {
      enabled: this.enabled,
      tokenIssuanceEnabled: this.tokenIssuanceEnabled,
      requests: 0,
      rejected: 0,
      issued: 0,
      lastRequestAt: null,
      lastStatus: HUDDLE_MEDIA_TOKEN_STATUSES.DISABLED,
      lastReason: null,
    };
  }

  getStatus() {
    const config = getLiveKitTokenEndpointConfig();
    return {
      status: config.ready
        ? HUDDLE_MEDIA_TOKEN_STATUSES.ISSUED
        : HUDDLE_MEDIA_TOKEN_STATUSES.DISABLED,
      enabled: config.tokenEndpointEnabled,
      tokenIssuanceEnabled: config.ready,
      livekitTokensEnabled: config.ready,
      canaryEnabled: config.canaryEnabled,
      connectivityEnabled: config.connectivityEnabled,
      workspaceScoped: true,
      liveKitUrlConfigured: Boolean(config.liveKitUrl),
      apiKeyConfigured: config.apiKeyConfigured,
      apiSecretConfigured: config.apiSecretConfigured,
      reason: config.ready
        ? "livekit_token_endpoint_ready"
        : "livekit_token_endpoint_disabled",
    };
  }

  async requestToken({
    request,
    authorization = createMediaTokenAuthorizationContract(),
  } = {}) {
    this.diagnostics.requests += 1;
    this.diagnostics.lastRequestAt = new Date().toISOString();
    const normalizedRequest = createMediaTokenRequest(request || {});
    const contract = validateMediaTokenRequestContract(normalizedRequest);
    const config = getLiveKitTokenEndpointConfig({
      workspaceId: normalizedRequest.workspaceId,
    });

    const reject = (status, reason) => {
      this.diagnostics.rejected += 1;
      this.diagnostics.lastStatus = status;
      this.diagnostics.lastReason = reason;
      return {
        ok: false,
        status,
        reason,
        token: null,
        expiresAt: null,
        request: sanitizeTokenRequestSummary(normalizedRequest),
        authorization: sanitizeAuthorizationSummary(authorization),
        contract,
        livekit: {
          canaryEnabled: config.canaryEnabled,
          tokenEndpointEnabled: config.tokenEndpointEnabled,
          connectivityEnabled: config.connectivityEnabled,
          workspaceAllowed: config.workspaceAllowed,
          liveKitUrlConfigured: Boolean(config.liveKitUrl),
          apiKeyConfigured: config.apiKeyConfigured,
          apiSecretConfigured: config.apiSecretConfigured,
        },
        diagnostics: this.getDiagnostics(),
      };
    };

    if (!contract.ok) {
      return reject(
        HUDDLE_MEDIA_TOKEN_STATUSES.REJECTED,
        "invalid_token_request_contract"
      );
    }

    if (normalizedRequest.providerType !== HUDDLE_MEDIA_PROVIDERS.LIVEKIT) {
      return reject(
        HUDDLE_MEDIA_TOKEN_STATUSES.DISABLED,
        "non_livekit_token_issuance_disabled"
      );
    }

    if (!authorization?.authorized) {
      return reject(
        HUDDLE_MEDIA_TOKEN_STATUSES.REJECTED,
        "provider_authorization_failed"
      );
    }

    if (!config.ready) {
      return reject(
        config.apiKeyConfigured && config.apiSecretConfigured && config.liveKitUrl
          ? HUDDLE_MEDIA_TOKEN_STATUSES.DISABLED
          : HUDDLE_MEDIA_TOKEN_STATUSES.CONFIGURATION_MISSING,
        "livekit_token_endpoint_not_ready"
      );
    }

    const { apiKey, apiSecret } = getLiveKitTokenSecretConfig();
    const ttlSeconds = numericTtlSeconds(
      normalizedRequest.ttlSeconds,
      config.ttlSeconds
    );
    const token = new AccessToken(apiKey, apiSecret, {
      identity: normalizedRequest.providerIdentity,
      ttl: `${ttlSeconds}s`,
    });
    token.name = normalizedRequest.providerIdentity;
    token.metadata = JSON.stringify({
      workspaceId: normalizedRequest.workspaceId,
      sessionId: normalizedRequest.sessionId,
      participantId: normalizedRequest.participantId,
      deviceId: normalizedRequest.deviceId,
      identityKind: normalizedRequest.identityKind,
    });
    token.addGrant(tokenGrantFromRequest(normalizedRequest));
    const jwt = await token.toJwt();
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();

    this.diagnostics.issued += 1;
    this.diagnostics.lastStatus = HUDDLE_MEDIA_TOKEN_STATUSES.ISSUED;
    this.diagnostics.lastReason = "token_issued";
    return {
      ok: true,
      status: HUDDLE_MEDIA_TOKEN_STATUSES.ISSUED,
      reason: "token_issued",
      token: jwt,
      expiresAt,
      liveKitUrl: config.liveKitUrl,
      providerRoomId: normalizedRequest.providerRoomId,
      providerIdentity: normalizedRequest.providerIdentity,
      request: sanitizeTokenRequestSummary(normalizedRequest),
      authorization: sanitizeAuthorizationSummary(authorization),
      contract,
      diagnostics: this.getDiagnostics(),
    };
  }

  getDiagnostics() {
    return {
      ...this.diagnostics,
      status: this.getStatus(),
      observedAt: new Date().toISOString(),
    };
  }
}

const huddleMediaTokenService = new HuddleMediaTokenService();

export default huddleMediaTokenService;

export {
  sanitizeAuthorizationSummary,
  sanitizeTokenRequestSummary,
};
