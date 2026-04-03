import pool from "../db.js";

/**
 * Ensure exactly ONE system (AI) user per workspace.
 * Safe to call multiple times.
 * Safe inside or outside a transaction.
 */
export async function ensureSystemUser(workspaceId, client = null) {
  const db = client || (await pool.connect());
  const release = !client;

  try {
    const email = `ai+${workspaceId}@example.com`;
    const username = `Autopilot`;

    // 1️⃣ Find existing AI user
    let { rows } = await db.query(
      `SELECT * FROM users WHERE email = $1 LIMIT 1`,
      [email]
    );

    let aiUser = rows[0];

    // 2️⃣ Create if missing
    if (!aiUser) {
      const res = await db.query(
        `
        INSERT INTO users (
          id,
          username,
          email,
          role,
          workspace_id,
          is_system,
          created_at
        )
        VALUES (
          gen_random_uuid(),
          $1,
          $2,
          'system',
          $3,
          true,
          now()
        )
        RETURNING *
        `,
        [username, email, workspaceId]
      );

      aiUser = res.rows[0];
    } else if (aiUser.username !== username) {
      // Migrate old "AI_System_<uuid>" display name to clean "Autopilot"
      await db.query(
        `UPDATE users SET username = $1 WHERE id = $2`,
        [username, aiUser.id]
      );
      aiUser = { ...aiUser, username };
    }

    // 3️⃣ Ensure mapping ALWAYS exists
    await db.query(
      `INSERT INTO system_users (workspace_id, user_id)
       VALUES ($1, $2)
       ON CONFLICT (workspace_id) DO NOTHING`,
      [workspaceId, aiUser.id]
    );

    return aiUser;
  } finally {
    if (release) db.release();
  }
}
