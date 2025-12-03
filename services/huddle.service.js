import pool from "../db.js";

/**
 * Create/Start a huddle
 */
export async function createHuddle({ channelKey, huddleId, startedBy }) {
  const client = await pool.connect();
  try {
    const result = await client.query(
      `
      INSERT INTO chat_huddles (channel_key, huddle_id, started_by)
      VALUES ($1, $2, $3)
      RETURNING *
      `,
      // FIXED: order matches DB column names
      [channelKey, huddleId, startedBy]
    );

    return result.rows[0];
  } finally {
    client.release();
  }
}

/**
 * Get active (non-ended) huddle for a channel
 */
export async function getActiveHuddle(channelKey) {
  const client = await pool.connect();
  try {
    const result = await client.query(
      `
      SELECT *
      FROM chat_huddles
      WHERE channel_key = $1 AND ended_at IS NULL
      ORDER BY started_at DESC
      LIMIT 1
      `,
      [channelKey]
    );

    return result.rows[0] || null;
  } finally {
    client.release();
  }
}

/**
 * Mark huddle ended
 */
export async function endHuddle({ channelKey, huddleId }) {
  const client = await pool.connect();
  try {
    const result = await client.query(
      `
      UPDATE chat_huddles
      SET ended_at = NOW()
      WHERE channel_key = $1
        AND huddle_id = $2
        AND ended_at IS NULL
      RETURNING *
      `,
      [channelKey, huddleId]
    );

    return result.rows[0] || null;
  } finally {
    client.release();
  }
}
