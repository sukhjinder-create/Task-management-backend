// services/push.service.js
// Sends Web Push (VAPID) and FCM notifications.
//
// Required env vars:
//   VAPID_PUBLIC_KEY   – generate once with: npx web-push generate-vapid-keys
//   VAPID_PRIVATE_KEY
//   VAPID_EMAIL        – mailto:you@example.com
//
// Optional (Android FCM):
//   FIREBASE_SERVICE_ACCOUNT_JSON – full JSON string of Firebase service account

import pool from "../db.js";

// ─── Web Push (VAPID) ────────────────────────────────────────────────────────

let webpush = null;
let vapidReady = false;

async function initWebPush() {
  if (vapidReady) return;
  try {
    const mod = await import("web-push");
    webpush = mod.default ?? mod;
    const pub  = process.env.VAPID_PUBLIC_KEY;
    const priv = process.env.VAPID_PRIVATE_KEY;
    const email = process.env.VAPID_EMAIL || "mailto:admin@example.com";
    if (pub && priv) {
      webpush.setVapidDetails(email, pub, priv);
      vapidReady = true;
    }
  } catch (e) {
    console.warn("[push] web-push not installed or VAPID keys missing:", e.message);
  }
}

initWebPush();

// ─── Firebase Admin (FCM) ────────────────────────────────────────────────────

let firebaseAdmin = null;
let fcmReady = false;

async function initFirebase() {
  if (fcmReady) return;
  // Support both plain JSON and base64-encoded JSON (FIREBASE_SERVICE_ACCOUNT_B64)
  let raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON || process.env.FIREBASE_SERVICE_ACCOUNT_B64;
  if (!raw) {
    console.warn("[push] Firebase not configured — FCM disabled (set FIREBASE_SERVICE_ACCOUNT_B64 secret)");
    return;
  }
  // Decode base64 if the value doesn't start with '{'
  if (!raw.trim().startsWith("{")) {
    try { raw = Buffer.from(raw.trim(), "base64").toString("utf-8"); } catch (e) {
      console.warn("[push] Firebase base64 decode failed:", e.message);
      return;
    }
  }
  try {
    const { default: admin } = await import("firebase-admin");
    if (!admin.apps.length) {
      const serviceAccount = JSON.parse(raw);
      admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    }
    firebaseAdmin = admin;
    fcmReady = true;
    console.log("[push] Firebase Admin initialized successfully");
  } catch (e) {
    console.warn("[push] firebase-admin not installed or service account invalid:", e.message);
  }
}

initFirebase();

// ─── Token management ─────────────────────────────────────────────────────────

export async function registerPushToken({ userId, platform, endpoint, p256dh, auth, fcmToken, workspaceId }) {
  if (platform === "web") {
    // Delete-then-insert to reliably refresh keys (no race-condition silent failure)
    await pool.query(
      "DELETE FROM user_push_tokens WHERE user_id::text = $1 AND endpoint = $2",
      [String(userId), endpoint]
    );
    await pool.query(
      `INSERT INTO user_push_tokens (user_id, workspace_id, platform, endpoint, keys_p256dh, keys_auth, updated_at)
       VALUES ($1::uuid, $2, 'web', $3, $4, $5, now())`,
      [userId, workspaceId || null, endpoint, p256dh, auth]
    );
    console.log(`[push] web token registered for user ${userId}`);
  } else {
    // Delete any existing row for this user+token, then re-insert fresh
    await pool.query(
      "DELETE FROM user_push_tokens WHERE fcm_token = $1",
      [fcmToken]
    );
    await pool.query(
      `INSERT INTO user_push_tokens (user_id, workspace_id, platform, fcm_token, updated_at)
       VALUES ($1, $2, $3, $4, now())`,
      [userId, workspaceId || null, platform, fcmToken]
    );
    console.log(`[push] FCM token registered user=${userId} platform=${platform} token=${fcmToken?.slice(0, 20)}...`);
  }
}

export async function unregisterPushToken({ userId, endpoint, fcmToken }) {
  if (endpoint) {
    await pool.query(
      "DELETE FROM user_push_tokens WHERE user_id = $1 AND endpoint = $2",
      [userId, endpoint]
    );
  } else if (fcmToken) {
    await pool.query(
      "DELETE FROM user_push_tokens WHERE user_id = $1 AND fcm_token = $2",
      [userId, fcmToken]
    );
  }
}

// ─── Preference management ────────────────────────────────────────────────────

export async function getPreferences(userId) {
  const { rows } = await pool.query(
    "SELECT mute_all, mute_tasks, mute_chat FROM notification_preferences WHERE user_id = $1",
    [userId]
  );
  return rows[0] || { mute_all: false, mute_tasks: false, mute_chat: false };
}

export async function updatePreferences(userId, { mute_all, mute_tasks, mute_chat }) {
  await pool.query(
    `INSERT INTO notification_preferences (user_id, mute_all, mute_tasks, mute_chat, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (user_id)
     DO UPDATE SET mute_all = $2, mute_tasks = $3, mute_chat = $4, updated_at = now()`,
    [userId, !!mute_all, !!mute_tasks, !!mute_chat]
  );
  return getPreferences(userId);
}

// ─── Sending ──────────────────────────────────────────────────────────────────

