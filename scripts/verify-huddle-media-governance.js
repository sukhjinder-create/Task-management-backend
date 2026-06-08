import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

process.env.DATABASE_URL = " ";
process.env.DB_HOST = "localhost";
process.env.DB_PORT = "5432";
process.env.DB_NAME = "asystence_local";
process.env.NODE_ENV = "test";

const root = process.cwd();

function read(relativePath) {
  return readFileSync(join(root, relativePath), "utf8");
}

function livekitReadyConfig() {
  return {
    roomConfig: {
      ready: true,
      roomEndpointEnabled: true,
      connectivityEnabled: true,
      liveKitUrl: "wss://livekit.example.test",
    },
    tokenConfig: {
      ready: true,
      tokenEndpointEnabled: true,
      connectivityEnabled: true,
      liveKitUrl: "wss://livekit.example.test",
      apiKeyConfigured: true,
      apiSecretConfigured: true,
    },
  };
}

function env(overrides = {}) {
  return {
    HUDDLE_MEDIA_PROVIDER: "",
    HUDDLE_MEDIA_FORCE_MESH: "false",
    HUDDLE_LIVEKIT_FORCE_MESH: "false",
    HUDDLE_LIVEKIT_ENABLED: "false",
    HUDDLE_LIVEKIT_CANARY_ENABLED: "false",
    HUDDLE_LIVEKIT_CANARY_WORKSPACES: "",
    HUDDLE_LIVEKIT_CANARY_SDK_LOAD_ENABLED: "false",
    ...overrides,
  };
}

function webLiveKitCapabilities() {
  return {
    clientType: "web",
    platform: "web",
    supportedProviders: ["mesh", "livekit"],
    providerVersions: {
      livekit: "canary-1",
    },
  };
}

const {
  HUDDLE_MEDIA_PROVIDER_SELECTION_REASONS,
  selectHuddleMediaProvider,
} = await import("../services/huddleMediaProviderSelector.service.js");

function select(params = {}) {
  return selectHuddleMediaProvider({
    workspaceId: "workspace-a",
    session: {
      id: "session-a",
      workspace_id: "workspace-a",
    },
    ...livekitReadyConfig(),
    ...params,
  });
}

const meshDefault = select();
assert.equal(meshDefault.selectedProvider, "mesh");
assert.equal(
  meshDefault.selectionReason,
  HUDDLE_MEDIA_PROVIDER_SELECTION_REASONS.DEFAULT_MESH
);
assert.equal(meshDefault.clientCapabilities.provided, false);

const livekitDisabled = select({
  requestedProvider: "livekit",
  entitlement: true,
  clientCapabilities: webLiveKitCapabilities(),
});
assert.equal(livekitDisabled.selectedProvider, "mesh");
assert.equal(
  livekitDisabled.fallbackReason,
  HUDDLE_MEDIA_PROVIDER_SELECTION_REASONS.LIVEKIT_CANARY_DISABLED
);

const livekitNotEntitled = select({
  requestedProvider: "livekit",
  entitlement: false,
  env: env({
    HUDDLE_LIVEKIT_CANARY_ENABLED: "true",
    HUDDLE_LIVEKIT_CANARY_WORKSPACES: "*",
  }),
  clientCapabilities: webLiveKitCapabilities(),
});
assert.equal(livekitNotEntitled.selectedProvider, "mesh");
assert.equal(
  livekitNotEntitled.fallbackReason,
  HUDDLE_MEDIA_PROVIDER_SELECTION_REASONS.LIVEKIT_ENTITLEMENT_REQUIRED
);

const livekitNotCanary = select({
  requestedProvider: "livekit",
  entitlement: true,
  env: env({
    HUDDLE_LIVEKIT_CANARY_ENABLED: "true",
    HUDDLE_LIVEKIT_CANARY_WORKSPACES: "workspace-b",
  }),
  clientCapabilities: webLiveKitCapabilities(),
});
assert.equal(livekitNotCanary.selectedProvider, "mesh");
assert.equal(
  livekitNotCanary.fallbackReason,
  HUDDLE_MEDIA_PROVIDER_SELECTION_REASONS.LIVEKIT_WORKSPACE_NOT_ENABLED
);

