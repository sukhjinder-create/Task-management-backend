import { readFileSync } from "fs";
import { join } from "path";

const root = process.cwd();

function read(relativePath) {
  return readFileSync(join(root, relativePath), "utf8");
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertIncludes(source, needle, label) {
  assert(source.includes(needle), `${label} missing: ${needle}`);
}

function assertNotMatches(source, pattern, label) {
  assert(!pattern.test(source), `${label} matched forbidden pattern: ${pattern}`);
}

const socket = read("realtime/socket.js");
const adapter = read("services/huddleCompatibilityAdapter.service.js");
const realtimeService = read("services/huddleRealtime.service.js");
const recoveryService = read("services/huddleRecovery.service.js");
const restorationValidator = read("services/huddleRestorationValidator.service.js");
const recoveryFenceService = read("services/huddleRecoveryFence.service.js");
const deviceIdentityService = read("services/huddleDeviceIdentity.service.js");
const localRealtimeProvider = read("realtime/huddle/localRealtimeProvider.js");
const redisRealtimeProvider = read("realtime/huddle/redisRealtimeProvider.js");
const migration = read("migrations/20260603_huddle_sessions.sql");
const hardeningMigration = read("migrations/20260604_huddle_production_readiness.sql");
const restorationReadinessMigration = read("migrations/20260604_huddle_restoration_readiness.sql");
const sessionService = read("services/huddleSession.service.js");
const mobileSocket = read("mobile/asystence_mobile/lib/src/core/socket_service.dart");

const forbiddenSocketPatterns = [
  /\bcreateHuddle\s*\(/,
  /\bgetActiveHuddleForWorkspace\b/,
  /\bendHuddleForWorkspace\b/,
  /\bgetActiveHuddle\s*\(/,
  /\bendHuddle\s*\(/,
  /\bchat_huddles\b/i,
  /\bhuddleRooms\b/,
  /\bgetHuddleRoom\b/,
  /\bsetHuddleRoom\b/,
  /\bdeleteHuddleRoom\b/,
  /\bhuddleParticipantList\b/,
  /\bsocketSafeBroadcast\b/,
  /services\/huddle\.service\.js/,
];

for (const pattern of forbiddenSocketPatterns) {
  assertNotMatches(socket, pattern, "socket legacy persistence boundary");
}

const huddleInviteBroadcast = socket.slice(
  socket.indexOf("async function emitHuddleInviteEvent"),
  socket.indexOf("async function emitHuddleLiveEvent")
);
const huddleLiveBroadcast = socket.slice(
  socket.indexOf("async function emitHuddleLiveEvent"),
  socket.indexOf("async function getHuddlePushTargetIds")
);
const huddleJoinHandler = socket.slice(
  socket.indexOf('socket.on("huddle:join"'),
  socket.indexOf("async function handleHuddleLeave")
);
const huddleLeaveHandler = socket.slice(
  socket.indexOf("async function handleHuddleLeave"),
  socket.indexOf('socket.on("huddle:leave"')
);
assertNotMatches(huddleInviteBroadcast, /legacyRoomName/, "workspace-scoped huddle invite broadcast");
assertNotMatches(huddleLiveBroadcast, /legacyRoomName/, "workspace-scoped huddle live broadcast");
assertNotMatches(huddleJoinHandler, /legacyRoomName/, "workspace-scoped huddle join room ownership");
assertNotMatches(huddleLeaveHandler, /legacyRoomName|socket\.leave\(workspaceRoomName/, "chat room ownership is not released by huddle leave");
assertIncludes(huddleInviteBroadcast, "huddleRealtimeService.broadcastInvite", "huddle realtime invite boundary");
assertIncludes(huddleLiveBroadcast, "huddleRealtimeService.broadcastLive", "huddle realtime live boundary");
assertIncludes(socket, "huddleRealtimeService.configure", "huddle realtime service initialization");
assertIncludes(socket, "@socket.io/redis-adapter", "Socket.IO Redis adapter dependency");
assertIncludes(socket, "configureSocketIoRedisAdapter", "distributed Socket.IO adapter setup");
assertIncludes(socket, "getSocketRealtimeDiagnostics", "Socket.IO realtime diagnostics");
assertIncludes(socket, "SOCKET_IO_REDIS_URL", "Socket.IO Redis URL configuration");
assertIncludes(socket, "SOCKET_IO_REDIS_REQUIRED", "Socket.IO Redis required fail-closed configuration");
assertIncludes(socket, "huddleRealtimeService.joinDevice", "huddle realtime join boundary");
assertIncludes(socket, "huddleRealtimeService.leaveDevice", "huddle realtime leave boundary");
assertIncludes(socket, "huddleRealtimeService.getRecoverySnapshots", "huddle realtime recovery boundary");
assertIncludes(socket, "huddleRealtimeService.leaveDeviceFromAllRooms", "huddle device-scoped realtime disconnect boundary");
assertIncludes(realtimeService, "class HuddleRealtimeService", "huddle realtime service");
assertIncludes(localRealtimeProvider, "class LocalRealtimeProvider", "local realtime provider");
assertIncludes(redisRealtimeProvider, "class RedisRealtimeProvider", "redis realtime provider");
assertIncludes(redisRealtimeProvider, "class RedisHealthClient", "redis health client");
assertIncludes(redisRealtimeProvider, "delegatedProvider: \"local\"", "redis provider delegates behavior to local provider");
assertIncludes(realtimeService, "HUDDLE_REDIS_ENABLED", "redis provider feature flag");
assertIncludes(realtimeService, "HUDDLE_REDIS_REQUIRED", "redis required feature flag");
assertIncludes(realtimeService, "HUDDLE_REALTIME_SHADOW_WRITE", "redis shadow presence feature flag");
assertIncludes(realtimeService, "HUDDLE_HEARTBEATS_ENABLED", "redis heartbeat feature flag");
assertIncludes(redisRealtimeProvider, "shadowWriteEnabled", "redis shadow presence toggle");
assertIncludes(redisRealtimeProvider, "heartbeatsEnabled", "redis heartbeat toggle");
assertIncludes(redisRealtimeProvider, "huddle:presence:session", "redis session presence key model");
assertIncludes(redisRealtimeProvider, "huddle:presence:participant", "redis participant presence key model");
assertIncludes(redisRealtimeProvider, "huddle:presence:device", "redis device presence key model");
assertIncludes(redisRealtimeProvider, "huddle:heartbeat:session", "redis heartbeat session key model");
assertIncludes(redisRealtimeProvider, "huddle:heartbeat:participant", "redis heartbeat participant key model");
assertIncludes(redisRealtimeProvider, "huddle:heartbeat:device", "redis heartbeat device key model");
assertIncludes(redisRealtimeProvider, "scheduleShadowPresenceWrite", "redis best-effort shadow write scheduler");
assertIncludes(redisRealtimeProvider, "scheduleHeartbeatWrite", "redis best-effort heartbeat write scheduler");
assertIncludes(redisRealtimeProvider, "getHeartbeatDiagnostics", "redis heartbeat diagnostics");
assertIncludes(redisRealtimeProvider, "staleParticipants", "redis stale participant diagnostics");
assertIncludes(redisRealtimeProvider, "staleDevices", "redis stale device diagnostics");
assertIncludes(redisRealtimeProvider, "compareShadowPresence", "redis local-vs-shadow diagnostics");
assertIncludes(redisRealtimeProvider, "missing_session", "redis shadow mismatch reporting");
assertIncludes(redisRealtimeProvider, "participant_mismatch", "redis shadow participant mismatch reporting");
assertIncludes(redisRealtimeProvider, "device_mismatch", "redis shadow device mismatch reporting");
assertIncludes(localRealtimeProvider, "roomKey(workspaceId, huddleId)", "workspace-scoped provider room key");
assertIncludes(localRealtimeProvider, "workspaceRoomName", "workspace-scoped provider broadcast");
assertIncludes(socket, 'socket.on("huddle:heartbeat"', "optional heartbeat socket protocol");
assertIncludes(socket, "huddleRealtimeService.recordHeartbeat", "socket heartbeat boundary");
assertIncludes(socket, "huddle:heartbeat:ack", "optional heartbeat acknowledgement");
assertIncludes(socket, "huddleRecoveryService.evaluate", "huddle shadow recovery boundary");
assertIncludes(socket, "huddle:sync:memory:shadow_recovery", "huddle sync memory recovery shadow hook");
assertIncludes(socket, "huddle:sync:db:shadow_recovery", "huddle sync db recovery shadow hook");
assertIncludes(socket, "huddle:join:shadow_recovery", "huddle join recovery shadow hook");
assertIncludes(socket, "huddle:heartbeat:shadow_recovery", "huddle heartbeat recovery shadow hook");
assertIncludes(socket, "socket:reconnect", "socket reconnect recovery shadow hook");
assertIncludes(recoveryService, "class HuddleRecoveryService", "huddle recovery service");
assertIncludes(recoveryService, "evaluateDurable", "huddle durable recovery evaluation");
assertIncludes(recoveryService, "HUDDLE_RECOVERY_SHADOW_ENABLED", "huddle recovery feature flag");
assertIncludes(recoveryService, "HUDDLE_RECOVERY_SNAPSHOT_ENABLED", "huddle recovery snapshot exposure feature flag");
assertIncludes(recoveryService, "expiresAt", "huddle recovery snapshot expiry");
assertIncludes(recoveryService, "generation", "huddle recovery generation fencing");
assertIncludes(recoveryService, "sessionVersion", "huddle recovery session version fencing");
assertIncludes(recoveryService, "restoreAllowed: false", "huddle recovery shadow-only decision");
assertIncludes(recoveryService, "snapshotsGenerated", "huddle recovery generated diagnostics");
assertIncludes(recoveryService, "snapshotsExposed", "huddle recovery exposed diagnostics");
assertIncludes(recoveryService, "snapshotsTruncated", "huddle recovery truncated diagnostics");
assertIncludes(recoveryService, "snapshotsRejected", "huddle recovery rejected diagnostics");
assertIncludes(socket, "withRecoveryMetadata", "huddle optional recovery metadata helper");
assertIncludes(socket, "recoverySnapshot", "huddle optional recovery snapshot payload");
assertIncludes(restorationValidator, "class HuddleRestorationValidator", "huddle restoration validator");
assertIncludes(restorationValidator, "participant_declined", "huddle restoration declined participant guard");
assertIncludes(restorationValidator, "participant_removed", "huddle restoration removed participant guard");
assertIncludes(restorationValidator, "stale_generation", "huddle restoration generation fence guard");
assertIncludes(restorationValidator, "stale_session_version", "huddle restoration session version guard");
assertIncludes(restorationValidator, "restoreAllowed: false", "huddle restoration remains non-restoring");
assertIncludes(recoveryFenceService, "class HuddleRecoveryFenceService", "huddle durable recovery fence service");
assertIncludes(recoveryFenceService, "recordRestoreAttempt", "huddle restore idempotency persistence");
assertIncludes(deviceIdentityService, "normalizeHuddleDeviceIdentity", "huddle logical device identity helper");

for (const method of [
  "huddleCompatibilityAdapter.startLegacyHuddle",
  "huddleCompatibilityAdapter.getActiveLegacyHuddle",
  "huddleCompatibilityAdapter.listRecentActiveLegacyHuddles",
  "huddleCompatibilityAdapter.endLegacyHuddle",
  "huddleCompatibilityAdapter.recordLegacyHuddleJoin",
  "huddleCompatibilityAdapter.recordLegacyHuddleLeave",
  "huddleCompatibilityAdapter.recordLegacyHuddleDecline",
  "huddleCompatibilityAdapter.verifyParticipantSnapshot",
]) {
  assertIncludes(socket, method, "socket adapter routing");
}

for (const eventName of [
  "huddle:start",
  "huddle:join",
  "huddle:leave",
  "huddle:end",
  "huddle:decline",
  "huddle:signal",
  "huddle:mute",
  "huddle:unmute",
  "huddle:camera-on",
  "huddle:camera-off",
]) {
  assertIncludes(mobileSocket, eventName, "mobile huddle event contract");
}
assertIncludes(mobileSocket, "huddle:sync", "mobile reconnect sync contract");
assertIncludes(mobileSocket, "huddle:error", "mobile authorization error contract");

for (const eventName of [
  "huddle:started",
  "huddle:ended",
  "huddle:declined",
  "huddle:user-joined",
  "huddle:user-left",
  "huddle:participants",
  "huddle:signal",
]) {
  assertIncludes(socket, eventName, "server socket event contract");
}

for (const payloadField of [
  "channelId",
  "workspaceId",
  "huddleId",
  "startedBy",
  "endedBy",
  "participants",
]) {
  assertIncludes(socket, payloadField, "legacy payload field");
}

assertIncludes(socket, 'type: "huddle"', "huddle notification type");
assertIncludes(socket, "/chat?channel=", "huddle deep link");
for (const pushField of ["huddleId", "channelId", "startedByName", "startedBy"]) {
  assertIncludes(socket, pushField, "huddle notification extraData");
}

for (const tableName of [
  "huddle_sessions",
  "huddle_session_participants",
  "huddle_session_events",
  "huddle_participant_devices",
  "huddle_guests",
  "huddle_artifacts",
]) {
  assertIncludes(migration, `CREATE TABLE IF NOT EXISTS ${tableName}`, "huddle migration table");
}

assertIncludes(migration, "CREATE EXTENSION IF NOT EXISTS pgcrypto", "migration pgcrypto readiness");
assertIncludes(migration, "CREATE UNIQUE INDEX IF NOT EXISTS uniq_huddle_sessions_active_scope", "active scope index");
assertIncludes(migration, "CREATE UNIQUE INDEX IF NOT EXISTS uniq_huddle_sessions_legacy_huddle", "legacy huddle index");
assertIncludes(hardeningMigration, "ADD COLUMN IF NOT EXISTS workspace_id UUID", "legacy workspace ownership");
assertIncludes(hardeningMigration, "huddle_devices_participant_session_workspace_fk", "device ownership constraint");
assertIncludes(hardeningMigration, "huddle_artifacts_source_event_session_workspace_fk", "artifact event ownership constraint");
assertIncludes(hardeningMigration, "huddle_events_actor_identity_check", "event actor ownership constraint");
assertIncludes(hardeningMigration, "validate_huddle_participant_ownership", "participant ownership validation");
assertIncludes(restorationReadinessMigration, "logical_device_id", "logical device identity schema");
assertIncludes(restorationReadinessMigration, "huddle_recovery_fences", "durable recovery fence table");
assertIncludes(restorationReadinessMigration, "huddle_restore_attempts", "restore idempotency table");
assertIncludes(restorationReadinessMigration, "uniq_huddle_devices_active_logical_device", "active logical device uniqueness");
assertIncludes(sessionService, "INSERT INTO chat_huddles (workspace_id", "workspace-scoped legacy write");
assertIncludes(sessionService, "WHERE h.workspace_id = $1", "workspace-scoped legacy read");
assertIncludes(adapter, "legacy_active_session_shadow_failed", "legacy-only session degradation");
assertIncludes(adapter, "legacyEndOk: true", "legacy-authoritative end behavior");

for (const destructivePattern of [
  /\bDROP\s+TABLE\b/i,
  /\bTRUNCATE\b/i,
  /\bDELETE\s+FROM\s+chat_huddles\b/i,
  /\bALTER\s+TABLE\s+chat_huddles\s+DROP\b/i,
]) {
  assertNotMatches(migration, destructivePattern, "migration rollback safety");
  assertNotMatches(hardeningMigration, destructivePattern, "hardening migration rollback safety");
  assertNotMatches(restorationReadinessMigration, destructivePattern, "restoration readiness migration rollback safety");
}

for (const mismatch of [
  "missing_session",
  "missing_legacy_row",
  "participant_mismatch",
  "state_mismatch",
  "event_mismatch",
]) {
  assertIncludes(adapter, mismatch, "adapter mismatch classification");
}

assertIncludes(adapter, "session.repaired", "adapter repair event");
assertIncludes(adapter, "legacy_session_repair", "adapter repair metadata");
assertIncludes(adapter, "validateMigrationReadiness", "adapter migration readiness API");

console.log("Huddle compatibility adapter verification passed.");
console.log("- Socket handlers use the adapter as the legacy persistence boundary.");
console.log("- Mobile huddle event names are unchanged.");
console.log("- Legacy socket event names and core payload fields are still present.");
console.log("- Huddle notification type, deep link, and extraData fields are still present.");
console.log("- Migration is additive/idempotent and contains required session-domain tables.");
console.log("- Legacy Huddles are workspace-scoped and session failures degrade safely.");
console.log("- Huddle realtime broadcasts and in-memory rooms are workspace-scoped.");
