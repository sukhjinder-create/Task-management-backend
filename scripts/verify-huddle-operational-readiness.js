import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

process.env.DATABASE_URL = " ";
process.env.DB_HOST = "localhost";
process.env.DB_PORT = "5432";
process.env.DB_NAME = "asystence_local";
process.env.NODE_ENV = "test";

const root = process.cwd();
const read = (relativePath) => readFileSync(join(root, relativePath), "utf8");

const {
  HUDDLE_MEDIA_OPERATIONAL_EVENTS,
  HUDDLE_MEDIA_OPERATIONAL_OUTCOMES,
  HUDDLE_LIVEKIT_ROLLOUT_STAGES,
  createFinalEpic5ReadinessReport,
  createHuddleMediaReadinessDashboard,
  evaluateHuddleMediaSLOs,
  getHuddleMediaOperationalMetricsSnapshot,
  getLiveKitRolloutStageDiagnostics,
  recordHuddleMediaOperationalEvent,
  resetHuddleMediaOperationalMetrics,
} = await import("../services/huddleMediaOperationalReadiness.service.js");

const {
  HUDDLE_MEDIA_PROVIDER_SELECTION_REASONS,
  selectHuddleMediaProvider,
} = await import("../services/huddleMediaProviderSelector.service.js");

function env(overrides = {}) {
  return {
    HUDDLE_MEDIA_PROVIDER: "",
    HUDDLE_MEDIA_FORCE_MESH: "false",
    HUDDLE_FORCE_MESH: "false",
    HUDDLE_LIVEKIT_FORCE_MESH: "false",
    HUDDLE_LIVEKIT_ENABLED: "false",
    HUDDLE_LIVEKIT_CANARY_ENABLED: "false",
    HUDDLE_LIVEKIT_CANARY_WORKSPACES: "",
    HUDDLE_LIVEKIT_CANARY_SDK_LOAD_ENABLED: "false",
    HUDDLE_LIVEKIT_CANARY_CONNECTIVITY_ENABLED: "false",
    HUDDLE_LIVEKIT_ROOM_ENDPOINT_ENABLED: "false",
    HUDDLE_LIVEKIT_TOKEN_ENDPOINT_ENABLED: "false",
    HUDDLE_LIVEKIT_ROLLOUT_ENABLED: "false",
    HUDDLE_LIVEKIT_ROLLOUT_STAGE: "stage_0_internal_only",
    LIVEKIT_URL: "",
    LIVEKIT_API_KEY: "",
    LIVEKIT_API_SECRET: "",
    ...overrides,
  };
}

function readyEnv(overrides = {}) {
  return env({
    HUDDLE_LIVEKIT_CANARY_ENABLED: "true",
    HUDDLE_LIVEKIT_CANARY_WORKSPACES: "workspace-a",
    HUDDLE_LIVEKIT_CANARY_SDK_LOAD_ENABLED: "true",
    HUDDLE_LIVEKIT_CANARY_CONNECTIVITY_ENABLED: "true",
    HUDDLE_LIVEKIT_ROOM_ENDPOINT_ENABLED: "true",
    HUDDLE_LIVEKIT_TOKEN_ENDPOINT_ENABLED: "true",
    LIVEKIT_URL: "wss://livekit.example.test",
    LIVEKIT_API_KEY: "key",
    LIVEKIT_API_SECRET: "secret",
    ...overrides,
  });
}

function liveKitCapabilities() {
  return {
    clientType: "web",
    platform: "web",
    supportedProviders: ["mesh", "livekit"],
    providerVersions: { livekit: "canary-1" },
  };
}

function select(params = {}) {
  return selectHuddleMediaProvider({
    workspaceId: "workspace-a",
    session: { id: "session-a", workspace_id: "workspace-a" },
    entitlement: true,
    ...params,
  });
}

resetHuddleMediaOperationalMetrics();

