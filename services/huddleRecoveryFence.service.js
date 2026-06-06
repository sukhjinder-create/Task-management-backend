import crypto from "node:crypto";

import pool from "../db.js";
import { normalizeHuddleDeviceIdentity } from "./huddleDeviceIdentity.service.js";

function runner(client) {
  return client || pool;
}

function safeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function toBigIntNumber(value) {
  const parsed = Number(value || 0);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

function json(value) {
  return JSON.stringify(value || {});
}

function identityFor({ userId = null, guestId = null } = {}) {
  if (safeString(userId)) {
    return { identityKind: "user", identityId: safeString(userId), userId: safeString(userId), guestId: null };
  }
  if (safeString(guestId)) {
    return { identityKind: "guest", identityId: safeString(guestId), userId: null, guestId: safeString(guestId) };
  }
  return { identityKind: "anonymous", identityId: "anonymous", userId: null, guestId: null };
}

export function buildRestoreIdempotencyKey({
  workspaceId,
  sessionId = null,
  huddleId,
  userId = null,
  guestId = null,
  logicalDeviceId,
  snapshotId = null,
  generation = 0,
  sessionVersion = 0,
} = {}) {
  const identity = identityFor({ userId, guestId });
  return [
    "huddle-restore",
    workspaceId,
    sessionId || "no-session",
    huddleId,
    identity.identityKind,
    identity.identityId,
    logicalDeviceId,
    snapshotId || "no-snapshot",
    toBigIntNumber(generation),
    toBigIntNumber(sessionVersion),
  ].map((part) => safeString(String(part || "unknown"))).join(":");
}

export function hashRestoreRequest(value) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(value || {}))
    .digest("hex");
}

export class HuddleRecoveryFenceService {
  constructor({ db = pool } = {}) {
    this.db = db;
  }

  async reserveSnapshotFence({
    workspaceId,
    sessionId = null,
    huddleId,
    channelId = null,
    participantId = null,
    userId = null,
    guestId = null,
    deviceContext = {},
    logicalDeviceId = null,
    sessionVersion = 0,
    snapshotId = null,
    idempotencyKey = null,
    metadata = {},
    client = null,
  } = {}) {
    if (!workspaceId || !huddleId) {
      return null;
    }
    const identity = identityFor({ userId, guestId });
    const device = normalizeHuddleDeviceIdentity({
      ...deviceContext,
      userId,
      guestId,
    });
    const stableDeviceId = safeString(logicalDeviceId) || device.logicalDeviceId;
    if (!stableDeviceId) return null;

    const { rows } = await runner(client || this.db).query(
      `
      INSERT INTO huddle_recovery_fences (
        workspace_id,
        session_id,
        huddle_id,
        channel_id,
        participant_id,
        identity_kind,
        identity_id,
        user_id,
        guest_id,
        logical_device_id,
        generation,
        session_version,
        last_snapshot_id,
        last_idempotency_key,
        metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 1, $11, $12, $13, $14)
      ON CONFLICT (
        workspace_id,
        huddle_id,
        identity_kind,
        identity_id,
        logical_device_id
      )
      DO UPDATE SET
        session_id = COALESCE(EXCLUDED.session_id, huddle_recovery_fences.session_id),
        channel_id = COALESCE(EXCLUDED.channel_id, huddle_recovery_fences.channel_id),
        participant_id = COALESCE(EXCLUDED.participant_id, huddle_recovery_fences.participant_id),
        generation = huddle_recovery_fences.generation + 1,
        session_version = GREATEST(huddle_recovery_fences.session_version, EXCLUDED.session_version),
        last_snapshot_id = COALESCE(EXCLUDED.last_snapshot_id, huddle_recovery_fences.last_snapshot_id),
        last_idempotency_key = COALESCE(EXCLUDED.last_idempotency_key, huddle_recovery_fences.last_idempotency_key),
        last_seen_at = now(),
        updated_at = now(),
        metadata = huddle_recovery_fences.metadata || EXCLUDED.metadata
      RETURNING *
      `,
      [
        workspaceId,
        sessionId,
        huddleId,
        channelId,
        participantId,
        identity.identityKind,
        identity.identityId,
        identity.userId,
        identity.guestId,
        stableDeviceId,
        toBigIntNumber(sessionVersion),
        snapshotId,
        idempotencyKey,
        json(metadata),
      ]
    );
    return rows[0] || null;
  }

  async getFence({
    workspaceId,
    huddleId,
    userId = null,
    guestId = null,
    logicalDeviceId,
    client = null,
  } = {}) {
    if (!workspaceId || !huddleId || !logicalDeviceId) return null;
    const identity = identityFor({ userId, guestId });
    const { rows } = await runner(client || this.db).query(
      `
      SELECT *
      FROM huddle_recovery_fences
      WHERE workspace_id = $1
        AND huddle_id = $2
        AND identity_kind = $3
        AND identity_id = $4
        AND logical_device_id = $5
      LIMIT 1
      `,
      [workspaceId, huddleId, identity.identityKind, identity.identityId, logicalDeviceId]
    );
    return rows[0] || null;
  }

