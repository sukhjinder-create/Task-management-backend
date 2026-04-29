
// Extended Chat Data Access Layer for Postgres (workspace-aware)
// Combines original behavior with workspace-scoped enhancements.
import axios from 'axios';  // Add this line to import axios
import pool from "../db.js";
// 🔥 EMIT TO SOCKET SO UI UPDATES INSTANTLY
import { emitMessage, emitAiTyping } from "../realtime/socket.js";
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

function extractAIPlainText(savedMessage) {
  if (!savedMessage) return null;

  // 1️⃣ DB fallback_text — but it may itself be the encrypted envelope JSON.
  //    When the frontend sends an E2E message the raw encrypted JSON gets stored
  //    as fallback_text. Parse it and pull out the embedded fallbackText field.
  if (typeof savedMessage.fallback_text === "string") {
    const fb = savedMessage.fallback_text;
    if (fb.includes("e2e-p256-aesgcm")) {
      try {
        const parsed = JSON.parse(fb);
        if (parsed?.fallbackText) return stripHtml(String(parsed.fallbackText));
      } catch {}
      // encrypted with no usable fallback — fall through to step 2
    } else {
      return stripHtml(fb);
    }
  }

  // 2️⃣ encrypted_json.message (STRINGIFIED JSON)
  try {
    const enc =
      typeof savedMessage.encrypted_json === "string"
        ? JSON.parse(savedMessage.encrypted_json)
        : savedMessage.encrypted_json;

    if (enc?.message && typeof enc.message === "string") {
      const inner = JSON.parse(enc.message);

      if (typeof inner.fallbackText === "string") {
        return stripHtml(inner.fallbackText);
      }
    }
  } catch (err) {
    console.error("❌ AI extract failed", err);
  }

  // 3️⃣ legacy plaintext
  if (
    typeof savedMessage.text_html === "string" &&
    !savedMessage.text_html.includes("e2e-p256")
  ) {
    return stripHtml(savedMessage.text_html);
  }

  return null;
}

function stripHtml(html) {
  return html.replace(/<[^>]*>/g, "").trim();
}

