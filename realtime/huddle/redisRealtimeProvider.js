import net from "node:net";
import tls from "node:tls";

import LocalRealtimeProvider from "./localRealtimeProvider.js";

function parseBoolean(value) {
  return String(value || "").trim().toLowerCase() === "true";
}

function nowIso() {
  return new Date().toISOString();
}

function keyPart(value) {
  return encodeURIComponent(String(value ?? "unknown"));
}

function shadowTtlSeconds(value) {
  const parsed = Number(value || 300);
  if (!Number.isFinite(parsed) || parsed <= 0) return 300;
  return Math.max(30, Math.floor(parsed));
}

function heartbeatTtlSeconds(value) {
  const parsed = Number(value || 120);
  if (!Number.isFinite(parsed) || parsed <= 0) return 120;
  return Math.max(30, Math.floor(parsed));
}

function heartbeatStaleAfterMs(value) {
  const parsed = Number(value || 45000);
  if (!Number.isFinite(parsed) || parsed <= 0) return 45000;
  return Math.max(5000, Math.floor(parsed));
}

function redisCommand(parts) {
  const values = parts.map((part) => String(part ?? ""));
  return `*${values.length}\r\n${values.map((part) => `$${Buffer.byteLength(part)}\r\n${part}\r\n`).join("")}`;
}

function isCompleteRespBuffer(buffer) {
  if (!buffer?.length) return false;
  const headerEnd = buffer.indexOf("\r\n");
  if (headerEnd === -1) return false;

  const prefix = String.fromCharCode(buffer[0]);
  if (prefix === "+" || prefix === "-" || prefix === ":") return true;

  if (prefix === "$") {
    const length = Number(buffer.slice(1, headerEnd).toString("utf8"));
    if (length === -1) return true;
    return buffer.length >= headerEnd + 2 + length + 2;
  }

  return true;
}

function parseBulkString(reply) {
  if (!reply || !reply.startsWith("$")) return null;
  const headerEnd = reply.indexOf("\r\n");
  if (headerEnd === -1) return null;
  const length = Number(reply.slice(1, headerEnd));
  if (length === -1) return null;
  return reply.slice(headerEnd + 2, headerEnd + 2 + length);
}

function parseJsonReply(reply) {
  const body = parseBulkString(reply);
  if (!body) return null;
  try {
    return JSON.parse(body);
  } catch (err) {
    return { parseError: err.message, raw: body };
  }
}

function sortedParticipants(snapshot) {
  return [...(snapshot?.participants || [])]
    .map((participant) => ({
      userId: String(participant.userId),
      username: participant.username || "",
    }))
    .sort((a, b) => a.userId.localeCompare(b.userId));
}

function normalizeComparable(value) {
  if (Array.isArray(value)) return value.map(normalizeComparable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => [key, normalizeComparable(entry)])
  );
}

function sameJson(a, b) {
  return JSON.stringify(normalizeComparable(a)) === JSON.stringify(normalizeComparable(b));
}

function shadowSessionKey(workspaceId, huddleId) {
  return `huddle:presence:session:${keyPart(workspaceId)}:${keyPart(huddleId)}`;
}

function shadowParticipantKey(workspaceId, huddleId, userId) {
  return `huddle:presence:participant:${keyPart(workspaceId)}:${keyPart(huddleId)}:${keyPart(userId)}`;
}

function shadowDeviceKey(workspaceId, huddleId, userId) {
  return `huddle:presence:device:${keyPart(workspaceId)}:${keyPart(huddleId)}:${keyPart(`legacy:${userId}`)}`;
}

function heartbeatSessionKey(workspaceId, huddleId) {
  return `huddle:heartbeat:session:${keyPart(workspaceId)}:${keyPart(huddleId)}`;
}

function heartbeatParticipantKey(workspaceId, huddleId, userId) {
  return `huddle:heartbeat:participant:${keyPart(workspaceId)}:${keyPart(huddleId)}:${keyPart(userId)}`;
}

function heartbeatDeviceKey(workspaceId, huddleId, userId, deviceId) {
  return `huddle:heartbeat:device:${keyPart(workspaceId)}:${keyPart(huddleId)}:${keyPart(userId)}:${keyPart(deviceId)}`;
}

function normalizeHeartbeatDeviceId({ deviceId = null, socketId = null, userId = null } = {}) {
  const explicit = typeof deviceId === "string" ? deviceId.trim() : "";
  if (explicit) {
    return explicit.startsWith("device:") || explicit.startsWith("legacy:") || explicit.startsWith("socket:")
      ? explicit
      : `device:${explicit}`;
  }

  const socket = typeof socketId === "string" ? socketId.trim() : "";
  if (socket) return `socket:${socket}`;

  return `legacy:${userId || "unknown"}`;
}