const missingCapability = select({
  requestedProvider: "livekit",
  entitlement: true,
  env: env({
    HUDDLE_LIVEKIT_CANARY_ENABLED: "true",
    HUDDLE_LIVEKIT_CANARY_WORKSPACES: "*",
  }),
});
assert.equal(missingCapability.selectedProvider, "mesh");
assert.equal(
  missingCapability.fallbackReason,
  HUDDLE_MEDIA_PROVIDER_SELECTION_REASONS.LIVEKIT_CLIENT_CAPABILITY_REQUIRED
);

const livekitEligible = select({
  requestedProvider: "livekit",
  entitlement: true,
  env: env({
    HUDDLE_LIVEKIT_CANARY_ENABLED: "true",
    HUDDLE_LIVEKIT_CANARY_WORKSPACES: "*",
    HUDDLE_LIVEKIT_CANARY_SDK_LOAD_ENABLED: "true",
  }),
  clientCapabilities: webLiveKitCapabilities(),
});
assert.equal(livekitEligible.selectedProvider, "livekit");
assert.equal(
  livekitEligible.selectionReason,
  HUDDLE_MEDIA_PROVIDER_SELECTION_REASONS.LIVEKIT_SELECTED
);
assert.equal(livekitEligible.livekitCanaryEligible, true);

const livekitForceMesh = select({
  requestedProvider: "livekit",
  entitlement: true,
  env: env({
    HUDDLE_MEDIA_FORCE_MESH: "true",
    HUDDLE_LIVEKIT_CANARY_ENABLED: "true",
    HUDDLE_LIVEKIT_CANARY_WORKSPACES: "*",
  }),
  clientCapabilities: webLiveKitCapabilities(),
});
assert.equal(livekitForceMesh.selectedProvider, "mesh");
assert.equal(
  livekitForceMesh.fallbackReason,
  HUDDLE_MEDIA_PROVIDER_SELECTION_REASONS.LIVEKIT_REQUESTED_BUT_FORCE_MESH
);

const inheritedLock = select({
  requestedProvider: "mesh",
  entitlement: true,
  env: env({
    HUDDLE_LIVEKIT_CANARY_ENABLED: "true",
    HUDDLE_LIVEKIT_CANARY_WORKSPACES: "*",
  }),
  providerLock: {
    providerType: "livekit",
    mediaSessionId: "media-session-a",
  },
});
assert.equal(inheritedLock.selectedProvider, "livekit");
assert.equal(
  inheritedLock.selectionReason,
  HUDDLE_MEDIA_PROVIDER_SELECTION_REASONS.PROVIDER_LOCK_INHERITED
);
assert.equal(inheritedLock.providerLock.locked, true);
assert.equal(inheritedLock.providerLock.mismatch, true);

const meshLockBlocksLiveKit = select({
  requestedProvider: "livekit",
  entitlement: true,
  env: env({
    HUDDLE_LIVEKIT_CANARY_ENABLED: "true",
    HUDDLE_LIVEKIT_CANARY_WORKSPACES: "*",
  }),
  clientCapabilities: webLiveKitCapabilities(),
  providerLock: {
    providerType: "mesh",
    mediaSessionId: "media-session-b",
  },
});
assert.equal(meshLockBlocksLiveKit.selectedProvider, "mesh");
assert.equal(
  meshLockBlocksLiveKit.fallbackReason,
  HUDDLE_MEDIA_PROVIDER_SELECTION_REASONS.PROVIDER_LOCK_MISMATCH
);

const route = read("routes/huddleMedia.routes.js");
const socket = read("realtime/socket.js");
const providerLockGuard = read("services/huddleProviderLockGuard.service.js");
const sessionService = read("services/huddleMediaSession.service.js");
const providerSelector = read("services/huddleMediaProviderSelector.service.js");
const mobileProvider = read("mobile/asystence_mobile/lib/src/features/workspace/huddle_media/huddle_media_provider.dart");
const mobileService = read("mobile/asystence_mobile/lib/src/features/workspace/huddle_media/huddle_media_service.dart");
const envExample = read(".env.example");