async function ensureWorkspaceAIUser(client, workspaceId) {
  if (!workspaceId) {
    throw new Error("workspaceId is required for AI user");
  }

  // system_users schema: (workspace_id PK, user_id) — no id or display_name columns
  const res = await client.query(
    `
    SELECT
      su.user_id,
      COALESCE(ws.ai_name, u.username, 'AI Assistant') AS ai_name
    FROM system_users su
    LEFT JOIN workspace_ai_settings ws ON ws.workspace_id = su.workspace_id
    LEFT JOIN users u ON u.id = su.user_id
    WHERE su.workspace_id = $1::uuid
    LIMIT 1
    `,
    [workspaceId]
  );

  if (res.rows.length > 0) {
    const aiName = res.rows[0].ai_name;
    const aiUserId = res.rows[0].user_id;
    await client.query(
      `UPDATE users SET username = $1 WHERE id = $2 AND username != $1`,
      [aiName, aiUserId]
    );
    return { userId: aiUserId, username: aiName };
  }

  // Lazy-create AI user (once per workspace)
  const userRes = await client.query(
    `
    INSERT INTO users (id, username, email, role, workspace_id, is_system, created_at)
    VALUES (gen_random_uuid(), 'AI Assistant', $1, 'system', $2::uuid, true, now())
    RETURNING id
    `,
    [`ai+${workspaceId}@example.com`, workspaceId]
  );

  const aiUserId = userRes.rows[0].id;

  await client.query(
    `INSERT INTO system_users (workspace_id, user_id) VALUES ($1::uuid, $2) ON CONFLICT (workspace_id) DO NOTHING`,
    [workspaceId, aiUserId]
  );

  return { userId: aiUserId, username: "AI Assistant" };
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
  const aiServiceUrl = process.env.AI_SERVICE_URL;

if (!aiServiceUrl) {
  throw new Error("AI_SERVICE_URL is not defined in backend environment");
}

  const aiServiceSecret = process.env.AI_SERVICE_SECRET;

if (!aiServiceSecret) {
  throw new Error("AI_SERVICE_SECRET is not defined in backend environment");
}

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
  tempId = null,
  textHtml,
  parentId = null,
  encryptedJson = null,
  fallbackText = null,
  attachments = [],
  workspaceId,
}) {
  if (!channelKey) throw new Error("channelKey required");
  if (!workspaceId) throw new Error("workspaceId required");

  const client = await pool.connect();
  let normalizedFallback = null;

// 🔥 If encrypted JSON contains fallbackText, extract it ONCE
if (encryptedJson && typeof encryptedJson === "object") {
  if (typeof encryptedJson.fallbackText === "string") {
    normalizedFallback = encryptedJson.fallbackText;
  }
}

const baseText =
  normalizedFallback?.trim() ||
  fallbackText?.trim() ||
  (typeof textHtml === "string" ? textHtml.trim() : "");

const safeAttachments = Array.isArray(attachments) ? attachments : [];

  // ⛔ side-effects MUST NOT run inside DB transaction
  let postCommit = null;

  try {
    const encryptedJsonObject = { message: baseText };

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
    parent_id,
    attachments,
    temp_id
  )
  VALUES (
    gen_random_uuid(),
    $1,
    $2,
    $3,
    $4,
    $5,
    $6::uuid,
    now(),
    $7,
    $8::jsonb,
    $9
  )
  ON CONFLICT (workspace_id, temp_id) WHERE temp_id IS NOT NULL
  DO UPDATE SET temp_id = EXCLUDED.temp_id
  RETURNING *, (SELECT u.username FROM users u WHERE u.id = user_id) AS username
  `,
  [
    channelKey,
    userId,
    textHtml || baseText,
    baseText,
    encryptedJson
    ? JSON.stringify(encryptedJson)
    : JSON.stringify({ message: baseText }),
    workspaceId,
    parentId,
    JSON.stringify(safeAttachments),
    tempId || null,          // $9 → temp_id for dedup
  ]
);

    const savedMessage = mapMessageRow(res.rows[0]);

    console.log("🧪 AI TEXT CHECK", {
  fallback: savedMessage.fallback_text,
  encrypted: savedMessage.encrypted_json,
  extracted: extractAIPlainText(savedMessage),
});

    const socketMessage = {
      id: savedMessage.id,
      tempId,
      channelId: channelKey,
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

    // ✅ Emit to all clients IMMEDIATELY — do not wait for AI checks
    emitMessage(socketMessage, workspaceId);

    // -----------------------------
    // AI logic (background only — message already delivered above)
    // -----------------------------
    const isSystemUser = await client.query(
      `SELECT 1 FROM system_users WHERE user_id = $1 LIMIT 1`,
      [userId]
    );

    // 🔐 Resolve user role for AI (admin / manager / member)
let userRole = "member";

try {
  const roleRes = await client.query(
    `
    SELECT role
    FROM workspace_users
    WHERE user_id = $1 AND workspace_id = $2
    LIMIT 1
    `,
    [userId, workspaceId]
  );

  if (roleRes.rows.length > 0) {
    userRole = roleRes.rows[0].role;
  }
} catch (err) {
  console.warn("⚠️ Failed to resolve user role, defaulting to member");
}

    if (isSystemUser.rows.length === 0) {
      // ── Step 1: check workspace AI master switch ──────────────
      const ws = await client.query(
        `SELECT ai_enabled FROM workspace_ai_settings WHERE workspace_id = $1 LIMIT 1`,
        [workspaceId]
      );
      const workspaceAIEnabled =
        ws.rows.length === 0 ? true : ws.rows[0].ai_enabled === true;

      if (workspaceAIEnabled) {
        // ── Step 2: determine whether AI should reply ─────────────
        // For DMs  → check the RECIPIENT's ai_reply_enabled preference
        // For channels → check workspace ai_auto_reply setting
        let aiAllowed = false;
        let recipientId = null;
        let recipientName = null;
        const isDm = channelKey.startsWith("dm:");

        if (isDm) {
          // DM key format: dm:<smallerId>:<largerId>
          const parts = channelKey.split(":");
          const id1 = parts[1];
          const id2 = parts[2];
          recipientId = String(id1) === String(userId) ? id2 : id1;

          // Only trigger if recipient has opted in to AI auto-reply
          const pref = await client.query(
            `SELECT ai_reply_enabled FROM user_preferences WHERE user_id = $1 LIMIT 1`,
            [recipientId]
          );
          aiAllowed = pref.rows.length > 0
            ? pref.rows[0].ai_reply_enabled === true
            : false; // default OFF — users must opt in

          if (aiAllowed) {
            const recRow = await client.query(
              `SELECT username FROM users WHERE id = $1 LIMIT 1`,
              [recipientId]
            );
            recipientName = recRow.rows[0]?.username || null;
          }
        } else {
          // Channel: use workspace-level ai_auto_reply setting
          const wsSettings = await client.query(
            `SELECT ai_auto_reply FROM workspace_ai_settings WHERE workspace_id = $1 LIMIT 1`,
            [workspaceId]
          );
          aiAllowed = wsSettings.rows.length > 0
            ? wsSettings.rows[0].ai_auto_reply === true
            : false; // default OFF
        }

        if (aiAllowed) {
          await ensureWorkspaceAIUser(client, workspaceId);
          postCommit = async () => {
            console.log("🚀 EMITTING TO AI (postCommit)", {
              workspaceId,
              channelKey,
              messageId: savedMessage.id,
              isDm,
              recipientId,
            });

            // Signal to the sender that AI is processing — shows typing indicator
            emitAiTyping(channelKey, workspaceId);

            await emitToAI({
              workspace_id: workspaceId,
              type: "chat:new-message",
              payload: {
                workspace_id: workspaceId,
                channel_key: channelKey,
                message_id: savedMessage.id,
                user_id: savedMessage.user_id,
                user_role: userRole,
                // Recipient context — used by AI to reply "on behalf of" the right person
                is_dm: isDm,
                sender_name: savedMessage.username,
                recipient_id: recipientId,
                recipient_name: recipientName,
                encrypted_json: savedMessage.encrypted_json,
                // Use extractAIPlainText so the AI always receives readable text,
                // even when the message body is an E2E-encrypted JSON envelope.
                fallback_text: extractAIPlainText(savedMessage),
                text_html: savedMessage.text_html,
                created_at: savedMessage.created_at,
              },
            });
          };
        }
      }
    }

    // postCommit is only needed for AI side-effects; message already emitted above
    return savedMessage;
  } finally {
    client.release();

    // 🔥 AI side-effects AFTER DB is safe (message was already emitted above)
    if (postCommit) {
      postCommit().catch(err =>
        console.error("Post-commit side effect failed:", err)
      );
    }
  }
}

/**
 * Create a chat message as AI system user
 * This MUST behave exactly like a normal user message
 */
export async function createAIChatMessage({
  channelKey,
  workspaceId,
  textHtml,
  parentId = null,
}) {
  if (!channelKey) throw new Error("channelKey required");
  if (!workspaceId) throw new Error("workspaceId required");

  const client = await pool.connect();
  try {
    // 1️⃣ Resolve AI system user for workspace
  const aiUser = await ensureWorkspaceAIUser(client, workspaceId);

if (!aiUser?.userId) {
  throw new Error("AI user resolution failed");
}

    // 2️⃣ Insert message as AI user
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
    $6::uuid,
    now(),
    $7
      )
      RETURNING *
      `,
      [
  channelKey,
  aiUser.userId,
  textHtml,
  textHtml, // ✅ fallback_text (plain)
  JSON.stringify({ message: textHtml,
      __from_ai: true }), // ✅ encrypted_json placeholder
  workspaceId,
  parentId,
]);

    const savedMessage = mapMessageRow(res.rows[0]);

    // 3️⃣ Emit via socket (same as normal message)
    emitMessage(
      {
        id: savedMessage.id,
        channelId: channelKey,
        userId: aiUser.userId,
        username: aiUser.username,
        textHtml: savedMessage.text_html,
        createdAt: savedMessage.created_at,
        parentId: savedMessage.parent_id,
        reactions: {},
        attachments: [],
        workspaceId,
        isAiMessage: true, // used by frontend to render the reasoning button regardless of username
      },
      workspaceId
    );

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
  _limit = null,
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
      `,
      [channelKey, workspaceId]
    );

    return res.rows.map(mapMessageRow);
  } finally {
    client.release();
  }
}

export async function getRecentMessagesByChannelKey(
  channelKey,
  _limit = null,
  workspaceId
) {
  if (!workspaceId) return [];

  const client = await pool.connect();
  try {
    // 1️⃣ Resolve channel once (by key + workspace)
    const channel = await getChannelByKey(channelKey, workspaceId);
    if (!channel) return [];

    // 2️⃣ Load all messages — no limit
    const res = await client.query(
  `
  SELECT
    m.*,
    u.username AS username
  FROM chat_messages m
