import pool from "../db.js";

function runner(client) {
  return client || pool;
}

function json(value) {
  return JSON.stringify(value || {});
}

function safeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || "")
  );
}

export function threadMessageIdFromChannelKey(channelKey) {
  const parts = safeString(channelKey).split(":");
  const last = parts[parts.length - 1];
  return isUuid(last) ? last : null;
}

export function buildHuddleScopeKey({
  scopeType,
  workspaceId,
  channelId = null,
  legacyChannelKey = null,
  threadMessageId = null,
  participantIds = [],
}) {
  const legacyKey = safeString(legacyChannelKey);
  if (scopeType === "dm") {
    const ids = (participantIds || [])
      .map((id) => safeString(String(id)))
      .filter(Boolean)
      .sort();
    if (ids.length > 0) return `dm:${ids.join(":")}`;
    return legacyKey || `dm:${workspaceId}`;
  }

  if (scopeType === "thread") {
    return `thread:${threadMessageId || threadMessageIdFromChannelKey(legacyKey) || legacyKey}`;
  }

  if (scopeType === "channel") {
    return `channel:${channelId || legacyKey}`;
  }

  return `${scopeType || "ad_hoc"}:${channelId || legacyKey || workspaceId}`;
}

export function normalizeLegacyHuddleScope({
  workspaceId,
  legacyChannelKey,
  scope = {},
}) {
  const channelKey = safeString(scope.channelId) || safeString(legacyChannelKey);
  const scopeType = safeString(scope.type) || (
    channelKey.startsWith("dm:")
      ? "dm"
      : channelKey.startsWith("thread:")
      ? "thread"
      : "channel"
  );
  const threadMessageId =
    scope.threadMessageId ||
    scope.thread_message_id ||
    threadMessageIdFromChannelKey(channelKey);
  const channelId =
    scopeType === "channel"
      ? scope.channel?.id || null
      : scopeType === "thread"
      ? scope.parentScope?.channel?.id || null
      : null;
  const participantIds =
    scopeType === "dm"
      ? scope.participantIds || channelKey.split(":").slice(1)
      : scope.parentScope?.type === "dm"
      ? scope.parentScope.participantIds || []
      : [];
  const visibility =
    scopeType === "dm" || scopeType === "thread" || scope.isPrivate
      ? "scope_members"
      : "workspace";

  return {
    workspaceId,
    scopeType,
    scopeKey: buildHuddleScopeKey({
      scopeType,
      workspaceId,
      channelId,
      legacyChannelKey: channelKey,
      threadMessageId,
      participantIds,
    }),
    channelId,
    threadMessageId,
    legacyChannelKey: channelKey,
    visibility,
    participantIds,
  };
}

export async function findHuddleSessionByLegacy({
  workspaceId,
  legacyChannelKey = null,
  legacyHuddleId = null,
  client = null,
}) {
  if (!workspaceId) throw new Error("workspaceId is required");
  if (!legacyHuddleId && !legacyChannelKey) return null;

  const params = [workspaceId];
  const predicates = ["workspace_id = $1"];

  if (legacyHuddleId) {
    params.push(legacyHuddleId);
    predicates.push(`legacy_huddle_id = $${params.length}`);
  }
  if (legacyChannelKey) {
    params.push(legacyChannelKey);
    predicates.push(`legacy_channel_key = $${params.length}`);
  }

  const { rows } = await runner(client).query(
    `
    SELECT *
    FROM huddle_sessions
    WHERE ${predicates.join(" AND ")}
    ORDER BY started_at DESC
    LIMIT 1
    `,
    params
  );

  return rows[0] || null;
}

export async function findActiveHuddleSessionByScope({
  workspaceId,
  scopeType,
  scopeKey,
  client = null,
}) {
  if (!workspaceId) throw new Error("workspaceId is required");
  if (!scopeType) throw new Error("scopeType is required");
  if (!scopeKey) throw new Error("scopeKey is required");

  const { rows } = await runner(client).query(
    `
    SELECT *
    FROM huddle_sessions
    WHERE workspace_id = $1
      AND scope_type = $2
      AND scope_key = $3
      AND ended_at IS NULL
    ORDER BY started_at DESC
    LIMIT 1
    `,
    [workspaceId, scopeType, scopeKey]
  );

  return rows[0] || null;
}

