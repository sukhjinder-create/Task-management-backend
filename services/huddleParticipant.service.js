import pool from "../db.js";
import { normalizeHuddleDeviceIdentity } from "./huddleDeviceIdentity.service.js";

function runner(client) {
  return client || pool;
}

function json(value) {
  return JSON.stringify(value || {});
}

function isMissingLogicalDeviceColumn(err) {
  return err?.code === "42703" || /logical_device_id|recovery_generation|recovery_session_version/i.test(err?.message || "");
}

async function findParticipant({
  sessionId,
  userId = null,
  guestId = null,
  client = null,
}) {
  if (!sessionId) throw new Error("sessionId is required");
  if (!userId && !guestId) return null;

  const predicate = userId
    ? "session_id = $1 AND user_id = $2"
    : "session_id = $1 AND guest_id = $2";
  const identity = userId || guestId;

  const { rows } = await runner(client).query(
    `
    SELECT *
    FROM huddle_session_participants
    WHERE ${predicate}
    LIMIT 1
    `,
    [sessionId, identity]
  );

  return rows[0] || null;
}

export async function upsertHuddleParticipant({
  sessionId,
  workspaceId,
  participantKind = "workspace_user",
  userId = null,
  guestId = null,
  role = "participant",
  inviteState = "none",
  joinState = "invited",
  invitedBy = null,
  joinedAt = null,
  leftAt = null,
  lastSeenAt = null,
  metadata = {},
  client = null,
}) {
  if (!sessionId) throw new Error("sessionId is required");
  if (!workspaceId) throw new Error("workspaceId is required");

  const existing = await findParticipant({ sessionId, userId, guestId, client });
  if (existing) {
    if (String(existing.workspace_id) !== String(workspaceId)) {
      throw new Error("participant_workspace_mismatch");
    }
    const { rows } = await runner(client).query(
      `
      UPDATE huddle_session_participants
      SET
        role = COALESCE($3, role),
        invite_state = COALESCE($4, invite_state),
        join_state = COALESCE($5, join_state),
        invited_by = COALESCE($6, invited_by),
        joined_at = COALESCE($7, joined_at),
        left_at = $8,
        last_seen_at = COALESCE($9, now()),
        metadata = metadata || $10::jsonb,
        updated_at = now()
      WHERE id = $1
        AND workspace_id = $2
      RETURNING *
      `,
      [
        existing.id,
        workspaceId,
        role,
        inviteState,
        joinState,
        invitedBy,
        joinedAt,
        leftAt,
        lastSeenAt,
        json(metadata),
      ]
    );
    return rows[0] || existing;
  }

  const { rows } = await runner(client).query(
    `
    INSERT INTO huddle_session_participants (
      session_id,
      workspace_id,
      participant_kind,
      user_id,
      guest_id,
      role,
      invite_state,
      join_state,
      invited_by,
      joined_at,
      left_at,
      last_seen_at,
      metadata
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, COALESCE($12, now()), $13)
    RETURNING *
    `,
    [
      sessionId,
      workspaceId,
      participantKind,
      userId,
      guestId,
      role,
      inviteState,
      joinState,
      invitedBy,
      joinedAt,
      leftAt,
      lastSeenAt,
      json(metadata),
    ]
  );

  return rows[0];
}