const meshOnly = select({ env: env() });
assert.equal(meshOnly.selectedProvider, "mesh");
assert.equal(meshOnly.selectionReason, HUDDLE_MEDIA_PROVIDER_SELECTION_REASONS.DEFAULT_MESH);

const canaryEligible = select({
  requestedProvider: "livekit",
  env: readyEnv(),
  clientCapabilities: liveKitCapabilities(),
});
assert.equal(canaryEligible.selectedProvider, "livekit");
assert.equal(canaryEligible.livekitCanaryEligible, true);

const forceMesh = select({
  requestedProvider: "livekit",
  env: readyEnv({ HUDDLE_MEDIA_FORCE_MESH: "true" }),
  clientCapabilities: liveKitCapabilities(),
});
assert.equal(forceMesh.selectedProvider, "mesh");
assert.equal(
  forceMesh.fallbackReason,
  HUDDLE_MEDIA_PROVIDER_SELECTION_REASONS.LIVEKIT_REQUESTED_BUT_FORCE_MESH
);

const missingCapability = select({
  requestedProvider: "livekit",
  env: readyEnv(),
});
assert.equal(missingCapability.selectedProvider, "mesh");
assert.equal(
  missingCapability.fallbackReason,
  HUDDLE_MEDIA_PROVIDER_SELECTION_REASONS.LIVEKIT_CLIENT_CAPABILITY_REQUIRED
);

const inheritedLock = select({
  requestedProvider: "livekit",
  env: readyEnv(),
  providerLock: {
    providerType: "livekit",
    mediaSessionId: "media-session-a",
  },
});
assert.equal(
  inheritedLock.selectionReason,
  HUDDLE_MEDIA_PROVIDER_SELECTION_REASONS.PROVIDER_LOCK_INHERITED
);
assert.equal(inheritedLock.providerLock.locked, true);

const lockViolation = select({
  requestedProvider: "livekit",
  env: readyEnv(),
  clientCapabilities: liveKitCapabilities(),
  providerLock: {
    providerType: "mesh",
    mediaSessionId: "media-session-b",
  },
});
assert.equal(lockViolation.selectedProvider, "mesh");
assert.equal(
  lockViolation.fallbackReason,
  HUDDLE_MEDIA_PROVIDER_SELECTION_REASONS.PROVIDER_LOCK_MISMATCH
);

recordHuddleMediaOperationalEvent({
  providerType: "livekit",
  eventType: HUDDLE_MEDIA_OPERATIONAL_EVENTS.ROOM_PROVISIONING,
  outcome: HUDDLE_MEDIA_OPERATIONAL_OUTCOMES.SUCCESS,
  reason: "livekit_room_payload_ready",
});
recordHuddleMediaOperationalEvent({
  providerType: "livekit",
  eventType: HUDDLE_MEDIA_OPERATIONAL_EVENTS.ROOM_PROVISIONING,
  outcome: HUDDLE_MEDIA_OPERATIONAL_OUTCOMES.FAILURE,
  reason: "livekit_endpoint_not_ready",
});
recordHuddleMediaOperationalEvent({
  providerType: "livekit",
  eventType: HUDDLE_MEDIA_OPERATIONAL_EVENTS.TOKEN_ISSUANCE,
  outcome: HUDDLE_MEDIA_OPERATIONAL_OUTCOMES.SUCCESS,
  reason: "token_issued",
});
recordHuddleMediaOperationalEvent({
  providerType: "livekit",
  eventType: HUDDLE_MEDIA_OPERATIONAL_EVENTS.TOKEN_ISSUANCE,
  outcome: HUDDLE_MEDIA_OPERATIONAL_OUTCOMES.FAILURE,
  reason: "livekit_token_endpoint_not_ready",
});
recordHuddleMediaOperationalEvent({
  providerType: "livekit",
  eventType: HUDDLE_MEDIA_OPERATIONAL_EVENTS.JOIN,
  outcome: HUDDLE_MEDIA_OPERATIONAL_OUTCOMES.SUCCESS,
});
recordHuddleMediaOperationalEvent({
  providerType: "livekit",
  eventType: HUDDLE_MEDIA_OPERATIONAL_EVENTS.PUBLISH,
  outcome: HUDDLE_MEDIA_OPERATIONAL_OUTCOMES.FAILURE,
  reason: "publish_failed",
});
recordHuddleMediaOperationalEvent({
  providerType: "livekit",
  eventType: HUDDLE_MEDIA_OPERATIONAL_EVENTS.RECONNECT,
  outcome: HUDDLE_MEDIA_OPERATIONAL_OUTCOMES.SUCCESS,
});
recordHuddleMediaOperationalEvent({
  providerType: "livekit",
  eventType: HUDDLE_MEDIA_OPERATIONAL_EVENTS.PROVIDER_FALLBACK,
  outcome: HUDDLE_MEDIA_OPERATIONAL_OUTCOMES.SUCCESS,
  reason: "force_mesh",
});