function parseClientSentAt(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  if (typeof value === "number") {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  if (typeof value === "string") {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  return null;
}

function latencyMs(clientSentAt, serverReceivedAt) {
  const client = clientSentAt ? Date.parse(clientSentAt) : NaN;
  const server = serverReceivedAt ? Date.parse(serverReceivedAt) : NaN;
  if (!Number.isFinite(client) || !Number.isFinite(server)) return null;
  return Math.max(0, server - client);
}

function makePresenceDocuments(snapshot, { operation = "unknown", updatedAt = nowIso() } = {}) {
  if (!snapshot) {
    return {
      session: null,
      participants: [],
      devices: [],
    };
  }

  const participants = sortedParticipants(snapshot);
  const participantIds = participants.map((participant) => participant.userId);
  const base = {
    schemaVersion: 1,
    shadow: true,
    localAuthoritative: true,
    operation,
    workspaceId: snapshot.workspaceId,
    huddleId: snapshot.huddleId,
    sessionId: snapshot.sessionId || null,
    channelId: snapshot.channelId,
    updatedAt,
  };

  return {
    session: {
      key: shadowSessionKey(snapshot.workspaceId, snapshot.huddleId),
      value: {
        ...base,
        kind: "session_presence",
        startedBy: snapshot.startedBy || null,
        startedAt: snapshot.startedAt || null,
        scopeType: snapshot.scope?.type || null,
        scopeKey: snapshot.scope?.scopeKey || snapshot.scope?.channelId || snapshot.channelId || null,
        participantIds,
        participantCount: participantIds.length,
      },
    },
    participants: participants.map((participant) => ({
      key: shadowParticipantKey(snapshot.workspaceId, snapshot.huddleId, participant.userId),
      userId: participant.userId,
      value: {
        ...base,
        kind: "participant_presence",
        participantKind: "user",
        userId: participant.userId,
        username: participant.username,
        present: true,
      },
    })),
    devices: participants.map((participant) => ({
      key: shadowDeviceKey(snapshot.workspaceId, snapshot.huddleId, participant.userId),
      userId: participant.userId,
      value: {
        ...base,
        kind: "device_presence",
        participantKind: "user",
        userId: participant.userId,
        username: participant.username,
        deviceId: `legacy:${participant.userId}`,
        source: "legacy_user_presence",
        present: true,
      },
    })),
  };
}

function removalKeys(snapshot, removedUserIds = []) {
  if (!snapshot && !removedUserIds.length) return [];
  const workspaceId = snapshot?.workspaceId;
  const huddleId = snapshot?.huddleId;
  if (!workspaceId || !huddleId) return [];
  const keys = [];
  for (const userId of new Set(removedUserIds.map(String))) {
    keys.push(shadowParticipantKey(workspaceId, huddleId, userId));
    keys.push(shadowDeviceKey(workspaceId, huddleId, userId));
  }
  return keys;
}

function makeHeartbeatDocuments(params = {}) {
  const serverReceivedAt = params.serverReceivedAt || nowIso();
  const clientSentAt = parseClientSentAt(params.clientSentAt);
  const userId = String(params.userId || "");
  const deviceId = normalizeHeartbeatDeviceId({
    deviceId: params.deviceId,
    socketId: params.socketId,
    userId,
  });
  const participantIds = sortedParticipants(params.room).map((participant) => participant.userId);
  const base = {
    schemaVersion: 1,
    shadow: true,
    localAuthoritative: true,
    workspaceId: params.workspaceId,
    huddleId: params.huddleId,
    sessionId: params.sessionId || params.room?.sessionId || null,
    channelId: params.channelId || params.room?.channelId || null,
    userId,
    username: params.username || "",
    deviceId,
    socketId: params.socketId || null,
    platform: params.platform || null,
    sequence: params.sequence ?? null,
    source: params.source || "huddle:heartbeat",
    clientSentAt,
    serverReceivedAt,
    latencyMs: latencyMs(clientSentAt, serverReceivedAt),
  };

  return {
    device: {
      key: heartbeatDeviceKey(params.workspaceId, params.huddleId, userId, deviceId),
      value: {
        ...base,
        kind: "device_heartbeat",
      },
    },
    participant: {
      key: heartbeatParticipantKey(params.workspaceId, params.huddleId, userId),
      value: {
        ...base,
        kind: "participant_heartbeat",
        lastHeartbeatAt: serverReceivedAt,
        latestDeviceId: deviceId,
      },
    },
    session: {
      key: heartbeatSessionKey(params.workspaceId, params.huddleId),
      value: {
        schemaVersion: 1,
        shadow: true,
        localAuthoritative: true,
        kind: "session_heartbeat",
        workspaceId: params.workspaceId,
        huddleId: params.huddleId,
        sessionId: params.sessionId || params.room?.sessionId || null,
        channelId: params.channelId || params.room?.channelId || null,
        participantIds,
        participantCount: participantIds.length,
        lastHeartbeatAt: serverReceivedAt,
        lastUserId: userId,
        latestDeviceId: deviceId,
      },
    },
  };
}

function redactRedisUrl(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = "REDACTED";
    if (parsed.username) parsed.username = parsed.username.replace(/.+/, "REDACTED");
    return parsed.toString();
  } catch {
    return "(invalid redis url)";
  }
}

class RedisHealthClient {
  constructor({
    redisUrl = process.env.REDIS_URL || process.env.HUDDLE_REDIS_URL || "",
    connectTimeoutMs = Number(process.env.HUDDLE_REDIS_CONNECT_TIMEOUT_MS || 500),
    pingTimeoutMs = Number(process.env.HUDDLE_REDIS_PING_TIMEOUT_MS || 500),
  } = {}) {
    this.redisUrl = redisUrl;
    this.connectTimeoutMs = connectTimeoutMs;
    this.pingTimeoutMs = pingTimeoutMs;
    this.lastHealth = {
      ok: false,
      status: "not_configured",
      latencyMs: null,
      checkedAt: null,
      error: redisUrl ? null : "REDIS_URL is not configured",
      url: redactRedisUrl(redisUrl),
    };
  }

  get target() {
    if (!this.redisUrl) return null;
    try {
      const parsed = new URL(this.redisUrl);
      return {
        parsed,
        host: parsed.hostname || "localhost",
        port: Number(parsed.port || 6379),
        tls: parsed.protocol === "rediss:",
        username: decodeURIComponent(parsed.username || ""),
        password: decodeURIComponent(parsed.password || ""),
      };
    } catch (err) {
      return { error: err.message };
    }
  }

  write(socket, command) {
    return new Promise((resolve, reject) => {
      socket.write(command, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  readReply(socket, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("redis_reply_timeout"));
      }, timeoutMs);
      let buffer = Buffer.alloc(0);

      const cleanup = () => {
        clearTimeout(timer);
        socket.off("data", onData);
        socket.off("error", onError);
      };
      const onData = (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (!isCompleteRespBuffer(buffer)) return;
        cleanup();
        resolve(buffer.toString("utf8"));
      };
      const onError = (err) => {
        cleanup();
        reject(err);
      };

      socket.on("data", onData);
      socket.once("error", onError);
    });
  }

  async authenticate(socket, target) {
    if (!target.password) return;
    const auth = target.username
      ? redisCommand(["AUTH", target.username, target.password])
      : redisCommand(["AUTH", target.password]);
    await this.write(socket, auth);
    const reply = await this.readReply(socket, this.pingTimeoutMs);
    if (!reply.startsWith("+OK")) {
      throw new Error(`redis_auth_failed:${reply.trim()}`);
    }
  }

  async connect(target) {
    return new Promise((resolve, reject) => {
      const socketFactory = target.tls ? tls.connect : net.connect;
      const socket = socketFactory({
        host: target.host,
        port: target.port,
        servername: target.tls ? target.host : undefined,
      });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error("redis_connect_timeout"));
      }, this.connectTimeoutMs);
      const readyEvent = target.tls ? "secureConnect" : "connect";

      socket.once(readyEvent, () => {
        clearTimeout(timer);
        resolve(socket);
      });
      socket.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  async ping() {
    const started = Date.now();
    const target = this.target;
    if (!target) {
      this.lastHealth = {
        ok: false,
        status: "not_configured",
        latencyMs: null,
        checkedAt: nowIso(),
        error: "REDIS_URL is not configured",
        url: null,
      };
      return this.lastHealth;
    }
    if (target.error) {
      this.lastHealth = {
        ok: false,
        status: "invalid_url",
        latencyMs: null,
        checkedAt: nowIso(),
        error: target.error,
        url: redactRedisUrl(this.redisUrl),
      };
      return this.lastHealth;
    }

    let socket = null;
    try {
      socket = await this.connect(target);
      await this.authenticate(socket, target);

      await this.write(socket, redisCommand(["PING"]));
      const pong = await this.readReply(socket, this.pingTimeoutMs);
      if (!pong.startsWith("+PONG")) {
        throw new Error(`redis_ping_failed:${pong.trim()}`);
      }

      this.lastHealth = {
        ok: true,
        status: "healthy",
        latencyMs: Date.now() - started,
        checkedAt: nowIso(),
        error: null,
        url: redactRedisUrl(this.redisUrl),
      };
      return this.lastHealth;
    } catch (err) {
      this.lastHealth = {
        ok: false,
        status: "unavailable",
        latencyMs: Date.now() - started,
        checkedAt: nowIso(),
        error: err.message,
        url: redactRedisUrl(this.redisUrl),
      };
      return this.lastHealth;
    } finally {
      if (socket) socket.destroy();
    }
  }

  getDiagnostics() {
    return this.lastHealth;
  }

  async runMany(commands = []) {
    const target = this.target;
    if (!target) throw new Error("REDIS_URL is not configured");
    if (target.error) throw new Error(target.error);

    let socket = null;
    try {
      socket = await this.connect(target);
      await this.authenticate(socket, target);
      const replies = [];
      for (const command of commands) {
        await this.write(socket, redisCommand(command));
        replies.push(await this.readReply(socket, this.pingTimeoutMs));
      }
      this.lastHealth = {
        ok: true,
        status: "healthy",
        latencyMs: this.lastHealth?.latencyMs ?? null,
        checkedAt: nowIso(),
        error: null,
        url: redactRedisUrl(this.redisUrl),
      };
      return replies;
    } catch (err) {
      this.lastHealth = {
        ok: false,
        status: "unavailable",
        latencyMs: null,
        checkedAt: nowIso(),
        error: err.message,
        url: redactRedisUrl(this.redisUrl),
      };
      throw err;
    } finally {
      if (socket) socket.destroy();
    }
  }
}