export async function upsertHuddleParticipantDevice({
  sessionId,
  participantId,
  workspaceId,
  userId = null,
  guestId = null,
  socketId = null,
  deviceId = null,
  platform = null,
  deviceLabel = null,
  logicalDeviceId = null,
  recoveryGeneration = 0,
  recoverySessionVersion = 0,
  restoreIdempotencyKey = null,
  joinState = "joined",
  mediaState = {},
  metadata = {},
  client = null,
}) {
  if (!sessionId) throw new Error("sessionId is required");
  if (!participantId) throw new Error("participantId is required");
  if (!workspaceId) throw new Error("workspaceId is required");

  const identity = normalizeHuddleDeviceIdentity({
    deviceId,
    socketId,
    userId,
    guestId,
    platform,
  });
  const stableLogicalDeviceId = logicalDeviceId || identity.logicalDeviceId;
  const enrichedMetadata = {
    ...metadata,
    logicalDeviceSource: identity.source,
  };

  async function findExistingDeviceWithLogicalIdentity() {
    if (stableLogicalDeviceId) {
      const { rows } = await runner(client).query(
        `
        SELECT *
        FROM huddle_participant_devices
        WHERE session_id = $1
          AND participant_id = $2
          AND logical_device_id = $3
          AND left_at IS NULL
        LIMIT 1
        `,
        [sessionId, participantId, stableLogicalDeviceId]
      );
      if (rows[0]) return rows[0];
    }

    if (!socketId) return null;
    const { rows } = await runner(client).query(
      `
      SELECT *
      FROM huddle_participant_devices
      WHERE session_id = $1
        AND participant_id = $2
        AND socket_id = $3
        AND left_at IS NULL
      LIMIT 1
      `,
      [sessionId, participantId, socketId]
    );
    return rows[0] || null;
  }

  try {
    const existingDevice = await findExistingDeviceWithLogicalIdentity();
    if (existingDevice) {
      const { rows } = await runner(client).query(
        `
        UPDATE huddle_participant_devices
        SET
          join_state = $2,
          media_state = media_state || $3::jsonb,
          socket_id = COALESCE($5, socket_id),
          device_id = COALESCE($6, device_id),
          logical_device_id = COALESCE($7, logical_device_id),
          platform = COALESCE($8, platform),
          recovery_generation = GREATEST(recovery_generation, $9),
          recovery_session_version = GREATEST(recovery_session_version, $10),
          restore_idempotency_key = COALESCE($11, restore_idempotency_key),
          last_seen_at = now(),
          metadata = metadata || $4::jsonb,
          updated_at = now()
        WHERE id = $1
        RETURNING *
        `,
        [
          existingDevice.id,
          joinState,
          json(mediaState),
          json(enrichedMetadata),
          socketId,
          deviceId,
          stableLogicalDeviceId,
          platform,
          recoveryGeneration || 0,
          recoverySessionVersion || 0,
          restoreIdempotencyKey,
        ]
      );
      return rows[0];
    }
  } catch (err) {
    if (!isMissingLogicalDeviceColumn(err)) throw err;
  }

  try {
    const { rows } = await runner(client).query(
      `
      INSERT INTO huddle_participant_devices (
        session_id,
        participant_id,
        workspace_id,
        user_id,
        guest_id,
        socket_id,
        device_id,
        logical_device_id,
        platform,
        device_label,
        join_state,
        recovery_generation,
        recovery_session_version,
        restore_idempotency_key,
        media_state,
        metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      RETURNING *
      `,
      [
        sessionId,
        participantId,
        workspaceId,
        userId,
        guestId,
        socketId,
        deviceId,
        stableLogicalDeviceId,
        platform,
        deviceLabel,
        joinState,
        recoveryGeneration || 0,
        recoverySessionVersion || 0,
        restoreIdempotencyKey,
        json(mediaState),
        json(enrichedMetadata),
      ]
    );

    return rows[0];
  } catch (err) {
    if (!isMissingLogicalDeviceColumn(err)) throw err;
    const { rows } = await runner(client).query(
      `
      INSERT INTO huddle_participant_devices (
        session_id,
        participant_id,
        workspace_id,
        user_id,
        guest_id,
        socket_id,
        device_id,
        platform,
        device_label,
        join_state,
        media_state,
        metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING *
      `,
      [
        sessionId,
        participantId,
        workspaceId,
        userId,
        guestId,
        socketId,
        deviceId,
        platform,
        deviceLabel,
        joinState,
        json(mediaState),
        json(metadata),
      ]
    );

    return rows[0];
  }
}