const metrics = getHuddleMediaOperationalMetricsSnapshot();
assert.equal(metrics.providerSelections.selected.mesh >= 1, true);
assert.equal(metrics.providerSelections.selected.livekit >= 1, true);
assert.equal(metrics.providerSelections.capabilityNegotiationFailures >= 1, true);
assert.equal(metrics.providerSelections.providerLockViolations >= 1, true);
assert.equal(metrics.events.room_provisioning.success, 1);
assert.equal(metrics.events.room_provisioning.failure, 1);
assert.equal(metrics.events.token_issuance.success, 1);
assert.equal(metrics.events.token_issuance.failure, 1);
assert.equal(metrics.events.join.success, 1);
assert.equal(metrics.events.publish.failure, 1);
assert.equal(metrics.events.reconnect.success, 1);
assert.equal(metrics.events.provider_fallback.success, 1);

const meshDashboard = createHuddleMediaReadinessDashboard({
  env: env(),
  workspaceId: "workspace-a",
  metrics,
});
assert.equal(meshDashboard.providerStatus.mesh.productionDefault, true);
assert.equal(meshDashboard.providerStatus.livekit.enabled, false);
assert.equal(meshDashboard.roomStatus.ready, false);
assert.equal(meshDashboard.tokenStatus.ready, false);

const canaryDashboard = createHuddleMediaReadinessDashboard({
  env: readyEnv({ HUDDLE_LIVEKIT_ROLLOUT_STAGE: "stage_1_single_workspace" }),
  workspaceId: "workspace-a",
  providerSelection: canaryEligible,
  metrics,
});
assert.equal(canaryDashboard.providerStatus.livekit.enabled, true);
assert.equal(canaryDashboard.roomStatus.ready, true);
assert.equal(canaryDashboard.tokenStatus.ready, true);
assert.equal(canaryDashboard.rolloutStatus.stage, HUDDLE_LIVEKIT_ROLLOUT_STAGES.STAGE_1);
assert.equal(canaryDashboard.rolloutStatus.ready, true);

const forceMeshDashboard = createHuddleMediaReadinessDashboard({
  env: readyEnv({
    HUDDLE_MEDIA_FORCE_MESH: "true",
    HUDDLE_LIVEKIT_ROLLOUT_STAGE: "stage_1_single_workspace",
  }),
  workspaceId: "workspace-a",
  metrics,
});
assert.equal(forceMeshDashboard.fallbackStatus.forceMesh, true);
assert.equal(
  forceMeshDashboard.rolloutStatus.blockers.includes("global_force_mesh_enabled"),
  true
);

const roomDisabled = createHuddleMediaReadinessDashboard({
  env: readyEnv({ HUDDLE_LIVEKIT_ROOM_ENDPOINT_ENABLED: "false" }),
  workspaceId: "workspace-a",
});
assert.equal(roomDisabled.roomStatus.provisioningEnabled, false);
assert.equal(roomDisabled.roomStatus.ready, false);

