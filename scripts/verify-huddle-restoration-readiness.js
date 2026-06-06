import assert from "node:assert/strict";

import LocalRealtimeProvider from "../realtime/huddle/localRealtimeProvider.js";
import { HuddleRecoveryService } from "../services/huddleRecovery.service.js";
import { MemoryHuddleRecoveryFenceStore } from "../services/huddleRecoveryFence.service.js";
import { HuddleRestorationValidator } from "../services/huddleRestorationValidator.service.js";

const liveSession = {
  id: "session-a",
  workspace_id: "workspace-a",
  legacy_huddle_id: "huddle-a",
  legacy_channel_key: "team-general",
  state: "live",
  started_at: "2026-06-04T00:00:00.000Z",
  updated_at: "2026-06-04T00:00:01.000Z",
};

const joinedParticipant = {
  id: "participant-a",
  session_id: "session-a",
  workspace_id: "workspace-a",
  user_id: "user-1",
  join_state: "joined",
  role: "participant",
};

function makeSnapshot(overrides = {}) {
  return {
    type: "huddle_recovery_snapshot",
    version: 1,
    snapshotId: "snapshot-a",
    generatedAt: "2026-06-04T00:00:02.000Z",
    expiresAt: "2026-06-04T00:01:00.000Z",
    generation: 1,
    sessionVersion: Date.parse(liveSession.updated_at),
    workspaceId: "workspace-a",
    sessionId: "session-a",
    huddleId: "huddle-a",
    channelId: "team-general",
    self: {
      userId: "user-1",
      participantState: "joined",
      devices: [{ deviceId: "web-1", platform: "web" }],
    },
    decision: { status: "recoverable", restoreAllowed: false },
    ...overrides,
  };
}

function makeValidator({
  fenceStore = new MemoryHuddleRecoveryFenceStore(),
  session = liveSession,
  participant = joinedParticipant,
} = {}) {
  return {
    fenceStore,
    validator: new HuddleRestorationValidator({
      fenceService: fenceStore,
      now: () => Date.parse("2026-06-04T00:00:10.000Z"),
      checkWorkspaceAccess: async () => ({ ok: true }),
      loadSession: async () => session,
      loadParticipant: async () => participant,
    }),
  };
}

function verifyDuplicateReconnectRuntimePresence() {
  const provider = new LocalRealtimeProvider();
  provider.createRoom({
    workspaceId: "workspace-a",
    huddleId: "huddle-a",
    channelId: "team-general",
    participants: [{
      userId: "user-1",
      username: "One",
      deviceId: "web-1",
      socketId: "socket-a",
      platform: "web",
    }],
    startedBy: { userId: "user-1", username: "One" },
    sessionId: "session-a",
  });

  const duplicate = provider.joinDevice({
    workspaceId: "workspace-a",
    huddleId: "huddle-a",
    channelId: "team-general",
    userId: "user-1",
    username: "One",
    deviceId: "web-1",
    socketId: "socket-b",
    platform: "web",
  });

  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.duplicateDevice, true);
  assert.equal(duplicate.participantCount, 1);
  assert.equal(duplicate.deviceCount, 1);
  assert.equal(duplicate.room.devices[0].socketId, "socket-b");
}

function verifyStaleDisconnectCannotRemoveHealthyDevice() {
  const provider = new LocalRealtimeProvider();
  provider.createRoom({
    workspaceId: "workspace-a",
    huddleId: "huddle-a",
    channelId: "team-general",
    participants: [{
      userId: "user-1",
      username: "One",
      deviceId: "web-1",
      socketId: "socket-a",
      platform: "web",
    }],
    sessionId: "session-a",
  });
  provider.joinDevice({
    workspaceId: "workspace-a",
    huddleId: "huddle-a",
    channelId: "team-general",
    userId: "user-1",
    username: "One",
    deviceId: "web-1",
    socketId: "socket-b",
    platform: "web",
  });

  const staleChanges = provider.leaveDeviceFromAllRooms({
    userId: "user-1",
    socketId: "socket-a",
    deviceId: "web-1",
  });
  assert.equal(staleChanges.length, 0);
  assert.equal(provider.getPresence({ workspaceId: "workspace-a", huddleId: "huddle-a" }).participantCount, 1);

  const currentChanges = provider.leaveDeviceFromAllRooms({
    userId: "user-1",
    socketId: "socket-b",
    deviceId: "web-1",
  });
  assert.equal(currentChanges.length, 1);
  assert.equal(currentChanges[0].participantCount, 0);
  assert.equal(currentChanges[0].shouldEnd, true);
}

