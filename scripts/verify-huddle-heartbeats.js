import assert from "node:assert/strict";

import LocalRealtimeProvider from "../realtime/huddle/localRealtimeProvider.js";
import RedisRealtimeProvider from "../realtime/huddle/redisRealtimeProvider.js";

function bulk(value) {
  if (value === null || value === undefined) return "$-1\r\n";
  return `$${Buffer.byteLength(value)}\r\n${value}\r\n`;
}

class MemoryRedisClient {
  constructor({ failWrites = false } = {}) {
    this.values = new Map();
    this.failWrites = failWrites;
    this.lastHealth = {
      ok: true,
      status: "healthy",
      latencyMs: 0,
      checkedAt: new Date().toISOString(),
      error: null,
      url: "memory://redis",
    };
  }

  async ping() {
    return this.lastHealth;
  }

  getDiagnostics() {
    return this.lastHealth;
  }

  async runMany(commands = []) {
    if (this.failWrites) throw new Error("memory_redis_write_failed");
    return commands.map((command) => {
      const [op, ...args] = command;
      if (op === "SET") {
        this.values.set(args[0], args[1]);
        return "+OK\r\n";
      }
      if (op === "DEL") {
        let count = 0;
        for (const key of args) {
          if (this.values.delete(key)) count += 1;
        }
        return `:${count}\r\n`;
      }
      if (op === "GET") {
        return bulk(this.values.get(args[0]) ?? null);
      }
      throw new Error(`unsupported_memory_redis_command:${op}`);
    });
  }
}

function makeProvider(redisClient, options = {}) {
  return new RedisRealtimeProvider({
    localProvider: new LocalRealtimeProvider(),
    redisEnabled: true,
    redisRequired: false,
    shadowWriteEnabled: false,
    heartbeatsEnabled: true,
    heartbeatTtl: 60,
    heartbeatStaleAfter: 1000,
    healthClient: redisClient,
    commandClient: redisClient,
    ...options,
  });
}

async function flush(provider) {
  await provider.flushShadowWrites();
}

function findKey(redisClient, fragment) {
  return [...redisClient.values.keys()].find((key) => key.includes(fragment));
}

function createRoom(provider, participants = [{ userId: "user-1", username: "One" }]) {
  return provider.createRoom({
    workspaceId: "workspace-a",
    huddleId: "huddle-a",
    channelId: "team-general",
    participants,
    startedBy: { userId: "user-1", username: "One" },
    startedAt: new Date().toISOString(),
    sessionId: "session-a",
    scope: { type: "channel", channelId: "team-general", workspaceId: "workspace-a" },
  });
}

async function verifyHeartbeatWrite() {
  const redisClient = new MemoryRedisClient();
  const provider = makeProvider(redisClient);
  createRoom(provider);

  const heartbeat = provider.recordHeartbeat({
    workspaceId: "workspace-a",
    huddleId: "huddle-a",
    channelId: "team-general",
    userId: "user-1",
    username: "One",
    deviceId: "web-1",
    platform: "web",
    clientSentAt: Date.now() - 25,
    sequence: 1,
  });
  assert.equal(heartbeat.ok, true);
  assert.equal(heartbeat.supported, true);
  assert.equal(heartbeat.shadow, true);
  await flush(provider);

  assert.ok(findKey(redisClient, "huddle:heartbeat:session:workspace-a:huddle-a"));
  assert.ok(findKey(redisClient, "huddle:heartbeat:participant:workspace-a:huddle-a:user-1"));
  assert.ok(findKey(redisClient, "huddle:heartbeat:device:workspace-a:huddle-a:user-1:device%3Aweb-1"));

  const diagnostics = provider.getDiagnostics();
  assert.equal(diagnostics.local.participantCount, 1);
  assert.equal(diagnostics.heartbeats.successes, 1);
  assert.equal(diagnostics.heartbeats.failures, 0);
  assert.equal(diagnostics.heartbeats.observedDeviceCount, 1);
  assert.equal(diagnostics.heartbeats.staleDevices.length, 0);
  assert.equal(diagnostics.heartbeats.staleParticipants.length, 0);
  assert.equal(typeof diagnostics.heartbeats.lastLatencyMs, "number");
}

async function verifyStaleDetection() {
  const redisClient = new MemoryRedisClient();
  const provider = makeProvider(redisClient);
  createRoom(provider, [
    { userId: "user-1", username: "One" },
    { userId: "user-2", username: "Two" },
  ]);

  const staleAt = new Date(Date.now() - 5000).toISOString();
  provider.recordHeartbeat({
    workspaceId: "workspace-a",
    huddleId: "huddle-a",
    channelId: "team-general",
    userId: "user-1",
    username: "One",
    deviceId: "web-1",
    serverReceivedAt: staleAt,
  });
  await flush(provider);

  const diagnostics = provider.getDiagnostics();
  assert.equal(diagnostics.heartbeats.staleDevices.length, 1);
  assert.equal(
    diagnostics.heartbeats.staleParticipants.some((participant) => participant.userId === "user-1" && participant.reason === "all_devices_stale"),
    true
  );
  assert.equal(
    diagnostics.heartbeats.staleParticipants.some((participant) => participant.userId === "user-2" && participant.reason === "missing_heartbeat"),
    true
  );
  assert.equal(diagnostics.heartbeats.missedHeartbeats, 2);
}

async function verifyBestEffortFailure() {
  const redisClient = new MemoryRedisClient({ failWrites: true });
  const provider = makeProvider(redisClient);
  createRoom(provider);

  const heartbeat = provider.recordHeartbeat({
    workspaceId: "workspace-a",
    huddleId: "huddle-a",
    channelId: "team-general",
    userId: "user-1",
  });
  assert.equal(heartbeat.ok, true);
  await flush(provider);

  const diagnostics = provider.getDiagnostics();
  assert.equal(diagnostics.local.participantCount, 1);
  assert.equal(diagnostics.heartbeats.failures, 1);
  assert.equal(diagnostics.degraded, true);
  assert.match(diagnostics.heartbeats.lastError, /memory_redis_write_failed/);
}

async function verifyDisabledMode() {
  const redisClient = new MemoryRedisClient();
  const provider = makeProvider(redisClient, { heartbeatsEnabled: false });
  createRoom(provider);

  const heartbeat = provider.recordHeartbeat({
    workspaceId: "workspace-a",
    huddleId: "huddle-a",
    channelId: "team-general",
    userId: "user-1",
  });
  assert.equal(heartbeat.ok, true);
  assert.equal(heartbeat.supported, false);
  await flush(provider);
  assert.equal(findKey(redisClient, "huddle:heartbeat:"), undefined);
}

await verifyHeartbeatWrite();
await verifyStaleDetection();
await verifyBestEffortFailure();
await verifyDisabledMode();

console.log("Huddle heartbeat verification passed.");
console.log("- Heartbeat snapshots are written to Redis in shadow mode.");
console.log("- LocalRealtimeProvider remains authoritative.");
console.log("- Stale device and stale participant diagnostics are detected.");
console.log("- Redis heartbeat failures degrade diagnostics only.");