const tokenDisabled = createHuddleMediaReadinessDashboard({
  env: readyEnv({ HUDDLE_LIVEKIT_TOKEN_ENDPOINT_ENABLED: "false" }),
  workspaceId: "workspace-a",
});
assert.equal(tokenDisabled.tokenStatus.issuanceEnabled, false);
assert.equal(tokenDisabled.tokenStatus.ready, false);

const stage0 = getLiveKitRolloutStageDiagnostics(env());
assert.equal(stage0.stage, HUDDLE_LIVEKIT_ROLLOUT_STAGES.STAGE_0);
assert.equal(stage0.ready, true);
assert.equal(stage0.mode, "stage_0_infrastructure_only");
assert.equal(stage0.maxWorkspaceCount, 1);

const stage0Internal = getLiveKitRolloutStageDiagnostics(
  readyEnv({
    HUDDLE_LIVEKIT_ROLLOUT_STAGE: "stage_0_internal_only",
    HUDDLE_LIVEKIT_CANARY_WORKSPACES: "workspace-a",
  })
);
assert.equal(stage0Internal.stage, HUDDLE_LIVEKIT_ROLLOUT_STAGES.STAGE_0);
assert.equal(stage0Internal.mode, "stage_0_internal_validation");
assert.equal(stage0Internal.internalValidation, true);
assert.equal(stage0Internal.ready, true);

const stage0TooMany = getLiveKitRolloutStageDiagnostics(
  readyEnv({
    HUDDLE_LIVEKIT_ROLLOUT_STAGE: "stage_0_internal_only",
    HUDDLE_LIVEKIT_CANARY_WORKSPACES: "workspace-a,workspace-b",
  })
);
assert.equal(stage0TooMany.ready, false);
assert.equal(
  stage0TooMany.blockers.includes("workspace_allowlist_exceeds_stage_limit"),
  true
);

const stage2TooMany = getLiveKitRolloutStageDiagnostics(
  readyEnv({
    HUDDLE_LIVEKIT_ROLLOUT_STAGE: "stage_2_five_workspaces",
    HUDDLE_LIVEKIT_CANARY_WORKSPACES: "a,b,c,d,e,f",
  })
);
assert.equal(stage2TooMany.ready, false);
assert.equal(
  stage2TooMany.blockers.includes("workspace_allowlist_exceeds_stage_limit"),
  true
);

const stage4 = getLiveKitRolloutStageDiagnostics(
  readyEnv({
    HUDDLE_LIVEKIT_ROLLOUT_STAGE: "stage_4_general_availability",
    HUDDLE_LIVEKIT_CANARY_WORKSPACES: "*",
  })
);
assert.equal(stage4.stage, HUDDLE_LIVEKIT_ROLLOUT_STAGES.STAGE_4);
assert.equal(stage4.ready, true);

const slo = evaluateHuddleMediaSLOs({ metrics });
assert.equal(slo.nonEnforcing, true);
assert.equal(slo.checks.some((check) => check.name === "publish_success_rate"), true);

const finalReport = createFinalEpic5ReadinessReport({
  env: readyEnv({ HUDDLE_LIVEKIT_ROLLOUT_STAGE: "stage_1_single_workspace" }),
  workspaceId: "workspace-a",
  providerSelection: canaryEligible,
  metrics,
});
assert.equal(finalReport.architectureReadiness.meshDefaultPreserved, true);
assert.equal(finalReport.implementationReadiness.noProductionRolloutIncluded, true);
assert.equal(finalReport.operationalReadiness.metricsAvailable, true);
assert.equal(finalReport.rolloutReadiness.status, "ready_for_configured_stage");

