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

async function flush(provider) {
  await provider.flushShadowWrites();
}

function makeProvider(redisClient) {
  return new RedisRealtimeProvider({
    localProvider: new LocalRealtimeProvider(),
    redisEnabled: true,
    redisRequired: false,
    shadowWriteEnabled: true,
    shadowPresenceTtlSeconds: 300,
    healthClient: redisClient,
    commandClient: redisClient,
  });
}

function findKey(redisClient, fragment) {
  return [...redisClient.values.keys()].find((key) => key.includes(fragment));
}

async function verifyShadowWriteLifecycle() {
  const redisClient = new MemoryRedisClient();
  const provider = makeProvider(redisClient);

  const started = provider.createRoom({
    workspaceId: "workspace-a",
    huddleId: "huddle-a",
    channelId: "team-general",
    participants: [{ userId: "user-1", username: "One" }],
    startedBy: { userId: "user-1", username: "One" },
    startedAt: "2026-06-04T00:00:00.000Z",
    sessionId: "session-a",
    scope: { type: "channel", channelId: "team-general", workspaceId: "workspace-a" },
  });
  assert.equal(started.participantCount, 1);
  await flush(provider);

  let diagnostics = provider.getDiagnostics();
  assert.equal(diagnostics.local.participantCount, 1);
  assert.equal(diagnostics.shadowPresence.successes, 1);
  assert.equal(diagnostics.shadowPresence.lastComparison.mismatchCount, 0);
  assert.ok(findKey(redisClient, "huddle:presence:session:workspace-a:huddle-a"));
  assert.ok(findKey(redisClient, "huddle:presence:participant:workspace-a:huddle-a:user-1"));
  assert.ok(findKey(redisClient, "huddle:presence:device:workspace-a:huddle-a:legacy%3Auser-1"));

  const joined = provider.joinDevice({
    workspaceId: "workspace-a",
    huddleId: "huddle-a",
    channelId: "team-general",
    userId: "user-2",
    username: "Two",
    sessionId: "session-a",
  });
  assert.equal(joined.ok, true);
  assert.equal(joined.participantCount, 2);
  await flush(provider);

  diagnostics = provider.getDiagnostics();
  assert.equal(diagnostics.local.participantCount, 2);
  assert.equal(diagnostics.shadowPresence.lastComparison.mismatchCount, 0);
  assert.ok(findKey(redisClient, "huddle:presence:participant:workspace-a:huddle-a:user-2"));
  assert.ok(findKey(redisClient, "huddle:presence:device:workspace-a:huddle-a:legacy%3Auser-2"));

  const left = provider.leaveDevice({
    workspaceId: "workspace-a",
    huddleId: "huddle-a",
    userId: "user-2",
  });
  assert.equal(left.ok, true);
  assert.equal(left.participantCount, 1);
  await flush(provider);

  diagnostics = provider.getDiagnostics();
  assert.equal(diagnostics.local.participantCount, 1);
  assert.equal(diagnostics.shadowPresence.lastComparison.mismatchCount, 0);
  assert.equal(findKey(redisClient, "huddle:presence:participant:workspace-a:huddle-a:user-2"), undefined);
  assert.equal(findKey(redisClient, "huddle:presence:device:workspace-a:huddle-a:legacy%3Auser-2"), undefined);

  assert.equal(provider.deleteRoom({ workspaceId: "workspace-a", huddleId: "huddle-a" }), true);
  await flush(provider);
  diagnostics = provider.getDiagnostics();
  assert.equal(diagnostics.local.sessionCount, 0);
  assert.equal(diagnostics.shadowPresence.lastComparison.mismatchCount, 0);
  assert.equal(redisClient.values.size, 0);
}

async function verifyBestEffortFailure() {
  const redisClient = new MemoryRedisClient({ failWrites: true });
  const provider = makeProvider(redisClient);

  const started = provider.createRoom({
    workspaceId: "workspace-a",
    huddleId: "huddle-failure",
    channelId: "team-general",
    participants: [{ userId: "user-1", username: "One" }],
  });
  assert.equal(started.participantCount, 1);
  await flush(provider);

  const diagnostics = provider.getDiagnostics();
  assert.equal(diagnostics.local.participantCount, 1);
  assert.equal(diagnostics.shadowPresence.failures, 1);
  assert.equal(diagnostics.degraded, true);
  assert.match(diagnostics.shadowPresence.lastError, /memory_redis_write_failed/);
}

await verifyShadowWriteLifecycle();
await verifyBestEffortFailure();

console.log("Huddle shadow presence verification passed.");
console.log("- Redis shadow writes mirror session, participant, and legacy device presence.");
console.log("- LocalRealtimeProvider remains authoritative for behavior.");
console.log("- Shadow Redis failures are best-effort and only affect diagnostics.");
console.log("- Shadow diagnostics report local-vs-Redis comparison results.");
