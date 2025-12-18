// repositories/superadminWorkspaces.repository.js
import pool from "../db.js"; // your existing DB pool
import crypto from "crypto";

/**
 * Helper to generate UUID string if needed (db can generate too)
 * We will use gen_random_uuid() in SQL where convenient, but keep JS fallback.
 */
function genUuid() {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.createHash("sha1").update(String(Date.now()) + Math.random()).digest("hex");
}

/**
 * Create workspace + owner user (transactional)
 * ownerPasswordHash must be a bcrypt hash string.
 */
export async function createWorkspace({
  name,
  plan = "basic",
  member_limit = 10,
  ownerEmail,
  ownerPasswordHash,
  ownerName = null,
}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Insert workspace (use gen_random_uuid() in PG if available)
    const insWs = await client.query(
      `INSERT INTO workspaces (id, name, plan, member_limit, is_active, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, true, now(), now())
       RETURNING *`,
      [name, plan, Number(member_limit) || 10]
    );

    const workspace = insWs.rows[0];

    // Create owner user (role = admin)
    // If your users table has columns: id, username, email, password_hash, role, workspace_id
    // adjust below columns to match your schema.
    const ownerInsert = await client.query(
      `INSERT INTO users (id, username, email, password_hash, role, workspace_id, created_at)
       VALUES (gen_random_uuid(), $1, $2, $3, 'admin', $4, now())
       RETURNING id, username, email, role, workspace_id`,
      [ownerName || ownerEmail.split("@")[0], ownerEmail, ownerPasswordHash, workspace.id]
    );

    await client.query("COMMIT");

    // return workspace and created owner summary
    return {
      workspace,
      owner: ownerInsert.rows[0],
    };
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("createWorkspace TX error:", err);
    throw err;
  } finally {
    client.release();
  }
}

export async function listWorkspaces() {
  const res = await pool.query(`SELECT * FROM workspaces ORDER BY created_at DESC`);
  return res.rows;
}

export async function getWorkspace(id) {
  const res = await pool.query(`SELECT * FROM workspaces WHERE id = $1 LIMIT 1`, [id]);
  return res.rows[0] || null;
}

export async function updateWorkspace(id, data = {}) {
  const allowed = ["name", "plan", "member_limit"];
  const sets = [];
  const values = [];
  let idx = 1;

  for (const key of allowed) {
    if (data[key] !== undefined) {
      sets.push(`${key} = $${idx++}`);
      values.push(data[key]);
    }
  }

  if (sets.length === 0) {
    throw new Error("Nothing to update");
  }

  // always update updated_at
  sets.push(`updated_at = now()`);

  values.push(id);

  const q = `UPDATE workspaces SET ${sets.join(", ")} WHERE id = $${idx} RETURNING *`;
  const res = await pool.query(q, values);
  return res.rows[0];
}

export async function updateWorkspaceStatus(id, is_active) {
  const res = await pool.query(
    `UPDATE workspaces SET is_active = $1, updated_at = now() WHERE id = $2 RETURNING *`,
    [is_active, id]
  );
  return res.rows[0];
}

/**
 * Soft delete workspace: mark inactive & set deleted_at.
 * You can change this to actually cascade delete if you prefer (be careful).
 */
export async function deleteWorkspace(id) {
  await pool.query(
    `UPDATE workspaces SET is_active = false, updated_at = now() WHERE id = $1`,
    [id]
  );
  // optional: leave deleted_at column if you created it earlier.
  return;
}
