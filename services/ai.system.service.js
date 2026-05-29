import pool from "../db.js";

const SYSTEM_USERNAME = "Autopilot";

function stableSystemUsername(workspaceId) {
  return `${SYSTEM_USERNAME}-${String(workspaceId || "global")}`;
}

async function hasGlobalUsernameConstraint(db) {
  const { rows } = await db.query(
    `SELECT 1
     FROM pg_constraint
     WHERE conrelid = 'users'::regclass
       AND conname = 'users_username_key'
       AND contype = 'u'
     LIMIT 1`
  );
  return rows.length > 0;
}

async function chooseSystemUsername(db, workspaceId, currentUserId = null) {
  const hasGlobalConstraint = await hasGlobalUsernameConstraint(db);
  const query = hasGlobalConstraint
    ? {
        text: `SELECT id
               FROM users
               WHERE username = $1
                 AND ($2::uuid IS NULL OR id <> $2::uuid)
               LIMIT 1`,
        values: [SYSTEM_USERNAME, currentUserId],
      }
    : {
        text: `SELECT id
               FROM users
               WHERE username = $1
                 AND workspace_id = $2::uuid
                 AND ($3::uuid IS NULL OR id <> $3::uuid)
               LIMIT 1`,
        values: [SYSTEM_USERNAME, workspaceId, currentUserId],
      };

  const { rows } = await db.query(query.text, query.values);

  return rows.length > 0 ? stableSystemUsername(workspaceId) : SYSTEM_USERNAME;
}

async function insertSystemUser(db, workspaceId, email) {
  const username = await chooseSystemUsername(db, workspaceId);
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

  return res.rows[0];
}

async function updateSystemUsername(db, userId, workspaceId) {
  const username = await chooseSystemUsername(db, workspaceId, userId);
  await db.query(
    `UPDATE users SET username = $1 WHERE id = $2 AND username != $1`,
    [username, userId]
  );
  return username;
}

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

    // 1️⃣ Find existing AI user
    let { rows } = await db.query(
      `SELECT * FROM users WHERE email = $1 LIMIT 1`,
      [email]
    );

    let aiUser = rows[0];

    // 2️⃣ Create if missing
    if (!aiUser) {
      aiUser = await insertSystemUser(db, workspaceId, email);
    } else if (aiUser.username !== SYSTEM_USERNAME) {
      // Prefer the clean display name once the DB supports workspace-scoped usernames.
      const username = await updateSystemUsername(db, aiUser.id, workspaceId);
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
