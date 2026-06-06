import {
  HUDDLE_MEDIA_PROVIDERS,
  normalizeMediaProviderType,
} from "./huddleMediaSession.service.js";
import { getLiveKitRoomEndpointConfig } from "./liveKitRoom.service.js";
import { getLiveKitTokenEndpointConfig } from "./huddleMediaToken.service.js";

export const HUDDLE_MEDIA_OPERATIONAL_EVENTS = Object.freeze({
  PROVIDER_SELECTION: "provider_selection",
  ROOM_PROVISIONING: "room_provisioning",
  TOKEN_ISSUANCE: "token_issuance",
  JOIN: "join",
  PUBLISH: "publish",
  RECONNECT: "reconnect",
  PROVIDER_FALLBACK: "provider_fallback",
});

export const HUDDLE_MEDIA_OPERATIONAL_OUTCOMES = Object.freeze({
  SUCCESS: "success",
  FAILURE: "failure",
});

export const HUDDLE_LIVEKIT_ROLLOUT_STAGES = Object.freeze({
  STAGE_0: "stage_0_internal_only",
  STAGE_1: "stage_1_single_workspace",
  STAGE_2: "stage_2_five_workspaces",
  STAGE_3: "stage_3_twenty_five_workspaces",
  STAGE_4: "stage_4_general_availability",
});

export const HUDDLE_LIVEKIT_ROLLOUT_STAGE_ORDER = Object.freeze([
  HUDDLE_LIVEKIT_ROLLOUT_STAGES.STAGE_0,
  HUDDLE_LIVEKIT_ROLLOUT_STAGES.STAGE_1,
  HUDDLE_LIVEKIT_ROLLOUT_STAGES.STAGE_2,
  HUDDLE_LIVEKIT_ROLLOUT_STAGES.STAGE_3,
  HUDDLE_LIVEKIT_ROLLOUT_STAGES.STAGE_4,
]);

export const HUDDLE_LIVEKIT_ROLLOUT_STAGE_LIMITS = Object.freeze({
  [HUDDLE_LIVEKIT_ROLLOUT_STAGES.STAGE_0]: {
    label: "Internal validation",
    maxWorkspaceCount: 1,
    allowWildcard: false,
  },
  [HUDDLE_LIVEKIT_ROLLOUT_STAGES.STAGE_1]: {
    label: "Single workspace",
    maxWorkspaceCount: 1,
    allowWildcard: false,
  },
  [HUDDLE_LIVEKIT_ROLLOUT_STAGES.STAGE_2]: {
    label: "Five workspaces",
    maxWorkspaceCount: 5,
    allowWildcard: false,
  },
  [HUDDLE_LIVEKIT_ROLLOUT_STAGES.STAGE_3]: {
    label: "Twenty-five workspaces",
    maxWorkspaceCount: 25,
    allowWildcard: false,
  },
  [HUDDLE_LIVEKIT_ROLLOUT_STAGES.STAGE_4]: {
    label: "General availability",
    maxWorkspaceCount: null,
    allowWildcard: true,
  },
});

const PROVIDERS = Object.values(HUDDLE_MEDIA_PROVIDERS);
const EVENTS = Object.values(HUDDLE_MEDIA_OPERATIONAL_EVENTS);
const OUTCOMES = Object.values(HUDDLE_MEDIA_OPERATIONAL_OUTCOMES);

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

function getOperationalSelectorConfig(env = process.env) {
  return {
    livekitCanaryEnabled: isEnabled(env.HUDDLE_LIVEKIT_CANARY_ENABLED),
    livekitSdkLoadEnabled: isEnabled(env.HUDDLE_LIVEKIT_CANARY_SDK_LOAD_ENABLED),
    forceMesh:
      isEnabled(env.HUDDLE_MEDIA_FORCE_MESH) ||
      isEnabled(env.HUDDLE_FORCE_MESH) ||
      isEnabled(env.HUDDLE_LIVEKIT_FORCE_MESH),
  };
}

function numericRate(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) return fallback;
  return parsed;
}

function increment(map, key, amount = 1) {
  const resolved = safeString(key) || "unknown";
  map[resolved] = (map[resolved] || 0) + amount;
}

function emptyByProvider(value = 0) {
  return Object.fromEntries(PROVIDERS.map((provider) => [provider, value]));
}

