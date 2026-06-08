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

const {
  HUDDLE_PROVIDER_LOCK_GUARD_REASONS,
  evaluateProviderLockCompatibility,
} = await import("../services/huddleProviderLockGuard.service.js");
const {
  HUDDLE_MEDIA_PROVIDER_SELECTION_REASONS,
  selectHuddleMediaProvider,
} = await import("../services/huddleMediaProviderSelector.service.js");

function lock(providerType) {
  return {
    providerType,
    mediaSessionId: `media-session-${providerType}`,
  };
}

const meshLockMeshJoin = evaluateProviderLockCompatibility({
  action: "huddle:join",
  requestedProvider: "mesh",
  providerLock: lock("mesh"),
});
assert.equal(meshLockMeshJoin.providerLockEvaluated, true);
assert.equal(meshLockMeshJoin.providerLockMatched, true);
assert.equal(meshLockMeshJoin.providerLockRejected, false);
assert.equal(meshLockMeshJoin.effectiveProvider, "mesh");

const meshLockLiveKitRequest = evaluateProviderLockCompatibility({
  action: "livekit:room",
  requestedProvider: "livekit",
  providerLock: lock("mesh"),
});
assert.equal(meshLockLiveKitRequest.providerLockRejected, true);
assert.equal(
  meshLockLiveKitRequest.rejectionReason,
  HUDDLE_PROVIDER_LOCK_GUARD_REASONS.PROVIDER_LOCK_MISMATCH
);

const liveKitLockLiveKitRequest = evaluateProviderLockCompatibility({
  action: "livekit:token",
  requestedProvider: "livekit",
  providerLock: lock("livekit"),
});
assert.equal(liveKitLockLiveKitRequest.providerLockMatched, true);
assert.equal(liveKitLockLiveKitRequest.providerLockRejected, false);
assert.equal(liveKitLockLiveKitRequest.effectiveProvider, "livekit");

const liveKitLockMeshJoin = evaluateProviderLockCompatibility({
  action: "huddle:join",
  requestedProvider: "mesh",
  providerLock: lock("livekit"),
});
assert.equal(liveKitLockMeshJoin.providerLockRejected, true);
assert.equal(
  liveKitLockMeshJoin.rejectionReason,
  HUDDLE_PROVIDER_LOCK_GUARD_REASONS.PROVIDER_LOCK_MISMATCH
);

const liveKitLifecycleJoin = evaluateProviderLockCompatibility({
  action: "huddle:join",
  requestedProvider: "mesh",
  providerLock: lock("livekit"),
  liveKitIdentity: { id: "identity-a" },
  allowLiveKitLifecycleJoin: true,
});
assert.equal(liveKitLifecycleJoin.providerLockMatched, true);
assert.equal(liveKitLifecycleJoin.providerLockRejected, false);
assert.equal(liveKitLifecycleJoin.effectiveProvider, "livekit");
assert.equal(liveKitLifecycleJoin.liveKitIdentityMatched, true);

const noLockMeshSelection = evaluateProviderLockCompatibility({
  action: "huddle:join",
  requestedProvider: "mesh",
  providerLock: null,
});
assert.equal(noLockMeshSelection.providerLockMatched, true);
assert.equal(noLockMeshSelection.providerLockRejected, false);
assert.equal(noLockMeshSelection.effectiveProvider, "mesh");

const noLockLiveKitSelection = selectHuddleMediaProvider({
  requestedProvider: "livekit",
  workspaceId: "workspace-a",
  session: { id: "session-a", workspace_id: "workspace-a" },
  entitlement: true,
  env: {
    HUDDLE_LIVEKIT_CANARY_ENABLED: "true",
    HUDDLE_LIVEKIT_CANARY_WORKSPACES: "*",
    HUDDLE_LIVEKIT_CANARY_SDK_LOAD_ENABLED: "true",
  },
  clientCapabilities: {
    clientType: "web",
    platform: "web",
    supportedProviders: ["mesh", "livekit"],
    providerVersions: { livekit: "canary-1" },
  },
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
});
assert.equal(noLockLiveKitSelection.selectedProvider, "livekit");
assert.equal(
  noLockLiveKitSelection.selectionReason,
  HUDDLE_MEDIA_PROVIDER_SELECTION_REASONS.LIVEKIT_SELECTED
);

const rollbackUnderLock = selectHuddleMediaProvider({
  requestedProvider: "mesh",
  workspaceId: "workspace-a",
  session: { id: "session-a", workspace_id: "workspace-a" },
  providerLock: lock("livekit"),
  env: {
    HUDDLE_MEDIA_FORCE_MESH: "true",
    HUDDLE_LIVEKIT_CANARY_ENABLED: "false",
    HUDDLE_LIVEKIT_CANARY_WORKSPACES: "",
  },
});
assert.equal(rollbackUnderLock.selectedProvider, "livekit");
assert.equal(
  rollbackUnderLock.selectionReason,
  HUDDLE_MEDIA_PROVIDER_SELECTION_REASONS.PROVIDER_LOCK_INHERITED
);
assert.equal(rollbackUnderLock.providerLock.locked, true);
assert.equal(rollbackUnderLock.providerLock.mismatch, true);

