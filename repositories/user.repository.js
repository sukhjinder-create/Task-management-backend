// repositories/user.repository.js
import pool from "../db.js";

// CREATE USER
export async function createUserRepo({
  username,
  email,
  password_hash,
  role,
  added_by,
  projects,
}) {
  const q = `
    INSERT INTO users (username, email, password_hash, role, added_by, projects)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING id, username, email, role, projects, created_at;
  `;
  const { rows } = await pool.query(q, [
    username,
    email,
    password_hash,
    role,
    added_by,
    projects || [],
  ]);
  return rows[0];
}

// GET USER BY EMAIL (for login)
export async function getUserByEmail(email) {
  const q = `SELECT * FROM users WHERE email = $1`;
  const { rows } = await pool.query(q, [email]);
  return rows[0] || null;
}

// GET USER BY ID
export async function getUserById(id) {
  const q = `
    SELECT id, username, email, role, projects, created_at
    FROM users
    WHERE id = $1
  `;
  const { rows } = await pool.query(q, [id]);
  return rows[0] || null;
}

// 🔹 NEW: GET USER BY USERNAME (for @mentions)
export async function getUserByUsername(username) {
  const q = `
    SELECT id, username, email, role, projects, created_at
    FROM users
    WHERE username = $1
  `;
  const { rows } = await pool.query(q, [username]);
  return rows[0] || null;
}

// GET ALL USERS (for admin UI)
export async function getAllUsersRepo() {
  const q = `
    SELECT 
      u.id,
      u.username,
      u.email,
      u.role,
      u.projects,
      u.created_at,
      k.public_key  -- 🔐 include E2E public key (may be null)
    FROM users u
    LEFT JOIN user_keys k ON k.user_id = u.id
    ORDER BY u.created_at DESC
  `;
  const { rows } = await pool.query(q);
  return rows;
}

// UPDATE USER
export async function updateUserRepo(id, { username, email, role, projects }) {
  const q = `
    UPDATE users
    SET username = $1,
        email = $2,
        role = $3,
        projects = $4,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = $5
    RETURNING id, username, email, role, projects, created_at, updated_at;
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

// DELETE USER
export async function deleteUserRepo(id) {
  const q = `DELETE FROM users WHERE id = $1`;
  const { rowCount } = await pool.query(q, [id]);
  return rowCount > 0;
}

// 🔹 OPTIONAL: get a single user plus their public key (if any)
export async function getUserWithPublicKeyById(id) {
  const q = `
    SELECT 
      u.id,
      u.username,
      u.email,
      u.role,
      u.projects,
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
    created_at: row.created_at,
    updated_at: row.updated_at,
    public_key: row.public_key || null,
  };
}

// 🔹 OPTIONAL: get all users plus their public keys
export async function getAllUsersWithPublicKeysRepo() {
  const q = `
    SELECT 
      u.id,
      u.username,
      u.email,
      u.role,
      u.projects,
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
    created_at: row.created_at,
    updated_at: row.updated_at,
    public_key: row.public_key || null,
  }));
}