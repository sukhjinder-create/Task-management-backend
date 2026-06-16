import express from "express";
import huddleMediaTokenService, {
  createMediaTokenAuthorizationContract,
  createMediaTokenRequest,
  getLiveKitTokenEndpointConfig,
} from "../services/huddleMediaToken.service.js";
import {
  HUDDLE_MEDIA_PROVIDERS,
  buildProviderRoomIdentity,
  createOrGetLockedMediaSession,
  findLockedMediaSession,
  listLiveKitQualitySamples,
  recordLiveKitQualityDiagnostics,
  summarizeLiveKitQualitySamples,
  upsertMediaProviderIdentity,
} from "../services/huddleMediaSession.service.js";
import {
  getLiveKitRoomEndpointConfig,
} from "../services/liveKitRoom.service.js";
import liveKitRoomService from "../services/liveKitRoom.service.js";
import {
  getProviderSelectionDiagnostics,
  selectHuddleMediaProvider,
} from "../services/huddleMediaProviderSelector.service.js";
import {
  HUDDLE_MEDIA_OPERATIONAL_EVENTS,
  HUDDLE_MEDIA_OPERATIONAL_OUTCOMES,
  createFinalEpic5ReadinessReport,
  createHuddleMediaReadinessDashboard,
  recordHuddleMediaOperationalEvent,
} from "../services/huddleMediaOperationalReadiness.service.js";
import { resolveHuddleScope } from "../services/huddleScopeResolver.service.js";
import { findHuddleSessionByLegacy } from "../services/huddleSession.service.js";

const router = express.Router();

function safeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function safeDisplayName(value, fallback = "Teammate") {
  const displayName = safeString(value);
  if (!displayName) return fallback;
  if (displayName.toLowerCase().startsWith("livekit:")) return fallback;
  return displayName.slice(0, 80);
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || "")
  );
}

function hasVideoHuddleEntitlement(req) {
  const features = Array.isArray(req.workspace?.planFeatures)
    ? req.workspace.planFeatures
    : [];
  return Boolean(req.workspace?.onTrial) || features.includes("video_huddle");
}

function isEnabled(value) {
  return safeString(value).toLowerCase() === "true";
}

function nowMs() {
  return Number(process.hrtime.bigint() / 1000000n);
}

function elapsedMs(startedAt) {
  return Math.max(0, nowMs() - startedAt);
}

