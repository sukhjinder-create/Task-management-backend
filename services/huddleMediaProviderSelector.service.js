import {
  HUDDLE_MEDIA_PROVIDERS,
  normalizeMediaProviderType,
} from "./huddleMediaSession.service.js";
import {
  createLiveKitReadinessDiagnostics,
  getLiveKitRoomEndpointConfig,
} from "./liveKitRoom.service.js";
import { getLiveKitTokenEndpointConfig } from "./huddleMediaToken.service.js";
import { recordProviderSelection } from "./huddleMediaOperationalReadiness.service.js";

export const HUDDLE_MEDIA_PROVIDER_SELECTION_REASONS = Object.freeze({
  DEFAULT_MESH: "default_mesh",
  REQUESTED_MESH: "requested_mesh",
  PROVIDER_LOCK_INHERITED: "provider_lock_inherited",
  LIVEKIT_SELECTED: "livekit_selected",
  LIVEKIT_REQUESTED_BUT_FORCE_MESH: "livekit_requested_but_force_mesh",
  LIVEKIT_CANARY_DISABLED: "livekit_canary_disabled",
  LIVEKIT_WORKSPACE_NOT_ENABLED: "livekit_workspace_not_enabled",
  LIVEKIT_CLIENT_CAPABILITY_REQUIRED: "livekit_client_capability_required",
  LIVEKIT_ENTITLEMENT_REQUIRED: "livekit_entitlement_required",
  LIVEKIT_ROOM_NOT_READY: "livekit_room_not_ready",
  LIVEKIT_TOKEN_NOT_READY: "livekit_token_not_ready",
  PROVIDER_LOCK_MISMATCH: "provider_lock_mismatch",
  UNSUPPORTED_PROVIDER: "unsupported_provider",
});

export const HUDDLE_CLIENT_TYPES = Object.freeze({
  WEB: "web",
  MOBILE: "mobile",
  DESKTOP: "desktop",
  SERVICE: "service",
  UNKNOWN: "unknown",
});

const SAFE_CLIENT_TYPES = new Set(Object.values(HUDDLE_CLIENT_TYPES));
const SAFE_PROVIDERS = new Set(Object.values(HUDDLE_MEDIA_PROVIDERS));

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

function normalizeClientType(value, platform = null) {
  const normalized = safeString(value).toLowerCase();
  if (SAFE_CLIENT_TYPES.has(normalized)) return normalized;
  const inferred = safeString(platform).toLowerCase();
  if (["ios", "android", "mobile"].includes(inferred)) {
    return HUDDLE_CLIENT_TYPES.MOBILE;
  }
  if (["web", "browser"].includes(inferred)) return HUDDLE_CLIENT_TYPES.WEB;
  return HUDDLE_CLIENT_TYPES.UNKNOWN;
}

function normalizePlatform(value) {
  const normalized = safeString(value).toLowerCase();
  if (!normalized) return "unknown";
  if (normalized === "browser") return "web";
  return normalized;
}

function normalizeProviderList(value) {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  const providers = raw
    .map((item) => normalizeMediaProviderType(item))
    .filter((provider) => SAFE_PROVIDERS.has(provider));
  return Array.from(new Set(providers.length ? providers : [HUDDLE_MEDIA_PROVIDERS.MESH]));
}

export function createHuddleClientCapabilities({
  clientType = null,
  platform = null,
  supportedProviders = null,
  mediaProviderSupport = null,
  providerVersions = {},
} = {}) {
  const resolvedPlatform = normalizePlatform(platform);
  const providers = normalizeProviderList(
    supportedProviders || mediaProviderSupport || []
  );
  return {
    provided: true,
    clientType: normalizeClientType(clientType, resolvedPlatform),
    platform: resolvedPlatform,
    supportedProviders: providers,
    providerVersions:
      providerVersions && typeof providerVersions === "object" && !Array.isArray(providerVersions)
        ? Object.fromEntries(
            Object.entries(providerVersions)
              .filter(([provider]) => SAFE_PROVIDERS.has(normalizeMediaProviderType(provider)))
              .map(([provider, version]) => [
                normalizeMediaProviderType(provider),
                safeString(version) || null,
              ])
          )
        : {},
  };
}