  async recordRestoreAttempt({
    idempotencyKey,
    workspaceId,
    sessionId = null,
    huddleId,
    channelId = null,
    participantId = null,
    userId = null,
    guestId = null,
    logicalDeviceId,
    snapshotId = null,
    generation = 0,
    sessionVersion = 0,
    status = "validated",
    decisionReason = null,
    requestHash = null,
    metadata = {},
    client = null,
  } = {}) {
    if (!idempotencyKey) throw new Error("idempotencyKey is required");
    const identity = identityFor({ userId, guestId });
    const { rows } = await runner(client || this.db).query(
      `
      INSERT INTO huddle_restore_attempts (
        idempotency_key,
        workspace_id,
        session_id,
        huddle_id,
        channel_id,
        participant_id,
        identity_kind,
        identity_id,
        user_id,
        guest_id,
        logical_device_id,
        snapshot_id,
        generation,
        session_version,
        status,
        decision_reason,
        request_hash,
        metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
      ON CONFLICT (idempotency_key)
      DO UPDATE SET
        updated_at = huddle_restore_attempts.updated_at
      RETURNING *, (xmax = 0) AS inserted
      `,
      [
        idempotencyKey,
        workspaceId,
        sessionId,
        huddleId,
        channelId,
        participantId,
        identity.identityKind,
        identity.identityId,
        identity.userId,
        identity.guestId,
        logicalDeviceId,
        snapshotId,
        toBigIntNumber(generation),
        toBigIntNumber(sessionVersion),
        status,
        decisionReason,
        requestHash,
        json(metadata),
      ]
    );
    const row = rows[0] || null;
    return row ? { ...row, idempotent: row.inserted === false } : null;
  }
}

export class MemoryHuddleRecoveryFenceStore {
  constructor() {
    this.fences = new Map();
    this.attempts = new Map();
  }

  key({ workspaceId, huddleId, userId = null, guestId = null, logicalDeviceId }) {
    const identity = identityFor({ userId, guestId });
    return [workspaceId, huddleId, identity.identityKind, identity.identityId, logicalDeviceId]
      .map((part) => safeString(String(part || "unknown")))
      .join(":");
  }

  async reserveSnapshotFence(params = {}) {
    if (!params.workspaceId || !params.huddleId) return null;
    const device = normalizeHuddleDeviceIdentity({
      ...(params.deviceContext || {}),
      userId: params.userId,
      guestId: params.guestId,
    });
    const logicalDeviceId = params.logicalDeviceId || device.logicalDeviceId;
    const key = this.key({ ...params, logicalDeviceId });
    const existing = this.fences.get(key) || {};
    const next = {
      ...existing,
      workspace_id: params.workspaceId,
      session_id: params.sessionId || existing.session_id || null,
      huddle_id: params.huddleId,
      channel_id: params.channelId || existing.channel_id || null,
      participant_id: params.participantId || existing.participant_id || null,
      user_id: params.userId || null,
      guest_id: params.guestId || null,
      logical_device_id: logicalDeviceId,
      generation: (existing.generation || 0) + 1,
      session_version: Math.max(
        toBigIntNumber(existing.session_version),
        toBigIntNumber(params.sessionVersion)
      ),
      last_snapshot_id: params.snapshotId || existing.last_snapshot_id || null,
      last_idempotency_key: params.idempotencyKey || existing.last_idempotency_key || null,
    };
    this.fences.set(key, next);
    return next;
  }

  async getFence(params = {}) {
    const key = this.key(params);
    return this.fences.get(key) || null;
  }

  async recordRestoreAttempt(params = {}) {
    if (!params.idempotencyKey) throw new Error("idempotencyKey is required");
    if (this.attempts.has(params.idempotencyKey)) {
      return { ...this.attempts.get(params.idempotencyKey), idempotent: true };
    }
    const row = {
      idempotency_key: params.idempotencyKey,
      workspace_id: params.workspaceId,
      session_id: params.sessionId || null,
      huddle_id: params.huddleId,
      channel_id: params.channelId || null,
      participant_id: params.participantId || null,
      user_id: params.userId || null,
      guest_id: params.guestId || null,
      logical_device_id: params.logicalDeviceId,
      snapshot_id: params.snapshotId || null,
      generation: toBigIntNumber(params.generation),
      session_version: toBigIntNumber(params.sessionVersion),
      status: params.status || "validated",
      decision_reason: params.decisionReason || null,
      request_hash: params.requestHash || null,
      idempotent: false,
    };
    this.attempts.set(params.idempotencyKey, row);
    return row;
  }
}

const huddleRecoveryFenceService = new HuddleRecoveryFenceService();

export default huddleRecoveryFenceService;