export class RedisRealtimeProvider {
  constructor({
    localProvider = new LocalRealtimeProvider(),
    redisEnabled = parseBoolean(process.env.HUDDLE_REDIS_ENABLED),
    redisRequired = parseBoolean(process.env.HUDDLE_REDIS_REQUIRED),
    shadowWriteEnabled = parseBoolean(process.env.HUDDLE_REALTIME_SHADOW_WRITE),
    shadowPresenceTtlSeconds = shadowTtlSeconds(process.env.HUDDLE_REALTIME_SHADOW_TTL_SECONDS),
    heartbeatsEnabled = parseBoolean(process.env.HUDDLE_HEARTBEATS_ENABLED),
    heartbeatTtl = heartbeatTtlSeconds(process.env.HUDDLE_HEARTBEAT_TTL_SECONDS),
    heartbeatStaleAfter = heartbeatStaleAfterMs(process.env.HUDDLE_HEARTBEAT_STALE_AFTER_MS),
    redisUrl = process.env.REDIS_URL || process.env.HUDDLE_REDIS_URL || "",
    healthClient = null,
    commandClient = null,
  } = {}) {
    this.localProvider = localProvider;
    this.redisEnabled = redisEnabled;
    this.redisRequired = redisRequired;
    this.shadowWriteEnabled = shadowWriteEnabled;
    this.shadowPresenceTtlSeconds = shadowPresenceTtlSeconds;
    this.heartbeatsEnabled = heartbeatsEnabled;
    this.heartbeatTtlSeconds = heartbeatTtl;
    this.heartbeatStaleAfterMs = heartbeatStaleAfter;
    this.healthClient = healthClient || new RedisHealthClient({ redisUrl });
    this.commandClient = commandClient || this.healthClient;
    this.lastDegradedAt = null;
    this.pendingShadowWrites = new Set();
    this.heartbeatDevices = new Map();
    this.shadowPresence = {
      enabled: this.redisEnabled && this.shadowWriteEnabled,
      ttlSeconds: this.shadowPresenceTtlSeconds,
      attempts: 0,
      successes: 0,
      failures: 0,
      skipped: 0,
      lastWriteAt: null,
      lastOperation: null,
      lastError: null,
      lastComparison: null,
      lastMismatchAt: null,
      recentMismatches: [],
    };
    this.heartbeats = {
      enabled: this.redisEnabled && this.heartbeatsEnabled,
      ttlSeconds: this.heartbeatTtlSeconds,
      staleAfterMs: this.heartbeatStaleAfterMs,
      attempts: 0,
      successes: 0,
      failures: 0,
      skipped: 0,
      lastHeartbeatAt: null,
      lastWriteAt: null,
      lastLatencyMs: null,
      latencySamples: [],
      lastError: null,
      lastOperation: null,
    };
  }