export function normalizeHuddleClientCapabilities(input = null, fallback = {}) {
  const source =
    input && typeof input === "object" && !Array.isArray(input)
      ? input
      : null;
  if (!source) {
    return {
      ...createHuddleClientCapabilities({
        clientType: fallback.clientType,
        platform: fallback.platform,
        supportedProviders: [HUDDLE_MEDIA_PROVIDERS.MESH],
      }),
      provided: false,
      reason: "capabilities_absent_default_mesh",
    };
  }

  return createHuddleClientCapabilities({
    clientType: source.clientType || source.type || fallback.clientType,
    platform: source.platform || fallback.platform,
    supportedProviders:
      source.supportedProviders ||
      source.mediaProviders ||
      source.mediaProviderSupport ||
      source.providers,
    providerVersions: source.providerVersions || source.versions || {},
  });
}

export function clientSupportsProvider(capabilities, providerType) {
  const provider = normalizeMediaProviderType(providerType);
  return Boolean(capabilities?.supportedProviders?.includes(provider));
}

export function getProviderSelectorConfig(env = process.env) {
  return {
    livekitModeled: true,
    livekitCanaryEnabled: isEnabled(env.HUDDLE_LIVEKIT_CANARY_ENABLED),
    livekitCanaryWorkspaces: splitCsv(env.HUDDLE_LIVEKIT_CANARY_WORKSPACES),
    livekitSdkLoadEnabled: isEnabled(env.HUDDLE_LIVEKIT_CANARY_SDK_LOAD_ENABLED),
    meshEnabled: true,
    requestedProvider: safeString(env.HUDDLE_MEDIA_PROVIDER).toLowerCase() || null,
    livekitFlagPresent: isEnabled(env.HUDDLE_LIVEKIT_ENABLED),
    forceMesh:
      isEnabled(env.HUDDLE_MEDIA_FORCE_MESH) ||
      isEnabled(env.HUDDLE_FORCE_MESH) ||
      isEnabled(env.HUDDLE_LIVEKIT_FORCE_MESH),
  };
}

function lockProvider(providerLock = null) {
  const provider =
    providerLock?.providerType ||
    providerLock?.provider_type ||
    providerLock?.selectedProvider ||
    null;
  if (!provider) return null;
  return normalizeMediaProviderType(provider);
}

function createDecisionPath(checks) {
  return Object.entries(checks).map(([check, passed]) => ({
    check,
    passed: Boolean(passed),
  }));
}

function firstFailedLiveKitReason(checks) {
  if (checks.forceMesh) {
    return HUDDLE_MEDIA_PROVIDER_SELECTION_REASONS.LIVEKIT_REQUESTED_BUT_FORCE_MESH;
  }
  if (!checks.canaryEnabled) {
    return HUDDLE_MEDIA_PROVIDER_SELECTION_REASONS.LIVEKIT_CANARY_DISABLED;
  }
  if (!checks.workspaceAllowed) {
    return HUDDLE_MEDIA_PROVIDER_SELECTION_REASONS.LIVEKIT_WORKSPACE_NOT_ENABLED;
  }
  if (!checks.clientCapable) {
    return HUDDLE_MEDIA_PROVIDER_SELECTION_REASONS.LIVEKIT_CLIENT_CAPABILITY_REQUIRED;
  }
  if (!checks.entitled) {
    return HUDDLE_MEDIA_PROVIDER_SELECTION_REASONS.LIVEKIT_ENTITLEMENT_REQUIRED;
  }
  if (!checks.roomReady) {
    return HUDDLE_MEDIA_PROVIDER_SELECTION_REASONS.LIVEKIT_ROOM_NOT_READY;
  }
  if (!checks.tokenReady) {
    return HUDDLE_MEDIA_PROVIDER_SELECTION_REASONS.LIVEKIT_TOKEN_NOT_READY;
  }
  return HUDDLE_MEDIA_PROVIDER_SELECTION_REASONS.LIVEKIT_SELECTED;
}

