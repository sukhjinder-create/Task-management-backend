// services/crypto.service.js
import pool from "../db.js";

/**
 * ----- PER-USER PUBLIC KEY HELPERS -----
 */

/**
 * Get the stored public key for a given user (or null if none).
 */
export async function getPublicKeyForUser(userId) {
  const { rows } = await pool.query(
    "SELECT public_key FROM user_keys WHERE user_id = $1 LIMIT 1",
    [userId]
  );
  if (!rows.length) return null;
  return rows[0].public_key;
}

/**
 * Insert or update the public key for a given user.
 */
export async function upsertPublicKeyForUser(userId, publicKey) {
  await pool.query(
    `
      INSERT INTO user_keys (user_id, public_key)
      VALUES ($1, $2)
      ON CONFLICT (user_id)
      DO UPDATE SET public_key = EXCLUDED.public_key
    `,
    [userId, publicKey]
  );
}

/**
 * Get public keys for all users (used when encrypting for everyone).
 */
export async function getAllUserPublicKeys() {
  const { rows } = await pool.query(
    `
      SELECT u.id AS user_id, u.username, k.public_key
      FROM users u
      LEFT JOIN user_keys k ON k.user_id = u.id
    `
  );

  return rows.map((r) => ({
    userId: r.user_id,
    username: r.username,
    publicKey: r.public_key || null,
  }));
}

/**
 * ----- PER-USER CHANNEL KEY HELPERS -----
 * These are for storing a symmetric channel key encrypted for each user.
 * (We added the tables/endpoints already, even if you’re not fully using them yet.)
 */

/**
 * Get the encrypted channel key for a given user in a channel (or null).
 */
export async function getEncryptedChannelKeyForUser(channelId, userId) {
  const { rows } = await pool.query(
    `
      SELECT encrypted_key
      FROM channel_member_keys
      WHERE channel_id = $1 AND user_id = $2
      LIMIT 1
    `,
    [channelId, userId]
  );
  if (!rows.length) return null;
  return rows[0].encrypted_key;
}

/**
 * Insert or update the encrypted channel key for a given user in a channel.
 */
export async function upsertEncryptedChannelKeyForUser(
  channelId,
  userId,
  encryptedKey
) {
  await pool.query(
    `
      INSERT INTO channel_member_keys (channel_id, user_id, encrypted_key)
      VALUES ($1, $2, $3)
      ON CONFLICT (channel_id, user_id)
      DO UPDATE SET encrypted_key = EXCLUDED.encrypted_key
    `,
    [channelId, userId, encryptedKey]
  );
}

/**
 * Optional default export if you prefer object-style imports.
 */
export default {
  getPublicKeyForUser,
  upsertPublicKeyForUser,
  getAllUserPublicKeys,
  getEncryptedChannelKeyForUser,
  upsertEncryptedChannelKeyForUser,
};