  configure(options = {}) {
    this.localProvider.configure(options);
    if (this.redisEnabled) {
      this.checkHealth({ reason: "configure" }).catch((err) => {
        this.lastDegradedAt = nowIso();
        console.warn("[huddle:realtime:redis:health_failed]", err.message);
      });
    }
  }

  async checkHealth({ reason = "manual" } = {}) {
    const health = await this.healthClient.ping();
    if (!health.ok) {
      this.lastDegradedAt = nowIso();
      console.warn("[huddle:realtime:redis:degraded]", {
        reason,
        redisRequired: this.redisRequired,
        status: health.status,
        error: health.error,
      });
    }
    return health;
  }

  shouldShadowWrite() {
    return this.redisEnabled && this.shadowWriteEnabled;
  }

  shouldTrackHeartbeats() {
    return this.redisEnabled && this.heartbeatsEnabled;
  }

  trackShadowWrite(promise) {
    this.pendingShadowWrites.add(promise);
    promise.finally(() => this.pendingShadowWrites.delete(promise));
    return promise;
  }

  scheduleShadowPresenceWrite({ operation, snapshot = null, previousSnapshot = null, removedUserIds = [] } = {}) {
    if (!this.shouldShadowWrite()) {
      this.shadowPresence.skipped += 1;
      return;
    }

    const targetSnapshot = snapshot || previousSnapshot;
    if (!targetSnapshot?.workspaceId || !targetSnapshot?.huddleId) {
      this.shadowPresence.skipped += 1;
      return;
    }

    this.shadowPresence.attempts += 1;
    this.shadowPresence.lastOperation = operation;
    const write = this.writeShadowPresence({
      operation,
      snapshot,
      previousSnapshot,
      removedUserIds,
    }).catch((err) => {
      this.shadowPresence.failures += 1;
      this.shadowPresence.lastError = err.message;
      this.lastDegradedAt = nowIso();
      console.warn("[huddle:realtime:redis:shadow_write_failed]", {
        operation,
        error: err.message,
      });
    });
    this.trackShadowWrite(write);
  }

