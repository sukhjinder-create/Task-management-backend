import assert from "node:assert/strict";

import { HuddleRecoveryService } from "../services/huddleRecovery.service.js";

function room(overrides = {}) {
  return {
    huddleId: "huddle-a",
    channelId: "team-general",
    workspaceId: "workspace-a",
    participantIds: ["user-1", "user-2"],
    participantCount: 2,
    participants: [
      { userId: "user-1", username: "One" },
      { userId: "user-2", username: "Two" },
    ],
    startedBy: { userId: "user-1", username: "One" },
    startedAt: "2026-06-04T00:00:00.000Z",
    sessionId: "session-a",
    scope: { type: "channel", channelId: "team-general", workspaceId: "workspace-a" },
    ...overrides,
  };
}

function baseParams(overrides = {}) {
  return {
    source: "test",
    workspaceId: "workspace-a",
    channelId: "team-general",
    huddleId: "huddle-a",
    userId: "user-1",
    username: "One",
    scope: { type: "channel", channelId: "team-general", workspaceId: "workspace-a" },
    localRoom: room(),
    session: {
      id: "session-a",
      state: "live",
      started_at: "2026-06-04T00:00:00.000Z",
      updated_at: "2026-06-04T00:00:01.000Z",
      host_user_id: "user-1",
    },
    deviceContext: {
      deviceId: "web-1",
      platform: "web",
      socketId: "socket-1",
    },
    access: { ok: true },
    ...overrides,
  };
}

function makeService(options = {}) {
  return new HuddleRecoveryService({
    enabled: true,
    snapshotExposureEnabled: false,
    snapshotTtlMs: 30000,
    participantLimit: 50,
    softLimitBytes: 8192,
    hardLimitBytes: 32768,
    ...options,
  });
}

function assertSnapshotShape(result) {
  assert.equal(result.ok, true);
  assert.equal(result.enabled, true);
  assert.equal(result.snapshot.type, "huddle_recovery_snapshot");
  assert.equal(result.snapshot.version, 1);
  assert.equal(typeof result.snapshot.snapshotId, "string");
  assert.equal(typeof result.snapshot.expiresAt, "string");
  assert.equal(typeof result.snapshot.generation, "number");
  assert.equal(typeof result.snapshot.sessionVersion, "number");
  assert.equal(result.snapshot.decision.restoreAllowed, false);
  assert.equal(result.snapshot.limits.bytes <= result.snapshot.limits.hardLimitBytes, true);
}

function assertExposed(result) {
  assert.equal(result.exposure.exposed, true);
  assert.equal(result.exposure.rejected, false);
  assert.equal(result.exposure.metadata.recoverySnapshot.type, "huddle_recovery_snapshot");
  assert.equal(typeof result.exposure.metadata.recoverySnapshot.expiresAt, "string");
  assert.equal(typeof result.exposure.metadata.recoverySnapshot.generation, "number");
  assert.equal(typeof result.exposure.metadata.recoverySnapshot.sessionVersion, "number");
}

function verifyBrowserRefreshRecovery() {
  const service = makeService();
  const result = service.evaluate(baseParams({
    source: "browser_refresh",
    deviceContext: { deviceId: "web-1", platform: "web", socketId: "socket-new" },
  }));

  assertSnapshotShape(result);
  assert.equal(result.decision.status, "recoverable");
  assert.equal(result.decision.reason, "live_session");
  assert.equal(result.snapshot.self.participantState, "joined");
  assert.equal(result.snapshot.self.devices[0].deviceId, "web-1");
  assert.equal(result.exposure.exposed, false);
  assert.equal(result.exposure.reason, "snapshot_exposure_disabled");
}

function verifyDuplicateReconnectGeneration() {
  const service = makeService();
  const first = service.evaluate(baseParams({
    source: "duplicate_reconnect:first",
    deviceContext: { deviceId: "web-1", platform: "web", socketId: "socket-a" },
  }));
  const second = service.evaluate(baseParams({
    source: "duplicate_reconnect:second",
    deviceContext: { deviceId: "web-1", platform: "web", socketId: "socket-b" },
  }));

  assertSnapshotShape(first);
  assertSnapshotShape(second);
  assert.equal(second.snapshot.generation, first.snapshot.generation + 1);
  assert.equal(second.snapshot.sessionVersion, first.snapshot.sessionVersion);
}

