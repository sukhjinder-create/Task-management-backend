
// Extended Chat Data Access Layer for Postgres (workspace-aware)
// Combines original behavior with workspace-scoped enhancements.

import pool from "../db.js";

/* -------------------------------------------------------
   HELPERS — mapping functions (workspace-aware, backwards compatible)
------------------------------------------------------- */

/* -------------------------------------------------------
   :lock: WORKSPACE GUARD (ADD-ONLY)
------------------------------------------------------- */
async function assertChannelWorkspace(channelId, workspaceId) {
  if (!workspaceId) return true; // legacy / global mode

  const { rows } = await pool.query(
    `SELECT 1 FROM chat_channels WHERE id = $1 AND workspace_id = $2`,
    [channelId, workspaceId]
  );

  if (!rows.length) {
    throw new Error("Channel not found in this workspace");
  }

  return true;
}

/* -------------------------------------------------------
   HELPERS — mapping functions (workspace-aware, backwards compatible)
------------------------------------------------------- */
function mapChannelRow(row) {
  if (!row) return null;

  const isPrivate =
    row.is_private !== undefined ? row.is_private : row.isPrivate || false;

  return {
    id: row.id,
    key: row.key,
    name: row.name,
    type: row.type,
    createdBy: row.created_by || row.createdBy,
    createdAt: row.created_at || row.createdAt,
    isPrivate,
    is_private: isPrivate,
    workspaceId: row.workspace_id || row.workspaceId || null,
  };
}

function mapMessageRow(row) {
  if (!row) return null;

  const textHtml =
    row.text_html != null && row.text_html !== ""
      ? row.text_html
      : row.text != null
      ? row.text
      : "";

  return {
    id: row.id,
    channel_id: row.channel_id,
    user_id: row.user_id,
    text_html: textHtml,
    created_at: row.created_at,
    updated_at: row.updated_at,
    deleted_at: row.deleted_at,
    parent_id: row.parent_id,
    reactions: row.reactions || {},
    attachments: row.attachments || [],
    username: row.username,
    workspace_id: row.workspace_id || null,
    encrypted_json: row.encrypted_json,
    fallback_text: row.fallback_text,
    sender_public_key: row.sender_public_key,
  };
}

/* -------------------------------------------------------
   CHANNEL ADMIN HELPERS
------------------------------------------------------- */
export async function isChannelAdmin(channelId, userId) {
  const client = await pool.connect();
  try {
    const res = await client.query(
      `
      SELECT 1 FROM chat_channel_admins
      WHERE channel_id = $1 AND user_id = $2
      LIMIT 1
      `,
      [channelId, userId]
    );
    return res.rows.length > 0;
  } finally {
    client.release();
  }
}

export async function addChannelAdmin(channelId, userId) {
  const client = await pool.connect();
  try {
    await client.query(
      `
      INSERT INTO chat_channel_admins (id, channel_id, user_id)
      VALUES (gen_random_uuid(), $1, $2)
      ON CONFLICT DO NOTHING
      `,
      [channelId, userId]
    );
  } finally {
    client.release();
  }
}

export async function removeChannelAdmin(channelId, userId) {
  const client = await pool.connect();
  try {
    await client.query(
      `
      DELETE FROM chat_channel_admins
      WHERE channel_id = $1 AND user_id = $2
      `,
      [channelId, userId]
    );
  } finally {
    client.release();
  }
}

/* -------------------------------------------------------
   MEMBERSHIP CHECK
------------------------------------------------------- */
export async function isChannelMember(channelId, userId) {
  const client = await pool.connect();
  try {
    const res = await client.query(
      `
      SELECT 1
      FROM chat_channel_members
      WHERE channel_id = $1 AND user_id = $2
      LIMIT 1
      `,
      [channelId, userId]
    );
    return res.rows.length > 0;
  } finally {
    client.release();
  }
}

export async function addChannelMember(channelId, userId) {
  const client = await pool.connect();
  try {
    await client.query(
      `
      INSERT INTO chat_channel_members (id, channel_id, user_id)
      VALUES (gen_random_uuid(), $1, $2)
      ON CONFLICT DO NOTHING
      `,
      [channelId, userId]
    );
  } finally {
    client.release();
  }
}