  heartbeatKey(params = {}) {
    return [
      params.workspaceId,
      params.huddleId,
      params.userId,
      normalizeHeartbeatDeviceId(params),
    ].map((part) => String(part ?? "unknown")).join(":");
  }

  rememberHeartbeat(documents) {
    const entry = documents?.device?.value;
    if (!entry) return;
    this.heartbeatDevices.set(this.heartbeatKey(entry), {
      ...entry,
      key: documents.device.key,
      participantKey: documents.participant.key,
      sessionKey: documents.session.key,
    });
    this.heartbeats.lastHeartbeatAt = entry.serverReceivedAt;
    this.heartbeats.lastLatencyMs = entry.latencyMs;
    if (typeof entry.latencyMs === "number") {
      this.heartbeats.latencySamples = [
        entry.latencyMs,
        ...this.heartbeats.latencySamples,
      ].slice(0, 100);
    }
  }

  forgetHeartbeatDevices({ workspaceId, huddleId, userIds = [] } = {}) {
    const deleted = [];
    const userIdSet = new Set(userIds.map(String));
    for (const [key, entry] of this.heartbeatDevices.entries()) {
      if (String(entry.workspaceId) !== String(workspaceId)) continue;
      if (String(entry.huddleId) !== String(huddleId)) continue;
      if (userIdSet.size && !userIdSet.has(String(entry.userId))) continue;
      deleted.push(entry.key, entry.participantKey);
      this.heartbeatDevices.delete(key);
    }
    if (!userIdSet.size) {
      deleted.push(heartbeatSessionKey(workspaceId, huddleId));
    }
    return [...new Set(deleted.filter(Boolean))];
  }

  scheduleHeartbeatRemoval({ operation, workspaceId, huddleId, userIds = [] } = {}) {
    if (!this.shouldTrackHeartbeats()) return;
    const keys = this.forgetHeartbeatDevices({ workspaceId, huddleId, userIds });
    if (!keys.length) return;
    const write = this.commandClient.runMany([["DEL", ...keys]]).catch((err) => {
      this.heartbeats.failures += 1;
      this.heartbeats.lastError = err.message;
      this.lastDegradedAt = nowIso();
      console.warn("[huddle:realtime:redis:heartbeat_remove_failed]", {
        operation,
        error: err.message,
      });
    });
    this.trackShadowWrite(write);
  }

  scheduleHeartbeatWrite({ operation, documents }) {
    if (!this.shouldTrackHeartbeats()) {
      this.heartbeats.skipped += 1;
      return;
    }

    this.heartbeats.attempts += 1;
    this.heartbeats.lastOperation = operation;
    this.rememberHeartbeat(documents);
    const commands = [
      ["SET", documents.device.key, JSON.stringify(documents.device.value), "EX", this.heartbeatTtlSeconds],
      ["SET", documents.participant.key, JSON.stringify(documents.participant.value), "EX", this.heartbeatTtlSeconds],
      ["SET", documents.session.key, JSON.stringify(documents.session.value), "EX", this.heartbeatTtlSeconds],
    ];
    const write = this.commandClient.runMany(commands)
      .then(() => {
        this.heartbeats.successes += 1;
        this.heartbeats.lastWriteAt = nowIso();
        this.heartbeats.lastError = null;
      })
      .catch((err) => {
        this.heartbeats.failures += 1;
        this.heartbeats.lastError = err.message;
        this.lastDegradedAt = nowIso();
        console.warn("[huddle:realtime:redis:heartbeat_write_failed]", {
          operation,
          error: err.message,
        });
      });
    this.trackShadowWrite(write);
  }

  async writeShadowPresence({ operation, snapshot = null, previousSnapshot = null, removedUserIds = [] }) {
    const updatedAt = nowIso();
    const documents = makePresenceDocuments(snapshot, { operation, updatedAt });
    const previousParticipants = previousSnapshot?.participants || [];
    const deleteKeys = new Set(removalKeys(snapshot || previousSnapshot, removedUserIds));

    if (operation === "deleteRoom" && previousSnapshot) {
      deleteKeys.add(shadowSessionKey(previousSnapshot.workspaceId, previousSnapshot.huddleId));
      for (const participant of previousParticipants) {
        deleteKeys.add(shadowParticipantKey(previousSnapshot.workspaceId, previousSnapshot.huddleId, participant.userId));
        deleteKeys.add(shadowDeviceKey(previousSnapshot.workspaceId, previousSnapshot.huddleId, participant.userId));
      }
    }

    const commands = [];
    if (deleteKeys.size) {
      commands.push(["DEL", ...deleteKeys]);
    }
    if (documents.session) {
      commands.push(["SET", documents.session.key, JSON.stringify(documents.session.value), "EX", this.shadowPresenceTtlSeconds]);
      for (const participant of documents.participants) {
        commands.push(["SET", participant.key, JSON.stringify(participant.value), "EX", this.shadowPresenceTtlSeconds]);
      }
      for (const device of documents.devices) {
        commands.push(["SET", device.key, JSON.stringify(device.value), "EX", this.shadowPresenceTtlSeconds]);
      }
    }

    if (!commands.length) {
      this.shadowPresence.skipped += 1;
      return;
    }

    await this.commandClient.runMany(commands);
    this.shadowPresence.successes += 1;
    this.shadowPresence.lastWriteAt = updatedAt;
    this.shadowPresence.lastError = null;

    const comparison = await this.compareShadowPresence({
      operation,
      documents,
      previousSnapshot,
      deletedKeys: [...deleteKeys],
    });
    this.recordShadowComparison(comparison);
  }

