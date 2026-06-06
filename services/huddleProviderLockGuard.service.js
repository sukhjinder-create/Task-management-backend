import {
  HUDDLE_MEDIA_PROVIDERS,
  buildProviderRoomIdentity,
  createOrGetLockedMediaSession,
  findActiveMediaProviderIdentity,
  findLockedMediaSession,
  normalizeMediaProviderType,
} from "./huddleMediaSession.service.js";
import {
  HUDDLE_MEDIA_PROVIDER_SELECTION_REASONS,
  selectHuddleMediaProvider,
} from "./huddleMediaProviderSelector.service.js";

export const HUDDLE_PROVIDER_LOCK_GUARD_REASONS = Object.freeze({
  PROVIDER_LOCK_MATCHED: "provider_lock_matched",
  PROVIDER_LOCK_CREATED: "provider_lock_created",
  PROVIDER_LOCK_ABSENT: "provider_lock_absent",
  PROVIDER_LOCK_MISMATCH: "provider_lock_mismatch",
  PROVIDER_LOCK_LOOKUP_FAILED: "provider_lock_lookup_failed",
  PROVIDER_LOCK_CREATE_FAILED: "provider_lock_create_failed",
  PROVIDER_LOCK_SESSION_MISSING: "provider_lock_session_missing",
});

function safeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function lockProvider(providerLock = null) {
  const provider =
    providerLock?.providerType ||
    providerLock?.provider_type ||
    providerLock?.providerLock?.providerType ||
    null;
  if (!provider) return null;
  return normalizeMediaProviderType(provider);
}

function lockSource(providerLock = null) {
  return (
    providerLock?.mediaSessionId ||
    providerLock?.media_session_id ||
    providerLock?.providerLock?.mediaSessionId ||
    providerLock?.id ||
    null
  );
}

function createProviderLockDiagnostics({
  action = null,
  requestedProvider = HUDDLE_MEDIA_PROVIDERS.MESH,
  effectiveProvider = null,
  providerLock = null,
  providerLockEvaluated = true,
  providerLockMatched = false,
  providerLockRejected = false,
  rejectionReason = null,
  selectionReason = null,
  fallbackReason = null,
  providerLockCreated = false,
  providerLockInherited = false,
  liveKitIdentityMatched = false,
} = {}) {
  const lockedProvider = lockProvider(providerLock);
  return {
    providerLockEvaluated: Boolean(providerLockEvaluated),
    providerLockMatched: Boolean(providerLockMatched),
    providerLockRejected: Boolean(providerLockRejected),
    rejectionReason: rejectionReason || null,
    requestedProvider: normalizeMediaProviderType(requestedProvider),
    effectiveProvider:
      effectiveProvider ? normalizeMediaProviderType(effectiveProvider) : null,
    lockedProvider,
    providerLockPresent: Boolean(lockedProvider),
    providerLockImmutable: true,
    providerLockSource: lockSource(providerLock),
    providerLockCreated: Boolean(providerLockCreated),
    providerLockInherited: Boolean(providerLockInherited),
    liveKitIdentityMatched: Boolean(liveKitIdentityMatched),
    selectionReason: selectionReason || null,
    fallbackReason: fallbackReason || null,
    action,
    observedAt: new Date().toISOString(),
  };
}