async function sendWebPushToSubscription(subscription, payload) {
  if (!vapidReady || !webpush) return;
  try {
    await webpush.sendNotification(subscription, JSON.stringify(payload));
  } catch (err) {
    if (err.statusCode === 404 || err.statusCode === 410) {
      // Subscription expired — clean up
      await pool.query(
        "DELETE FROM user_push_tokens WHERE endpoint = $1",
        [subscription.endpoint]
      );
    }
  }
}

async function sendFCMMulticast(tokens, payload) {
  if (!tokens.length || !fcmReady || !firebaseAdmin) return;

  const extraStringified = {};
  if (payload.extraData) {
    for (const [k, v] of Object.entries(payload.extraData)) extraStringified[k] = String(v);
  }
  const message = {
    notification: { title: payload.title, body: payload.body },
    data: { url: payload.url || "/", type: payload.type || "general", ...extraStringified },
    android: {
      priority: "high",
      notification: { channelId: "default", sound: "default", defaultVibrateTimings: true, defaultSound: true },
    },
    apns: {
      headers: { "apns-priority": "10" },
      payload: { aps: { alert: { title: payload.title, body: payload.body }, sound: "default", badge: 1 } },
    },
  };

  // FCM's multicast API caps at 500 tokens per call — chunk larger fan-outs.
  const FCM_BATCH_LIMIT = 500;
  const invalidTokens = [];
  for (let i = 0; i < tokens.length; i += FCM_BATCH_LIMIT) {
    const batch = tokens.slice(i, i + FCM_BATCH_LIMIT);
    try {
      const res = await firebaseAdmin.messaging().sendEachForMulticast({ tokens: batch, ...message });
      res.responses.forEach((r, idx) => {
        if (!r.success && r.error?.code === "messaging/registration-token-not-registered") {
          invalidTokens.push(batch[idx]);
        }
      });
      console.log(`[push] FCM multicast batch: ${res.successCount} ok, ${res.failureCount} failed (of ${batch.length})`);
    } catch (err) {
      console.error("[push] FCM multicast batch error:", err.message);
    }
  }
  if (invalidTokens.length) {
    await pool.query("DELETE FROM user_push_tokens WHERE fcm_token = ANY($1)", [invalidTokens]).catch(() => {});
  }
}

/**
 * Send a push notification to many users at once — the efficient path for
 * channel/group fan-out. Batches preference + token lookups into a single
 * query each (instead of per-user round trips), and sends FCM via the real
 * multicast API (up to 500 devices per HTTP call to Firebase, instead of one
 * call per device). Web Push has no true multicast API, so those still send
 * individually, but only for the (typically much smaller) web-token subset.
 *
 * @param {(string|number)[]} userIds
 * @param {object} opts - same payload shape as sendPushToUser
 */
export async function sendPushToUsers(userIds, { title, body, url = "/", type = "general", extraData = null }) {
  const ids = [...new Set((userIds || []).map(String))].filter(Boolean);
  if (!ids.length) return;

  try {
    const { rows: prefRows } = await pool.query(
      "SELECT user_id::text AS user_id, mute_all, mute_tasks, mute_chat FROM notification_preferences WHERE user_id::text = ANY($1::text[])",
      [ids]
    );
    const prefsByUser = new Map(prefRows.map((r) => [r.user_id, r]));
    const eligible = ids.filter((id) => {
      const p = prefsByUser.get(id);
      if (!p) return true; // no row = defaults (not muted)
      if (p.mute_all) return false;
      if (type === "task" && p.mute_tasks) return false;
      if (type === "chat" && p.mute_chat) return false;
      return true;
    });
    if (!eligible.length) return;

    const { rows: tokenRows } = await pool.query(
      "SELECT user_id::text AS user_id, platform, endpoint, keys_p256dh, keys_auth, fcm_token FROM user_push_tokens WHERE user_id::text = ANY($1::text[])",
      [eligible]
    );

    const payload = { title, body, url, type, extraData };
    const webRows = tokenRows.filter((r) => r.platform === "web" && r.endpoint);
    const fcmTokens = tokenRows
      .filter((r) => (r.platform === "android" || r.platform === "ios") && r.fcm_token)
      .map((r) => r.fcm_token);

    await Promise.allSettled([
      ...webRows.map((row) =>
        sendWebPushToSubscription(
          { endpoint: row.endpoint, keys: { p256dh: row.keys_p256dh, auth: row.keys_auth } },
          payload
        )
      ),
      sendFCMMulticast(fcmTokens, payload),
    ]);
  } catch (err) {
    console.error("[push] sendPushToUsers error:", err.message);
  }
}

/**
 * Send a push notification to all registered devices for a single user.
 * Thin wrapper over sendPushToUsers — prefer sendPushToUsers directly for
 * any fan-out to more than one recipient (channel messages, broadcasts).
 *
 * @param {object} opts
 * @param {number}  opts.userId
 * @param {string}  opts.title
 * @param {string}  opts.body
 * @param {string}  opts.url        - deep link path (e.g. "/projects/123?task=456")
 * @param {string}  opts.type       - 'task' | 'chat' | 'general'
 */
export async function sendPushToUser({ userId, title, body, url = "/", type = "general", extraData = null }) {
  return sendPushToUsers([userId], { title, body, url, type, extraData });
}

export const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || null;