LEFT JOIN users u ON u.id = m.user_id
  WHERE m.channel_key = $1
    AND m.workspace_id = $2
  ORDER BY m.created_at ASC
  `,
  [channelKey, workspaceId]
);

    return res.rows.map(mapMessageRow);
  } finally {
    client.release();
  }
}

/* -------------------------------------------------------
   UPDATE / DELETE / LIST HELPERS (unchanged logic)
------------------------------------------------------- */
export async function updateChatMessage({
  messageId,
  workspaceId,
  textHtml,
  fallbackText,
  encryptedJson,
}) {
  const client = await pool.connect();

  try {
    const safeText = textHtml?.trim();
    if (!safeText) return null;

    const res = await client.query(
      `
      UPDATE chat_messages
      SET
        text_html      = $1,
        fallback_text  = $2,
        encrypted_json = $3,
        updated_at     = now()
      WHERE id = $4
        AND workspace_id = $5
        AND deleted_at IS NULL
      RETURNING *
      `,
      [
        safeText,
        fallbackText ?? safeText,
        encryptedJson
          ? JSON.stringify(encryptedJson)
          : JSON.stringify({ message: safeText }),
        messageId,
        workspaceId,
      ]
    );

    if (!res.rows.length) return null;
    return res.rows[0];
  } finally {
    client.release();
  }
}

export async function updateMessageReactions({
  messageId,
  reactions,
}) {
  const client = await pool.connect();
  try {
    await client.query(
      `
      UPDATE chat_messages
      SET reactions = $1
      WHERE id = $2
      `,
      [reactions, messageId]
    );
  } finally {
    client.release();
  }
}

export async function getChannelMembers(channelId) {
  const { rows } = await pool.query(
    `SELECT m.user_id, u.username
     FROM chat_channel_members m
     JOIN users u ON u.id = m.user_id
     JOIN chat_channels c ON c.id = m.channel_id
     LEFT JOIN workspace_users wu ON wu.user_id = m.user_id AND wu.workspace_id = c.workspace_id
     WHERE m.channel_id = $1
       AND (wu.billing_status IS NULL OR wu.billing_status != 'pending')`,
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

// ─── Unread count tracking ────────────────────────────────────────────────────

// Ensure the table exists (idempotent, runs once at startup)
pool.query(`
  CREATE TABLE IF NOT EXISTS chat_channel_read_status (
    user_id      UUID         NOT NULL,
    channel_key  VARCHAR(500) NOT NULL,
    last_read_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, channel_key)
  );
  CREATE INDEX IF NOT EXISTS idx_ccrs_user ON chat_channel_read_status(user_id);