export function evaluateProviderLockCompatibility({
  action = null,
  requestedProvider = HUDDLE_MEDIA_PROVIDERS.MESH,
  providerLock = null,
  liveKitIdentity = null,
  allowLiveKitLifecycleJoin = false,
} = {}) {
  const requested = normalizeMediaProviderType(requestedProvider);
  const locked = lockProvider(providerLock);

  if (!locked) {
    return createProviderLockDiagnostics({
      action,
      requestedProvider: requested,
      effectiveProvider: requested,
      providerLock,
      providerLockMatched: true,
      selectionReason: HUDDLE_PROVIDER_LOCK_GUARD_REASONS.PROVIDER_LOCK_ABSENT,
    });
  }

  if (requested === locked) {
    return createProviderLockDiagnostics({
      action,
      requestedProvider: requested,
      effectiveProvider: locked,
      providerLock,
      providerLockMatched: true,
      providerLockInherited: true,
      selectionReason: HUDDLE_PROVIDER_LOCK_GUARD_REASONS.PROVIDER_LOCK_MATCHED,
    });
  }

  if (
    allowLiveKitLifecycleJoin &&
    requested === HUDDLE_MEDIA_PROVIDERS.MESH &&
    locked === HUDDLE_MEDIA_PROVIDERS.LIVEKIT &&
    liveKitIdentity
  ) {
    return createProviderLockDiagnostics({
      action,
      requestedProvider: requested,
      effectiveProvider: HUDDLE_MEDIA_PROVIDERS.LIVEKIT,
      providerLock,
      providerLockMatched: true,
      providerLockInherited: true,
      liveKitIdentityMatched: true,
      selectionReason: "livekit_lifecycle_join_identity_matched",
    });
  }

  return createProviderLockDiagnostics({
    action,
    requestedProvider: requested,
    effectiveProvider: requested,
    providerLock,
    providerLockRejected: true,
    rejectionReason: HUDDLE_PROVIDER_LOCK_GUARD_REASONS.PROVIDER_LOCK_MISMATCH,
    fallbackReason: HUDDLE_MEDIA_PROVIDER_SELECTION_REASONS.PROVIDER_LOCK_MISMATCH,
  });
}

export async function getProviderLockDiagnostics({
  workspaceId,
  sessionId,
  action = null,
  requestedProvider = HUDDLE_MEDIA_PROVIDERS.MESH,
  userId = null,
  deviceId = null,
  allowLiveKitLifecycleJoin = false,
  client = null,
} = {}) {
  if (!workspaceId || !sessionId) {
    return createProviderLockDiagnostics({
      action,
      requestedProvider,
      providerLockEvaluated: Boolean(workspaceId || sessionId),
      providerLockRejected: false,
      rejectionReason: !sessionId
        ? HUDDLE_PROVIDER_LOCK_GUARD_REASONS.PROVIDER_LOCK_SESSION_MISSING
        : null,
    });
  }

  const providerLock = await findLockedMediaSession({ workspaceId, sessionId, client });
  let liveKitIdentity = null;
  if (
    allowLiveKitLifecycleJoin &&
    lockProvider(providerLock) === HUDDLE_MEDIA_PROVIDERS.LIVEKIT &&
    userId
  ) {
    liveKitIdentity = await findActiveMediaProviderIdentity({
      workspaceId,
      sessionId,
      providerType: HUDDLE_MEDIA_PROVIDERS.LIVEKIT,
      userId,
      deviceId: deviceId || null,
      client,
    });
    if (!liveKitIdentity && deviceId) {
      liveKitIdentity = await findActiveMediaProviderIdentity({
        workspaceId,
        sessionId,
        providerType: HUDDLE_MEDIA_PROVIDERS.LIVEKIT,
        userId,
        client,
      });
    }
  }

  return evaluateProviderLockCompatibility({
    action,
    requestedProvider,
    providerLock,
    liveKitIdentity,
    allowLiveKitLifecycleJoin,
  });
}

