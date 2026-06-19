// src/realtime/socket.js
// Workspace-aware Socket.IO server that preserves legacy behavior.
// Backwards compatible: keeps legacy room names and emits, while also
// adding optional workspace-scoped rooms for newer clients.
import pool from "../db.js";
import { Server } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import { createClient } from "redis";
import jwt from "jsonwebtoken";

import {
  ensureChannelMember,
  createChatMessage,
  updateChatMessage,
  softDeleteChatMessage,
  isChannelMember,
  isChannelAdmin,
  getChannelMembers,
} from "../services/chat.service.js";

import {
  getChannelByKey,
  getRecentMessagesResolved,
} from "../services/chat.service.js";

import { sendPushToUser } from "../services/push.service.js";

import huddleCompatibilityAdapter from "../services/huddleCompatibilityAdapter.service.js";
import huddleRealtimeService from "../services/huddleRealtime.service.js";
import huddleRecoveryService from "../services/huddleRecovery.service.js";
import {
  enforceSocketHuddleProviderLock,
  getProviderLockDiagnostics,
} from "../services/huddleProviderLockGuard.service.js";
import {
  HUDDLE_MEDIA_PROVIDERS,
  normalizeMediaProviderType,
} from "../services/huddleMediaSession.service.js";

import workspaceService from "../services/workspace.service.js";
import { getPlanBySlug } from "../repositories/billingPlans.repository.js";
import { registerAiSocket } from "./ai.socket.js";  // import AI socket handler
import { recomputeWorkspaceHealth } from "../services/workspaceHealth.service.js";

let io;
let socketRealtimeDiagnostics = {
  adapter: "local",
  distributed: false,
  ready: false,
  required: false,
  reason: "socket_io_not_initialized",
  configuredAt: null,
};
const JWT_SECRET = process.env.JWT_SECRET || "task_management_secret";
const WORKSPACE_GLOBAL = "GLOBAL";
const parsedHuddleDisconnectGraceMs = Number(process.env.HUDDLE_DISCONNECT_GRACE_MS || 15000);
const HUDDLE_DISCONNECT_GRACE_MS = Number.isFinite(parsedHuddleDisconnectGraceMs)
  ? Math.max(0, parsedHuddleDisconnectGraceMs)
  : 15000;
const pendingHuddleDisconnectTimers = new Map();

/**
 * For DM channels we use key pattern:
 *   dm:<uidSmall>:<uidBig>
 */
function getChannelMetaFromKey(channelKey) {
  if (channelKey === "general") return { type: "public", name: "#general" };
  if (channelKey.startsWith("dm:")) return { type: "dm", name: "Direct message" };
  if (channelKey.startsWith("thread:")) return { type: "thread", name: "Thread" };
  return { type: "public", name: channelKey };
}

function legacyRoomName(channelKey) {
  return `channel:${channelKey}`;
}
function workspaceRoomName(channelKey, workspaceId = WORKSPACE_GLOBAL) {
  const ws = workspaceId || WORKSPACE_GLOBAL;
  return `workspace:${ws}:channel:${channelKey}`;
}

function boolEnv(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function getSocketRedisUrl() {
  return (
    process.env.SOCKET_IO_REDIS_URL ||
    process.env.HUDDLE_SOCKET_REDIS_URL ||
    process.env.REDIS_URL ||
    process.env.HUDDLE_REDIS_URL ||
    ""
  ).trim();
}

function redactRedisUrl(value) {
  if (!value) return "";
  try {
    const parsed = new URL(value);
    if (parsed.password) parsed.password = "***";
    if (parsed.username) parsed.username = "***";
    return parsed.toString();
  } catch {
    return "(invalid redis url)";
  }
}

async function configureSocketIoRedisAdapter(ioInstance) {
  const redisUrl = getSocketRedisUrl();
  const required = boolEnv(process.env.SOCKET_IO_REDIS_REQUIRED, false);
  socketRealtimeDiagnostics = {
    adapter: "local",
    distributed: false,
    ready: false,
    required,
    reason: redisUrl ? "redis_adapter_connecting" : "redis_url_missing",
    configuredAt: new Date().toISOString(),
  };

  if (!redisUrl) {
    console.warn("[socket:redis_adapter:disabled]", {
      reason: "redis_url_missing",
      maxScaleRisk: "cross_instance_socket_emits_are_local_only",
    });
    if (required) {
      throw new Error("socket_io_redis_required_but_missing");
    }
    return;
  }

  const pubClient = createClient({ url: redisUrl });
  const subClient = pubClient.duplicate();
  const onRedisError = (role) => (error) => {
    socketRealtimeDiagnostics = {
      ...socketRealtimeDiagnostics,
      adapter: "redis",
      distributed: false,
      ready: false,
      reason: `redis_${role}_error:${error.message}`,
      errorAt: new Date().toISOString(),
    };
    console.error("[socket:redis_adapter:error]", {
      role,
      error: error.message,
      url: redactRedisUrl(redisUrl),
    });
  };

  pubClient.on("error", onRedisError("pub"));
  subClient.on("error", onRedisError("sub"));

  try {
    await Promise.all([pubClient.connect(), subClient.connect()]);
    ioInstance.adapter(createAdapter(pubClient, subClient));
    socketRealtimeDiagnostics = {
      adapter: "redis",
      distributed: true,
      ready: true,
      required,
      reason: "redis_adapter_ready",
      configuredAt: socketRealtimeDiagnostics.configuredAt,
      readyAt: new Date().toISOString(),
      url: redactRedisUrl(redisUrl),
    };
    console.log("[socket:redis_adapter:ready]", {
      distributed: true,
      url: redactRedisUrl(redisUrl),
    });
  } catch (error) {
    socketRealtimeDiagnostics = {
      adapter: "redis",
      distributed: false,
      ready: false,
      required,
      reason: `redis_adapter_connect_failed:${error.message}`,
      configuredAt: socketRealtimeDiagnostics.configuredAt,
      errorAt: new Date().toISOString(),
      url: redactRedisUrl(redisUrl),
    };
    console.error("[socket:redis_adapter:failed]", {
      error: error.message,
      url: redactRedisUrl(redisUrl),
      required,
    });
    try {
      await Promise.allSettled([pubClient.quit(), subClient.quit()]);
    } catch {}
    if (required) throw error;
  }
}

function dmParticipantIds(channelId) {
  if (typeof channelId !== "string" || !channelId.startsWith("dm:")) return [];
  return channelId.split(":").slice(1).filter(Boolean);
}

function extractPlainText(input) {
  if (!input) return "";

  // If encrypted JSON string, try extracting fallbackText
  if (typeof input === "string" && input.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(input);
      if (typeof parsed?.fallbackText === "string") {
        return parsed.fallbackText.trim();
      }
    } catch {
      // ignore parse errors
    }
  }

  // Otherwise assume normal HTML/text
  return input
    .replace(/<[^>]*>/g, "")
    .trim();
}

function resolveRenderableText(m) {
  if (m.updated_at && m.text_html) {
    return m.text_html;
  }
  // 1️⃣ Plain text (legacy)
  if (m.text_html && typeof m.text_html === "string" && !m.text_html.startsWith("{")) {
    return m.text_html;
  }

  // 2️⃣ Explicit fallback_text column
  if (m.fallback_text) {
    return m.fallback_text;
  }

  // 3️⃣ Encrypted JSON → extract fallbackText
  if (m.encrypted_json?.message) {
    try {
      const parsed =
        typeof m.encrypted_json.message === "string"
          ? JSON.parse(m.encrypted_json.message)
          : m.encrypted_json.message;

      if (typeof parsed?.fallbackText === "string") {
        return parsed.fallbackText;
      }
    } catch {
      return "";
    }
  }

  return "";
}

// utils / local helper
function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value
  );
}

const HUDDLE_ADMIN_ROLES = new Set(["admin", "owner"]);
const HUDDLE_ALLOWED_FALLBACK_PLANS = new Set(["basic", "pro", "enterprise"]);
const HUDDLE_BLOCKED_FALLBACK_PLANS = new Set(["free", "starter"]);

