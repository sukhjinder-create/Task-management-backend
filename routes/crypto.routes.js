// routes/crypto.routes.js
import express from "express";
import pool from "../db.js";
import { authMiddleware } from "../middleware/auth.middleware.js";

const router = express.Router();

/**
 * 🔐 AUTO-CREATE TABLES (runs once when this file is loaded)
 * - we also *try* to ensure pgcrypto for gen_random_uuid, but failures are just logged
 */
async function ensureCryptoTables() {
  try {
    // pgcrypto is needed for gen_random_uuid() used in channel_member_keys
    // This may require superuser; if it fails, we just log and continue.
    try {
      await pool.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto";`);
      console.log('[crypto] pgcrypto extension ready (or already exists)');
    } catch (extErr) {
      console.warn(
        "[crypto] Could not create pgcrypto extension (not critical for user_keys):",
        extErr.message
      );
    }

    // 👇 STEP 1: create base table if missing (no timestamps here)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_keys (
        user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        public_key JSONB NOT NULL
      );
    `);

    // 👇 STEP 2: migrate existing table to have created_at / updated_at if missing
    await pool.query(`
      ALTER TABLE user_keys
        ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now(),
        ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();
    `);

    // Table for per-user encrypted channel keys (for future use)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS channel_member_keys (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        channel_id UUID NOT NULL REFERENCES chat_channels(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        encrypted_key TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT now(),
        updated_at TIMESTAMPTZ DEFAULT now(),
        CONSTRAINT channel_member_keys_unique UNIQUE (channel_id, user_id)
      );
    `);

    console.log("[crypto] user_keys & channel_member_keys tables are ready");
  } catch (err) {
    console.error("[crypto] Failed to ensure crypto tables:", err.message);
    console.error(err.stack);
  }
}

// ✅ Fire-and-forget init (no top-level await)
ensureCryptoTables().catch((err) => {
  console.error("[crypto] ensureCryptoTables top-level error:", err.message);
});

/**
 * GET /crypto/public-key
 * -> get current user's public key (if any)
 */
router.get("/public-key", authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT public_key FROM user_keys WHERE user_id = $1 LIMIT 1",
      [req.user.id]
    );
    if (!rows.length) {
      return res.json({ publicKey: null });
    }
    return res.json({ publicKey: rows[0].public_key });
  } catch (err) {
    console.error("GET /crypto/public-key error:", err.message);
    console.error(err.stack);
    return res.status(500).json({ error: "Failed to fetch public key" });
  }
});

/**
 * POST /crypto/public-key
 * body: { publicKey }
 * -> upsert current user's public key
 */
router.post("/public-key", authMiddleware, async (req, res) => {
  try {
    let { publicKey } = req.body;
    if (!publicKey) {
      return res.status(400).json({ error: "publicKey required" });
    }

    // 🧹 Normalize value to valid JSON text for JSONB
    let publicKeyJson;

    if (typeof publicKey === "string") {
      // If it's already JSON text, keep it; otherwise wrap it as JSON
      try {
        JSON.parse(publicKey); // just to validate
        publicKeyJson = publicKey;
      } catch {
        publicKeyJson = JSON.stringify(publicKey);
      }
    } else {
      // Object -> JSON string
      publicKeyJson = JSON.stringify(publicKey);
    }

    await pool.query(
      `
        INSERT INTO user_keys (user_id, public_key)
        VALUES ($1, $2::jsonb)
        ON CONFLICT (user_id)
        DO UPDATE SET public_key = EXCLUDED.public_key,
                      updated_at = now()
      `,
      [req.user.id, publicKeyJson]
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error("POST /crypto/public-key error:", err.message);
    console.error(err.stack);
    return res.status(500).json({ error: "Failed to store public key" });
  }
});

/**
 * GET /crypto/public-keys
 * -> public keys for all users
 */
router.get("/public-keys", authMiddleware, async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `
        SELECT u.id AS user_id, u.username, k.public_key
        FROM users u
        LEFT JOIN user_keys k ON k.user_id = u.id
      `
    );

    return res.json(
      rows.map((r) => ({
        userId: r.user_id,
        username: r.username,
        publicKey: r.public_key || null,
      }))
    );
  } catch (err) {
    console.error("GET /crypto/public-keys error:", err.message);
    console.error(err.stack);
    return res.status(500).json({ error: "Failed to fetch public keys" });
  }
});

/**
 * GET /crypto/channel-keys/:channelId
 * -> encrypted channel key for current user (if exists)
 */
router.get("/channel-keys/:channelId", authMiddleware, async (req, res) => {
  try {
    const { channelId } = req.params;

    const { rows } = await pool.query(
      `
        SELECT encrypted_key
        FROM channel_member_keys
        WHERE channel_id = $1 AND user_id = $2
        LIMIT 1
      `,
      [channelId, req.user.id]
    );

    if (!rows.length) {
      return res.json({ encryptedKey: null });
    }
    return res.json({ encryptedKey: rows[0].encrypted_key });
  } catch (err) {
    console.error("GET /crypto/channel-keys/:channelId error:", err.message);
    console.error(err.stack);
    return res.status(500).json({ error: "Failed to fetch channel key" });
  }
});

/**
 * POST /crypto/channel-keys/:channelId
 * body: { encryptedKey }
 * -> store encrypted channel symmetric key for current user
 */
router.post("/channel-keys/:channelId", authMiddleware, async (req, res) => {
  try {
    const { channelId } = req.params;
    const { encryptedKey } = req.body;

    if (!encryptedKey) {
      return res.status(400).json({ error: "encryptedKey required" });
    }

    await pool.query(
      `
        INSERT INTO channel_member_keys (channel_id, user_id, encrypted_key)
        VALUES ($1, $2, $3)
        ON CONFLICT (channel_id, user_id)
        DO UPDATE SET encrypted_key = EXCLUDED.encrypted_key,
                      updated_at = now()
      `,
      [channelId, req.user.id, encryptedKey]
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error("POST /crypto/channel-keys/:channelId error:", err.message);
    console.error(err.stack);
    return res.status(500).json({ error: "Failed to store channel key" });
  }
});

export default router;
