import { randomUUID } from "node:crypto";

import huddleRecoveryFenceService, {
  buildRestoreIdempotencyKey,
} from "./huddleRecoveryFence.service.js";
import { normalizeHuddleDeviceIdentity } from "./huddleDeviceIdentity.service.js";

function isEnabled(value) {
  return String(value || "").trim().toLowerCase() === "true";
}

function safeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function nowIso() {
  return new Date().toISOString();
}

function isoAfter(ms, base = Date.now()) {
  return new Date(base + ms).toISOString();
}

function numberFromEnv(value, fallback, min = 1) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min) return fallback;
  return Math.floor(parsed);
}

function byteSize(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function timestampVersion(...values) {
  for (const value of values) {
    if (!value) continue;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function snapshotSessionVersion({
  session = null,
  active = null,
  localRoom = null,
} = {}) {
  return timestampVersion(
    session?.updated_at,
    session?.ended_at,
    session?.started_at,
    active?.ended_at,
    active?.started_at,
    localRoom?.startedAt
  );
}

function sessionState({ session = null, active = null, localRoom = null } = {}) {
  if (session?.ended_at || session?.state === "ended") return "ended";
  if (session?.state) return String(session.state);
  if (active?.ended_at) return "ended";
  if (active || localRoom) return "live";
  return "unknown";
}

function participantState({ localRoom = null, userId = null, participant = null } = {}) {
  if (participant?.join_state) return String(participant.join_state);
  if (localRoom?.participantIds?.map(String).includes(String(userId))) return "joined";
  return "unknown";
}

function participantRole({ session = null, userId = null, participant = null } = {}) {
  if (participant?.role) return String(participant.role);
  if (session?.host_user_id && String(session.host_user_id) === String(userId)) return "host";
  if (session?.started_by && String(session.started_by) === String(userId)) return "host";
  return "participant";
}

function startedBy({ localRoom = null, active = null, session = null } = {}) {
  if (localRoom?.startedBy) return localRoom.startedBy;
  if (active?.started_by) {
    return {
      userId: String(active.started_by),
      username: active.starter_username || "Someone",
    };
  }
  if (session?.started_by) {
    return {
      userId: String(session.started_by),
      username: session.metadata?.legacyStarterUsername || "Someone",
    };
  }
  return null;
}

function scopeSummary(scope = {}, channelId = null) {
  return {
    type: scope?.type || (safeString(channelId).startsWith("dm:") ? "dm" : safeString(channelId).startsWith("thread:") ? "thread" : "channel"),
    isPrivate: Boolean(scope?.isPrivate || scope?.type === "dm" || scope?.type === "thread"),
  };
}

function normalizeDeviceContext(deviceContext = {}) {
  const deviceId = safeString(deviceContext.deviceId) || safeString(deviceContext.socketId) || "unknown";
  return {
    deviceId,
    platform: safeString(deviceContext.platform) || "unknown",
    socketId: safeString(deviceContext.socketId) || null,
  };
}

function participantItems(localRoom = null, selfUserId = null, startedByUserId = null) {
  const items = (localRoom?.participants || []).map((participant) => ({
    userId: String(participant.userId),
    username: participant.username || "",
    role: startedByUserId && String(startedByUserId) === String(participant.userId) ? "host" : "participant",
    state: "joined",
    deviceCount: 1,
    hasHealthyDevice: true,
  }));

  return items.sort((a, b) => {
    if (String(a.userId) === String(selfUserId)) return -1;
    if (String(b.userId) === String(selfUserId)) return 1;
    if (startedByUserId && String(a.userId) === String(startedByUserId)) return -1;
    if (startedByUserId && String(b.userId) === String(startedByUserId)) return 1;
    return a.userId.localeCompare(b.userId);
  });
}

function averageDecision(decisions, status) {
  return decisions.filter((decision) => decision.status === status).length;
}

export class HuddleRecoveryService {
  constructor({
    enabled = isEnabled(process.env.HUDDLE_RECOVERY_SHADOW_ENABLED),
    snapshotExposureEnabled = isEnabled(process.env.HUDDLE_RECOVERY_SNAPSHOT_ENABLED),
    snapshotTtlMs = numberFromEnv(process.env.HUDDLE_RECOVERY_SNAPSHOT_TTL_MS, 30000, 1000),
    participantLimit = numberFromEnv(process.env.HUDDLE_RECOVERY_PARTICIPANT_LIMIT, 50, 1),
    softLimitBytes = numberFromEnv(process.env.HUDDLE_RECOVERY_SNAPSHOT_SOFT_LIMIT_BYTES, 8192, 1024),
    hardLimitBytes = numberFromEnv(process.env.HUDDLE_RECOVERY_SNAPSHOT_HARD_LIMIT_BYTES, 32768, 4096),
    fenceService = huddleRecoveryFenceService,
  } = {}) {
    this.enabled = enabled;
    this.snapshotExposureEnabled = snapshotExposureEnabled;
    this.snapshotTtlMs = snapshotTtlMs;
    this.participantLimit = participantLimit;
    this.softLimitBytes = softLimitBytes;
    this.hardLimitBytes = hardLimitBytes;
    this.fenceService = fenceService;
    this.generations = new Map();
    this.diagnostics = {
      enabled,
      snapshotExposureEnabled,
      evaluations: 0,
      skipped: 0,
      failures: 0,
      snapshotsGenerated: 0,
      snapshotsExposed: 0,
      snapshotsTruncated: 0,
      snapshotsRejected: 0,
      durableFencesReserved: 0,
      durableFenceFailures: 0,
      lastEvaluatedAt: null,
      lastExposedAt: null,
      lastRejectedAt: null,
      lastError: null,
      recent: [],
    };
  }

  configure({
    enabled = this.enabled,
    snapshotExposureEnabled = this.snapshotExposureEnabled,
  } = {}) {
    this.enabled = enabled;
    this.snapshotExposureEnabled = snapshotExposureEnabled;
    this.diagnostics.enabled = enabled;
    this.diagnostics.snapshotExposureEnabled = snapshotExposureEnabled;
  }

  generationKey({ workspaceId, huddleId, userId, deviceContext = {} }) {
    const device = normalizeDeviceContext(deviceContext);
    return [workspaceId, huddleId, userId, device.deviceId].map((part) => String(part || "unknown")).join(":");
  }

  nextGeneration(params) {
    const key = this.generationKey(params);
    const next = (this.generations.get(key) || 0) + 1;
    this.generations.set(key, next);
    return next;
  }

  computeDecision({
    access = { ok: true },
    localRoom = null,
    active = null,
    session = null,
    participant = null,
    userId = null,
  } = {}) {
    if (!access?.ok) {
      return {
        status: "access_denied",
        reason: access.reason || "permission_denied",
        restoreAllowed: false,
      };
    }

    const state = sessionState({ session, active, localRoom });
    if (state === "ended") {
      return {
        status: "ended",
        reason: "session_ended",
        restoreAllowed: false,
      };
    }

    if (!localRoom && !active && !session) {
      return {
        status: "not_recoverable",
        reason: "huddle_not_found",
        restoreAllowed: false,
      };
    }

    const selfState = participantState({ localRoom, userId, participant });
    if (selfState === "left" || selfState === "declined" || selfState === "removed") {
      return {
        status: "not_recoverable",
        reason: `participant_${selfState}`,
        restoreAllowed: false,
      };
    }

    return {
      status: "recoverable",
      reason: "live_session",
      restoreAllowed: false,
    };
  }

  buildSnapshot({
    source = "unknown",
    workspaceId,
    channelId,
    huddleId,
    userId,
    username = "",
    scope = {},
    localRoom = null,
    active = null,
    session = null,
    participant = null,
    deviceContext = {},
    heartbeatDiagnostics = null,
    access = { ok: true },
    decision = null,
    fence = null,
    snapshotId = randomUUID(),
    idempotencyKey = null,
    generatedAtMs = Date.now(),
  } = {}) {
    const generatedAt = new Date(generatedAtMs).toISOString();
    const generation = fence?.generation
      ? Number(fence.generation)
      : this.nextGeneration({ workspaceId, huddleId, userId, deviceContext });
    const startedByUser = startedBy({ localRoom, active, session });
    const participants = participantItems(localRoom, userId, startedByUser?.userId);
    const includedParticipants = participants.slice(0, this.participantLimit);
    const device = normalizeDeviceContext(deviceContext);
    const sessionVersion = fence?.session_version || fence?.sessionVersion
      ? Number(fence.session_version || fence.sessionVersion)
      : snapshotSessionVersion({ session, active, localRoom });
    const finalDecision = decision || this.computeDecision({
      access,
      localRoom,
      active,
      session,
      participant,
      userId,
    });

    const snapshot = {
      type: "huddle_recovery_snapshot",
      version: 1,
      snapshotId,
      idempotencyKey: idempotencyKey || null,
      generatedAt,
      expiresAt: isoAfter(this.snapshotTtlMs, generatedAtMs),
      generation,
      sessionVersion,
      workspaceId: workspaceId || null,
      sessionId: session?.id || session?.sessionId || localRoom?.sessionId || active?.session_id || null,
      huddleId: huddleId || active?.huddle_id || localRoom?.huddleId || null,
      channelId: channelId || active?.channel_key || localRoom?.channelId || null,
      scope: scopeSummary(scope, channelId || localRoom?.channelId || active?.channel_key),
      decision: finalDecision,
      session: {
        state: sessionState({ session, active, localRoom }),
        startedAt: session?.started_at || active?.started_at || localRoom?.startedAt || null,
        startedBy: startedByUser,
      },
      self: {
        userId: userId || null,
        participantState: participantState({ localRoom, userId, participant }),
        role: participantRole({ session, userId, participant }),
        devices: [
          {
            deviceId: device.deviceId,
            platform: device.platform,
            lastSeenAt: generatedAt,
            lastHeartbeatAt: heartbeatDiagnostics?.lastHeartbeatAt || null,
            stale: false,
          },
        ],
      },
      participants: {
        total: participants.length,
        included: includedParticipants.length,
        truncated: participants.length > includedParticipants.length,
        items: includedParticipants,
      },
      diagnostics: {
        source: {
          evaluation: source,
          session: session ? "postgres" : "unavailable",
          runtime: localRoom ? "local" : "missing",
          heartbeat: heartbeatDiagnostics ? "redis_shadow" : "unavailable",
          fence: fence ? "durable" : "process_fallback",
        },
        localPresenceMatched: Boolean(localRoom && localRoom.participantIds?.map(String).includes(String(userId))),
        heartbeatAgeMs: heartbeatDiagnostics?.heartbeatAgeMs ?? null,
        staleDeviceCount: heartbeatDiagnostics?.staleDeviceCount ?? 0,
        staleParticipantCount: heartbeatDiagnostics?.staleParticipantCount ?? 0,
      },
      limits: {
        truncated: participants.length > includedParticipants.length,
        omitted: participants.length > includedParticipants.length ? ["participants_over_limit"] : [],
      },
    };

    return this.enforceSnapshotSize(snapshot);
  }

  enforceSnapshotSize(snapshot) {
    const sized = structuredClone(snapshot);
    const originalSize = byteSize(sized);
    sized.limits.bytes = originalSize;
    sized.limits.softLimitBytes = this.softLimitBytes;
    sized.limits.hardLimitBytes = this.hardLimitBytes;

    if (originalSize <= this.hardLimitBytes) return sized;

    sized.participants.items = [];
    sized.participants.included = 0;
    sized.participants.truncated = true;
    sized.self.devices = sized.self.devices.slice(0, 1).map((device) => ({
      deviceId: device.deviceId,
      platform: device.platform,
      stale: device.stale,
    }));
    sized.limits.truncated = true;
    sized.limits.omitted = [
      ...new Set([...(sized.limits.omitted || []), "participants_over_limit", "device_details_over_limit"]),
    ];
    sized.limits.bytes = byteSize(sized);

    if (sized.limits.bytes <= this.hardLimitBytes) return sized;

    sized.diagnostics = {
      source: snapshot.diagnostics.source,
      localPresenceMatched: snapshot.diagnostics.localPresenceMatched,
    };
    sized.limits.omitted = [...new Set([...sized.limits.omitted, "diagnostics_over_limit"])];
    sized.limits.bytes = byteSize(sized);
    return sized;
  }

  sanitizeSnapshotForExposure(snapshot) {
    if (!snapshot) return null;
    const exposed = structuredClone(snapshot);
    const forbiddenKeys = new Set([
      "sdp",
      "candidate",
      "ice",
      "iceCandidates",
      "offer",
      "answer",
      "chatContent",
      "message",
      "transcript",
      "recording",
      "secret",
      "token",
      "auth",
    ]);

    const stripForbidden = (value) => {
      if (Array.isArray(value)) return value.map(stripForbidden);
      if (!value || typeof value !== "object") return value;
      return Object.fromEntries(
        Object.entries(value)
          .filter(([key]) => !forbiddenKeys.has(key))
          .map(([key, entry]) => [key, stripForbidden(entry)])
      );
    };

    return this.enforceSnapshotSize(stripForbidden(exposed));
  }

  buildExposure({ snapshot, decision } = {}) {
    if (!this.snapshotExposureEnabled) {
      return {
        exposed: false,
        rejected: false,
        reason: "snapshot_exposure_disabled",
        metadata: null,
      };
    }
    if (!snapshot) {
      this.diagnostics.snapshotsRejected += 1;
      this.diagnostics.lastRejectedAt = nowIso();
      return {
        exposed: false,
        rejected: true,
        reason: "snapshot_missing",
        metadata: null,
      };
    }
    if (decision?.status === "access_denied") {
      this.diagnostics.snapshotsRejected += 1;
      this.diagnostics.lastRejectedAt = nowIso();
      return {
        exposed: false,
        rejected: true,
        reason: "access_denied",
        metadata: null,
      };
    }

    const sanitized = this.sanitizeSnapshotForExposure(snapshot);
    if (!sanitized || byteSize(sanitized) > this.hardLimitBytes) {
      this.diagnostics.snapshotsRejected += 1;
      this.diagnostics.lastRejectedAt = nowIso();
      return {
        exposed: false,
        rejected: true,
        reason: "snapshot_size_limit_exceeded",
        metadata: null,
      };
    }

    this.diagnostics.snapshotsExposed += 1;
    this.diagnostics.lastExposedAt = nowIso();
    return {
      exposed: true,
      rejected: false,
      reason: "snapshot_exposed",
      metadata: {
        recoverySnapshot: sanitized,
      },
    };
  }

  record(result) {
    const entry = {
      at: nowIso(),
      source: result.source,
      status: result.decision?.status || "unknown",
      reason: result.decision?.reason || "unknown",
      snapshotId: result.snapshot?.snapshotId || null,
      workspaceId: result.snapshot?.workspaceId || result.workspaceId || null,
      huddleId: result.snapshot?.huddleId || result.huddleId || null,
      generation: result.snapshot?.generation || null,
      sessionVersion: result.snapshot?.sessionVersion || null,
      bytes: result.snapshot?.limits?.bytes || 0,
    };
    this.diagnostics.evaluations += 1;
    if (result.snapshot) this.diagnostics.snapshotsGenerated += 1;
    if (result.snapshot?.limits?.truncated) this.diagnostics.snapshotsTruncated += 1;
    this.diagnostics.lastEvaluatedAt = entry.at;
    this.diagnostics.recent = [entry, ...this.diagnostics.recent].slice(0, 50);
  }

  evaluate(params = {}) {
    if (!this.enabled) {
      this.diagnostics.skipped += 1;
      return {
        ok: true,
        enabled: false,
        source: params.source || "unknown",
        decision: {
          status: "not_evaluated",
          reason: "recovery_shadow_disabled",
          restoreAllowed: false,
        },
        snapshot: null,
        exposure: {
          exposed: false,
          rejected: false,
          reason: "recovery_shadow_disabled",
          metadata: null,
        },
      };
    }

    try {
      const decision = this.computeDecision(params);
      const snapshot = this.buildSnapshot({ ...params, decision });
      const result = {
        ok: true,
        enabled: true,
        source: params.source || "unknown",
        decision,
        snapshot,
      };
      this.record(result);
      result.exposure = this.buildExposure({ snapshot, decision });
      return result;
    } catch (err) {
      this.diagnostics.failures += 1;
      this.diagnostics.lastError = err.message;
      console.warn("[huddle:recovery:shadow_failed]", {
        source: params.source || "unknown",
        workspaceId: params.workspaceId || null,
        huddleId: params.huddleId || null,
        error: err.message,
      });
      return {
        ok: false,
        enabled: true,
        source: params.source || "unknown",
        decision: {
          status: "not_evaluated",
          reason: "recovery_shadow_failed",
          restoreAllowed: false,
        },
        snapshot: null,
        error: err.message,
      };
    }
  }

  async evaluateDurable(params = {}) {
    if (!this.enabled) return this.evaluate(params);

    const sessionVersion = snapshotSessionVersion(params);
    const snapshotId = randomUUID();
    const device = normalizeHuddleDeviceIdentity({
      ...(params.deviceContext || {}),
      userId: params.userId,
      guestId: params.guestId,
    });
    let fence = null;
    if (this.fenceService?.reserveSnapshotFence) {
      try {
        fence = await this.fenceService.reserveSnapshotFence({
          workspaceId: params.workspaceId,
          sessionId: params.session?.id || params.session?.sessionId || params.localRoom?.sessionId || params.active?.session_id || null,
          huddleId: params.huddleId || params.active?.huddle_id || params.localRoom?.huddleId || null,
          channelId: params.channelId || params.active?.channel_key || params.localRoom?.channelId || null,
          participantId: params.participant?.id || null,
          userId: params.userId,
          guestId: params.guestId,
          deviceContext: params.deviceContext,
          logicalDeviceId: device.logicalDeviceId,
          sessionVersion,
          snapshotId,
          metadata: { source: params.source || "unknown" },
        });
        if (fence) this.diagnostics.durableFencesReserved += 1;
      } catch (err) {
        this.diagnostics.durableFenceFailures += 1;
        this.diagnostics.lastError = err.message;
        console.warn("[huddle:recovery:fence_failed]", {
          source: params.source || "unknown",
          workspaceId: params.workspaceId || null,
          huddleId: params.huddleId || null,
          error: err.message,
        });
      }
    }
    const durableGeneration = fence?.generation ? Number(fence.generation) : 0;
    const durableSessionVersion = fence?.session_version || fence?.sessionVersion
      ? Number(fence.session_version || fence.sessionVersion)
      : sessionVersion;
    const idempotencyKey = buildRestoreIdempotencyKey({
      workspaceId: params.workspaceId,
      sessionId: params.session?.id || params.session?.sessionId || params.localRoom?.sessionId || params.active?.session_id || null,
      huddleId: params.huddleId || params.active?.huddle_id || params.localRoom?.huddleId || null,
      userId: params.userId,
      guestId: params.guestId,
      logicalDeviceId: device.logicalDeviceId,
      snapshotId,
      generation: durableGeneration,
      sessionVersion: durableSessionVersion,
    });

    return this.evaluate({
      ...params,
      fence,
      snapshotId,
      idempotencyKey,
    });
  }

  getDiagnostics() {
    const recent = this.diagnostics.recent;
    return {
      ...this.diagnostics,
      decisions: {
        recoverable: averageDecision(recent, "recoverable"),
        notRecoverable: averageDecision(recent, "not_recoverable"),
        ended: averageDecision(recent, "ended"),
        accessDenied: averageDecision(recent, "access_denied"),
      },
      limits: {
        snapshotTtlMs: this.snapshotTtlMs,
        participantLimit: this.participantLimit,
        softLimitBytes: this.softLimitBytes,
        hardLimitBytes: this.hardLimitBytes,
      },
    };
  }
}

const huddleRecoveryService = new HuddleRecoveryService();

export default huddleRecoveryService;