const stage0InternalReport = createFinalEpic5ReadinessReport({
  env: readyEnv({
    HUDDLE_LIVEKIT_ROLLOUT_STAGE: "stage_0_internal_only",
    HUDDLE_LIVEKIT_CANARY_WORKSPACES: "workspace-a",
  }),
  workspaceId: "workspace-a",
  providerSelection: canaryEligible,
  metrics,
});
assert.equal(stage0InternalReport.rolloutReadiness.stage, HUDDLE_LIVEKIT_ROLLOUT_STAGES.STAGE_0);
assert.equal(stage0InternalReport.dashboard.rolloutStatus.mode, "stage_0_internal_validation");
assert.equal(stage0InternalReport.rolloutReadiness.status, "ready_for_configured_stage");

const stage0InternalRoomBlocked = createFinalEpic5ReadinessReport({
  env: readyEnv({
    HUDDLE_LIVEKIT_ROLLOUT_STAGE: "stage_0_internal_only",
    HUDDLE_LIVEKIT_CANARY_WORKSPACES: "workspace-a",
    HUDDLE_LIVEKIT_ROOM_ENDPOINT_ENABLED: "false",
  }),
  workspaceId: "workspace-a",
});
assert.equal(
  stage0InternalRoomBlocked.remainingBlockers.includes("room_status_not_ready"),
  true
);

const service = read("services/huddleMediaOperationalReadiness.service.js");
const route = read("routes/huddleMedia.routes.js");
const envExample = read(".env.example");
const runbook = read("HUDDLE_LIVEKIT_PRODUCTION_RUNBOOKS.md");

assert.match(service, /providerSelections/, "Operational service must track provider selection counts");
assert.match(service, /ROOM_PROVISIONING/, "Operational service must track room provisioning");
assert.match(service, /TOKEN_ISSUANCE/, "Operational service must track token issuance");
assert.match(service, /JOIN/, "Operational service must track join metrics");
assert.match(service, /PUBLISH/, "Operational service must track publish metrics");
assert.match(service, /RECONNECT/, "Operational service must track reconnect metrics");
assert.match(service, /providerLockViolations/, "Operational service must track provider lock violations");
assert.match(service, /capabilityNegotiationFailures/, "Operational service must track capability failures");
assert.match(route, /readinessDashboard/, "Existing diagnostics route must expose readiness dashboard model");
assert.match(route, /epic5Readiness/, "Existing diagnostics route must expose final Epic 5 readiness report");
assert.match(envExample, /HUDDLE_LIVEKIT_ROLLOUT_STAGE=stage_0_internal_only/, "Rollout stage config must be documented");
assert.match(envExample, /HUDDLE_LIVEKIT_SLO_JOIN_SUCCESS_RATE=0\.99/, "SLO config must be documented");
assert.match(runbook, /Force Mesh/, "Force mesh runbook must exist");
assert.match(runbook, /Disable LiveKit/, "Disable LiveKit runbook must exist");
assert.match(runbook, /Emergency Canary Shutdown/, "Emergency shutdown runbook must exist");
assert.match(runbook, /Provider Lock Handling/, "Provider lock handling runbook must exist");
assert.doesNotMatch(service, /\brecording\b/i, "Operational bundle must not add recording features");
assert.doesNotMatch(service, /\btranscription\b/i, "Operational bundle must not add transcription features");
assert.doesNotMatch(service, /\bAI\b/, "Operational bundle must not add AI features");

console.log("Huddle operational readiness verification passed.");
console.log("- Provider-neutral metrics cover selection, sessions, fallback, room, token, join, publish, reconnect, provider locks, and capabilities.");
console.log("- Readiness dashboard reports provider, room, token, canary, rollout, fallback, SLO, and final Epic 5 readiness status.");
console.log("- Rollout stages 0-4 and stage transition diagnostics are covered.");
console.log("- Emergency rollback flags and production runbooks are documented.");
console.log("- SLO diagnostics are non-enforcing and certification-only.");