  async compareShadowPresence({ operation, documents, previousSnapshot = null, deletedKeys = [] }) {
    const keys = [];
    const expected = new Map();
    if (documents.session) {
      keys.push(documents.session.key);
      expected.set(documents.session.key, documents.session.value);
    }
    for (const participant of documents.participants) {
      keys.push(participant.key);
      expected.set(participant.key, participant.value);
    }
    for (const device of documents.devices) {
      keys.push(device.key);
      expected.set(device.key, device.value);
    }
    for (const key of deletedKeys) {
      keys.push(key);
      expected.set(key, null);
    }

    const replies = keys.length
      ? await this.commandClient.runMany(keys.map((key) => ["GET", key]))
      : [];
    const mismatches = [];
    const redisPresence = {};

    keys.forEach((key, index) => {
      const expectedValue = expected.get(key);
      const actualValue = parseJsonReply(replies[index]);
      redisPresence[key] = actualValue;
      if (expectedValue === null) {
        if (actualValue !== null) {
          mismatches.push({ type: key.includes(":device:") ? "stale_device" : "stale_participant", key });
        }
        return;
      }
      if (actualValue === null) {
        const type = key.includes(":session:")
          ? "missing_session"
          : key.includes(":device:")
            ? "missing_device"
            : "missing_participant";
        mismatches.push({ type, key });
        return;
      }
      if (actualValue.parseError || !sameJson(expectedValue, actualValue)) {
        const type = key.includes(":session:")
          ? "session_mismatch"
          : key.includes(":device:")
            ? "device_mismatch"
            : "participant_mismatch";
        mismatches.push({ type, key });
      }
    });

    return {
      checkedAt: nowIso(),
      operation,
      localAuthoritative: true,
      comparedKeys: keys.length,
      mismatchCount: mismatches.length,
      mismatches,
      local: documents.session
        ? {
            workspaceId: documents.session.value.workspaceId,
            huddleId: documents.session.value.huddleId,
            sessionId: documents.session.value.sessionId,
            participantCount: documents.session.value.participantCount,
            participantIds: documents.session.value.participantIds,
          }
        : {
            workspaceId: previousSnapshot?.workspaceId || null,
            huddleId: previousSnapshot?.huddleId || null,
            sessionId: previousSnapshot?.sessionId || null,
            participantCount: 0,
            participantIds: [],
          },
      redis: {
        keyCount: Object.values(redisPresence).filter(Boolean).length,
      },
    };
  }

  recordShadowComparison(comparison) {
    this.shadowPresence.lastComparison = comparison;
    if (comparison.mismatchCount > 0) {
      this.shadowPresence.lastMismatchAt = comparison.checkedAt;
      this.shadowPresence.recentMismatches = [
        comparison,
        ...this.shadowPresence.recentMismatches,
      ].slice(0, 10);
      console.warn("[huddle:realtime:redis:shadow_mismatch]", {
        operation: comparison.operation,
        mismatchCount: comparison.mismatchCount,
        mismatches: comparison.mismatches,
      });
    }
  }

  async flushShadowWrites() {
    await Promise.allSettled([...this.pendingShadowWrites]);
  }

