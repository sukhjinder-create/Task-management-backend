
// Extended Chat Data Access Layer for Postgres (workspace-aware)
// Combines original behavior with workspace-scoped enhancements.
import axios from 'axios';  // Add this line to import axios
import pool from "../db.js";
// 🔥 EMIT TO SOCKET SO UI UPDATES INSTANTLY
import { emitMessage } from "../realtime/socket.js";
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
    channel_key: row.channel_key,
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
export async function getChannelByKey(key, workspaceId) {
  if (!workspaceId) return null; // 🔒 workspace is mandatory now

  const client = await pool.connect();
  try {
    const res = await client.query(
      `
      SELECT *
      FROM chat_channels
      WHERE key = $1
        AND workspace_id = $2
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [key, workspaceId]
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

// Helper to send events to AI service
async function emitToAI(event) {
  const aiServiceUrl = process.env.AI_SERVICE_URL || 'http://localhost:5005/internal/chat-event';  // Update if needed
  const aiServiceSecret = process.env.AI_SERVICE_SECRET;

  console.log('🔥 Emitting event to AI:', event);  // Add log to confirm event is being emitted

  try {
    const response = await axios.post(aiServiceUrl, event, {
      headers: {
        Authorization: `Bearer ${aiServiceSecret}`,
      },
    });
    console.log('🔥 Event sent to AI:', response.status);
  } catch (error) {
    console.error('🔥 Failed to send event to AI:', error.message);
  }
}

/* -------------------------------------------------------
   LEGACY FUNCTION (INTENTIONALLY DISABLED)
   ❌ Do NOT use global channels anymore
------------------------------------------------------- */
async function legacy_getOrCreateChannelByKey() {
  throw new Error(
    "[chat] legacy_getOrCreateChannelByKey is disabled. Channels must be workspace-scoped."
  );
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

// Create Chat Message (where the text is inserted)
export async function createChatMessage({
  channelKey,
  userId,
  textHtml,
  parentId = null,
  encryptedJson = null,
  fallbackText = null,
  workspaceId,
}) {
  if (!channelKey) throw new Error("channelKey required");
  if (!workspaceId) throw new Error("workspaceId required");

  const client = await pool.connect();
  const baseText = textHtml || fallbackText || "";

  try {
    // Convert the text to valid JSON (encode the message if necessary)
    const encryptedJsonObject = {
      message: baseText,  // Wrap the baseText in a valid JSON object
    };

    const res = await client.query(
      `
      INSERT INTO chat_messages (
        id,
        channel_key,
        user_id,
        text_html,
        fallback_text,
        encrypted_json,
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
        $6,
        now(),
        $7
      )
      RETURNING *
      `,
      [
        channelKey,
        userId,
        baseText,
        fallbackText,
        JSON.stringify(encryptedJsonObject),  // Ensure the encrypted field is JSON stringified
        workspaceId,
        parentId,
      ]
    );

    const savedMessage = mapMessageRow(res.rows[0]);

    // 🔥 Normalize message for socket emit (CRITICAL)
const socketMessage = {
  id: savedMessage.id,
  channelId: channelKey,          // MUST be string
  userId: savedMessage.user_id,
  username: savedMessage.username,
  textHtml: savedMessage.text_html || savedMessage.fallback_text || "",
  createdAt: savedMessage.created_at,
  updatedAt: savedMessage.updated_at,
  deletedAt: savedMessage.deleted_at,
  parentId: savedMessage.parent_id,
  reactions: savedMessage.reactions || {},
  attachments: savedMessage.attachments || [],
  workspaceId,
};

    // 🔥 Emit the event to AI after saving the message
    // Do not notify AI if the sender is the AI itself (system user)
    const isSystemUser = await client.query(
      `SELECT 1 FROM system_users WHERE user_id = $1 LIMIT 1`,
      [userId]
    );

    if (isSystemUser.rows.length === 0) {
      // Notify AI only if the sender is not the system user
      await emitToAI({
        type: "chat:new-message",
        payload: savedMessage,
      });
    }

    // Emit the message to any other channels or front-end systems (non-AI)
    emitMessage(socketMessage, workspaceId);// Ensure the message is also emitted to other channels if necessary

    return savedMessage;
  } finally {
    client.release();
  }
}

/* -------------------------------------------------------
   RECENT MESSAGES (workspace-aware, CHANNEL + DM SAFE)
------------------------------------------------------- */
export async function getRecentMessagesResolved(
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
        u.username
      FROM chat_messages m
      JOIN users u ON u.id = m.user_id
      WHERE m.channel_key = $1
        AND m.workspace_id = $2
      ORDER BY m.created_at ASC
      LIMIT $3
      `,
      [channelKey, workspaceId, Number(limit)]
    );

    return res.rows.map(mapMessageRow);
  } finally {
    client.release();
  }
}

export async function getRecentMessagesByChannelKey(
  channelKey,
  limit = 100,
  workspaceId
) {
  if (!workspaceId) return [];

  const client = await pool.connect();
  try {
    // 1️⃣ Resolve channel once (by key + workspace)
    const channel = await getChannelByKey(channelKey, workspaceId);
    if (!channel) return [];

    // 2️⃣ Load messages safely (UUID-based, correct LIMIT binding)
    const res = await client.query(
  `
  SELECT
    m.*,
    u.username AS username
  FROM chat_messages m
  JOIN users u ON u.id = m.user_id
  WHERE m.channel_key = $1
    AND m.workspace_id = $2
  ORDER BY m.created_at ASC
  LIMIT $3
  `,
  [
    channelKey,     // ✅ TEXT
    workspaceId,
    Number(limit),
  ]
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

// 🔐 WORKSPACE-SAFE CHANNEL LISTING (FIXED)
export async function getChannelsForUserInWorkspace(userId, workspaceId) {
  const client = await pool.connect();
  try {
    const q = `
      SELECT DISTINCT c.*
      FROM chat_channels c
      LEFT JOIN chat_channel_members m
        ON m.channel_id = c.id
      WHERE c.workspace_id = $1
        AND (
          c.is_private = false
          OR m.user_id = $2
        )
      ORDER BY c.created_at ASC
    `;

    const { rows } = await client.query(q, [workspaceId, userId]);
    return rows.map(mapChannelRow);
  } finally {
    client.release();
  }
}

// ✅ LIST ALL CHANNELS (CHANNEL + DM) FOR A WORKSPACE
export async function getAllChannelsForWorkspace(workspaceId) {
  const client = await pool.connect();
  try {
    const res = await client.query(
      `
      SELECT *
      FROM chat_channels
      WHERE workspace_id = $1
      ORDER BY created_at ASC
      `,
      [workspaceId]
    );
    return res.rows.map(mapChannelRow);
  } finally {
    client.release();
  }
}


// ✅ LIST ONLY DMs (OPTIONAL – USED LATER FOR FILTERING)
export async function getAllDMsForWorkspace(workspaceId) {
  if (!workspaceId) return [];

  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `
      SELECT *
      FROM chat_channels
      WHERE workspace_id = $1
        AND type = 'dm'
      ORDER BY created_at ASC
      `,
      [workspaceId]
    );

    return rows.map(mapChannelRow);
  } finally {
    client.release();
  }
}

export { emitToAI };

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
