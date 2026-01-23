// ai.permissions.js
import pool from "../db.js";
import { AI_USER_ROLE } from "./ai.constants.js";

/**
 * Rules:
 * - AI never replies to itself
 * - AI replies only if user allowed it
 * - AI never speaks in channels unless admin allows
 */

export async function canAIRespond({
  workspaceId,
  channelType,   // "dm" | "channel"
  senderUserId,
}) {
  const client = await pool.connect();
  try {
    // 1️⃣ Block AI replying to itself
    const sender = await client.query(
      `SELECT role FROM users WHERE id = $1`,
      [senderUserId]
    );

    if (sender.rows[0]?.role === AI_USER_ROLE) {
      return false;
    }

    // 2️⃣ Channel rules
    if (channelType === "channel") {
      const res = await client.query(
        `
        SELECT allow_ai
        FROM chat_channels
        WHERE workspace_id = $1
        LIMIT 1
        `,
        [workspaceId]
      );

      return res.rows[0]?.allow_ai === true;
    }

    // 3️⃣ DM → allowed by default
    return true;
  } finally {
    client.release();
  }
}
