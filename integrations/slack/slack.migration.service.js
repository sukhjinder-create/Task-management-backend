import axios from "axios";
import pool from "../../db.js";
import bcrypt from "bcrypt";
import { getUserByEmail, createUserRepo, addUserToWorkspaceRepo } from "../../repositories/user.repository.js";
import { getChannelByKey, createChannel } from "../../services/chat.service.js";
import { finalizeMigrationImport } from "../../services/migrationHistory.service.js";

const SLACK_API = "https://slack.com/api";

/* ─────────────────────────────────────────────
   LOW-LEVEL SLACK HELPERS
───────────────────────────────────────────── */
async function slackGet(method, token, params = {}) {
  const res = await axios.get(`${SLACK_API}/${method}`, {
    headers: { Authorization: `Bearer ${token}` },
    params,
  });
  if (!res.data.ok) throw new Error(`Slack API error (${method}): ${res.data.error}`);
  return res.data;
}

async function slackPost(method, token, data = {}) {
  const res = await axios.post(`${SLACK_API}/${method}`, data, {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  return res.data; // caller checks .ok
}

/** Convert Slack mrkdwn to basic HTML */
function mrkdwnToHtml(text, mentionMap = {}) {
  if (!text) return "<p></p>";
  let html = text
    .replace(/<@([A-Z0-9]+)(?:\|([^>]+))?>/g, (_, uid, name) => {
      const resolved = mentionMap[uid] || name || uid;
      return `<span class="mention">@${resolved}</span>`;
    })
    .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, '<a href="$1">$2</a>')
    .replace(/<(https?:\/\/[^>]+)>/g, '<a href="$1">$1</a>')
    .replace(/<!channel>/g, '<span class="mention">@channel</span>')
    .replace(/<!here>/g, '<span class="mention">@here</span>')
    .replace(/\*([^*\n]+)\*/g, "<strong>$1</strong>")
    .replace(/_([^_\n]+)_/g, "<em>$1</em>")
    .replace(/~([^~\n]+)~/g, "<s>$1</s>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\n/g, "<br>");
  return `<p>${html}</p>`;
}

/* ─────────────────────────────────────────────
   BATCH INSERT messages — much faster than one-by-one
───────────────────────────────────────────── */
async function batchInsertMessages(rows) {
  if (!rows.length) return 0;
  // rows: [{ channelKey, senderId, textHtml, fallbackText, workspaceId, createdAt }]
  const CHUNK = 100;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const values = [];
    const params = [];
    let p = 1;
    for (const r of chunk) {
      values.push(`(gen_random_uuid(), $${p++}, $${p++}, $${p++}, $${p++}, $${p++}::uuid, $${p++}, '{}'::jsonb, '[]'::jsonb)`);
      params.push(r.channelKey, r.senderId, r.textHtml, r.fallbackText, r.workspaceId, r.createdAt);
    }
    try {
      await pool.query(
        `INSERT INTO chat_messages (id, channel_key, user_id, text_html, fallback_text, workspace_id, created_at, reactions, attachments)
         VALUES ${values.join(",")}
         ON CONFLICT DO NOTHING`,
        params
      );
      inserted += chunk.length;
    } catch (e) {
      // fall back to one-by-one on batch error
      for (const r of chunk) {
        try {
          await pool.query(
            `INSERT INTO chat_messages (id, channel_key, user_id, text_html, fallback_text, workspace_id, created_at, reactions, attachments)
             VALUES (gen_random_uuid(), $1, $2, $3, $4, $5::uuid, $6, '{}'::jsonb, '[]'::jsonb)
             ON CONFLICT DO NOTHING`,
            [r.channelKey, r.senderId, r.textHtml, r.fallbackText, r.workspaceId, r.createdAt]
          );
          inserted++;
        } catch (_) { /* skip individual failures */ }
      }
    }
  }
  return inserted;
}

/* ─────────────────────────────────────────────
   VALIDATE TOKEN — preview only, no DB writes
───────────────────────────────────────────── */
export async function validateSlackToken(token) {
  const auth = await slackGet("auth.test", token);

  const usersRes = await slackGet("users.list", token, { limit: 200 });
  const realUsers = (usersRes.members || []).filter(
    (u) => !u.deleted && !u.is_bot && u.id !== "USLACKBOT"
  );

  // Paginate conversations.list to get ALL channels (not just first 200)
  let allChannels = [];
  let channelCursor;
  do {
    const params = { types: "public_channel", limit: 200, exclude_archived: false };
    if (channelCursor) params.cursor = channelCursor;
    const channelsRes = await slackGet("conversations.list", token, params);
    allChannels.push(...(channelsRes.channels || []));
    channelCursor = channelsRes.response_metadata?.next_cursor || null;
  } while (channelCursor);
  const channels = allChannels;

  // Test if conversations.history actually works — catches "missing_scope" early
  // Prefer a channel the user is already a member of for the test
  let historyAccess = { ok: false, error: null, sampleCount: 0 };
  if (channels.length > 0) {
    const memberChannel = channels.find((c) => c.is_member) || channels[0];
    try {
      const testRes = await slackGet("conversations.history", token, {
        channel: memberChannel.id,
        limit: 5,
      });
      historyAccess = { ok: true, error: null, sampleCount: (testRes.messages || []).length };
    } catch (e) {
      const raw = e.message || "";
      const match = raw.match(/Slack API error \([^)]+\): (.+)/);
      historyAccess = { ok: false, error: match ? match[1] : raw };
    }
  }

  // Group channels by prefix (first word before - or _)
  const grouped = {};
  for (const c of channels) {
    const prefix = c.name.split(/[-_]/)[0] || "general";
    if (!grouped[prefix]) grouped[prefix] = [];
    grouped[prefix].push({
      id: c.id,
      name: c.name,
      memberCount: c.num_members || 0,
      isArchived: c.is_archived || false,
      isMember: c.is_member === true,
      topic: c.topic?.value || "",
      purpose: c.purpose?.value || "",
    });
  }

  return {
    teamName: auth.team,
    teamId: auth.team_id,
    botUser: auth.user,
    userCount: realUsers.length,
    channelCount: channels.length,
    historyAccess,
    channels: channels.map((c) => ({
      id: c.id,
      name: c.name,
      memberCount: c.num_members || 0,
      isArchived: c.is_archived || false,
      isMember: c.is_member === true,
      topic: c.topic?.value || "",
      purpose: c.purpose?.value || "",
    })),
    channelGroups: grouped,
  };
}

