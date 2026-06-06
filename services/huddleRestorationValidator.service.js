import pool from "../db.js";
import { normalizeHuddleDeviceIdentity } from "./huddleDeviceIdentity.service.js";
import huddleRecoveryFenceService, {
  buildRestoreIdempotencyKey,
  hashRestoreRequest,
} from "./huddleRecoveryFence.service.js";

function runner(client) {
  return client || pool;
}

function safeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? Math.floor(parsed) : 0;
}

function timestampVersion(...values) {
  for (const value of values) {
    if (!value) continue;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function sessionVersion(session = null) {
  return timestampVersion(session?.updated_at, session?.ended_at, session?.started_at);
}

function reject(reason, details = {}) {
  return {
    ok: false,
    eligible: false,
    restoreAllowed: false,
    reason,
    ...details,
  };
}

function pass(details = {}) {
  return {
    ok: true,
    eligible: true,
    restoreAllowed: false,
    reason: "validated_for_future_restore",
    ...details,
  };
}

export class HuddleRestorationValidator {
  constructor({
    db = pool,
    fenceService = huddleRecoveryFenceService,
    loadSession = null,
    loadParticipant = null,
    checkWorkspaceAccess = null,
    now = () => Date.now(),
  } = {}) {
    this.db = db;
    this.fenceService = fenceService;
    this.loadSessionOverride = loadSession;
    this.loadParticipantOverride = loadParticipant;
    this.checkWorkspaceAccessOverride = checkWorkspaceAccess;
    this.now = now;
  }

  async loadSession({ sessionId, workspaceId, client = null }) {
    if (this.loadSessionOverride) return this.loadSessionOverride({ sessionId, workspaceId, client });
    if (!sessionId) return null;
    const { rows } = await runner(client || this.db).query(
      `
      SELECT *
      FROM huddle_sessions
      WHERE id = $1
        AND workspace_id = $2
      LIMIT 1
      `,
      [sessionId, workspaceId]
    );
    return rows[0] || null;
  }

  async loadParticipant({ sessionId, workspaceId, userId = null, guestId = null, client = null }) {
    if (this.loadParticipantOverride) {
      return this.loadParticipantOverride({ sessionId, workspaceId, userId, guestId, client });
    }
    if (!sessionId || (!userId && !guestId)) return null;
    const predicate = userId ? "user_id = $3" : "guest_id = $3";
    const { rows } = await runner(client || this.db).query(
      `
      SELECT *
      FROM huddle_session_participants
      WHERE session_id = $1
        AND workspace_id = $2
        AND ${predicate}
      LIMIT 1
      `,
      [sessionId, workspaceId, userId || guestId]
    );
    return rows[0] || null;
  }

  async checkWorkspaceAccess({ workspaceId, userId = null, guestId = null, access = null, client = null }) {
    if (access && access.ok === false) return access;
    if (this.checkWorkspaceAccessOverride) {
      return this.checkWorkspaceAccessOverride({ workspaceId, userId, guestId, access, client });
    }
    if (guestId) return { ok: true, reason: "guest_access_deferred" };
    if (!workspaceId || !userId) return { ok: false, reason: "workspace_access_required" };
    const { rows } = await runner(client || this.db).query(
      `
      SELECT 1
      FROM workspace_users
      WHERE workspace_id = $1
        AND user_id = $2
        AND (billing_status IS NULL OR billing_status != 'pending')
      LIMIT 1
      `,
      [workspaceId, userId]
    );
    return rows[0] ? { ok: true } : { ok: false, reason: "workspace_membership_required" };
  }

  async validate({
    snapshot,
    workspaceId,
    sessionId = null,
    huddleId = null,
    channelId = null,
    userId = null,
    guestId = null,
    deviceContext = {},
    access = null,
    currentSession = null,
    currentParticipant = null,
    idempotencyKey = null,
    client = null,
  } = {}) {
    if (!snapshot || snapshot.type !== "huddle_recovery_snapshot") {
      return reject("snapshot_required");
    }

    const effectiveWorkspaceId = workspaceId || snapshot.workspaceId;
    const effectiveSessionId = sessionId || snapshot.sessionId;
    const effectiveHuddleId = huddleId || snapshot.huddleId;
    const effectiveChannelId = channelId || snapshot.channelId;
    const effectiveUserId = safeString(userId) || safeString(snapshot.self?.userId);
    const effectiveGuestId = safeString(guestId);
    const device = normalizeHuddleDeviceIdentity({
      ...deviceContext,
      deviceId: deviceContext.deviceId || snapshot.self?.devices?.[0]?.deviceId,
      platform: deviceContext.platform || snapshot.self?.devices?.[0]?.platform,
      userId: effectiveUserId,
      guestId: effectiveGuestId,
    });

    if (snapshot.expiresAt && Date.parse(snapshot.expiresAt) <= this.now()) {
      return reject("snapshot_expired");
    }
    if (safeString(snapshot.workspaceId) && safeString(snapshot.workspaceId) !== safeString(effectiveWorkspaceId)) {
      return reject("workspace_mismatch");
    }
    if (safeString(snapshot.huddleId) && safeString(snapshot.huddleId) !== safeString(effectiveHuddleId)) {
      return reject("huddle_mismatch");
    }
    if (safeString(snapshot.channelId) && safeString(snapshot.channelId) !== safeString(effectiveChannelId)) {
      return reject("channel_mismatch");
    }

    const workspaceAccess = await this.checkWorkspaceAccess({
      workspaceId: effectiveWorkspaceId,
      userId: effectiveUserId || null,
      guestId: effectiveGuestId || null,
      access,
      client,
    });
    if (!workspaceAccess?.ok) {
      return reject(workspaceAccess?.reason || "workspace_access_denied");
    }

    const session = currentSession || await this.loadSession({
      sessionId: effectiveSessionId,
      workspaceId: effectiveWorkspaceId,
      client,
    });
    if (!session) return reject("session_required");
    if (String(session.workspace_id || session.workspaceId) !== String(effectiveWorkspaceId)) {
      return reject("session_workspace_mismatch");
    }
    if (session.ended_at || session.state === "ended") {
      return reject("session_ended");
    }

    const participant = currentParticipant || await this.loadParticipant({
      sessionId: session.id || effectiveSessionId,
      workspaceId: effectiveWorkspaceId,
      userId: effectiveUserId || null,
      guestId: effectiveGuestId || null,
      client,
    });
    if (!participant) return reject("participant_required");
    const participantState = String(participant.join_state || "");
    if (participantState === "declined") return reject("participant_declined");
    if (participantState === "removed") return reject("participant_removed");
    if (participantState === "left") return reject("participant_left");

    const currentVersion = sessionVersion(session);
    if (numberValue(snapshot.sessionVersion) < currentVersion) {
      return reject("stale_session_version", {
        snapshotSessionVersion: numberValue(snapshot.sessionVersion),
        currentSessionVersion: currentVersion,
      });
    }

    const fence = await this.fenceService?.getFence?.({
      workspaceId: effectiveWorkspaceId,
      huddleId: effectiveHuddleId,
      userId: effectiveUserId || null,
      guestId: effectiveGuestId || null,
      logicalDeviceId: device.logicalDeviceId,
      client,
    });
    if (fence && numberValue(snapshot.generation) < numberValue(fence.generation)) {
      return reject("stale_generation", {
        snapshotGeneration: numberValue(snapshot.generation),
        currentGeneration: numberValue(fence.generation),
      });
    }
    if (fence && numberValue(snapshot.sessionVersion) < numberValue(fence.session_version)) {
      return reject("fenced_session_version", {
        snapshotSessionVersion: numberValue(snapshot.sessionVersion),
        currentSessionVersion: numberValue(fence.session_version),
      });
    }

    const restoreIdempotencyKey = idempotencyKey || snapshot.idempotencyKey || buildRestoreIdempotencyKey({
      workspaceId: effectiveWorkspaceId,
      sessionId: session.id || effectiveSessionId,
      huddleId: effectiveHuddleId,
      userId: effectiveUserId || null,
      guestId: effectiveGuestId || null,
      logicalDeviceId: device.logicalDeviceId,
      snapshotId: snapshot.snapshotId,
      generation: snapshot.generation,
      sessionVersion: snapshot.sessionVersion,
    });
    const requestHash = hashRestoreRequest({
      snapshotId: snapshot.snapshotId,
      workspaceId: effectiveWorkspaceId,
      sessionId: session.id || effectiveSessionId,
      huddleId: effectiveHuddleId,
      userId: effectiveUserId || null,
      guestId: effectiveGuestId || null,
      logicalDeviceId: device.logicalDeviceId,
      generation: snapshot.generation,
      sessionVersion: snapshot.sessionVersion,
    });
    const attempt = await this.fenceService?.recordRestoreAttempt?.({
      idempotencyKey: restoreIdempotencyKey,
      workspaceId: effectiveWorkspaceId,
      sessionId: session.id || effectiveSessionId,
      huddleId: effectiveHuddleId,
      channelId: effectiveChannelId,
      participantId: participant.id || null,
      userId: effectiveUserId || null,
      guestId: effectiveGuestId || null,
      logicalDeviceId: device.logicalDeviceId,
      snapshotId: snapshot.snapshotId,
      generation: snapshot.generation,
      sessionVersion: snapshot.sessionVersion,
      status: "validated",
      decisionReason: "validated_for_future_restore",
      requestHash,
      metadata: { restorationBlocked: true },
      client,
    });

    return pass({
      session,
      participant,
      fence: fence || null,
      idempotencyKey: restoreIdempotencyKey,
      idempotent: Boolean(attempt?.idempotent),
      logicalDeviceId: device.logicalDeviceId,
    });
  }
}

const huddleRestorationValidator = new HuddleRestorationValidator();

export default huddleRestorationValidator;