function splitCsv(value) {
  return safeString(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function isLiveKitCanaryWorkspaceAllowed(workspaceId, env = process.env) {
  const resolvedWorkspaceId = safeString(workspaceId);
  const allowlist = splitCsv(env.HUDDLE_LIVEKIT_CANARY_WORKSPACES);
  return (
    isEnabled(env.HUDDLE_LIVEKIT_CANARY_ENABLED) &&
    (allowlist.includes("*") ||
      (Boolean(resolvedWorkspaceId) && allowlist.includes(resolvedWorkspaceId)))
  );
}

function getVideoHuddleEntitlement(req) {
  const planEntitled = hasVideoHuddleEntitlement(req);
  const canaryEntitled = isLiveKitCanaryWorkspaceAllowed(
    req.workspaceId || req.workspace?.id
  );
  return {
    entitled: planEntitled || canaryEntitled,
    planEntitled,
    canaryEntitled,
  };
}

function liveKitProviderRequested(body = {}) {
  return safeString(body.provider || body.providerType).toLowerCase() ===
    HUDDLE_MEDIA_PROVIDERS.LIVEKIT;
}

function resolveSessionId(body = {}) {
  return (
    safeString(body.sessionId) ||
    safeString(body.huddleId) ||
    safeString(body.providerRoomId) ||
    null
  );
}

function resolveClientCapabilities(req, body = {}) {
  const supplied = body.clientCapabilities || body.capabilities || body.client;
  if (supplied && typeof supplied === "object" && !Array.isArray(supplied)) {
    return supplied;
  }
  return null;
}

async function resolveDurableHuddleSession({
  workspaceId,
  channelId,
  sessionId,
  huddleId,
}) {
  if (isUuid(sessionId)) {
    return {
      ok: true,
      source: "request_session_id",
      session: {
        id: sessionId,
        workspace_id: workspaceId,
        legacy_huddle_id: huddleId || null,
        legacy_channel_key: channelId || null,
      },
    };
  }

  const legacyHuddleId = safeString(huddleId) || safeString(sessionId);
  if (!legacyHuddleId || !channelId) {
    return { ok: false, reason: "durable_session_required" };
  }

  const session = await findHuddleSessionByLegacy({
    workspaceId,
    legacyChannelKey: channelId,
    legacyHuddleId,
  });
  if (!session) return { ok: false, reason: "durable_session_not_found" };
  return { ok: true, source: "legacy_session_lookup", session };
}

function createProviderIdentity({
  workspaceId,
  sessionId,
  userId,
  deviceId = null,
} = {}) {
  return [
    "livekit",
    "workspace",
    workspaceId,
    "session",
    sessionId,
    "user",
    userId,
    "device",
    safeString(deviceId) || "default",
  ].map((part) => String(part).replace(/[^a-zA-Z0-9:_-]/g, "_")).join(":");
}

function safeErrorPayload({ reason, authorization, diagnostics = {} }) {
  return {
    ok: false,
    reason,
    authorization,
    diagnostics,
  };
}

async function authorizeLiveKitRequest(req, body = {}, endpointKind = "room") {
  const totalStartedAt = nowMs();
  const timings = {
    authorizationTotalMs: null,
    scopeResolutionMs: null,
    durableSessionResolutionMs: null,
    providerLockLookupMs: null,
    providerSelectionMs: null,
    providerLockAcquisitionMs: null,
    providerLockInheritedWithoutWrite: false,
  };
  const workspaceId = req.workspaceId;
  const userId = req.user?.id;
  const channelId = safeString(body.channelId);
  const sessionId = resolveSessionId(body);
  const providerRequested = liveKitProviderRequested(body);
  const requestedWorkspaceId = safeString(body.workspaceId);
  const entitlement = getVideoHuddleEntitlement(req);
  const planEntitled = entitlement.entitled;
  const roomConfig = getLiveKitRoomEndpointConfig({ workspaceId });
  const tokenConfig = getLiveKitTokenEndpointConfig({ workspaceId });
  let selector = null;

  const checks = {
    authenticated: Boolean(userId),
    workspaceResolved: Boolean(workspaceId),
    workspaceMatch:
      !requestedWorkspaceId || String(requestedWorkspaceId) === String(workspaceId),
    providerRequested,
    channelProvided: Boolean(channelId),
    sessionProvided: Boolean(sessionId),
    planEntitled,
    planFeatureEntitled: entitlement.planEntitled,
    canaryEntitled: entitlement.canaryEntitled,
    canaryEnabled: false,
    workspaceAllowed: false,
    canaryEligible: false,
    connectivityEnabled:
      endpointKind === "token"
        ? tokenConfig.connectivityEnabled
        : roomConfig.connectivityEnabled,
    endpointEnabled:
      endpointKind === "token"
        ? tokenConfig.tokenEndpointEnabled
        : roomConfig.roomEndpointEnabled,
    liveKitUrlConfigured:
      endpointKind === "token"
        ? Boolean(tokenConfig.liveKitUrl)
        : Boolean(roomConfig.liveKitUrl),
    apiKeyConfigured:
      endpointKind === "token" ? tokenConfig.apiKeyConfigured : undefined,
    apiSecretConfigured:
      endpointKind === "token" ? tokenConfig.apiSecretConfigured : undefined,
    providerLockEvaluated: false,
    providerLockMatched: false,
    providerLockRejected: false,
    rejectionReason: null,
  };

  if (!checks.authenticated) return { ok: false, status: 401, reason: "unauthenticated", checks };
  if (!checks.workspaceResolved) return { ok: false, status: 400, reason: "workspace_required", checks };
  if (!checks.workspaceMatch) return { ok: false, status: 403, reason: "workspace_mismatch", checks };
  if (!checks.providerRequested) return { ok: false, status: 400, reason: "livekit_provider_required", checks };
  if (!checks.channelProvided) return { ok: false, status: 400, reason: "channel_required", checks };
  if (!checks.sessionProvided) return { ok: false, status: 400, reason: "session_required", checks };
  if (!checks.planEntitled) return { ok: false, status: 403, reason: "video_huddle_entitlement_required", checks };

  const scopeStartedAt = nowMs();
  const scopeResult = await resolveHuddleScope({
    channelId,
    workspaceId,
    actorUserId: userId,
  });
  timings.scopeResolutionMs = elapsedMs(scopeStartedAt);
  checks.scopeAccess = Boolean(scopeResult.ok);
  if (!scopeResult.ok) {
      return {
        ok: false,
        status: 403,
        reason: scopeResult.reason || "huddle_scope_access_denied",
        checks,
    };
  }

  const durableStartedAt = nowMs();
  const durableSession = await resolveDurableHuddleSession({
    workspaceId,
    channelId,
    sessionId,
    huddleId: safeString(body.huddleId) || sessionId,
  });
  timings.durableSessionResolutionMs = elapsedMs(durableStartedAt);
  checks.durableSessionResolved = Boolean(durableSession.ok);
  if (!durableSession.ok) {
    return {
      ok: false,
      status: 409,
      reason: durableSession.reason,
      checks,
      scope: scopeResult.scope,
    };
  }

  const lockLookupStartedAt = nowMs();
  const providerLock = await findLockedMediaSession({
    workspaceId,
    sessionId: durableSession.session.id,
  }).catch((error) => ({
    providerType: HUDDLE_MEDIA_PROVIDERS.MESH,
    diagnostics: { providerLockLookupError: error.message },
  }));
  timings.providerLockLookupMs = elapsedMs(lockLookupStartedAt);
  const selectorStartedAt = nowMs();
  selector = selectHuddleMediaProvider({
    requestedProvider: HUDDLE_MEDIA_PROVIDERS.LIVEKIT,
    workspaceId,
    session: durableSession.session,
    platform:
      safeString(body.platform) ||
      safeString(req.get?.("x-client-platform")) ||
      "web",
    clientCapabilities: resolveClientCapabilities(req, body),
    entitlement: planEntitled,
    roomConfig,
    tokenConfig,
    providerLock,
  });
  timings.providerSelectionMs = elapsedMs(selectorStartedAt);
  checks.canaryEnabled = Boolean(selector.livekitCanaryEnabled);
  checks.workspaceAllowed = Boolean(selector.livekitCanaryWorkspaceAllowed);
  checks.canaryEligible = Boolean(selector.livekitCanaryEligible);
  checks.clientCapable = Boolean(selector.checks?.clientCapable);
  checks.selectedProvider = selector.selectedProvider;
  checks.selectionReason = selector.selectionReason;
  checks.fallbackReason = selector.fallbackReason;
  checks.providerLocked = Boolean(selector.providerLock?.locked);
  checks.providerLockMismatch = Boolean(selector.providerLock?.mismatch);
  checks.providerLockEvaluated = true;
  checks.providerLockMatched = Boolean(
    selector.providerLock?.locked && !selector.providerLock?.mismatch
  );
  checks.providerLockRejected = Boolean(
    selector.providerLock?.locked && selector.providerLock?.mismatch
  );
  checks.rejectionReason = checks.providerLockRejected
    ? selector.fallbackReason || selector.selectionReason
    : null;

  if (selector.selectedProvider !== HUDDLE_MEDIA_PROVIDERS.LIVEKIT) {
    return {
      ok: false,
      status: selector.providerLock?.mismatch ? 409 : 403,
      reason: selector.fallbackReason || selector.selectionReason,
      checks,
      scope: scopeResult.scope,
      selector,
      providerLock,
      durableSession: durableSession.session,
    };
  }
  if (!checks.endpointEnabled || !checks.connectivityEnabled || !checks.liveKitUrlConfigured) {
    return { ok: false, status: 503, reason: "livekit_endpoint_not_ready", checks, scope: scopeResult.scope, selector };
  }
  if (endpointKind === "token" && (!checks.apiKeyConfigured || !checks.apiSecretConfigured)) {
    return { ok: false, status: 503, reason: "livekit_token_configuration_missing", checks, scope: scopeResult.scope, selector };
  }
  if (endpointKind === "diagnostics") {
    if (!providerLock || providerLock.providerType !== HUDDLE_MEDIA_PROVIDERS.LIVEKIT) {
      return {
        ok: false,
        status: 409,
        reason: "livekit_provider_lock_required",
        checks: {
          ...checks,
          providerLocked: Boolean(providerLock),
          lockedProvider: providerLock?.providerType || null,
          providerLockEvaluated: true,
          providerLockMatched: false,
          providerLockRejected: true,
          rejectionReason: "livekit_provider_lock_required",
        },
        scope: scopeResult.scope,
        selector,
        providerLock,
        durableSession: durableSession.session,
      };
    }
    timings.authorizationTotalMs = elapsedMs(totalStartedAt);
    return {
      ok: true,
      workspaceId,
      userId,
      channelId,
      sessionId: durableSession.session.id,
      huddleId: safeString(body.huddleId) || sessionId,
      deviceId: safeString(body.deviceId) || null,
      scope: scopeResult.scope,
      selector,
      mediaSession: providerLock,
      providerLock: providerLock.providerLock,
      roomConfig,
      tokenConfig,
      timings,
      checks: {
        ...checks,
        providerLocked: true,
        providerLockEvaluated: true,
        providerLockMatched: true,
        providerLockRejected: false,
        rejectionReason: null,
      },
    };
  }

  const providerRoomId = safeString(body.providerRoomId) ||
    buildProviderRoomIdentity({
      providerType: HUDDLE_MEDIA_PROVIDERS.LIVEKIT,
      workspaceId,
      sessionId: durableSession.session.id,
      legacyHuddleId: safeString(body.huddleId) || sessionId,
      legacyChannelKey: channelId,
    });
  let lockResult = null;
  if (
    providerLock?.providerType === HUDDLE_MEDIA_PROVIDERS.LIVEKIT &&
    providerLock?.providerLock?.locked
  ) {
    timings.providerLockInheritedWithoutWrite = true;
    timings.providerLockAcquisitionMs = 0;
    lockResult = {
      ok: true,
      inherited: true,
      mismatch: false,
      mediaSession: providerLock,
      providerType: providerLock.providerType,
      providerLock: providerLock.providerLock,
    };
  } else {
    const lockStartedAt = nowMs();
    lockResult = await createOrGetLockedMediaSession({
      session: durableSession.session,
      workspaceId,
      providerSelection: selector,
      providerRoomId,
      providerMetadata: {
        roomName: providerRoomId,
        diagnostics: {
          endpointKind,
          selector: selector.selectionReason,
        },
      },
      diagnostics: {
        endpointKind,
        selector: getProviderSelectionDiagnostics(selector),
        providerLock: {
          locked: true,
          immutable: true,
          providerType: selector.selectedProvider,
        },
      },
    });
    timings.providerLockAcquisitionMs = elapsedMs(lockStartedAt);
  }
  if (lockResult.mismatch || lockResult.providerType !== HUDDLE_MEDIA_PROVIDERS.LIVEKIT) {
    return {
      ok: false,
      status: 409,
      reason: "provider_lock_mismatch",
      checks: {
        ...checks,
        providerLocked: true,
        lockedProvider: lockResult.providerType,
        providerLockEvaluated: true,
        providerLockMatched: false,
        providerLockRejected: true,
        rejectionReason: "provider_lock_mismatch",
      },
      scope: scopeResult.scope,
      selector,
      providerLock: lockResult.providerLock,
      durableSession: durableSession.session,
    };
  }
  checks.providerLocked = true;
  checks.providerLockEvaluated = true;
  checks.providerLockMatched = true;
  checks.providerLockRejected = false;
  checks.rejectionReason = null;

  timings.authorizationTotalMs = elapsedMs(totalStartedAt);
  return {
    ok: true,
    workspaceId,
    userId,
    channelId,
    sessionId: durableSession.session.id,
    huddleId: safeString(body.huddleId) || sessionId,
    deviceId: safeString(body.deviceId) || null,
    scope: scopeResult.scope,
    selector,
    mediaSession: lockResult.mediaSession,
    providerLock: lockResult.providerLock,
    roomConfig,
    tokenConfig,
    timings,
    checks,
  };
}

function buildRoomPayload(authz, body = {}) {
  const providerRoomId =
    authz.mediaSession?.providerRoomId ||
    safeString(body.providerRoomId) ||
    buildProviderRoomIdentity({
      providerType: HUDDLE_MEDIA_PROVIDERS.LIVEKIT,
      workspaceId: authz.workspaceId,
      sessionId: authz.sessionId,
      legacyHuddleId: authz.huddleId,
      legacyChannelKey: authz.channelId,
    });
  const room = liveKitRoomService.buildRoomModel({
    workspaceId: authz.workspaceId,
    sessionId: authz.sessionId,
    legacyHuddleId: authz.huddleId,
    legacyChannelKey: authz.channelId,
    providerRoomId,
  });

  return {
    providerRoomId,
    room,
    liveKitUrl: authz.roomConfig.liveKitUrl,
  };
}

router.get("/livekit/diagnostics", (req, res) => {
  const selector = selectHuddleMediaProvider({
    requestedProvider: HUDDLE_MEDIA_PROVIDERS.LIVEKIT,
    workspaceId: req.workspaceId,
    platform: "web",
  });
  const readinessDashboard = createHuddleMediaReadinessDashboard({
    workspaceId: req.workspaceId,
    providerSelection: selector,
  });
  res.json({
    ok: true,
    provider: HUDDLE_MEDIA_PROVIDERS.LIVEKIT,
    selector: getProviderSelectionDiagnostics(selector),
    room: getLiveKitRoomEndpointConfig({ workspaceId: req.workspaceId }),
    token: getLiveKitTokenEndpointConfig({ workspaceId: req.workspaceId }),
    readinessDashboard,
    epic5Readiness: createFinalEpic5ReadinessReport({
      workspaceId: req.workspaceId,
      providerSelection: selector,
      metrics: readinessDashboard.metrics,
    }),
  });
});

router.get("/livekit/quality/sessions/:sessionId", async (req, res) => {
  try {
    const samples = await listLiveKitQualitySamples({
      workspaceId: req.workspaceId,
      sessionId: req.params.sessionId,
      actorUserId: req.user?.id,
      role: req.user?.role || "user",
      limit: req.query.limit,
    });
    res.json({
      ok: true,
      provider: HUDDLE_MEDIA_PROVIDERS.LIVEKIT,
      sampleCount: samples.length,
      samples,
    });
  } catch (error) {
    res.status(error?.statusCode || 500).json({
      ok: false,
      reason: error?.reason || "livekit_quality_samples_failed",
    });
  }
});

router.get("/livekit/quality/sessions/:sessionId/summary", async (req, res) => {
  try {
    const samples = await listLiveKitQualitySamples({
      workspaceId: req.workspaceId,
      sessionId: req.params.sessionId,
      actorUserId: req.user?.id,
      role: req.user?.role || "user",
      limit: req.query.limit || 1000,
    });
    res.json({
      ok: true,
      provider: HUDDLE_MEDIA_PROVIDERS.LIVEKIT,
      quality: summarizeLiveKitQualitySamples(samples),
    });
  } catch (error) {
    res.status(error?.statusCode || 500).json({
      ok: false,
      reason: error?.reason || "livekit_quality_summary_failed",
    });
  }
});

router.post("/livekit/diagnostics", async (req, res) => {
  try {
    const authz = await authorizeLiveKitRequest(req, req.body, "diagnostics");
    if (!authz.ok) {
      return res.status(authz.status).json(safeErrorPayload({
        reason: authz.reason,
        authorization: authz.checks,
        diagnostics: {
          selector: getProviderSelectionDiagnostics(authz.selector),
        },
      }));
    }

    const result = await recordLiveKitQualityDiagnostics({
      workspaceId: authz.workspaceId,
      sessionId: authz.sessionId,
      providerRoomId:
        safeString(req.body.providerRoomId) ||
        authz.mediaSession?.providerRoomId ||
        null,
      userId: authz.userId,
      deviceId: authz.deviceId,
      diagnostics: req.body.diagnostics,
    });

    return res.json({
      ok: true,
      provider: HUDDLE_MEDIA_PROVIDERS.LIVEKIT,
      diagnostics: {
        persisted: result.mediaSessionUpdated,
        providerIdentityCount: result.providerIdentityCount,
        qualitySampleId: result.qualitySampleId,
        summary: result.summary,
        authorization: authz.checks,
        providerLock: authz.providerLock,
      },
    });
  } catch (error) {
    console.error("[huddle:media:livekit:diagnostics]", error.message);
    return res.status(500).json({ ok: false, reason: "livekit_diagnostics_endpoint_failed" });
  }
});

router.post("/livekit/room", async (req, res) => {
  try {
    const authz = await authorizeLiveKitRequest(req, req.body, "room");
    if (!authz.ok) {
      recordHuddleMediaOperationalEvent({
        providerType: HUDDLE_MEDIA_PROVIDERS.LIVEKIT,
        eventType: HUDDLE_MEDIA_OPERATIONAL_EVENTS.ROOM_PROVISIONING,
        outcome: HUDDLE_MEDIA_OPERATIONAL_OUTCOMES.FAILURE,
        reason: authz.reason,
      });
      return res.status(authz.status).json(safeErrorPayload({
        reason: authz.reason,
        authorization: authz.checks,
        diagnostics: {
          selector: getProviderSelectionDiagnostics(authz.selector),
          room: getLiveKitRoomEndpointConfig({ workspaceId: req.workspaceId }),
        },
      }));
    }

    const { providerRoomId, room, liveKitUrl } = buildRoomPayload(authz, req.body);
    recordHuddleMediaOperationalEvent({
      providerType: HUDDLE_MEDIA_PROVIDERS.LIVEKIT,
      eventType: HUDDLE_MEDIA_OPERATIONAL_EVENTS.ROOM_PROVISIONING,
      outcome: HUDDLE_MEDIA_OPERATIONAL_OUTCOMES.SUCCESS,
      reason: "livekit_room_payload_ready",
    });
    return res.json({
      ok: true,
      provider: HUDDLE_MEDIA_PROVIDERS.LIVEKIT,
      liveKit: {
        url: liveKitUrl,
        roomName: providerRoomId,
      },
      room,
      diagnostics: {
        selector: getProviderSelectionDiagnostics(authz.selector),
        room: liveKitRoomService.getDiagnostics(),
        authorization: authz.checks,
        providerLock: authz.providerLock,
      },
    });
  } catch (error) {
    console.error("[huddle:media:livekit:room]", error.message);
    recordHuddleMediaOperationalEvent({
      providerType: HUDDLE_MEDIA_PROVIDERS.LIVEKIT,
      eventType: HUDDLE_MEDIA_OPERATIONAL_EVENTS.ROOM_PROVISIONING,
      outcome: HUDDLE_MEDIA_OPERATIONAL_OUTCOMES.FAILURE,
      reason: "livekit_room_endpoint_failed",
    });
    return res.status(500).json({ ok: false, reason: "livekit_room_endpoint_failed" });
  }
});

router.post("/livekit/token", async (req, res) => {
  const endpointStartedAt = nowMs();
  try {
    const authorizationStartedAt = nowMs();
    const authz = await authorizeLiveKitRequest(req, req.body, "token");
    const authorizationMs = elapsedMs(authorizationStartedAt);
    if (!authz.ok) {
      recordHuddleMediaOperationalEvent({
        providerType: HUDDLE_MEDIA_PROVIDERS.LIVEKIT,
        eventType: HUDDLE_MEDIA_OPERATIONAL_EVENTS.TOKEN_ISSUANCE,
        outcome: HUDDLE_MEDIA_OPERATIONAL_OUTCOMES.FAILURE,
        reason: authz.reason,
      });
      return res.status(authz.status).json(safeErrorPayload({
        reason: authz.reason,
        authorization: authz.checks,
        diagnostics: {
          selector: getProviderSelectionDiagnostics(authz.selector),
          token: getLiveKitTokenEndpointConfig({ workspaceId: req.workspaceId }),
        },
      }));
    }

    const { providerRoomId } = buildRoomPayload(authz, req.body);
    const providerIdentity = createProviderIdentity({
      workspaceId: authz.workspaceId,
      sessionId: authz.sessionId,
      userId: authz.userId,
      deviceId: authz.deviceId,
    });
    const displayName = safeDisplayName(
      req.user?.username ||
      req.user?.name ||
      req.user?.displayName ||
      req.user?.email
    );
    const tokenStartedAt = nowMs();
    const tokenResult = await huddleMediaTokenService.requestToken({
      request: createMediaTokenRequest({
        workspaceId: authz.workspaceId,
        sessionId: authz.sessionId,
        providerType: HUDDLE_MEDIA_PROVIDERS.LIVEKIT,
        providerRoomId,
        participantId: authz.userId,
        deviceId: authz.deviceId,
        userId: authz.userId,
        identityKind: "workspace_user",
        providerIdentity,
        metadata: {
          displayName,
          username: displayName,
        },
      }),
      authorization: createMediaTokenAuthorizationContract({
        workspaceAccess: true,
        scopeAccess: true,
        participantAllowed: true,
        deviceAllowed: true,
        sessionLive: true,
        providerAllowed: true,
        planEntitled: true,
        role: req.user?.role || "participant",
      }),
    });
    const tokenIssuanceMs = elapsedMs(tokenStartedAt);

    if (!tokenResult.ok) {
      recordHuddleMediaOperationalEvent({
        providerType: HUDDLE_MEDIA_PROVIDERS.LIVEKIT,
        eventType: HUDDLE_MEDIA_OPERATIONAL_EVENTS.TOKEN_ISSUANCE,
        outcome: HUDDLE_MEDIA_OPERATIONAL_OUTCOMES.FAILURE,
        reason: tokenResult.reason,
      });
      return res.status(503).json({
        ok: false,
        reason: tokenResult.reason,
        diagnostics: tokenResult.diagnostics,
      });
    }

    const identityPersistStartedAt = nowMs();
    const persistIdentity = () => upsertMediaProviderIdentity({
      workspaceId: authz.workspaceId,
      mediaSessionId: authz.mediaSession.mediaSessionId,
      sessionId: authz.sessionId,
      providerType: HUDDLE_MEDIA_PROVIDERS.LIVEKIT,
      providerIdentity,
      identityKind: "workspace_user",
      userId: authz.userId,
      metadata: {
        providerLock: authz.providerLock,
        displayName,
      },
      diagnostics: {
        tokenIssued: true,
        endpointKind: "token",
      },
    }).then(() => {
      recordHuddleMediaOperationalEvent({
        providerType: HUDDLE_MEDIA_PROVIDERS.LIVEKIT,
        eventType: HUDDLE_MEDIA_OPERATIONAL_EVENTS.TOKEN_ISSUANCE,
        outcome: HUDDLE_MEDIA_OPERATIONAL_OUTCOMES.SUCCESS,
        reason: "provider_identity_persisted_async",
      });
    }).catch((error) => {
      console.warn("[huddle:media:livekit:identity_persist_failed]", {
        workspaceId: authz.workspaceId,
        sessionId: authz.sessionId,
        error: error.message,
      });
    });
    if (typeof setImmediate === "function") {
      setImmediate(persistIdentity);
    } else {
      void persistIdentity();
    }

    recordHuddleMediaOperationalEvent({
      providerType: HUDDLE_MEDIA_PROVIDERS.LIVEKIT,
      eventType: HUDDLE_MEDIA_OPERATIONAL_EVENTS.TOKEN_ISSUANCE,
      outcome: HUDDLE_MEDIA_OPERATIONAL_OUTCOMES.SUCCESS,
      reason: "token_issued",
    });
    return res.json({
      ok: true,
      provider: HUDDLE_MEDIA_PROVIDERS.LIVEKIT,
      liveKit: {
        url: tokenResult.liveKitUrl,
        roomName: providerRoomId,
        token: tokenResult.token,
        expiresAt: tokenResult.expiresAt,
        identity: tokenResult.providerIdentity,
      },
      diagnostics: {
        token: tokenResult.diagnostics,
        authorization: authz.checks,
        selector: getProviderSelectionDiagnostics(authz.selector),
        providerLock: authz.providerLock,
        timings: {
          endpointTotalMs: elapsedMs(endpointStartedAt),
          authorizationMs,
          tokenIssuanceMs,
          identityPersistQueuedMs: elapsedMs(identityPersistStartedAt),
          ...(authz.timings || {}),
        },
      },
    });
  } catch (error) {
    console.error("[huddle:media:livekit:token]", error.message);
    recordHuddleMediaOperationalEvent({
      providerType: HUDDLE_MEDIA_PROVIDERS.LIVEKIT,
      eventType: HUDDLE_MEDIA_OPERATIONAL_EVENTS.TOKEN_ISSUANCE,
      outcome: HUDDLE_MEDIA_OPERATIONAL_OUTCOMES.FAILURE,
      reason: "livekit_token_endpoint_failed",
    });
    return res.status(500).json({ ok: false, reason: "livekit_token_endpoint_failed" });
  }
});

export default router;