export async function endActiveHuddleSessionsForScope({
  workspaceId,
  scopeType,
  scopeKey,
  endedBy = null,
  reason = "superseded_by_legacy_huddle",
  exceptLegacyHuddleId = null,
  client = null,
}) {
  if (!workspaceId || !scopeType || !scopeKey) return [];

  const params = [workspaceId, scopeType, scopeKey, endedBy, reason];
  let exceptSql = "";
  if (exceptLegacyHuddleId) {
    params.push(exceptLegacyHuddleId);
    exceptSql = `AND (legacy_huddle_id IS NULL OR legacy_huddle_id != $${params.length})`;
  }

  const { rows } = await runner(client).query(
    `
    UPDATE huddle_sessions
    SET
      state = 'ended',
      ended_at = COALESCE(ended_at, now()),
      ended_by = COALESCE($4, ended_by),
      end_reason = COALESCE(end_reason, $5),
      updated_at = now()
    WHERE workspace_id = $1
      AND scope_type = $2
      AND scope_key = $3
      AND ended_at IS NULL
      ${exceptSql}
    RETURNING *
    `,
    params
  );

  return rows;
}

export async function createOrGetLegacyHuddleSession({
  workspaceId,
  legacyChannelKey,
  legacyHuddleId,
  startedBy,
  hostUserId = startedBy,
  scope = {},
  startedAt = null,
  metadata = {},
  client = null,
}) {
  if (!workspaceId) throw new Error("workspaceId is required");
  if (!legacyChannelKey) throw new Error("legacyChannelKey is required");
  if (!legacyHuddleId) throw new Error("legacyHuddleId is required");
  if (!startedBy) throw new Error("startedBy is required");

  const existing = await findHuddleSessionByLegacy({
    workspaceId,
    legacyChannelKey,
    legacyHuddleId,
    client,
  });
  if (existing) return existing;

  const normalized = normalizeLegacyHuddleScope({
    workspaceId,
    legacyChannelKey,
    scope,
  });

  await endActiveHuddleSessionsForScope({
    workspaceId,
    scopeType: normalized.scopeType,
    scopeKey: normalized.scopeKey,
    endedBy: startedBy,
    exceptLegacyHuddleId: legacyHuddleId,
    client,
  });

  try {
    const { rows } = await runner(client).query(
      `
      INSERT INTO huddle_sessions (
        workspace_id,
        legacy_huddle_id,
        legacy_channel_key,
        scope_type,
        scope_key,
        channel_id,
        thread_message_id,
        started_by,
        host_user_id,
        state,
        visibility,
        started_at,
        metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'live', $10, COALESCE($11, now()), $12)
      RETURNING *
      `,
      [
        workspaceId,
        legacyHuddleId,
        normalized.legacyChannelKey,
        normalized.scopeType,
        normalized.scopeKey,
        normalized.channelId,
        normalized.threadMessageId,
        startedBy,
        hostUserId || startedBy,
        normalized.visibility,
        startedAt,
        json({
          ...metadata,
          legacyChannelKey,
          participantIds: normalized.participantIds,
        }),
      ]
    );
    return rows[0];
  } catch (err) {
    if (err?.code === "23505") {
      return (
        (await findHuddleSessionByLegacy({
          workspaceId,
          legacyChannelKey,
          legacyHuddleId,
          client,
        })) ||
        (await findActiveHuddleSessionByScope({
          workspaceId,
          scopeType: normalized.scopeType,
          scopeKey: normalized.scopeKey,
          client,
        }))
      );
    }
    throw err;
  }
}

export async function endLegacyHuddleSession({
  workspaceId,
  legacyChannelKey,
  legacyHuddleId,
  endedBy = null,
  reason = "legacy_huddle_ended",
  client = null,
}) {
  const session = await findHuddleSessionByLegacy({
    workspaceId,
    legacyChannelKey,
    legacyHuddleId,
    client,
  });
  if (!session) return null;

  const { rows } = await runner(client).query(
    `
    UPDATE huddle_sessions
    SET
      state = 'ended',
      ended_at = COALESCE(ended_at, now()),
      ended_by = COALESCE($3, ended_by),
      end_reason = COALESCE(end_reason, $4),
      updated_at = now()
    WHERE id = $1
      AND workspace_id = $2
    RETURNING *
    `,
    [session.id, workspaceId, endedBy, reason]
  );

  return rows[0] || session;
}