/* ─────────────────────────────────────────────
   MAIN MIGRATION
   runId: pre-created migration_imports row (status='running')
───────────────────────────────────────────── */
export async function migrateSlackWorkspace({
  token,
  workspaceId,
  triggeredBy,
  selectedChannelIds = null,
  mode = "skip",      // "skip" | "replace"
  autoJoin = false,   // if true, join non-member channels (posts a visible join message in Slack)
  runId = null,
  onProgress = null,
}) {
  const log = (step, msg) => {
    console.log(`[Slack Migration] [${step}] ${msg}`);
    if (onProgress) onProgress(step, msg);
  };

  const result = {
    usersCreated: 0,
    usersLinked: 0,
    channelsCreated: 0,
    messagesImported: 0,
    errors: [],
  };

  // Track what we create for history/deletion
  const createdChannelKeys = [];
  const createdUserIds = [];

  try {
    /* ── STEP 1: Auth ── */
    log("auth", "Validating Slack token…");
    await slackGet("auth.test", token);

    /* ── STEP 2: Users ── */
    log("users", "Fetching Slack users…");
    const usersRes = await slackGet("users.list", token, { limit: 200 });
    const slackMembers = (usersRes.members || []).filter(
      (u) => !u.deleted && !u.is_bot && u.id !== "USLACKBOT"
    );

    const userMap = {}; // slackId → { internalId, username }

    for (const su of slackMembers) {
      const email = su.profile?.email;
      const displayName = su.profile?.display_name || su.profile?.real_name || su.name;
      if (!email) continue;

      try {
        const existing = await getUserByEmail(email);
        if (existing) {
          await addUserToWorkspaceRepo(existing.id, workspaceId);
          userMap[su.id] = { internalId: existing.id, username: existing.username };
          result.usersLinked++;
        } else {
          const randomPassword = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
          const password_hash = await bcrypt.hash(randomPassword, 10);

          let username = displayName;
          let newUser = null;
          for (let attempt = 0; attempt < 5; attempt++) {
            try {
              newUser = await createUserRepo({
                username,
                email,
                password_hash,
                role: "member",
                added_by: triggeredBy,
                projects: [],
                workspace_id: workspaceId,
              });
              break;
            } catch (e) {
              if (e.message?.includes("unique constraint") || e.message?.includes("duplicate key")) {
                username = `${displayName}_${Math.random().toString(36).slice(2, 6)}`;
              } else {
                throw e;
              }
            }
          }
          if (!newUser) throw new Error(`Could not create user ${email} after 5 attempts`);

          await addUserToWorkspaceRepo(newUser.id, workspaceId);

          const avatarUrl = su.profile?.image_512 || su.profile?.image_192 || null;
          if (avatarUrl) {
            try {
              await pool.query(`UPDATE users SET avatar_url = $1 WHERE id = $2`, [avatarUrl, newUser.id]);
            } catch (_) { /* non-fatal */ }
          }

          userMap[su.id] = { internalId: newUser.id, username };
          createdUserIds.push(newUser.id);
          result.usersCreated++;
          log("users", `Created: ${email}`);
        }
      } catch (e) {
        result.errors.push(`User ${email}: ${e.message}`);
      }
    }

    const mentionMap = {};
    for (const [slackId, info] of Object.entries(userMap)) {
      mentionMap[slackId] = info.username;
    }

    /* ── STEP 3: Channels — paginated to get ALL ── */
    log("channels", "Fetching channels…");
    let allMigrationChannels = [];
    let migrationChannelCursor;
    do {
      const params = { types: "public_channel", limit: 200, exclude_archived: false };
      if (migrationChannelCursor) params.cursor = migrationChannelCursor;
      const channelsRes = await slackGet("conversations.list", token, params);
      allMigrationChannels.push(...(channelsRes.channels || []));
      migrationChannelCursor = channelsRes.response_metadata?.next_cursor || null;
    } while (migrationChannelCursor);

    let channels = allMigrationChannels;
    if (selectedChannelIds?.length) {
      channels = channels.filter((c) => selectedChannelIds.includes(c.id));
    }
    log("channels", `Found ${channels.length} channels to process`);

    /* ── STEP 4: Messages per channel ── */
    const isUserToken = token.startsWith("xoxp-");

    for (const sc of channels) {
      const channelKey = `slack-${sc.name}`;
      log("channels", `Processing #${sc.name}…`);

      try {
        // Create channel in our DB
        let channel = await getChannelByKey(channelKey, workspaceId);
        if (!channel) {
          channel = await createChannel({
            key: channelKey,
            name: `#${sc.name}`,
            type: "channel",
            createdBy: triggeredBy,
            isPrivate: false,
            workspaceId,
          });
          result.channelsCreated++;
          createdChannelKeys.push(channelKey);
        }

        // Replace mode: wipe existing messages in this channel first
        if (mode === "replace" && channel) {
          await pool.query(
            `DELETE FROM chat_messages WHERE channel_key = $1 AND workspace_id = $2`,
            [channelKey, workspaceId]
          );
          log("channels", `#${sc.name}: cleared existing messages for replace`);
        }

        // For non-member channels: try auto-join if enabled, otherwise attempt history anyway
        // (is_member field from Slack API is not always reliable)
        const isMember = sc.is_member === true;
        if (!isMember && autoJoin) {
          const joinRes = await slackPost("conversations.join", token, { channel: sc.id });
          if (!joinRes.ok) {
            const joinErr = joinRes.error || "unknown";
            if (joinErr === "missing_scope") {
              result.errors.push(`#${sc.name}: skipped — add channels:join to User Token Scopes`);
              continue;
            } else if (joinErr !== "already_in_channel") {
              result.errors.push(`#${sc.name}: skipped — could not join: ${joinErr}`);
              continue;
            }
          }
        }

        // Fetch ALL messages (paginated), collect into buffer, then batch insert
        // If we get not_in_channel, skip gracefully (don't treat as fatal)
        let cursor = undefined;
        const messageBuffer = [];
        let historyFailed = false;

        do {
          const params = { channel: sc.id, limit: 200 };
          if (cursor) params.cursor = cursor;

          let msgRes;
          try {
            msgRes = await slackGet("conversations.history", token, params);
          } catch (histErr) {
            const raw = histErr.message || "";
            const match = raw.match(/Slack API error \([^)]+\): (.+)/);
            const slackErr = match ? match[1] : raw;
            if (slackErr === "not_in_channel") {
              log("channels", `#${sc.name}: skipped — not a member`);
              result.errors.push(`#${sc.name}: skipped (not a member — join in Slack first, or enable auto-join)`);
            } else {
              result.errors.push(`#${sc.name}: history fetch failed — ${slackErr}`);
            }
            historyFailed = true;
            break;
          }
          const messages = msgRes.messages || [];

          for (const msg of messages) {
            if (msg.subtype || msg.bot_id) continue;
            if (!msg.text && !msg.files) continue;

            messageBuffer.push({
              channelKey,
              senderId: userMap[msg.user]?.internalId || triggeredBy,
              textHtml: mrkdwnToHtml(msg.text || "", mentionMap),
              fallbackText: msg.text || "",
              workspaceId,
              createdAt: msg.ts
                ? new Date(parseFloat(msg.ts) * 1000).toISOString()
                : new Date().toISOString(),
            });
          }

          cursor = msgRes.response_metadata?.next_cursor;
        } while (cursor);

        if (historyFailed) continue;

        // Batch insert all messages for this channel at once
        const count = await batchInsertMessages(messageBuffer);
        result.messagesImported += count;
        log("channels", `#${sc.name}: ${count} messages imported`);
      } catch (e) {
        result.errors.push(`Channel #${sc.name}: ${e.message}`);
        log("channels", `Error on #${sc.name}: ${e.message}`);
      }
    }

    log("done", `Complete. Users: ${result.usersCreated}+${result.usersLinked}. Channels: ${result.channelsCreated}. Messages: ${result.messagesImported}.`);
  } catch (fatalErr) {
    log("error", `Fatal error: ${fatalErr.message}`);
    result.errors.push(`Fatal: ${fatalErr.message}`);

    if (runId) {
      await finalizeMigrationImport(runId, {
        stats: result,
        metadata: { channelKeys: createdChannelKeys, createdUserIds },
        status: "failed",
      }).catch(() => {});
    }
    throw fatalErr;
  }

  /* ── Finalize history record ── */
  if (runId) {
    await finalizeMigrationImport(runId, {
      stats: result,
      metadata: { channelKeys: createdChannelKeys, createdUserIds },
      status: "completed",
    }).catch(() => {});
  }

  return {
    ...result,
    importId: runId,
  };
}