export async function removeChannelMember(channelId, userId) {
  const client = await pool.connect();
  try {
    await client.query(
      `
      DELETE FROM chat_channel_members
      WHERE channel_id = $1 AND user_id = $2
      `,
      [channelId, userId]
    );
  } finally {
    client.release();
  }
}

/* -------------------------------------------------------
   CHANNEL FETCH BY KEY / ID (workspace-aware)
   NOTE: optional workspaceId params are accepted but currently
         not used if your schema does not have workspace_id yet.
------------------------------------------------------- */

/**
 * Get channel by key, optionally restricted to a workspace.
 * If workspaceId is provided, prefer channel where workspace_id = workspaceId.
 * If workspaceId is null, prefer a global channel where workspace_id IS NULL,
 * but fallback to any channel with that key for compatibility.
 */
export async function getChannelByKey(key, workspaceId = null) {
  const client = await pool.connect();
  try {
    if (workspaceId) {
      const res = await client.query(
        `SELECT * FROM chat_channels WHERE key = $1 AND workspace_id = $2 LIMIT 1`,
        [key, workspaceId]
      );
      if (res.rows.length) return mapChannelRow(res.rows[0]);

      // fallback: maybe a global channel exists but we prefer workspace-specific — return null
      return null;
    } else {
      // find a global channel (workspace_id IS NULL)
      const res = await client.query(
        `SELECT * FROM chat_channels WHERE key = $1 AND workspace_id IS NULL LIMIT 1`,
        [key]
      );
      if (res.rows.length) return mapChannelRow(res.rows[0]);

      // fallback: if none, maybe any channel with that key exists; return first (backwards compatible)
      const fallback = await client.query(
        `SELECT * FROM chat_channels WHERE key = $1 LIMIT 1`,
        [key]
      );
      if (fallback.rows.length) return mapChannelRow(fallback.rows[0]);

      return null;
    }
  } finally {
    client.release();
  }
}

export async function getChannelById(id) {
  const client = await pool.connect();
  try {
    const res = await client.query(
      `SELECT * FROM chat_channels WHERE id = $1 LIMIT 1`,
      [id]
    );
    if (!res.rows.length) return null;
    return mapChannelRow(res.rows[0]);
  } finally {
    client.release();
  }
}

/* -------------------------------------------------------
   CREATE CHANNEL (explicit)
   - preserves previous behavior (creator becomes admin & member)
   - accepts workspaceId optionally (no-op for legacy schema)
------------------------------------------------------- */
export async function createChannel({
  key,
  name,
  type = "channel",
  createdBy,
  isPrivate = false,
  workspaceId = null,
}) {
  const client = await pool.connect();
  try {
    const res = await client.query(
      `
      INSERT INTO chat_channels
        (id, key, name, type, created_by, is_private, workspace_id, created_at)
      VALUES
        (gen_random_uuid(), $1, $2, $3, $4, $5, $6, now())
      RETURNING *
      `,
      [key, name, type, createdBy, isPrivate, workspaceId]
    );

    const channel = mapChannelRow(res.rows[0]);

    // creator is admin + member automatically
    await client.query(
      `
      INSERT INTO chat_channel_admins (id, channel_id, user_id)
      VALUES (gen_random_uuid(), $1, $2)
      ON CONFLICT DO NOTHING
      `,
      [channel.id, createdBy]
    );

    await client.query(
      `
      INSERT INTO chat_channel_members (id, channel_id, user_id)
      VALUES (gen_random_uuid(), $1, $2)
      ON CONFLICT DO NOTHING
      `,
      [channel.id, createdBy]
    );

    return channel;
  } finally {
    client.release();
  }
}

/* -------------------------------------------------------
   GET OR CREATE CHANNEL (WORKSPACE-AWARE)
------------------------------------------------------- */
export async function getOrCreateChannelByKey({
  key,
  type,
  name,
  createdBy,
  workspaceId = null,
}) {
  const q = `
    INSERT INTO chat_channels (key, type, name, created_by, workspace_id)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (workspace_id, key)
    DO UPDATE SET key = EXCLUDED.key
    RETURNING *;
  `;

  const { rows } = await pool.query(q, [
    key,
    type,
    name,
    createdBy,
    workspaceId,
  ]);

  return mapChannelRow(rows[0]);

}