export function selectHuddleMediaProvider({
  requestedProvider = null,
  env = process.env,
  session = null,
  workspaceId = null,
  platform = null,
  clientCapabilities = null,
  entitlement = false,
  roomConfig = null,
  tokenConfig = null,
  providerLock = null,
} = {}) {
  const config = getProviderSelectorConfig(env);
  const requestedRaw = safeString(requestedProvider || config.requestedProvider).toLowerCase();
  const supportedRequest =
    requestedRaw === HUDDLE_MEDIA_PROVIDERS.MESH ||
    requestedRaw === HUDDLE_MEDIA_PROVIDERS.LIVEKIT;
  const normalizedRequest = supportedRequest
    ? normalizeMediaProviderType(requestedRaw)
    : null;
  const resolvedWorkspaceId = workspaceId || session?.workspace_id || null;
  const capabilities = normalizeHuddleClientCapabilities(clientCapabilities, {
    platform,
  });
  const workspaceAllowlist = config.livekitCanaryWorkspaces;
  const workspaceAllowed =
    config.livekitCanaryEnabled &&
    (workspaceAllowlist.includes("*") ||
      (Boolean(resolvedWorkspaceId) &&
        workspaceAllowlist.includes(String(resolvedWorkspaceId))));
  const room = roomConfig || getLiveKitRoomEndpointConfig({ env, workspaceId: resolvedWorkspaceId });
  const token = tokenConfig || getLiveKitTokenEndpointConfig({ env, workspaceId: resolvedWorkspaceId });
  const lockedProvider = lockProvider(providerLock);

  const livekitChecks = {
    requestedLiveKit: normalizedRequest === HUDDLE_MEDIA_PROVIDERS.LIVEKIT,
    forceMesh: config.forceMesh,
    canaryEnabled: config.livekitCanaryEnabled,
    workspaceAllowed,
    clientCapable: clientSupportsProvider(capabilities, HUDDLE_MEDIA_PROVIDERS.LIVEKIT),
    entitled: Boolean(entitlement),
    roomReady: Boolean(room?.ready),
    tokenReady: Boolean(token?.ready),
  };

  let selectedProvider = HUDDLE_MEDIA_PROVIDERS.MESH;
  let selectionReason = normalizedRequest === HUDDLE_MEDIA_PROVIDERS.MESH
    ? HUDDLE_MEDIA_PROVIDER_SELECTION_REASONS.REQUESTED_MESH
    : HUDDLE_MEDIA_PROVIDER_SELECTION_REASONS.DEFAULT_MESH;
  let fallbackReason = null;

  if (requestedRaw && !supportedRequest) {
    fallbackReason = HUDDLE_MEDIA_PROVIDER_SELECTION_REASONS.UNSUPPORTED_PROVIDER;
    selectionReason = fallbackReason;
  }

  if (lockedProvider) {
    selectedProvider = lockedProvider;
    selectionReason = HUDDLE_MEDIA_PROVIDER_SELECTION_REASONS.PROVIDER_LOCK_INHERITED;
    if (normalizedRequest && normalizedRequest !== lockedProvider) {
      fallbackReason = HUDDLE_MEDIA_PROVIDER_SELECTION_REASONS.PROVIDER_LOCK_MISMATCH;
    }
  } else if (normalizedRequest === HUDDLE_MEDIA_PROVIDERS.LIVEKIT) {
    const livekitReason = firstFailedLiveKitReason(livekitChecks);
    if (livekitReason === HUDDLE_MEDIA_PROVIDER_SELECTION_REASONS.LIVEKIT_SELECTED) {
      selectedProvider = HUDDLE_MEDIA_PROVIDERS.LIVEKIT;
      selectionReason = livekitReason;
    } else {
      selectedProvider = HUDDLE_MEDIA_PROVIDERS.MESH;
      selectionReason = livekitReason;
      fallbackReason = livekitReason;
    }
  }

  const selectedLiveKit = selectedProvider === HUDDLE_MEDIA_PROVIDERS.LIVEKIT;
  const livekitCanaryEligible =
    normalizedRequest === HUDDLE_MEDIA_PROVIDERS.LIVEKIT &&
    selectedLiveKit &&
    livekitChecks.canaryEnabled &&
    livekitChecks.workspaceAllowed &&
    livekitChecks.clientCapable &&
    livekitChecks.entitled &&
    livekitChecks.roomReady &&
    livekitChecks.tokenReady;

  const readinessDiagnostics = {
    mesh: {
      modeled: true,
      enabled: true,
      active: selectedProvider === HUDDLE_MEDIA_PROVIDERS.MESH,
    },
    livekit: {
      ...createLiveKitReadinessDiagnostics({
        tokenReady: token?.ready,
      }),
      enabled: selectedLiveKit,
      active: selectedLiveKit,
      canaryEnabled: Boolean(config.livekitCanaryEnabled),
      workspaceAllowed: Boolean(workspaceAllowed),
      canaryEligible: Boolean(livekitCanaryEligible),
      sdkLoadEnabled: Boolean(config.livekitSdkLoadEnabled),
      clientCapable: livekitChecks.clientCapable,
      entitlementSatisfied: livekitChecks.entitled,
      room: {
        ...createLiveKitReadinessDiagnostics().room,
        ready: Boolean(room?.ready),
        provisioningEnabled: Boolean(room?.roomEndpointEnabled),
        liveKitUrlConfigured: Boolean(room?.liveKitUrl),
      },
      token: {
        ...createLiveKitReadinessDiagnostics().token,
        ready: Boolean(token?.ready),
        issuanceEnabled: Boolean(token?.tokenEndpointEnabled),
        liveKitUrlConfigured: Boolean(token?.liveKitUrl),
        apiKeyConfigured: Boolean(token?.apiKeyConfigured),
        apiSecretConfigured: Boolean(token?.apiSecretConfigured),
      },
      reason: selectedLiveKit ? "livekit_canary_selected" : fallbackReason || selectionReason,
    },
  };

  const selection = {
    providerType: selectedProvider,
    selectedProvider,
    requestedProvider: normalizedRequest || requestedRaw || null,
    activeProvider: selectedProvider,
    fallbackProvider:
      selectedProvider === HUDDLE_MEDIA_PROVIDERS.LIVEKIT
        ? HUDDLE_MEDIA_PROVIDERS.MESH
        : null,
    selectionReason,
    reason: selectionReason,
    fallbackReason,
    canFallbackToMesh: selectedProvider === HUDDLE_MEDIA_PROVIDERS.LIVEKIT,
    livekitModeled: config.livekitModeled,
    livekitEnabled: selectedLiveKit,
    livekitCanaryEnabled: config.livekitCanaryEnabled,
    livekitCanaryWorkspaceAllowed: workspaceAllowed,
    livekitCanaryEligible,
    livekitCanarySdkLoadEnabled: config.livekitSdkLoadEnabled,
    meshEnabled: true,
    roomProvisioningEnabled: selectedLiveKit && Boolean(room?.roomEndpointEnabled),
    tokenIssuanceEnabled: selectedLiveKit && Boolean(token?.tokenEndpointEnabled),
    sessionId: session?.id || null,
    workspaceId: resolvedWorkspaceId,
    platform: normalizePlatform(platform || capabilities.platform),
    clientCapabilities: capabilities,
    providerLock: {
      locked: Boolean(lockedProvider),
      providerType: lockedProvider,
      source: providerLock?.mediaSessionId || providerLock?.id || null,
      mismatch: Boolean(fallbackReason === HUDDLE_MEDIA_PROVIDER_SELECTION_REASONS.PROVIDER_LOCK_MISMATCH),
    },
    entitlement: {
      entitled: Boolean(entitlement),
    },
    readinessDiagnostics,
    decisionPath: createDecisionPath(livekitChecks),
    checks: livekitChecks,
  };
  recordProviderSelection(selection);
  return selection;
}