function emptyOutcomeCounters() {
  return Object.fromEntries(
    EVENTS.map((event) => [
      event,
      {
        total: 0,
        success: 0,
        failure: 0,
        byProvider: Object.fromEntries(
          PROVIDERS.map((provider) => [
            provider,
            { total: 0, success: 0, failure: 0 },
          ])
        ),
        byReason: {},
      },
    ])
  );
}

function createEmptyMetricsState() {
  return {
    startedAt: new Date().toISOString(),
    providerSelections: {
      total: 0,
      requested: {},
      selected: emptyByProvider(0),
      byReason: {},
      fallbackCount: 0,
      fallbackReasons: {},
      providerLockViolations: 0,
      capabilityNegotiationFailures: 0,
    },
    sessions: {
      mesh: 0,
      livekit: 0,
      byProvider: emptyByProvider(0),
    },
    events: emptyOutcomeCounters(),
  };
}

let metricsState = createEmptyMetricsState();

export function resetHuddleMediaOperationalMetrics() {
  metricsState = createEmptyMetricsState();
  return getHuddleMediaOperationalMetricsSnapshot();
}

export function recordProviderSelection(selection = {}) {
  const selectedProvider = normalizeMediaProviderType(
    selection.selectedProvider || selection.providerType
  );
  const requestedProvider = safeString(selection.requestedProvider) || "default";
  const reason = selection.selectionReason || selection.reason || "unknown";
  const fallbackReason = selection.fallbackReason || null;

  metricsState.providerSelections.total += 1;
  increment(metricsState.providerSelections.requested, requestedProvider);
  increment(metricsState.providerSelections.selected, selectedProvider);
  increment(metricsState.providerSelections.byReason, reason);
  increment(metricsState.sessions.byProvider, selectedProvider);
  metricsState.sessions[selectedProvider] =
    (metricsState.sessions[selectedProvider] || 0) + 1;

  if (fallbackReason) {
    metricsState.providerSelections.fallbackCount += 1;
    increment(metricsState.providerSelections.fallbackReasons, fallbackReason);
    if (fallbackReason === "livekit_client_capability_required") {
      metricsState.providerSelections.capabilityNegotiationFailures += 1;
    }
    if (fallbackReason === "provider_lock_mismatch") {
      metricsState.providerSelections.providerLockViolations += 1;
    }
  }

  return getHuddleMediaOperationalMetricsSnapshot();
}

export function recordHuddleMediaOperationalEvent({
  providerType = HUDDLE_MEDIA_PROVIDERS.MESH,
  eventType,
  outcome,
  reason = null,
} = {}) {
  const event = EVENTS.includes(eventType) ? eventType : null;
  if (!event) return getHuddleMediaOperationalMetricsSnapshot();
  const result = OUTCOMES.includes(outcome)
    ? outcome
    : HUDDLE_MEDIA_OPERATIONAL_OUTCOMES.FAILURE;
  const provider = normalizeMediaProviderType(providerType);
  const counters = metricsState.events[event];
  counters.total += 1;
  counters[result] += 1;
  counters.byProvider[provider].total += 1;
  counters.byProvider[provider][result] += 1;
  if (reason) increment(counters.byReason, reason);

  if (
    event === HUDDLE_MEDIA_OPERATIONAL_EVENTS.PROVIDER_FALLBACK &&
    result === HUDDLE_MEDIA_OPERATIONAL_OUTCOMES.FAILURE
  ) {
    metricsState.providerSelections.fallbackCount += 1;
    increment(metricsState.providerSelections.fallbackReasons, reason || "unknown");
  }

  return getHuddleMediaOperationalMetricsSnapshot();
}

export function getHuddleMediaOperationalMetricsSnapshot() {
  return {
    ...structuredClone(metricsState),
    observedAt: new Date().toISOString(),
  };
}

export function getHuddleMediaSloConfig(env = process.env) {
  return {
    nonEnforcing: true,
    joinSuccessRate: numericRate(
      env.HUDDLE_LIVEKIT_SLO_JOIN_SUCCESS_RATE,
      0.99
    ),
    publishSuccessRate: numericRate(
      env.HUDDLE_LIVEKIT_SLO_PUBLISH_SUCCESS_RATE,
      0.99
    ),
    reconnectSuccessRate: numericRate(
      env.HUDDLE_LIVEKIT_SLO_RECONNECT_SUCCESS_RATE,
      0.98
    ),
    fallbackSuccessRate: numericRate(
      env.HUDDLE_LIVEKIT_SLO_FALLBACK_SUCCESS_RATE,
      0.99
    ),
    providerLockViolationRate: numericRate(
      env.HUDDLE_LIVEKIT_SLO_PROVIDER_LOCK_VIOLATION_RATE,
      0.001
    ),
  };
}

