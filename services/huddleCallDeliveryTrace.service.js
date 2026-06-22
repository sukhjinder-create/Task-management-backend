import pool from "../db.js";

export const HUDDLE_CALL_DELIVERY_STEPS = Object.freeze({
  CALL_STARTED: "call_started",
  INCOMING_CALL_DELIVERED: "incoming_call_delivered",
  INCOMING_CALL_DISPLAYED: "incoming_call_displayed",
  ANSWER_PRESSED: "answer_pressed",
  DECLINE_PRESSED: "decline_pressed",
  JOIN_REQUEST_SENT: "join_request_sent",
  JOIN_REQUEST_RECEIVED: "join_request_received",
  PROVIDER_LOCK_RESOLVED: "provider_lock_resolved",
  SESSION_RESOLVED: "session_resolved",
  TOKEN_REQUESTED: "token_requested",
  TOKEN_ISSUED: "token_issued",
  ROOM_CONNECT_STARTED: "room_connect_started",
  ROOM_CONNECT_SUCCESS: "room_connect_success",
  ROOM_CONNECT_FAILED: "room_connect_failed",
  AUDIO_CONNECTED: "audio_connected",
  VIDEO_CONNECTED: "video_connected",
});

export const HUDDLE_CALL_DELIVERY_STATUSES = Object.freeze({
  OBSERVED: "observed",
  ATTEMPTED: "attempted",
  SUCCESS: "success",
  FAILURE: "failure",
});

const allowedSteps = new Set(Object.values(HUDDLE_CALL_DELIVERY_STEPS));
const allowedStatuses = new Set(Object.values(HUDDLE_CALL_DELIVERY_STATUSES));

function safeString(value, max = 500) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function safeUuid(value) {
  const text = safeString(value, 80);
  if (!text) return null;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)
    ? text
    : null;
}

function safeJsonObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return {};
  }
}

function normalizeStatus(value) {
  const status = safeString(value, 40) || HUDDLE_CALL_DELIVERY_STATUSES.OBSERVED;
  return allowedStatuses.has(status) ? status : HUDDLE_CALL_DELIVERY_STATUSES.OBSERVED;
}

export function normalizeCallDeliveryStep(value) {
  const step = safeString(value, 80);
  return allowedSteps.has(step) ? step : null;
}

export async function recordHuddleCallStep(input = {}) {
  const step = normalizeCallDeliveryStep(input.step);
  const huddleId = safeString(input.huddleId || input.huddle_id, 240);
  if (!step || !huddleId) return { ok: false, reason: "invalid_call_delivery_trace_event" };

  const payload = {
    workspaceId: safeUuid(input.workspaceId || input.workspace_id),
    sessionId: safeUuid(input.sessionId || input.session_id),
    huddleId,
    channelId: safeString(input.channelId || input.channel_id, 300),
    actorUserId: safeUuid(input.actorUserId || input.actor_user_id),
    targetUserId: safeUuid(input.targetUserId || input.target_user_id),
    deviceId: safeString(input.deviceId || input.device_id, 240),
    platform: safeString(input.platform, 80),
    clientSurface: safeString(input.clientSurface || input.client_surface, 80),
    step,
    status: normalizeStatus(input.status),
    reason: safeString(input.reason, 300),
    metadata: safeJsonObject(input.metadata),
  };

  try {
    const { rows } = await pool.query(
      `
      INSERT INTO huddle_call_delivery_events (
        workspace_id,
        session_id,
        huddle_id,
        channel_id,
        actor_user_id,
        target_user_id,
        device_id,
        platform,
        client_surface,
        step,
        status,
        reason,
        metadata
      )
      VALUES (
        $1::uuid,
        $2::uuid,
        $3,
        $4,
        $5::uuid,
        $6::uuid,
        $7,
        $8,
        $9,
        $10,
        $11,
        $12,
        $13::jsonb
      )
      RETURNING id, occurred_at
      `,
      [
        payload.workspaceId,
        payload.sessionId,
        payload.huddleId,
        payload.channelId,
        payload.actorUserId,
        payload.targetUserId,
        payload.deviceId,
        payload.platform,
        payload.clientSurface,
        payload.step,
        payload.status,
        payload.reason,
        JSON.stringify(payload.metadata),
      ]
    );
    return { ok: true, event: rows[0] };
  } catch (error) {
    console.warn("[huddle:call-trace] record failed", {
      step: payload.step,
      huddleId: payload.huddleId,
      reason: error?.message || String(error),
    });
    return { ok: false, reason: "call_delivery_trace_record_failed" };
  }
}

export async function listHuddleCallTrace({
  workspaceId,
  sessionId = null,
  huddleId = null,
  limit = 200,
} = {}) {
  const safeWorkspaceId = safeUuid(workspaceId);
  const safeSessionId = safeUuid(sessionId);
  const safeHuddleId = safeString(huddleId, 240);
  if (!safeWorkspaceId || (!safeSessionId && !safeHuddleId)) {
    return { ok: false, reason: "workspace_and_session_or_huddle_required", events: [] };
  }
  const safeLimit = Math.min(Math.max(Number(limit) || 200, 1), 500);
  const params = [safeWorkspaceId, safeLimit];
  let filter = "workspace_id = $1";
  if (safeSessionId) {
    params.push(safeSessionId);
    filter += ` AND session_id = $${params.length}::uuid`;
  }
  if (safeHuddleId) {
    params.push(safeHuddleId);
    filter += ` AND huddle_id = $${params.length}`;
  }
  try {
    const { rows } = await pool.query(
      `
      SELECT
        id,
        workspace_id,
        session_id,
        huddle_id,
        channel_id,
        actor_user_id,
        target_user_id,
        device_id,
        platform,
        client_surface,
        step,
        status,
        reason,
        metadata,
        occurred_at
      FROM huddle_call_delivery_events
      WHERE ${filter}
      ORDER BY occurred_at ASC, created_at ASC
      LIMIT $2
      `,
      params
    );
    return { ok: true, events: rows };
  } catch (error) {
    console.warn("[huddle:call-trace] list failed", {
      workspaceId: safeWorkspaceId,
      sessionId: safeSessionId,
      huddleId: safeHuddleId,
      reason: error?.message || String(error),
    });
    return { ok: false, reason: "call_delivery_trace_list_failed", events: [] };
  }
}

export default {
  recordHuddleCallStep,
  listHuddleCallTrace,
};