async function legacy_getOrCreateChannelByKey({
  key,
  type,
  name,
  createdBy,
  workspaceId = null,
  isPrivate = false,
}) {
  const client = await pool.connect();
  try {
    // Try to find exact workspace-scoped channel first (if workspaceId provided)
    if (workspaceId) {
      const existing = await client.query(
        `SELECT * FROM chat_channels WHERE key = $1 AND workspace_id = $2 LIMIT 1`,
        [key, workspaceId]
      );
      if (existing.rows.length > 0) {
        return mapChannelRow(existing.rows[0]);
      }

      // If not found, create a workspace-scoped channel
      const inserted = await client.query(
        `
        INSERT INTO chat_channels (id, key, type, name, created_by, workspace_id, created_at, is_private)
        VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, now(), $6)
        RETURNING *
        `,
        [key, type, name, createdBy, workspaceId, isPrivate]
      );

      const channel = mapChannelRow(inserted.rows[0]);

      // add creator as admin+member as before (ensure workspace_id stored if your admin/member table has workspace_id column)
      try {
        await client.query(
          `INSERT INTO chat_channel_admins (id, channel_id, user_id, workspace_id)
           VALUES (gen_random_uuid(), $1, $2, $3)
           ON CONFLICT DO NOTHING`,
          [channel.id, createdBy, workspaceId]
        );
      } catch (e) {
        // If admin table doesn't have workspace_id, try without it (backwards compatible)
        await client.query(
          `INSERT INTO chat_channel_admins (id, channel_id, user_id)
           VALUES (gen_random_uuid(), $1, $2)
           ON CONFLICT DO NOTHING`,
          [channel.id, createdBy]
        );
      }

      try {
        await client.query(
          `INSERT INTO chat_channel_members (id, channel_id, user_id, workspace_id)
           VALUES (gen_random_uuid(), $1, $2, $3)
           ON CONFLICT DO NOTHING`,
          [channel.id, createdBy, workspaceId]
        );
      } catch (e) {
        await client.query(
          `INSERT INTO chat_channel_members (id, channel_id, user_id)
           VALUES (gen_random_uuid(), $1, $2)
           ON CONFLICT DO NOTHING`,
          [channel.id, createdBy]
        );
      }

      return channel;
    }

    // No workspaceId: try to find a global channel (workspace_id IS NULL)
    const existing = await client.query(
      `SELECT * FROM chat_channels WHERE key = $1 AND workspace_id IS NULL LIMIT 1`,
      [key]
    );
    if (existing.rows.length > 0) {
      return mapChannelRow(existing.rows[0]);
    }

    // Fallback: look for any channel with the key (legacy rows)
    const any = await client.query(
      `SELECT * FROM chat_channels WHERE key = $1 LIMIT 1`,
      [key]
    );
    if (any.rows.length > 0) {
      return mapChannelRow(any.rows[0]);
    }

    // Finally, create a global channel
    const inserted = await client.query(
      `
      INSERT INTO chat_channels (id, key, type, name, created_by, created_at, is_private)
      VALUES (gen_random_uuid(), $1, $2, $3, $4, now(), $5)
      RETURNING *
      `,
      [key, type, name, createdBy, isPrivate]
    );

    const channel = mapChannelRow(inserted.rows[0]);

    // add creator as admin+member (without workspace_id)
    await client.query(
      `INSERT INTO chat_channel_admins (id, channel_id, user_id)
       VALUES (gen_random_uuid(), $1, $2)
       ON CONFLICT DO NOTHING`,
      [channel.id, createdBy]
    );

    await client.query(
      `INSERT INTO chat_channel_members (id, channel_id, user_id)
       VALUES (gen_random_uuid(), $1, $2)
       ON CONFLICT DO NOTHING`,
      [channel.id, createdBy]
    );

    return channel;
  } finally {
    client.release();
  }
}