function rate(success, total) {
  if (!total) return null;
  return success / total;
}

function evaluateSuccessRate({ name, counters, threshold }) {
  const safeCounters = counters || { total: 0, success: 0, failure: 0 };
  const actual = rate(safeCounters.success, safeCounters.total);
  return {
    name,
    threshold,
    actual,
    attempts: safeCounters.total,
    success: safeCounters.success,
    failure: safeCounters.failure,
    status: actual == null ? "unknown" : actual >= threshold ? "pass" : "fail",
  };
}

export function evaluateHuddleMediaSLOs({
  metrics = getHuddleMediaOperationalMetricsSnapshot(),
  env = process.env,
} = {}) {
  const config = getHuddleMediaSloConfig(env);
  const events = metrics.events || {};
  const providerLockViolationRate = metrics.providerSelections?.total
    ? metrics.providerSelections.providerLockViolations /
      metrics.providerSelections.total
    : null;
  const checks = [
    evaluateSuccessRate({
      name: "join_success_rate",
      counters: events[HUDDLE_MEDIA_OPERATIONAL_EVENTS.JOIN],
      threshold: config.joinSuccessRate,
    }),
    evaluateSuccessRate({
      name: "publish_success_rate",
      counters: events[HUDDLE_MEDIA_OPERATIONAL_EVENTS.PUBLISH],
      threshold: config.publishSuccessRate,
    }),
    evaluateSuccessRate({
      name: "reconnect_success_rate",
      counters: events[HUDDLE_MEDIA_OPERATIONAL_EVENTS.RECONNECT],
      threshold: config.reconnectSuccessRate,
    }),
    evaluateSuccessRate({
      name: "fallback_success_rate",
      counters: events[HUDDLE_MEDIA_OPERATIONAL_EVENTS.PROVIDER_FALLBACK],
      threshold: config.fallbackSuccessRate,
    }),
    {
      name: "provider_lock_violation_rate",
      threshold: config.providerLockViolationRate,
      actual: providerLockViolationRate,
      attempts: metrics.providerSelections?.total || 0,
      violations: metrics.providerSelections?.providerLockViolations || 0,
      status:
        providerLockViolationRate == null
          ? "unknown"
          : providerLockViolationRate <= config.providerLockViolationRate
            ? "pass"
            : "fail",
    },
  ];
  return {
    nonEnforcing: true,
    config,
    checks,
    status: checks.some((check) => check.status === "fail")
      ? "attention_required"
      : "diagnostic_only",
    observedAt: new Date().toISOString(),
  };
}

export function normalizeLiveKitRolloutStage(stage = null) {
  const normalized = safeString(stage).toLowerCase();
  if (HUDDLE_LIVEKIT_ROLLOUT_STAGE_ORDER.includes(normalized)) {
    return normalized;
  }
  if (["0", "stage0", "internal"].includes(normalized)) {
    return HUDDLE_LIVEKIT_ROLLOUT_STAGES.STAGE_0;
  }
  if (["1", "stage1", "single"].includes(normalized)) {
    return HUDDLE_LIVEKIT_ROLLOUT_STAGES.STAGE_1;
  }
  if (["2", "stage2", "five"].includes(normalized)) {
    return HUDDLE_LIVEKIT_ROLLOUT_STAGES.STAGE_2;
  }
  if (["3", "stage3", "twenty_five", "twenty-five"].includes(normalized)) {
    return HUDDLE_LIVEKIT_ROLLOUT_STAGES.STAGE_3;
  }
  if (["4", "stage4", "ga", "general_availability"].includes(normalized)) {
    return HUDDLE_LIVEKIT_ROLLOUT_STAGES.STAGE_4;
  }
  return HUDDLE_LIVEKIT_ROLLOUT_STAGES.STAGE_0;
}