export function getProviderSelectionDiagnostics(selection) {
  const selected =
    selection ||
    selectHuddleMediaProvider({
      requestedProvider: null,
    });
  return {
    requestedProvider: selected.requestedProvider,
    selectedProvider: selected.selectedProvider,
    providerType: selected.providerType,
    activeProvider: selected.activeProvider,
    selectionReason: selected.selectionReason,
    reason: selected.reason,
    fallbackReason: selected.fallbackReason,
    providerLock: selected.providerLock,
    entitlement: selected.entitlement,
    clientCapabilities: selected.clientCapabilities,
    canaryEligibility: {
      canaryEnabled: Boolean(selected.livekitCanaryEnabled),
      workspaceAllowed: Boolean(selected.livekitCanaryWorkspaceAllowed),
      eligible: Boolean(selected.livekitCanaryEligible),
    },
    readinessDiagnostics: selected.readinessDiagnostics,
    providerReadiness: selected.readinessDiagnostics,
    roomProvisioningEnabled: selected.roomProvisioningEnabled,
    tokenIssuanceEnabled: selected.tokenIssuanceEnabled,
    decisionPath: selected.decisionPath,
    observedAt: new Date().toISOString(),
  };
}

export default {
  HUDDLE_MEDIA_PROVIDER_SELECTION_REASONS,
  HUDDLE_CLIENT_TYPES,
  createHuddleClientCapabilities,
  normalizeHuddleClientCapabilities,
  clientSupportsProvider,
  getProviderSelectorConfig,
  selectHuddleMediaProvider,
  getProviderSelectionDiagnostics,
};