/* -------------------------------------------------------
   ENSURE MEMBER (legacy behavior preserved)
------------------------------------------------------- */
export async function ensureChannelMember(channelId, userId) {
  const client = await pool.connect();
  try {
    const existing = await client.query(
      `
      SELECT 1
      FROM chat_channel_members
      WHERE channel_id = $1 AND user_id = $2
      LIMIT 1
      `,
      [channelId, userId]
    );

    if (existing.rows.length > 0) return;

    await client.query(
      `
      INSERT INTO chat_channel_members (id, channel_id, user_id)
      VALUES (gen_random_uuid(), $1, $2)
      `,
      [channelId, userId]
    );
  } finally {
    client.release();
  }
}

/* -------------------------------------------------------
   CREATE CHAT MESSAGE (workspace-aware, with legacy fallback)
   - will attempt extended insert (encrypted_json, fallback_text, workspace_id)
   - falls back to legacy columns if needed
------------------------------------------------------- */
export async function createChatMessage({
  channelId,
  userId,
  textHtml,
  parentId = null,
  encryptedJson = null,
  fallbackText = null,
  workspaceId = null,
}) {
  const client = await pool.connect();

  // what we’ll store in text_html (always non-empty string)
const baseText = textHtml || fallbackText || "";

try {
  // 🔐 workspace guard MUST be outside SQL
  await assertChannelWorkspace(channelId, workspaceId);

  // Try extended insert (workspace-aware schema)
  try {
    const res = await client.query(
      `
      INSERT INTO chat_messages (
        id,
        channel_id,
        user_id,
        text_html,
        fallback_text,
        workspace_id,
        created_at,
        parent_id
      )
      VALUES (
        gen_random_uuid(),
        $1,
        $2,
        $3,
        $4,
        $5,
        now(),
        $6
      )
      RETURNING *
      `,
      [
        channelId,
        userId,
        baseText,
        fallbackText,
        workspaceId,
        parentId,
      ]
    );

    return mapMessageRow(res.rows[0]);
  } catch (err) {
    // 🧯 fallback for legacy schema (no workspace_id / extra cols)
    console.error(
      "[chat] extended message insert failed, falling back to legacy insert:",
      err.message
    );

    const res = await client.query(
      `
      INSERT INTO chat_messages (
        id,
        channel_id,
        user_id,
        text_html,
        created_at,
        parent_id
      )
      VALUES (
        gen_random_uuid(),
        $1,
        $2,
        $3,
        now(),
        $4
      )
      RETURNING *
      `,
      [
        channelId,
        userId,
        baseText,
        parentId,
      ]
    );

    return mapMessageRow(res.rows[0]);
  }
} finally {
  client.release();
  }
}

/* -------------------------------------------------------
   RECENT MESSAGES (workspace-aware)
------------------------------------------------------- */

// 🔁 SAFE RESOLVER: accepts channelId OR channelKey
export async function getRecentMessagesResolved(
  channelIdentifier,
  limit = 100,
  workspaceId = null
) {
  const client = await pool.connect();

  try {
    // 🧠 If it looks like a UUID → treat as channelId
    if (typeof channelIdentifier === "string" && channelIdentifier.includes("-")) {
      const res = await client.query(
        `
        SELECT
          m.*,
          u.username AS username
        FROM chat_messages m
        JOIN users u ON u.id = m.user_id
        WHERE m.channel_id = $1
        ORDER BY m.created_at ASC
        LIMIT $2
        `,
        [channelIdentifier, limit]
      );

      return res.rows.map(mapMessageRow);
    }

    // 🧠 Otherwise treat as channelKey (workspace-aware path)
    return await getRecentMessagesByChannelKey(
      channelIdentifier,
      limit,
      workspaceId
    );
  } finally {
    client.release();
  }
}


/**
 * Get recent messages by channelKey within a workspace (if workspaceId provided).
 * If workspaceId is null → fetch from global channel (workspace_id IS NULL)
 */