const liveKitAfterMeshStartLock = selectHuddleMediaProvider({
  requestedProvider: "livekit",
  workspaceId: "workspace-a",
  session: { id: "session-a", workspace_id: "workspace-a" },
  providerLock: lock("mesh"),
  entitlement: true,
  env: {
    HUDDLE_LIVEKIT_CANARY_ENABLED: "true",
    HUDDLE_LIVEKIT_CANARY_WORKSPACES: "*",
    HUDDLE_LIVEKIT_CANARY_SDK_LOAD_ENABLED: "true",
  },
  clientCapabilities: {
    clientType: "web",
    platform: "web",
    supportedProviders: ["mesh", "livekit"],
    providerVersions: { livekit: "canary-1" },
  },
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
});
assert.equal(liveKitAfterMeshStartLock.selectedProvider, "mesh");
assert.equal(liveKitAfterMeshStartLock.providerLock.mismatch, true);
assert.equal(
  liveKitAfterMeshStartLock.fallbackReason,
  HUDDLE_MEDIA_PROVIDER_SELECTION_REASONS.PROVIDER_LOCK_MISMATCH
);

const socket = read("realtime/socket.js");
const route = read("routes/huddleMedia.routes.js");
const sessionService = read("services/huddleMediaSession.service.js");
const guard = read("services/huddleProviderLockGuard.service.js");
const adapter = read("services/huddleCompatibilityAdapter.service.js");

assert.match(socket, /enforceSocketHuddleProviderLock/, "Socket must import provider-lock guard");
assert.match(
  adapter,
  /recordLegacyHuddleStart[\s\S]*ensureSessionFromLegacy[\s\S]*createStartMediaProviderLock[\s\S]*upsertHuddleParticipant/,
  "huddle:start must create or inherit a provider lock before host participant persistence"
);
assert.match(
  adapter,
  /requestedProvider[\s\S]*clientCapabilities[\s\S]*entitlement[\s\S]*selectHuddleMediaProvider/,
  "huddle:start provider lock must consume requested provider, client capabilities, and entitlement"
);
assert.match(
  socket,
  /socket\.on\("huddle:start"[\s\S]*resolveSocketRequestedProvider[\s\S]*resolveSocketClientCapabilities[\s\S]*hasLiveKitEntitlement/,
  "huddle:start must pass additive provider intent into provider-lock creation"
);
assert.match(
  socket,
  /socket\.on\("huddle:start"[\s\S]*startLegacyHuddle[\s\S]*provider_lock_required[\s\S]*huddleRealtimeService\.createRoom/,
  "huddle:start must require a provider lock before realtime room creation"
);
assert.match(
  adapter,
  /provider_lock_start_failed[\s\S]*endLegacyChatHuddle/,
  "provider-lock startup failures must fail closed and end the unpublishable legacy row"
);
assert.match(
  socket,
  /socket\.on\("huddle:join"[\s\S]*enforceSocketHuddleProviderLock[\s\S]*recordLegacyHuddleJoin/,
  "huddle:join must evaluate provider lock before legacy join persistence"
);
assert.match(
  socket,
  /allowLiveKitLifecycleJoin:\s*true/,
  "huddle:join and reconnect paths must allow LiveKit lifecycle joins only with identity proof"
);
assert.match(
  socket,
  /socket\.on\("huddle:heartbeat"[\s\S]*enforceSocketHuddleProviderLock/,
  "heartbeat/reconnect path must evaluate provider lock"
);
assert.match(
  socket,
  /"huddle:signal"[\s\S]*enforceSocketHuddleProviderLock[\s\S]*allowLiveKitLifecycleJoin:\s*false/,
  "mesh signaling must reject LiveKit-locked sessions"
);
assert.match(
  socket,
  /socket\.on\("huddle:sync"[\s\S]*getProviderLockDiagnostics/,
  "sync/recovery path must expose provider-lock diagnostics"
);
assert.match(
  socket,
  /providerLock:\s*providerLockGuard\.diagnostics/,
  "socket denials must expose provider-lock guard diagnostics"
);
assert.match(
  guard,
  /providerLockRejected[\s\S]*rejectionReason/,
  "provider-lock guard diagnostics must expose providerLockRejected and rejectionReason"
);
assert.match(
  route,
  /providerLockEvaluated[\s\S]*providerLockMatched[\s\S]*providerLockRejected[\s\S]*rejectionReason/,
  "LiveKit room/token authorization must expose provider-lock diagnostics"
);
assert.match(
  route,
  /provider_lock_mismatch/,
  "LiveKit room/token authorization must reject mesh-locked LiveKit requests"
);
assert.match(
  sessionService,
  /findActiveMediaProviderIdentity/,
  "Provider identity lookup must exist for LiveKit lifecycle socket joins"
);
assert.match(
  guard,
  /createOrGetLockedMediaSession/,
  "Unlocked mesh socket participation must create the first provider lock"
);
assert.match(
  sessionService,
  /const existing = await findLockedMediaSession[\s\S]*if \(existing\)[\s\S]*mismatch/,
  "Provider lock creation must inherit existing locks instead of inserting a second provider decision"
);
assert.match(
  guard,
  /findLockedMediaSession/,
  "Socket participation must read existing provider locks"
);

console.log("Huddle provider-lock authority verification passed.");
console.log("- Mesh lock + mesh join is allowed.");
console.log("- Mesh lock + LiveKit request is rejected.");
console.log("- LiveKit lock + LiveKit request is allowed.");
console.log("- LiveKit lock + mesh join/signal is rejected.");
console.log("- LiveKit lifecycle socket join requires an active LiveKit provider identity.");
console.log("- huddle:start creates an immutable provider lock before host participation or realtime publication.");
console.log("- LiveKit-capable huddle:start requests can create a LiveKit lock without changing old mesh clients.");
console.log("- Unlocked mesh participation creates a mesh provider lock.");
console.log("- Unlocked LiveKit selection remains selector-governed.");
console.log("- LiveKit cannot acquire a lock after mesh startup has locked the session.");
console.log("- Sync, reconnect/heartbeat, socket join, socket signal, room, and token paths expose provider-lock diagnostics.");
console.log("- Rollback flags do not mutate existing provider locks or enable split-brain participation.");