`).catch((e) => console.warn("[chat] chat_channel_read_status init:", e.message));

export async function markChannelRead(userId, channelKey) {
  await pool.query(
    `INSERT INTO chat_channel_read_status (user_id, channel_key, last_read_at)
     VALUES ($1, $2, now())
     ON CONFLICT (user_id, channel_key)
     DO UPDATE SET last_read_at = now()`,
    [userId, channelKey]
  );
}

export async function getUnreadCounts(userId, workspaceId) {
  // Returns { channelKey: unreadCount } for all channels + DMs this user receives messages in.
  // Public/system channels are included without requiring a membership record.
  // Private channels require membership. DM channels require user to be a participant.
  const { rows } = await pool.query(
    `
    WITH unread_msgs AS (
      SELECT
        m.channel_key,
        COUNT(*) AS cnt
      FROM chat_messages m
      WHERE m.user_id != $1
        AND m.deleted_at IS NULL
        AND m.channel_key != 'availability-updates'
        AND m.created_at > COALESCE(
          (SELECT rs.last_read_at FROM chat_channel_read_status rs
           WHERE rs.user_id = $1 AND rs.channel_key = m.channel_key),
          '1970-01-01'::timestamptz
        )
      GROUP BY m.channel_key
      HAVING COUNT(*) > 0
    )
    SELECT u.channel_key, u.cnt AS unread_count
    FROM unread_msgs u
    WHERE
      -- DM channels: only if this user is a participant
      (u.channel_key LIKE 'dm:%' AND (
        u.channel_key LIKE $2
        OR u.channel_key LIKE $3
      ))
      OR
      -- Non-DM channels: public channels always; private channels only if member
      (u.channel_key NOT LIKE 'dm:%' AND (
        NOT EXISTS (
          SELECT 1 FROM chat_channels c
          WHERE c.key = u.channel_key AND c.is_private = true
        )
        OR EXISTS (
          SELECT 1 FROM chat_channels c
          JOIN chat_channel_members cm ON cm.channel_id = c.id
          WHERE c.key = u.channel_key AND cm.user_id = $1
        )
      ))
    `,
    [userId, `dm:${userId}:%`, `dm:%:${userId}`]
  );
  const result = {};
  for (const row of rows) {
    result[row.channel_key] = parseInt(row.unread_count, 10);
  }
  return result;
}