  getHeartbeatDiagnostics(local = this.localProvider.getDiagnostics()) {
    const checkedAtMs = Date.now();
    const sessions = local?.sessions || [];
    const activeSessionKeys = new Set(
      sessions.map((session) => `${String(session.workspaceId)}:${String(session.huddleId)}`)
    );
    const expectedParticipants = [];
    for (const session of sessions) {
      for (const participant of session.participants || []) {
        expectedParticipants.push({
          workspaceId: session.workspaceId,
          huddleId: session.huddleId,
          sessionId: session.sessionId || null,
          channelId: session.channelId,
          userId: String(participant.userId),
          username: participant.username || "",
        });
      }
    }

    const devices = [...this.heartbeatDevices.values()];
    const activeDevices = devices.filter((device) =>
      activeSessionKeys.has(`${String(device.workspaceId)}:${String(device.huddleId)}`)
    );
    const staleDevices = [];
    const participantDevices = new Map();
    for (const device of activeDevices) {
      const receivedAtMs = Date.parse(device.serverReceivedAt);
      const ageMs = Number.isFinite(receivedAtMs) ? checkedAtMs - receivedAtMs : Number.POSITIVE_INFINITY;
      const deviceDiagnostic = {
        workspaceId: device.workspaceId,
        huddleId: device.huddleId,
        sessionId: device.sessionId || null,
        channelId: device.channelId || null,
        userId: device.userId,
        username: device.username || "",
        deviceId: device.deviceId,
        socketId: device.socketId || null,
        platform: device.platform || null,
        lastHeartbeatAt: device.serverReceivedAt,
        ageMs,
        staleAfterMs: this.heartbeatStaleAfterMs,
      };
      const participantKey = `${String(device.workspaceId)}:${String(device.huddleId)}:${String(device.userId)}`;
      if (!participantDevices.has(participantKey)) participantDevices.set(participantKey, []);
      participantDevices.get(participantKey).push(deviceDiagnostic);
      if (ageMs > this.heartbeatStaleAfterMs) staleDevices.push(deviceDiagnostic);
    }

    const staleParticipants = [];
    for (const participant of expectedParticipants) {
      const key = `${String(participant.workspaceId)}:${String(participant.huddleId)}:${String(participant.userId)}`;
      const devicesForParticipant = participantDevices.get(key) || [];
      if (!devicesForParticipant.length) {
        staleParticipants.push({
          ...participant,
          reason: "missing_heartbeat",
          deviceCount: 0,
          staleAfterMs: this.heartbeatStaleAfterMs,
        });
        continue;
      }
      const allDevicesStale = devicesForParticipant.every((device) => device.ageMs > this.heartbeatStaleAfterMs);
      if (allDevicesStale) {
        staleParticipants.push({
          ...participant,
          reason: "all_devices_stale",
          deviceCount: devicesForParticipant.length,
          lastHeartbeatAt: devicesForParticipant
            .map((device) => device.lastHeartbeatAt)
            .sort()
            .at(-1) || null,
          staleAfterMs: this.heartbeatStaleAfterMs,
        });
      }
    }

    const latencySamples = this.heartbeats.latencySamples.filter((sample) => typeof sample === "number");
    const averageLatencyMs = latencySamples.length
      ? Math.round(latencySamples.reduce((sum, sample) => sum + sample, 0) / latencySamples.length)
      : null;

    return {
      ...this.heartbeats,
      checkedAt: new Date(checkedAtMs).toISOString(),
      averageLatencyMs,
      observedDeviceCount: activeDevices.length,
      expectedParticipantCount: expectedParticipants.length,
      staleDevices,
      staleParticipants,
      missedHeartbeats: staleParticipants.length,
      orphanedDeviceCount: devices.length - activeDevices.length,
    };
  }

  getRoom(params) {
    return this.localProvider.getRoom(params);
  }

  createRoom(params) {
    const snapshot = this.localProvider.createRoom(params);
    this.scheduleShadowPresenceWrite({ operation: "createRoom", snapshot });
    return snapshot;
  }

  deleteRoom(params) {
    const previousSnapshot = this.localProvider.getPresence(params);
    const deleted = this.localProvider.deleteRoom(params);
    if (deleted) {
      this.scheduleShadowPresenceWrite({ operation: "deleteRoom", previousSnapshot });
      this.scheduleHeartbeatRemoval({
        operation: "deleteRoom",
        workspaceId: params.workspaceId,
        huddleId: params.huddleId,
      });
    }
    return deleted;
  }

  ensureRoomFromActive(params) {
    const snapshot = this.localProvider.ensureRoomFromActive(params);
    this.scheduleShadowPresenceWrite({ operation: "ensureRoomFromActive", snapshot });
    return snapshot;
  }

  updateRoomContext(params) {
    const snapshot = this.localProvider.updateRoomContext(params);
    this.scheduleShadowPresenceWrite({ operation: "updateRoomContext", snapshot });
    return snapshot;
  }

  findRoomByChannel(params) {
    return this.localProvider.findRoomByChannel(params);
  }

  getPresence(params) {
    return this.localProvider.getPresence(params);
  }

  hasParticipant(params) {
    return this.localProvider.hasParticipant(params);
  }

  joinDevice(params) {
    const result = this.localProvider.joinDevice(params);
    if (result?.ok) {
      this.scheduleShadowPresenceWrite({ operation: "joinDevice", snapshot: result.room });
    }
    return result;
  }

  leaveDevice(params) {
    const result = this.localProvider.leaveDevice(params);
    if (result?.ok) {
      const removedUserIds = result.removedUserIds || [];
      this.scheduleShadowPresenceWrite({
        operation: "leaveDevice",
        snapshot: result.room,
        removedUserIds,
      });
      if (removedUserIds.length > 0) {
        this.scheduleHeartbeatRemoval({
          operation: "leaveDevice",
          workspaceId: params.workspaceId,
          huddleId: params.huddleId,
          userIds: removedUserIds,
        });
      }
    }
    return result;
  }

  getRecoverySnapshots(params) {
    return this.localProvider.getRecoverySnapshots(params);
  }

