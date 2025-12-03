// services/chat.service.js
// Chat data access layer for Postgres

import pool from "../db.js"; // ⬅️ adjust this if your db import is different

// ---------- Helpers ----------

function mapChannelRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    type: row.type,
    createdBy: row.created_by,
    createdAt: row.created_at,
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
    username: row.username, // from JOIN with users
  };
}

// ---------- Channels ----------

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
      INSERT INTO chat_channels (id, key, type, name, created_by, created_at)
      VALUES (gen_random_uuid(), $1, $2, $3, $4, now())
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

// ---------- Messages ----------

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
    const result = await client.query(
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

    return result.rows.map(mapMessageRow);
  } finally {
    client.release();
  }
}

// ---------- Edit / Delete (persistent) ----------

export async function updateChatMessage({ messageId, userId, textHtml }) {
  const client = await pool.connect();
  try {
    const result = await client.query(
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

    if (result.rows.length === 0) return null;
    return mapMessageRow(result.rows[0]);
  } finally {
    client.release();
  }
}

export async function softDeleteChatMessage({ messageId, userId }) {
  const client = await pool.connect();
  try {
    const result = await client.query(
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

    if (result.rows.length === 0) return null;
    return mapMessageRow(result.rows[0]);
  } finally {
    client.release();
  }
}