async function verifyDurableFenceGeneration() {
  const fenceStore = new MemoryHuddleRecoveryFenceStore();
  const service = new HuddleRecoveryService({
    enabled: true,
    fenceService: fenceStore,
    snapshotTtlMs: 30000,
  });
  const params = {
    source: "readiness",
    workspaceId: "workspace-a",
    channelId: "team-general",
    huddleId: "huddle-a",
    userId: "user-1",
    username: "One",
    localRoom: {
      workspaceId: "workspace-a",
      channelId: "team-general",
      huddleId: "huddle-a",
      participantIds: ["user-1"],
      participants: [{ userId: "user-1", username: "One" }],
      startedAt: liveSession.started_at,
      sessionId: "session-a",
    },
    session: liveSession,
    deviceContext: { deviceId: "web-1", socketId: "socket-a", platform: "web" },
  };

  const first = await service.evaluateDurable(params);
  const second = await service.evaluateDurable({ ...params, deviceContext: { deviceId: "web-1", socketId: "socket-b", platform: "web" } });

  assert.equal(first.snapshot.generation, 1);
  assert.equal(second.snapshot.generation, 2);
  assert.equal(second.snapshot.sessionVersion, Date.parse(liveSession.updated_at));
  assert.equal(service.getDiagnostics().durableFencesReserved, 2);
}

async function verifySessionEndedRaceRejected() {
  const { validator } = makeValidator({
    session: {
      ...liveSession,
      state: "ended",
      ended_at: "2026-06-04T00:00:05.000Z",
      updated_at: "2026-06-04T00:00:05.000Z",
    },
  });
  const result = await validator.validate({ snapshot: makeSnapshot() });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "session_ended");
}

async function verifyDeclinedParticipantRejected() {
  const { validator } = makeValidator({
    participant: { ...joinedParticipant, join_state: "declined" },
  });
  const result = await validator.validate({ snapshot: makeSnapshot() });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "participant_declined");
}

async function verifyRemovedParticipantRejected() {
  const { validator } = makeValidator({
    participant: { ...joinedParticipant, join_state: "removed" },
  });
  const result = await validator.validate({ snapshot: makeSnapshot() });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "participant_removed");
}

async function verifyStaleGenerationRejected() {
  const { validator, fenceStore } = makeValidator();
  await fenceStore.reserveSnapshotFence({
    workspaceId: "workspace-a",
    sessionId: "session-a",
    huddleId: "huddle-a",
    channelId: "team-general",
    userId: "user-1",
    logicalDeviceId: "device:web-1",
    sessionVersion: Date.parse(liveSession.updated_at),
  });
  await fenceStore.reserveSnapshotFence({
    workspaceId: "workspace-a",
    sessionId: "session-a",
    huddleId: "huddle-a",
    channelId: "team-general",
    userId: "user-1",
    logicalDeviceId: "device:web-1",
    sessionVersion: Date.parse(liveSession.updated_at),
  });

  const result = await validator.validate({ snapshot: makeSnapshot({ generation: 1 }) });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "stale_generation");
}

async function verifyStaleSessionVersionRejected() {
  const { validator } = makeValidator({
    session: {
      ...liveSession,
      updated_at: "2026-06-04T00:00:20.000Z",
    },
  });
  const result = await validator.validate({ snapshot: makeSnapshot({ sessionVersion: Date.parse(liveSession.updated_at) }) });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "stale_session_version");
}

async function verifyRestoreIdempotency() {
  const { validator, fenceStore } = makeValidator();
  await fenceStore.reserveSnapshotFence({
    workspaceId: "workspace-a",
    sessionId: "session-a",
    huddleId: "huddle-a",
    channelId: "team-general",
    userId: "user-1",
    logicalDeviceId: "device:web-1",
    sessionVersion: Date.parse(liveSession.updated_at),
  });
  const snapshot = makeSnapshot({ generation: 1, idempotencyKey: "restore-key-a" });
  const first = await validator.validate({ snapshot });
  const second = await validator.validate({ snapshot });

  assert.equal(first.ok, true);
  assert.equal(first.restoreAllowed, false);
  assert.equal(first.idempotent, false);
  assert.equal(second.ok, true);
  assert.equal(second.idempotent, true);
}

verifyDuplicateReconnectRuntimePresence();
verifyStaleDisconnectCannotRemoveHealthyDevice();
await verifyDurableFenceGeneration();
await verifySessionEndedRaceRejected();
await verifyDeclinedParticipantRejected();
await verifyRemovedParticipantRejected();
await verifyStaleGenerationRejected();
await verifyStaleSessionVersionRejected();
await verifyRestoreIdempotency();

console.log("Huddle restoration readiness verification passed.");
console.log("- Duplicate reconnects update one logical device instead of duplicating participants/devices.");
console.log("- Stale disconnects do not remove healthy logical devices.");
console.log("- Ended, declined, removed, stale-generation, and stale-session snapshots are rejected.");
console.log("- Restore idempotency keys are repeat-safe while restoration remains disabled.");