export function getLiveKitRolloutStageDiagnostics(env = process.env) {
  const stage = normalizeLiveKitRolloutStage(env.HUDDLE_LIVEKIT_ROLLOUT_STAGE);
  const definition = HUDDLE_LIVEKIT_ROLLOUT_STAGE_LIMITS[stage];
  const workspaceAllowlist = splitCsv(env.HUDDLE_LIVEKIT_CANARY_WORKSPACES);
  const wildcardEnabled = workspaceAllowlist.includes("*");
  const explicitWorkspaceCount = workspaceAllowlist.filter((item) => item !== "*").length;
  const stageIndex = HUDDLE_LIVEKIT_ROLLOUT_STAGE_ORDER.indexOf(stage);
  const stage0InternalValidation =
    stage === HUDDLE_LIVEKIT_ROLLOUT_STAGES.STAGE_0 && explicitWorkspaceCount > 0;
  const requiresLiveKitCanary = stageIndex > 0 || stage0InternalValidation;
  const blockers = [];

  if (!definition.allowWildcard && wildcardEnabled) {
    blockers.push("wildcard_workspace_allowlist_not_allowed_for_stage");
  }
  if (
    definition.maxWorkspaceCount != null &&
    explicitWorkspaceCount > definition.maxWorkspaceCount
  ) {
    blockers.push("workspace_allowlist_exceeds_stage_limit");
  }
  if (requiresLiveKitCanary && !isEnabled(env.HUDDLE_LIVEKIT_CANARY_ENABLED)) {
    blockers.push("livekit_canary_disabled");
  }
  if (requiresLiveKitCanary && isEnabled(env.HUDDLE_MEDIA_FORCE_MESH)) {
    blockers.push("global_force_mesh_enabled");
  }
  if (requiresLiveKitCanary && isEnabled(env.HUDDLE_LIVEKIT_FORCE_MESH)) {
    blockers.push("livekit_force_mesh_enabled");
  }

  return {
    stage,
    stageIndex,
    label: definition.label,
    mode: stage0InternalValidation
      ? "stage_0_internal_validation"
      : stage === HUDDLE_LIVEKIT_ROLLOUT_STAGES.STAGE_0
        ? "stage_0_infrastructure_only"
        : "workspace_canary",
    internalValidation: Boolean(stage0InternalValidation),
    maxWorkspaceCount: definition.maxWorkspaceCount,
    allowWildcard: definition.allowWildcard,
    workspaceAllowlist,
    explicitWorkspaceCount,
    wildcardEnabled,
    canaryEnabled: isEnabled(env.HUDDLE_LIVEKIT_CANARY_ENABLED),
    rolloutEnabled: isEnabled(env.HUDDLE_LIVEKIT_ROLLOUT_ENABLED),
    forceMesh:
      isEnabled(env.HUDDLE_MEDIA_FORCE_MESH) ||
      isEnabled(env.HUDDLE_LIVEKIT_FORCE_MESH),
    blockers,
    ready: blockers.length === 0,
    observedAt: new Date().toISOString(),
  };
}

export function createHuddleMediaReadinessDashboard({
  env = process.env,
  workspaceId = null,
  providerSelection = null,
  metrics = getHuddleMediaOperationalMetricsSnapshot(),
} = {}) {
  const selectorConfig = getOperationalSelectorConfig(env);
  const room = getLiveKitRoomEndpointConfig({ env, workspaceId });
  const token = getLiveKitTokenEndpointConfig({ env, workspaceId });
  const rollout = getLiveKitRolloutStageDiagnostics(env);
  const slo = evaluateHuddleMediaSLOs({ metrics, env });
  const providerStatus = {
    mesh: {
      providerType: HUDDLE_MEDIA_PROVIDERS.MESH,
      enabled: true,
      productionDefault: true,
      activeSelections:
        metrics.providerSelections?.selected?.[HUDDLE_MEDIA_PROVIDERS.MESH] || 0,
    },
    livekit: {
      providerType: HUDDLE_MEDIA_PROVIDERS.LIVEKIT,
      enabled: Boolean(selectorConfig.livekitCanaryEnabled),
      productionDefault: false,
      canaryOnly: rollout.stage !== HUDDLE_LIVEKIT_ROLLOUT_STAGES.STAGE_4,
      activeSelections:
        metrics.providerSelections?.selected?.[HUDDLE_MEDIA_PROVIDERS.LIVEKIT] || 0,
      lastSelectionReason: providerSelection?.selectionReason || null,
      lastFallbackReason: providerSelection?.fallbackReason || null,
    },
  };

  return {
    providerNeutral: true,
    providerStatus,
    roomStatus: {
      providerType: HUDDLE_MEDIA_PROVIDERS.LIVEKIT,
      ready: Boolean(room.ready),
      provisioningEnabled: Boolean(room.roomEndpointEnabled),
      connectivityEnabled: Boolean(room.connectivityEnabled),
      liveKitUrlConfigured: Boolean(room.liveKitUrl),
    },
    tokenStatus: {
      providerType: HUDDLE_MEDIA_PROVIDERS.LIVEKIT,
      ready: Boolean(token.ready),
      issuanceEnabled: Boolean(token.tokenEndpointEnabled),
      connectivityEnabled: Boolean(token.connectivityEnabled),
      liveKitUrlConfigured: Boolean(token.liveKitUrl),
      apiKeyConfigured: Boolean(token.apiKeyConfigured),
      apiSecretConfigured: Boolean(token.apiSecretConfigured),
    },
    canaryStatus: {
      enabled: Boolean(selectorConfig.livekitCanaryEnabled),
      sdkLoadEnabled: Boolean(selectorConfig.livekitSdkLoadEnabled),
      workspaceAllowed: Boolean(room.workspaceAllowed || token.workspaceAllowed),
      workspaceAllowlistCount: room.workspaceAllowlistCount,
    },
    rolloutStatus: rollout,
    fallbackStatus: {
      forceMesh: Boolean(selectorConfig.forceMesh),
      fallbackCount: metrics.providerSelections?.fallbackCount || 0,
      fallbackReasons: metrics.providerSelections?.fallbackReasons || {},
      providerFallbackEvents:
        metrics.events?.[HUDDLE_MEDIA_OPERATIONAL_EVENTS.PROVIDER_FALLBACK] || null,
    },
    slo,
    metrics,
    observedAt: new Date().toISOString(),
  };
}

