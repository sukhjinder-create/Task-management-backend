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
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) return;
  try {
    const { default: admin } = await import("firebase-admin");
    if (!admin.apps.length) {
      const serviceAccount = JSON.parse(raw);
      admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    }
    firebaseAdmin = admin;
    fcmReady = true;
  } catch (e) {
    console.warn("[push] firebase-admin not installed or service account invalid:", e.message);
  }
}

initFirebase();

// ─── Token management ─────────────────────────────────────────────────────────

export async function registerPushToken({ userId, platform, endpoint, p256dh, auth, fcmToken, workspaceId }) {
  if (platform === "web") {
    await pool.query(
      `INSERT INTO user_push_tokens (user_id, workspace_id, platform, endpoint, keys_p256dh, keys_auth, updated_at)
       VALUES ($1, $2, 'web', $3, $4, $5, now())
       ON CONFLICT (endpoint) DO UPDATE
         SET user_id = $1, workspace_id = $2, keys_p256dh = $4, keys_auth = $5, updated_at = now()`,
      [userId, workspaceId || null, endpoint, p256dh, auth]
    );
    console.log(`[push] web token registered for user ${userId}`);
  } else {
    // Upsert by fcm_token — one row per device token, always up to date
    await pool.query(
      `INSERT INTO user_push_tokens (user_id, workspace_id, platform, fcm_token, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (fcm_token) DO UPDATE
         SET user_id = $1, workspace_id = $2, platform = $3, updated_at = now()`,
      [userId, workspaceId || null, platform, fcmToken]
    );
    console.log(`[push] FCM token registered for user ${userId} platform=${platform} token=${fcmToken?.slice(0, 20)}...`);
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

async function sendFCMNotification(fcmToken, payload) {
  if (!fcmReady || !firebaseAdmin) {
    console.warn("[push] FCM not ready — skipping. fcmReady:", fcmReady);
    return;
  }
  try {
    const extraStringified = {};
    if (payload.extraData) {
      for (const [k, v] of Object.entries(payload.extraData)) {
        extraStringified[k] = String(v);
      }
    }
    const channelId = payload.type === "chat" ? "chat" : payload.type === "huddle" ? "huddle" : "tasks";
    await firebaseAdmin.messaging().send({
      token: fcmToken,
      notification: { title: payload.title, body: payload.body },
      data: {
        url:  payload.url  || "/",
        type: payload.type || "general",
        ...extraStringified,
      },
      android: {
        priority: "high",
        notification: {
          channelId,
          sound: "default",
          defaultVibrateTimings: true,
          defaultSound: true,
        },
      },
    });
  } catch (err) {
    if (err.code === "messaging/registration-token-not-registered") {
      console.warn("[push] FCM token expired, removing:", fcmToken?.slice(0, 20));
      await pool.query(
        "DELETE FROM user_push_tokens WHERE fcm_token = $1",
        [fcmToken]
      );
    } else {
      console.error("[push] FCM send error:", err.code || err.message, "token:", fcmToken?.slice(0, 20));
    }
  }
}

/**
 * Send a push notification to all registered devices for a user.
 * Respects mute preferences.
 *
 * @param {object} opts
 * @param {number}  opts.userId
 * @param {string}  opts.title
 * @param {string}  opts.body
 * @param {string}  opts.url        - deep link path (e.g. "/projects/123?task=456")
 * @param {string}  opts.type       - 'task' | 'chat' | 'general'
 */
export async function sendPushToUser({ userId, title, body, url = "/", type = "general", extraData = null }) {
  try {
    // Check preferences
    const prefs = await getPreferences(userId);
    if (prefs.mute_all) return;
    if (type === "task" && prefs.mute_tasks) return;
    if (type === "chat" && prefs.mute_chat) return;

    // Fetch all tokens
    const { rows } = await pool.query(
      "SELECT platform, endpoint, keys_p256dh, keys_auth, fcm_token FROM user_push_tokens WHERE user_id = $1",
      [userId]
    );

    const payload = { title, body, url, type, extraData };

    await Promise.allSettled(
      rows.map((row) => {
        if (row.platform === "web" && row.endpoint) {
          return sendWebPushToSubscription(
            { endpoint: row.endpoint, keys: { p256dh: row.keys_p256dh, auth: row.keys_auth } },
            payload
          );
        }
        if ((row.platform === "android" || row.platform === "ios") && row.fcm_token) {
          return sendFCMNotification(row.fcm_token, payload);
        }
        return Promise.resolve();
      })
    );
  } catch (err) {
    console.error("[push] sendPushToUser error:", err.message);
  }
}

export const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || null;