export async function enforceSocketHuddleProviderLock({
  workspaceId,
  session = null,
  sessionId = null,
  channelId = null,
  huddleId = null,
  action = null,
  requestedProvider = HUDDLE_MEDIA_PROVIDERS.MESH,
  userId = null,
  deviceId = null,
  allowLiveKitLifecycleJoin = false,
  createIfMissing = false,
  client = null,
} = {}) {
  const resolvedSessionId = session?.id || sessionId || null;
  if (!workspaceId || !resolvedSessionId) {
    return {
      ok: true,
      providerType: null,
      providerLock: null,
      diagnostics: createProviderLockDiagnostics({
        action,
        requestedProvider,
        providerLockEvaluated: Boolean(workspaceId || resolvedSessionId),
        rejectionReason: !resolvedSessionId
          ? HUDDLE_PROVIDER_LOCK_GUARD_REASONS.PROVIDER_LOCK_SESSION_MISSING
          : null,
      }),
    };
  }

  try {
    const providerLock = await findLockedMediaSession({
      workspaceId,
      sessionId: resolvedSessionId,
      client,
    });
    let liveKitIdentity = null;
    if (
      allowLiveKitLifecycleJoin &&
      lockProvider(providerLock) === HUDDLE_MEDIA_PROVIDERS.LIVEKIT &&
      userId
    ) {
      liveKitIdentity = await findActiveMediaProviderIdentity({
        workspaceId,
        sessionId: resolvedSessionId,
        providerType: HUDDLE_MEDIA_PROVIDERS.LIVEKIT,
        userId,
        deviceId: deviceId || null,
        client,
      });
      if (!liveKitIdentity && deviceId) {
        liveKitIdentity = await findActiveMediaProviderIdentity({
          workspaceId,
          sessionId: resolvedSessionId,
          providerType: HUDDLE_MEDIA_PROVIDERS.LIVEKIT,
          userId,
          client,
        });
      }
    }

    const compatibility = evaluateProviderLockCompatibility({
      action,
      requestedProvider,
      providerLock,
      liveKitIdentity,
      allowLiveKitLifecycleJoin,
    });
    if (compatibility.providerLockRejected) {
      return {
        ok: false,
        providerType: compatibility.effectiveProvider,
        providerLock,
        reason: compatibility.rejectionReason,
        diagnostics: compatibility,
      };
    }

    if (providerLock || !createIfMissing) {
      return {
        ok: true,
        providerType: compatibility.effectiveProvider,
        providerLock,
        diagnostics: compatibility,
      };
    }

    const selectedProvider = normalizeMediaProviderType(requestedProvider);
    const providerSelection = selectHuddleMediaProvider({
      requestedProvider: selectedProvider,
      session: {
        id: resolvedSessionId,
        workspace_id: workspaceId,
      },
      workspaceId,
      clientCapabilities: null,
      entitlement: false,
    });
    const lockResult = await createOrGetLockedMediaSession({
      session: {
        id: resolvedSessionId,
        workspace_id: workspaceId,
        legacy_huddle_id: safeString(huddleId) || null,
        legacy_channel_key: safeString(channelId) || null,
      },
      workspaceId,
      providerSelection,
      providerType: selectedProvider,
      providerRoomId: buildProviderRoomIdentity({
        providerType: selectedProvider,
        workspaceId,
        sessionId: resolvedSessionId,
        legacyHuddleId: huddleId,
        legacyChannelKey: channelId,
      }),
      providerMetadata: {
        transport: "mesh",
        signaling: "socket.io",
        roomMode: "legacy_mesh",
        compatibilitySource: action || "socket",
      },
      diagnostics: {
        providerLockEvaluated: true,
        providerLockMatched: true,
        providerLockRejected: false,
        requestedProvider: selectedProvider,
        selectedProvider,
        fallbackReason: providerSelection.fallbackReason || null,
        selectionReason: providerSelection.selectionReason,
        socketAction: action,
      },
      selectedBy: "socket_provider_lock_guard",
      client,
    });

    const createdProviderLock = lockResult?.providerLock || lockResult?.mediaSession?.providerLock || null;
    const diagnostics = createProviderLockDiagnostics({
      action,
      requestedProvider: selectedProvider,
      effectiveProvider: lockResult?.providerType || selectedProvider,
      providerLock: createdProviderLock,
      providerLockMatched: true,
      providerLockCreated: !lockResult?.inherited,
      providerLockInherited: Boolean(lockResult?.inherited),
      selectionReason:
        lockResult?.inherited
          ? HUDDLE_PROVIDER_LOCK_GUARD_REASONS.PROVIDER_LOCK_MATCHED
          : HUDDLE_PROVIDER_LOCK_GUARD_REASONS.PROVIDER_LOCK_CREATED,
      fallbackReason: providerSelection.fallbackReason || null,
    });

    return {
      ok: true,
      providerType: lockResult?.providerType || selectedProvider,
      providerLock: createdProviderLock,
      diagnostics,
    };
  } catch (err) {
    return {
      ok: false,
      providerType: normalizeMediaProviderType(requestedProvider),
      providerLock: null,
      reason: HUDDLE_PROVIDER_LOCK_GUARD_REASONS.PROVIDER_LOCK_LOOKUP_FAILED,
      diagnostics: createProviderLockDiagnostics({
        action,
        requestedProvider,
        providerLockRejected: true,
        rejectionReason: HUDDLE_PROVIDER_LOCK_GUARD_REASONS.PROVIDER_LOCK_LOOKUP_FAILED,
        fallbackReason: err?.message || null,
      }),
    };
  }
}

export default {
  HUDDLE_PROVIDER_LOCK_GUARD_REASONS,
  evaluateProviderLockCompatibility,
  getProviderLockDiagnostics,
  enforceSocketHuddleProviderLock,
};
