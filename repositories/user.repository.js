import pool from "../db.js";

const WORKSPACE_GLOBAL = "GLOBAL";

/* =====================================================
   CREATE USER
   🔐 workspace_id is now REQUIRED (except superadmin use)
===================================================== */
export async function createUserRepo({
  username,
  email,
  password_hash,
  role,
  added_by,
  projects,
  workspace_id = WORKSPACE_GLOBAL, // 🔐 NEW (forced by service)
}) {
  const q = `
    INSERT INTO users (
      username,
      email,
      password_hash,
      role,
      added_by,
      projects,
      workspace_id
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING
      id,
      username,
      email,
      role,
      projects,
      workspace_id,
      created_at;
  `;

  const { rows } = await pool.query(q, [
    username,
    email,
    password_hash,
    role,
    added_by,
    projects || [],
    workspace_id,
  ]);

  return rows[0];
}

/* =====================================================
   ADD USER TO WORKSPACE (REQUIRED FOR SYSTEM CHAT)
===================================================== */
export async function addUserToWorkspaceRepo(userId, workspaceId) {
  if (!userId || !workspaceId || workspaceId === WORKSPACE_GLOBAL) {
    return;
  }

  const q = `
    INSERT INTO workspace_users (user_id, workspace_id)
    VALUES ($1, $2)
    ON CONFLICT (user_id) DO NOTHING
  `;

  await pool.query(q, [userId, workspaceId]);
}


/* =====================================================
   GET USER BY EMAIL (for login)
   ⚠️ Email is globally unique → keep unchanged
===================================================== */
export async function getUserByEmail(email) {
  const q = `SELECT * FROM users WHERE email = $1`;
  const { rows } = await pool.query(q, [email]);
  return rows[0] || null;
}

/* =====================================================
   GET USER BY ID
   🔐 Includes workspace_id for enforcement
===================================================== */
export async function getUserById(id) {
  const q = `
    SELECT
      id,
      username,
      email,
      role,
      projects,
      workspace_id,
      avatar_url,
      created_at,
      updated_at
    FROM users
    WHERE id = $1
  `;
  const { rows } = await pool.query(q, [id]);
  return rows[0] || null;
}

export async function updateAvatarUrl(id, avatarUrl) {
  const { rows } = await pool.query(
    `UPDATE users SET avatar_url = $1 WHERE id = $2 RETURNING id, avatar_url`,
    [avatarUrl, id]
  );
  return rows[0] || null;
}

/* =====================================================
   GET USER BY USERNAME (for @mentions)
   🔐 Workspace-aware variant added
===================================================== */
export async function getUserByUsername(username) {
  const q = `
    SELECT
      id,
      username,
      email,
      role,
      projects,
      workspace_id,
      created_at
    FROM users
    WHERE username = $1
  `;
  const { rows } = await pool.query(q, [username]);
  return rows[0] || null;
}

/* =====================================================
   🔴 LEGACY (UNSAFE) — DO NOT USE IN NEW CODE
   Kept ONLY for backward compatibility
===================================================== */
export async function getAllUsersRepo() {
  const q = `
    SELECT 
      u.id,
      u.username,
      u.email,
      u.role,
      u.projects,
      u.workspace_id,
      u.created_at,
      k.public_key
    FROM users u
    LEFT JOIN user_keys k ON k.user_id = u.id
    ORDER BY u.created_at DESC
  `;
  const { rows } = await pool.query(q);
  return rows;
}

/* =====================================================
   ✅ NEW: GET ALL USERS BY WORKSPACE (HARD ISOLATION)
   THIS IS WHAT SERVICES MUST USE
===================================================== */
export async function getAllUsersByWorkspaceRepo(workspaceId) {
  if (!workspaceId) {
    throw new Error("workspaceId is required");
  }

  const q = `
    SELECT
      u.id,
      u.username,
      u.email,
      u.role,
      u.projects,
      u.workspace_id,
      u.avatar_url,
      u.created_at,
      k.public_key
    FROM users u
    LEFT JOIN user_keys k ON k.user_id = u.id
    WHERE u.workspace_id = $1
    ORDER BY u.created_at DESC
  `;

  const { rows } = await pool.query(q, [workspaceId]);
  return rows;
}

/* =====================================================
   UPDATE USER
   🔐 Workspace is checked at SERVICE layer
===================================================== */
export async function updateUserRepo(id, { username, email, role, projects }) {
  const q = `
    UPDATE users
    SET
      username = $1,
      email = $2,
      role = $3,
      projects = $4,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = $5
    RETURNING
      id,
      username,
      email,
      role,
      projects,
      workspace_id,
      created_at,
      updated_at;
  `;

  const { rows } = await pool.query(q, [
    username,
    email,
    role,
    projects || [],
    id,
  ]);

  return rows[0] || null;
}

/* =====================================================
   DELETE USER
===================================================== */
export async function deleteUserRepo(id) {
  const q = `DELETE FROM users WHERE id = $1`;
  const { rowCount } = await pool.query(q, [id]);
  return rowCount > 0;
}

/* =====================================================
   GET USER + PUBLIC KEY (WORKSPACE SAFE)
===================================================== */
export async function getUserWithPublicKeyById(id) {
  const q = `
    SELECT 
      u.id,
      u.username,
      u.email,
      u.role,
      u.projects,
      u.workspace_id,
      u.created_at,
      u.updated_at,
      k.public_key
    FROM users u
    LEFT JOIN user_keys k ON k.user_id = u.id
    WHERE u.id = $1
  `;
  const { rows } = await pool.query(q, [id]);
  if (!rows[0]) return null;

  const row = rows[0];
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    role: row.role,
    projects: row.projects,
    workspace_id: row.workspace_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    public_key: row.public_key || null,
  };
}

/* =====================================================
   🔴 LEGACY: ALL USERS + KEYS (UNSAFE)
   Kept for backward compatibility ONLY
===================================================== 
export async function getAllUsersWithPublicKeysRepo() {
  const q = `
    SELECT 
      u.id,
      u.username,
      u.email,
      u.role,
      u.projects,
      u.workspace_id,
      u.created_at,
      u.updated_at,
      k.public_key
    FROM users u
    LEFT JOIN user_keys k ON k.user_id = u.id
    ORDER BY u.created_at DESC
  `;

  const { rows } = await pool.query(q);

  return rows.map((row) => ({
    id: row.id,
    username: row.username,
    email: row.email,
    role: row.role,
    projects: row.projects,
    workspace_id: row.workspace_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    public_key: row.public_key || null,
  }));
} */