  leaveUserFromAllRooms(params) {
    const changes = this.localProvider.leaveUserFromAllRooms(params);
    for (const change of changes) {
      const removedUserIds = change.removedUserIds || [params.userId];
      this.scheduleShadowPresenceWrite({
        operation: "leaveUserFromAllRooms",
        snapshot: change.room,
        removedUserIds,
      });
      this.scheduleHeartbeatRemoval({
        operation: "leaveUserFromAllRooms",
        workspaceId: change.workspaceId,
        huddleId: change.huddleId,
        userIds: removedUserIds,
      });
    }
    return changes;
  }

  leaveDeviceFromAllRooms(params) {
    const changes = this.localProvider.leaveDeviceFromAllRooms(params);
    for (const change of changes) {
      const removedUserIds = change.removedUserIds || [];
      this.scheduleShadowPresenceWrite({
        operation: "leaveDeviceFromAllRooms",
        snapshot: change.room,
        removedUserIds,
      });
      if (removedUserIds.length > 0) {
        this.scheduleHeartbeatRemoval({
          operation: "leaveDeviceFromAllRooms",
          workspaceId: change.workspaceId,
          huddleId: change.huddleId,
          userIds: removedUserIds,
        });
      }
    }
    return changes;
  }

  joinRealtimeRooms(params) {
    return this.localProvider.joinRealtimeRooms(params);
  }

  broadcastInvite(params) {
    return this.localProvider.broadcastInvite(params);
  }

  broadcastLive(params) {
    return this.localProvider.broadcastLive(params);
  }

  sendToUser(params) {
    return this.localProvider.sendToUser(params);
  }

  sendToDevice(params) {
    return this.localProvider.sendToDevice(params);
  }

  recordHeartbeat(params = {}) {
    if (!this.heartbeatsEnabled) {
      this.heartbeats.skipped += 1;
      return {
        ok: true,
        provider: "redis",
        delegatedProvider: "local",
        supported: false,
        reason: "heartbeats_disabled",
      };
    }
    if (!this.redisEnabled) {
      this.heartbeats.skipped += 1;
      return {
        ok: true,
        provider: "redis",
        delegatedProvider: "local",
        supported: false,
        reason: "redis_disabled",
      };
    }

    const workspaceId = params.workspaceId;
    const huddleId = params.huddleId;
    const userId = String(params.userId || "");
    if (!workspaceId || !huddleId || !userId) {
      this.heartbeats.skipped += 1;
      return {
        ok: false,
        provider: "redis",
        delegatedProvider: "local",
        supported: true,
        reason: "heartbeat_scope_required",
      };
    }

    const room = this.localProvider.getPresence({ workspaceId, huddleId });
    if (!room) {
      this.heartbeats.skipped += 1;
      return {
        ok: false,
        provider: "redis",
        delegatedProvider: "local",
        supported: true,
        reason: "huddle_room_required",
      };
    }
    if (!room.participantIds?.map(String).includes(userId)) {
      this.heartbeats.skipped += 1;
      return {
        ok: false,
        provider: "redis",
        delegatedProvider: "local",
        supported: true,
        reason: "participant_required",
      };
    }

    const documents = makeHeartbeatDocuments({
      ...params,
      workspaceId,
      huddleId,
      userId,
      username: params.username || room.participants?.find((participant) => String(participant.userId) === userId)?.username || "",
      channelId: params.channelId || room.channelId,
      sessionId: params.sessionId || room.sessionId,
      room,
      serverReceivedAt: params.serverReceivedAt || nowIso(),
    });
    this.scheduleHeartbeatWrite({ operation: params.source || "huddle:heartbeat", documents });

    return {
      ok: true,
      provider: "redis",
      delegatedProvider: "local",
      supported: true,
      shadow: true,
      heartbeatAt: documents.device.value.serverReceivedAt,
      latencyMs: documents.device.value.latencyMs,
      staleAfterMs: this.heartbeatStaleAfterMs,
      ttlSeconds: this.heartbeatTtlSeconds,
      deviceId: documents.device.value.deviceId,
    };
  }

  getDiagnostics() {
    const local = this.localProvider.getDiagnostics();
    const redis = this.healthClient.getDiagnostics();
    const shadowDegraded = this.shadowWriteEnabled && Boolean(this.shadowPresence.lastError);
    const heartbeatDiagnostics = this.getHeartbeatDiagnostics(local);
    const heartbeatDegraded = this.heartbeatsEnabled && Boolean(this.heartbeats.lastError);
    return {
      provider: "redis",
      activeStateProvider: "local",
      redisEnabled: this.redisEnabled,
      redisRequired: this.redisRequired,
      shadowWriteEnabled: this.shadowWriteEnabled,
      heartbeatsEnabled: this.heartbeatsEnabled,
      degraded: this.redisEnabled && (!redis.ok || shadowDegraded || heartbeatDegraded),
      heartbeatDegraded,
      lastDegradedAt: this.lastDegradedAt,
      redis,
      shadowPresence: this.shadowPresence,
      heartbeats: heartbeatDiagnostics,
      local,
    };
  }
}

export { RedisHealthClient };
export default RedisRealtimeProvider;
