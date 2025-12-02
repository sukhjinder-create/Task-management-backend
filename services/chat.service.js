// services/chat.service.js
import pool from "../db.js";

/**
 * Save a chat message in DB and return the saved row.
 * 
 * Make sure you have a table like:
 *
 * CREATE TABLE IF NOT EXISTS chat_messages (
 *   id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 *   channel_id TEXT NOT NULL,
 *   user_id UUID NOT NULL,
 *   username TEXT NOT NULL,
 *   text TEXT NOT NULL,
 *   created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
 * );
 */
export async function saveChatMessage({ channel_id, user_id, username, text }) {
  const query = `
    INSERT INTO chat_messages (channel_id, user_id, username, text)
    VALUES ($1, $2, $3, $4)
    RETURNING *;
  `;
  const values = [channel_id, user_id, username, text];
  const { rows } = await pool.query(query, values);
  return rows[0];
}

/**
 * Get recent messages for a channel, newest last.
 */
export async function getRecentMessages(channel_id, limit = 100) {
  const query = `
    SELECT *
    FROM chat_messages
    WHERE channel_id = $1
    ORDER BY created_at DESC
    LIMIT $2;
  `;
  const { rows } = await pool.query(query, [channel_id, limit]);
  // reverse so oldest first in UI
  return rows.reverse();
}