export async function createLegacyChatHuddle({
  workspaceId,
  legacyChannelKey,
  legacyHuddleId,
  startedBy,
  client = null,
}) {
  if (!workspaceId) throw new Error("workspaceId is required");
  if (!legacyChannelKey) throw new Error("legacyChannelKey is required");
  if (!legacyHuddleId) throw new Error("legacyHuddleId is required");
  if (!startedBy) throw new Error("startedBy is required");

  const { rows } = await runner(client).query(
    `
    INSERT INTO chat_huddles (workspace_id, channel_key, huddle_id, started_by)
    VALUES ($1, $2, $3, $4)
    RETURNING *
    `,
    [workspaceId, legacyChannelKey, legacyHuddleId, startedBy]
  );

  return rows[0];
}

export async function endLegacyChatHuddle({
  workspaceId,
  legacyChannelKey,
  legacyHuddleId,
  client = null,
}) {
  if (!workspaceId) throw new Error("workspaceId is required");
  if (!legacyChannelKey) throw new Error("legacyChannelKey is required");
  if (!legacyHuddleId) throw new Error("legacyHuddleId is required");

  const { rows } = await runner(client).query(
    `
    UPDATE chat_huddles
    SET ended_at = NOW()
    WHERE workspace_id = $1
      AND channel_key = $2
      AND huddle_id = $3
      AND ended_at IS NULL
    RETURNING *
    `,
    [workspaceId, legacyChannelKey, legacyHuddleId]
  );

  return rows[0] || null;
}

export async function findLegacyChatHuddle({
  workspaceId,
  legacyChannelKey,
  legacyHuddleId,
  client = null,
}) {
  if (!workspaceId) throw new Error("workspaceId is required");
  if (!legacyChannelKey) throw new Error("legacyChannelKey is required");
  if (!legacyHuddleId) throw new Error("legacyHuddleId is required");

  const { rows } = await runner(client).query(
    `
    SELECT h.*, u.username AS starter_username
    FROM chat_huddles h
    LEFT JOIN users u ON u.id = h.started_by
    WHERE h.workspace_id = $1
      AND h.channel_key = $2
      AND h.huddle_id = $3
    ORDER BY h.started_at DESC
    LIMIT 1
    `,
    [workspaceId, legacyChannelKey, legacyHuddleId]
  );

  return rows[0] || null;
}

export async function findActiveLegacyChatHuddle({
  workspaceId,
  legacyChannelKey,
  legacyHuddleId = null,
  client = null,
}) {
  if (!workspaceId) throw new Error("workspaceId is required");
  if (!legacyChannelKey) throw new Error("legacyChannelKey is required");

  const params = [workspaceId, legacyChannelKey];
  const huddlePredicate = legacyHuddleId ? `AND h.huddle_id = $3` : "";
  if (legacyHuddleId) params.push(legacyHuddleId);

  const { rows } = await runner(client).query(
    `
    SELECT h.*, u.username AS starter_username
    FROM chat_huddles h
    LEFT JOIN users u ON u.id = h.started_by
    WHERE h.workspace_id = $1
      AND h.channel_key = $2
      AND h.ended_at IS NULL
      ${huddlePredicate}
    ORDER BY h.started_at DESC
    LIMIT 1
    `,
    params
  );

  return rows[0] || null;
}

export async function listRecentActiveLegacyChatHuddles({
  workspaceId,
  excludeStartedBy = null,
  withinMinutes = 5,
  limit = 20,
  client = null,
}) {
  if (!workspaceId) throw new Error("workspaceId is required");

  const { rows } = await runner(client).query(
    `
    SELECT h.*, u.username AS starter_username
    FROM chat_huddles h
    JOIN users u ON u.id = h.started_by
    WHERE h.workspace_id = $1
      AND h.ended_at IS NULL
      AND ($2::uuid IS NULL OR h.started_by != $2::uuid)
      AND h.started_at > NOW() - ($3::int * INTERVAL '1 minute')
    ORDER BY h.started_at DESC
    LIMIT $4
    `,
    [workspaceId, excludeStartedBy || null, withinMinutes, limit]
  );

  return rows;
}

export default {
  buildHuddleScopeKey,
  normalizeLegacyHuddleScope,
  findHuddleSessionByLegacy,
  findActiveHuddleSessionByScope,
  endActiveHuddleSessionsForScope,
  createOrGetLegacyHuddleSession,
  endLegacyHuddleSession,
  createLegacyChatHuddle,
  endLegacyChatHuddle,
  findLegacyChatHuddle,
  findActiveLegacyChatHuddle,
  listRecentActiveLegacyChatHuddles,
};
