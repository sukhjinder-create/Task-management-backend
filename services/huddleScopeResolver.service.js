import pool from "../db.js";
import { getChannelByKey, isChannelMember } from "./chat.service.js";
import {
  buildHuddleScopeKey,
  threadMessageIdFromChannelKey,
} from "./huddleSession.service.js";

function safeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || "")
  );
}

export function dmParticipantIds(channelKey) {
  if (typeof channelKey !== "string" || !channelKey.startsWith("dm:")) return [];
  return channelKey.split(":").slice(1).filter(Boolean);
}

async function resolveDmScope(channelKey, workspaceId, actorUserId) {
  const participantIds = dmParticipantIds(channelKey).map(String);
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
      channelId: channelKey,
      workspaceId,
      participantIds,
      isPrivate: true,
      scopeKey: buildHuddleScopeKey({
        scopeType: "dm",
        workspaceId,
        legacyChannelKey: channelKey,
        participantIds,
      }),
    },
  };
}

async function resolveChannelScope(channelKey, workspaceId, actorUserId) {
  const channel = await getChannelByKey(channelKey, workspaceId);
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
      channelId: channelKey,
      workspaceId,
      channel,
      isPrivate,
      scopeKey: buildHuddleScopeKey({
        scopeType: "channel",
        workspaceId,
        channelId: channel.id,
        legacyChannelKey: channelKey,
      }),
    },
  };
}

async function resolveThreadScope(channelKey, workspaceId, actorUserId) {
  const messageId = threadMessageIdFromChannelKey(channelKey);
  if (!messageId) return { ok: false, reason: "invalid_thread_channel" };

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

  const parent = parentChannelKey.startsWith("dm:")
    ? await resolveDmScope(parentChannelKey, workspaceId, actorUserId)
    : await resolveChannelScope(parentChannelKey, workspaceId, actorUserId);
  if (!parent.ok) return parent;

  return {
    ok: true,
    scope: {
      ...parent.scope,
      type: "thread",
      channelId: channelKey,
      parentChannelId: parentChannelKey,
      parentScope: parent.scope,
      threadMessageId: messageId,
      isPrivate: true,
      scopeKey: buildHuddleScopeKey({
        scopeType: "thread",
        workspaceId,
        channelId: parent.scope.channel?.id || null,
        legacyChannelKey: channelKey,
        threadMessageId: messageId,
        participantIds: parent.scope.participantIds || [],
      }),
    },
  };
}

export async function resolveHuddleScope({
  channelId,
  workspaceId,
  actorUserId,
}) {
  const channelKey = safeString(channelId);
  if (!channelKey) return { ok: false, reason: "channel_required" };
  if (!workspaceId) return { ok: false, reason: "workspace_required" };
  if (!actorUserId) return { ok: false, reason: "actor_required" };

  if (channelKey.startsWith("dm:")) {
    return resolveDmScope(channelKey, workspaceId, actorUserId);
  }
  if (channelKey.startsWith("thread:")) {
    return resolveThreadScope(channelKey, workspaceId, actorUserId);
  }
  return resolveChannelScope(channelKey, workspaceId, actorUserId);
}

export default {
  dmParticipantIds,
  resolveHuddleScope,
};