function verifyMobileResumeRecovery() {
  const service = makeService();
  const result = service.evaluate(baseParams({
    source: "mobile_resume",
    deviceContext: { deviceId: "android-1", platform: "android", socketId: "socket-mobile" },
    heartbeatDiagnostics: {
      lastHeartbeatAt: "2026-06-04T00:00:10.000Z",
      heartbeatAgeMs: 1200,
      staleDeviceCount: 0,
      staleParticipantCount: 0,
    },
  }));

  assertSnapshotShape(result);
  assert.equal(result.decision.status, "recoverable");
  assert.equal(result.snapshot.self.devices[0].platform, "android");
  assert.equal(result.snapshot.diagnostics.source.heartbeat, "redis_shadow");
  assert.equal(result.snapshot.diagnostics.heartbeatAgeMs, 1200);
}

function verifyReconnectAfterEnd() {
  const service = makeService();
  const result = service.evaluate(baseParams({
    source: "reconnect_after_end",
    localRoom: null,
    active: null,
    session: {
      id: "session-a",
      state: "ended",
      started_at: "2026-06-04T00:00:00.000Z",
      ended_at: "2026-06-04T00:01:00.000Z",
      updated_at: "2026-06-04T00:01:00.000Z",
      host_user_id: "user-1",
    },
  }));

  assertSnapshotShape(result);
  assert.equal(result.decision.status, "ended");
  assert.equal(result.decision.reason, "session_ended");
  assert.equal(result.snapshot.session.state, "ended");
}

function verifyAccessDenied() {
  const service = makeService();
  const result = service.evaluate(baseParams({
    source: "access_denied",
    localRoom: null,
    session: null,
    active: null,
    access: { ok: false, reason: "channel_membership_required" },
  }));

  assertSnapshotShape(result);
  assert.equal(result.decision.status, "access_denied");
  assert.equal(result.decision.reason, "channel_membership_required");
}

function verifySizeCap() {
  const service = makeService({ participantLimit: 500, hardLimitBytes: 4096, softLimitBytes: 2048 });
  const participants = Array.from({ length: 500 }, (_, index) => ({
    userId: `user-${index}`,
    username: `Participant ${index} With A Rather Long Generated Name`,
  }));
  const result = service.evaluate(baseParams({
    source: "large_snapshot",
    localRoom: room({
      participantIds: participants.map((participant) => participant.userId),
      participantCount: participants.length,
      participants,
    }),
  }));

  assertSnapshotShape(result);
  assert.equal(result.snapshot.limits.bytes <= 4096, true);
  assert.equal(result.snapshot.limits.truncated, true);
  assert.equal(result.snapshot.participants.truncated, true);
}

function verifyDisabledMode() {
  const service = new HuddleRecoveryService({ enabled: false });
  const result = service.evaluate(baseParams({ source: "disabled" }));
  assert.equal(result.ok, true);
  assert.equal(result.enabled, false);
  assert.equal(result.snapshot, null);
  assert.equal(result.decision.status, "not_evaluated");
}

function verifySmallSessionExposure() {
  const service = makeService({ snapshotExposureEnabled: true });
  const result = service.evaluate(baseParams({ source: "small_session_exposure" }));
  assertSnapshotShape(result);
  assertExposed(result);
  assert.equal(result.exposure.metadata.recoverySnapshot.limits.truncated, false);

  const diagnostics = service.getDiagnostics();
  assert.equal(diagnostics.snapshotsGenerated, 1);
  assert.equal(diagnostics.snapshotsExposed, 1);
  assert.equal(diagnostics.snapshotsRejected, 0);
}

