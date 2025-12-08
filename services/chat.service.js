// services/chat.service.js
// Extended Chat Data Access Layer for Postgres
// ⚠️ NO OLD FUNCTIONS REMOVED — FULL BACKWARD COMPATIBILITY

import pool from "../db.js";

/* -------------------------------------------------------
   HELPERS — existing mapping functions preserved
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
    // camelCase and snake_case so frontend can use either
    isPrivate,
    is_private: isPrivate,
  };
}


function mapMessageRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    channel_id: row.channel_id,
    user_id: row.user_id,
    text_html: row.text_html,
    created_at: row.created_at,
    updated_at: row.updated_at,
    deleted_at: row.deleted_at,
    parent_id: row.parent_id,
    reactions: row.reactions || {},
    attachments: row.attachments || [],
    username: row.username,
  };
}

/* -------------------------------------------------------
   NEW: CHANNEL ADMIN HELPERS
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
   NEW: MEMBERSHIP CHECK
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

/* -------------------------------------------------------
   NEW: CHANNEL FETCH BY KEY / ID
------------------------------------------------------- */
export async function getChannelByKey(key) {
  const client = await pool.connect();
  try {
    const res = await client.query(
      `SELECT * FROM chat_channels WHERE key = $1 LIMIT 1`,
      [key]
    );
    if (!res.rows.length) return null;
    return mapChannelRow(res.rows[0]);
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
   NEW: CREATE CHANNEL (explicit)
   - preserves previous behavior (creator becomes admin & member)
------------------------------------------------------- */
export async function createChannel({
  key,
  name,
  type = "channel",
  createdBy,
  isPrivate = false,
}) {
  const client = await pool.connect();
  try {
    const res = await client.query(
      `
      INSERT INTO chat_channels
        (id, key, name, type, created_by, is_private, created_at)
      VALUES
        (gen_random_uuid(), $1, $2, $3, $4, $5, now())
      RETURNING *
      `,
      [key, name, type, createdBy, isPrivate]
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
   NEW: ADD/REMOVE MEMBERS (keeps compatibility)
------------------------------------------------------- */
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
   NEW: UPDATE CHANNEL PRIVACY
------------------------------------------------------- */
export async function updateChannelPrivacy(channelId, isPrivate) {
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
}

/* -------------------------------------------------------
   EXISTING FUNCTIONS (NOT TOUCHED)
   — preserve original behavior and names
------------------------------------------------------- */

export async function getOrCreateChannelByKey({ key, type, name, createdBy }) {
  const client = await pool.connect();
  try {
    const existing = await client.query(
      `SELECT * FROM chat_channels WHERE key = $1 LIMIT 1`,
      [key]
    );
    if (existing.rows.length > 0) {
      return mapChannelRow(existing.rows[0]);
    }

    const inserted = await client.query(
      `
      INSERT INTO chat_channels (id, key, type, name, created_by, created_at, is_private)
      VALUES (gen_random_uuid(), $1, $2, $3, $4, now(), false)
      RETURNING *
      `,
      [key, type, name, createdBy]
    );

    return mapChannelRow(inserted.rows[0]);
  } finally {
    client.release();
  }
}

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

export async function createChatMessage({
  channelId,
  userId,
  textHtml,
  parentId = null,
}) {
  const client = await pool.connect();
  try {
    const result = await client.query(
      `
      INSERT INTO chat_messages (
        id,
        channel_id,
        user_id,
        text_html,
        created_at,
        parent_id
      )
      VALUES (gen_random_uuid(), $1, $2, $3, now(), $4)
      RETURNING *
      `,
      [channelId, userId, textHtml, parentId]
    );

    return mapMessageRow(result.rows[0]);
  } finally {
    client.release();
  }
}

export async function getRecentMessages(channelId, limit = 100) {
  const client = await pool.connect();
  try {
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
      [channelId, limit]
    );

    return res.rows.map(mapMessageRow);
  } finally {
    client.release();
  }
}

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

/* -------------------------------------------------------
   ADDITIONAL: CHANNEL LISTING (public + private where member)
------------------------------------------------------- */
export async function getChannelsForUser(userId) {
  const client = await pool.connect();
  try {
    const publicQ = await client.query(
      `SELECT * FROM chat_channels WHERE is_private = false ORDER BY created_at DESC`
    );
    const privateQ = await client.query(
      `SELECT c.* FROM chat_channels c JOIN chat_channel_members m ON c.id = m.channel_id WHERE m.user_id = $1 ORDER BY c.created_at DESC`,
      [userId]
    );
    const map = new Map();
    for (const r of publicQ.rows.concat(privateQ.rows)) map.set(r.id, r);
    return Array.from(map.values()).map(mapChannelRow);
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
  updateChannelPrivacy,
  getChannelByKey,
  getChannelById,
  createChannel,
  getChannelsForUser,
  getOrCreateChannelByKey,
  ensureChannelMember,
  createChatMessage,
  getRecentMessages,
  updateChatMessage,
  softDeleteChatMessage,
  getChannelMembers,
  getChannelAdmins,
  leaveChannel,
  deleteChannel,
};

export default exported;