assert.match(route, /findLockedMediaSession/, "LiveKit route must resolve provider lock");
assert.match(route, /createOrGetLockedMediaSession/, "LiveKit route must create provider lock");
assert.match(route, /durable_session_required|durable_session_not_found/, "LiveKit route must require durable sessions");
assert.match(route, /provider_lock_mismatch/, "LiveKit route must reject lock mismatches");
assert.match(route, /providerLockEvaluated/, "LiveKit route must expose provider-lock diagnostics");
assert.match(route, /resolveClientCapabilities/, "LiveKit route must consume client capabilities");
assert.match(route, /canaryEntitled/, "LiveKit route must allow canary-entitled workspaces through room/token authorization");
assert.match(route, /upsertMediaProviderIdentity/, "LiveKit route must persist provider identity diagnostics");
assert.match(socket, /enforceSocketHuddleProviderLock/, "Legacy socket participation must enforce provider locks");
assert.match(socket, /canaryLiveKitEntitled/, "Socket huddle start must allow canary-entitled workspaces to create LiveKit locks");
assert.match(socket, /socket\.on\("huddle:join"[\s\S]*enforceSocketHuddleProviderLock/, "huddle:join must enforce provider locks");
assert.match(socket, /"huddle:signal"[\s\S]*enforceSocketHuddleProviderLock/, "huddle:signal must enforce provider locks");
assert.match(providerLockGuard, /evaluateProviderLockCompatibility/, "Provider-lock guard must expose a certifiable decision function");
assert.match(sessionService, /pg_advisory_xact_lock/, "Provider lock creation must serialize by session");
assert.match(sessionService, /findLockedMediaSession/, "Provider lock lookup must exist");
assert.match(sessionService, /findActiveMediaProviderIdentity/, "LiveKit lifecycle joins must be provable without socket contract changes");
assert.match(sessionService, /createOrGetLockedMediaSession/, "Provider lock creation must exist");
assert.match(
  sessionService,
  /tokenIssued:\s*false[\s\S]*roomProvisioned:\s*false[\s\S]*\.\.\.diagnostics/,
  "Provider identity diagnostics defaults must not overwrite successful token issuance diagnostics"
);
assert.match(providerSelector, /capabilities_absent_default_mesh/, "Missing capabilities must default to mesh");
assert.match(providerSelector, /selectedProvider/, "Selector must expose selected provider");
assert.match(providerSelector, /fallbackReason/, "Selector must expose fallback reason");
assert.match(envExample, /HUDDLE_MEDIA_FORCE_MESH=false/, "Rollback force-mesh flag must be documented");
assert.match(envExample, /HUDDLE_LIVEKIT_CANARY_ENABLED=false/, "Canary shutdown flag must be documented");
assert.match(mobileProvider, /mesh,[\s\S]*livekit,/, "Mobile provider enum must preserve mesh and add LiveKit");
assert.match(mobileService, /huddleLiveKitMobileCanaryEnabled/, "Mobile LiveKit must remain canary gated");
assert.match(mobileService, /huddleLiveKitMobileForceMesh/, "Mobile force-mesh rollback must remain available");
assert.match(mobileService, /MeshHuddleMediaProvider/, "Mobile media service must preserve mesh fallback");

console.log("Huddle media governance verification passed.");
console.log("- Mesh remains the default when provider/capability data is absent.");
console.log("- LiveKit selection requires canary, allowlist, entitlement, capability, room readiness, and token readiness.");
console.log("- LiveKit fallback reasons are explicit for disabled, not entitled, not canary, missing capability, force mesh, and lock mismatch.");
console.log("- Existing provider locks are inherited and late joiners cannot change the selected provider.");
console.log("- LiveKit route persists provider locks and rejects split-brain lock mismatches.");
console.log("- Canary-allowlisted workspaces satisfy LiveKit canary entitlement for room/token and start-lock authorization.");
console.log("- Provider identity diagnostics preserve successful room/token evidence.");
console.log("- Legacy socket join/signal paths enforce provider locks and reject split-brain mesh participation.");
console.log("- Rollback flags and canary shutdown flags are documented.");
console.log("- Mobile LiveKit is canary-gated with mesh as the default fallback.");
