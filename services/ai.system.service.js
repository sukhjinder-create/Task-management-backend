import pool from "../db.js";

export async function ensureSystemUser(workspaceId) {
  const client = await pool.connect();

  try {
    // 1️⃣ Check if system user already exists in users table
    const existing = await client.query(
      `
      SELECT * FROM users WHERE email = $1 LIMIT 1
      `,
      [`ai+${workspaceId}@example.com`]
    );

    if (existing.rows.length > 0) {
      return existing.rows[0]; // ✅ Return the existing user
    }

    // 2️⃣ Create AI user in the users table only if it doesn't exist
    const uniqueUsername = `AI_System_${workspaceId}`;
    const uniqueEmail = `ai+${workspaceId}@example.com`;

    const userRes = await client.query(
      `
      INSERT INTO users (
        id,
        username,
        email,
        role,
        workspace_id,
        display_name,
        is_system,
        created_at
      )
      VALUES (
        gen_random_uuid(),
        $1,
        $2,
        'system',
        $3,
        'AI Assistant',
        true,
        now()
      )
      RETURNING *
      `,
      [uniqueUsername, uniqueEmail, workspaceId]
    );

    const aiUser = userRes.rows[0];

    // 3️⃣ Insert mapping into system_users table
    await client.query(
      `
      INSERT INTO system_users (
        id,
        workspace_id,
        user_id,
        created_at
      )
      VALUES (
        gen_random_uuid(),
        $1,
        $2,
        now()
      )
      ON CONFLICT (workspace_id) DO NOTHING
      `,
      [workspaceId, aiUser.id]
    );

    return aiUser;
  } finally {
    client.release();
  }
}