function normalizeSocketId(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeOptionalSocketValue(value) {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  return "";
}

function getHuddleSocketDeviceContext(socket, payload = {}) {
  const auth = socket?.handshake?.auth || {};
  const query = socket?.handshake?.query || {};
  const deviceId =
    normalizeOptionalSocketValue(payload.deviceId) ||
    normalizeOptionalSocketValue(auth.deviceId) ||
    normalizeOptionalSocketValue(query.deviceId) ||
    "";
  const platform =
    normalizeOptionalSocketValue(payload.platform) ||
    normalizeOptionalSocketValue(auth.platform) ||
    normalizeOptionalSocketValue(query.platform) ||
    "";
  return {
    deviceId,
    platform,
    socketId: socket?.id || null,
  };
}

function getResolvedHuddleSession({ room = null, active = null, session = null, sessionId = null } = {}) {
  const id =
    session?.id ||
    sessionId ||
    room?.sessionId ||
    active?.session_id ||
    active?.sessionId ||
    null;
  if (!id) return null;
  return {
    id,
    workspace_id:
      session?.workspace_id ||
      room?.workspaceId ||
      active?.workspace_id ||
      null,
    legacy_huddle_id:
      session?.legacy_huddle_id ||
      room?.huddleId ||
      active?.huddle_id ||
      null,
    legacy_channel_key:
      session?.legacy_channel_key ||
      room?.channelId ||
      active?.channel_key ||
      null,
    state: session?.state || "live",
  };
}

function isSocketReconnect(socket) {
  const auth = socket?.handshake?.auth || {};
  const query = socket?.handshake?.query || {};
  return Boolean(
    socket?.recovered ||
      auth.recovered ||
      auth.reconnect ||
      query.recovered ||
      query.reconnect
  );
}

function isDmChannelKey(channelId) {
  return typeof channelId === "string" && channelId.startsWith("dm:");
}

function isThreadChannelKey(channelId) {
  return typeof channelId === "string" && channelId.startsWith("thread:");
}

function normalizeFeatures(features) {
  if (Array.isArray(features)) return features.map((f) => String(f));
  if (typeof features === "string") {
    try {
      const parsed = JSON.parse(features);
      return Array.isArray(parsed) ? parsed.map((f) => String(f)) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function hasFeature(features, key) {
  return normalizeFeatures(features).includes(key);
}

function isHuddleEnvEnabled(value) {
  return normalizeSocketId(value).toLowerCase() === "true";
}

function splitHuddleCsv(value) {
  return normalizeSocketId(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function isLiveKitCanaryWorkspaceAllowed(workspaceId, env = process.env) {
  const resolvedWorkspaceId = normalizeSocketId(workspaceId);
  const allowlist = splitHuddleCsv(env.HUDDLE_LIVEKIT_CANARY_WORKSPACES);
  return (
    isHuddleEnvEnabled(env.HUDDLE_LIVEKIT_CANARY_ENABLED) &&
    (allowlist.includes("*") ||
      (Boolean(resolvedWorkspaceId) && allowlist.includes(resolvedWorkspaceId)))
  );
}

function emitHuddleDenied(socket, action, reason, extra = {}) {
  socket.emit("huddle:error", {
    action,
    reason,
    ...extra,
  });
  console.warn("[huddle:authz:denied]", {
    socketId: socket.id,
    userId: socket.user?.id,
    workspaceId: socket.workspaceId,
    action,
    reason,
    ...extra,
  });
}

function resolveSocketRequestedProvider(payload = {}) {
  return normalizeMediaProviderType(
    payload?.provider ||
    payload?.providerType ||
    payload?.mediaProvider ||
    HUDDLE_MEDIA_PROVIDERS.MESH
  );
}

function resolveSocketClientCapabilities(payload = {}) {
  const supplied =
    payload?.clientCapabilities ||
    payload?.capabilities ||
    payload?.client ||
    null;
  if (supplied && typeof supplied === "object" && !Array.isArray(supplied)) {
    return supplied;
  }
  return null;
}

function hasLiveKitEntitlement(ctx = {}) {
  return Boolean(ctx.huddleEntitlement?.liveKit);
}

async function getWorkspaceHuddleContext(socket) {
  const workspaceId = socket.workspaceId;
  const userId = String(socket.user?.id || "");
  if (!workspaceId || workspaceId === WORKSPACE_GLOBAL || !userId) {
    return { ok: false, reason: "workspace_required" };
  }

  const workspace = await workspaceService.getOne(workspaceId);
  if (!workspace) return { ok: false, reason: "workspace_not_found" };
  if (workspace.status && workspace.status !== "active") {
    return { ok: false, reason: "workspace_inactive" };
  }

  const membership = await workspaceService.getMembership(workspaceId, userId);
  if (!membership) return { ok: false, reason: "workspace_membership_required" };
  if (membership.billing_status === "pending") {
    return { ok: false, reason: "workspace_member_pending" };
  }

  const trialEndsAt = workspace.trial_ends_at ? new Date(workspace.trial_ends_at) : null;
  const onTrial = trialEndsAt && trialEndsAt > new Date();
  if (onTrial) {
    return {
      ok: true,
      workspace,
      membership,
      huddleEntitlement: {
        onTrial: true,
        features: [],
        liveKit: true,
        canaryLiveKit: isLiveKitCanaryWorkspaceAllowed(workspaceId),
      },
    };
  }

  const planSlug = workspace.billing_plan || workspace.plan || null;
  const plan = planSlug ? await getPlanBySlug(planSlug).catch(() => null) : null;
  const features = normalizeFeatures(plan?.features);
  const canaryLiveKitEntitled = isLiveKitCanaryWorkspaceAllowed(workspaceId);
  const liveKitEntitled =
    hasFeature(features, "video_huddle") || canaryLiveKitEntitled;

  if (hasFeature(features, "video_huddle") || hasFeature(features, "huddle")) {
    return {
      ok: true,
      workspace,
      membership,
      huddleEntitlement: {
        onTrial: false,
        features,
        liveKit: liveKitEntitled,
        canaryLiveKit: canaryLiveKitEntitled,
      },
    };
  }

  const normalizedPlan = String(planSlug || "").toLowerCase();
  if (HUDDLE_ALLOWED_FALLBACK_PLANS.has(normalizedPlan)) {
    return {
      ok: true,
      workspace,
      membership,
      huddleEntitlement: {
        onTrial: false,
        features,
        liveKit: canaryLiveKitEntitled,
        canaryLiveKit: canaryLiveKitEntitled,
      },
    };
  }
  if (HUDDLE_BLOCKED_FALLBACK_PLANS.has(normalizedPlan)) {
    return { ok: false, reason: "plan_entitlement_required" };
  }

  // Preserve legacy workspaces whose plan rows predate machine-readable features.
  if (!planSlug && features.length === 0) {
    return {
      ok: true,
      workspace,
      membership,
      huddleEntitlement: {
        onTrial: false,
        features,
        liveKit: canaryLiveKitEntitled,
        canaryLiveKit: canaryLiveKitEntitled,
      },
    };
  }

  return { ok: false, reason: "plan_entitlement_required" };
}

async function getActiveWorkspaceUserIds(workspaceId, exceptUserId = null) {
  const { rows } = await pool.query(
    `
    SELECT user_id
    FROM workspace_users
    WHERE workspace_id = $1
      AND (billing_status IS NULL OR billing_status != 'pending')
    `,
    [workspaceId]
  );
  return rows
    .map((row) => String(row.user_id))
    .filter((uid) => !exceptUserId || uid !== String(exceptUserId));
}

async function resolveDmScope(channelId, workspaceId, actorUserId) {
  const participantIds = dmParticipantIds(channelId).map(String);
  if (participantIds.length !== 2) {
    return { ok: false, reason: "invalid_dm_channel" };
  }
  if (participantIds.some((uid) => !isUuid(uid))) {
    return { ok: false, reason: "invalid_dm_participant" };
  }
  if (!participantIds.includes(String(actorUserId))) {
    return { ok: false, reason: "dm_participation_required" };
  }

  const { rows } = await pool.query(
    `
    SELECT user_id
    FROM workspace_users
    WHERE workspace_id = $1
      AND user_id = ANY($2::uuid[])
      AND (billing_status IS NULL OR billing_status != 'pending')
    `,
    [workspaceId, participantIds]
  );
  const activeIds = new Set(rows.map((row) => String(row.user_id)));
  if (participantIds.some((uid) => !activeIds.has(uid))) {
    return { ok: false, reason: "dm_workspace_membership_required" };
  }

  return {
    ok: true,
    scope: {
      type: "dm",
      channelId,
      workspaceId,
      participantIds,
      isPrivate: true,
    },
  };
}

async function resolveChannelScope(channelId, workspaceId, actorUserId) {
  const channel = await getChannelByKey(channelId, workspaceId);
  if (!channel) return { ok: false, reason: "channel_not_found" };

  const isPrivate = Boolean(channel.isPrivate || channel.is_private);
  if (isPrivate) {
    const member = await isChannelMember(channel.id, actorUserId);
    if (!member) return { ok: false, reason: "channel_membership_required" };
  }

  return {
    ok: true,
    scope: {
      type: "channel",
      channelId,
      workspaceId,
      channel,
      isPrivate,
    },
  };
}

async function resolveThreadScope(channelId, workspaceId, actorUserId) {
  const parts = channelId.split(":");
  const messageId = parts[parts.length - 1];
  if (!isUuid(messageId)) {
    return { ok: false, reason: "invalid_thread_channel" };
  }

  const { rows } = await pool.query(
    `
    SELECT channel_key
    FROM chat_messages
    WHERE id = $1
      AND workspace_id = $2
      AND deleted_at IS NULL
    LIMIT 1
    `,
    [messageId, workspaceId]
  );
  const parentChannelKey = rows[0]?.channel_key;
  if (!parentChannelKey) return { ok: false, reason: "thread_not_found" };

  const parent = isDmChannelKey(parentChannelKey)
    ? await resolveDmScope(parentChannelKey, workspaceId, actorUserId)
    : await resolveChannelScope(parentChannelKey, workspaceId, actorUserId);

  if (!parent.ok) return parent;

  return {
    ok: true,
    scope: {
      ...parent.scope,
      type: "thread",
      channelId,
      parentChannelId: parentChannelKey,
      parentScope: parent.scope,
      isPrivate: true,
    },
  };
}

async function resolveHuddleScope(channelId, workspaceId, actorUserId) {
  const safeChannelId = normalizeSocketId(channelId);
  if (!safeChannelId) return { ok: false, reason: "channel_required" };
  if (isDmChannelKey(safeChannelId)) {
    return resolveDmScope(safeChannelId, workspaceId, actorUserId);
  }
  if (isThreadChannelKey(safeChannelId)) {
    return resolveThreadScope(safeChannelId, workspaceId, actorUserId);
  }
  return resolveChannelScope(safeChannelId, workspaceId, actorUserId);
}

async function authorizeHuddleScope(socket, channelId, action) {
  const workspaceContext = await getWorkspaceHuddleContext(socket);
  if (!workspaceContext.ok) {
    emitHuddleDenied(socket, action, workspaceContext.reason);
    return workspaceContext;
  }

  const scopeContext = await resolveHuddleScope(
    channelId,
    socket.workspaceId,
    String(socket.user.id)
  );
  if (!scopeContext.ok) {
    emitHuddleDenied(socket, action, scopeContext.reason, { channelId });
    return scopeContext;
  }

  return {
    ok: true,
    ...workspaceContext,
    scope: scopeContext.scope,
  };
}

async function getRoomOrActiveHuddle({ channelId, huddleId, workspaceId, scope }) {
  const room = huddleRealtimeService.getPresence({ workspaceId, huddleId });
  if (room) {
    if (
      String(room.channelId) !== String(channelId) ||
      String(room.workspaceId) !== String(workspaceId)
    ) {
      return { ok: false, reason: "huddle_scope_mismatch" };
    }
    if (!room.scope) {
      huddleRealtimeService.updateRoomContext({ workspaceId, huddleId, scope });
    }
    return { ok: true, room, active: null };
  }

  const activeResult = await huddleCompatibilityAdapter.getActiveLegacyHuddle({
    workspaceId,
    channelId,
    huddleId,
    scope,
    source: "socket:getRoomOrActiveHuddle",
  });
  const active = activeResult?.active || null;
  if (!active || String(active.huddle_id) !== String(huddleId)) {
    return { ok: false, reason: "huddle_not_found" };
  }

  return { ok: true, room: null, active, session: activeResult?.session || null };
}

function getRecoveryHeartbeatSummary({ workspaceId, huddleId, userId } = {}) {
  const diagnostics = huddleRealtimeService.getDiagnostics?.() || {};
  const heartbeats = diagnostics.heartbeats || null;
  if (!heartbeats) return null;

  const staleDevice = (heartbeats.staleDevices || []).find(
    (device) =>
      String(device.workspaceId) === String(workspaceId) &&
      String(device.huddleId) === String(huddleId) &&
      String(device.userId) === String(userId)
  );
  const staleParticipant = (heartbeats.staleParticipants || []).find(
    (participant) =>
      String(participant.workspaceId) === String(workspaceId) &&
      String(participant.huddleId) === String(huddleId) &&
      String(participant.userId) === String(userId)
  );

  return {
    lastHeartbeatAt: heartbeats.lastHeartbeatAt || null,
    heartbeatAgeMs: staleDevice?.ageMs ?? null,
    staleDeviceCount: (heartbeats.staleDevices || []).filter(
      (device) =>
        String(device.workspaceId) === String(workspaceId) &&
        String(device.huddleId) === String(huddleId)
    ).length,
    staleParticipantCount: (heartbeats.staleParticipants || []).filter(
      (participant) =>
        String(participant.workspaceId) === String(workspaceId) &&
        String(participant.huddleId) === String(huddleId)
    ).length,
    selfStale: Boolean(staleDevice || staleParticipant),
  };
}

async function evaluateHuddleRecoveryShadow({
  source,
  socket,
  workspaceId,
  channelId = null,
  huddleId = null,
  userId,
  username = "",
  scope = null,
  localRoom = null,
  active = null,
  session = null,
  access = { ok: true },
  payload = {},
}) {
  try {
    const evaluate = typeof huddleRecoveryService.evaluateDurable === "function"
      ? huddleRecoveryService.evaluateDurable.bind(huddleRecoveryService)
      : huddleRecoveryService.evaluate.bind(huddleRecoveryService);
    return await evaluate({
      source,
      workspaceId,
      channelId,
      huddleId,
      userId: String(userId || ""),
      username,
      scope: scope || {},
      localRoom,
      active,
      session,
      access,
      deviceContext: getHuddleSocketDeviceContext(socket, payload),
      heartbeatDiagnostics: getRecoveryHeartbeatSummary({ workspaceId, huddleId, userId }),
    });
  } catch (err) {
    console.warn("[huddle:recovery:shadow_socket_failed]", {
      source,
      workspaceId,
      channelId,
      huddleId,
      userId,
      error: err.message,
    });
    return null;
  }
}

function withRecoveryMetadata(payload, recoveryResult) {
  const metadata = recoveryResult?.exposure?.metadata;
  if (!metadata?.recoverySnapshot) return payload;
  return {
    ...payload,
    recovery: metadata,
  };
}

async function getScopeRecipientIds(scope, exceptUserId = null) {
  let ids = [];
  if (scope.type === "dm") {
    ids = scope.participantIds || [];
  } else if (scope.channel?.id) {
    const members = await getChannelMembers(scope.channel.id);
    ids = members.map((member) => String(member.user_id));
  } else if (scope.parentScope) {
    ids = await getScopeRecipientIds(scope.parentScope);
  }
  return ids.filter((uid) => !exceptUserId || uid !== String(exceptUserId));
}

async function emitHuddleInviteEvent(scope, event, payload, options = {}) {
  const { exceptUserId = null, includeWorkspaceRoom = false } = options;
  const recipientIds =
    scope.type === "dm" || scope.isPrivate
      ? await getScopeRecipientIds(scope, exceptUserId)
      : [];
  await huddleRealtimeService.broadcastInvite({
    scope,
    event,
    payload,
    recipientIds,
    exceptUserId,
    includeWorkspaceRoom,
  });
}

async function emitHuddleLiveEvent(scope, room, event, payload, options = {}) {
  await huddleRealtimeService.broadcastLive({
    scope,
    huddleId: room?.huddleId || payload?.huddleId,
    event,
    payload,
    exceptUserId: options.exceptUserId || null,
  });
}

async function endHuddleAndNotify(
  scope,
  huddleId,
  endedBy,
  reason = "legacy_huddle_ended"
) {
  const sessionResult = await huddleCompatibilityAdapter.endLegacyHuddle({
    workspaceId: scope.workspaceId,
    channelId: scope.channelId,
    huddleId,
    userId: endedBy?.userId ? String(endedBy.userId) : null,
    username: endedBy?.username || null,
    scope,
    reason,
  });
  if (!sessionResult?.ok) {
    return {
      ok: false,
      reason: sessionResult?.reason || "huddle_end_failed",
    };
  }

  huddleRealtimeService.deleteRoom({ workspaceId: scope.workspaceId, huddleId });
  const sessionId = sessionResult?.sessionId || null;

  const out = {
    channelId: scope.channelId,
    workspaceId: scope.workspaceId,
    huddleId,
    endedBy,
    at: new Date().toISOString(),
    ...(sessionId ? { sessionId } : {}),
  };
  await emitHuddleInviteEvent(scope, "huddle:ended", out);
  return { ok: true, payload: out, sessionResult };
}

function huddleDisconnectTimerKey({ userId, socketId }) {
  return `${String(userId || "")}:${String(socketId || "")}`;
}

function scheduleHuddleDisconnectCleanup({ socket, userId, username, deviceContext }) {
  const timerKey = huddleDisconnectTimerKey({ userId, socketId: deviceContext.socketId });
  clearTimeout(pendingHuddleDisconnectTimers.get(timerKey));

  const runCleanup = async () => {
    pendingHuddleDisconnectTimers.delete(timerKey);

    for (const change of huddleRealtimeService.leaveDeviceFromAllRooms({
      userId: String(userId),
      ...deviceContext,
    })) {
      const huddleId = change.huddleId;

      if (!change.participantStillPresent) {
        huddleCompatibilityAdapter.recordLegacyHuddleLeave({
          workspaceId: change.workspaceId || WORKSPACE_GLOBAL,
          channelId: change.channelId,
          huddleId,
          userId: String(userId),
          username,
          socket,
        }).catch(() => {});
      }

      if (change.shouldEnd) {
        const ws = change.workspaceId || WORKSPACE_GLOBAL;
        const scope = change.scope || {
          type: isDmChannelKey(change.channelId) ? "dm" : "channel",
          channelId: change.channelId,
          workspaceId: ws,
          isPrivate: isDmChannelKey(change.channelId),
          participantIds: dmParticipantIds(change.channelId),
        };
        endHuddleAndNotify(
          scope,
          huddleId,
          { userId, username },
          "legacy_huddle_disconnect_empty"
        )
          .then((ended) => {
            if (!ended.ok) {
              console.error("[huddle:disconnect:end]", ended.reason);
            }
          })
          .catch((err) => console.error("[huddle:disconnect:end]", err.message));
        continue;
      }

      if (!change.participantStillPresent) {
        const scope = change.scope || {
          type: isDmChannelKey(change.channelId) ? "dm" : "channel",
          channelId: change.channelId,
          workspaceId: change.workspaceId || WORKSPACE_GLOBAL,
          isPrivate: isDmChannelKey(change.channelId),
          participantIds: dmParticipantIds(change.channelId),
        };
        const out = {
          channelId: change.channelId,
          workspaceId: change.workspaceId || WORKSPACE_GLOBAL,
          huddleId,
          userId,
          username,
          at: new Date().toISOString(),
          ...(change.sessionId ? { sessionId: change.sessionId } : {}),
        };
        emitHuddleLiveEvent(scope, change.room, "huddle:user-left", out, { exceptUserId: userId })
          .catch((err) => console.error("[huddle:disconnect:user-left]", err.message));
      }
    }
  };

  const timer = setTimeout(runCleanup, HUDDLE_DISCONNECT_GRACE_MS);
  if (typeof timer.unref === "function") timer.unref();
  pendingHuddleDisconnectTimers.set(timerKey, timer);
}

async function getHuddlePushTargetIds(scope, actorUserId) {
  if (scope.type === "dm" || scope.isPrivate) {
    return getScopeRecipientIds(scope, actorUserId);
  }
  return getActiveWorkspaceUserIds(scope.workspaceId, actorUserId);
}

async function canManageHuddle({ scope, room, active, membership, userId }) {
  if (scope.type === "dm") {
    return scope.participantIds?.includes(String(userId));
  }

  const startedBy = String(room?.startedBy?.userId || active?.started_by || "");
  if (startedBy && startedBy === String(userId)) return true;

  const role = String(membership?.role || "").toLowerCase();
  if (HUDDLE_ADMIN_ROLES.has(role)) return true;

  if (scope.channel?.id) {
    try {
      if (await isChannelAdmin(scope.channel.id, userId)) return true;
    } catch {}
  }

  return false;
}

/* -------------------------------------------------------
   INIT SOCKET WITH FRONTEND URL
------------------------------------------------------- */
export function initSocket(server, frontendUrl) {
  io = new Server(server, {
    cors: {
      origin: frontendUrl || process.env.FRONTEND_BASE_URL,
      credentials: true,
    },
  });
  configureSocketIoRedisAdapter(io).catch((error) => {
    console.error("[socket:redis_adapter:init_failed]", error.message);
    if (boolEnv(process.env.SOCKET_IO_REDIS_REQUIRED, false)) {
      process.nextTick(() => {
        throw error;
      });
    }
  });
  huddleRealtimeService.configure({ io, workspaceRoomName });

// Register AI socket listeners
  registerAiSocket(io);  // THIS is where AI gets integrated

  /* -----------------------------------------------------
     AUTH MIDDLEWARE
  ----------------------------------------------------- */
  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error("Unauthorized: no token"));

    try {
      const decoded = jwt.verify(token, JWT_SECRET);

      socket.user = {
        ...decoded,
        workspaceId: decoded.workspaceId || WORKSPACE_GLOBAL,
      };

      if (
        socket.user.workspaceId === WORKSPACE_GLOBAL &&
        workspaceService?.getMembershipByUserId
      ) {
        try {
          const membership =
            await workspaceService.getMembershipByUserId(String(decoded.id));
          if (membership?.workspace_id) {
            socket.user.workspaceId = membership.workspace_id;
          }
        } catch (err) {
          console.error(
            "Socket workspace resolution failed:",
            err.message
          );
        }
      }

      next();
    } catch (err) {
      console.error("Socket auth error", err.message);
      next(new Error("Unauthorized: invalid token"));
    }
  });

  io.on("connection", async (socket) => {
  const userId = socket.user.id;
  const username = socket.user.username;
  // 🔐 Prevent duplicate sends from same socket
socket._recentMessageHashes = new Set();

  // 🔐 Always keep real workspaceId from JWT
  socket.workspaceId = socket.user.workspaceId || null;

  // 🔐 Internal lifecycle guard (used by async handlers)
  socket._isCleanedUp = false;

  // 🔁 Resolve workspace ONLY if missing (legacy safety)
  if (!socket.workspaceId && workspaceService?.getMembershipByUserId) {
    try {
      const membership =
        await workspaceService.getMembershipByUserId(String(userId));
      if (membership?.workspace_id) {
        socket.workspaceId = membership.workspace_id;
      }
    } catch (err) {
      console.error(
        "Failed to resolve workspace for socket:",
        err.message
      );
    }
  }

  // 🔐 HARD ASSERT — socket must belong to a workspace
  if (!socket.workspaceId) {
    console.error(
      "Socket connected without workspace. Disconnecting.",
      { userId }
    );
    socket.disconnect(true);
    return;
  }

  if (isSocketReconnect(socket)) {
    evaluateHuddleRecoveryShadow({
      source: "socket:reconnect",
      socket,
      workspaceId: socket.workspaceId,
      userId,
      username,
      access: { ok: true },
    }).catch(() => {});
  }

  // 🔁 Personal room (for direct emits)
socket.join(userId);

console.log(
  "Socket connected for user:",
  userId,
  "workspace:",
  socket.workspaceId
);

/* =====================================================
   🧠 WORKSPACE CONTROL CENTER ROOM (ADD THIS BLOCK)
   ===================================================== */
if (socket.workspaceId) {
  const workspaceRoom = `workspace:${socket.workspaceId}`;

  socket.join(workspaceRoom);

  console.log(
    "🧠 Joined workspace intelligence room:",
    workspaceRoom
  );
}

  // 🔔 Presence update (workspace-scoped)
  io.emit("presence:update", {
    userId,
    username,
    status: "online",
    at: new Date().toISOString(),
    workspaceId: socket.workspaceId,
  });

  /* -----------------------------------------------------
   WORKSPACE: SUBSCRIBE (FOR DASHBOARD & INTELLIGENCE)
----------------------------------------------------- */
socket.on("workspace:subscribe", () => {
  if (!socket.workspaceId) return;

  const workspaceRoom = `workspace:${socket.workspaceId}`;
  socket.join(workspaceRoom);

  console.log("✅ Client subscribed to workspace room:", workspaceRoom);
});

/* -----------------------------------------------------
   🔥 FETCH HISTORY ON CHANNEL OPEN (CHANNELS + DMs)
----------------------------------------------------- */
socket.on("chat:open", async (channelKey) => {
  if (!channelKey) return;
  if (socket.disconnected || socket._isCleanedUp) return;

  const workspaceId = socket.workspaceId;
  // ✅ Ensure DM sockets join rooms (CRITICAL)
if (channelKey.startsWith("dm:")) {
  const legacyRoom = legacyRoomName(channelKey);
  const wsRoom = workspaceRoomName(channelKey, workspaceId);

  socket.join(legacyRoom);
  socket.join(wsRoom);
}

  try {
    const res = await pool.query(
  `
  SELECT
    m.*,
    u.username,
    u.avatar_url
  FROM chat_messages m
  LEFT JOIN users u ON u.id = m.user_id
  WHERE m.channel_key = $1
    AND m.workspace_id = $2
    AND m.deleted_at IS NULL
  ORDER BY m.created_at DESC
  LIMIT 100
  `,
  [channelKey, workspaceId]
);
const rows = res.rows;
const orderedRows = rows.reverse();
socket.emit("chat:history", {
  channelId: channelKey,
  workspaceId,
  messages: orderedRows.map((m) => {
    // Detect AI-generated messages via the __from_ai flag stored in encrypted_json
    let isAiMessage = false;
    try {
      const enc = typeof m.encrypted_json === "string"
        ? JSON.parse(m.encrypted_json)
        : m.encrypted_json;
      isAiMessage = enc?.__from_ai === true;
    } catch {}

    return {
      id: m.id,
      channelId: channelKey,
      userId: m.user_id,
      username: m.username,
      avatarUrl: m.avatar_url || null,
      avatar_url: m.avatar_url || null,
      textHtml: resolveRenderableText(m),
      createdAt: m.created_at,
      updatedAt: m.updated_at,
      deletedAt: m.deleted_at,
      reactions: m.reactions || {},
      attachments: m.attachments || [],
      encrypted: m.encrypted_json,
      fallbackText: m.fallback_text,
      senderPublicKeyJwk: m.sender_public_key,
      parentId: m.parent_id,
      isAiMessage,
    };
  }),
});
  } catch (err) {
    console.error("🔥 chat:open history error:", err);
  }
});

  /* -----------------------------------------------------
     CHAT: JOIN CHANNEL
  ----------------------------------------------------- */
  socket.on("chat:join", (channelKey) => {
    if (!channelKey) return;

    if (socket.disconnected || socket._isCleanedUp) return;

    (async () => {
      try {
        const meta = getChannelMetaFromKey(channelKey);
        const workspaceId = socket.workspaceId || WORKSPACE_GLOBAL;

        const channel = await getChannelByKey(
          channelKey,
          socket.workspaceId
        );

        if (!channel) {
          socket.emit("chat:error", {
            error: "Channel does not exist",
          });
          return;
        }

        if (socket.disconnected || socket._isCleanedUp) return;

        const legacyRoom = legacyRoomName(channelKey);
        const wsRoom = workspaceRoomName(channelKey, workspaceId);

        socket.join(legacyRoom);
        socket.join(wsRoom);

        const resolvedWorkspaceId = socket.workspaceId;
        const canSeeHuddle =
          !(channel.isPrivate || channel.is_private) ||
          (await isChannelMember(channel.id, userId));
        const activeScopeContext = canSeeHuddle
          ? await resolveHuddleScope(channelKey, resolvedWorkspaceId, String(userId))
          : null;
        const activeResult = canSeeHuddle
          ? await huddleCompatibilityAdapter.getActiveLegacyHuddle({
              workspaceId: resolvedWorkspaceId,
              channelId: channelKey,
              actorUserId: String(userId),
              scope: activeScopeContext?.scope || {},
              source: "chat:join",
            })
          : null;
        const active = activeResult?.active || null;
        if (active && !socket.disconnected && !socket._isCleanedUp) {
          const starterUsername = active.starter_username || "User";
          const sessionId = activeResult?.sessionId || active.session_id || null;
          socket.emit("huddle:started", {
            channelId: channelKey,
            workspaceId: channel.workspaceId || resolvedWorkspaceId,
            huddleId: active.huddle_id,
            startedBy: {
              userId: active.started_by,
              username: starterUsername,
            },
            at: active.started_at,
            persisted: true,
            ...(sessionId ? { sessionId } : {}),
          });
        }

        // join/leave system messages intentionally suppressed
      } catch (err) {
        console.error("🔥 chat:join error", {
          socketId: socket.id,
          userId,
          channelKey,
          error: err,
        });
      }
    })();
  });

  /* -----------------------------------------------------
     CHAT: LEAVE
  ----------------------------------------------------- */
  socket.on("chat:leave", (channelKey) => {
    if (!channelKey) return;

    const workspaceId = socket.workspaceId || WORKSPACE_GLOBAL;
    const legacyRoom = legacyRoomName(channelKey);
    const wsRoom = workspaceRoomName(channelKey, workspaceId);

    socket.leave(legacyRoom);
    socket.leave(wsRoom);

    // join/leave system messages intentionally suppressed
  });

  /* -----------------------------------------------------
     CHAT: MESSAGE
  ----------------------------------------------------- */
 socket.on("chat:message", async (data, ack) => {
  const { channelId, text, tempId, parentId, attachments } = data || {};
  if (socket.disconnected || socket._isCleanedUp) return;
  const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
  if (!channelId || (!text?.trim() && !hasAttachments)) return;

  const workspaceId = socket.workspaceId;
  const cleanText = typeof text === "string" ? text.trim() : "";

  // 🔐 HARD DEDUPLICATION (same socket, same message)
  const dedupeKey = `${channelId}::${tempId || cleanText}::${parentId || "root"}::${JSON.stringify(attachments || [])}`;

  if (socket._recentMessageHashes.has(dedupeKey)) {
    console.warn("⚠️ Duplicate chat:message ignored", dedupeKey);
    return;
  }

  socket._recentMessageHashes.add(dedupeKey);

  // auto-expire after 3s (covers double enter / resend / reconnect)
  setTimeout(() => {
    socket._recentMessageHashes.delete(dedupeKey);
  }, 3000);

  try {
    const isDM = channelId.startsWith("dm:");

    // ✅ ONLY validate channel for non-DM
    if (!isDM) {
      const channel = await getChannelByKey(channelId, workspaceId);
      if (!channel) {
        socket.emit("chat:error", { error: "Channel does not exist" });
        return;
      }

      if (channel.isPrivate || channel.is_private) {
        const member = await isChannelMember(channel.id, userId);
        if (!member) {
          socket.emit("chat:error", {
            error: "You are not a member of this private channel.",
          });
          return;
        }
      }

      await ensureChannelMember(channel.id, userId);
    }

    console.log("🔥 SAVING MESSAGE", { channelId, workspaceId, isDM });

    // 🔥 SINGLE SOURCE OF TRUTH (DB → socket emit happens elsewhere)
    const saved = await createChatMessage({
      channelKey: channelId,
      userId,
      tempId: tempId || null,
      textHtml: cleanText,
      parentId: parentId || null,
      attachments: Array.isArray(attachments) ? attachments : [],
      workspaceId,
    });

    // ✅ Confirm save to sender — frontend uses this to cancel its fallback timer
    if (typeof ack === "function") ack({ ok: true, tempId: tempId || null });

    // Push notification to other channel members (non-blocking)
    try {
      const senderName = saved?.username || username || "Someone";
      const channelUrl = `/chat?channel=${encodeURIComponent(channelId)}`;

      if (isDM) {
        // DM: unread-bump + push to each participant
        const dmTargets = channelId.split(":").slice(1).filter((id) => id !== String(userId));
        for (const targetId of dmTargets) {
          io.to(targetId).emit("chat:unread-bump", { channelKey: channelId });
          sendPushToUser({
            userId: targetId,
            title: senderName,
            body: "Sent a message",
            url: channelUrl,
            type: "chat",
            extraData: { channelId },
          }).catch((e) => console.error("[push:chat:socket] sendPushToUser failed:", e.message));
        }
      } else {
        // Channel: fetch members for push notifications
        const { rows: chMembers } = await pool.query(
          "SELECT user_id FROM chat_channel_members WHERE channel_id = (SELECT id FROM chat_channels WHERE key = $1 LIMIT 1) AND user_id != $2",
          [channelId, userId]
        );
        // Unread-bump: workspace-wide for public channels, per-member for private
        const { rows: chInfo } = await pool.query(
          "SELECT is_private FROM chat_channels WHERE key = $1 LIMIT 1",
          [channelId]
        );
        const isPrivate = chInfo[0]?.is_private;
        if (isPrivate) {
          for (const { user_id } of chMembers) {
            io.to(user_id).emit("chat:unread-bump", { channelKey: channelId });
          }
        } else {
          io.to(`workspace:${workspaceId}`).emit("chat:unread-bump", {
            channelKey: channelId,
            fromUserId: String(userId),
          });
        }
        // Push notifications go to explicit members only
        for (const { user_id } of chMembers) {
          sendPushToUser({
            userId: user_id,
            title: `${senderName} in #${channelId}`,
            body: "Sent a message",
            url: channelUrl,
            type: "chat",
            extraData: { channelId },
          }).catch((e) => console.error("[push:chat:socket] sendPushToUser failed:", e.message));
        }
      }
      console.log(`[push:chat:socket] isDM=${isDM} channelId=${channelId} sender=${userId}`);
    } catch (e) {
      console.error("[push:chat:socket] error:", e.message);
    }
  } catch (err) {
    console.error("chat:message error:", err);
    if (typeof ack === "function") ack({ ok: false, error: err.message });
  }
});

  /* -----------------------------------------------------
     CHAT: EDIT / DELETE
  ----------------------------------------------------- */
socket.on("chat:edit", async ({ channelId, messageId, text }) => {
  // 🔒 HARD GUARD — never edit temp messages
  if (!messageId || !isUuid(messageId)) {
    console.warn("Ignoring edit for non-persisted message:", messageId);
    return;
  }

  if (!channelId || !text?.trim()) return;

  try {
    const plainText = extractPlainText(text);

    const encryptedPayload =
      typeof text === "string" && text.trim().startsWith("{")
        ? JSON.parse(text)
        : { message: plainText };

    const updated = await updateChatMessage({
      messageId,
      workspaceId: socket.workspaceId, // ✅ REQUIRED
      textHtml: plainText,
      fallbackText: plainText,
      encryptedJson: encryptedPayload,
    });

    if (!updated) return;

    const workspaceId = socket.workspaceId || WORKSPACE_GLOBAL;

    const payload = {
      id: updated.id,
      channelId,
      workspaceId,
      userId: updated.user_id,
      username,
      textHtml: updated.text_html,
      createdAt: updated.created_at,
      updatedAt: updated.updated_at,
    };

    io.to(legacyRoomName(channelId)).emit("chat:messageEdited", payload);
    io.to(workspaceRoomName(channelId, workspaceId)).emit(
      "chat:messageEdited",
      payload
    );
  } catch (err) {
    console.error("chat:edit error:", err);
  }
});

  socket.on("chat:delete", async ({ channelId, messageId }) => {
    if (!channelId || !messageId) return;

    try {
      const deleted = await softDeleteChatMessage({
        messageId,
        userId,
      });

      if (!deleted) return;

      const workspaceId = socket.workspaceId || WORKSPACE_GLOBAL;

      const payload = {
        id: deleted.id,
        channelId,
        workspaceId,
        userId: deleted.user_id,
        username,
        deletedAt: deleted.deleted_at,
      };

      io.to(legacyRoomName(channelId)).emit(
        "chat:messageDeleted",
        payload
      );
      io.to(workspaceRoomName(channelId, workspaceId)).emit(
        "chat:messageDeleted",
        payload
      );
    } catch (err) {
      console.error("chat:delete error:", err.message);
    }
  });

  /* -----------------------------------------------------
     REACTIONS / TYPING / READ
  ----------------------------------------------------- */
  socket.on("chat:reaction", async (payload) => {
  const { channelId, messageId } = payload;
  if (!channelId || !messageId) return;

  try {
    // 1️⃣ Load current reactions
    const { rows } = await pool.query(
      `SELECT reactions FROM chat_messages WHERE id = $1 LIMIT 1`,
      [messageId]
    );
    if (!rows.length) return;

    const current = rows[0].reactions || {};
    const { emoji, action } = payload;

    const r = current[emoji] || { userIds: [] };
    const set = new Set(r.userIds || []);

    if (action === "add") set.add(userId);
    if (action === "remove") set.delete(userId);

    if (set.size === 0) {
      delete current[emoji];
    } else {
      current[emoji] = {
        count: set.size,
        userIds: Array.from(set),
      };
    }

    // 2️⃣ Persist to DB
    await pool.query(
      `UPDATE chat_messages SET reactions = $1 WHERE id = $2`,
      [current, messageId]
    );

    // 3️⃣ Emit (unchanged behavior)
    const out = {
      ...payload,
      userId,
      username,
      reactions: current,
      at: new Date().toISOString(),
      workspaceId: socket.workspaceId || WORKSPACE_GLOBAL,
    };

    io.to(legacyRoomName(channelId)).emit("chat:reaction", out);
    io
      .to(workspaceRoomName(channelId, out.workspaceId))
      .emit("chat:reaction", out);
  } catch (err) {
    console.error("chat:reaction error:", err);
  }
});

  socket.on("chat:typing", ({ channelId }) => {
    const out = {
      channelId,
      userId,
      username,
      at: new Date().toISOString(),
      workspaceId: socket.workspaceId || WORKSPACE_GLOBAL,
    };
    socket.to(legacyRoomName(channelId)).emit("chat:typing", out);
    socket
      .to(workspaceRoomName(channelId, out.workspaceId))
      .emit("chat:typing", out);
  });

  socket.on("chat:read", ({ channelId, at }) => {
    const out = {
      channelId,
      userId,
      username,
      at: at || new Date().toISOString(),
      workspaceId: socket.workspaceId || WORKSPACE_GLOBAL,
    };
    socket.to(legacyRoomName(channelId)).emit("chat:read", out);
    socket
      .to(workspaceRoomName(channelId, out.workspaceId))
      .emit("chat:read", out);
  });

  /* -----------------------------------------------------
     HUDDLES
  ----------------------------------------------------- */
  socket.on("huddle:start", async (payload = {}) => {
    let { channelId, huddleId } = payload;
    channelId = normalizeSocketId(channelId);
    huddleId = normalizeSocketId(huddleId);
    if (!channelId || !huddleId) return;

    const ctx = await authorizeHuddleScope(socket, channelId, "huddle:start");
    if (!ctx.ok) return;
    const { scope } = ctx;
    const workspaceId = scope.workspaceId;

    const duplicateRoom = huddleRealtimeService.getPresence({ workspaceId, huddleId });
    if (duplicateRoom) {
      if (
        duplicateRoom.channelId === channelId &&
        duplicateRoom.workspaceId === workspaceId &&
        String(duplicateRoom.startedBy?.userId) === String(userId)
      ) {
        return;
      }
      emitHuddleDenied(socket, "huddle:start", "huddle_id_already_active", { channelId, huddleId });
      return;
    }

    // Clear any stale/zombie huddle so a new one can always start.
    // A huddle becomes stale when everyone left without pressing "End for all".
    const existingResult = await huddleCompatibilityAdapter.getActiveLegacyHuddle({
      workspaceId,
      channelId,
      actorUserId: String(userId),
      scope,
      source: "huddle:start:existing",
    });
    if (existingResult && !existingResult.ok) {
      emitHuddleDenied(socket, "huddle:start", existingResult.reason || "active_huddle_lookup_failed", { channelId, huddleId });
      return;
    }
    const existing = existingResult?.active || null;
    if (existing) {
      const staleRoom = huddleRealtimeService.getPresence({
        workspaceId,
        huddleId: existing.huddle_id,
      });
      if (staleRoom && staleRoom.workspaceId !== workspaceId) {
        emitHuddleDenied(socket, "huddle:start", "active_huddle_scope_mismatch", { channelId });
        return;
      }
      const ended = await endHuddleAndNotify(scope, existing.huddle_id, { userId, username });
      if (!ended.ok) {
        emitHuddleDenied(socket, "huddle:start", ended.reason, { channelId, huddleId });
        return;
      }
    }

    const startResult = await huddleCompatibilityAdapter.startLegacyHuddle({
      workspaceId,
      channelId,
      huddleId,
      userId: String(userId),
      username,
      scope,
      requestedProvider: resolveSocketRequestedProvider(payload),
      clientCapabilities: resolveSocketClientCapabilities(payload),
      platform: payload?.platform || socket.handshake?.auth?.platform || "web",
      entitlement: hasLiveKitEntitlement(ctx),
    });
    if (!startResult?.ok || !startResult?.legacy) {
      emitHuddleDenied(socket, "huddle:start", startResult?.reason || "huddle_start_failed", { channelId, huddleId });
      return;
    }
    const sessionId = startResult?.sessionId || null;
    if (!sessionId || !startResult?.providerLock?.locked) {
      emitHuddleDenied(socket, "huddle:start", "provider_lock_required", {
        channelId,
        huddleId,
        providerLock: startResult?.providerLockDiagnostics || null,
      });
      return;
    }
    const providerLockDiagnostics =
      startResult.providerLockDiagnostics ||
      await getProviderLockDiagnostics({
        workspaceId,
        sessionId,
        action: "huddle:start",
        requestedProvider: resolveSocketRequestedProvider(payload),
        userId: String(userId),
        deviceId: getHuddleSocketDeviceContext(socket).deviceId || null,
      });

    const out = {
      channelId,
      workspaceId,
      huddleId,
      startedBy: { userId, username },
      at: new Date().toISOString(),
      persisted: true,
      providerLock: providerLockDiagnostics,
      ...(sessionId ? { sessionId } : {}),
    };

    const starterDeviceContext = getHuddleSocketDeviceContext(socket);
    huddleRealtimeService.createRoom({
      huddleId,
      channelId,
      workspaceId,
      participants: [{ userId: String(userId), username, ...starterDeviceContext }],
      startedBy: { userId: String(userId), username },
      startedAt: out.at,
      scope,
      sessionId,
    });
    huddleRealtimeService.recordHeartbeat({
      workspaceId,
      channelId,
      huddleId,
      userId: String(userId),
      username,
      sessionId,
      ...starterDeviceContext,
      source: "huddle:start",
    });

    socket.emit("huddle:started", out);

    await emitHuddleInviteEvent(scope, "huddle:started", out, {
      exceptUserId: scope.type === "dm" || scope.isPrivate ? userId : null,
      includeWorkspaceRoom: scope.type !== "dm" && !scope.isPrivate,
    });

    // Send FCM push notification only to relevant participants (not entire workspace for DMs)
    try {
      const pushTargetIds = await getHuddlePushTargetIds(scope, userId);
      const channelLabel =
        scope.type === "dm" ? "Direct Message" :
        scope.type === "thread" ? "Thread" :
        `#${channelId}`;
      for (const uid of pushTargetIds) {
        sendPushToUser({
          userId: uid,
          title: `📞 ${username} is calling`,
          body: `Incoming huddle in ${channelLabel}`,
          url: `/chat?channel=${encodeURIComponent(channelId)}`,
          type: "huddle",
          extraData: {
            huddleId,
            channelId,
            startedByName: username,
            startedBy: String(userId),
            ...(sessionId ? { sessionId } : {}),
          },
        }).catch(() => {});
      }
    } catch (e) {
      console.error("[push:huddle] error:", e.message);
    }
  });

  socket.on("huddle:end", async ({ channelId, huddleId }) => {
    channelId = normalizeSocketId(channelId);
    huddleId = normalizeSocketId(huddleId);
    if (!channelId || !huddleId) return;

    const ctx = await authorizeHuddleScope(socket, channelId, "huddle:end");
    if (!ctx.ok) return;

    const resolved = await getRoomOrActiveHuddle({
      channelId,
      huddleId,
      workspaceId: ctx.scope.workspaceId,
      scope: ctx.scope,
    });
    if (!resolved.ok) {
      emitHuddleDenied(socket, "huddle:end", resolved.reason, { channelId, huddleId });
      return;
    }

    const allowed = await canManageHuddle({
      scope: ctx.scope,
      room: resolved.room,
      active: resolved.active,
      membership: ctx.membership,
      userId,
    });
    if (!allowed) {
      emitHuddleDenied(socket, "huddle:end", "huddle_owner_required", { channelId, huddleId });
      return;
    }

    const ended = await endHuddleAndNotify(ctx.scope, huddleId, { userId, username });
    if (!ended.ok) {
      emitHuddleDenied(socket, "huddle:end", ended.reason, { channelId, huddleId });
    }
  });

  socket.on("huddle:join", async (payload = {}) => {
    let { channelId, huddleId } = payload;
    channelId = normalizeSocketId(channelId);
    huddleId = normalizeSocketId(huddleId);
    if (!channelId || !huddleId) return;

    const ctx = await authorizeHuddleScope(socket, channelId, "huddle:join");
    if (!ctx.ok) return;

    const resolved = await getRoomOrActiveHuddle({
      channelId,
      huddleId,
      workspaceId: ctx.scope.workspaceId,
      scope: ctx.scope,
    });
    if (!resolved.ok) {
      emitHuddleDenied(socket, "huddle:join", resolved.reason, { channelId, huddleId });
      return;
    }

    const workspaceId = ctx.scope.workspaceId;
    const room =
      resolved.room ||
      huddleRealtimeService.ensureRoomFromActive({
        scope: ctx.scope,
        huddleId,
        active: resolved.active,
      });
    const deviceContext = getHuddleSocketDeviceContext(socket);
    const resolvedSession = getResolvedHuddleSession({
      room,
      active: resolved.active,
      session: resolved.session,
    });
    const providerLockGuard = await enforceSocketHuddleProviderLock({
      workspaceId,
      session: resolvedSession,
      channelId,
      huddleId,
      action: "huddle:join",
      requestedProvider: resolveSocketRequestedProvider(payload),
      userId: String(userId),
      deviceId: deviceContext.deviceId || null,
      allowLiveKitLifecycleJoin: true,
      createIfMissing: true,
    });
    if (!providerLockGuard.ok) {
      emitHuddleDenied(socket, "huddle:join", providerLockGuard.reason || "provider_lock_mismatch", {
        channelId,
        huddleId,
        providerLock: providerLockGuard.diagnostics,
      });
      return;
    }

    huddleRealtimeService.joinRealtimeRooms({
      socket,
      workspaceId,
      channelId,
      scope: ctx.scope,
    });

    const sessionResult = await huddleCompatibilityAdapter.recordLegacyHuddleJoin({
      workspaceId,
      channelId,
      huddleId,
      userId: String(userId),
      username,
      scope: ctx.scope,
      socket,
    });
    const sessionId = sessionResult?.sessionId || room.sessionId || null;

    const joinResult = huddleRealtimeService.joinDevice({
      workspaceId,
      huddleId,
      channelId,
      userId: String(userId),
      username,
      ...deviceContext,
      scope: ctx.scope,
      sessionId,
    });
    huddleRealtimeService.recordHeartbeat({
      workspaceId,
      channelId,
      huddleId,
      userId: String(userId),
      username,
      sessionId,
      ...deviceContext,
      source: "huddle:join",
    });
    const joinRecovery = await evaluateHuddleRecoveryShadow({
      source: "huddle:join:shadow_recovery",
      socket,
      workspaceId,
      channelId,
      huddleId,
      userId,
      username,
      scope: ctx.scope,
      localRoom: joinResult.room,
      active: resolved.active,
      session: sessionResult?.session || resolved.session || null,
    });
    const existingParticipants = joinResult.existingParticipants || [];

    const out = {
      channelId,
      workspaceId,
      huddleId,
      userId,
      username,
      at: new Date().toISOString(),
      providerLock: providerLockGuard.diagnostics,
      ...(sessionId ? { sessionId } : {}),
    };

    // Tell existing participants that someone new joined (they create offers)
    await emitHuddleLiveEvent(ctx.scope, joinResult.room, "huddle:user-joined", out, { exceptUserId: userId });

    // Tell the joiner who's already in the call — the joiner creates offers to them.
    // This eliminates the race where huddle:user-joined is missed by the caller.
    if (existingParticipants.length > 0) {
      socket.emit("huddle:participants", withRecoveryMetadata({
        channelId,
        huddleId,
        providerLock: providerLockGuard.diagnostics,
        ...(sessionId ? { sessionId } : {}),
        participants: existingParticipants,
      }, joinRecovery));
    }

    const participantsOut = {
      channelId,
      workspaceId,
      huddleId,
      providerLock: providerLockGuard.diagnostics,
      ...(sessionId ? { sessionId } : {}),
      participants: joinResult.participants || [],
    };
    await emitHuddleLiveEvent(ctx.scope, joinResult.room, "huddle:participants", participantsOut);
  });

  async function handleHuddleLeave(channelId, huddleId) {
    const ctx = await authorizeHuddleScope(socket, channelId, "huddle:leave");
    if (!ctx.ok) return;

    const resolved = await getRoomOrActiveHuddle({
      channelId,
      huddleId,
      workspaceId: ctx.scope.workspaceId,
      scope: ctx.scope,
    });
    if (!resolved.ok || !resolved.room) return;

    const room = resolved.room;
    if (
      !huddleRealtimeService.hasParticipant({
        workspaceId: ctx.scope.workspaceId,
        huddleId,
        userId: String(userId),
      })
    ) {
      emitHuddleDenied(socket, "huddle:leave", "participant_required", { channelId, huddleId });
      return;
    }

    const sessionResult = await huddleCompatibilityAdapter.recordLegacyHuddleLeave({
      workspaceId: ctx.scope.workspaceId,
      channelId,
      huddleId,
      userId: String(userId),
      username,
      scope: ctx.scope,
      socket,
    });
    const sessionId = sessionResult?.sessionId || room.sessionId || null;

    const leaveResult = huddleRealtimeService.leaveDevice({
      workspaceId: ctx.scope.workspaceId,
      huddleId,
      userId: String(userId),
      ...getHuddleSocketDeviceContext(socket),
    });

    if (leaveResult.participantStillPresent) {
      return;
    }

    if (leaveResult.participantCount === 0 || ctx.scope.type === "dm") {
      const ended = await endHuddleAndNotify(ctx.scope, huddleId, { userId, username });
      if (!ended.ok) {
        console.error("[huddle:leave:end]", ended.reason);
      }
      return;
    }

    const out = {
      channelId,
      workspaceId: ctx.scope.workspaceId,
      huddleId,
      userId,
      username,
      at: new Date().toISOString(),
      ...(sessionId ? { sessionId } : {}),
    };
    await emitHuddleLiveEvent(ctx.scope, leaveResult.room, "huddle:user-left", out, { exceptUserId: userId });
  }

  socket.on("huddle:leave", ({ channelId, huddleId }) => {
    channelId = normalizeSocketId(channelId);
    huddleId = normalizeSocketId(huddleId);
    if (!channelId || !huddleId) return;
    handleHuddleLeave(channelId, huddleId).catch((e) => console.error("[huddle:leave]", e.message));
  });

  socket.on("huddle:heartbeat", async (payload = {}) => {
    let { channelId, huddleId, clientSentAt, sequence } = payload || {};
    channelId = normalizeSocketId(channelId);
    huddleId = normalizeSocketId(huddleId);
    if (!channelId || !huddleId) return;

    const ctx = await authorizeHuddleScope(socket, channelId, "huddle:heartbeat");
    if (!ctx.ok) return;

    const room = huddleRealtimeService.getPresence({
      workspaceId: ctx.scope.workspaceId,
      huddleId,
    });
    if (!room || room.channelId !== channelId) {
      emitHuddleDenied(socket, "huddle:heartbeat", "huddle_room_required", { channelId, huddleId });
      return;
    }
    if (
      !huddleRealtimeService.hasParticipant({
        workspaceId: ctx.scope.workspaceId,
        huddleId,
        userId: String(userId),
      })
    ) {
      emitHuddleDenied(socket, "huddle:heartbeat", "participant_required", { channelId, huddleId });
      return;
    }

    const deviceContext = getHuddleSocketDeviceContext(socket, payload);
    const providerLockGuard = await enforceSocketHuddleProviderLock({
      workspaceId: ctx.scope.workspaceId,
      session: getResolvedHuddleSession({ room }),
      channelId,
      huddleId,
      action: "huddle:heartbeat",
      requestedProvider: "mesh",
      userId: String(userId),
      deviceId: deviceContext.deviceId || null,
      allowLiveKitLifecycleJoin: true,
      createIfMissing: false,
    });
    if (!providerLockGuard.ok) {
      emitHuddleDenied(socket, "huddle:heartbeat", providerLockGuard.reason || "provider_lock_mismatch", {
        channelId,
        huddleId,
        providerLock: providerLockGuard.diagnostics,
      });
      return;
    }

    const heartbeat = huddleRealtimeService.recordHeartbeat({
      workspaceId: ctx.scope.workspaceId,
      channelId,
      huddleId,
      userId: String(userId),
      username,
      sessionId: room.sessionId || null,
      clientSentAt,
      sequence,
      ...deviceContext,
      source: "huddle:heartbeat",
    });
    const heartbeatRecovery = await evaluateHuddleRecoveryShadow({
      source: "huddle:heartbeat:shadow_recovery",
      socket,
      workspaceId: ctx.scope.workspaceId,
      channelId,
      huddleId,
      userId,
      username,
      scope: ctx.scope,
      localRoom: room,
      session: { id: room.sessionId || null, state: "live" },
      payload,
    });

    socket.emit("huddle:heartbeat:ack", withRecoveryMetadata({
      channelId,
      workspaceId: ctx.scope.workspaceId,
      huddleId,
      at: new Date().toISOString(),
      ok: heartbeat?.ok !== false,
      supported: Boolean(heartbeat?.supported),
      shadow: Boolean(heartbeat?.shadow),
      providerLock: providerLockGuard.diagnostics,
      ...(heartbeat?.deviceId ? { deviceId: heartbeat.deviceId } : {}),
      ...(typeof heartbeat?.latencyMs === "number" ? { latencyMs: heartbeat.latencyMs } : {}),
      ...(room.sessionId ? { sessionId: room.sessionId } : {}),
    }, heartbeatRecovery));
  });

  // Frontend emits this on socket connect/reconnect to re-receive any active invitation
  // they may have missed while disconnected.
  socket.on("huddle:sync", async () => {
    const ws = socket.workspaceId || WORKSPACE_GLOBAL;
    try {
      const workspaceContext = await getWorkspaceHuddleContext(socket);
      if (!workspaceContext.ok) return;
      // 1️⃣ Check in-memory map first (most accurate while server is running)
      for (const room of huddleRealtimeService.getRecoverySnapshots({
        workspaceId: ws,
        userId: String(userId),
      })) {
        const huddleId = room.huddleId;
        const scopeContext = await resolveHuddleScope(room.channelId, ws, String(userId));
        if (!scopeContext.ok) continue;
        const sessionResult = room.sessionId
          ? { sessionId: room.sessionId }
          : await huddleCompatibilityAdapter.shadowReadLegacyHuddle({
              workspaceId: ws,
              channelId: room.channelId,
              huddleId,
              actorUserId: String(userId),
              scope: scopeContext.scope,
              source: "huddle:sync:memory",
            });
        const sessionId = sessionResult?.sessionId || null;
        const providerLockDiagnostics = await getProviderLockDiagnostics({
          workspaceId: ws,
          sessionId,
          action: "huddle:sync",
          requestedProvider: "mesh",
          userId: String(userId),
          deviceId: getHuddleSocketDeviceContext(socket).deviceId || null,
          allowLiveKitLifecycleJoin: true,
        });
        huddleRealtimeService.updateRoomContext({
          workspaceId: ws,
          huddleId,
          scope: scopeContext.scope,
          sessionId,
        });
        huddleCompatibilityAdapter.verifyParticipantSnapshot({
          workspaceId: ws,
          channelId: room.channelId,
          huddleId,
          expectedParticipantIds: room.participantIds || [],
          actorUserId: String(userId),
          source: "huddle:sync:memory",
        }).catch(() => {});
        const syncRecovery = await evaluateHuddleRecoveryShadow({
          source: "huddle:sync:memory:shadow_recovery",
          socket,
          workspaceId: ws,
          channelId: room.channelId,
          huddleId,
          userId,
          username,
          scope: scopeContext.scope,
          localRoom: room,
          session: sessionResult?.session || (sessionId ? { id: sessionId, state: "live" } : null),
        });
        socket.emit("huddle:started", withRecoveryMetadata({
          channelId: room.channelId,
          workspaceId: ws,
          huddleId,
          startedBy: room.startedBy || { userId: "unknown", username: "Someone" },
          at: room.startedAt || new Date().toISOString(),
          persisted: true,
          providerLock: providerLockDiagnostics,
          ...(sessionId ? { sessionId } : {}),
        }, syncRecovery));
        return; // only send one invitation at a time
      }

      // 2️⃣ Fallback: query DB for any recently-started active huddle in workspace channels
      // (handles the case where the server restarted and local realtime state is empty)
      const recentResult = await huddleCompatibilityAdapter.listRecentActiveLegacyHuddles({
        workspaceId: ws,
        excludeStartedBy: String(userId),
        withinMinutes: 5,
        limit: 20,
        source: "huddle:sync:db",
      });
      const rows = recentResult?.huddles || [];
      for (const h of rows) {
        const scopeContext = await resolveHuddleScope(h.channel_key, ws, String(userId));
        if (!scopeContext.ok) continue;
        const sessionResult = await huddleCompatibilityAdapter.getActiveLegacyHuddle({
          workspaceId: ws,
          channelId: h.channel_key,
          huddleId: h.huddle_id,
          actorUserId: String(userId),
          scope: scopeContext.scope,
          source: "huddle:sync:db",
        });
        const sessionId = sessionResult?.sessionId || null;
        const providerLockDiagnostics = await getProviderLockDiagnostics({
          workspaceId: ws,
          sessionId,
          action: "huddle:sync",
          requestedProvider: "mesh",
          userId: String(userId),
          deviceId: getHuddleSocketDeviceContext(socket).deviceId || null,
          allowLiveKitLifecycleJoin: true,
        });
        const syncRecovery = await evaluateHuddleRecoveryShadow({
          source: "huddle:sync:db:shadow_recovery",
          socket,
          workspaceId: ws,
          channelId: h.channel_key,
          huddleId: h.huddle_id,
          userId,
          username,
          scope: scopeContext.scope,
          localRoom: null,
          active: sessionResult?.active || h,
          session: sessionResult?.session || null,
        });
        socket.emit("huddle:started", withRecoveryMetadata({
          channelId: h.channel_key,
          workspaceId: ws,
          huddleId: h.huddle_id,
          startedBy: { userId: h.started_by, username: h.starter_username },
          at: h.started_at,
          persisted: true,
          providerLock: providerLockDiagnostics,
          ...(sessionId ? { sessionId } : {}),
        }, syncRecovery));
        return;
      }
    } catch (e) {
      console.error("[huddle:sync]", e.message);
    }
  });

  // When a recipient declines a huddle invite: notify the initiator and end
  // the huddle so the caller's GlobalHuddleWindow closes via huddle:ended.
  socket.on("huddle:decline", async ({ channelId, huddleId, initiatorUserId }) => {
    channelId = normalizeSocketId(channelId);
    huddleId = normalizeSocketId(huddleId);
    initiatorUserId = normalizeSocketId(initiatorUserId);
    if (!channelId || !huddleId || !initiatorUserId) return;

    const ctx = await authorizeHuddleScope(socket, channelId, "huddle:decline");
    if (!ctx.ok) return;

    const resolved = await getRoomOrActiveHuddle({
      channelId,
      huddleId,
      workspaceId: ctx.scope.workspaceId,
      scope: ctx.scope,
    });
    if (!resolved.ok) {
      emitHuddleDenied(socket, "huddle:decline", resolved.reason, { channelId, huddleId });
      return;
    }

    const startedBy = String(resolved.room?.startedBy?.userId || resolved.active?.started_by || "");
    if (String(initiatorUserId) !== startedBy || String(initiatorUserId) === String(userId)) {
      emitHuddleDenied(socket, "huddle:decline", "huddle_initiator_mismatch", { channelId, huddleId });
      return;
    }

    const workspaceId = ctx.scope.workspaceId;
    const at = new Date().toISOString();
    const sessionResult = await huddleCompatibilityAdapter.recordLegacyHuddleDecline({
      workspaceId,
      channelId,
      huddleId,
      userId: String(userId),
      username,
      scope: ctx.scope,
    });
    const sessionId = sessionResult?.sessionId || resolved.room?.sessionId || null;

    // Tell the initiator who declined (for the toast)
    huddleRealtimeService.sendToUser({
      userId: initiatorUserId,
      event: "huddle:declined",
      payload: {
      channelId,
      workspaceId,
      huddleId,
      declinedBy: { userId, username },
      at,
      ...(sessionId ? { sessionId } : {}),
      },
    });

    const room = resolved.room;
    if (ctx.scope.type === "dm" || !room || room.participantCount <= 1) {
      const ended = await endHuddleAndNotify(ctx.scope, huddleId, { userId, username });
      if (!ended.ok) {
        console.error("[huddle:decline:end]", ended.reason);
      }
    }
  });

  /* -----------------------------------------------------
     HUDDLE SIGNALING
  ----------------------------------------------------- */
  socket.on(
    "huddle:signal",
    async ({ channelId, targetUserId, huddleId, data }) => {
      channelId = normalizeSocketId(channelId);
      targetUserId = normalizeSocketId(targetUserId);
      huddleId = normalizeSocketId(huddleId);
      if (!channelId || !targetUserId || !huddleId || !data) return;

      const ctx = await authorizeHuddleScope(socket, channelId, "huddle:signal");
      if (!ctx.ok) return;

      const resolved = await getRoomOrActiveHuddle({
        channelId,
        huddleId,
        workspaceId: ctx.scope.workspaceId,
        scope: ctx.scope,
      });
      if (!resolved.ok || !resolved.room) {
        emitHuddleDenied(socket, "huddle:signal", resolved.reason || "huddle_room_required", { channelId, huddleId });
        return;
      }

      const providerLockGuard = await enforceSocketHuddleProviderLock({
        workspaceId: ctx.scope.workspaceId,
        session: getResolvedHuddleSession({
          room: resolved.room,
          active: resolved.active,
          session: resolved.session,
        }),
        channelId,
        huddleId,
        action: "huddle:signal",
        requestedProvider: "mesh",
        userId: String(userId),
        deviceId: getHuddleSocketDeviceContext(socket).deviceId || null,
        allowLiveKitLifecycleJoin: false,
        createIfMissing: true,
      });
      if (!providerLockGuard.ok) {
        emitHuddleDenied(socket, "huddle:signal", providerLockGuard.reason || "provider_lock_mismatch", {
          channelId,
          huddleId,
          providerLock: providerLockGuard.diagnostics,
        });
        return;
      }

      if (
        !huddleRealtimeService.hasParticipant({
          workspaceId: ctx.scope.workspaceId,
          huddleId,
          userId: String(userId),
        }) ||
        !huddleRealtimeService.hasParticipant({
          workspaceId: ctx.scope.workspaceId,
          huddleId,
          userId: String(targetUserId),
        })
      ) {
        emitHuddleDenied(socket, "huddle:signal", "participant_target_required", { channelId, huddleId, targetUserId });
        return;
      }

      huddleRealtimeService.sendToUser({
        userId: targetUserId,
        event: "huddle:signal",
        payload: {
          channelId,
          huddleId,
          fromUserId: userId,
          toUserId: targetUserId,
          data,
          workspaceId: ctx.scope.workspaceId,
          ...(resolved.room.sessionId ? { sessionId: resolved.room.sessionId } : {}),
        },
      });
    }
  );

  /* -----------------------------------------------------
     HUDDLE MEDIA STATE BROADCASTS
  ----------------------------------------------------- */
  async function broadcastHuddleMediaState({ channelId, event, payload, hostOnly = false, action = event }) {
    channelId = normalizeSocketId(channelId);
    if (!channelId) return;

    const ctx = await authorizeHuddleScope(socket, channelId, action);
    if (!ctx.ok) return;

    const activeRoom = huddleRealtimeService.findRoomByChannel({
      channelId,
      workspaceId: ctx.scope.workspaceId,
      userId,
    });
    if (!activeRoom?.room) {
      emitHuddleDenied(socket, action, "participant_required", { channelId });
      return;
    }

    if (hostOnly) {
      const allowed = await canManageHuddle({
        scope: ctx.scope,
        room: activeRoom.room,
        active: null,
        membership: ctx.membership,
        userId,
      });
      if (!allowed) {
        emitHuddleDenied(socket, action, "huddle_owner_required", { channelId, huddleId: activeRoom.huddleId });
        return;
      }
    }

    const out = payload();
    if (activeRoom.room.sessionId) out.sessionId = activeRoom.room.sessionId;
    await emitHuddleLiveEvent(ctx.scope, activeRoom.room, event, out, { exceptUserId: userId });
  }

  socket.on("huddle:mute", ({ channelId }) => {
    broadcastHuddleMediaState({
      channelId,
      event: "huddle:mute",
      payload: () => ({ channelId, userId, username }),
    }).catch((e) => console.error("[huddle:mute]", e.message));
  });

  socket.on("huddle:unmute", ({ channelId }) => {
    broadcastHuddleMediaState({
      channelId,
      event: "huddle:unmute",
      payload: () => ({ channelId, userId, username }),
    }).catch((e) => console.error("[huddle:unmute]", e.message));
  });

  socket.on("huddle:camera-off", ({ channelId }) => {
    broadcastHuddleMediaState({
      channelId,
      event: "huddle:camera-off",
      payload: () => ({ channelId, userId, username }),
    }).catch((e) => console.error("[huddle:camera-off]", e.message));
  });

  socket.on("huddle:camera-on", ({ channelId }) => {
    broadcastHuddleMediaState({
      channelId,
      event: "huddle:camera-on",
      payload: () => ({ channelId, userId, username }),
    }).catch((e) => console.error("[huddle:camera-on]", e.message));
  });

  socket.on("huddle:subtitle", ({ channelId, text, isFinal }) => {
    broadcastHuddleMediaState({
      channelId,
      event: "huddle:subtitle",
      payload: () => ({ channelId, fromUserId: userId, username, text, isFinal }),
    }).catch((e) => console.error("[huddle:subtitle]", e.message));
  });

  socket.on("huddle:screen-start", ({ channelId }) => {
    broadcastHuddleMediaState({
      channelId,
      event: "huddle:screen-start",
      payload: () => ({ channelId, userId, username }),
    }).catch((e) => console.error("[huddle:screen-start]", e.message));
  });

  socket.on("huddle:screen-stop", ({ channelId }) => {
    broadcastHuddleMediaState({
      channelId,
      event: "huddle:screen-stop",
      payload: () => ({ channelId, userId, username }),
    }).catch((e) => console.error("[huddle:screen-stop]", e.message));
  });

  socket.on("huddle:mute-all", ({ channelId }) => {
    broadcastHuddleMediaState({
      channelId,
      event: "huddle:muted",
      action: "huddle:mute-all",
      hostOnly: true,
      payload: () => ({ channelId, byUserId: userId }),
    }).catch((e) => console.error("[huddle:mute-all]", e.message));
  });

  /* -----------------------------------------------------
     PRESENCE
  ----------------------------------------------------- */
  socket.on("presence:set", (status) => {
    if (!status) return;
    io.emit("presence:update", {
      userId,
      username,
      status,
      at: new Date().toISOString(),
      workspaceId: socket.workspaceId || WORKSPACE_GLOBAL,
    });
  });

  /* -----------------------------------------------------
     DISCONNECT — CLEAN LIFECYCLE ✅ FIXED LOCATION
  ----------------------------------------------------- */
  socket.on("disconnect", () => {
    socket._isCleanedUp = true;
    console.log("Socket disconnected:", userId);

    io.emit("presence:update", {
      userId,
      username,
      status: "offline",
      at: new Date().toISOString(),
      workspaceId: socket.workspaceId,
    });

    // Treat disconnect as a recoverable refresh/network gap first. If the
    // device does not come back before the grace window, clean it up and notify.
    const disconnectDeviceContext = getHuddleSocketDeviceContext(socket);
    scheduleHuddleDisconnectCleanup({
      socket,
      userId,
      username,
      deviceContext: disconnectDeviceContext,
    });
  });
});

  async function safeSocketDbExec(socket, fn, context = "unknown") {
  if (!socket || socket.disconnected) return;

  try {
    await fn();
  } catch (err) {
    console.error(`🔥 Socket DB error [${context}]`, {
      socketId: socket.id,
      error: err,
    });
  }
 }
}


/* -----------------------------------------------------
   EXPORT IO + helper emits
----------------------------------------------------- */
export function getIO() {
  if (!io) throw new Error("Socket.io not initialized");
  return io;
}

export function getSocketRealtimeDiagnostics() {
  return {
    ...socketRealtimeDiagnostics,
    cloudRunMaxScaleRisk:
      socketRealtimeDiagnostics.distributed
        ? false
        : "Socket.IO emits are process-local unless max instances is 1 or Redis adapter is ready.",
  };
}

/* =====================================================
   🧠 WORKSPACE INTELLIGENCE EMITTER
   ===================================================== */

export async function emitWorkspaceIntelligenceUpdate(workspaceId, payload) {
  const room = `workspace:${workspaceId}`;

  const newHealth = await recomputeWorkspaceHealth(workspaceId);

  io.to(room).emit("workspace:intelligence-updated", payload);

  io.to(room).emit("workspace:health-pulse", {
    health: newHealth,
    at: new Date().toISOString(),
  });
}

/**
 * Emitted when a superadmin changes a workspace's billing plan.
 * All connected users in that workspace re-fetch their plan features.
 */
export function emitPlanUpdated(workspaceId, planSlug) {
  if (!io) return;
  io.to(`workspace:${workspaceId}`).emit("workspace:plan_updated", {
    workspaceId,
    plan: planSlug,
  });
}

export function emitChannelCreated(channel, workspaceId = WORKSPACE_GLOBAL) {
  if (!io) return;

  const key = channel?.key || channel?.id || "unknown";
  const legacyRoom = legacyRoomName(key);
  const wsRoom = workspaceRoomName(key, workspaceId);

  io.to(legacyRoom).emit("chat:channel_created", channel);
  io.to(wsRoom).emit("chat:channel_created", channel);
}

export function emitMemberAdded(
  channelId,
  userId,
  workspaceId = WORKSPACE_GLOBAL
) {
  if (!io) return;
  io.to(userId).emit("chat:added_to_channel", { channelId, workspaceId });
  io.to(legacyRoomName(channelId)).emit("chat:member_added", {
    channelId,
    userId,
    workspaceId,
  });
  io.to(workspaceRoomName(channelId, workspaceId)).emit(
    "chat:member_added",
    {
      channelId,
      userId,
      workspaceId,
    }
  );
}

export function emitMessage(channelKey, message, workspaceId = WORKSPACE_GLOBAL) {
  if (!io) return;

  // 🔒 BACKWARD-COMPAT SAFETY:
  // allow old calls: emitMessage(message, workspaceId)
  if (typeof channelKey === "object" && channelKey !== null) {
    workspaceId = message || channelKey.workspaceId || channelKey.workspace_id || workspaceId;
    message = channelKey;
    channelKey =
      message.channelId ||
      message.channel_key ||
      message.channel ||
      null;
  }

  if (!message || !channelKey) return;

   // 🧪 DEBUG LOG — PASTE THIS LINE
  console.log(
    "[emitMessage]",
    "channelKey:",
    channelKey,
    "messageId:",
    message.id,
    "workspaceId:",
    workspaceId
  );

  // 🔒 SAFETY: ensure channelKey is always a string
  const resolvedChannelKey =
    typeof channelKey === "string"
      ? channelKey
      : message.channelId ||
        message.channel_key ||
        message.channel ||
        null;

  if (!resolvedChannelKey) return;

  // 🔒 SAFETY: ensure text is not dropped (AI messages rely on this)
  const resolvedText =
    message.textHtml ||
    message.text_html ||
    message.text ||
    message.fallbackText ||
    message.fallback_text ||
    "";

  const resolvedWorkspaceId =
    message.workspaceId || message.workspace_id || workspaceId;

  const payload = {
    id: message.id || message.tempId || message.message_id || null,
    tempId: message.tempId || null,
    channelId: resolvedChannelKey,
    workspaceId: resolvedWorkspaceId,
    userId: message.userId || message.user_id,
    username: message.username,
    avatarUrl: message.avatarUrl || message.avatar_url || null,
    avatar_url: message.avatarUrl || message.avatar_url || null,
    textHtml: resolvedText,
    createdAt:
      message.createdAt || message.created_at || new Date().toISOString(),
    updatedAt: message.updatedAt || message.updated_at || null,
    deletedAt: message.deletedAt || message.deleted_at || null,
    reactions: message.reactions || {},
    attachments: message.attachments || [],
    encrypted: message.encrypted || message.encrypted_json,
    senderPublicKeyJwk:
      message.senderPublicKeyJwk || message.sender_public_key || null,
    fallbackText: message.fallbackText || message.fallback_text || "",
    parentId: message.parentId || message.parent_id || null,
    isAiMessage: message.isAiMessage === true,
  };

io
  .to(legacyRoomName(resolvedChannelKey))
  .to(workspaceRoomName(resolvedChannelKey, resolvedWorkspaceId))
  .emit("chat:message", payload);

  // For DM channels: also emit to each participant's personal room so they
  // receive the notification even when they're not on the chat page (and
  // therefore haven't joined the channel room via chat:join/chat:open).
  if (resolvedChannelKey.startsWith("dm:")) {
    const parts = resolvedChannelKey.split(":");
    for (let i = 1; i < parts.length; i++) {
      const uid = parts[i];
      if (uid && uid !== String(payload.userId || "")) {
        io.to(uid).emit("chat:message", payload);
      }
    }
  }
}

/**
 * Emit an AI-typing indicator to a channel.
 * Called immediately when the AI starts processing a message so the sender
 * sees "AI is typing..." while waiting for the LLM response.
 */
export function emitAiTyping(channelKey, workspaceId) {
  if (!io || !channelKey || !workspaceId) return;
  const payload = { channelId: channelKey, workspaceId };
  // Emit to both rooms so every client in the DM sees the indicator,
  // regardless of which room they joined (legacy or workspace-scoped).
  io.to(legacyRoomName(channelKey)).emit("chat:ai-typing", payload);
  io.to(workspaceRoomName(channelKey, workspaceId)).emit("chat:ai-typing", payload);
}

/**
 * Emitted when the smart browser test agent hits a login wall and needs
 * the user to provide credentials before it can continue testing.
 * Frontend should listen for this event and show a credential prompt modal.
 */
export function emitTestingCredentialRequest(workspaceId, runId, loginUrl) {
  if (!io || !workspaceId || !runId) return;
  io.to(`workspace:${workspaceId}`).emit("testing:credential_request", {
    runId,
    loginUrl,
    message: "The testing agent reached a login page and needs credentials to continue.",
    timestamp: new Date().toISOString(),
  });
}