export async function getRecentMessagesByChannelKey(
  channelKey,
  limit = 100,
  workspaceId
) {
  if (!workspaceId) return [];

  const client = await pool.connect();
  try {
    const res = await client.query(
      `
      SELECT
        m.*,
        u.username AS username
      FROM chat_messages m
      JOIN chat_channels c ON c.id = m.channel_id
      JOIN users u ON u.id = m.user_id
      WHERE c.key = $1
        AND c.workspace_id = $2
      ORDER BY m.created_at ASC
      LIMIT $3
      `,
      [channelKey, workspaceId, limit]
    );

    return res.rows.map(mapMessageRow);
  } finally {
    client.release();
  }
}


/* -------------------------------------------------------
   UPDATE / DELETE / LIST HELPERS (unchanged logic)
------------------------------------------------------- */
export async function updateChatMessage({ messageId, userId, textHtml }) {
  const client = await pool.connect();
  try {
    const res = await client.query(
      `
      UPDATE chat_messages
      SET text_html = $1,
          updated_at = now()
      WHERE id = $2
        AND user_id = $3
        AND deleted_at IS NULL
      RETURNING *
      `,
      [textHtml, messageId, userId]
    );

    if (!res.rows.length) return null;
    return mapMessageRow(res.rows[0]);
  } finally {
    client.release();
  }
}

export async function getChannelMembers(channelId) {
  const { rows } = await pool.query(
    `SELECT m.user_id, u.username
     FROM chat_channel_members m
     JOIN users u ON u.id = m.user_id
     WHERE m.channel_id = $1`,
    [channelId]
  );
  return rows;
}

export async function getChannelAdmins(channelId) {
  const { rows } = await pool.query(
    `SELECT user_id FROM chat_channel_admins WHERE channel_id = $1`,
    [channelId]
  );
  return rows;
}

export async function leaveChannel(channelId, userId) {
  await removeChannelMember(channelId, userId);
}

export async function deleteChannel(channelId, userId) {
  if (!(await isChannelAdmin(channelId, userId))) {
    throw new Error("Only admins can delete the channel");
  }
  await pool.query(`DELETE FROM chat_channels WHERE id = $1`, [channelId]);
}

export async function softDeleteChatMessage({ messageId, userId }) {
  const client = await pool.connect();
  try {
    const res = await client.query(
      `
      UPDATE chat_messages
      SET deleted_at = now()
      WHERE id = $1
        AND user_id = $2
        AND deleted_at IS NULL
      RETURNING *
      `,
      [messageId, userId]
    );

    if (!res.rows.length) return null;
    return mapMessageRow(res.rows[0]);
  } finally {
    client.release();
  }
}

// 🔐 WORKSPACE-SAFE CHANNEL LISTING (ADD-ONLY)
export async function getChannelsForUserInWorkspace(userId, workspaceId) {
  const client = await pool.connect();
  try {
    const q = `
      SELECT DISTINCT c.*
      FROM chat_channels c
      LEFT JOIN chat_channel_members m ON m.channel_id = c.id
      WHERE c.workspace_id = $1
        AND (
          c.is_private = false
          OR m.user_id = $2
        )
      ORDER BY c.created_at DESC
    `;
    const { rows } = await client.query(q, [workspaceId, userId]);
    return rows.map(mapChannelRow);
  } finally {
    client.release();
  }
}


/* -------------------------------------------------------
   EXPORT DEFAULT (for compatibility) and named exports
------------------------------------------------------- */
const exported = {
  isChannelAdmin,
  addChannelAdmin,
  removeChannelAdmin,
  isChannelMember,
  addChannelMember,
  removeChannelMember,
  updateChannelPrivacy: async (channelId, isPrivate) => {
    const client = await pool.connect();
    try {
      await client.query(
        `
        UPDATE chat_channels
        SET is_private = $1
        WHERE id = $2
        `,
        [isPrivate, channelId]
      );
    } finally {
      client.release();
    }
  },
  getChannelByKey,
  getChannelById,
  createChannel,
  getOrCreateChannelByKey,
  ensureChannelMember,
  createChatMessage,
  getRecentMessagesByChannelKey,
  updateChatMessage,
  softDeleteChatMessage,
  getChannelMembers,
  getChannelAdmins,
  leaveChannel,
  deleteChannel,
  getChannelsForUserInWorkspace,
  getRecentMessagesResolved,
};

export default exported;