export function createFinalEpic5ReadinessReport({
  env = process.env,
  workspaceId = null,
  providerSelection = null,
  metrics = getHuddleMediaOperationalMetricsSnapshot(),
} = {}) {
  const dashboard = createHuddleMediaReadinessDashboard({
    env,
    workspaceId,
    providerSelection,
    metrics,
  });
  const blockers = [];
  if (!dashboard.rolloutStatus.ready) {
    blockers.push(...dashboard.rolloutStatus.blockers);
  }
  const requiresLiveKitReadiness =
    dashboard.rolloutStatus.stageIndex > 0 ||
    dashboard.rolloutStatus.internalValidation;
  if (requiresLiveKitReadiness && !dashboard.roomStatus.ready) {
    blockers.push("room_status_not_ready");
  }
  if (requiresLiveKitReadiness && !dashboard.tokenStatus.ready) {
    blockers.push("token_status_not_ready");
  }

  return {
    architectureReadiness: {
      status: "ready",
      meshDefaultPreserved: true,
      providerLockingAvailable: true,
      capabilityNegotiationAvailable: true,
      providerNeutralDiagnosticsAvailable: true,
    },
    implementationReadiness: {
      status: "ready",
      webCanaryAvailable: true,
      mobileCanaryAvailable: true,
      mediaFeatureScopeFrozen: true,
      noProductionRolloutIncluded: true,
    },
    operationalReadiness: {
      status: "ready",
      metricsAvailable: true,
      readinessDashboardAvailable: true,
      sloDiagnosticsAvailable: true,
      runbooksRequired: true,
    },
    rolloutReadiness: {
      status: blockers.length === 0 ? "ready_for_configured_stage" : "blocked",
      stage: dashboard.rolloutStatus.stage,
      blockers,
    },
    remainingBlockers: blockers,
    dashboard,
    certificationVerdict:
      blockers.length === 0
        ? "epic_5_operationally_certifiable_for_configured_stage"
        : "epic_5_operational_controls_ready_with_rollout_blockers",
    observedAt: new Date().toISOString(),
  };
}

export default {
  HUDDLE_MEDIA_OPERATIONAL_EVENTS,
  HUDDLE_MEDIA_OPERATIONAL_OUTCOMES,
  HUDDLE_LIVEKIT_ROLLOUT_STAGES,
  HUDDLE_LIVEKIT_ROLLOUT_STAGE_ORDER,
  HUDDLE_LIVEKIT_ROLLOUT_STAGE_LIMITS,
  resetHuddleMediaOperationalMetrics,
  recordProviderSelection,
  recordHuddleMediaOperationalEvent,
  getHuddleMediaOperationalMetricsSnapshot,
  getHuddleMediaSloConfig,
  evaluateHuddleMediaSLOs,
  normalizeLiveKitRolloutStage,
  getLiveKitRolloutStageDiagnostics,
  createHuddleMediaReadinessDashboard,
  createFinalEpic5ReadinessReport,
};