function verifyLargeSessionExposure() {
  const service = makeService({ snapshotExposureEnabled: true, participantLimit: 50 });
  const participants = Array.from({ length: 75 }, (_, index) => ({
    userId: `user-${index}`,
    username: `Participant ${index}`,
  }));
  const result = service.evaluate(baseParams({
    source: "large_session_exposure",
    localRoom: room({
      participantIds: participants.map((participant) => participant.userId),
      participantCount: participants.length,
      participants,
    }),
  }));
  assertSnapshotShape(result);
  assertExposed(result);
  assert.equal(result.exposure.metadata.recoverySnapshot.participants.total, 75);
  assert.equal(result.exposure.metadata.recoverySnapshot.participants.included, 50);
  assert.equal(result.exposure.metadata.recoverySnapshot.participants.truncated, true);
}

function verifyTruncatedSessionExposure() {
  const service = makeService({
    snapshotExposureEnabled: true,
    participantLimit: 500,
    hardLimitBytes: 4096,
    softLimitBytes: 2048,
  });
  const participants = Array.from({ length: 500 }, (_, index) => ({
    userId: `user-${index}`,
    username: `Participant ${index} With A Rather Long Generated Name`,
  }));
  const result = service.evaluate(baseParams({
    source: "truncated_session_exposure",
    localRoom: room({
      participantIds: participants.map((participant) => participant.userId),
      participantCount: participants.length,
      participants,
    }),
  }));
  assertSnapshotShape(result);
  assertExposed(result);
  assert.equal(result.exposure.metadata.recoverySnapshot.limits.bytes <= 4096, true);
  assert.equal(result.exposure.metadata.recoverySnapshot.limits.truncated, true);
  assert.equal(result.exposure.metadata.recoverySnapshot.participants.items.length, 0);
}

function verifyEndedSessionExposure() {
  const service = makeService({ snapshotExposureEnabled: true });
  const result = service.evaluate(baseParams({
    source: "ended_session_exposure",
    localRoom: null,
    active: null,
    session: {
      id: "session-a",
      state: "ended",
      started_at: "2026-06-04T00:00:00.000Z",
      ended_at: "2026-06-04T00:01:00.000Z",
      updated_at: "2026-06-04T00:01:00.000Z",
    },
  }));
  assertSnapshotShape(result);
  assertExposed(result);
  assert.equal(result.exposure.metadata.recoverySnapshot.decision.status, "ended");
  assert.equal(result.exposure.metadata.recoverySnapshot.decision.restoreAllowed, false);
}

function verifyAccessDeniedExposureRejected() {
  const service = makeService({ snapshotExposureEnabled: true });
  const result = service.evaluate(baseParams({
    source: "access_denied_exposure",
    localRoom: null,
    session: null,
    active: null,
    access: { ok: false, reason: "channel_membership_required" },
  }));
  assertSnapshotShape(result);
  assert.equal(result.exposure.exposed, false);
  assert.equal(result.exposure.rejected, true);
  assert.equal(result.exposure.reason, "access_denied");

  const diagnostics = service.getDiagnostics();
  assert.equal(diagnostics.snapshotsGenerated, 1);
  assert.equal(diagnostics.snapshotsExposed, 0);
  assert.equal(diagnostics.snapshotsRejected, 1);
}

verifyBrowserRefreshRecovery();
verifyDuplicateReconnectGeneration();
verifyMobileResumeRecovery();
verifyReconnectAfterEnd();
verifyAccessDenied();
verifySizeCap();
verifyDisabledMode();
verifySmallSessionExposure();
verifyLargeSessionExposure();
verifyTruncatedSessionExposure();
verifyEndedSessionExposure();
verifyAccessDeniedExposureRejected();

console.log("Huddle recovery verification passed.");
console.log("- Browser refresh, duplicate reconnect, and mobile resume produce shadow snapshots.");
console.log("- Reconnect after end and access denied are classified without restoration.");
console.log("- Snapshots include expiresAt, generation, and sessionVersion.");
console.log("- Snapshot hard-size capping truncates optional details.");
console.log("- Disabled mode performs no snapshot generation.");
console.log("- Optional snapshot exposure is feature-flagged and rejects access-denied snapshots.");