export async function markParticipantLeft({
  sessionId,
  workspaceId,
  userId = null,
  guestId = null,
  socketId = null,
  deviceId = null,
  logicalDeviceId = null,
  matchLogicalDevice = false,
  client = null,
}) {
  const participant = await findParticipant({ sessionId, userId, guestId, client });
  if (!participant) return null;

  const identity = normalizeHuddleDeviceIdentity({ deviceId, socketId, userId, guestId });
  const stableLogicalDeviceId = logicalDeviceId || identity.logicalDeviceId;

  if (socketId || (matchLogicalDevice && stableLogicalDeviceId)) {
    try {
      await runner(client).query(
        `
        UPDATE huddle_participant_devices
        SET
          join_state = 'left',
          left_at = COALESCE(left_at, now()),
          last_seen_at = now(),
          updated_at = now()
        WHERE session_id = $1
          AND participant_id = $2
          AND (
            ($3::text IS NOT NULL AND socket_id = $3)
            OR ($4::text IS NOT NULL AND logical_device_id = $4)
          )
          AND left_at IS NULL
        `,
        [sessionId, participant.id, socketId || null, matchLogicalDevice ? stableLogicalDeviceId : null]
      );
    } catch (err) {
      if (!isMissingLogicalDeviceColumn(err)) throw err;
      if (!socketId) throw err;
      await runner(client).query(
        `
        UPDATE huddle_participant_devices
        SET
          join_state = 'left',
          left_at = COALESCE(left_at, now()),
          last_seen_at = now(),
          updated_at = now()
        WHERE session_id = $1
          AND participant_id = $2
          AND socket_id = $3
          AND left_at IS NULL
        `,
        [sessionId, participant.id, socketId]
      );
    }

    const { rows: activeDeviceRows } = await runner(client).query(
      `
      SELECT COUNT(*)::int AS active_count
      FROM huddle_participant_devices
      WHERE session_id = $1
        AND participant_id = $2
        AND left_at IS NULL
      `,
      [sessionId, participant.id]
    );

    if ((activeDeviceRows[0]?.active_count || 0) > 0) {
      const { rows } = await runner(client).query(
        `
        UPDATE huddle_session_participants
        SET
          join_state = 'joined',
          left_at = NULL,
          last_seen_at = now(),
          updated_at = now()
        WHERE id = $1
          AND workspace_id = $2
        RETURNING *
        `,
        [participant.id, workspaceId]
      );
      return rows[0] || participant;
    }
  } else {
    await runner(client).query(
      `
      UPDATE huddle_participant_devices
      SET
        join_state = 'left',
        left_at = COALESCE(left_at, now()),
        last_seen_at = now(),
        updated_at = now()
      WHERE session_id = $1
        AND participant_id = $2
        AND left_at IS NULL
      `,
      [sessionId, participant.id]
    );
  }

  const { rows } = await runner(client).query(
    `
    UPDATE huddle_session_participants
    SET
      join_state = 'left',
      left_at = COALESCE(left_at, now()),
      last_seen_at = now(),
      updated_at = now()
    WHERE id = $1
      AND workspace_id = $2
    RETURNING *
    `,
    [participant.id, workspaceId]
  );

  return rows[0] || participant;
}

export async function markParticipantDeclined({
  sessionId,
  workspaceId,
  userId = null,
  guestId = null,
  client = null,
}) {
  const participant = await upsertHuddleParticipant({
    sessionId,
    workspaceId,
    participantKind: guestId ? "guest" : "workspace_user",
    userId,
    guestId,
    role: guestId ? "guest" : "participant",
    inviteState: "declined",
    joinState: "declined",
    lastSeenAt: new Date(),
    client,
  });

  return participant;
}

export async function markSessionParticipantsLeft({
  sessionId,
  workspaceId,
  client = null,
}) {
  if (!sessionId) throw new Error("sessionId is required");
  if (!workspaceId) throw new Error("workspaceId is required");

  await runner(client).query(
    `
    UPDATE huddle_participant_devices
    SET
      join_state = 'left',
      left_at = COALESCE(left_at, now()),
      last_seen_at = now(),
      updated_at = now()
    WHERE session_id = $1
      AND workspace_id = $2
      AND left_at IS NULL
    `,
    [sessionId, workspaceId]
  );

  const { rows } = await runner(client).query(
    `
    UPDATE huddle_session_participants
    SET
      join_state = CASE
        WHEN join_state IN ('declined', 'removed') THEN join_state
        ELSE 'left'
      END,
      left_at = CASE
        WHEN join_state IN ('declined', 'removed') THEN left_at
        ELSE COALESCE(left_at, now())
      END,
      last_seen_at = now(),
      updated_at = now()
    WHERE session_id = $1
      AND workspace_id = $2
    RETURNING *
    `,
    [sessionId, workspaceId]
  );

  return rows;
}

export default {
  upsertHuddleParticipant,
  upsertHuddleParticipantDevice,
  markParticipantLeft,
  markParticipantDeclined,
  markSessionParticipantsLeft,
};
